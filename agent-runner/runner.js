// Phase 5: consumes QUEUED jobs one at a time.
//   QUEUED → FETCHING (TICKET.md + worktree) → ANALYZING (Claude) → IMPLEMENTING (commit)
//          → VALIDATING (xcodebuild; up to maxFixAttempts Claude retries on compile errors) → VALIDATED
// Exits: NEEDS_INFO (agent asked a question / changed nothing), VALIDATION_FAILED, FAILED, INTERRUPTED.
// Nothing here pushes or talks to GitLab (that is Phase 6, VALIDATED → PUSHING).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { childEnv, run as defaultRun } from './exec.js';
import { createWorkspace } from './workspace.js';
import { claudeArgs, initialPrompt, parseClaudeOutput, retryPrompt } from './claudeAgent.js';
import { writeTicket } from '../jira-integration/ticketBuilder.js';
import { TRANSIENT_STATES } from '../queue/stateMachine.js';

export function buildLogTail(log, maxLines = 80) {
  const lines = String(log).split('\n');
  const errors = lines.filter((l) => /\berror:|\*\* BUILD FAILED \*\*|fatal error/i.test(l));
  const picked = errors.length ? [...new Set(errors)].slice(0, 60) : lines.slice(-maxLines);
  return picked.join('\n').slice(0, 12_000);
}

