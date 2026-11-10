import { describe, it, expect } from "vitest";
import { rateChangeIsPlausible } from "./syp-rate-policy";

describe("rateChangeIsPlausible", () => {
  it("accepts any first rate", () => {
    expect(rateChangeIsPlausible(null, 130)).toBe(true);
  });

  it("accepts an ordinary move", () => {
    expect(rateChangeIsPlausible(130, 140)).toBe(true);
    expect(rateChangeIsPlausible(130, 120)).toBe(true);
  });

  it("accepts up to halving and doubling", () => {
    expect(rateChangeIsPlausible(130, 65)).toBe(true);
    expect(rateChangeIsPlausible(130, 260)).toBe(true);
  });

  it("refuses a switch between old and new pounds", () => {
    expect(rateChangeIsPlausible(130, 1.3)).toBe(false);
    expect(rateChangeIsPlausible(1.3, 130)).toBe(false);
  });

  it("refuses a sudden collapse", () => {
    expect(rateChangeIsPlausible(130, 13)).toBe(false);
  });
});
import {
  parseSpTodayRate,
  rateInUnit,
  priceFromRate,
  effectivePriceSyp,
  OLD_PER_NEW,
} from "./syp-rate-policy";

/** The shape SP Today's /currencies returns, as the code that calls it reads it. */
function body(sell: unknown, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      rates: [
        { code: "EUR", cities: { damascus: { buy: 15000, sell: 15100 } } },
        {
          code: "USD",
          cities: { damascus: { buy: 13800, sell }, aleppo: { buy: 13900, sell: 14000 } },
          updated_at: "2026-11-06T09:00:00Z",
          ...extra,
        },
      ],
    },
  };
}

describe("parseSpTodayRate", () => {
  it("reads the USD sell rate for Damascus", () => {
    const parsed = parseSpTodayRate(body(13850));
    expect(parsed?.rateOld).toBe(13850);
    expect(parsed?.sourceUpdatedAt?.toISOString()).toBe("2026-11-06T09:00:00.000Z");
  });

  it("reads another city when asked", () => {
    expect(parseSpTodayRate(body(13850), "aleppo")?.rateOld).toBe(14000);
  });

  it("accepts the list under data.currencies as well as data.rates", () => {
    // The two names appear in different parts of SP Today's own material;
    // both are read rather than betting on one.
    const alt = { ok: true, data: { currencies: body(13850).data.rates } };
    expect(parseSpTodayRate(alt)?.rateOld).toBe(13850);
  });

  it("returns null rather than a guess on a broken feed", () => {
    // A null keeps the last good rate. A wrong rate would mis-price every plan.
    expect(parseSpTodayRate(body(0))).toBeNull();
    expect(parseSpTodayRate(body(-5))).toBeNull();
    expect(parseSpTodayRate(body("n/a"))).toBeNull();
    expect(parseSpTodayRate({ ok: false })).toBeNull();
    expect(parseSpTodayRate({ ok: true, data: { rates: [] } })).toBeNull();
    expect(parseSpTodayRate(null)).toBeNull();
    expect(parseSpTodayRate("<html>")).toBeNull();
  });

  it("does not take the EUR rate when USD is missing", () => {
    const noUsd = { ok: true, data: { rates: [body(1).data.rates[0]] } };
    expect(parseSpTodayRate(noUsd)).toBeNull();
  });
});

describe("old and new pounds", () => {
  it("uses the official redenomination ratio", () => {
    expect(OLD_PER_NEW).toBe(100);
  });

  it("converts SP Today's old-pound figure to new pounds", () => {
    // Getting this wrong asks a student for a hundredth of the price, or a
    // hundred times it.
    expect(rateInUnit(13850, "new")).toBeCloseTo(138.5);
  });

  it("leaves it alone when prices are in old pounds", () => {
    expect(rateInUnit(13850, "old")).toBe(13850);
  });
});

describe("priceFromRate", () => {
  it("multiplies and rounds UP to a whole pound", () => {
    // $2 at 138.5 is 277 exactly; $5 at 138.55 is 692.75, charged as 693 so
    // the amount received is never short of the dollar price.
    expect(priceFromRate(2, 138.5)).toBe(277);
    expect(priceFromRate(5, 138.55)).toBe(693);
  });

  it("refuses nonsense inputs", () => {
    expect(priceFromRate(0, 138.5)).toBeNull();
    expect(priceFromRate(2, 0)).toBeNull();
    expect(priceFromRate(2, Number.NaN)).toBeNull();
  });
});

describe("effectivePriceSyp — which figure a student is charged", () => {
  it("uses the admin's figure when automatic pricing is off", () => {
    expect(effectivePriceSyp({ auto: false, rate: 138.5, priceUsd: 2, manualPriceSyp: 300 })).toBe(300);
  });

  it("uses the rate when automatic pricing is on", () => {
    expect(effectivePriceSyp({ auto: true, rate: 138.5, priceUsd: 2, manualPriceSyp: 300 })).toBe(277);
  });

  it("falls back to the admin's figure when on but no rate was ever fetched", () => {
    // Turning the switch on must never take a plan off sale that was selling.
    expect(effectivePriceSyp({ auto: true, rate: null, priceUsd: 2, manualPriceSyp: 300 })).toBe(300);
  });

  it("has no price when neither a rate nor a manual figure exists", () => {
    expect(effectivePriceSyp({ auto: true, rate: null, priceUsd: 2, manualPriceSyp: null })).toBeNull();
    expect(effectivePriceSyp({ auto: false, rate: 138.5, priceUsd: 2, manualPriceSyp: null })).toBeNull();
  });
});
