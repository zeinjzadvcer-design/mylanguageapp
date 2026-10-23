/**
 * Entitlement policy — the rules, with no database behind them.
 *
 * Split from entitlements.ts so the rules can be tested without a live
 * DATABASE_URL: entitlements.ts imports @workspace/db, which opens a pool at
 * import time, and that would make every test of these rules need a database to
 * decide questions that are pure arithmetic over a plan.
 *
 * Types and messages live here too, so a caller that only needs the shapes does
 * not pull in the pool either.
 */

/** What a student's plan allows. Resolved from the database in entitlements.ts. */
export interface Entitlement {
  /** Plan code backing this entitlement — `"free"` when nothing is active. */
  planCode: string;
  /** Value to match against a lesson's `track`. */
  track: string;
  /** Distinct lessons startable, or `null` for unlimited. */
  quota: number | null;
  /** Whether a paid plan is active. */
  isPaid: boolean;
}

/** Why a lesson is not startable. `null` means it is. */
export type LessonDenial = "wrong_track" | "quota_exhausted";

/**
 * Whether a lesson's `track` belongs to this entitlement's track.
 *
 * Equality, deliberately. The tracks are alternatives, so there is no ordering
 * to compare and no "higher plan includes lower" rule to apply — a
 * professional subscriber genuinely does not get general lessons.
 *
 * Note this is the lesson's `track`, not its `lessonType`: `lessonType` is the
 * pedagogical format (reading, pronunciation…) and says nothing about which
 * plan sells the lesson.
 */
export function isLessonInTrack(entitlement: Entitlement, lessonTrack: string): boolean {
  return lessonTrack === entitlement.track;
}

/**
 * Decide whether a user may start a specific lesson.
 *
 * `alreadyStarted` is the caller's answer to "does this user already have a
 * lesson_progress row for this lesson". It matters: resuming a lesson already
 * started must stay allowed even once the quota is spent, or a free student who
 * closes the tab mid-lesson can never reopen the one lesson they were given.
 *
 * NOT TRANSACTIONAL ON ITS OWN. Two concurrent start requests can both read
 * `lessonsStarted = 0` and both be allowed. Callers must re-check inside the
 * transaction that writes the progress row — see routes/lessons.ts.
 */
export function checkLessonAccess(args: {
  entitlement: Entitlement;
  lessonTrack: string;
  lessonsStarted: number;
  alreadyStarted: boolean;
}): LessonDenial | null {
  const { entitlement, lessonTrack, lessonsStarted, alreadyStarted } = args;

  if (!isLessonInTrack(entitlement, lessonTrack)) return "wrong_track";

  if (entitlement.quota === null) return null;
  if (alreadyStarted) return null;
  if (lessonsStarted >= entitlement.quota) return "quota_exhausted";

  return null;
}

/** Arabic-first messages, matching how the rest of the student API answers. */
export const DENIAL_MESSAGES: Record<LessonDenial, { error: string; errorAr: string }> = {
  wrong_track: {
    error: "This lesson is not part of your plan",
    errorAr: "هذا الدرس غير متضمن في خطتك",
  },
  quota_exhausted: {
    error: "Your free lesson has been used. Subscribe to continue.",
    errorAr: "لقد استخدمت درسك المجاني. اشترك للمتابعة.",
  },
};

/**
 * Add one billing cycle to a start date.
 *
 * Month arithmetic deliberately, not 30 days: a student who subscribes on the
 * 15th expects to be billed on the 15th. `setMonth` clamps 31 January + 1
 * month to 28/29 February rather than overflowing into March.
 */
export function addBillingCycle(from: Date, cycle: string): Date {
  const to = new Date(from.getTime());
  if (cycle === "yearly") {
    to.setFullYear(to.getFullYear() + 1);
  } else {
    to.setMonth(to.getMonth() + 1);
  }
  return to;
}
