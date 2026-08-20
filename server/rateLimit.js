// A plain in-memory fixed-window limiter — good enough for a single-process server like this
// one; would need a shared store (Redis, etc.) only if this ever runs as more than one instance.
const buckets = new Map(); // key -> { count, windowStart }

export function isRateLimited(key, { max, windowMs }) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return false;
  }
  bucket.count++;
  return bucket.count > max;
}
