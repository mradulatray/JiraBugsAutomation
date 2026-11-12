import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateJiraEvent } from '../jira-integration/webhookFilter.js';
import { assignPayload, testConfig, OTHER } from './helpers.js';

const opts = () => ({ ...testConfig().jira, now: Date.now() });

test('accepts a new Bug assignment to me', () => {
  const v = evaluateJiraEvent(assignPayload(), opts());
  assert.equal(v.accept, true);
  assert.equal(v.issueKey, 'NGBUGS-1234');
  assert.equal(v.dedupeKey, 'NGBUGS-1234:assign:10001');
});

test('accepts an issue created already assigned to me', () => {
  const v = evaluateJiraEvent(assignPayload({ event: 'jira:issue_created' }), opts());
  assert.equal(v.accept, true);
  assert.equal(v.dedupeKey, 'NGBUGS-1234:created');
});

const cases = [
  ['not assigned to me', { to: OTHER }, 'not_assigned_to_me'],
  ['not a bug', { type: 'Story' }, 'issue_type_not_allowed'],
  ['other project', { project: 'NGRES', key: 'NGRES-1' }, 'project_not_allowed'],
  ['key/project mismatch', { key: 'NGRES-1' }, 'project_not_allowed'],
  ['stale', { timestamp: Date.now() - 7 * 3600_000 }, 'stale_event'],
  ['unsupported event', { event: 'comment_created' }, 'unsupported_event'],
  ['bad key', { key: 'ngbugs-1; rm -rf /' }, 'invalid_issue_key'],
];
for (const [name, p, reason] of cases) {
  test(`rejects: ${name}`, () => {
    assert.equal(evaluateJiraEvent(assignPayload(p), opts()).reason, reason);
  });
}

test('ignores updates that do not change the assignee (e.g. comment edit while assigned)', () => {
  const p = assignPayload();
  p.changelog.items = [{ field: 'status', fieldId: 'status', to: '3' }];
  assert.equal(evaluateJiraEvent(p, opts()).reason, 'no_assignment_change');
});

test('rejects when account id not configured', () => {
  assert.equal(evaluateJiraEvent(assignPayload(), { ...opts(), accountId: '' }).reason, 'account_not_configured');
});
