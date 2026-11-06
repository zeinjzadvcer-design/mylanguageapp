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

import { eq } from "drizzle-orm";
import { db, paymentSettingsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { invalidate, CK } from "./cache";
import { SETTINGS_ROW_ID } from "./payment-settings";
import {
  parseSpTodayRate,
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
  const config = await getPricingConfig();
  if (!config.auto || !sptodayConfigured()) return;
  const age = config.fetchedAt ? Date.now() - config.fetchedAt.getTime() : Infinity;
  if (age < RATE_REFRESH_MS) return;
  await refreshSypRate();
}
