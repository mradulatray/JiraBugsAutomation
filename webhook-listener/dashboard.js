// Local portal: http://127.0.0.1:8787/  (this Mac only)
// - refused when it arrives via the tunnel (proxy header) or with a non-loopback Host (DNS rebinding)
// - state-changing calls need the custom x-ngauto-ui header (forces a CORS preflight we never
//   answer, so other websites open in the browser cannot trigger them) and a same-origin Origin
import express from 'express';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseClaudeOutput } from '../agent-runner/claudeAgent.js';
import { TRANSIENT_STATES } from '../queue/stateMachine.js';

const execFileAsync = promisify(execFile);
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashboard', 'index.html');
const RETRYABLE = ['NEEDS_INFO', 'FAILED', 'VALIDATION_FAILED', 'INTERRUPTED', 'VALIDATED'];
const CANCELLABLE = ['QUEUED', 'NEEDS_INFO', 'FAILED', 'VALIDATION_FAILED', 'INTERRUPTED', 'VALIDATED'];

function latestFile(dir, prefix) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.startsWith(prefix)).map((f) => path.join(dir, f));
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}

function tail(file, maxBytes) {
  if (!file) return '';
  const buf = readFileSync(file);
  return buf.subarray(Math.max(0, buf.length - maxBytes)).toString('utf8');
}

export function mountDashboard(app, { config, jobStore, jira, killSwitch, runner, logger }) {
  const proxyHeader = config.server.trustProxyHeader;
  const base = config.gitlab.defaultTargetBranch;
  const wsDir = (key) => path.join(config.paths.workspaces, key);

  function localOnly(req, res, next) {
    const host = req.get('host') ?? '';
    const port = req.socket.localPort;
    const hostOk = host === `127.0.0.1:${port}` || host === `localhost:${port}`;
    if (!LOOPBACK.has(req.socket.remoteAddress) || (proxyHeader && req.get(proxyHeader)) || !hostOk) return res.status(404).end();
    if (req.method !== 'GET') {
      const origin = req.get('origin');
      if (req.get('x-ngauto-ui') !== '1' || (origin && origin !== `http://${host}`)) return res.status(403).end();
    }
    res.set({ 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    next();
  }

  const r = express.Router();
  r.use(localOnly);
  r.use(express.json({ limit: '32kb' }));

  r.get('/', (req, res) => {
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
    res.type('html').send(readFileSync(PAGE));
  });

  function agentResult(key) {
    const f = latestFile(wsDir(key), 'agent-');
    if (!f) return null;
    const p = parseClaudeOutput(tail(f, 400_000));
    return p.ok ? { status: p.status, summary: p.summary, details: p.details, question: p.question } : { error: p.reason };
  }

  function view(job, { full = false } = {}) {
    const v = {
      id: job.id,
      key: job.issue_key,
      state: job.state,
      running: TRANSIENT_STATES.includes(job.state),
      branch: job.branch,
      target: job.target_branch,
      mrUrl: job.mr_url,
      info: job.error,
      attempts: job.attempts,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
      jiraUrl: jira?.browseUrl(job.issue_key) ?? null,
      canRetry: RETRYABLE.includes(job.state),
      canCancel: CANCELLABLE.includes(job.state),
      canAnswer: RETRYABLE.includes(job.state) && Boolean(jira),
    };
    const ticket = path.join(wsDir(job.issue_key), 'TICKET.md');
    if (existsSync(ticket)) v.title = /^## Summary\n+(.+)$/m.exec(readFileSync(ticket, 'utf8'))?.[1]?.slice(0, 200) ?? null;
    v.agent = agentResult(job.issue_key);
    if (full) {
      v.events = jobStore.jobEvents(job.id);
      v.ticket = existsSync(ticket) ? readFileSync(ticket, 'utf8').slice(0, 60_000) : null;
      if (job.state === 'VALIDATING' || job.state === 'VALIDATION_FAILED') {
        v.buildTail = tail(latestFile(wsDir(job.issue_key), 'build-'), 6_000).split('\n').slice(-40).join('\n');
      }
    }
    return v;
  }

  r.get('/api/status', (req, res) => {
    res.json({ killed: killSwitch.isActive(), runnerBusy: runner?.isBusy() ?? false, runnerEnabled: Boolean(runner), counts: jobStore.countByState(), now: new Date().toISOString() });
  });

  r.get('/api/jobs', (req, res) => res.json(jobStore.listJobs(100).map((j) => view(j))));

  const withJob = (fn) => async (req, res) => {
    const job = jobStore.getJob(Number(req.params.id));
    if (!job) return res.status(404).json({ error: 'Job not found' });
    try {
      await fn(job, req, res);
    } catch (err) {
      logger.warn('portal.action_failed', { jobId: job.id, err });
      res.status(400).json({ error: String(err?.message ?? err).slice(0, 300) });
    }
  };

  r.get('/api/jobs/:id', withJob((job, req, res) => res.json(view(job, { full: true }))));

  r.get('/api/jobs/:id/diff', withJob(async (job, req, res) => {
    const repo = path.join(wsDir(job.issue_key), 'repo');
    if (!existsSync(repo)) return res.json({ diff: '' });
    const git = (args) => execFileAsync('git', args, { cwd: repo, maxBuffer: 4 * 1024 * 1024, timeout: 20_000 }).then((o) => o.stdout).catch(() => '');
    const committed = await git(['diff', '--no-color', `origin/${base}...HEAD`]);
    const pending = await git(['diff', '--no-color', 'HEAD']);
    const diff = committed + (pending ? `\n# --- uncommitted changes ---\n${pending}` : '');
    res.json({ diff: diff.slice(0, 400_000), truncated: diff.length > 400_000 });
  }));

  r.post('/api/jobs/:id/retry', withJob((job, req, res) => {
    const j = jobStore.transition(job.id, 'QUEUED', { note: 'retry via portal', patch: { error: null } });
    logger.info('portal.retry', { jobId: job.id, issueKey: job.issue_key });
    res.json(view(j));
  }));

  r.post('/api/jobs/:id/cancel', withJob((job, req, res) => {
    const j = jobStore.transition(job.id, 'CANCELLED', { note: 'cancelled via portal' });
    logger.info('portal.cancel', { jobId: job.id, issueKey: job.issue_key });
    res.json(view(j));
  }));

  // Posts the answer to Jira as a comment (as you), then re-queues: the agent re-reads the ticket incl. comments.
  r.post('/api/jobs/:id/answer', withJob(async (job, req, res) => {
    const text = String(req.body?.text ?? '').trim();
    if (!jira) throw new Error('Jira client not configured');
    if (!RETRYABLE.includes(job.state)) throw new Error(`Cannot answer a job in state ${job.state}`);
    if (text.length < 3 || text.length > 8000) throw new Error('Answer must be 3-8000 characters');
    await jira.addComment(job.issue_key, text);
    const j = jobStore.transition(job.id, 'QUEUED', { note: 'answered via portal (Jira comment added)', patch: { error: null } });
    logger.info('portal.answer', { jobId: job.id, issueKey: job.issue_key, chars: text.length });
    res.json(view(j));
  }));

  app.use(r);
}
