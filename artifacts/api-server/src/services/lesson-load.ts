/**
 * Lesson capacity: how many students are in lessons, how hard the server is
 * working, and whether one more may open a lesson.
 *
 * WHY
 * ───
 * A lesson is mostly cheap reads and small writes, so more students make the
 * site slower long before anything fails — and slow is how it fails: requests
 * queue for the one CPU and for database connections until they time out. This
 * turns away a student OPENING a lesson while that is happening, with a message
 * to come back in a few minutes, instead of making every student wait.
 *
 * Two triggers, either enough:
 *   - The administrator's limit on students in lessons at once (lesson_settings).
 *   - The server looking overloaded: its event loop falling behind, or requests
 *     queueing for database connections (lesson-load-policy.ts, isOverloaded).
 *
 * A student already in a lesson, and staff, are never turned away.
 *
 * "In a lesson" means the student opened a lesson, started one or answered in
 * one within ACTIVE_WINDOW_MS. Kept in Valkey so every API instance counts the
 * same students; in this process when Valkey is not configured.
 */

import { monitorEventLoopDelay } from "node:perf_hooks";
import { and, eq, isNotNull } from "drizzle-orm";
import { db, pool, lessonProgressTable, lessonSettingsTable } from "@workspace/db";
import { redis, isRedisAvailable } from "./redis";
import { envInt } from "../lib/env";
import { logger } from "../lib/logger";
import { isUnmeteredRole } from "./entitlement-policy";
import {
  isOverloaded,
  takeLocalSeat,
  type LessonRefusal,
  type LoadLimits,
  type LoadSignals,
} from "./lesson-load-policy";
import { takeSeatInRedis } from "./lesson-seats";

/** How long after their last lesson request a student still counts as in a lesson. */
const ACTIVE_WINDOW_MS = envInt("LESSON_ACTIVE_WINDOW_MS", 10 * 60_000);

/**
 * Event-loop delay (99th percentile, ms) past which the server is overloaded.
 * An idle server reads about 20–40 ms here: the sampling interval itself.
 */
const LAG_LIMIT_MS = envInt("LESSON_OVERLOAD_LAG_MS", 500);

/** Requests waiting for a database connection at which the database is overloaded. */
const DB_WAITING_LIMIT = envInt("LESSON_OVERLOAD_DB_WAITING", pool.options.max ?? 10);

const ACTIVE_KEY = "lessons:active";

// ─── Load signals ─────────────────────────────────────────────────────────────

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
let lastWindowLagMs = 0;
// Each window's 99th percentile, so one slow moment ages out within seconds
// rather than keeping lessons closed.
setInterval(() => {
  lastWindowLagMs = readP99();
  loopDelay.reset();
}, 5_000).unref();

function readP99(): number {
  const p99 = loopDelay.percentile(99) / 1e6;
  return Number.isFinite(p99) ? p99 : 0;
}

export function loadSignals(): LoadSignals {
  return {
    loopLagMs: Math.round(Math.max(lastWindowLagMs, readP99())),
    dbWaiting: pool.waitingCount,
  };
}

// ─── Students in lessons ──────────────────────────────────────────────────────

/** Fallback when Valkey is not configured: one process, one count. */
const localActive = new Map<number, number>();

function client() {
  return redis && isRedisAvailable() ? redis : null;
}

/**
 * Give this student a seat in lessons, unless `max` are taken by others.
 * `max` null means no limit, and then this only records them. Never throws:
 * when Valkey fails the student is let in, since capacity management must not
 * be what closes lessons.
 */
async function takeSeat(userId: number, max: number | null): Promise<boolean> {
  const now = Date.now();
  const since = now - ACTIVE_WINDOW_MS;
  const r = client();
  if (!r) return takeLocalSeat(localActive, userId, now, since, max);
  try {
    return await takeSeatInRedis(r, ACTIVE_KEY, userId, now, since, max);
  } catch (err) {
    logger.debug({ err }, "Could not take a lesson seat");
    return true;
  }
}

/**
 * Record that this student is still in a lesson, so they keep their seat.
 * Staff are not counted: their seats would be taken from students.
 */
export async function noteLessonActivity(userId: number, role: string | undefined): Promise<void> {
  if (isUnmeteredRole(role)) return;
  await takeSeat(userId, null);
}

/** Students in lessons now. */
export async function countActiveLearners(): Promise<number> {
  const since = Date.now() - ACTIVE_WINDOW_MS;
  const r = client();
  if (!r) {
    for (const [id, at] of localActive) if (at < since) localActive.delete(id);
    return localActive.size;
  }
  try {
    const [, count] = (await r
      .multi()
      .zremrangebyscore(ACTIVE_KEY, "-inf", since)
      .zcard(ACTIVE_KEY)
      .exec()) as [unknown, [Error | null, number]];
    return count[1] ?? 0;
  } catch (err) {
    logger.debug({ err }, "Could not count students in lessons");
    return 0;
  }
}

async function isActiveLearner(userId: number): Promise<boolean> {
  const since = Date.now() - ACTIVE_WINDOW_MS;
  const r = client();
  if (!r) return (localActive.get(userId) ?? 0) >= since;
  try {
    const score = await r.zscore(ACTIVE_KEY, String(userId));
    return score !== null && Number(score) >= since;
  } catch {
    return false;
  }
}

