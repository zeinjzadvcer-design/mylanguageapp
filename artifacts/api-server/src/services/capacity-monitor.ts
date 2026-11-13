/**
 * Measures what this server is doing, for the suggested limits on the admin
 * Capacity page (capacity-advice.ts does the arithmetic).
 *
 * Kept in 15-second buckets over the last 15 minutes: requests served (and how
 * many were for voice calls), how busy the CPU thread was, how many database
 * connections were in use, and how many students were in lessons and calls
 * were live. Each instance measures itself; the student and call counts are
 * site-wide, which is what makes the suggestion come out site-wide too when
 * more than one instance shares the traffic.
 */

import { performance, type EventLoopUtilization } from "node:perf_hooks";
import type { NextFunction, Request, Response } from "express";
import { pool } from "@workspace/db";
import { envInt } from "../lib/env";
import { logger } from "../lib/logger";
import { countActiveLearners } from "./lesson-load";
import { countLiveCalls } from "./practice";
import { adviseCapacity, type CapacityAdvice, type UsageTotals } from "./capacity-advice";

const BUCKET_MS = 15_000;
const BUCKETS = 60; // 15 minutes
const DB_SAMPLE_MS = 1_000;

/** Share of the CPU and database connections the suggestions plan to fill. */
const TARGET = envInt("CAPACITY_TARGET_PERCENT", 70) / 100;
const DB_POOL_MAX = envInt("DB_POOL_MAX", 10);
/**
 * Requests per second for one student in a lesson, used until there are
 * enough students to measure it. The load test's students, who answered
 * every two to four seconds, made about 0.32; real ones read and think.
 */
const ASSUMED_LEARNER_RPS = 0.25;

interface Bucket {
  wallMs: number;
  requests: number;
  callRequests: number;
  busyMs: number;
  dbInUseSum: number;
  dbSamples: number;
  learners: number | null;
  calls: number | null;
}

const emptyBucket = (): Bucket => ({
  wallMs: 0,
  requests: 0,
  callRequests: 0,
  busyMs: 0,
  dbInUseSum: 0,
  dbSamples: 0,
  learners: null,
  calls: null,
});

const closed: Bucket[] = [];
let current = emptyBucket();
let bucketStartedAt = Date.now();
let lastElu: EventLoopUtilization | null = null;
let started = false;

/** Counts each API request. Cheap: two increments. */
export function countRequest(req: Request, _res: Response, next: NextFunction): void {
  if (started && req.path.startsWith("/api/")) {
    current.requests++;
    if (req.path.startsWith("/api/practice/")) current.callRequests++;
  }
  next();
}

async function closeBucket(): Promise<void> {
  const now = Date.now();
  const elu = performance.eventLoopUtilization();
  const bucket = current;
  bucket.wallMs = now - bucketStartedAt;
  bucket.busyMs = lastElu ? performance.eventLoopUtilization(elu, lastElu).active : 0;
  lastElu = elu;
  current = emptyBucket();
  bucketStartedAt = now;
  closed.push(bucket);
  if (closed.length > BUCKETS) closed.shift();

  // Sampled once a bucket. Filled in after the bucket closes, and a failure
  // leaves the bucket out of the averages rather than counting zero.
  try {
    const [learners, calls] = await Promise.all([countActiveLearners(), countLiveCalls()]);
    bucket.learners = learners;
    bucket.calls = calls;
  } catch (err) {
    logger.debug({ err }, "Capacity monitor could not count students and calls");
  }
}

/** Start measuring. Called once, when the server starts listening. */
export function startCapacityMonitor(): void {
  if (started) return;
  started = true;
  bucketStartedAt = Date.now();
  lastElu = performance.eventLoopUtilization();
  setInterval(() => {
    current.dbInUseSum += pool.totalCount - pool.idleCount;
    current.dbSamples++;
  }, DB_SAMPLE_MS).unref();
  setInterval(() => void closeBucket(), BUCKET_MS).unref();
}

function totals(): UsageTotals {
  let windowMs = 0;
  let requests = 0;
  let callRequests = 0;
  let busyMs = 0;
  let dbSum = 0;
  let dbSamples = 0;
  let learnersSum = 0;
  let callsSum = 0;
  let counted = 0;
  for (const b of closed) {
    windowMs += b.wallMs;
    requests += b.requests;
    callRequests += b.callRequests;
    busyMs += b.busyMs;
    dbSum += b.dbInUseSum;
    dbSamples += b.dbSamples;
    if (b.learners !== null && b.calls !== null) {
      learnersSum += b.learners;
      callsSum += b.calls;
      counted++;
    }
  }
  return {
    windowS: windowMs / 1000,
    requests,
    callRequests,
    busyS: busyMs / 1000,
    dbInUseAvg: dbSamples ? dbSum / dbSamples : 0,
    learnersAvg: counted ? learnersSum / counted : 0,
    callsAvg: counted ? callsSum / counted : 0,
  };
}

/** The suggested limits, from the last 15 minutes. */
export function capacityAdvice(): CapacityAdvice {
  return adviseCapacity(totals(), {
    target: TARGET,
    dbPoolMax: DB_POOL_MAX,
    assumedLearnerRps: ASSUMED_LEARNER_RPS,
  });
}
