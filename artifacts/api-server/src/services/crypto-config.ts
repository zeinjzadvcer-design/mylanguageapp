/**
 * USDT (BEP-20) payment configuration.
 *
 * WHY THE WALLET ADDRESS IS ENV AND NOT ADMIN-EDITABLE
 * ────────────────────────────────────────────────────
 * This address is the trust anchor of the automated path. A payment to it is
 * verified on-chain and activates a subscription with no human in the loop, so
 * anyone who could change it would have every subsequent payment confirmed
 * into their own wallet — and nothing would look broken. The verifier would
 * keep reporting success, because the transfers really did arrive at the
 * configured address. It would surface at reconciliation, days later, with the
 * money gone.
 *
 * The ShamCash QR is admin-editable precisely because that path has a human
 * reading every receipt, who would notice an unfamiliar account name. Here
 * there is no such review, so changing the address requires deploy access.
 *
 * The admin UI may DISPLAY this value read-only — an admin needs to confirm
 * what students are being shown — but nothing writes it.
 */

import { logger } from "../lib/logger";

/**
 * The official USDT contract on BNB Smart Chain.
 *
 * Checked on every transfer, not just the recipient and amount. Scammers
 * deploy tokens on BSC with the symbol "USDT" and Tether's logo; verifying
 * only "2.00 USDT arrived at our address" would activate a subscription paid
 * in a worthless lookalike. The contract address is the only reliable identity.
 */
export const USDT_BSC_CONTRACT = "0x55d398326f99059ff775485246999027b3197955";

/**
 * BEP-20 USDT carries EIGHTEEN decimals.
 *
 * TRC-20 and ERC-20 USDT use six. Reading a BEP-20 amount with six would
 * misread $2.00 by a factor of 10^12. Hardcoded rather than read from the
 * contract: a value this consequential should not depend on an RPC call that
 * can fail or be answered by the wrong chain.
 */
export const USDT_BSC_DECIMALS = 18n;

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** BNB Smart Chain mainnet. */
export const BSC_CHAIN_ID = 56;

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export interface CryptoConfig {
  enabled: boolean;
  /** Lowercased. EVM addresses are case-insensitive bar the EIP-55 checksum. */
  walletAddress: string;
  rpcUrls: string[];
  confirmations: number;
  /** Fractional tolerance on the expected amount, e.g. 0.02 for 2%. */
  amountTolerance: number;
  /** How old a transaction may be and still buy a subscription. */
  maxAgeDays: number;
}

/**
 * Read and validate the configuration.
 *
 * Throws rather than returning a broken config when crypto is switched on but
 * misconfigured. A malformed address that merely fails every comparison would
 * reject legitimate payments silently; failing at boot is louder and cheaper.
 */
export function loadCryptoConfig(env: NodeJS.ProcessEnv = process.env): CryptoConfig {
  const enabled = env.CRYPTO_PAYMENTS_ENABLED === "true";

  const rawAddress = (env.BSC_USDT_WALLET_ADDRESS ?? "").trim();

  if (!enabled) {
    return {
      enabled: false,
      walletAddress: rawAddress.toLowerCase(),
      rpcUrls: [],
      confirmations: 0,
      amountTolerance: 0,
      maxAgeDays: 0,
    };
  }

  if (!ADDRESS_RE.test(rawAddress)) {
    throw new Error(
      "BSC_USDT_WALLET_ADDRESS must be a 0x-prefixed 40-hex-character address " +
        "when CRYPTO_PAYMENTS_ENABLED=true. Refusing to start: an unset or " +
        "malformed address would reject every legitimate payment.",
    );
  }

  // Public endpoints are flaky; a fallback is configuration, not luxury.
  const rpcUrls = [env.BSC_RPC_URL, env.BSC_RPC_URL_FALLBACK]
    .map((u) => (u ?? "").trim())
    .filter((u) => u.length > 0);

  if (rpcUrls.length === 0) {
    throw new Error(
      "BSC_RPC_URL must be set when CRYPTO_PAYMENTS_ENABLED=true.",
    );
  }

  const confirmations = parseInt(env.BSC_CONFIRMATIONS ?? "15", 10);
  const tolerancePct = parseFloat(env.CRYPTO_AMOUNT_TOLERANCE_PCT ?? "2");
  const maxAgeDays = parseInt(env.CRYPTO_TXID_MAX_AGE_DAYS ?? "7", 10);

  if (!Number.isFinite(confirmations) || confirmations < 1) {
    throw new Error("BSC_CONFIRMATIONS must be a positive integer.");
  }
  if (!Number.isFinite(tolerancePct) || tolerancePct < 0 || tolerancePct > 50) {
    throw new Error("CRYPTO_AMOUNT_TOLERANCE_PCT must be between 0 and 50.");
  }
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 1) {
    throw new Error("CRYPTO_TXID_MAX_AGE_DAYS must be a positive integer.");
  }

  return {
    enabled: true,
    // Lowercased once, here. A log topic arrives lowercased and an env value
    // may be EIP-55 checksummed; comparing them raw would never match.
    walletAddress: rawAddress.toLowerCase(),
    rpcUrls,
    confirmations,
    amountTolerance: tolerancePct / 100,
    maxAgeDays,
  };
}

let cached: CryptoConfig | null = null;

/** The process-wide configuration, validated once. */
export function cryptoConfig(): CryptoConfig {
  if (!cached) {
    cached = loadCryptoConfig();
    if (cached.enabled) {
      logger.info(
        {
          wallet: cached.walletAddress,
          rpcCount: cached.rpcUrls.length,
          confirmations: cached.confirmations,
        },
        "USDT (BEP-20) payments enabled",
      );
    } else {
      logger.info("USDT (BEP-20) payments disabled");
    }
  }
  return cached;
}

/** Test seam — forget the cached config. */
export function resetCryptoConfig(): void {
  cached = null;
}
