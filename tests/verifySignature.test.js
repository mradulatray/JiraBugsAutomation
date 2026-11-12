import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSignature, verifySignature } from '../webhook-listener/verifySignature.js';

const secret = 'test-secret-value-123';
const body = Buffer.from('{"a":1}');

test('accepts a correct signature', () => {
  assert.deepEqual(verifySignature({ secret, rawBody: body, header: computeSignature(secret, body) }), { ok: true });
});

test('accepts uppercase hex', () => {
  const header = 'sha256=' + computeSignature(secret, body).slice(7).toUpperCase();
  assert.equal(verifySignature({ secret, rawBody: body, header }).ok, true);
});

test('rejects missing / malformed / wrong signatures', () => {
  assert.equal(verifySignature({ secret, rawBody: body, header: undefined }).reason, 'missing_signature');
  assert.equal(verifySignature({ secret, rawBody: body, header: 'sha1=abc' }).reason, 'malformed_signature');
  assert.equal(verifySignature({ secret, rawBody: body, header: computeSignature('other', body) }).reason, 'bad_signature');
});

test('signature is bound to exact raw bytes (whitespace change fails)', () => {
  const header = computeSignature(secret, body);
  assert.equal(verifySignature({ secret, rawBody: Buffer.from('{"a": 1}'), header }).ok, false);
});

test('rejects when no secret configured or body is not raw', () => {
  assert.equal(verifySignature({ secret: '', rawBody: body, header: 'x' }).reason, 'no_secret_configured');
  assert.equal(verifySignature({ secret, rawBody: { a: 1 }, header: 'x' }).reason, 'no_raw_body');
});
