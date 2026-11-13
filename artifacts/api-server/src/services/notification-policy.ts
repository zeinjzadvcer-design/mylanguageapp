/**
 * When the daily lesson reminder is due — the rules, with no database behind
 * them, so they can be tested directly.
 *
 * Students are in Syria, so the day and the hour are Damascus's, not the
 * server's (which runs in UTC). Asia/Damascus has had no daylight saving since
 * 2022, but the conversion below reads the offset for the actual instant
 * rather than assuming one, so it stays right if that changes.
 */

const DEFAULT_TIMEZONE = "Asia/Damascus";

/** Whether the runtime knows this IANA time zone name. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const configuredTimeZone = process.env.REMINDER_TIMEZONE?.trim() || "";

/**
 * A REMINDER_TIMEZONE that is not a zone name, or null. Kept so the sweeper can
 * say so loudly at start: Intl throws on a bad name, and inside the sweep that
 * would only ever be a warning while every reminder silently failed.
 */
export const REMINDER_TIMEZONE_REJECTED =
  configuredTimeZone && !isValidTimeZone(configuredTimeZone) ? configuredTimeZone : null;

export const REMINDER_TIMEZONE =
  configuredTimeZone && !REMINDER_TIMEZONE_REJECTED ? configuredTimeZone : DEFAULT_TIMEZONE;

/** The local hour from which the reminder goes out, 0-23. Default 18:00. */
export const REMINDER_HOUR = (() => {
  const hour = Number(process.env.REMINDER_HOUR ?? 18);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 18;
})();

/**
 * The last local hour a reminder may still go out. A server that was down at
 * six should catch up in the evening, not wake a student at three in the
 * morning.
 */
export const REMINDER_LAST_HOUR = 22;

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(now: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

export interface ReminderWindow {
  /** Whether reminders may be sent at this moment. */
  due: boolean;
  /** The local date, YYYY-MM-DD, used to send each student one reminder a day. */
  dateKey: string;
  /** The instant the local day began: activity after it counts as studying today. */
  dayStart: Date;
}

export function reminderWindow(
  now: Date,
  timeZone: string = REMINDER_TIMEZONE,
  hour: number = REMINDER_HOUR,
): ReminderWindow {
  const p = localParts(now, timeZone);
  // How far the zone is ahead of UTC at this instant.
  const offsetMs =
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) -
    Math.floor(now.getTime() / 1000) * 1000;
  const dayStart = new Date(Date.UTC(p.year, p.month - 1, p.day) - offsetMs);
  const pad = (n: number) => String(n).padStart(2, "0");

  return {
    due: p.hour >= hour && p.hour <= Math.max(hour, REMINDER_LAST_HOUR),
    dateKey: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    dayStart,
  };
}

/**
 * Whether a placed student has a lesson they can open now, by the rules the
 * lesson pages apply. A reminder is only worth sending when this is true.
 */
export function hasLessonToStudy(s: {
  unlimited: boolean;
  /** A lesson started and not yet passed can always be continued or retried. */
  hasUnpassedStartedLesson: boolean;
  /** On the free plan with a free lesson chosen: that lesson is all that opens. */
  freeOnly: boolean;
  freeLessonPassed: boolean;
  /** Null means no limit. */
  lessonQuota: number | null;
  /** Lessons started in the current period. */
  lessonsStarted: number;
}): boolean {
  if (s.unlimited || s.hasUnpassedStartedLesson) return true;
  if (s.freeOnly) return !s.freeLessonPassed;
  if (s.lessonQuota === null) return true;
  return s.lessonsStarted < s.lessonQuota;
}

/** The key that lets a student get one reminder per local day. */
export const reminderDedupeKey = (dateKey: string) => `lesson-reminder:${dateKey}`;

/** One "quiz available" per quiz per student, whichever event announced it first. */
export const quizDedupeKey = (quizId: number) => `quiz:${quizId}`;

/** One "level test is open" per evaluation per student. */
export const evaluationDedupeKey = (quizId: number) => `evaluation:${quizId}`;

/** One notice per payment decision, so a retried approval does not repeat it. */
export const paymentDedupeKey = (submissionId: number, outcome: "approved" | "rejected") =>
  `payment:${submissionId}:${outcome}`;

/** How long a notification is kept. Older ones are deleted by the sweep. */
export const NOTIFICATION_RETENTION_DAYS = 90;
