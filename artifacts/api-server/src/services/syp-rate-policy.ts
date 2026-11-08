/**
 * Syrian pound pricing — the rules, with no network or database behind them.
 *
 * Split from syp-rate.ts for the same reason the other `*-policy.ts` modules
 * are: this arithmetic decides what a student is asked to pay, and it should be
 * covered by tests that run anywhere.
 */

/** 100 old Syrian pounds = 1 new one, the official redenomination ratio. */
export const OLD_PER_NEW = 100;

export type SypUnit = "new" | "old";

export interface ParsedRate {
  /** SYP per USD, in the OLD unit, as SP Today reports it. */
  rateOld: number;
  /** The source's own timestamp for the figure, when it gives one. */
  sourceUpdatedAt: Date | null;
}

/**
 * Pull the USD sell rate for a city out of an SP Today `/currencies` response.
 *
 * The shape is inferred from the code that calls this API rather than from
 * published docs — SP Today's reference page was unreachable — so this reads
 * defensively: the list may be under `data.rates` or `data.currencies`, and
 * anything unexpected yields null rather than a guess. A null is stored as an
 * error and the last good rate is kept, which is the safe failure: a wrong rate
 * would mis-price every plan, while a stale one is merely a little out.
 *
 * The SELL rate, not the buy: it is what someone pays for a dollar, which is
 * the side of the market a student's payment sits on.
 */
export function parseSpTodayRate(body: unknown, city = "damascus"): ParsedRate | null {
  if (!body || typeof body !== "object") return null;
  const envelope = body as { ok?: unknown; data?: unknown };
  if (envelope.ok === false) return null;

  const data = envelope.data as { rates?: unknown; currencies?: unknown } | undefined;
  const list = (Array.isArray(data?.rates) ? data?.rates : data?.currencies) as unknown;
  if (!Array.isArray(list)) return null;

  const usd = list.find(
    (item) => (item as { code?: unknown })?.code?.toString().toUpperCase() === "USD",
  ) as { cities?: Record<string, { sell?: unknown }>; updated_at?: unknown } | undefined;
  if (!usd) return null;

  const rateOld = Number(usd.cities?.[city]?.sell);
  // Bounded on both sides. Zero, negative or absurd values are a broken feed,
  // and multiplying a plan price by one would quote a student nonsense.
  if (!Number.isFinite(rateOld) || rateOld <= 0 || rateOld >= 1_000_000_000) return null;

  const stamp = usd.updated_at ? new Date(String(usd.updated_at)) : null;
  return {
    rateOld,
    sourceUpdatedAt: stamp && !Number.isNaN(stamp.getTime()) ? stamp : null,
  };
}

/** Express an old-pound rate in the unit prices are charged in. */
export function rateInUnit(rateOld: number, unit: SypUnit): number {
  return unit === "new" ? rateOld / OLD_PER_NEW : rateOld;
}

/**
 * A plan's SYP price from its USD price and a rate.
 *
 * Rounded UP to a whole pound. The student pays the figure shown, so it has to
 * be one they can type; rounding up rather than to nearest means the amount
 * received is never short of the dollar price, which is the direction the
 * amount check already tolerates.
 */
export function priceFromRate(priceUsd: number, rate: number): number | null {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return Math.ceil(priceUsd * rate);
}

/**
 * The SYP price actually charged for a plan.
 *
 * Automatic mode uses the stored rate when there is one. If the switch is on
 * but no rate has ever been fetched — no API key yet, or the first fetch failed
 * — it falls back to the admin's manual figure rather than refusing the plan:
 * turning the switch on should never take a plan off sale that was selling.
 */
export function effectivePriceSyp(args: {
  auto: boolean;
  rate: number | null;
  priceUsd: number;
  manualPriceSyp: number | null;
}): number | null {
  const { auto, rate, priceUsd, manualPriceSyp } = args;
  if (auto && rate !== null) {
    const computed = priceFromRate(priceUsd, rate);
    if (computed !== null) return computed;
  }
  return manualPriceSyp;
}
