import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openJobStore } from '../queue/jobStore.js';
import { tempDir } from './helpers.js';

const open = () => openJobStore(path.join(tempDir(), 'state.db'));

test('enqueue, duplicate event, active-job protection', () => {
  const s = open();
  const a = s.enqueue({ issueKey: 'NGBUGS-1', source: 'webhook', dedupeKey: 'NGBUGS-1:assign:1' });
  assert.equal(a.status, 'enqueued');
  assert.equal(a.job.state, 'QUEUED');
  assert.equal(s.enqueue({ issueKey: 'NGBUGS-1', source: 'webhook', dedupeKey: 'NGBUGS-1:assign:1' }).status, 'duplicate_event');
  assert.equal(s.enqueue({ issueKey: 'NGBUGS-1', source: 'reconciler', dedupeKey: 'NGBUGS-1:assign:2' }).status, 'active_job_exists');
  s.transition(a.job.id, 'CANCELLED');
  assert.equal(s.enqueue({ issueKey: 'NGBUGS-1', source: 'webhook', dedupeKey: 'NGBUGS-1:assign:3' }).status, 'enqueued');
  s.close();
});

test('illegal transitions throw; MR_DRAFT cannot be skipped', () => {
  const s = open();
  const { job } = s.enqueue({ issueKey: 'NGBUGS-2', source: 'webhook', dedupeKey: 'k2' });
  assert.throws(() => s.transition(job.id, 'MERGED'), /Illegal transition/);
  assert.throws(() => s.transition(job.id, 'FETCHING', { patch: { state: 'MERGED' } }), /not patchable/);
  s.transition(job.id, 'FETCHING');
  assert.equal(s.getJob(job.id).attempts, 1);
  s.close();
});

test('recoverInterrupted marks in-flight jobs INTERRUPTED', () => {
  const s = open();
  const { job } = s.enqueue({ issueKey: 'NGBUGS-3', source: 'webhook', dedupeKey: 'k3' });
  s.transition(job.id, 'FETCHING');
  s.transition(job.id, 'ANALYZING');
  const recovered = s.recoverInterrupted();
  assert.equal(recovered.length, 1);
  assert.equal(s.getJob(job.id).state, 'INTERRUPTED');
  assert.deepEqual(s.jobEvents(job.id).map((e) => e.to_state), ['QUEUED', 'FETCHING', 'ANALYZING', 'INTERRUPTED']);
  s.close();
});

test('recordDelivery dedupes delivery ids', () => {
  const s = open();
  assert.equal(s.recordDelivery('d-1'), true);
  assert.equal(s.recordDelivery('d-1'), false);
  s.close();
});
