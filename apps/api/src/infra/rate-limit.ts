import type { Redis } from 'ioredis';
import { tooManyRequests } from '../lib/errors';

/**
 * Fixed-window rate limit in Redis. Throws 429 when `key` has been hit more than `limit`
 * times in the current window. Keys are hashes, never raw IPs or emails.
 */
export async function rateLimit(redis: Redis, key: string, limit: number, windowSec: number): Promise<void> {
  const redisKey = `rl:${key}`;
  const result = await redis.multi().incr(redisKey).expire(redisKey, windowSec, 'NX').ttl(redisKey).exec();
  const count = Number(result?.[0]?.[1] ?? 0);
  const ttl = Number(result?.[2]?.[1] ?? windowSec);
  if (count > limit) throw tooManyRequests(ttl > 0 ? ttl : windowSec);
}
