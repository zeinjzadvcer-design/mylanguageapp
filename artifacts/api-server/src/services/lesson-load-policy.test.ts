import { describe, it, expect } from "vitest";
import { createSlots, isOverloaded, lessonRefusal, type LoadLimits, type LoadSignals } from "./lesson-load-policy";

const calm: LoadSignals = { loopLagMs: 30, dbWaiting: 0 };
const limits: LoadLimits = { maxActiveLearners: 100, lagLimitMs: 500, dbWaitingLimit: 10 };

const refusal = (over: Partial<Parameters<typeof lessonRefusal>[0]> = {}) =>
  lessonRefusal({ staff: false, alreadyIn: false, activeLearners: 10, signals: calm, limits, ...over });

describe("opening a lesson", () => {
  it("is allowed while there is room and the server is calm", () => {
    expect(refusal()).toBeNull();
  });

  it("is refused once the administrator's limit is reached", () => {
    expect(refusal({ activeLearners: 100 })).toBe("full");
    expect(refusal({ activeLearners: 99 })).toBeNull();
  });

  it("has no limit when none is set", () => {
    expect(refusal({ activeLearners: 100_000, limits: { ...limits, maxActiveLearners: null } })).toBeNull();
  });

  it("is refused while the server falls behind", () => {
    expect(refusal({ signals: { loopLagMs: 800, dbWaiting: 0 } })).toBe("overloaded");
  });

  it("is refused while requests queue for the database", () => {
    expect(refusal({ signals: { loopLagMs: 30, dbWaiting: 10 } })).toBe("overloaded");
    expect(refusal({ signals: { loopLagMs: 30, dbWaiting: 9 } })).toBeNull();
  });

  it("never turns away a student already in a lesson", () => {
    expect(refusal({ alreadyIn: true, activeLearners: 1_000 })).toBeNull();
    expect(refusal({ alreadyIn: true, signals: { loopLagMs: 5_000, dbWaiting: 50 } })).toBeNull();
  });

  it("never turns away staff, who must be able to check content", () => {
    expect(refusal({ staff: true, activeLearners: 1_000, signals: { loopLagMs: 5_000, dbWaiting: 50 } })).toBeNull();
  });
});

describe("overload detection", () => {
  it("can be switched off, signal by signal", () => {
    const off: LoadLimits = { maxActiveLearners: null, lagLimitMs: 0, dbWaitingLimit: 0 };
    expect(isOverloaded({ loopLagMs: 10_000, dbWaiting: 100 }, off)).toBe(false);
  });
});

describe("inline grading slots", () => {
  it("hands out at most the limit, and a slot comes back when released", () => {
    const slots = createSlots(2);
    const a = slots.tryTake();
    const b = slots.tryTake();
    expect(a && b).toBeTruthy();
    expect(slots.tryTake()).toBeNull();
    a!();
    expect(slots.inUse).toBe(1);
    expect(slots.tryTake()).not.toBeNull();
  });

  it("does not hand a slot back twice when released twice", () => {
    const slots = createSlots(1);
    const release = slots.tryTake()!;
    release();
    release();
    expect(slots.inUse).toBe(0);
  });

  it("with a limit of zero, sends everything to the background", () => {
    expect(createSlots(0).tryTake()).toBeNull();
  });
});
