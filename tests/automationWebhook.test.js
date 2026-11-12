import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createApp } from '../webhook-listener/server.js';
import { verifyToken } from '../webhook-listener/verifySignature.js';
import { createReconciler } from '../jira-integration/reconciler.js';
import { openJobStore } from '../queue/jobStore.js';
import { createKillSwitch } from '../security/killSwitch.js';
import { nullLogger } from '../lib/logger.js';
import { ME, tempDir, testConfig } from './helpers.js';

const SECRET = 'automation-shared-secret-for-tests';
let server, base, jobStore, getIssueCalls;
const config = testConfig({ jira: { ...testConfig().jira, webhookAuth: 'token', tokenHeader: 'x-ngauto-token' } });

const jira = {
  async getIssue(key) {
    getIssueCalls.push(key);
    const assignee = key === 'NGBUGS-2' ? 'someone-else' : ME;
    return { id: '1', key, fields: { project: { key: 'NGBUGS' }, issuetype: { name: 'Bug' }, assignee: { accountId: assignee }, created: new Date().toISOString() } };
  },
  async getChangelog() {
    return [{ id: '555', created: new Date().toISOString(), items: [{ fieldId: 'assignee', to: ME }] }];
  },
};

const post = (body, token = SECRET, { client = '203.0.113.9' } = {}) =>
  fetch(`${base}/hooks/jira`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': client, ...(token && { 'x-ngauto-token': token }) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const settle = () => new Promise((r) => setTimeout(r, 50));

before(async () => {
  getIssueCalls = [];
  const dir = tempDir();
  jobStore = openJobStore(path.join(dir, 'state.db'));
  const killSwitch = createKillSwitch(path.join(dir, 'KILL'));
  const reconciler = createReconciler({ config, jira, jobStore, logger: nullLogger, killSwitch });
  const secrets = { get: async () => SECRET, has: async () => true };
  const app = createApp({ config, logger: nullLogger, secrets, jobStore, killSwitch, reconciler });
  await new Promise((r) => {
    server = app.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  jobStore.close();
});

test('verifyToken: exact match only', () => {
  assert.equal(verifyToken({ secret: 'abc', header: 'abc' }).ok, true);
  assert.equal(verifyToken({ secret: 'abc', header: 'abcd' }).ok, false);
  assert.equal(verifyToken({ secret: 'abc', header: undefined }).reason, 'missing_token');
});

test('missing or wrong token -> 401, Jira never called', async () => {
  assert.equal((await post({ issueKey: 'NGBUGS-1' }, null)).status, 401);
  assert.equal((await post({ issueKey: 'NGBUGS-1' }, 'wrong')).status, 401);
  assert.equal(getIssueCalls.length, 0);
});

test('bad issue key -> 400', async () => {
  assert.equal((await post({ issueKey: '../etc' })).status, 400);
  assert.equal((await post({})).status, 400);
});

test('valid request -> 202, issue re-fetched from Jira and enqueued once', async () => {
  const r = await post({ issueKey: 'NGBUGS-1' });
  assert.equal(r.status, 202);
  await settle();
  assert.deepEqual(getIssueCalls, ['NGBUGS-1']);
  const [job] = jobStore.listJobs();
  assert.equal(job.issue_key, 'NGBUGS-1');
  assert.equal(job.source, 'automation');
  assert.equal(job.dedupe_key, 'NGBUGS-1:assign:555');

  await post({ issueKey: 'NGBUGS-1' }); // Automation retry / duplicate rule fire
  await settle();
  assert.equal(jobStore.listJobs().length, 1);
});

test('body is only a hint: issue not actually assigned to me -> nothing enqueued', async () => {
  await post({ issueKey: 'NGBUGS-2' });
  await settle();
  assert.equal(jobStore.listJobs().filter((j) => j.issue_key === 'NGBUGS-2').length, 0);
});

test('other project key -> not fetched from Jira', async () => {
  const before = getIssueCalls.length;
  await post({ issueKey: 'OTHER-9' });
  await settle();
  assert.equal(getIssueCalls.length, before);
});
