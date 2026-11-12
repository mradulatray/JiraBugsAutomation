import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../webhook-listener/rateLimit.js';

test('allows up to capacity, then refills over time', () => {
  let t = 0;
  const rl = createRateLimiter({ capacity: 2, refillPerSec: 1, now: () => t });
  assert.equal(rl.take('a').allowed, true);
  assert.equal(rl.take('a').allowed, true);
  const denied = rl.take('a');
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterSec >= 1);
  assert.equal(rl.take('b').allowed, true, 'keys are independent');
  t = 1000;
  assert.equal(rl.take('a').allowed, true);
});
