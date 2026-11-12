import { describe, it, expect } from "vitest";
import {
  checkLessonAccess,
  lessonOpenDenial,
  limitedToFreeLesson,
  stateForFreeLessonStudent,
  studentLessonState,
  unmeteredEntitlement,
  type Entitlement,
} from "./entitlement-policy";

const free: Entitlement = {
  planCode: "free",
  track: "general",
  lessonQuota: 1,
  callQuota: 0,
  isPaid: false,
  periodStartedAt: null,
  unlimited: false,
};

const paid: Entitlement = {
  planCode: "general_basic",
  track: "general",
  lessonQuota: 12,
  callQuota: 8,
  isPaid: true,
  periodStartedAt: new Date("2026-11-01T00:00:00.000Z"),
  unlimited: false,
};

const FREE = 42;

describe("who is limited to the free lesson", () => {
  it("a free-plan student, once one is chosen", () => {
    expect(limitedToFreeLesson(free, FREE)).toBe(true);
  });

  it("nobody while none is chosen", () => {
    expect(limitedToFreeLesson(free, null)).toBe(false);
  });

  it("never a paying student or staff", () => {
    expect(limitedToFreeLesson(paid, FREE)).toBe(false);
    expect(limitedToFreeLesson(unmeteredEntitlement("admin"), FREE)).toBe(false);
  });
});

describe("starting a lesson on the free plan with a free lesson chosen", () => {
  const start = (lessonId: number, over: Partial<Parameters<typeof checkLessonAccess>[0]> = {}) =>
    checkLessonAccess({
      entitlement: free,
      lessonId,
      lessonTrack: "general",
      lessonsStarted: 0,
      alreadyStarted: false,
      freeLessonId: FREE,
      ...over,
    });

  it("opens the free lesson", () => {
    expect(start(FREE)).toBeNull();
  });

  it("opens it even from the other track", () => {
    expect(start(FREE, { lessonTrack: "professional" })).toBeNull();
  });

  it("opens it even with the monthly allowance spent: it uses none", () => {
    expect(start(FREE, { lessonsStarted: 5 })).toBeNull();
  });

  it("refuses any other lesson", () => {
    expect(start(7)).toBe("free_lesson_only");
  });

  it("still lets a student finish a lesson begun before the choice was made", () => {
    expect(start(7, { alreadyStarted: true })).toBeNull();
  });
});

describe("with no free lesson chosen nothing changes", () => {
  it("the free plan keeps its allowance of one lesson in its track", () => {
    const base = { entitlement: free, lessonTrack: "general", alreadyStarted: false, lessonId: 7, freeLessonId: null };
    expect(checkLessonAccess({ ...base, lessonsStarted: 0 })).toBeNull();
    expect(checkLessonAccess({ ...base, lessonsStarted: 1 })).toBe("quota_exhausted");
    expect(checkLessonAccess({ ...base, lessonsStarted: 0, lessonTrack: "professional" })).toBe("wrong_track");
  });

  it("and paying students are unaffected by a choice", () => {
    expect(
      checkLessonAccess({ entitlement: paid, lessonId: 7, lessonTrack: "general", lessonsStarted: 0, alreadyStarted: false, freeLessonId: FREE }),
    ).toBeNull();
    expect(
      checkLessonAccess({ entitlement: paid, lessonId: FREE, lessonTrack: "professional", lessonsStarted: 0, alreadyStarted: false, freeLessonId: FREE }),
    ).toBe("wrong_track");
  });
});

describe("reading a lesson", () => {
  const open = (lessonId: number, entitlement = free, alreadyStarted = false) =>
    lessonOpenDenial({ entitlement, lessonId, lessonTrack: "general", freeLessonId: FREE, alreadyStarted });

  it("follows the same rule as starting one", () => {
    expect(open(FREE)).toBeNull();
    expect(open(7)).toBe("free_lesson_only");
    expect(open(7, free, true)).toBeNull();
    expect(open(7, paid)).toBeNull();
  });
});

describe("how lessons look to a student limited to the free lesson", () => {
  it("the free lesson is open wherever it sits in the curriculum", () => {
    expect(stateForFreeLessonStudent("LOCKED", { isFree: true, started: false })).toBe("AVAILABLE");
  });

  it("every other lesson not yet started is locked", () => {
    expect(stateForFreeLessonStudent("AVAILABLE", { isFree: false, started: false })).toBe("LOCKED");
  });

  it("work already done or under way keeps its state", () => {
    expect(stateForFreeLessonStudent("COMPLETED", { isFree: false, started: true })).toBe("COMPLETED");
    expect(stateForFreeLessonStudent("IN_PROGRESS", { isFree: false, started: true })).toBe("IN_PROGRESS");
    expect(stateForFreeLessonStudent("AVAILABLE", { isFree: false, started: true })).toBe("AVAILABLE");
    // Begun as the free lesson before another was chosen: still open to finish.
    expect(stateForFreeLessonStudent("LOCKED", { isFree: false, started: true })).toBe("IN_PROGRESS");
  });
});

describe("how lessons look to every other student", () => {
  const plain = (started: boolean) => ({ freeOnly: false, isFree: false, started });

  it("follows the curriculum", () => {
    expect(studentLessonState("LOCKED", plain(false))).toBe("LOCKED");
    expect(studentLessonState("AVAILABLE", plain(false))).toBe("AVAILABLE");
  });

  it("keeps a lesson begun as the free lesson open after the choice is cleared", () => {
    expect(studentLessonState("LOCKED", plain(true))).toBe("IN_PROGRESS");
  });

  it("applies the free-lesson rule only to a student it limits", () => {
    expect(studentLessonState("AVAILABLE", { freeOnly: true, isFree: false, started: false })).toBe("LOCKED");
    expect(studentLessonState("LOCKED", { freeOnly: true, isFree: true, started: false })).toBe("AVAILABLE");
  });
});
