/**
 * The rules behind lesson capacity, kept free of the database and Valkey so
 * each can be tested directly. lesson-load.ts applies them.
 */

export type LessonRefusal = "full" | "overloaded";

export interface LoadSignals {
  /** 99th percentile of event-loop delay over the last few seconds, in ms. */
  loopLagMs: number;
  /** Requests waiting for a database connection right now. */
  dbWaiting: number;
}

export interface LoadLimits {
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
 * Take a seat in lessons, or be refused one, in a single step.
 *
 * `seats` maps each student in a lesson to when they were last seen. Seats not
 * used since `since` are freed first. A student who already has a seat keeps
 * it (and it is refreshed); anyone else gets one only while fewer than `max`
 * are taken. `max` null means no limit.
 *
 * Deciding and taking together is the point: checked and taken separately, a
 * class opening lessons in the same second would all see the last free seat
 * and all take it. The Valkey version (lesson-seats.ts) does the same steps in
 * one script for the same reason.
 */
export function takeLocalSeat(
  seats: Map<number, number>,
  userId: number,
  now: number,
  since: number,
  max: number | null,
): boolean {
  for (const [id, at] of seats) if (at < since) seats.delete(id);
  if (max !== null && !seats.has(userId) && seats.size >= max) return false;
  seats.set(userId, now);
  return true;
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
