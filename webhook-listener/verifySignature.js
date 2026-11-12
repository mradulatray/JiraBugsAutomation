// HMAC-SHA256 verification of Jira Cloud webhooks (header "X-Hub-Signature: sha256=<hex>").
// Must be given the exact raw request bytes - never a re-serialised JSON body.
import { createHmac, timingSafeEqual } from 'node:crypto';

const SIG_RE = /^sha256=([a-f0-9]{64})$/i;

export function computeSignature(secret, rawBody) {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function verifySignature({ secret, rawBody, header }) {
  if (!secret) return { ok: false, reason: 'no_secret_configured' };
  if (!Buffer.isBuffer(rawBody)) return { ok: false, reason: 'no_raw_body' };
  if (typeof header !== 'string' || header.length === 0) return { ok: false, reason: 'missing_signature' };

  const m = SIG_RE.exec(header.trim());
  if (!m) return { ok: false, reason: 'malformed_signature' };

  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(m[1], 'hex');
  if (given.length !== expected.length) return { ok: false, reason: 'bad_signature' };
  return timingSafeEqual(given, expected) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

// Shared-token auth for senders that cannot sign (Jira Automation "Send web request").
// Both sides are hashed first so the comparison is constant-time and length-independent.
export function verifyToken({ secret, header }) {
  if (!secret) return { ok: false, reason: 'no_secret_configured' };
  if (typeof header !== 'string' || header.length === 0) return { ok: false, reason: 'missing_token' };
  if (header.length > 1024) return { ok: false, reason: 'bad_token' };
  const a = createHmac('sha256', 'ngauto-token').update(header.trim()).digest();
  const b = createHmac('sha256', 'ngauto-token').update(secret).digest();
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'bad_token' };
}
