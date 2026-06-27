import type { RequestHandler } from "express";

const buckets = new Map<string, { count: number; resetAt: number }>();

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  keyPrefix: string;
  key?: (req: RateLimitRequest) => string | null | undefined;
}

export interface RateLimitRequest {
  ip?: string;
  auth?: { id?: string };
}

export function createRateLimiter({
  windowMs,
  max,
  keyPrefix,
  key
}: RateLimiterOptions): RequestHandler {
  return function rateLimiter(req, res, next) {
    const now = Date.now();
    const rateLimitReq = req as RateLimitRequest;
    const identity = key ? key(rateLimitReq) : rateLimitReq.auth?.id || rateLimitReq.ip || "anonymous";
    const bucketKey = `${keyPrefix}:${identity}`;
    const current = buckets.get(bucketKey);

    if (!current || current.resetAt <= now) {
      buckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
      return next();
    }

    current.count += 1;
    if (current.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((current.resetAt - now) / 1000)));
      res.status(429).json({ ok: false, error: "Upload rate limit exceeded." });
      return;
    }

    next();
  };
}
