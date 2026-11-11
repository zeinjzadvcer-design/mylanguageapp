import { describe, it, expect } from "vitest";
import { fieldChanges, needsPassword } from "./payment-audit-policy";

describe("which payment setting changes need the admin's password", () => {
  it("the crypto address and the crypto QR do", () => {
    expect(needsPassword(["cryptoWalletAddress"])).toBe(true);
    expect(needsPassword(["cryptoQrMediaId"])).toBe(true);
    expect(needsPassword(["sypUnit", "cryptoWalletAddress"])).toBe(true);
  });

  it("prices and the Syriatel Cash details do not", () => {
    expect(needsPassword(["sypRateAuto", "sypUnit", "walletAccountName"])).toBe(false);
    expect(needsPassword([])).toBe(false);
  });
});

describe("what the history records", () => {
  const fields = ["cryptoWalletAddress", "walletAccountName", "sypRateAuto", "priceSyp"];

  it("names the field and the kind of change, never the value", () => {
    const changes = fieldChanges(
      { cryptoWalletAddress: "0xaaa", walletAccountName: null },
      { cryptoWalletAddress: "0xbbb", walletAccountName: "Shop" },
      fields,
    );
    expect(changes).toEqual([
      { field: "cryptoWalletAddress", change: "changed" },
      { field: "walletAccountName", change: "added" },
    ]);
    expect(JSON.stringify(changes)).not.toMatch(/0xaaa|0xbbb|Shop/);
  });

  it("records a removal", () => {
    expect(fieldChanges({ cryptoWalletAddress: "0xaaa" }, { cryptoWalletAddress: null }, fields)).toEqual([
      { field: "cryptoWalletAddress", change: "removed" },
    ]);
  });

  it("does not record a field saved with the value it already had", () => {
    expect(fieldChanges({ cryptoWalletAddress: "0xaaa" }, { cryptoWalletAddress: "0xaaa" }, fields)).toEqual([]);
    expect(fieldChanges({ walletAccountName: null }, { walletAccountName: "" }, fields)).toEqual([]);
    expect(fieldChanges({ priceSyp: "15000.00" }, { priceSyp: "15000.00" }, fields)).toEqual([]);
  });

  it("treats turning a switch off as a change, not a removal", () => {
    expect(fieldChanges({ sypRateAuto: true }, { sypRateAuto: false }, fields)).toEqual([
      { field: "sypRateAuto", change: "changed" },
    ]);
  });

  it("ignores fields that were not sent, and ones it was not asked about", () => {
    expect(fieldChanges({ cryptoWalletAddress: "0xaaa" }, { updatedBy: 3 }, fields)).toEqual([]);
  });

  it("treats a first save on an empty table as additions", () => {
    expect(fieldChanges(undefined, { walletAccountName: "Shop" }, fields)).toEqual([
      { field: "walletAccountName", change: "added" },
    ]);
  });
});
