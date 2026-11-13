/**
 * Redis Client Singleton
 *
 * A single ioredis client shared across the entire API server process.
 * All Redis calls go through this module — no direct ioredis imports elsewhere.
 *
 * DESIGN PRINCIPLES
 * ──────────────────
 * 1. Graceful degradation: Redis unavailability never crashes the application.
 *    `isAvailable()` returns false when the connection is down so callers can
 *    fall back to PostgreSQL without throwing.
 * 2. No offline queue: commands are NOT queued while Redis is down.
 *    `enableOfflineQueue: false` means a Redis call made while disconnected
 *    rejects immediately instead of hanging indefinitely.
 * 3. Lazy connect: the process starts even if Redis is unreachable.
 * 4. Singleton: one TCP connection reused for all requests.
 *
 * FAILURE BEHAVIOR (by feature)
 * ──────────────────────────────
 * - Caching:             fail open → DB fallback (always)
 * - General rate limits: fail open → allow the request
 * - AI quota:            fail CLOSED → deny the AI request (cost protection)
 *
 * CONFIGURATION
 * ──────────────
 * Set REDIS_URL in the environment. Leave it unset to run without Redis
 * (in-process cache only; suitable for single-server development).
 *
 * Supported URL formats:
 *   redis://[:password@]host:port[/db]
 *   rediss://...   (TLS)
 */

import Redis from "ioredis";
import { logger } from "../lib/logger";

// ─── Connection state ─────────────────────────────────────────────────────────

let _client: Redis | null = null;
let _available = false;

function createClient(): Redis | null {
  const url = process.env.REDIS_URL;
  if (!url) {
    logger.info("REDIS_URL not set — running without Redis (in-process cache only)");
    return null;
  }

  const client = new Redis(url, {
    // Don't queue commands while disconnected — fail fast so callers fall back
    enableOfflineQueue: false,
    // Lazy connect so startup doesn't block on Redis
    lazyConnect: true,
    // Reconnect with exponential backoff, capped at 5 s
    retryStrategy: (times) => Math.min(times * 200, 5000),
    // Connection-level timeout
    connectTimeout: parseInt(process.env.REDIS_CONNECT_TIMEOUT ?? "3000", 10),
    // Command timeout (prevents indefinite hangs)
    commandTimeout: parseInt(process.env.REDIS_CMD_TIMEOUT ?? "1000", 10),
    // TLS support: rediss:// URLs enable TLS automatically in ioredis
    tls: url.startsWith("rediss://") ? {} : undefined,
    maxRetriesPerRequest: 0, // fail immediately; retryStrategy handles reconnects
  });

  // Available on "ready", not "connect": between the two the socket is open
  // but ioredis is still checking the server, and with no offline queue every
  // command sent in that gap fails with "Stream isn't writeable". Callers
  // would take that as Redis being down, on every reconnect.
  client.on("connect", () => {
    logger.info("Redis connected");
  });

  client.on("ready", () => {
    _available = true;
  });

  client.on("error", (err: Error) => {
    if (_available) {
      logger.warn({ err: err.message }, "Redis error — falling back to database");
    }
    _available = false;
  });

  client.on("close", () => {
    _available = false;
  });

  // Fire-and-forget initial connect; errors are handled by the event listener
  client.connect().catch(() => {
    logger.warn("Redis initial connection failed — will retry automatically");
  });

  return client;
}

/** The singleton client. Null when REDIS_URL is not configured. */
export const redis: Redis | null = (() => {
  _client = createClient();
  return _client;
})();

/**
 * Returns true when Redis is connected and accepting commands.
 * Always false when REDIS_URL is not set.
 * Use this before any Redis call to decide whether to fall back.
 */
export function isRedisAvailable(): boolean {
  return _client !== null && _available;
}

/**
 * Safe wrapper: runs `fn` only when Redis is available.
 * If Redis is down, returns `fallback` instead of throwing.
 * Always use this for non-critical Redis calls (cache, optional rate limits).
 */
export async function withRedis<T>(
  fn: (client: Redis) => Promise<T>,
  fallback: T,
): Promise<T> {
  if (!_client || !_available) return fallback;
  try {
    return await fn(_client);
  } catch (err) {
    logger.debug({ err }, "Redis operation failed — using fallback");
    return fallback;
  }
}

/**
 * Critical wrapper: runs `fn` only when Redis is available.
 * If Redis is down, THROWS with a clear error message.
 * Use this for AI quota checks and other security-sensitive Redis calls
 * where failing open would allow unlimited expensive requests.
 */
export async function withRedisCritical<T>(
  fn: (client: Redis) => Promise<T>,
  featureName: string,
): Promise<T> {
  if (!_client || !_available) {
    throw new Error(
      `${featureName} is temporarily unavailable (Redis is offline). Please try again in a moment.`,
    );
  }
  return fn(_client);
}
