/**
 * Entitlements Service
 *
 * Answers one question: what may this student open right now?
 *
 * Two independent things decide it, and they compose:
 *
 *   track  — WHICH lessons, matched against `lessons.track`. The general
 *            and professional tracks are mutually exclusive: neither is a
 *            superset of the other, so this is an equality test, never a
 *            ranking.
 *   quota  — HOW MANY distinct lessons may be STARTED. `null` is unlimited.
 *            The free plan sets 1: the single trial lesson a student gets
 *            after placement, before everything locks.
 *
 * WHY NOTHING HERE IS CACHED
 * ──────────────────────────
 * `services/cache.ts` names this exact case under WHAT MUST NOT BE CACHED:
 * "active subscription status (access-control decisions)" and "any data where
 * staleness causes security or financial harm". routes/subscriptions.ts
 * already honours it — "Per-user subscription status — authoritative, never
 * cached".
 *
 * A stale entitlement is an expired subscription that still opens lessons, or
 * a student who paid and still cannot. Both are worse than the query, which is
 * two indexed reads. Plan *definitions* stay cached where they already are.
 */

import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Entitlement } from "./entitlement-policy";

// Re-exported so callers have one import for the whole concern; the rules
// themselves live in entitlement-policy.ts, which has no database import.
export {
  checkLessonAccess,
  isLessonInTrack,
  DENIAL_MESSAGES,
  type Entitlement,
  type LessonDenial,
} from "./entitlement-policy";
import {
  db,
  lessonProgressTable,
  studentSubscriptionsTable,
  subscriptionPlansTable,
} from "@workspace/db";

/** The free plan's code in `subscription_plans`. */
const FREE_PLAN_CODE = "free";

/**
 * Fallback used only when the `free` plan row is missing from the database.
 *
 * The free tier is deliberately read from the table rather than hardcoded, so
 * an admin can widen the trial without a deploy. But a seeding slip must not
 * hand out unlimited access, so this fails closed on the narrower of the two.
 */
const FREE_PLAN_FALLBACK = { lessonTrack: "general", freeLessonQuota: 1 } as const;

/**
 * Resolve the plan backing a user's access.
 *
 * An active row whose `expiresAt` has passed does not count. The expiry sweeper
 * sets `status = 'expired'` eventually, but access must revoke the moment the
 * timestamp passes rather than whenever the job next runs — so the filter is on
 * the timestamp, not on the status alone.
 */
export async function getEntitlement(userId: number): Promise<Entitlement> {
  const [active] = await db
    .select({
      planCode: studentSubscriptionsTable.planCode,
      lessonTrack: subscriptionPlansTable.lessonTrack,
      freeLessonQuota: subscriptionPlansTable.freeLessonQuota,
    })
    .from(studentSubscriptionsTable)
    .innerJoin(
      subscriptionPlansTable,
      eq(subscriptionPlansTable.code, studentSubscriptionsTable.planCode),
    )
    .where(
      and(
        eq(studentSubscriptionsTable.userId, userId),
        eq(studentSubscriptionsTable.status, "active"),
        // A null expiry is an open-ended subscription, not an expired one.
        or(
          isNull(studentSubscriptionsTable.expiresAt),
          gt(studentSubscriptionsTable.expiresAt, new Date()),
        ),
      ),
    )
    .limit(1);

  if (active) {
    return {
      planCode: active.planCode,
      track: active.lessonTrack,
      quota: active.freeLessonQuota,
      isPaid: active.planCode !== FREE_PLAN_CODE,
    };
  }

  const [freePlan] = await db
    .select({
      lessonTrack: subscriptionPlansTable.lessonTrack,
      freeLessonQuota: subscriptionPlansTable.freeLessonQuota,
    })
    .from(subscriptionPlansTable)
    .where(eq(subscriptionPlansTable.code, FREE_PLAN_CODE))
    .limit(1);

  return {
    planCode: FREE_PLAN_CODE,
    track: freePlan?.lessonTrack ?? FREE_PLAN_FALLBACK.lessonTrack,
    // `?? ` not `||`: a deliberate 0 must stay 0, and an unlimited free plan
    // (quota null) must stay unlimited rather than collapsing to the fallback.
    quota: freePlan ? freePlan.freeLessonQuota : FREE_PLAN_FALLBACK.freeLessonQuota,
    isPaid: false,
  };
}

/**
 * How many distinct lessons this user has started.
 *
 * Distinct lessons, not attempts: `lesson_progress` is unique on
 * (user_id, lesson_id), so one row per lesson however many times it is
 * resumed. A student who abandons their free lesson and comes back to it has
 * still used one.
 *
 * `startedAt IS NOT NULL` rather than a status test: a row can exist at
 * `not_started` (created by progress bookkeeping elsewhere) without the student
 * having opened anything, and that must not burn the quota.
 */
export async function countLessonsStarted(
  userId: number,
  /**
   * Run inside a caller's transaction. The quota check must read the count
   * under the same lock that guards the write, so passing the transaction is
   * not an optimisation — on `db` it would read outside that lock and could
   * miss a concurrent start.
   */
  executor: Pick<typeof db, "select"> = db,
): Promise<number> {
  const [row] = await executor
    .select({ count: sql<number>`count(distinct ${lessonProgressTable.lessonId})::int` })
    .from(lessonProgressTable)
    .where(
      and(
        eq(lessonProgressTable.userId, userId),
        sql`${lessonProgressTable.startedAt} is not null`,
      ),
    );

  return row?.count ?? 0;
}

