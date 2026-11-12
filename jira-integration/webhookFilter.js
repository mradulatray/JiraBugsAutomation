// Decides whether a (signature-verified) Jira webhook payload is a NEW assignment of a
// Bug to the configured account. Payload content is still treated as untrusted: it is
// only used for filtering here, and Phase 4 re-fetches the issue from the Jira API.
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
const SUPPORTED_EVENTS = new Set(['jira:issue_updated', 'jira:issue_created']);
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function reject(reason, issueKey) {
  return { accept: false, reason, issueKey };
}

export function evaluateJiraEvent(payload, { accountId, projects, issueTypes, maxEventAgeSec, now = Date.now() }) {
  if (!accountId) return reject('account_not_configured');
  if (!payload || typeof payload !== 'object') return reject('invalid_payload');
  if (!SUPPORTED_EVENTS.has(payload.webhookEvent)) return reject('unsupported_event');

  const issue = payload.issue;
  const issueKey = typeof issue?.key === 'string' ? issue.key : undefined;
  if (!issueKey || !ISSUE_KEY_RE.test(issueKey)) return reject('invalid_issue_key');
  const issueId = issue.id != null ? String(issue.id) : undefined;
  if (issueId !== undefined && !/^\d+$/.test(issueId)) return reject('invalid_issue_id', issueKey);

  if (maxEventAgeSec && Number.isFinite(payload.timestamp)) {
    const age = now - payload.timestamp;
    if (age > maxEventAgeSec * 1000) return reject('stale_event', issueKey);
    if (age < -MAX_CLOCK_SKEW_MS) return reject('future_event', issueKey);
  }

  const fields = issue.fields ?? {};
  const projectKey = fields.project?.key;
  if (!projects.includes(projectKey) || !issueKey.startsWith(`${projectKey}-`)) return reject('project_not_allowed', issueKey);

  const typeName = String(fields.issuetype?.name ?? '').toLowerCase();
  if (!issueTypes.some((t) => t.toLowerCase() === typeName)) return reject('issue_type_not_allowed', issueKey);

  if (fields.assignee?.accountId !== accountId) return reject('not_assigned_to_me', issueKey);

  if (payload.webhookEvent === 'jira:issue_created') {
    return { accept: true, issueKey, issueId, trigger: 'created_assigned', dedupeKey: `${issueKey}:created` };
  }

  const items = Array.isArray(payload.changelog?.items) ? payload.changelog.items : [];
  const assigned = items.some((i) => (i?.fieldId === 'assignee' || i?.field === 'assignee') && i?.to === accountId);
  if (!assigned) return reject('no_assignment_change', issueKey);

  const changelogId = payload.changelog?.id != null ? String(payload.changelog.id) : null;
  if (!changelogId || !/^\d+$/.test(changelogId)) return reject('missing_changelog_id', issueKey);

  return { accept: true, issueKey, issueId, trigger: 'assigned', dedupeKey: `${issueKey}:assign:${changelogId}` };
}
