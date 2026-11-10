import { describe, it, expect } from "vitest";
import {
  checkLessonAccess,
  isLessonInTrack,
  DENIAL_MESSAGES,
  canReadMediaAsset,
  checkCallAccess,
  currentPeriodStart,
  isUnmeteredRole,
  unmeteredEntitlement,
  previousLessonInTrack,
  type Entitlement,
} from "./entitlement-policy";

const free: Entitlement = {
  planCode: "free",
  track: "general",
  lessonQuota: 1,
  callQuota: 0,
  isPaid: false,
  // Null, not a date: the trial is one lesson EVER, so the counters read the
  // account's whole history rather than a monthly window.
  periodStartedAt: null,
  unlimited: false,
};

const general: Entitlement = {
  planCode: "general_basic",
  track: "general",
  lessonQuota: 12,
  callQuota: 8,
  isPaid: true,
  periodStartedAt: new Date("2026-11-01T00:00:00.000Z"),
  unlimited: false,
};

const professional: Entitlement = {
  planCode: "pro_basic",
  track: "professional",
  lessonQuota: 12,
  callQuota: 8,
  isPaid: true,
  periodStartedAt: new Date("2026-11-01T00:00:00.000Z"),
  unlimited: false,
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

  it("applies the monthly allowance to a paid plan too", () => {
    // The $2 tier buys 12 lessons a month, not unlimited — that is what
    // separates it from the $5 tier in the same track.
    expect(
      checkLessonAccess({
        entitlement: general,
        lessonTrack: "general",
        lessonsStarted: 11,
        alreadyStarted: false,
      }),
    ).toBeNull();
    expect(
      checkLessonAccess({
        entitlement: general,
        lessonTrack: "general",
        lessonsStarted: 12,
        alreadyStarted: false,
      }),
    ).toBe("quota_exhausted");
  });

  it("never applies a quota when the plan sets none", () => {
    const unlimitedPlan: Entitlement = { ...general, lessonQuota: null };
    expect(
      checkLessonAccess({
        entitlement: unlimitedPlan,
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
    const noTrial: Entitlement = { ...free, lessonQuota: 0 };
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

describe("canReadMediaAsset — payment receipts are financial records", () => {
  const receipt = { ownerUserId: 7, purpose: "payment_receipt" };
  const recording = { ownerUserId: 7, purpose: "lesson_activity" };

  it("lets payments staff read a receipt, and no student recording", () => {
    expect(canReadMediaAsset(receipt, { userId: 99, role: "payments_manager" })).toBe(true);
    expect(canReadMediaAsset(recording, { userId: 99, role: "payments_manager" })).toBe(false);
  });

  it("lets the student read their own receipt", () => {
    expect(
      canReadMediaAsset(receipt, { userId: 7, role: "student" }),
    ).toBe(true);
  });

  it("refuses another student's receipt", () => {
    expect(
      canReadMediaAsset(receipt, { userId: 8, role: "student" }),
    ).toBe(false);
  });

  it("lets an admin read a receipt — they review the payment", () => {
    expect(
      canReadMediaAsset(receipt, { userId: 99, role: "admin" }),
    ).toBe(true);
  });

  it("refuses a content_manager both, since they do not mark work", () => {
    expect(
      canReadMediaAsset(receipt, { userId: 99, role: "content_manager" }),
    ).toBe(false);
    expect(
      canReadMediaAsset(recording, { userId: 99, role: "content_manager" }),
    ).toBe(false);
  });

  it("lets an admin hear a recording, in order to mark it", () => {
    expect(canReadMediaAsset(recording, { userId: 99, role: "admin" })).toBe(true);
    expect(canReadMediaAsset(recording, { userId: 99, role: "payments_manager" })).toBe(false);
  });

  it("lets anyone signed in see an unowned asset, such as the ShamCash QR", () => {
    // The QR must be visible to every student or nobody can pay.
    expect(
      canReadMediaAsset(
        { ownerUserId: null, purpose: "payment_qr" },
        { userId: 8, role: "student" }),
    ).toBe(true);
  });

  it("refuses a viewer with no role at all", () => {
    expect(
      canReadMediaAsset(receipt, { userId: 8, role: undefined }),
    ).toBe(false);
  });
});


describe("staff are not metered", () => {
  it("names admin and content_manager as unmetered", () => {
    expect(isUnmeteredRole("admin")).toBe(true);
    expect(isUnmeteredRole("content_manager")).toBe(true);
    // Retired: an account still holding it gets no exemption.
    expect(isUnmeteredRole("content_reviewer")).toBe(false);
  });

  it("meters a student and an unknown role", () => {
    expect(isUnmeteredRole("student")).toBe(false);
    expect(isUnmeteredRole(undefined)).toBe(false);
    expect(isUnmeteredRole("")).toBe(false);
  });

  it("lets staff open a lesson in either track, with no allowance", () => {
    // The bug this covers: staff hold no subscription, so they fell through to
    // the free plan — one lesson, then locked — which made their own content
    // unreviewable. routes/lessons.ts admits them to the student flow on
    // purpose, so the paywall has to let them through.
    const staff = unmeteredEntitlement("admin");
    for (const track of ["general", "professional"]) {
      expect(
        checkLessonAccess({
          entitlement: staff,
          lessonTrack: track,
          lessonsStarted: 9999,
          alreadyStarted: false,
        }),
      ).toBeNull();
    }
    expect(checkCallAccess({ entitlement: staff, callsStarted: 9999 })).toBeNull();
  });
});

describe("checkCallAccess — the monthly call allowance", () => {
  it("allows a call below the allowance", () => {
    expect(checkCallAccess({ entitlement: general, callsStarted: 7 })).toBeNull();
  });

  it("refuses the call that would exceed it", () => {
    expect(checkCallAccess({ entitlement: general, callsStarted: 8 })).toBe(
      "call_quota_exhausted",
    );
  });

  it("refuses every call on the free plan, which buys none", () => {
    expect(checkCallAccess({ entitlement: free, callsStarted: 0 })).toBe(
      "call_quota_exhausted",
    );
  });

  it("never refuses when the plan sets no call quota", () => {
    expect(
      checkCallAccess({ entitlement: { ...general, callQuota: null }, callsStarted: 500 }),
    ).toBeNull();
  });
});

describe("currentPeriodStart — the allowance resets monthly", () => {
  it("keeps the anchor while the first month is still running", () => {
    const anchor = new Date("2026-11-03T10:00:00.000Z");
    expect(
      currentPeriodStart(anchor, new Date("2026-11-20T10:00:00.000Z")).toISOString(),
    ).toBe(anchor.toISOString());
  });

  it("rolls forward one month once the boundary passes", () => {
    const anchor = new Date("2026-11-03T10:00:00.000Z");
    expect(
      currentPeriodStart(anchor, new Date("2026-12-05T10:00:00.000Z")).toISOString(),
    ).toBe("2026-12-03T10:00:00.000Z");
  });

  it("lands on the CURRENT period after a long gap, not the first unused one", () => {
    // A subscription dormant for months must not hand over one allowance for
    // the whole gap, nor accumulate the ones it did not use.
    const anchor = new Date("2026-05-03T10:00:00.000Z");
    expect(
      currentPeriodStart(anchor, new Date("2026-11-20T10:00:00.000Z")).toISOString(),
    ).toBe("2026-11-03T10:00:00.000Z");
  });

  it("clamps to a short month and returns to the anchor day afterwards", () => {
    const anchor = new Date("2026-01-31T10:00:00.000Z");
    expect(
      currentPeriodStart(anchor, new Date("2026-03-05T10:00:00.000Z")).toISOString(),
    ).toBe("2026-02-28T10:00:00.000Z");
    expect(
      currentPeriodStart(anchor, new Date("2026-04-01T10:00:00.000Z")).toISOString(),
    ).toBe("2026-03-31T10:00:00.000Z");
  });

  it("does not mutate the anchor it was given", () => {
    const anchor = new Date("2026-05-03T10:00:00.000Z");
    currentPeriodStart(anchor, new Date("2026-11-20T10:00:00.000Z"));
    expect(anchor.toISOString()).toBe("2026-05-03T10:00:00.000Z");
  });
});


describe("the free trial does not renew", () => {
  it("has no quota period, so the count is over all time", () => {
    // A date here would reset the trial every month and the paywall would
    // never really bite. Null is what makes it "one lesson, ever".
    expect(free.periodStartedAt).toBeNull();
  });

  it("still refuses a second lesson however long ago the first was", () => {
    expect(
      checkLessonAccess({
        entitlement: free,
        lessonTrack: "general",
        lessonsStarted: 1,
        alreadyStarted: false,
      }),
    ).toBe("quota_exhausted");
  });

  it("keeps a monthly period for a paid plan", () => {
    expect(general.periodStartedAt).not.toBeNull();
  });
});

describe("deriveLessonStateWithOrders — staff bypass progression too", () => {
  it("opens a future level for staff, which progression would lock", async () => {
    // Separate gate from the paywall: this locks by level order and by
    // whether the previous lesson was completed. An admin's profile sits at
    // level 1, so every later level read as مقفل and the content they are
    // there to review could not be opened.
    const { deriveLessonStateWithOrders } = await import("./entitlement-policy");

    const lesson = { id: 42, order: 3 };
    const futureLevel = 9;
    const studentAtLevelOne = 1;

    expect(
      deriveLessonStateWithOrders(
        lesson, futureLevel, studentAtLevelOne, new Set(), 41, null, false,
      ),
    ).toBe("LOCKED");

    expect(
      deriveLessonStateWithOrders(
        lesson, futureLevel, studentAtLevelOne, new Set(), 41, null, true,
      ),
    ).toBe("AVAILABLE");
  });

  it("opens lessons for staff with no placement at all", async () => {
    // currentLevelOrder is null for anyone without a placed level, which
    // locked everything outright.
    const { deriveLessonStateWithOrders } = await import("./entitlement-policy");
    expect(
      deriveLessonStateWithOrders(
        { id: 1, order: 1 }, 5, null, new Set(), null, null, true,
      ),
    ).toBe("AVAILABLE");
  });

  it("still reports work in progress for staff", async () => {
    const { deriveLessonStateWithOrders } = await import("./entitlement-policy");
    expect(
      deriveLessonStateWithOrders(
        { id: 1, order: 1 }, 5, null, new Set(), null, "in_progress", true,
      ),
    ).toBe("IN_PROGRESS");
  });
});

describe("previousLessonInTrack", () => {
  // One level, both tracks interleaved in the shared ordering.
  const level = [
    { id: 1, track: "general" },
    { id: 2, track: "professional" },
    { id: 3, track: "general" },
    { id: 4, track: "professional" },
  ];

  it("skips the other track's lessons", () => {
    expect(previousLessonInTrack(level, 2)).toBe(1);
    expect(previousLessonInTrack(level, 3)).toBe(2);
  });

  it("has no predecessor for the first lesson of each track", () => {
    expect(previousLessonInTrack(level, 0)).toBeNull();
    expect(previousLessonInTrack(level, 1)).toBeNull();
  });
});
