import { describe, it, expect } from "vitest";
import { addBillingCycle } from "./entitlement-policy";

describe("addBillingCycle — the clock starts at activation", () => {
  it("adds a month for a monthly plan", () => {
    const from = new Date("2026-03-15T10:00:00.000Z");
    expect(addBillingCycle(from, "monthly").toISOString()).toBe(
      "2026-04-15T10:00:00.000Z",
    );
  });

  it("adds a year for a yearly plan", () => {
    const from = new Date("2026-03-15T10:00:00.000Z");
    expect(addBillingCycle(from, "yearly").toISOString()).toBe(
      "2027-03-15T10:00:00.000Z",
    );
  });

  it("treats an unknown cycle as monthly rather than granting forever", () => {
    // Fails closed. A plan row with a cycle this code does not know must not
    // produce a subscription with no meaningful expiry.
    const from = new Date("2026-03-15T10:00:00.000Z");
    expect(addBillingCycle(from, "fortnightly").toISOString()).toBe(
      "2026-04-15T10:00:00.000Z",
    );
  });

  it("does not mutate the date it was given", () => {
    // The caller uses `startedAt` after computing `expiresAt` from it; a
    // mutating implementation would silently move the start date too.
    const from = new Date("2026-03-15T10:00:00.000Z");
    addBillingCycle(from, "monthly");
    expect(from.toISOString()).toBe("2026-03-15T10:00:00.000Z");
  });
});

describe("addBillingCycle — month ends", () => {
  it("clamps 31 January to the end of February rather than landing in March", () => {
    // setMonth would otherwise overflow 31 February into 2 or 3 March, giving
    // the student a few days they did not pay for and moving their billing
    // date permanently.
    const jan31 = new Date("2026-01-31T12:00:00.000Z");
    expect(addBillingCycle(jan31, "monthly").toISOString()).toBe("2026-02-28T12:00:00.000Z");
  });

  it("handles a leap day", () => {
    const leap = new Date("2028-02-29T12:00:00.000Z");
    const result = addBillingCycle(leap, "yearly");
    // 29 February 2029 does not exist; JS rolls it to 1 March.
    expect(result.getUTCFullYear()).toBe(2029);
  });
});
