// Durable job queue + state on SQLite (node:sqlite, no extra dependency).
// Interface is intentionally small so it can be re-implemented on Postgres/SQS/DynamoDB.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { canTransition, TERMINAL_STATES, TRANSIENT_STATES } from './stateMachine.js';

const PATCHABLE = new Set(['branch', 'target_branch', 'mr_url', 'error', 'agent_pid']);
const inList = (arr) => arr.map((s) => `'${s}'`).join(',');

export function openJobStore(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS jobs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_key     TEXT NOT NULL,
      issue_id      TEXT,
      state         TEXT NOT NULL,
      source        TEXT NOT NULL,
      dedupe_key    TEXT NOT NULL UNIQUE,
      attempts      INTEGER NOT NULL DEFAULT 0,
      branch        TEXT,
      target_branch TEXT,
      mr_url        TEXT,
      agent_pid     INTEGER,
      error         TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_issue ON jobs(issue_key);
    CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
    CREATE TABLE IF NOT EXISTS job_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id     INTEGER NOT NULL REFERENCES jobs(id),
      from_state TEXT,
      to_state   TEXT NOT NULL,
      note       TEXT,
      at         TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      delivery_id TEXT PRIMARY KEY,
      received_at TEXT NOT NULL
    );
  `);

  const stmt = {
    insertDelivery: db.prepare('INSERT OR IGNORE INTO deliveries (delivery_id, received_at) VALUES (?, ?)'),
    pruneDeliveries: db.prepare('DELETE FROM deliveries WHERE received_at < ?'),
    byDedupe: db.prepare('SELECT * FROM jobs WHERE dedupe_key = ?'),
    activeForIssue: db.prepare(`SELECT * FROM jobs WHERE issue_key = ? AND state NOT IN (${inList(TERMINAL_STATES)}) ORDER BY id DESC LIMIT 1`),
    insertJob: db.prepare(`INSERT INTO jobs (issue_key, issue_id, state, source, dedupe_key, created_at, updated_at) VALUES (?, ?, 'QUEUED', ?, ?, ?, ?)`),
    insertEvent: db.prepare('INSERT INTO job_events (job_id, from_state, to_state, note, at) VALUES (?, ?, ?, ?, ?)'),
    byId: db.prepare('SELECT * FROM jobs WHERE id = ?'),
    list: db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT ?'),
    events: db.prepare('SELECT * FROM job_events WHERE job_id = ? ORDER BY id'),
    transient: db.prepare(`SELECT * FROM jobs WHERE state IN (${inList(TRANSIENT_STATES)})`),
    countByState: db.prepare('SELECT state, COUNT(*) AS n FROM jobs GROUP BY state'),
    nextQueued: db.prepare(`SELECT * FROM jobs WHERE state = 'QUEUED' ORDER BY id LIMIT 1`),
  };

  const nowIso = () => new Date().toISOString();

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Returns true if this webhook delivery id has not been seen before. */
  function recordDelivery(deliveryId) {
    return stmt.insertDelivery.run(deliveryId, nowIso()).changes === 1;
  }

  function pruneDeliveries(olderThanDays = 14) {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    return stmt.pruneDeliveries.run(cutoff).changes;
  }

  function enqueue({ issueKey, issueId = null, source, dedupeKey }) {
    return tx(() => {
      const dup = stmt.byDedupe.get(dedupeKey);
      if (dup) return { status: 'duplicate_event', job: dup };
      const active = stmt.activeForIssue.get(issueKey);
      if (active) return { status: 'active_job_exists', job: active };
      const t = nowIso();
      const { lastInsertRowid } = stmt.insertJob.run(issueKey, issueId, source, dedupeKey, t, t);
      const id = Number(lastInsertRowid);
      stmt.insertEvent.run(id, null, 'QUEUED', `source=${source}`, t);
      return { status: 'enqueued', job: stmt.byId.get(id) };
    });
  }

  function transition(jobId, to, { note = null, patch = {} } = {}) {
    return tx(() => {
      const job = stmt.byId.get(jobId);
      if (!job) throw new Error(`Job ${jobId} not found`);
      if (!canTransition(job.state, to)) throw new Error(`Illegal transition ${job.state} -> ${to} for job ${jobId}`);
      const sets = ['state = ?', 'updated_at = ?'];
      const vals = [to, nowIso()];
      for (const [k, v] of Object.entries(patch)) {
        if (!PATCHABLE.has(k)) throw new Error(`Field ${k} is not patchable`);
        sets.push(`${k} = ?`);
        vals.push(v);
      }
      if (to === 'FETCHING') sets.push('attempts = attempts + 1');
      db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals, jobId);
      stmt.insertEvent.run(jobId, job.state, to, note, nowIso());
      return stmt.byId.get(jobId);
    });
  }

  /** On boot: anything that was mid-flight is marked INTERRUPTED (never auto-resumed). */
  function recoverInterrupted() {
    return stmt.transient.all().map((job) => transition(job.id, 'INTERRUPTED', { note: 'service restarted during processing' }));
  }

  return {
    recordDelivery,
    pruneDeliveries,
    enqueue,
    transition,
    recoverInterrupted,
    getJob: (id) => stmt.byId.get(id),
    listJobs: (limit = 20) => stmt.list.all(limit),
    jobEvents: (id) => stmt.events.all(id),
    countByState: () => Object.fromEntries(stmt.countByState.all().map((r) => [r.state, r.n])),
    nextQueued: () => stmt.nextQueued.get(),
    close: () => db.close(),
  };
}
