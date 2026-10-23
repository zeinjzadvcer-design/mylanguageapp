/**
 * Cache Service
 *
 * Implements cache-aside pattern. Callers use the public helpers
 * (cached(), invalidate(), invalidatePrefix()) without knowing whether
 * the backend is Redis or the in-process fallback.
 *
 * BACKENDS
 * ─────────
 * - Redis (preferred): shared across all API server instances; enables
 *   horizontal scaling.
 * - In-process Map (automatic fallback): used when Redis is unavailable or
 *   REDIS_URL is not set. Sufficient for a single-server deployment.
 *
 * WHAT SHOULD BE CACHED
 * ──────────────────────
 * Only stable, shared (non-user-specific) educational content:
 *   - Languages, Curricula, Levels (long TTL)
 *   - Lesson content/blocks/exercises (medium TTL)
 *   - Vocabulary by lesson/level (medium TTL)
 *   - Subscription plan definitions (long TTL)
 *
 * WHAT MUST NOT BE CACHED HERE
 * ──────────────────────────────
 * - Per-user progress, scores, XP
 * - Active subscription status (access-control decisions)
 * - Authentication/session data
 * - Any data where staleness causes security or financial harm
 *
 * KEY NAMING CONVENTION
 * ──────────────────────
 * All keys use a version prefix so future schema changes can bust all
 * existing cache entries by incrementing the version:
 *   v1:lang:list
 *   v1:curricula:list
 *   v1:sub:plans
 *   v1:levels:c:{curriculumId}
 *   v2:lesson:{lessonId}:content
 *   v1:vocab:lesson:{lessonId}
 *   v1:vocab:level:{levelId}
 */

import { withRedis, isRedisAvailable } from "./redis";
import { logger } from "../lib/logger";

// ─── TTL constants (seconds) ──────────────────────────────────────────────────

export const TTL = {
  /** Languages and curricula rarely change — admin restart required anyway */
  LANG_CURRICULA: 3600,          // 1 hour
  /** Level structure changes infrequently */
  LEVELS: 900,                    // 15 minutes
  /** Lesson content can be updated by admins — invalidate on admin write */
  LESSON_CONTENT: 300,            // 5 minutes
  /** Vocabulary is stable */
  VOCABULARY: 900,                // 15 minutes
  /** Subscription plan definitions are very stable */
  SUBSCRIPTION_PLANS: 3600,       // 1 hour
} as const;

// ─── Cache key registry ───────────────────────────────────────────────────────

export const CK = {
  langList:           () => "v1:lang:list",
  curriculaList:      () => "v1:curricula:list",
  subPlans:           () => "v1:sub:plans",
  levelsByCurriculum: (cid: number) => `v1:levels:c:${cid}`,
  // v2: the bundle gained `lesson.track`, which the paywall matches against the
  // student's plan. A v1 entry written before that deploy has no track, so the
  // check would compare against undefined and 403 a paying student until the
  // entry expired. Bumping the version retires those entries on deploy.
  lessonContent:      (lid: number) => `v2:lesson:${lid}:content`,
  vocabByLesson:      (lid: number) => `v1:vocab:lesson:${lid}`,
  vocabByLevel:       (lid: number) => `v1:vocab:level:${lid}`,
} as const;

// ─── In-process fallback cache ────────────────────────────────────────────────

interface Entry<T> { value: T; expiresAt: number }
const _local = new Map<string, Entry<unknown>>();

function localGet<T>(key: string): T | null {
  const e = _local.get(key) as Entry<T> | undefined;
  if (!e) return null;
  if (Date.now() > e.expiresAt) { _local.delete(key); return null; }
  return e.value;
}
function localSet<T>(key: string, value: T, ttlSec: number): void {
  _local.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
}
function localDel(key: string): void { _local.delete(key); }
function localDelByPrefix(prefix: string): void {
  for (const k of _local.keys()) if (k.startsWith(prefix)) _local.delete(k);
}

// ─── Core cache operations ────────────────────────────────────────────────────

/** Get a cached value. Returns null on miss or error. */
async function get<T>(key: string): Promise<T | null> {
  // Try Redis first
  if (isRedisAvailable()) {
    const raw = await withRedis(
      (r) => r.get(key),
      null,
    );
    if (raw !== null) {
      try { return JSON.parse(raw) as T; }
      catch { return null; }
    }
  }
  // Fall back to in-process
  return localGet<T>(key);
}

/** Store a value in both Redis (if available) and the local fallback. */
async function set<T>(key: string, value: T, ttlSec: number): Promise<void> {
  const serialized = JSON.stringify(value);
  // Write to Redis (best-effort, non-blocking)
  if (isRedisAvailable()) {
    await withRedis(
      (r) => r.setex(key, ttlSec, serialized).then(() => undefined as unknown as null),
      null,
    );
  }
  // Always update local fallback so subsequent requests in this process benefit
  localSet(key, value, ttlSec);
}

/** Delete a specific key from Redis and local cache. */
async function del(key: string): Promise<void> {
  if (isRedisAvailable()) {
    await withRedis((r) => r.del(key).then(() => null), null);
  }
  localDel(key);
}

/** Delete all keys matching a prefix pattern from Redis and local cache. */
async function delByPrefix(prefix: string): Promise<void> {
  if (isRedisAvailable()) {
    await withRedis(async (r) => {
      // SCAN is safe for production — non-blocking, paginated
      let cursor = "0";
      do {
        const [nextCursor, keys] = await r.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 100);
        cursor = nextCursor;
        if (keys.length > 0) await r.del(...keys);
      } while (cursor !== "0");
      return null;
    }, null);
  }
  localDelByPrefix(prefix);
}

// ─── Public helper: cache-aside ───────────────────────────────────────────────

/**
 * Cache-aside helper. Returns the cached value if present, otherwise
 * calls `loader`, caches the result, and returns it.
 *
 * Usage:
 *   const data = await cached(CK.langList(), TTL.LANG_CURRICULA, () => db.select()...);
 */
export async function cached<T>(
  key: string,
  ttlSec: number,
  loader: () => Promise<T>,
): Promise<T> {
  const hit = await get<T>(key);
  if (hit !== null) {
    logger.debug({ key }, "Cache hit");
    return hit;
  }

  const value = await loader();
  // Store in background — don't await so the response isn't delayed by a slow Redis write
  set(key, value, ttlSec).catch((err) =>
    logger.warn({ err, key }, "Failed to write to cache"),
  );
  return value;
}

/** Invalidate a single cache key. */
export async function invalidate(key: string): Promise<void> {
  await del(key);
  logger.debug({ key }, "Cache invalidated");
}

/** Invalidate all keys matching a prefix. */
export async function invalidatePrefix(prefix: string): Promise<void> {
  await delByPrefix(prefix);
  logger.debug({ prefix }, "Cache prefix invalidated");
}