export function createAgentRunner({
  config,
  jobStore,
  jira,
  logger,
  killSwitch,
  notify = () => {},
  run = defaultRun,
  workspace = createWorkspace({ run }),
  setTimer = setInterval,
  clearTimer = clearInterval,
}) {
  const agent = config.agent;
  const base = config.gitlab.defaultTargetBranch;
  const appSubdir = config.repo.appSubdir;
  let timer = null;
  let busy = false;
  let stopped = true;
  let ctrl = null;

  const step = (job, to, extra = {}) => {
    const j = jobStore.transition(job.id, to, extra);
    logger.info('job.state', { jobId: job.id, issueKey: job.issue_key, state: to, note: extra.note ?? undefined });
    return j;
  };

  async function runClaude({ job, cwd, prompt, resumeSessionId, n, workspaceDir, signal }) {
    const r = await run(agent.claudePath, claudeArgs({ model: agent.model || undefined, maxBudgetUsd: agent.maxBudgetUsd, resumeSessionId }), {
      cwd,
      input: prompt,
      signal,
      timeoutMs: agent.timeoutMin * 60_000,
      logFile: path.join(workspaceDir, `agent-${n}.json`),
      // A stalled API request (seen through the corporate proxy) otherwise hangs until our 40-min cap;
      // this makes Claude Code abort and retry a silent request after 5 minutes.
      env: childEnv({ API_TIMEOUT_MS: String(agent.apiTimeoutMs ?? 300_000) }),
    });
    if (r.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
    if (r.timedOut) return { ok: false, reason: `agent_timeout_${agent.timeoutMin}m` };
    const parsed = parseClaudeOutput(r.stdout);
    logger.info('agent.finished', { jobId: job.id, issueKey: job.issue_key, run: n, ok: parsed.ok, status: parsed.status, reason: parsed.reason, costUsd: parsed.costUsd, turns: parsed.turns, exit: r.code });
    return parsed;
  }

  async function compile({ worktree, workspaceDir, n, signal }) {
    const v = config.validate;
    const derivedData = path.join(config.paths.home, 'DerivedData');
    const [cmd, ...args] = v.command.map((a) => a.replaceAll('{derivedData}', derivedData));
    const logFile = path.join(workspaceDir, `build-${n}.log`);
    const r = await run(cmd, args, { cwd: path.join(worktree, appSubdir), signal, timeoutMs: v.timeoutMin * 60_000, logFile });
    if (r.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
    return { ok: r.code === 0 && !r.timedOut, timedOut: r.timedOut, tail: buildLogTail(`${r.stdout}\n${r.stderr}`), logFile };
  }

  /** Validate the agent's working-tree changes and commit them. Returns { ok, reason }. */
  async function commitChanges({ job, worktree, message }) {
    const files = await workspace.changedFiles(worktree);
    if (!files.length) return { ok: false, empty: true, reason: 'agent changed no files' };
    const allowed = workspace.checkAllowed(files, { appSubdir });
    if (!allowed.ok) return { ok: false, reason: `agent changed forbidden paths: ${allowed.bad.slice(0, 5).join(', ')}` };
    const sha = await workspace.commitAll(worktree, message);
    logger.info('job.committed', { jobId: job.id, issueKey: job.issue_key, files: files.length, sha });
    return { ok: true, files };
  }

  async function processJob(queued, signal) {
    const key = queued.issue_key;
    const workspaceDir = path.join(config.paths.workspaces, key);
    let job = step(queued, 'FETCHING');

    const ticketFile = await writeTicket({ jira, config, issueKey: key });
    const ticketMarkdown = readFileSync(ticketFile, 'utf8');
    const issue = await jira.getIssue(key, { fields: ['summary'] });
    const { worktree, branch } = await workspace.prepare({ repoPath: config.repo.path, workspaceDir, issueKey: key, summary: issue?.fields?.summary, base, signal });

    job = step(job, 'ANALYZING', { patch: { branch, target_branch: base }, note: branch });
    notify(`${key}: fixing`, `Claude is working on ${branch}`);
    const res = await runClaude({ job, cwd: worktree, prompt: initialPrompt({ ticketMarkdown, appSubdir }), n: 1, workspaceDir, signal });
    if (!res.ok) return fail(job, `agent run failed: ${res.reason}`);
    if (res.status === 'needs_info') return needsInfo(job, res.question || 'Agent needs more information (no question given).');

    const c = await commitChanges({ job, worktree, message: `${key}: ${res.summary || 'automated fix'}\n\n${res.details}\n\nAutomated fix by ng-automation (Claude Code).\nJira: ${jira.browseUrl(key)}` });
    if (!c.ok) return c.empty ? needsInfo(job, 'Agent reported a fix but changed no files.') : fail(job, c.reason);
    job = step(job, 'IMPLEMENTING', { note: res.summary });

    if (!config.validate?.enabled) {
      job = step(job, 'VALIDATING', { note: 'compile check disabled' });
      return done(job, branch, worktree);
    }

    let sessionId = res.sessionId;
    job = step(job, 'VALIDATING');
    for (let attempt = 1; ; attempt++) {
      const b = await compile({ worktree, workspaceDir, n: attempt, signal });
      if (b.ok) return done(job, branch, worktree);
      logger.warn('job.compile_failed', { jobId: job.id, issueKey: key, attempt, timedOut: b.timedOut, log: b.logFile });
      if (b.timedOut || attempt > agent.maxFixAttempts) {
        step(job, 'VALIDATION_FAILED', { patch: { error: `compile failed after ${attempt} attempt(s); see ${b.logFile}` } });
        notify(`${key}: build failed`, 'Compile check failed. Run `ngauto show` for details.');
        return;
      }
      const r = await runClaude({ job, cwd: worktree, prompt: retryPrompt({ buildLogTail: b.tail, attempt }), resumeSessionId: sessionId, n: attempt + 1, workspaceDir, signal });
      if (!r.ok || r.status !== 'fixed') {
        step(job, 'VALIDATION_FAILED', { patch: { error: `compile failed; agent could not fix it (${r.reason ?? r.status})` } });
        notify(`${key}: build failed`, 'Agent could not fix the compile errors.');
        return;
      }
      sessionId = r.sessionId ?? sessionId;
      const cc = await commitChanges({ job, worktree, message: `${key}: fix build after automated change` });
      if (!cc.ok && !cc.empty) return fail(job, cc.reason);
    }
  }

  function fail(job, reason) {
    step(job, 'FAILED', { patch: { error: reason.slice(0, 1000) } });
    notify(`${job.issue_key}: failed`, reason.slice(0, 120));
  }

  function needsInfo(job, question) {
    step(job, 'NEEDS_INFO', { patch: { error: question.slice(0, 1000) } });
    notify(`${job.issue_key}: needs info`, question.slice(0, 120));
  }

  async function done(job, branch, worktree) {
    let stat = '';
    try {
      stat = (await workspace.diffStat(worktree, base)).trim().split('\n').at(-1) ?? '';
    } catch {}
    step(job, 'VALIDATED', { note: stat || null, patch: { error: null } });
    notify(`${job.issue_key}: fix ready`, `Compiled OK on ${branch}. ${stat}`);
  }

  async function tick() {
    if (busy || stopped || killSwitch?.isActive()) return;
    const job = jobStore.nextQueued();
    if (!job) return;
    busy = true;
    ctrl = new AbortController();
    const killWatch = setTimer(() => killSwitch?.isActive() && ctrl.abort(), 5_000);
    try {
      await processJob(job, ctrl.signal);
    } catch (err) {
      const current = safeGet(job.id);
      if (!current || !TRANSIENT_STATES.includes(current.state)) {
        logger.error('job.error_after_exit', { jobId: job.id, err });
      } else if (err?.aborted || ctrl.signal.aborted) {
        safeTransition(job.id, 'INTERRUPTED', { note: 'stopped (kill switch or shutdown)' });
      } else {
        logger.error('job.error', { jobId: job.id, issueKey: job.issue_key, err });
        safeTransition(job.id, 'FAILED', { patch: { error: String(err?.message ?? err).slice(0, 1000) } });
        notify(`${job.issue_key}: failed`, String(err?.message ?? err).slice(0, 120));
      }
    } finally {
      clearTimer(killWatch);
      busy = false;
      ctrl = null;
    }
  }

  function safeGet(id) {
    try {
      return jobStore.getJob(id);
    } catch {
      return null;
    }
  }
  function safeTransition(id, to, extra) {
    try {
      const j = jobStore.transition(id, to, extra);
      logger.info('job.state', { jobId: id, issueKey: j.issue_key, state: to });
    } catch (err) {
      logger.warn('job.transition_failed', { jobId: id, to, err });
    }
  }

  return {
    tick,
    isBusy: () => busy,
    start() {
      if (!stopped) return;
      stopped = false;
      timer = setTimer(() => tick().catch((err) => logger.error('runner.tick_error', { err })), agent.pollSec * 1000);
      timer?.unref?.();
      logger.info('runner.started', { pollSec: agent.pollSec, base });
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
      ctrl?.abort();
    },
  };
}
