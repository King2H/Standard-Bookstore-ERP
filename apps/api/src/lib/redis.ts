/**
 * ioredis singleton — fully optional.
 *
 * If REDIS_URL is not set, all Redis operations are no-ops and return null.
 * The app works correctly without Redis — config caching just falls back to DB.
 */
import Redis from 'ioredis';

let _redis: Redis | null = null;
let _attempted = false;

function getRedis(): Redis | null {
  // If no REDIS_URL configured, skip entirely
  if (!process.env.REDIS_URL) return null;

  if (!_attempted) {
    _attempted = true;
    try {
      _redis = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        enableReadyCheck: false,
        lazyConnect: true,
        retryStrategy: (times) => {
          if (times > 3) return null; // stop retrying
          return Math.min(times * 500, 2000);
        },
      });

      _redis.on('error', (err) => {
        console.warn(JSON.stringify({ level: 'warn', msg: 'Redis unavailable — running without cache', error: err.message }));
      });

      _redis.on('connect', () => {
        console.log(JSON.stringify({ level: 'info', msg: 'Redis connected' }));
      });
    } catch {
      _redis = null;
    }
  }

  return _redis;
}

/** Safely get a value from Redis. Returns null if Redis is unavailable. */
export async function redisGet(key: string): Promise<string | null> {
  const r = getRedis();
  if (!r) return null;
  try { return await r.get(key); } catch { return null; }
}

/** Safely set a value in Redis with optional TTL (seconds). No-op if unavailable. */
export async function redisSet(key: string, value: string, ttlSeconds?: number): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    if (ttlSeconds) {
      await r.set(key, value, 'EX', ttlSeconds);
    } else {
      await r.set(key, value);
    }
  } catch { /* ignore */ }
}

/** Safely delete a key from Redis. No-op if unavailable. */
export async function redisDel(key: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try { await r.del(key); } catch { /* ignore */ }
}

/** Publish to a Redis pub/sub channel. No-op if unavailable. */
export async function redisPublish(channel: string, message: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try { await r.publish(channel, message); } catch { /* ignore */ }
}
