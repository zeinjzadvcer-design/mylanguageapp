/**
 * Session storage in Redis.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Sessions were in PostgreSQL via `connect-pg-simple`, and under load they were
 * the single largest consumer of the database. Measured with
 * `pg_stat_statements` during a 90-caller load test:
 *
 *   UPDATE "session" SET expire = ...   11,579 calls   3,635 ms
 *   SELECT sess FROM "session" ...      11,579 calls   2,343 ms
 *
 * Just under half of all database time, and it scales with EVERY request from
 * EVERY user — not with any particular feature. Two queries per request: one
 * read to load the session, one write because `rolling: true` re-sends the
 * cookie on every response and the store's expiry has to keep up with it.
 *
 * In Redis the read is a GET and the refresh is an EXPIRE — both in memory,
 * neither touching a disk. A session is also exactly the kind of data Redis is
 * for: small, hot, read on every request, and worthless once expired.
 *
 * THE TRADE, STATED PLAINLY
 * ─────────────────────────
 * This makes Redis load-bearing for AUTHENTICATION. Before it, a Redis outage
 * cost the AI features (which fail closed) and the cache (which falls back to
 * the database); everyone stayed logged in. After it, a Redis outage logs
 * everyone out until it returns.
 *
 * There is no useful fallback. Writing each session to both stores would undo
 * the saving, and falling back to Postgres on a read would find nothing there
 * to read — so the session is gone either way, and a hybrid would only add
 * complexity for an outcome it cannot change.
 *
 * `REDIS_URL` unset keeps the PostgreSQL store, so development without Redis
 * works unchanged.
 */

import type { SessionData, Store } from "express-session";
import session from "express-session";
import Redis from "ioredis";
import { logger } from "../lib/logger";

/** Key prefix, so session keys are obvious in `redis-cli --scan`. */
const PREFIX = "sess:";

/** Fallback TTL when a session carries no cookie expiry, in seconds. */
const DEFAULT_TTL_S = 30 * 24 * 60 * 60;

/**
 * A connection of its own, not the shared client from `services/redis.ts`.
 *
 * That one is deliberately tuned to fail fast so callers can fall back to the
 * database — `enableOfflineQueue: false`, a one-second command timeout, no
 * retries. Correct for a cache; wrong for sessions, where a brief reconnect
 * should make a request wait a moment rather than log the person out.
 *
 * So this connection queues while reconnecting and allows a retry. The cost is
 * one extra TCP connection per process.
 */
function createSessionClient(url: string): Redis {
  const client = new Redis(url, {
    // Hold commands during a reconnect instead of rejecting them. A dropped
    // connection then delays a request; it does not end a session.
    enableOfflineQueue: true,
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => Math.min(times * 200, 5000),
    connectTimeout: parseInt(process.env.REDIS_CONNECT_TIMEOUT ?? "3000", 10),
    // Longer than the shared client's 1s: a session read is not optional, so
    // waiting is better than failing. Still bounded, so a request cannot hang.
    commandTimeout: parseInt(process.env.SESSION_REDIS_CMD_TIMEOUT ?? "3000", 10),
    tls: url.startsWith("rediss://") ? {} : undefined,
    lazyConnect: true,
  });

  client.on("error", (err: Error) => {
    logger.warn({ err: err.message }, "Session store Redis error");
  });

  client.connect().catch(() => {
    logger.warn("Session store Redis initial connection failed — will retry");
  });

  return client;
}

/**
 * The express-session `Store` contract, over ioredis.
 *
 * Written here rather than taken from `connect-redis`, whose current major
 * version speaks node-redis's API (`set(key, val, { expiration: … })`) and
 * would mean a second Redis client library in the process for the sake of four
 * methods. The same reasoning as `services/mailer.ts` calling two documented
 * endpoints with `fetch` instead of pulling in two SDKs.
 *
 * `all`, `length` and `clear` are deliberately absent: express-session never
 * calls them during a request, and implementing them means scanning the whole
 * keyspace, which is the kind of thing that gets run on a production Redis
 * exactly once.
 */
class RedisSessionStore extends session.Store {
  constructor(private readonly client: Redis) {
    super();
  }

  /** Seconds until this session should disappear. */
  private ttl(sess: SessionData): number {
    const maxAge = sess.cookie?.maxAge;
    if (typeof maxAge === "number" && maxAge > 0) return Math.ceil(maxAge / 1000);
    return DEFAULT_TTL_S;
  }

  get(
    sid: string,
    callback: (err?: unknown, session?: SessionData | null) => void,
  ): void {
    this.client
      .get(PREFIX + sid)
      .then((raw) => {
        if (!raw) return callback(null, null);
        try {
          callback(null, JSON.parse(raw) as SessionData);
        } catch (err) {
          // Unparseable means something else wrote this key, or it was
          // truncated. Treat it as absent rather than as an error: the person
          // logs in again, which is better than a 500 on every request.
          logger.warn({ sid }, "Session value could not be parsed — discarding");
          callback(null, null);
        }
      })
      .catch((err) => callback(err));
  }

  set(sid: string, sess: SessionData, callback?: (err?: unknown) => void): void {
    this.client
      .set(PREFIX + sid, JSON.stringify(sess), "EX", this.ttl(sess))
      .then(() => callback?.())
      .catch((err) => callback?.(err));
  }

  /**
   * Push the expiry out without rewriting the value.
   *
   * This is the method the whole change is about. With `rolling: true`
   * express-session calls it on every response for an unmodified session, and
   * in PostgreSQL that was an UPDATE — the most expensive query in the
   * application. Here it is one EXPIRE against a key already in memory.
   */
  touch(sid: string, sess: SessionData, callback?: (err?: unknown) => void): void {
    this.client
      .expire(PREFIX + sid, this.ttl(sess))
      .then(() => callback?.())
      .catch((err) => callback?.(err));
  }

  destroy(sid: string, callback?: (err?: unknown) => void): void {
    this.client
      .del(PREFIX + sid)
      .then(() => callback?.())
      .catch((err) => callback?.(err));
  }
}

/**
 * A Redis-backed session store, or null when `REDIS_URL` is not set.
 *
 * Null is not a failure: the caller keeps the PostgreSQL store, which is what
 * development without Redis should do.
 */
export function createRedisSessionStore(): Store | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  return new RedisSessionStore(createSessionClient(url));
}
