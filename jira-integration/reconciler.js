// Polling reconciler: finds Bugs newly assigned to jira.accountId and enqueues them.
// Works without a tunnel or Jira admin rights, and backstops the webhook when both run.
//
// Dedupe keys match the webhook path exactly - `KEY:assign:<changelogHistoryId>` or
// `KEY:created` - so an assignment seen by both the webhook and the poller is one job.
import { ISSUE_KEY_RE, JiraApiError } from './jiraClient.js';

const SEARCH_FIELDS = ['project', 'issuetype', 'assignee', 'created', 'summary'];

const jqlString = (s) => `"${String(s).replace(/["\\]/g, '\\$&')}"`;

export function buildJql({ accountId, projects, issueTypes, lookbackMin }) {
  const me = jqlString(accountId);
  const m = Math.max(1, Math.ceil(lookbackMin));
  return [
    `assignee = ${me}`,
    `project in (${projects.map(jqlString).join(', ')})`,
    `issuetype in (${issueTypes.map(jqlString).join(', ')})`,
    `(assignee CHANGED TO ${me} AFTER "-${m}m" OR created >= "-${m}m")`,
  ].join(' AND ') + ' ORDER BY updated ASC';
}

const isAssigneeItem = (i) => i?.fieldId === 'assignee' || i?.field === 'assignee';

/**
 * Decides from the issue + its changelog whether it is a recent assignment to accountId.
 * Mirrors evaluateJiraEvent()'s rules for the webhook path.
 */
export function evaluatePolledIssue(issue, histories, { accountId, projects, issueTypes, maxEventAgeSec, now = Date.now() }) {
  const issueKey = typeof issue?.key === 'string' ? issue.key : undefined;
  if (!issueKey || !ISSUE_KEY_RE.test(issueKey)) return { accept: false, reason: 'invalid_issue_key' };
  const issueId = issue.id != null ? String(issue.id) : undefined;
  if (issueId !== undefined && !/^\d+$/.test(issueId)) return { accept: false, reason: 'invalid_issue_id', issueKey };

  const f = issue.fields ?? {};
  if (!projects.includes(f.project?.key) || !issueKey.startsWith(`${f.project?.key}-`)) return { accept: false, reason: 'project_not_allowed', issueKey };
  const type = String(f.issuetype?.name ?? '').toLowerCase();
  if (!issueTypes.some((t) => t.toLowerCase() === type)) return { accept: false, reason: 'issue_type_not_allowed', issueKey };
  if (f.assignee?.accountId !== accountId) return { accept: false, reason: 'not_assigned_to_me', issueKey };

  const maxAgeMs = (maxEventAgeSec ?? Infinity) * 1000;
  const toMe = (Array.isArray(histories) ? histories : [])
    .filter((h) => Array.isArray(h?.items) && h.items.some((i) => isAssigneeItem(i) && i.to === accountId))
    .sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
  const latest = toMe.at(-1);

  if (latest) {
    const id = String(latest.id ?? '');
    if (!/^\d+$/.test(id)) return { accept: false, reason: 'missing_changelog_id', issueKey };
    const at = Date.parse(latest.created);
    if (!Number.isFinite(at) || now - at > maxAgeMs) return { accept: false, reason: 'stale_assignment', issueKey };
    return { accept: true, issueKey, issueId, trigger: 'assigned', dedupeKey: `${issueKey}:assign:${id}`, at };
  }

  // No "assigned to me" history entry => it was created already assigned to me.
  const created = Date.parse(f.created);
  if (!Number.isFinite(created) || now - created > maxAgeMs) return { accept: false, reason: 'stale_assignment', issueKey };
  return { accept: true, issueKey, issueId, trigger: 'created_assigned', dedupeKey: `${issueKey}:created`, at: created };
}

