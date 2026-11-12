// In-memory token bucket. Good enough for a single local process; swap for a shared
// store (Redis/API Gateway throttling) when moving to the cloud.
export function createRateLimiter({ capacity, refillPerSec, now = () => Date.now(), maxKeys = 10_000 }) {
  const buckets = new Map();

  function take(key = 'global') {
    const t = now();
    let b = buckets.get(key);
    if (!b) {
      if (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value);
      b = { tokens: capacity, last: t };
      buckets.set(key, b);
    }
    b.tokens = Math.min(capacity, b.tokens + ((t - b.last) / 1000) * refillPerSec);
    b.last = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true };
    }
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / refillPerSec)) };
  }

  return { take };
}
