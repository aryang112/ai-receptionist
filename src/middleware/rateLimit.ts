import type { Request, Response, NextFunction, RequestHandler } from 'express';

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Minimal in-memory fixed-window rate limiter keyed by client IP. Zero external
 * dependencies. A periodic sweep drops expired buckets so the map can't grow
 * unbounded on a long-running process.
 */
export function rateLimiter({
  windowMs,
  max,
}: {
  windowMs: number;
  max: number;
}): RequestHandler {
  const buckets = new Map<string, Bucket>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, b] of buckets) if (b.resetAt <= now) buckets.delete(key);
  }, windowMs);
  sweep.unref?.(); // don't keep the process alive just for cleanup

  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
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
