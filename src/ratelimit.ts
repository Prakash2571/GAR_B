import type { Request, Response, NextFunction } from "express";
import { trustedClientIp } from "./clientIp.js";

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * The most distinct clients one limiter will track at once.
 *
 * WHY A BOUND IS REQUIRED. The map had none. With a forgeable key an attacker inserted one entry per
 * distinct header value and the map grew unchecked for a full window (five minutes on the verify
 * route) — a memory-growth denial of service that was a direct consequence of the spoofable key.
 * Keying on a trusted address removes the easy amplification, but an unbounded map keyed by anything
 * network-derived is still a liability, so the bound stays.
 *
 * On overflow the OLDEST-RESETTING bucket is evicted. That is the entry closest to expiring anyway,
 * so eviction cannot be used to clear a budget that is actively being spent.
 */
const MAX_TRACKED_CLIENTS = 10_000;

/**
 * Lightweight in-memory fixed-window rate limiter keyed by the TRUSTED client address.
 *
 * The key comes from {@link trustedClientIp}, which ignores forwarding headers unless the connection
 * itself arrives from a trusted proxy and then reads the hop OUR proxy appended. It used to read the
 * first `X-Forwarded-For` element, which on this deployment is the value the caller supplied — so a
 * client could reset its own budget at will. See `src/clientIp.ts` for the full argument.
 */
export function rateLimit(opts: {
  windowMs: number;
  max: number;
  message?: string;
}) {
  const buckets = new Map<string, Bucket>();

  /** Evict the bucket nearest to expiry, so an active budget cannot be flushed by flooding keys. */
  const evictOldest = (): void => {
    let oldestKey: string | null = null;
    let oldestResetAt = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt < oldestResetAt) {
        oldestResetAt = bucket.resetAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) buckets.delete(oldestKey);
  };

  // Periodically drop stale buckets so memory stays bounded.
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of buckets) {
      if (now > b.resetAt) buckets.delete(ip);
    }
  }, opts.windowMs);
  cleanup.unref?.();

  return (req: Request, res: Response, next: NextFunction) => {
    const ip = trustedClientIp(req);

    const now = Date.now();
    let bucket = buckets.get(ip);
    if (!bucket || now > bucket.resetAt) {
      if (!bucket && buckets.size >= MAX_TRACKED_CLIENTS) evictOldest();
      bucket = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(ip, bucket);
    }
    bucket.count++;

    if (bucket.count > opts.max) {
      res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      res
        .status(429)
        .json({ error: opts.message ?? "Too many requests. Please slow down." });
      return;
    }
    next();
  };
}
