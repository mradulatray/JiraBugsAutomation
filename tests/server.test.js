import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createApp } from '../webhook-listener/server.js';
import { computeSignature } from '../webhook-listener/verifySignature.js';
import { openJobStore } from '../queue/jobStore.js';
import { createKillSwitch } from '../security/killSwitch.js';
import { nullLogger } from '../lib/logger.js';
import { assignPayload, tempDir, testConfig } from './helpers.js';

const SECRET = 'webhook-secret-for-tests';
let server, base, jobStore, killSwitch;
let deliveries = 0;

function post(payload, { sign = true, sig, deliveryId = `d-${++deliveries}`, headers = {} } = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const h = { 'content-type': 'application/json', 'x-atlassian-webhook-identifier': deliveryId, ...headers };
  if (sign) h['x-hub-signature'] = sig ?? computeSignature(SECRET, Buffer.from(body));
  return fetch(`${base}/hooks/jira`, { method: 'POST', headers: h, body });
}

before(async () => {
  const dir = tempDir();
  jobStore = openJobStore(path.join(dir, 'state.db'));
  killSwitch = createKillSwitch(path.join(dir, 'KILL'));
  const secrets = { get: async () => SECRET, has: async () => true };
  const app = createApp({ config: testConfig(), logger: nullLogger, secrets, jobStore, killSwitch });
  await new Promise((r) => {
    server = app.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  jobStore.close();
});

test('unsigned request -> 401, nothing enqueued', async () => {
  assert.equal((await post(assignPayload(), { sign: false })).status, 401);
  assert.equal(jobStore.listJobs().length, 0);
});

test('wrong signature -> 401', async () => {
  assert.equal((await post(assignPayload(), { sig: computeSignature('wrong', Buffer.from('x')) })).status, 401);
});

test('valid assignment -> 202 accepted and job QUEUED', async () => {
  const r = await post(assignPayload({ key: 'NGBUGS-1', changelogId: '1' }), { deliveryId: 'fixed-1' });
  assert.equal(r.status, 202);
  assert.equal((await r.json()).status, 'accepted');
  const [job] = jobStore.listJobs();
  assert.equal(job.issue_key, 'NGBUGS-1');
  assert.equal(job.state, 'QUEUED');
});

test('replayed delivery id -> duplicate', async () => {
  const r = await post(assignPayload({ key: 'NGBUGS-1', changelogId: '1' }), { deliveryId: 'fixed-1' });
  assert.equal((await r.json()).status, 'duplicate');
});

test('same assignment via a new delivery id -> duplicate (changelog dedupe)', async () => {
  const r = await post(assignPayload({ key: 'NGBUGS-1', changelogId: '1' }));
  assert.equal((await r.json()).status, 'duplicate');
  assert.equal(jobStore.listJobs().length, 1);
});

test('non-bug -> ignored', async () => {
  const r = await post(assignPayload({ key: 'NGBUGS-2', type: 'Story' }));
  assert.equal((await r.json()).status, 'ignored');
});

test('invalid JSON with valid signature -> 400', async () => {
  assert.equal((await post('{not json')).status, 400);
});

test('oversized body -> 413', async () => {
  assert.equal((await post({ pad: 'x'.repeat(5000) })).status, 413);
});

test('unknown route -> 404; healthz via tunnel header -> 404', async () => {
  assert.equal((await fetch(`${base}/admin`)).status, 404);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/healthz`, { headers: { 'cf-connecting-ip': '1.2.3.4' } })).status, 404);
});

test('kill switch -> 503', async () => {
  killSwitch.activate('test');
  assert.equal((await post(assignPayload({ key: 'NGBUGS-3' }))).status, 503);
  killSwitch.clear();
});

test('rate limiting -> 429 for a flooding client', async () => {
  const dir = tempDir();
  const store = openJobStore(path.join(dir, 's.db'));
  const cfg = testConfig({ rateLimit: { perClient: { capacity: 2, refillPerSec: 0.01 }, global: { capacity: 100, refillPerSec: 10 } } });
  const app = createApp({ config: cfg, logger: nullLogger, secrets: { get: async () => SECRET }, jobStore: store, killSwitch: createKillSwitch(path.join(dir, 'K')) });
  const s = await new Promise((r) => {
    const srv = app.listen(0, '127.0.0.1', () => r(srv));
  });
  const url = `http://127.0.0.1:${s.address().port}/hooks/jira`;
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await fetch(url, { method: 'POST', headers: { 'cf-connecting-ip': '9.9.9.9' }, body: '{}' })).status);
  assert.deepEqual(statuses, [401, 401, 429, 429]);
  s.close();
  store.close();
});
