import { describe, it, expect } from "vitest";
import {
  loadCryptoConfig,
  checkWalletAddress,
  USDT_BSC_CONTRACT,
  USDT_BSC_DECIMALS,
} from "./crypto-config";

describe("loadCryptoConfig — how the chain is read", () => {
  it("has working defaults, so a deployment needs no crypto env at all", () => {
    // The receiving address moved to admin settings; nothing here is
    // required any more, and an unset environment must still boot.
    const config = loadCryptoConfig({});
    expect(config.rpcUrls.length).toBeGreaterThan(0);
    expect(config.confirmations).toBe(15);
    expect(config.amountTolerance).toBeCloseTo(0.02);
    expect(config.maxAgeDays).toBe(7);
  });

  it("keeps a configured fallback RPC endpoint", () => {
    const config = loadCryptoConfig({
      BSC_RPC_URL: "https://primary.example",
      BSC_RPC_URL_FALLBACK: "https://backup.example",
    });
    expect(config.rpcUrls).toEqual(["https://primary.example", "https://backup.example"]);
  });

  it("rejects zero confirmations", () => {
    // Crediting an unconfirmed transfer means activating on a transaction a
    // reorg can still undo.
    expect(() => loadCryptoConfig({ BSC_CONFIRMATIONS: "0" })).toThrow(/BSC_CONFIRMATIONS/);
  });

  it("rejects an absurd tolerance rather than accepting half price", () => {
    expect(() => loadCryptoConfig({ CRYPTO_AMOUNT_TOLERANCE_PCT: "90" })).toThrow(
      /CRYPTO_AMOUNT_TOLERANCE_PCT/,
    );
  });
});

describe("checkWalletAddress — what an admin may save", () => {
  it("accepts a BEP-20 address and lowercases it", () => {
    // Compared against log topics, which arrive lowercased; an EIP-55
    // checksummed paste would otherwise never match.
    const result = checkWalletAddress("0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(result).toEqual({ ok: true, address: "0x" + "a".repeat(40) });
  });

  it("trims a pasted address", () => {
    expect(checkWalletAddress("  0x" + "1".repeat(40) + "\n")).toEqual({
      ok: true,
      address: "0x" + "1".repeat(40),
    });
  });

  it("refuses a TRON address with its own reason", () => {
    // The likeliest wrong paste — USDT is most often held on TRC-20 — and a
    // T… address saved here would make every BEP-20 payment fail verification
    // while looking entirely plausible.
    expect(checkWalletAddress("TN3W4H6rK2ce4vX9YnFQHwKENnHjoxbQmo")).toEqual({
      ok: false,
      error: "tron_address",
    });
  });

  it("refuses a truncated or overlong address", () => {
    expect(checkWalletAddress("0x1234")).toEqual({ ok: false, error: "malformed" });
    expect(checkWalletAddress("0x" + "a".repeat(41))).toEqual({ ok: false, error: "malformed" });
  });

  it("refuses an address with no 0x prefix", () => {
    expect(checkWalletAddress("a".repeat(40))).toEqual({ ok: false, error: "malformed" });
  });
});

describe("chain constants", () => {
  it("pins the official USDT contract on BSC, lowercased", () => {
    expect(USDT_BSC_CONTRACT).toBe("0x55d398326f99059ff775485246999027b3197955");
  });

  it("uses 18 decimals, not the 6 that TRC-20 and ERC-20 USDT use", () => {
    expect(USDT_BSC_DECIMALS).toBe(18n);
  });
});
