import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildJql, createReconciler, evaluatePolledIssue } from '../jira-integration/reconciler.js';
import { JiraApiError } from '../jira-integration/jiraClient.js';
import { openJobStore } from '../queue/jobStore.js';
import { nullLogger } from '../lib/logger.js';
import { ME, OTHER, tempDir, testConfig } from './helpers.js';

const NOW = Date.parse('2026-11-08T12:00:00Z');
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const rules = { ...testConfig().jira, now: NOW };

function issue({ key = 'NGBUGS-10', assignee = ME, type = 'Bug', project = 'NGBUGS', created = ago(60 * 24) } = {}) {
  return { id: '30010', key, fields: { project: { key: project }, issuetype: { name: type }, assignee: assignee && { accountId: assignee }, created } };
}
const assignHist = (id, min, to = ME) => ({ id: String(id), created: ago(min), items: [{ field: 'assignee', fieldId: 'assignee', from: OTHER, to }] });

test('buildJql quotes values and scopes to recent assignment', () => {
  const jql = buildJql({ accountId: 'a"b', projects: ['NGBUGS'], issueTypes: ['Bug'], lookbackMin: 7.2 });
  assert.match(jql, /assignee = "a\\"b"/);
  assert.match(jql, /project in \("NGBUGS"\)/);
  assert.match(jql, /assignee CHANGED TO "a\\"b" AFTER "-8m" OR created >= "-8m"/);
});

test('recent assignment -> accepted with webhook-compatible dedupe key', () => {
  const v = evaluatePolledIssue(issue(), [assignHist(5, 300, OTHER), assignHist(7, 10)], rules);
  assert.equal(v.accept, true);
  assert.equal(v.dedupeKey, 'NGBUGS-10:assign:7');
  assert.equal(v.trigger, 'assigned');
});

test('assignment older than maxEventAgeSec -> stale', () => {
  assert.equal(evaluatePolledIssue(issue(), [assignHist(7, 60 * 7)], rules).reason, 'stale_assignment');
});

test('created already assigned (no assignee history) -> created key', () => {
  const v = evaluatePolledIssue(issue({ created: ago(3) }), [], rules);
  assert.equal(v.dedupeKey, 'NGBUGS-10:created');
});

test('filters: other assignee, non-bug, other project, bad key', () => {
  assert.equal(evaluatePolledIssue(issue({ assignee: OTHER }), [], rules).reason, 'not_assigned_to_me');
  assert.equal(evaluatePolledIssue(issue({ type: 'Story' }), [], rules).reason, 'issue_type_not_allowed');
  assert.equal(evaluatePolledIssue(issue({ project: 'OTHER', key: 'OTHER-1' }), [], rules).reason, 'project_not_allowed');
  assert.equal(evaluatePolledIssue(issue({ key: 'ngbugs-1;rm' }), [], rules).reason, 'invalid_issue_key');
});

function fakeJira({ issues = [], histories = {}, fail } = {}) {
  const calls = { search: [] };
  return {
    calls,
    async searchIssues(jql) {
      calls.search.push(jql);
      if (fail) throw fail;
      return issues;
    },
    async getChangelog(key) {
      return histories[key] ?? [];
    },
  };
}

test('pollOnce enqueues once; webhook + poll dedupe to one job; dry run enqueues nothing', async () => {
  const store = openJobStore(path.join(tempDir(), 'state.db'));
  const jira = fakeJira({ issues: [issue()], histories: { 'NGBUGS-10': [assignHist(42, 5)] } });
  const killSwitch = { isActive: () => false };
  const rec = createReconciler({ config: testConfig(), jira, jobStore: store, logger: nullLogger, killSwitch, now: () => NOW });

  const dry = await rec.pollOnce({ dryRun: true });
  assert.equal(dry.results[0].status, 'would_enqueue');
  assert.equal(store.listJobs().length, 0);

  store.enqueue({ issueKey: 'NGBUGS-10', source: 'webhook', dedupeKey: 'NGBUGS-10:assign:42' }); // webhook got there first
  const r = await rec.pollOnce();
  assert.equal(r.results[0].status, 'duplicate_event');
  assert.equal(store.listJobs().length, 1);

  await rec.pollOnce();
  // first poll looks back maxEventAgeSec; later polls only since last success + overlap
  assert.match(jira.calls.search[0], /"-360m"/);
  assert.match(jira.calls.search.at(-1), /"-5m"/);
  store.close();
});

test('pollOnce does nothing while the kill switch is active', async () => {
  const jira = fakeJira({ issues: [issue()] });
  const rec = createReconciler({ config: testConfig(), jira, jobStore: null, logger: nullLogger, killSwitch: { isActive: () => true } });
  assert.equal((await rec.pollOnce()).skipped, 'kill_switch');
  assert.equal(jira.calls.search.length, 0);
});

test('scheduler backs off on errors and honours Retry-After', async () => {
  const delays = [];
  let fire;
  const setTimer = (fn, ms) => {
    delays.push(ms);
    fire = fn;
    return { unref() {} };
  };
  const jira = fakeJira({ fail: new JiraApiError(429, '/x', { retryAfterSec: 900 }) });
  const config = testConfig({ jira: { ...testConfig().jira, poll: { intervalSec: 60, overlapMin: 5 } } });
  const rec = createReconciler({ config, jira, jobStore: null, logger: nullLogger, killSwitch: { isActive: () => false }, setTimer, clearTimer() {} });
  rec.start({ initialDelayMs: 0 });
  await fire();
  rec.stop();
  assert.deepEqual(delays, [0, 900_000]);
});

test('pollOnce fails on bad credentials instead of searching anonymously', async () => {
  const killSwitch = { isActive: () => false };
  const mk = (myself) => {
    const jira = { ...fakeJira({ issues: [issue()] }), myself };
    return { jira, rec: createReconciler({ config: testConfig(), jira, jobStore: null, logger: nullLogger, killSwitch, now: () => NOW }) };
  };

  const bad = mk(async () => { throw new JiraApiError(401, '/rest/api/3/myself'); });
  await assert.rejects(bad.rec.pollOnce({ dryRun: true }), (e) => e.status === 401);
  assert.equal(bad.jira.calls.search.length, 0);

  const wrong = mk(async () => ({ accountId: OTHER }));
  await assert.rejects(wrong.rec.pollOnce({ dryRun: true }), (e) => e.status === 403);

  const ok = mk(async () => ({ accountId: ME }));
  await ok.rec.pollOnce({ dryRun: true });
  assert.equal(ok.jira.calls.search.length, 1);
});
