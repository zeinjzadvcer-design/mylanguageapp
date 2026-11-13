/**
 * Suggested limits for students in lessons and for live voice calls, worked
 * out from what this server has actually been doing.
 *
 * No timers or I/O here, so the arithmetic can be tested directly; the
 * measurements come from capacity-monitor.ts.
 *
 * THE IDEA
 * ────────
 * The server has two things that run out: the CPU (Node does its work on one
 * thread, so one core however many the machine has) and its database
 * connections. Over the last few minutes we know how many requests it served
 * and how much of each it used, so we know the cost of one request. We also
 * know how many requests one student in a lesson, and one live call, makes per
 * second. Together: how many students (or calls) fill the server to the target
 * level, leaving the rest as headroom for bursts.
 *
 * Each suggestion assumes the other stays as it was over the window: the
 * lesson figure leaves room for the calls that were running, and the call
 * figure for the students who were in lessons.
 */

export interface UsageTotals {
  /** Length of the measured window, in seconds. */
  windowS: number;
  /** All API requests served in the window. */
  requests: number;
  /** Of those, requests for voice calls (/api/practice/...). */
  callRequests: number;
  /** Time the CPU thread was busy in the window, in seconds. */
  busyS: number;
  /** Database connections in use, averaged over the window. */
  dbInUseAvg: number;
  /** Students in lessons, averaged over the window (all instances). */
  learnersAvg: number;
  /** Live calls, averaged over the window (all instances). */
  callsAvg: number;
}

export interface AdviceSettings {
  /** Share of the CPU and of the database connections to plan to fill. */
  target: number;
  /** Database connections this process may hold (DB_POOL_MAX). */
  dbPoolMax: number;
  /**
   * Requests per second one student in a lesson makes when there are too few
   * students yet to measure it.
   */
  assumedLearnerRps: number;
}

export type AdviceBasis =
  /** From this server's own traffic. */
  | "measured"
  /** Server cost measured, but too few students or calls yet to measure what one costs. */
  | "estimated"
  /** Not enough traffic yet to say anything. */
  | "insufficient";

export interface Suggestion {
  value: number | null;
  basis: AdviceBasis;
}

export interface CapacityAdvice {
  lessons: Suggestion;
  calls: Suggestion;
  /** How much of the window the measurements cover, in minutes. */
  measuredMinutes: number;
  /** Share of the CPU in use over the window, 0–1. */
  cpuShare: number;
  /** Share of the database connections in use over the window, 0–1. */
  dbShare: number;
  /** Requests per second the server could serve at the target level, or null. */
  capacityRps: number | null;
  /** What one live call costs, in students in lessons; null until both are measured. */
  callInLearners: number | null;
}

/** Below these the figures are mostly noise. */
export const MIN_WINDOW_S = 5 * 60;
export const MIN_REQUESTS = 300;
export const MIN_LEARNERS = 3;
export const MIN_CALLS = 1;

export function adviseCapacity(t: UsageTotals, s: AdviceSettings): CapacityAdvice {
  const cpuShare = t.windowS > 0 ? Math.min(1, t.busyS / t.windowS) : 0;
  const dbShare = s.dbPoolMax > 0 ? Math.min(1, t.dbInUseAvg / s.dbPoolMax) : 0;
  const base = {
    measuredMinutes: Math.floor(t.windowS / 60),
    cpuShare,
    dbShare,
  };
  const none: Suggestion = { value: null, basis: "insufficient" };

  if (t.windowS < MIN_WINDOW_S || t.requests < MIN_REQUESTS) {
    return { ...base, lessons: none, calls: none, capacityRps: null, callInLearners: null };
  }

  // What one request costs, and so how many per second fit at the target.
  const cpuPerRequestS = t.busyS / t.requests;
  const dbPerRequestS = (t.dbInUseAvg * t.windowS) / t.requests;
  const capacityRps = Math.min(
    cpuPerRequestS > 0 ? s.target / cpuPerRequestS : Infinity,
    dbPerRequestS > 0 ? (s.target * s.dbPoolMax) / dbPerRequestS : Infinity,
  );
  if (!Number.isFinite(capacityRps)) {
    return { ...base, lessons: none, calls: none, capacityRps: null, callInLearners: null };
  }

  const callRps = t.callRequests / t.windowS;
  // Everything that is not a call is put down to students: browsing the
  // curriculum and the dashboard is part of what a student in a lesson costs.
  const otherRps = (t.requests - t.callRequests) / t.windowS;

  const learnersMeasured = t.learnersAvg >= MIN_LEARNERS;
  const learnerRps = learnersMeasured ? otherRps / t.learnersAvg : s.assumedLearnerRps;
  const lessons: Suggestion = {
    value: Math.max(0, Math.floor((capacityRps - callRps) / learnerRps)),
    basis: learnersMeasured ? "measured" : "estimated",
  };

  const callsMeasured = t.callsAvg >= MIN_CALLS && t.callRequests > 0;
  const callRpsEach = callsMeasured ? callRps / t.callsAvg : null;
  const calls: Suggestion =
    callRpsEach !== null
      ? { value: Math.max(0, Math.floor((capacityRps - otherRps) / callRpsEach)), basis: "measured" }
      : none;

  return {
    ...base,
    lessons,
    calls,
    capacityRps: Math.round(capacityRps),
    callInLearners:
      callRpsEach !== null && learnersMeasured ? Math.round((callRpsEach / learnerRps) * 10) / 10 : null,
  };
}