// ─── The administrator's limit ────────────────────────────────────────────────

let cachedLimit: { value: number | null; at: number } | null = null;

/** The limit on students in lessons at once, or null for none. Read at most every 15 s. */
export async function getMaxActiveLearners(): Promise<number | null> {
  if (cachedLimit && Date.now() - cachedLimit.at < 15_000) return cachedLimit.value;
  try {
    const [row] = await db
      .select({ max: lessonSettingsTable.maxActiveLearners })
      .from(lessonSettingsTable)
      .limit(1);
    cachedLimit = { value: row?.max ?? null, at: Date.now() };
  } catch (err) {
    // Capacity management: a failure to read the limit must not close lessons.
    logger.error({ err }, "Could not read the lesson capacity limit");
    cachedLimit = { value: null, at: Date.now() };
  }
  return cachedLimit.value;
}

export async function setMaxActiveLearners(maxActiveLearners: number | null): Promise<void> {
  await db
    .insert(lessonSettingsTable)
    .values({ id: 1, maxActiveLearners })
    .onConflictDoUpdate({ target: lessonSettingsTable.id, set: { maxActiveLearners } });
  cachedLimit = { value: maxActiveLearners, at: Date.now() };
}

const LIMITS: LoadLimits = { lagLimitMs: LAG_LIMIT_MS, dbWaitingLimit: DB_WAITING_LIMIT };

// ─── Admission ────────────────────────────────────────────────────────────────

/**
 * Why this student may not open this lesson now, or null when they may — and
 * when they may, they now have a seat.
 *
 * Call it once the student is known to be allowed the lesson at all, so that
 * a locked or paid lesson is not reported as busy and takes no seat.
 *
 * Never turned away: staff, students already in a lesson, and students coming
 * back to a lesson they began. `alreadyStarted` is that last fact when the
 * caller has already read it; otherwise it is looked up, and only when the
 * answer would be no.
 */
export async function lessonAdmission(
  userId: number,
  role: string | undefined,
  lessonId: number,
  alreadyStarted?: boolean,
): Promise<LessonRefusal | null> {
  if (isUnmeteredRole(role)) return null;
  if (alreadyStarted) {
    await takeSeat(userId, null);
    return null;
  }

  const maxActiveLearners = await getMaxActiveLearners();
  const signals = loadSignals();
  let refusal: LessonRefusal | null = null;
  if (isOverloaded(signals, LIMITS)) {
    // Students already in a lesson carry on; nobody new starts one.
    refusal = (await isActiveLearner(userId)) ? null : "overloaded";
    if (!refusal) await takeSeat(userId, null);
  } else if (!(await takeSeat(userId, maxActiveLearners))) {
    refusal = "full";
  }
  if (!refusal) return null;

  if (alreadyStarted === undefined && (await hasStarted(userId, lessonId))) {
    await takeSeat(userId, null);
    return null;
  }
  logger.info({ userId, lessonId, reason: refusal, maxActiveLearners, ...signals }, "Lesson turned away: busy");
  return refusal;
}

/**
 * The early, cheap answer for while the server is overloaded: "overloaded" for
 * a student arriving at a lesson they have not begun, before any of the
 * lesson's own checks run.
 *
 * Those checks are several database queries, and while the server is
 * overloaded the database is usually why. Turning a newcomer away first costs
 * one Valkey lookup and one query instead. The price is that a newcomer
 * opening a lesson that is locked to them hears "busy" rather than "locked",
 * and only while the server is overloaded; when lessons are merely full, the
 * full checks run first and each lesson gets its own answer.
 *
 * Null otherwise, including always for staff and for students in a lesson;
 * lessonAdmission then decides as usual.
 */
export async function overloadRefusal(
  userId: number,
  role: string | undefined,
  lessonId: number,
): Promise<LessonRefusal | null> {
  if (isUnmeteredRole(role)) return null;
  const signals = loadSignals();
  if (!isOverloaded(signals, LIMITS)) return null;
  if ((await isActiveLearner(userId)) || (await hasStarted(userId, lessonId))) return null;
  logger.info({ userId, lessonId, reason: "overloaded", ...signals }, "Lesson turned away: busy");
  return "overloaded";
}

async function hasStarted(userId: number, lessonId: number): Promise<boolean> {
  const [begun] = await db
    .select({ id: lessonProgressTable.id })
    .from(lessonProgressTable)
    .where(
      and(
        eq(lessonProgressTable.userId, userId),
        eq(lessonProgressTable.lessonId, lessonId),
        isNotNull(lessonProgressTable.startedAt),
      ),
    )
    .limit(1);
  return Boolean(begun);
}

/** For the admin screen: the limit, the count, and how the server is doing. */
export async function lessonCapacityStatus() {
  const [maxActiveLearners, activeLearners] = await Promise.all([
    getMaxActiveLearners(),
    countActiveLearners(),
  ]);
  const signals = loadSignals();
  return {
    maxActiveLearners,
    activeLearners,
    overloaded: isOverloaded(signals, LIMITS),
    ...signals,
    lagLimitMs: LAG_LIMIT_MS,
    dbWaitingLimit: DB_WAITING_LIMIT,
  };
}
