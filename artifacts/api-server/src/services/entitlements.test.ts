import { describe, it, expect } from "vitest";
import {
  checkLessonAccess,
  isLessonInTrack,
  DENIAL_MESSAGES,
  type Entitlement,
} from "./entitlement-policy";

const free: Entitlement = {
  planCode: "free",
  track: "general",
  quota: 1,
  isPaid: false,
};

const general: Entitlement = {
  planCode: "general_english",
  track: "general",
  quota: null,
  isPaid: true,
};

const professional: Entitlement = {
  planCode: "professional_english",
  track: "professional",
  quota: null,
  isPaid: true,
};

describe("isLessonInTrack — tracks are alternatives, not tiers", () => {
  it("matches a lesson in the subscriber's own track", () => {
    expect(isLessonInTrack(general, "general")).toBe(true);
    expect(isLessonInTrack(professional, "professional")).toBe(true);
  });

  it("refuses a professional lesson to a general subscriber", () => {
    expect(isLessonInTrack(general, "professional")).toBe(false);
  });

  it("refuses a general lesson to a professional subscriber", () => {
    // The direction that a tier model would get wrong: the $4 plan does NOT
    // include the $2 plan's content. Neither track contains the other.
    expect(isLessonInTrack(professional, "general")).toBe(false);
  });
});

describe("checkLessonAccess — the free lesson quota", () => {
  it("lets a free student start their first lesson", () => {
    expect(
      checkLessonAccess({
        entitlement: free,
        lessonTrack: "general",
        lessonsStarted: 0,
        alreadyStarted: false,
      }),
    ).toBeNull();
  });

  it("refuses a second lesson once the quota is spent", () => {
    expect(
      checkLessonAccess({
        entitlement: free,
        lessonTrack: "general",
        lessonsStarted: 1,
        alreadyStarted: false,
      }),
    ).toBe("quota_exhausted");
  });

  it("still lets the student resume the lesson they already started", () => {
    // The whole point of counting distinct lessons rather than attempts. A free
    // student who closes the tab mid-lesson must be able to reopen it, even
    // though their one start is spent.
    expect(
      checkLessonAccess({
        entitlement: free,
        lessonTrack: "general",
        lessonsStarted: 1,
        alreadyStarted: true,
      }),
    ).toBeNull();
  });

  it("never applies a quota to an unlimited plan", () => {
    expect(
      checkLessonAccess({
        entitlement: general,
        lessonTrack: "general",
        lessonsStarted: 500,
        alreadyStarted: false,
      }),
    ).toBeNull();
  });
});

describe("checkLessonAccess — track is checked before quota", () => {
  it("reports the wrong track rather than the spent quota", () => {
    // Both would deny, but the reasons lead to different UI: one offers an
    // upgrade, the other says this content is not on your plan at all.
    expect(
      checkLessonAccess({
        entitlement: free,
        lessonTrack: "professional",
        lessonsStarted: 1,
        alreadyStarted: false,
      }),
    ).toBe("wrong_track");
  });

  it("refuses a wrong-track lesson even when it was somehow already started", () => {
    // `alreadyStarted` forgives the quota, never the track. A student whose
    // plan changed must not keep reading the other track's content.
    expect(
      checkLessonAccess({
        entitlement: professional,
        lessonTrack: "general",
        lessonsStarted: 0,
        alreadyStarted: true,
      }),
    ).toBe("wrong_track");
  });
});

describe("checkLessonAccess — a zero quota denies everything", () => {
  it("refuses even the first lesson", () => {
    // `?? ` vs `||` in getEntitlement matters here: a deliberate 0 must stay 0
    // rather than collapsing to the fallback of 1.
    const noTrial: Entitlement = { ...free, quota: 0 };
    expect(
      checkLessonAccess({
        entitlement: noTrial,
        lessonTrack: "general",
        lessonsStarted: 0,
        alreadyStarted: false,
      }),
    ).toBe("quota_exhausted");
  });
});

describe("DENIAL_MESSAGES", () => {
  it("carries an Arabic message for every denial reason", () => {
    // The student API answers Arabic-first; a denial that reaches a student
    // without `errorAr` would surface as untranslated English.
    for (const reason of ["wrong_track", "quota_exhausted"] as const) {
      expect(DENIAL_MESSAGES[reason].errorAr.trim()).not.toBe("");
      expect(DENIAL_MESSAGES[reason].error.trim()).not.toBe("");
    }
  });
});
