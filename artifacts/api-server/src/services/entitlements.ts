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

import { and, eq, gt, gte, isNull, or, sql } from "drizzle-orm";
import {
  currentPeriodStart as periodStartFor,
  isUnmeteredRole as roleIsUnmetered,
  unmeteredEntitlement,
  type Entitlement,
} from "./entitlement-policy";

// Re-exported so callers have one import for the whole concern; the rules
// themselves live in entitlement-policy.ts, which has no database import.
export {
  checkLessonAccess,
  checkCallAccess,
  isLessonInTrack,
  isUnmeteredRole,
  previousLessonInTrack,
  currentPeriodStart,
  DENIAL_MESSAGES,
  CALL_DENIAL_MESSAGES,
  type Entitlement,
  type LessonDenial,
  type CallDenial,
} from "./entitlement-policy";
import {
  db,
  lessonProgressTable,
  lessonsTable,
  practiceSessionsTable,
  studentSubscriptionsTable,
  subscriptionPlansTable,
  usersTable,
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
const FREE_PLAN_FALLBACK = { lessonTrack: "general", lessonsPerMonth: 1, callsPerMonth: 0 } as const;

/**
 * The condition for "this subscription is in force right now".
 *
 * Active AND not past its expiry. Status alone is not enough: it flips to
 * `expired` only when the hourly sweep runs, so a lapsed subscription still
 * reads `active` for up to an hour. Every place that asks "what plan does this
 * student have" uses this one condition, so the lesson gate, the AI allowance,
 * and every screen showing the plan agree with each other.
 */
export function subscriptionInForce(userId: number) {
  return and(
    eq(studentSubscriptionsTable.userId, userId),
    eq(studentSubscriptionsTable.status, "active"),
    // A null expiry is an open-ended subscription, not an expired one.
    or(
      isNull(studentSubscriptionsTable.expiresAt),
      gt(studentSubscriptionsTable.expiresAt, new Date()),
    ),
  );
}

/**
 * The `lessons` condition for "lessons this plan covers".
 *
 * Every student-facing query that lists or counts lessons applies it, so a
 * general student never sees a professional lesson and vice versa: not in the
 * lesson list, the level map, the dashboard, or the count that decides whether
 * a level is finished. Undefined for staff, who see both tracks; drizzle's
 * `and()` drops an undefined condition.
 */
export function lessonTrackFilter(entitlement: Entitlement) {
  return entitlement.unlimited ? undefined : eq(lessonsTable.track, entitlement.track);
}

/**
 * Resolve the plan backing a user's access.
 *
 * An active row whose `expiresAt` has passed does not count. The expiry sweeper
 * sets `status = 'expired'` eventually, but access must revoke the moment the
 * timestamp passes rather than whenever the job next runs — so the filter is on
 * the timestamp, not on the status alone.
 */
export async function getEntitlement(
  userId: number,
  /**
   * The caller's role, when known.
   *
   * Passed in so that a student, nearly every caller, costs no extra query. It
   * comes from the login session and can be out of date, so a claim to be staff
   * is confirmed against the database below. Omitting it falls back to plan
   * resolution, which is the safe direction — a student is never granted more
   * by accident.
   */
  role?: string,
): Promise<Entitlement> {
  // Staff are not metered. routes/lessons.ts admits them to the student flow
  // deliberately so they can review their own content, and a quota that stops
  // an admin opening a lesson makes that content unreviewable.
  if (roleIsUnmetered(role)) {
    const [user] = await db
      .select({ role: usersTable.role })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    if (user && roleIsUnmetered(user.role)) return unmeteredEntitlement(user.role);
  }

  const [active] = await db
    .select({
      planCode: studentSubscriptionsTable.planCode,
      startedAt: studentSubscriptionsTable.startedAt,
      periodStartedAt: studentSubscriptionsTable.periodStartedAt,
      lessonTrack: subscriptionPlansTable.lessonTrack,
      lessonsPerMonth: subscriptionPlansTable.lessonsPerMonth,
      callsPerMonth: subscriptionPlansTable.callsPerMonth,
      quotaPeriod: subscriptionPlansTable.quotaPeriod,
    })
    .from(studentSubscriptionsTable)
    .innerJoin(
      subscriptionPlansTable,
      eq(subscriptionPlansTable.code, studentSubscriptionsTable.planCode),
    )
    .where(subscriptionInForce(userId))
    .limit(1);

  if (active) {
    // The anchor is period_started_at where it exists, falling back to
    // started_at for rows that predate the column.
    const anchor = active.periodStartedAt ?? active.startedAt;
    return {
      planCode: active.planCode,
      track: active.lessonTrack,
      lessonQuota: active.lessonsPerMonth,
      callQuota: active.callsPerMonth,
      isPaid: active.planCode !== FREE_PLAN_CODE,
      // A lifetime allowance has no period: null makes the counters read the
      // account's whole history, which is exactly "one lesson, ever".
      periodStartedAt:
        active.quotaPeriod === "lifetime" ? null : periodStartFor(anchor),
      unlimited: false,
    };
  }

  const [freePlan] = await db
    .select({
      lessonTrack: subscriptionPlansTable.lessonTrack,
      lessonsPerMonth: subscriptionPlansTable.lessonsPerMonth,
      callsPerMonth: subscriptionPlansTable.callsPerMonth,
      quotaPeriod: subscriptionPlansTable.quotaPeriod,
    })
    .from(subscriptionPlansTable)
    .where(eq(subscriptionPlansTable.code, FREE_PLAN_CODE))
    .limit(1);

  return {
    planCode: FREE_PLAN_CODE,
    track: freePlan?.lessonTrack ?? FREE_PLAN_FALLBACK.lessonTrack,
    lessonQuota: freePlan
      ? freePlan.lessonsPerMonth
      : FREE_PLAN_FALLBACK.lessonsPerMonth,
    callQuota: freePlan ? freePlan.callsPerMonth : FREE_PLAN_FALLBACK.callsPerMonth,
    isPaid: false,
    /**
     * Null — count over the account's whole history.
     *
     * The free trial is one lesson EVER, not one a month: a monthly reset
     * would hand every student a free lesson every month and the paywall
     * would never really bite. A plan row saying otherwise is honoured, so an
     * admin can still widen the trial without a deploy.
     */
    periodStartedAt:
      freePlan && freePlan.quotaPeriod !== "lifetime"
        ? periodStartFor(new Date())
        : null,
    unlimited: false,
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
   * Only lessons started at or after this instant are counted, so an allowance
   * is per period rather than for all time. Null counts everything, which is
   * what a plan with no period wants.
   */
  since: Date | null = null,
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
        since ? gte(lessonProgressTable.startedAt, since) : undefined,
      ),
    );

  return row?.count ?? 0;
}

/**
 * How many peer calls this user has started in the period.
 *
 * Counted from practice_sessions rather than from evaluations: a call that
 * connected and was abandoned still consumed the allowance, and it may never
 * produce an evaluation at all.
 */
export async function countCallsStarted(
  userId: number,
  since: Date | null = null,
  executor: Pick<typeof db, "select"> = db,
): Promise<number> {
  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(practiceSessionsTable)
    .where(
      and(
        or(
          eq(practiceSessionsTable.requesterId, userId),
          eq(practiceSessionsTable.partnerId, userId),
        ),
        // startedAt is null until the two browsers actually connect, so a
        // pairing that never became a call does not consume the allowance.
        sql`${practiceSessionsTable.startedAt} is not null`,
        since ? gte(practiceSessionsTable.startedAt, since) : undefined,
      ),
    );

  return row?.count ?? 0;
}

