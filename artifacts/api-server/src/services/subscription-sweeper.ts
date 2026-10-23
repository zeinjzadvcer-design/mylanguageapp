/**
 * Subscription Expiry Sweeper
 *
 * Marks active subscriptions whose expiry has passed.
 *
 * This is bookkeeping, not enforcement. services/entitlements.ts filters on
 * `expiresAt` directly, so a subscription stops opening lessons the moment it
 * expires whether or not this has run. What the sweep fixes is the stored
 * status: without it an expired subscription still reads 'active' on the admin
 * screens, in reporting, and on the student's own subscription page — telling
 * them they have access they no longer have.
 *
 * Hourly rather than by the minute for that reason: nothing is gated on it, so
 * the cost of being an hour behind is a slightly stale label.
 */

import { logger } from "../lib/logger";
import { expireSubscriptions } from "./subscription-activation";

const INTERVAL_MS = parseInt(process.env.SUBSCRIPTION_SWEEP_INTERVAL_MS ?? "3600000", 10);

let timer: NodeJS.Timeout | null = null;

/**
 * Start sweeping on an interval.
 *
 * With more than one API instance every instance sweeps, which is wasteful but
 * harmless: the UPDATE filters on `status = 'active'`, so whichever runs first
 * takes the rows and the others match nothing.
 */
export function startSubscriptionSweeper(): void {
  if (timer) return;
  if (process.env.SUBSCRIPTION_SWEEP_ENABLED === "false") {
    logger.info("Subscription sweeper disabled by configuration");
    return;
  }

  // Once at startup as well as on the interval: a process that restarts more
  // often than the interval would otherwise never sweep at all.
  void expireSubscriptions().catch((err) => {
    logger.error({ err }, "Subscription expiry sweep failed");
  });

  timer = setInterval(() => {
    void expireSubscriptions().catch((err) => {
      logger.error({ err }, "Subscription expiry sweep failed");
    });
  }, INTERVAL_MS);

  // Do not hold the process open for the timer alone.
  timer.unref?.();

  logger.info({ intervalMs: INTERVAL_MS }, "Subscription sweeper started");
}

export function stopSubscriptionSweeper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
