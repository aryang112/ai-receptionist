import type { Request, Response, NextFunction, RequestHandler } from 'express';

interface Bucket {
  count: number;
  resetAt: number;
}

// F10l: with `trust proxy: true`, req.ip is the leftmost X-Forwarded-For, which
// is client-controllable — spoofed/rotating IPs can both evade the per-IP limit
// AND bloat the bucket map. Signature validation on /twilio + the small blast
// radius make this low risk, but we still bound memory with a hard cap on the
// number of distinct buckets (over-cap = inline sweep, then reject).
const MAX_BUCKETS = 10_000;

/**
 * Minimal in-memory fixed-window rate limiter keyed by client IP. Zero external
 * dependencies. A periodic sweep drops expired buckets and MAX_BUCKETS caps
 * total memory so a long-running process can't grow unbounded (F10l).
 */
export function rateLimiter({
  windowMs,
  max,
}: {
  windowMs: number;
  max: number;
}): RequestHandler {
  const buckets = new Map<string, Bucket>();

  const sweepExpired = () => {
    const now = Date.now();
    for (const [key, b] of buckets) if (b.resetAt <= now) buckets.delete(key);
  };
  const sweep = setInterval(sweepExpired, windowMs);
  sweep.unref?.(); // don't keep the process alive just for cleanup

  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      // New key: bound growth against spoofed/rotating IPs.
      if (!buckets.has(key) && buckets.size >= MAX_BUCKETS) {
        sweepExpired();
        if (buckets.size >= MAX_BUCKETS) {
          res.status(429).json({ error: 'Too many requests' });
          return;
        }
      }
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }
    next();
  };
}
