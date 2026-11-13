import { describe, it, expect } from "vitest";
import { createSlots, isOverloaded, takeLocalSeat, type LoadLimits } from "./lesson-load-policy";

const limits: LoadLimits = { lagLimitMs: 500, dbWaitingLimit: 10 };

describe("overload detection", () => {
  it("is calm while the server keeps up", () => {
    expect(isOverloaded({ loopLagMs: 30, dbWaiting: 0 }, limits)).toBe(false);
  });

  it("trips when the server falls behind", () => {
    expect(isOverloaded({ loopLagMs: 800, dbWaiting: 0 }, limits)).toBe(true);
  });

  it("trips when requests queue for the database", () => {
    expect(isOverloaded({ loopLagMs: 30, dbWaiting: 10 }, limits)).toBe(true);
    expect(isOverloaded({ loopLagMs: 30, dbWaiting: 9 }, limits)).toBe(false);
  });

  it("can be switched off, signal by signal", () => {
    expect(isOverloaded({ loopLagMs: 10_000, dbWaiting: 100 }, { lagLimitMs: 0, dbWaitingLimit: 0 })).toBe(false);
  });
});

describe("seats in lessons (no Valkey)", () => {
  const NOW = 1_000_000;
  const SINCE = NOW - 600_000;

  it("seats students until the limit, then refuses newcomers", () => {
    const seats = new Map<number, number>();
    expect(takeLocalSeat(seats, 1, NOW, SINCE, 2)).toBe(true);
    expect(takeLocalSeat(seats, 2, NOW, SINCE, 2)).toBe(true);
    expect(takeLocalSeat(seats, 3, NOW, SINCE, 2)).toBe(false);
    expect(seats.has(3)).toBe(false);
  });

  it("never refuses a student who already has a seat, and refreshes it", () => {
    const seats = new Map([[1, NOW - 1_000], [2, NOW - 1_000]]);
    expect(takeLocalSeat(seats, 1, NOW, SINCE, 2)).toBe(true);
    expect(seats.get(1)).toBe(NOW);
  });

  it("frees seats not used within the window", () => {
    const seats = new Map([[1, SINCE - 1], [2, NOW]]);
    expect(takeLocalSeat(seats, 3, NOW, SINCE, 2)).toBe(true);
    expect(seats.has(1)).toBe(false);
  });

  it("has no limit when none is set", () => {
    const seats = new Map<number, number>();
    for (let id = 0; id < 1_000; id++) expect(takeLocalSeat(seats, id, NOW, SINCE, null)).toBe(true);
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
