/**
 * The automatic Syrian pound rate, from SP Today (الليرة اليوم).
 *
 * Fetched on a timer and stored, never per request: the free tier allows 100
 * calls a month, so the rate is refreshed every twelve hours (about sixty calls)
 * and every price is computed from the stored figure.
 *
 * The API key is deploy configuration (SPTODAY_API_KEY), not an admin setting:
 * it is a credential, and the admin screen only needs to know whether one
 * exists. Without it the switch can still be turned on, but nothing is fetched
 * and prices fall back to the admin's manual figures.
 */

import { and, eq, sql } from "drizzle-orm";
import { db, paymentSettingsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { invalidate, CK } from "./cache";
import { SETTINGS_ROW_ID } from "./payment-settings";
import {
  parseSpTodayRate,
  rateChangeIsPlausible,
  rateInUnit,
  effectivePriceSyp,
  type SypUnit,
} from "./syp-rate-policy";

const SPTODAY_URL =
  process.env.SPTODAY_API_URL ?? "https://api-v2.sp-today.com/api/v1/currencies?lang=en";
const SPTODAY_CITY = process.env.SPTODAY_CITY ?? "damascus";
const FETCH_TIMEOUT_MS = 15_000;

/** Twelve hours: about sixty calls a month against a quota of a hundred. */
export const RATE_REFRESH_MS = parseInt(
  process.env.SYP_RATE_REFRESH_MS ?? String(12 * 3600_000),
  10,
);

export function sptodayConfigured(): boolean {
  return Boolean(process.env.SPTODAY_API_KEY?.trim());
}

export interface PricingConfig {
  auto: boolean;
  unit: SypUnit;
  /** SYP per USD in `unit`, or null when none has been fetched. */
  rate: number | null;
  fetchedAt: Date | null;
  sourceUpdatedAt: Date | null;
  error: string | null;
}

export async function getPricingConfig(): Promise<PricingConfig> {
  const [row] = await db
    .select({
      auto: paymentSettingsTable.sypRateAuto,
      unit: paymentSettingsTable.sypUnit,
      rate: paymentSettingsTable.sypRate,
      fetchedAt: paymentSettingsTable.sypRateFetchedAt,
      sourceUpdatedAt: paymentSettingsTable.sypRateSourceUpdatedAt,
      error: paymentSettingsTable.sypRateError,
    })
    .from(paymentSettingsTable)
    .where(eq(paymentSettingsTable.id, SETTINGS_ROW_ID))
    .limit(1);

  return {
    auto: row?.auto ?? false,
    unit: row?.unit === "old" ? "old" : "new",
    rate: row?.rate != null ? Number(row.rate) : null,
    fetchedAt: row?.fetchedAt ?? null,
    sourceUpdatedAt: row?.sourceUpdatedAt ?? null,
    error: row?.error ?? null,
  };
}

/** A plan's SYP price under the current pricing config. */
export function priceSypFor(
  config: PricingConfig,
  priceUsd: number,
  manualPriceSyp: string | number | null,
): number | null {
  return effectivePriceSyp({
    auto: config.auto,
    rate: config.rate,
    priceUsd,
    manualPriceSyp: manualPriceSyp == null ? null : Number(manualPriceSyp),
  });
}

export type RefreshOutcome =
  | { ok: true; rate: number }
  | { ok: false; error: string };

/**
 * Fetch the rate and store it.
 *
 * On failure the previous rate is KEPT and the error recorded beside it. A
 * stale rate is a little out; no rate, or a wrong one, mis-prices every plan.
 */
export async function refreshSypRate(): Promise<RefreshOutcome> {
  const key = process.env.SPTODAY_API_KEY?.trim();
  if (!key) return record({ ok: false, error: "SPTODAY_API_KEY is not set" });

  // Stamped here too, so a manual refresh also resets the scheduler's interval
  // rather than being followed by a second call on the next tick.
  await db
    .update(paymentSettingsTable)
    .set({ sypRateAttemptedAt: new Date() })
    .where(eq(paymentSettingsTable.id, SETTINGS_ROW_ID));

  const config = await getPricingConfig();

  let body: unknown;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(SPTODAY_URL, {
        headers: { "X-API-Key": key, Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) return record({ ok: false, error: `SP Today answered HTTP ${res.status}` });
      body = await res.json();
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return record({ ok: false, error: `Could not reach SP Today: ${String(err)}` });
  }

  const parsed = parseSpTodayRate(body, SPTODAY_CITY);
  if (!parsed) {
    return record({ ok: false, error: "SP Today's response had no usable USD rate" });
  }

  const rate = rateInUnit(parsed.rateOld, config.unit);

  // Kept out rather than stored: every plan is priced from this, and payments
  // activate against it with nobody looking. A real move this large does
  // happen, so a person accepts it: switching automatic pricing off and on
  // again clears the last rate (admin-payments.ts), and the next fetch has
  // nothing to be compared with.
  if (!rateChangeIsPlausible(config.rate, rate)) {
    return record({
      ok: false,
      error: `SP Today reported ${rate.toFixed(4)}, against ${config.rate?.toFixed(4)} last time. That jump looks like a broken feed, so the last rate is kept. Check sp-today.com: if the new rate is right, switch automatic pricing off and on again to accept it.`,
    });
  }

  await db
    .update(paymentSettingsTable)
    .set({
      sypRate: rate.toFixed(4),
      sypRateFetchedAt: new Date(),
      sypRateSourceUpdatedAt: parsed.sourceUpdatedAt,
      sypRateError: null,
    })
    .where(eq(paymentSettingsTable.id, SETTINGS_ROW_ID));

  // Plan prices are cached for an hour; a new rate must reach students now.
  await invalidate(CK.subPlans());

  logger.info({ rate, unit: config.unit, rateOld: parsed.rateOld }, "SYP rate refreshed");
  return { ok: true, rate };
}

async function record(outcome: { ok: false; error: string }): Promise<RefreshOutcome> {
  await db
    .update(paymentSettingsTable)
    .set({ sypRateError: outcome.error })
    .where(eq(paymentSettingsTable.id, SETTINGS_ROW_ID));
  logger.warn({ error: outcome.error }, "SYP rate refresh failed; keeping the last rate");
  return outcome;
}

/**
 * Refresh only when automatic pricing is on and the stored rate is due.
 *
 * Called by the sweeper on a timer. Checks the stored timestamp rather than
 * trusting the timer alone, so restarts and multiple instances do not each
 * spend a call from a hundred-a-month quota.
 */
export async function refreshSypRateIfDue(): Promise<void> {
  if (!sptodayConfigured()) return;

  // Claim the slot before fetching, in one conditional UPDATE. Only the
  // instance whose UPDATE matches fetches; every other instance, and every
  // later tick, sees the new timestamp and skips.
  //
  // Measured from the last ATTEMPT, not the last success. Measuring from
  // success retried a failing source every minute, which spent the whole
  // monthly quota in under two hours of outage. A failed fetch therefore
  // waits the full interval too; the last good rate stays in use meanwhile,
  // and an admin can still refresh by hand.
  const claimed = await db
    .update(paymentSettingsTable)
    .set({ sypRateAttemptedAt: new Date() })
    .where(
      and(
        eq(paymentSettingsTable.id, SETTINGS_ROW_ID),
        eq(paymentSettingsTable.sypRateAuto, true),
        // Falls back to the last success for rows from before the column.
        sql`coalesce(${paymentSettingsTable.sypRateAttemptedAt}, ${paymentSettingsTable.sypRateFetchedAt}, '-infinity'::timestamptz)
            <= now() - make_interval(secs => ${RATE_REFRESH_MS / 1000})`,
      ),
    )
    .returning({ id: paymentSettingsTable.id });

  if (claimed.length === 0) return;
  await refreshSypRate();
}
