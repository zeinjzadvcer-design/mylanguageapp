import { describe, expect, it } from "vitest";
import {
  evaluationDedupeKey,
  hasLessonToStudy,
  isValidTimeZone,
  paymentDedupeKey,
  quizDedupeKey,
  reminderDedupeKey,
  reminderWindow,
} from "./notification-policy";

// Damascus is UTC+3 all year.
const at = (iso: string) => new Date(iso);

describe("reminderWindow", () => {
  it("is not due before six in the evening, Damascus time", () => {
    expect(reminderWindow(at("2026-11-13T14:59:00Z"), "Asia/Damascus", 18).due).toBe(false);
  });

  it("is due from six in the evening, Damascus time", () => {
    expect(reminderWindow(at("2026-11-13T15:00:00Z"), "Asia/Damascus", 18).due).toBe(true);
  });

  it("stops before it would wake anyone", () => {
    expect(reminderWindow(at("2026-11-13T19:59:00Z"), "Asia/Damascus", 18).due).toBe(true);
    expect(reminderWindow(at("2026-11-13T20:00:00Z"), "Asia/Damascus", 18).due).toBe(false);
    expect(reminderWindow(at("2026-11-14T00:30:00Z"), "Asia/Damascus", 18).due).toBe(false);
  });

  it("uses the Damascus date, which can differ from the server's", () => {
    // 22:30 UTC on the 13th is 01:30 on the 14th in Damascus.
    expect(reminderWindow(at("2026-11-13T22:30:00Z"), "Asia/Damascus", 18).dateKey).toBe("2026-11-14");
    expect(reminderWindow(at("2026-11-13T15:00:00Z"), "Asia/Damascus", 18).dateKey).toBe("2026-11-13");
  });

  it("starts the day at Damascus midnight", () => {
    const { dayStart } = reminderWindow(at("2026-11-13T15:00:00Z"), "Asia/Damascus", 18);
    expect(dayStart.toISOString()).toBe("2026-11-12T21:00:00.000Z");
  });

  it("works for a zone with daylight saving", () => {
    // New York in summer is UTC-4.
    const { dayStart, dateKey } = reminderWindow(at("2026-07-01T23:00:00Z"), "America/New_York", 18);
    expect(dateKey).toBe("2026-07-01");
    expect(dayStart.toISOString()).toBe("2026-07-01T04:00:00.000Z");
  });
});

describe("hasLessonToStudy", () => {
  const base = {
    unlimited: false,
    hasUnpassedStartedLesson: false,
    freeOnly: false,
    freeLessonPassed: false,
    lessonQuota: 12 as number | null,
    lessonsStarted: 0,
  };

  it("is true while the plan's allowance has room", () => {
    expect(hasLessonToStudy({ ...base, lessonsStarted: 11 })).toBe(true);
  });

  it("is false once the allowance is used", () => {
    expect(hasLessonToStudy({ ...base, lessonsStarted: 12 })).toBe(false);
  });

  it("is true with the allowance used but a lesson still to finish", () => {
    expect(hasLessonToStudy({ ...base, lessonsStarted: 12, hasUnpassedStartedLesson: true })).toBe(true);
  });

  it("follows the free lesson for a student limited to it", () => {
    expect(hasLessonToStudy({ ...base, freeOnly: true })).toBe(true);
    expect(hasLessonToStudy({ ...base, freeOnly: true, freeLessonPassed: true })).toBe(false);
  });

  it("is true with no limit, or for staff", () => {
    expect(hasLessonToStudy({ ...base, lessonQuota: null, lessonsStarted: 99 })).toBe(true);
    expect(hasLessonToStudy({ ...base, unlimited: true, lessonsStarted: 99 })).toBe(true);
  });
});

describe("isValidTimeZone", () => {
  it("accepts zone names and refuses anything else", () => {
    expect(isValidTimeZone("Asia/Damascus")).toBe(true);
    expect(isValidTimeZone("Damascus")).toBe(false);
    expect(isValidTimeZone("UTC+3")).toBe(false);
  });
});

describe("dedupe keys", () => {
  it("separates each kind of event", () => {
    const keys = [
      reminderDedupeKey("2026-11-13"),
      quizDedupeKey(4),
      evaluationDedupeKey(4),
      paymentDedupeKey(4, "approved"),
      paymentDedupeKey(4, "rejected"),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});
