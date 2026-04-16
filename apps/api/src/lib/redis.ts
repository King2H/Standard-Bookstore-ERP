/**
 * ioredis singleton.
 * Connects to REDIS_URL env var (defaults to localhost:6379 for local dev without Docker).
 * Gracefully degrades — if Redis is unavailable, operations that depend on it
 * (config cache, rate limiting) fall back to DB-only mode.
 */
import Redis from 'ioredis';

let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (!_redis) {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    _redis = new Redis(url, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
      retryStrategy: (times) => {
        if (times > 5) return null; // stop retrying after 5 attempts
        return Math.min(times * 200, 2000);
      },
    });

    _redis.on('error', (err) => {
      // Log but don't crash — Redis is optional for core operations
      console.error(JSON.stringify({ level: 'warn', msg: 'Redis connection error', error: err.message }));
    });

    _redis.on('connect', () => {
      console.log(JSON.stringify({ level: 'info', msg: 'Redis connected' }));
    });
  }
  return _redis;
}

/**
 * Safely get a value from Redis. Returns null on any error.
 */
export async function redisGet(key: string): Promise<string | null> {
  try {
    return await getRedis().get(key);
  } catch {
    return null;
  }
}

/**
 * Safely set a value in Redis with optional TTL (seconds). Ignores errors.
 */
export async function redisSet(key: string, value: string, ttlSeconds?: number): Promise<void> {
  try {
    if (ttlSeconds) {
      await getRedis().set(key, value, 'EX', ttlSeconds);
    } else {
      await getRedis().set(key, value);
    }
  } catch {
    // ignore
  }
}

/**
 * Safely delete a key from Redis. Ignores errors.
 */
export async function redisDel(key: string): Promise<void> {
  try {
    await getRedis().del(key);
  } catch {
    // ignore
  }
}

/**
 * Publish a message to a Redis pub/sub channel. Ignores errors.
 */
export async function redisPublish(channel: string, message: string): Promise<void> {
  try {
    await getRedis().publish(channel, message);
  } catch {
    // ignore
  }
}