export function createReconciler({ config, jira, jobStore, logger, killSwitch, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  const { accountId, projects, issueTypes, maxEventAgeSec } = config.jira;
  const poll = { intervalSec: 120, overlapMin: 5, ...config.jira.poll };
  const maxLookbackMin = Math.ceil(maxEventAgeSec / 60);

  let lastSuccessAt = null;
  let running = false;
  let stopped = true;
  let timer = null;
  let failures = 0;

  function lookbackMin(t) {
    if (!lastSuccessAt) return maxLookbackMin;
    return Math.min(maxLookbackMin, Math.ceil((t - lastSuccessAt) / 60_000) + poll.overlapMin);
  }

  /** Verifies one issue against Jira (issue + changelog) and enqueues it if it is a recent assignment. */
  async function evaluateAndEnqueue(issue, { source, dryRun }) {
    const key = issue?.key;
    if (!ISSUE_KEY_RE.test(String(key))) return { issueKey: undefined, status: 'ignored', reason: 'invalid_issue_key' };
    const histories = await jira.getChangelog(key);
    const v = evaluatePolledIssue(issue, histories, { accountId, projects, issueTypes, maxEventAgeSec, now: now() });
    if (!v.accept) return { issueKey: v.issueKey ?? key, status: 'ignored', reason: v.reason };
    if (dryRun) return { issueKey: v.issueKey, status: 'would_enqueue', trigger: v.trigger, dedupeKey: v.dedupeKey };
    const r = jobStore.enqueue({ issueKey: v.issueKey, issueId: v.issueId, source, dedupeKey: v.dedupeKey });
    if (r.status === 'enqueued') logger.info(`${source}.enqueued`, { issueKey: v.issueKey, jobId: r.job.id, trigger: v.trigger });
    return { issueKey: v.issueKey, status: r.status, jobId: r.job?.id, trigger: v.trigger };
  }

  /**
   * Real-time path (Jira Automation webhook): the payload only says *which* issue to look at;
   * the decision is made from data fetched from Jira, never from the request body.
   */
  async function checkIssue(issueKey, { source = 'automation', dryRun = false } = {}) {
    if (killSwitch?.isActive()) return { issueKey, status: 'skipped', reason: 'kill_switch' };
    if (!accountId) return { issueKey, status: 'skipped', reason: 'account_not_configured' };
    if (!ISSUE_KEY_RE.test(String(issueKey))) return { issueKey: undefined, status: 'ignored', reason: 'invalid_issue_key' };
    if (!projects.some((p) => issueKey.startsWith(`${p}-`))) return { issueKey, status: 'ignored', reason: 'project_not_allowed' };
    const issue = await jira.getIssue(issueKey, { fields: SEARCH_FIELDS });
    if (issue?.key !== issueKey) return { issueKey, status: 'ignored', reason: 'key_mismatch' };
    return evaluateAndEnqueue(issue, { source, dryRun });
  }

  /** One poll. dryRun: evaluate and report, but do not enqueue. */
  async function pollOnce({ dryRun = false } = {}) {
    if (killSwitch?.isActive()) return { skipped: 'kill_switch', results: [] };
    if (!accountId) return { skipped: 'account_not_configured', results: [] };
    if (running) return { skipped: 'already_running', results: [] };
    running = true;
    const startedAt = now();
    try {
      // Jira Cloud treats bad Basic-auth credentials on search as an anonymous request
      // (200, zero results), so a broken token would poll "successfully" forever.
      // /myself does return 401, so check identity first on every poll.
      if (jira.myself) {
        const me = await jira.myself();
        if (me?.accountId !== accountId) throw new JiraApiError(403, '/rest/api/3/myself');
      }
      const jql = buildJql({ accountId, projects, issueTypes, lookbackMin: lookbackMin(startedAt) });
      const issues = await jira.searchIssues(jql, { fields: SEARCH_FIELDS });
      const results = [];
      for (const issue of issues) {
        if (killSwitch?.isActive()) break;
        try {
          results.push(await evaluateAndEnqueue(issue, { source: 'poll', dryRun }));
        } catch (err) {
          logger.warn('poll.issue_error', { issueKey: issue?.key, err });
          results.push({ issueKey: issue?.key, status: 'error', reason: err?.name ?? 'error' });
        }
      }
      if (!dryRun) lastSuccessAt = startedAt;
      logger.info('poll.completed', { candidates: issues.length, enqueued: results.filter((r) => r.status === 'enqueued').length, dryRun });
      return { results, jql };
    } finally {
      running = false;
    }
  }

  function schedule(delayMs) {
    if (stopped) return;
    timer = setTimer(tick, delayMs);
    timer?.unref?.();
  }

  async function tick() {
    timer = null;
    let delay = poll.intervalSec * 1000;
    try {
      await pollOnce();
      failures = 0;
    } catch (err) {
      failures += 1;
      const auth = err instanceof JiraApiError && (err.status === 401 || err.status === 403);
      logger[auth ? 'error' : 'warn']('poll.failed', {
        err,
        status: err?.status,
        failures,
        hint: auth ? 'check jira.email and the jira-api-token secret (`ngauto secret set jira-api-token`)' : undefined,
      });
      const backoff = Math.min(30 * 60_000, poll.intervalSec * 1000 * 2 ** Math.min(failures, 5));
      delay = Math.max(backoff, (err?.retryAfterSec ?? 0) * 1000);
    }
    schedule(delay);
  }

  return {
    pollOnce,
    checkIssue,
    start({ initialDelayMs = 2_000 } = {}) {
      if (!stopped) return;
      stopped = false;
      logger.info('poll.started', { intervalSec: poll.intervalSec });
      schedule(initialDelayMs);
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}
