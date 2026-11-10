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

import { hasPermission, roleDefinition } from "./access-policy";

/** What a student's plan allows. Resolved from the database in entitlements.ts. */
export interface Entitlement {
  /** Plan code backing this entitlement — `"free"` when nothing is active. */
  planCode: string;
  /** Value to match against a lesson's `track`. */
  track: string;
  /** Lessons startable this period, or `null` for unlimited. */
  lessonQuota: number | null;
  /** Peer calls startable this period, or `null` for unlimited. */
  callQuota: number | null;
  /** Whether a paid plan is active. */
  isPaid: boolean;
  /**
   * Start of the current quota period, or `null` when nothing is counted
   * against a period (an admin, or a subscription with no quota at all).
   */
  periodStartedAt: Date | null;
  /**
   * Bypasses every check: track, lesson quota and call quota alike.
   *
   * Staff need to walk the real student flow to review their own content —
   * routes/lessons.ts admits them deliberately for that reason — and a
   * paywall that stops an admin opening a lesson makes the content
   * unreviewable. This is not a plan; it is the absence of metering.
   */
  unlimited: boolean;
}

/** Whether a role skips metering. Set per role in access-policy.ts. */
export function isUnmeteredRole(role: string | undefined): boolean {
  return roleDefinition(role)?.unmetered ?? false;
}

/**
 * The entitlement for a role that is not metered.
 *
 * Track is `null`-like in effect: `unlimited` short-circuits the track test, so
 * the value here is never compared. It is set to `general` only so the shape
 * stays honest if something reads it for display.
 */
export function unmeteredEntitlement(role: string): Entitlement {
  return {
    planCode: role,
    track: "general",
    lessonQuota: null,
    callQuota: null,
    isPaid: true,
    periodStartedAt: null,
    unlimited: true,
  };
}

/**
 * Add calendar months, holding the day where the target month has it and
 * clamping to that month's last day where it does not.
 *
 * `setMonth` alone overflows: 31 January + 1 month is 3 March, which gives
 * extra paid days and moves the billing date.
 */
function addCalendarMonths(from: Date, months: number): Date {
  const to = new Date(from.getTime());
  const day = to.getUTCDate();
  // Day 1 first, so setting the month cannot itself overflow.
  to.setUTCDate(1);
  to.setUTCMonth(to.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() + 1, 0)).getUTCDate();
  to.setUTCDate(Math.min(day, lastDay));
  return to;
}

/**
 * Roll a period start forward until it covers `now`.
 *
 * A month at a time rather than jumping straight to the latest boundary: a
 * subscription dormant for three months must not grant one allowance for the
 * whole gap, and must not grant three either — it resumes on the current
 * period, having forfeited the unused ones.
 *
 * Each boundary is counted from the anchor, not from the previous boundary, so
 * a subscription started on the 31st returns to the 31st after a short month
 * rather than staying on the 28th for good.
 */
export function currentPeriodStart(anchor: Date, now: Date = new Date()): Date {
  let start = new Date(anchor.getTime());
  // Bounded: a corrupt far-past anchor must not spin here.
  for (let months = 1; months <= 600; months++) {
    const next = addCalendarMonths(anchor, months);
    if (next > now) break;
    start = next;
  }
  return start;
}

/** Why a lesson is not startable. `null` means it is. */
export type LessonDenial = "wrong_track" | "quota_exhausted";

/** Why a peer call is not startable. `null` means it is. */
export type CallDenial = "call_quota_exhausted";

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
  // Staff see both tracks: a reviewer cannot check professional content from a
  // general account, and they hold no subscription to switch.
  if (entitlement.unlimited) return true;
  return lessonTrack === entitlement.track;
}

/**
 * The lesson that must be finished before `ordered[idx]` unlocks.
 *
 * The previous lesson IN THE SAME TRACK, not simply the previous one in the
 * level. Both tracks share a level's ordering, so the plain predecessor of a
 * general lesson can be a professional one the student can never open, and
 * would lock the rest of their level behind it.
 */
export function previousLessonInTrack(
  ordered: ReadonlyArray<{ id: number; track: string }>,
  idx: number,
): number | null {
  const track = ordered[idx]?.track;
  for (let i = idx - 1; i >= 0; i--) {
    if (ordered[i].track === track) return ordered[i].id;
  }
  return null;
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

  if (entitlement.unlimited) return null;

  if (!isLessonInTrack(entitlement, lessonTrack)) return "wrong_track";

  if (entitlement.lessonQuota === null) return null;
  // A lesson already open can always be finished. The quota counts distinct
  // lessons STARTED, so this is what stops a student losing work when their
  // allowance runs out mid-lesson.
  if (alreadyStarted) return null;
  if (lessonsStarted >= entitlement.lessonQuota) return "quota_exhausted";

  return null;
}

/**
 * Decide whether a user may start a peer call.
 *
 * Simpler than the lesson check: a call has no track and nothing to resume, so
 * only the monthly allowance applies. The separate daily cap
 * (PRACTICE_DAILY_CALL_LIMIT) is abuse control and is enforced where it always
 * was — both apply, and whichever is stricter bites.
 */
