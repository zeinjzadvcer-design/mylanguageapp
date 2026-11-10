import { describe, it, expect } from "vitest";
import {
  bothQuiet,
  decodeLiveCall,
  encodeLiveCall,
  isCurrent,
  signalIdBase,
  signalsAfter,
  SIGNAL_READ_MAX,
} from "./practice-live-policy";
import type { PracticeSession } from "@workspace/db";

const session = {
  id: 7,
  requesterId: 1,
  partnerId: 2,
  status: "active",
  matchScore: 80,
  matchedAt: new Date("2026-11-10T10:00:00Z"),
  startedAt: new Date("2026-11-10T10:00:20Z"),
  endedAt: null,
  durationSeconds: null,
  endReason: null,
  endedBy: null,
  requesterSeenAt: null,
  partnerSeenAt: null,
  createdAt: new Date("2026-11-10T10:00:00Z"),
} as unknown as PracticeSession;

describe("the cached live call", () => {
  it("round-trips a call, with its dates as dates", () => {
    const back = decodeLiveCall(encodeLiveCall({ gen: 3, session }));
    expect(back?.gen).toBe(3);
    expect(back?.session?.startedAt).toBeInstanceOf(Date);
    expect(back?.session?.startedAt?.getTime()).toBe(session.startedAt!.getTime());
    expect(back?.session?.endedAt).toBeNull();
  });

  it("round-trips 'no call'", () => {
    expect(decodeLiveCall(encodeLiveCall({ gen: 0, session: null }))).toEqual({ gen: 0, session: null });
  });

  it("is used only at the student's current generation", () => {
    const entry = decodeLiveCall(encodeLiveCall({ gen: 3, session }));
    expect(isCurrent(entry, 3)).toBe(true);
    // A change since it was cached: read the database instead.
    expect(isCurrent(entry, 4)).toBe(false);
  });

  it("treats an unreadable value as missing", () => {
    expect(decodeLiveCall(null)).toBeNull();
    expect(decodeLiveCall("not json")).toBeNull();
    expect(decodeLiveCall(JSON.stringify({ session: null }))).toBeNull();
    expect(isCurrent(null, 0)).toBe(false);
  });
});

describe("whether a call has been abandoned", () => {
  const cutoff = 1_000_000;

  it("is abandoned when both sides were last seen before the cutoff", () => {
    expect(bothQuiet([cutoff - 1, cutoff - 50], cutoff)).toBe(true);
  });

  it("is not while either side is still polling", () => {
    expect(bothQuiet([cutoff - 1, cutoff + 5], cutoff)).toBe(false);
  });

  it("is never decided on a missing record, such as after a Valkey restart", () => {
    expect(bothQuiet([null, cutoff - 1], cutoff)).toBe(false);
    expect(bothQuiet([null, null], cutoff)).toBe(false);
    expect(bothQuiet([], cutoff)).toBe(false);
  });
});

describe("setup messages", () => {
  const stored = (id: number, kind = "ice") => JSON.stringify({ id, kind, payload: { n: id }, createdAt: "x" });

  it("number above anything the Postgres table handed out, inside a safe integer", () => {
    const base = signalIdBase(Date.parse("2026-11-10T10:00:00Z"));
    expect(base).toBeGreaterThan(2 ** 31);
    expect(Number.isSafeInteger(base + 10_000)).toBe(true);
  });

  it("hands over only messages after the last one seen, oldest first", () => {
    const list = [stored(12), stored(10), stored(11)];
    expect(signalsAfter(list, 10).map((s) => s.id)).toEqual([11, 12]);
    expect(signalsAfter(list, 0).map((s) => s.id)).toEqual([10, 11, 12]);
    expect(signalsAfter(list, 12)).toEqual([]);
  });

  it("skips an unreadable entry rather than failing", () => {
    expect(signalsAfter(["{broken", stored(5)], 0).map((s) => s.id)).toEqual([5]);
  });

  it("hands over at most one batch at a time", () => {
    const many = Array.from({ length: SIGNAL_READ_MAX + 20 }, (_, i) => stored(i + 1));
    expect(signalsAfter(many, 0)).toHaveLength(SIGNAL_READ_MAX);
  });
});
