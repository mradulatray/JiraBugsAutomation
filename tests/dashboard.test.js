import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createApp } from '../webhook-listener/server.js';
import { mountDashboard } from '../webhook-listener/dashboard.js';
import { openJobStore } from '../queue/jobStore.js';
import { nullLogger } from '../lib/logger.js';
import { tempDir, testConfig } from './helpers.js';

let server, base, port, store, comments, jobId;

function raw(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const ui = { 'content-type': 'application/json', 'x-ngauto-ui': '1' };
const post = (p, body = {}, headers = ui) => fetch(`${base}${p}`, { method: 'POST', headers, body: JSON.stringify(body) });

before(async () => {
  const dir = tempDir();
  store = openJobStore(path.join(dir, 'state.db'));
  comments = [];
  const config = { ...testConfig(), paths: { workspaces: path.join(dir, 'ws') }, gitlab: { defaultTargetBranch: 'release' } };
  const jira = { browseUrl: (k) => `https://x/browse/${k}`, addComment: async (key, text) => comments.push({ key, text }) };
  const app = createApp({
    config, logger: nullLogger, secrets: { get: async () => 's' }, jobStore: store, killSwitch: { isActive: () => false },
    extraRoutes: (a) => mountDashboard(a, { config, jobStore: store, jira, killSwitch: { isActive: () => false }, runner: { isBusy: () => false }, logger: nullLogger }),
  });
  await new Promise((r) => (server = app.listen(0, '127.0.0.1', r)));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
  jobId = store.enqueue({ issueKey: 'NGBUGS-9', source: 'poll', dedupeKey: 'NGBUGS-9:created' }).job.id;
  for (const s of ['FETCHING', 'ANALYZING', 'NEEDS_INFO']) store.transition(jobId, s, s === 'NEEDS_INFO' ? { patch: { error: 'Which screen?' } } : {});
});

after(() => {
  server.close();
  store.close();
});

test('portal page + job list are served locally', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const jobs = await (await fetch(`${base}/api/jobs`)).json();
  assert.equal(jobs[0].key, 'NGBUGS-9');
  assert.equal(jobs[0].info, 'Which screen?');
  assert.equal(jobs[0].canAnswer, true);
});

test('refused via tunnel (proxy header) and with a foreign Host (DNS rebinding)', async () => {
  assert.equal((await raw('GET', '/api/jobs', { headers: { 'cf-connecting-ip': '1.2.3.4' } })).status, 404);
  assert.equal((await raw('GET', '/api/jobs', { headers: { host: `evil.example:${port}` } })).status, 404);
  assert.equal((await raw('GET', '/', { headers: { host: 'x.ngrok-free.dev' } })).status, 404);
});

test('state changes need the UI header and same origin (CSRF)', async () => {
  assert.equal((await post(`/api/jobs/${jobId}/retry`, {}, { 'content-type': 'application/json' })).status, 403);
  assert.equal((await post(`/api/jobs/${jobId}/retry`, {}, { ...ui, origin: 'https://evil.example' })).status, 403);
  assert.equal(store.getJob(jobId).state, 'NEEDS_INFO');
});

test('answer posts a Jira comment and re-queues; invalid input rejected', async () => {
  assert.equal((await post(`/api/jobs/${jobId}/answer`, { text: '' })).status, 400);
  const r = await post(`/api/jobs/${jobId}/answer`, { text: 'Search screen, location field.\n\niPhone 15, iOS 18' }, { ...ui, origin: base });
  assert.equal(r.status, 200);
  assert.deepEqual(comments, [{ key: 'NGBUGS-9', text: 'Search screen, location field.\n\niPhone 15, iOS 18' }]);
  assert.equal(store.getJob(jobId).state, 'QUEUED');
  assert.equal(store.getJob(jobId).error, null);
  // QUEUED cannot be answered again, but can be cancelled
  assert.equal((await post(`/api/jobs/${jobId}/answer`, { text: 'again' })).status, 400);
  assert.equal((await post(`/api/jobs/${jobId}/cancel`)).status, 200);
  assert.equal(store.getJob(jobId).state, 'CANCELLED');
  assert.equal((await post('/api/jobs/999/retry')).status, 404);
});
