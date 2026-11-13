import { describe, expect, it } from "vitest";
import { adviseCapacity, type AdviceSettings, type UsageTotals } from "./capacity-advice";

const settings: AdviceSettings = { target: 0.7, dbPoolMax: 10, assumedLearnerRps: 0.25 };

// 15 minutes of a server serving 20 requests a second, 10 % busy, one database
// connection in use on average, with 50 students and no calls.
const quiet: UsageTotals = {
  windowS: 900,
  requests: 18_000,
  callRequests: 0,
  busyS: 90,
  dbInUseAvg: 1,
  learnersAvg: 50,
  callsAvg: 0,
};

describe("suggested limits", () => {
  it("fills the CPU to the target: 7× today's load at 10 % busy", () => {
    const advice = adviseCapacity(quiet, settings);
    // 0.005 s of CPU a request → 140 requests a second at 70 %; 0.4 each per student.
    expect(advice.capacityRps).toBe(140);
    expect(advice.lessons).toEqual({ value: 350, basis: "measured" });
    expect(advice.cpuShare).toBeCloseTo(0.1);
  });

  it("is held back by the database when connections run out first", () => {
    const advice = adviseCapacity({ ...quiet, dbInUseAvg: 5 }, settings);
    // Half the connections in use at 20 requests a second → 28 a second at 70 %.
    expect(advice.capacityRps).toBe(28);
    expect(advice.lessons.value).toBe(70);
  });

  it("leaves room for the calls that are running, and prices a call in students", () => {
    const advice = adviseCapacity({ ...quiet, requests: 19_800, callRequests: 1_800, callsAvg: 10, busyS: 99 }, settings);
    // 2 call requests a second over 10 calls: 0.2 each; students 0.4 each.
    expect(advice.lessons.value).toBe(345); // (140 − 2) / 0.4
    expect(advice.calls).toEqual({ value: 600, basis: "measured" }); // (140 − 20) / 0.2
    expect(advice.callInLearners).toBe(0.5);
  });

  it("estimates the students' share when there are too few students to measure", () => {
    const advice = adviseCapacity({ ...quiet, learnersAvg: 1 }, settings);
    expect(advice.lessons).toEqual({ value: 560, basis: "estimated" }); // 140 / 0.25
    expect(advice.calls.basis).toBe("insufficient");
  });

  it("says nothing until there is enough traffic to measure", () => {
    expect(adviseCapacity({ ...quiet, windowS: 120 }, settings).lessons.basis).toBe("insufficient");
    expect(adviseCapacity({ ...quiet, requests: 100 }, settings).lessons.value).toBeNull();
  });

  it("never suggests a negative number on a server already past the target", () => {
    const advice = adviseCapacity({ ...quiet, requests: 19_800, callRequests: 1_800, callsAvg: 10, busyS: 850 }, settings);
    expect(advice.lessons.value).toBeGreaterThanOrEqual(0);
    expect(advice.calls.value).toBeGreaterThanOrEqual(0);
  });
});
