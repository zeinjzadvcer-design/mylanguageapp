/**
 * USDT (BEP-20) payment configuration.
 *
 * Only how the chain is READ lives here. The receiving address used to as well,
 * as deploy configuration, on the reasoning that nothing reviews a crypto
 * payment — so anyone able to change the address could have every later payment
 * confirmed into their own wallet. It is now admin-editable (migration 027),
 * by decision, and three things narrow that exposure instead: changes are
 * attributed and shown on the admin screen, the address is validated on save,
 * and each submission snapshots the address it is checked against so a change
 * cannot redirect a payment already in flight.
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
  /** RPC endpoints, primary first. Defaults to BNB Chain's public nodes. */
  rpcUrls: string[];
  confirmations: number;
  /** Fractional tolerance on the expected amount, e.g. 0.02 for 2%. */
  amountTolerance: number;
  /** How old a transaction may be and still buy a subscription. */
  maxAgeDays: number;
}

/**
 * Read and validate the chain-reading configuration.
 *
 * The receiving address is no longer here. It moved to payment_settings so an
 * admin can set it (migration 027); whether crypto is offered at all now
 * follows from whether an address or a QR is set there, not from an env flag.
 * What stays in env is how the chain is read, which has safe defaults.
 *
 * Throws on a malformed value rather than running with it: a confirmation
 * count of zero would credit transfers a reorg can still undo.
 */
export function loadCryptoConfig(env: NodeJS.ProcessEnv = process.env): CryptoConfig {
  // Public endpoints are flaky; a fallback is configuration, not luxury.
  const rpcUrls = [
    env.BSC_RPC_URL || "https://bsc-dataseed.binance.org",
    env.BSC_RPC_URL_FALLBACK || "https://bsc-dataseed1.defibit.io",
  ]
    .map((u) => u.trim())
    .filter((u) => u.length > 0);

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
    rpcUrls,
    confirmations,
    amountTolerance: tolerancePct / 100,
    maxAgeDays,
  };
}

export type AddressCheck =
  | { ok: true; address: string }
  | { ok: false; error: "tron_address" | "malformed" };

/**
 * Validate and normalise a receiving address an admin typed.
 *
 * Lowercased once, here: log topics arrive lowercased and a pasted address may
 * be EIP-55 checksummed, so comparing them raw would never match.
 *
 * A TRON address gets its own refusal. It is the likeliest wrong paste — USDT
 * is most often held on TRC-20 — and a T… address saved here would make every
 * BEP-20 payment fail verification while looking entirely plausible.
 */
export function checkWalletAddress(raw: string): AddressCheck {
  const trimmed = raw.trim();
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(trimmed)) return { ok: false, error: "tron_address" };
  if (!ADDRESS_RE.test(trimmed)) return { ok: false, error: "malformed" };
  return { ok: true, address: trimmed.toLowerCase() };
}

let cached: CryptoConfig | null = null;

/** The process-wide configuration, validated once. */
export function cryptoConfig(): CryptoConfig {
  if (!cached) {
    cached = loadCryptoConfig();
    logger.info(
      { rpcCount: cached.rpcUrls.length, confirmations: cached.confirmations },
      "USDT (BEP-20) chain reader configured",
    );
  }
  return cached;
}

/** Test seam — forget the cached config. */
export function resetCryptoConfig(): void {
  cached = null;
}
