import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, registerSecret } from '../security/redact.js';

test('redacts sensitive keys, token shapes and registered secrets', () => {
  registerSecret('my-runtime-secret-xyz');
  const out = redact({
    token: 'abc',
    headers: { Authorization: 'Bearer abcdefghijkl' },
    msg: 'figma figd_FAKEFAKEFAKEFAKEFAKEFAKE0000 and glpat-aaaaaaaaaaaaaaaaaaaaaaaa',
    note: 'leaked my-runtime-secret-xyz here',
    nested: [{ password: 'p' }],
  });
  assert.equal(out.token, '[REDACTED]');
  assert.equal(out.headers.Authorization, '[REDACTED]');
  assert.equal(out.msg, 'figma [REDACTED] and [REDACTED]');
  assert.equal(out.note, 'leaked [REDACTED] here');
  assert.equal(out.nested[0].password, '[REDACTED]');
});
