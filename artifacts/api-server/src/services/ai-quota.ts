/**
 * AI Quota Enforcement Service
 *
 * Two-layer architecture:
 *   Fast layer  → Redis atomic counters (INCR + EXPIRE) for real-time enforcement
 *   Durable layer → PostgreSQL ai_usage_logs table for billing, auditing, abuse detection
 *
 * FAILURE BEHAVIOR
 * ─────────────────
 * Redis unavailable → FAIL CLOSED (deny the AI request)
 * This is intentional: at $2–$4/month subscriptions, allowing unlimited AI
 * requests because Redis is down would be extremely costly. Students see a
 * "service temporarily unavailable" message rather than unlimited access.
 *
 * PER-PLAN, PER-TASK LIMITS
 * ──────────────────────────
 * Read from `ai_plan_policies` at call time and edited from the admin panel —
 * see services/ai-config.ts. The commercial split is not settled, so pricing a
 * new tier must be a row rather than a deploy. A plan/task pair with no policy
 * row is denied: defaulting to "allowed" would make every task added later
 * silently free for everyone.
 *
 * REDIS KEYS
 * ──────────
 * v1:ai:daily:{userId}:{YYYY-MM-DD}     → daily request counter (TTL: 25h)
 * v1:ai:lock:{userId}                   → concurrent request lock (TTL: 60s)
 *
 * USAGE
 * ──────
 * const ctx = { userId, subscriptionPlan, feature };
 * await quota.checkAndIncrement(ctx);  // throws if quota exceeded or Redis down
 * // ... call AI provider ...
 * await quota.recordUsage({ ...ctx, modelId, tokensUsed, succeeded });
 */

import { withRedisCritical, withRedis } from "./redis";
import { eq, and, desc } from "drizzle-orm";
import {
  db,
  pool,
  usersTable,
  studentSubscriptionsTable,
  type AITask,
} from "@workspace/db";
import type { AIFeature } from "./ai";
import { getPlanAllowance } from "./ai-config";
import { logger } from "../lib/logger";
import { subscriptionInForce } from "./entitlements";

