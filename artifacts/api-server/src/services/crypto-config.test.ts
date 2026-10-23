import { describe, it, expect } from "vitest";
import { loadCryptoConfig, USDT_BSC_CONTRACT, USDT_BSC_DECIMALS } from "./crypto-config";

const valid = {
  CRYPTO_PAYMENTS_ENABLED: "true",
  BSC_USDT_WALLET_ADDRESS: "0x1111111111111111111111111111111111111111",
  BSC_RPC_URL: "https://bsc-dataseed.example",
} as NodeJS.ProcessEnv;

describe("loadCryptoConfig — refuses to start on a bad wallet address", () => {
  it("throws when the address is missing but crypto is enabled", () => {
    // Failing at boot is louder and cheaper than an address that merely fails
    // every comparison and silently rejects legitimate payments.
    expect(() =>
      loadCryptoConfig({ ...valid, BSC_USDT_WALLET_ADDRESS: "" }),
    ).toThrow(/BSC_USDT_WALLET_ADDRESS/);
  });

  it("throws on a truncated address", () => {
    expect(() =>
      loadCryptoConfig({ ...valid, BSC_USDT_WALLET_ADDRESS: "0x1234" }),
    ).toThrow(/BSC_USDT_WALLET_ADDRESS/);
  });

  it("throws on a TRON address, which is the likeliest wrong paste", () => {
    expect(() =>
      loadCryptoConfig({
        ...valid,
        BSC_USDT_WALLET_ADDRESS: "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxbQmo",
      }),
    ).toThrow(/BSC_USDT_WALLET_ADDRESS/);
  });

  it("throws when no RPC endpoint is configured", () => {
    expect(() => loadCryptoConfig({ ...valid, BSC_RPC_URL: "" })).toThrow(
      /BSC_RPC_URL/,
    );
  });
});

describe("loadCryptoConfig — disabled", () => {
  it("does not validate anything when crypto is switched off", () => {
    // A deployment that does not take crypto must boot without the config.
    const config = loadCryptoConfig({ CRYPTO_PAYMENTS_ENABLED: "false" });
    expect(config.enabled).toBe(false);
  });

  it("treats an unset flag as off", () => {
    expect(loadCryptoConfig({}).enabled).toBe(false);
  });
});

describe("loadCryptoConfig — normalisation", () => {
  it("lowercases the wallet address", () => {
    // Compared against log topics, which arrive lowercased. An EIP-55
    // checksummed env value would otherwise never match.
    const config = loadCryptoConfig({
      ...valid,
      BSC_USDT_WALLET_ADDRESS: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(config.walletAddress).toBe("0x" + "a".repeat(40));
  });

  it("keeps a fallback RPC endpoint when one is given", () => {
    const config = loadCryptoConfig({
      ...valid,
      BSC_RPC_URL_FALLBACK: "https://bsc-backup.example",
    });
    expect(config.rpcUrls).toHaveLength(2);
  });

  it("converts the tolerance percentage to a fraction", () => {
    const config = loadCryptoConfig({ ...valid, CRYPTO_AMOUNT_TOLERANCE_PCT: "2" });
    expect(config.amountTolerance).toBeCloseTo(0.02);
  });

  it("rejects an absurd tolerance rather than accepting half price", () => {
    expect(() =>
      loadCryptoConfig({ ...valid, CRYPTO_AMOUNT_TOLERANCE_PCT: "90" }),
    ).toThrow(/CRYPTO_AMOUNT_TOLERANCE_PCT/);
  });

  it("rejects zero confirmations", () => {
    // Accepting an unconfirmed transfer means activating on a transaction a
    // reorg can still undo.
    expect(() => loadCryptoConfig({ ...valid, BSC_CONFIRMATIONS: "0" })).toThrow(
      /BSC_CONFIRMATIONS/,
    );
  });
});

describe("chain constants", () => {
  it("pins the official USDT contract on BSC, lowercased", () => {
    expect(USDT_BSC_CONTRACT).toBe("0x55d398326f99059ff775485246999027b3197955");
    expect(USDT_BSC_CONTRACT).toBe(USDT_BSC_CONTRACT.toLowerCase());
  });

  it("uses 18 decimals, not the 6 that TRC-20 and ERC-20 USDT use", () => {
    expect(USDT_BSC_DECIMALS).toBe(18n);
  });
});
