import { logger } from "./logger";
import { redis } from "./redis";

// Fixed-window counter in Redis, shared by all API instances. Used on the public verify
// endpoint so nobody can hammer it to guess codes. Fails OPEN if Redis is unavailable:
// better a verify page that works than one that is down because a cache restarted.
export async function allow(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  try {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, windowSeconds);
    return n <= limit;
  } catch (err) {
    logger.warn({ err }, "rate limiter unavailable; allowing request");
    return true;
  }
}

// Forget a counter, e.g. when someone finally signs in correctly: their earlier typos
// must not count towards locking them out.
export async function reset(key: string): Promise<void> {
  try {
    await redis.del(key);
  } catch (err) {
    logger.warn({ err }, "rate limiter unavailable; could not reset");
  }
}