// ─── Config ───────────────────────────────────────────────────────────────────

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/** YYYY-MM. The plans are sold by the calendar month, so the counter follows it. */
function monthKeyFor(): string {
  return new Date().toISOString().slice(0, 7);
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QuotaContext {
  userId: number;
  subscriptionPlan: string | null;
  /** Which configured task this call belongs to — the unit limits are set on. */
  task: AITask;
  /** Legacy label kept on the usage log for continuity with older rows. */
  feature?: AIFeature;
}

export interface UsageRecord extends QuotaContext {
  provider: string;
  modelId: string;
  tokensUsed: number;
  promptTokens?: number;
  completionTokens?: number;
  /** Omitted when the provider's token prices have not been entered. */
  costUsd?: number;
  succeeded: boolean;
  requestId?: string;
  /** Logged, not stored — there is no column for it, and it is a debugging aid. */
  latencyMs?: number;
}

// ─── Which plan's limits apply ────────────────────────────────────────────────

/**
 * The plan whose AI limits apply to this user.
 *
 * An administrator is held to the `admin` policy whatever they subscribe to.
 * That row has always existed — unlimited, so staff can check the AI features
 * of the lessons they build — but nothing ever selected it: the plan came only
 * from the subscription, so an admin walking a lesson was treated as `free`
 * (or as whatever test subscription they held) and every recording they made
 * was refused with "not included in your plan", read-aloud and speaking alike.
 *
 * Everyone else gets their newest active subscription, or `free`.
 *
 * One copy of this used to live in each place that called the AI, and they had
 * all made the same omission.
 */
export async function resolvePlanCode(userId: number): Promise<string> {
  const [user] = await db
    .select({ role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (user?.role === "admin") return "admin";

  const [sub] = await db
    .select({ planCode: studentSubscriptionsTable.planCode })
    .from(studentSubscriptionsTable)
    // In force, not merely `active`. A lapsed paid subscription otherwise kept
    // the paid AI allowance until the hourly sweep flipped its status — AI
    // spend on a plan nobody is paying for.
    .where(subscriptionInForce(userId))
    .orderBy(desc(studentSubscriptionsTable.startedAt))
    .limit(1);
  return sub?.planCode ?? "free";
}

// ─── Quota check ──────────────────────────────────────────────────────────────

/**
 * Check whether the user has quota remaining, then atomically increment
 * the counter if they do.
 *
 * Throws:
 *   - QuotaExceededError if the daily limit is reached
 *   - Error if Redis is unavailable (fail closed)
 */
export async function checkAndIncrement(ctx: QuotaContext): Promise<void> {
  const allowance = await getPlanAllowance(ctx.subscriptionPlan, ctx.task);
  const limit = allowance.daily;

  // -1 means unlimited — used for admin and for tasks deliberately uncapped.
  if (limit < 0 && (allowance.monthly ?? -1) < 0) return;

  if (limit === 0 || allowance.monthly === 0) {
    throw Object.assign(
      new Error("This AI feature is not included in your plan."),
      { status: 403, code: "AI_QUOTA_PLAN_INELIGIBLE" },
    );
  }

  // Counted per task, so a student spending their conversation allowance does
  // not also lose the ability to have a written answer graded.
  const redisKey = `v1:ai:daily:${ctx.userId}:${ctx.task}:${todayKey()}`;

  // Fails closed if Redis unavailable (withRedisCritical throws)
  await withRedisCritical(async (r) => {
    // INCR is atomic — no race condition
    const current = await r.incr(redisKey);

    // Set TTL on first request of the day (25h to handle timezone drift)
    if (current === 1) await r.expire(redisKey, 25 * 3600);

    if (limit >= 0 && current > limit) {
      // Decrement to not count the failed attempt
      await r.decr(redisKey);
      throw Object.assign(
        new Error(
          `Daily limit reached for this feature (${limit} per day on your plan).`,
        ),
        { status: 429, code: "AI_QUOTA_EXCEEDED" },
      );
    }

    // The monthly allowance is the one the plans are sold in, so it is checked
    // second and reported differently: hitting it means the month is spent, not
    // that the student should come back tomorrow.
    if (allowance.monthly != null && allowance.monthly >= 0) {
      const monthKey = `v1:ai:monthly:${ctx.userId}:${ctx.task}:${monthKeyFor()}`;
      const usedThisMonth = await r.incr(monthKey);
      // 32 days covers the longest month plus the timezone drift the daily
      // counter already allows for.
      if (usedThisMonth === 1) await r.expire(monthKey, 32 * 24 * 3600);

      if (usedThisMonth > allowance.monthly) {
        await r.decr(monthKey);
        await r.decr(redisKey);
        throw Object.assign(
          new Error(
            `You have used this month's allowance (${allowance.monthly} on your plan). It resets next month.`,
          ),
          { status: 429, code: "AI_QUOTA_MONTHLY_EXCEEDED" },
        );
      }
    }
  }, "AI quota check");
}

/**
 * Give back an allowance that was claimed but never spent.
 *
 * The quota is deliberately claimed BEFORE the work, so a refusal cannot land
 * after money has already been spent with a provider. The cost of that ordering
 * is that a failure which spends nothing still consumes the allowance — and on
 * a plan with two peer-call analyses a day, two failed attempts left the student
 * locked out until tomorrow having received nothing at all.
 *
 * So the caller refunds when it knows no provider was ever billed: audio that
 * could not be read, a recording with only one voice in it, a transcript too
 * thin to analyse.
 *
 * Best-effort on purpose. A refund that fails must not turn a handled failure
 * into an unhandled one, and under-refunding is the safe direction: the student
 * loses an attempt, rather than the budget losing its ceiling.
 */
export async function refundQuota(ctx: QuotaContext): Promise<void> {
  try {
    await withRedisCritical(async (r) => {
      const dailyKey = `v1:ai:daily:${ctx.userId}:${ctx.task}:${todayKey()}`;
      const monthKey = `v1:ai:monthly:${ctx.userId}:${ctx.task}:${monthKeyFor()}`;
      // Floor at zero: a refund must never hand out a credit, which is what a
      // negative counter would be.
      for (const key of [dailyKey, monthKey]) {
        const current = await r.decr(key);
        if (current < 0) await r.set(key, "0");
      }
    }, "AI quota refund");
  } catch (err) {
    logger.warn({ err, task: ctx.task, userId: ctx.userId }, "Could not refund AI quota");
  }
}

/**
 * Get current daily usage for a user. Returns null if Redis is unavailable.
 * Used for displaying quota info in the API without enforcing limits.
 */
export async function getDailyUsage(
  userId: number,
  task: AITask,
): Promise<{ used: number; limit: number } | null> {
  return withRedis(async (r) => {
    const key = `v1:ai:daily:${userId}:${task}:${todayKey()}`;
    const raw = await r.get(key);
    return { used: parseInt(raw ?? "0", 10), limit: 0 }; // limit filled by caller
  }, null);
}

// ─── Usage persistence ────────────────────────────────────────────────────────

/**
 * Persist an AI usage record to PostgreSQL for billing and audit.
 * Called after the AI request completes (success or failure).
 * Non-blocking — logged on error but never throws.
 */
export async function recordUsage(record: UsageRecord): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO ai_usage_logs
         (user_id, feature, task, provider, model_id,
          tokens_used, prompt_tokens, completion_tokens,
          cost_usd, succeeded, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        record.userId,
        record.feature ?? record.task,
        record.task,
        record.provider,
        record.modelId,
        record.tokensUsed,
        record.promptTokens ?? null,
        record.completionTokens ?? null,
        record.costUsd ?? null,
        record.succeeded,
        record.requestId ?? null,
      ],
    );
  } catch (err) {
    // Log but never let a logging failure affect the user experience
    logger.error({ err, userId: record.userId, task: record.task }, "Failed to persist AI usage record");
  }
}

// ─── Distributed lock (for concurrent request control) ───────────────────────

/**
 * Acquire a per-user lock to prevent concurrent AI requests.
 * Returns true if the lock was acquired; false if another request is in flight.
 * Lock auto-expires after 60 seconds.
 */
export async function acquireLock(userId: number): Promise<boolean> {
  return withRedis(async (r) => {
    const key = `v1:ai:lock:${userId}`;
    // SET NX EX: set only if not exists, with 60s expiry
    const result = await r.set(key, "1", "EX", 60, "NX");
    return result === "OK";
  }, true); // fail open: if Redis is down, allow the request
}

export async function releaseLock(userId: number): Promise<void> {
  await withRedis(async (r) => {
    await r.del(`v1:ai:lock:${userId}`);
    return null;
  }, null);
}