export function checkCallAccess(args: {
  entitlement: Entitlement;
  callsStarted: number;
}): CallDenial | null {
  const { entitlement, callsStarted } = args;

  if (entitlement.unlimited) return null;
  if (entitlement.callQuota === null) return null;
  if (callsStarted >= entitlement.callQuota) return "call_quota_exhausted";

  return null;
}

/** Arabic-first messages, matching how the rest of the student API answers. */
export const DENIAL_MESSAGES: Record<LessonDenial, { error: string; errorAr: string }> = {
  wrong_track: {
    error: "This lesson is not part of your plan",
    errorAr: "هذا الدرس غير متضمن في خطتك",
  },
  quota_exhausted: {
    // Worded for a monthly allowance now, not a one-off trial: the free plan
    // is 1 lesson per month and a paid plan is 12 or 24, so "your free lesson"
    // would be wrong for every paying student who hits the limit.
    error: "You have used this month's lessons.",
    errorAr: "لقد استخدمت دروس هذا الشهر. يمكنك الترقية أو الانتظار حتى بداية الفترة القادمة.",
  },
};

/** Arabic-first messages for a refused call. */
export const CALL_DENIAL_MESSAGES: Record<CallDenial, { error: string; errorAr: string }> = {
  call_quota_exhausted: {
    error: "You have used this month's calls.",
    errorAr: "لقد استخدمت مكالمات هذا الشهر. يمكنك الترقية أو الانتظار حتى بداية الفترة القادمة.",
  },
};

/**
 * Add one billing cycle to a start date.
 *
 * Month arithmetic deliberately, not 30 days: a student who subscribes on the
 * 15th expects to be billed on the 15th. 31 January + 1 month is 28/29
 * February, not early March.
 */
export function addBillingCycle(from: Date, cycle: string): Date {
  return addCalendarMonths(from, cycle === "yearly" ? 12 : 1);
}

/**
 * Who may read a stored media asset.
 *
 * Lives here, away from the database, so the rule can be tested directly — it
 * decides whether one student can read another's payment receipt, which is not
 * a thing to find out from a failing integration test.
 *
 * Curriculum material and the ShamCash QR have no owner and are readable by
 * anyone signed in: both are meant to be seen by every student. An owned asset
 * is readable by its owner, and otherwise only by staff who need it.
 */
export function canReadMediaAsset(
  asset: { ownerUserId: number | null; purpose?: string | null },
  viewer: { userId: number; role: string | undefined },
): boolean {
  // Unowned is public only for what is meant for everyone. Any other unowned
  // row points somewhere private by mistake, and must not be served.
  if (asset.ownerUserId === null) {
    const purpose = asset.purpose ?? "curriculum";
    return purpose === "curriculum" || purpose === "payment_qr";
  }
  if (asset.ownerUserId === viewer.userId) return true;

  // A payment receipt is a financial record, not coursework: readable by those
  // who act on payments, and by nobody who is here to check exercises.
  if (asset.purpose === "payment_receipt") return hasPermission(viewer.role, "payments.review");

  // Someone else's recording is coursework, heard only in order to mark it.
  return hasPermission(viewer.role, "grading.manage");
}

/** Lesson states the curriculum can report. */
export type LessonState = "LOCKED" | "AVAILABLE" | "IN_PROGRESS" | "COMPLETED";

export function deriveLessonStateWithOrders(
  lesson: { id: number; order: number },
  levelOrder: number,
  currentLevelOrder: number | null,
  completedIds: Set<number>,
  prevLessonId: number | null,
  progressStatus?: string | null,
  /**
   * Staff see every lesson, in every level, regardless of progression.
   *
   * This is CURRICULUM progression, separate from the plan paywall — it locks
   * by level order and by whether the previous lesson was completed. Staff
   * hold no student profile, so `currentLevelOrder` is null for them and the
   * check below locked everything: an admin saw a wall of مقفل and could not
   * open the content they are here to review. The lesson routes admit staff on
   * purpose (see routes/lessons.ts), which is pointless if progression then
   * refuses them.
   */
  unmetered = false,
): LessonState {
  if (completedIds.has(lesson.id)) return "COMPLETED";

  if (unmetered) {
    // Still report work in progress, so a reviewer walking a lesson sees the
    // same state a student would.
    return progressStatus === "in_progress" ? "IN_PROGRESS" : "AVAILABLE";
  }

  if (currentLevelOrder === null) return "LOCKED";

  // Levels below current are review-accessible
  if (levelOrder < currentLevelOrder) {
    // Sequential within past levels still applies
    if (prevLessonId === null) return "AVAILABLE";
    if (completedIds.has(prevLessonId)) return "AVAILABLE";
    return "AVAILABLE"; // all past-level lessons are review-accessible
  }

  // Future levels are locked
  if (levelOrder > currentLevelOrder) return "LOCKED";

  // Current level: sequential unlock
  if (prevLessonId === null) return "AVAILABLE";
  if (completedIds.has(prevLessonId)) {
    if (progressStatus === "in_progress") return "IN_PROGRESS";
    return "AVAILABLE";
  }
  return "LOCKED";
}
