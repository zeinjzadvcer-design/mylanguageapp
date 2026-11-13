/**
 * Whether a student may open a lesson right now, given how busy the site is.
 *
 * No database or Valkey here, so every rule can be tested directly. The
 * numbers come from lesson-load.ts.
 */

export type LessonRefusal = "full" | "overloaded";

export interface LoadSignals {
  /** 99th percentile of event-loop delay over the last few seconds, in ms. */
  loopLagMs: number;
  /** Requests waiting for a database connection right now. */
  dbWaiting: number;
}

export interface LoadLimits {
  /** Students in lessons at once; null for no limit. Set by an administrator. */
  maxActiveLearners: number | null;
  /** Event-loop delay past which the server counts as overloaded; 0 turns it off. */
  lagLimitMs: number;
  /** Requests waiting for a connection at which the database counts as overloaded; 0 turns it off. */
  dbWaitingLimit: number;
}

/** Whether the server itself is struggling, whatever the administrator's limit. */
export function isOverloaded(signals: LoadSignals, limits: LoadLimits): boolean {
  return (
    (limits.lagLimitMs > 0 && signals.loopLagMs > limits.lagLimitMs) ||
    (limits.dbWaitingLimit > 0 && signals.dbWaiting >= limits.dbWaitingLimit)
  );
}

/**
 * Why this student may not open a lesson now, or null when they may.
 *
 * Only ever refuses someone arriving: a student already in a lesson (`alreadyIn`)
 * and staff are always let through, so nobody is cut off mid-lesson and content
 * can always be checked.
 */
export function lessonRefusal(args: {
  staff: boolean;
  alreadyIn: boolean;
  activeLearners: number;
  signals: LoadSignals;
  limits: LoadLimits;
}): LessonRefusal | null {
  if (args.staff || args.alreadyIn) return null;
  const { maxActiveLearners } = args.limits;
  if (maxActiveLearners !== null && args.activeLearners >= maxActiveLearners) return "full";
  if (isOverloaded(args.signals, args.limits)) return "overloaded";
  return null;
}

/** What the student is told, Arabic first like the rest of the student API. */
export const BUSY_MESSAGE = {
  error: "Lessons are very busy right now. Please try again in a few minutes.",
  errorAr: "الدروس مزدحمة حالياً. يرجى المحاولة مرة أخرى بعد بضع دقائق.",
  code: "LESSONS_BUSY",
} as const;

/** How long to tell the browser to wait before trying again, in seconds. */
export const RETRY_AFTER_S = 120;

/**
 * At most `max` at once, without waiting: a slot is taken or refused on the
 * spot. For work that has somewhere else to go when every slot is taken.
 */
export function createSlots(max: number) {
  let inUse = 0;
  return {
    tryTake(): (() => void) | null {
      if (inUse >= max) return null;
      inUse++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inUse--;
      };
    },
    get inUse() {
      return inUse;
    },
  };
}
