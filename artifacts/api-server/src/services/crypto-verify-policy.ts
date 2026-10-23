/**
 * On-chain payment verification — the rules, with no network behind them.
 *
 * Split from crypto-verify.ts for the same reason entitlement-policy.ts is
 * split from entitlements.ts: these decisions are what let a payment buy a
 * subscription, and they should be covered by tests that run anywhere rather
 * than needing a live RPC endpoint and a real transaction.
 */

import {
  USDT_BSC_CONTRACT,
  USDT_BSC_DECIMALS,
  TRANSFER_TOPIC,
} from "./crypto-config";

/** One entry from `eth_getTransactionReceipt`. */
export interface RpcLog {
  address: string;
  topics: string[];
  data: string;
}

export interface RpcReceipt {
  status: string;
  blockNumber: string;
  logs: RpcLog[];
  from?: string;
}

/** Why a transaction did not buy a subscription. `null` means it did. */
export type VerifyFailure =
  | "tx_not_found"
  | "tx_failed"
  | "insufficient_confirmations"
  | "no_matching_transfer"
  | "amount_too_low"
  | "tx_too_old";

export interface VerifyInput {
  receipt: RpcReceipt;
  currentBlock: number;
  /** The wallet we expect to have been paid. Lowercased. */
  walletAddress: string;
  /** What the plan costs, in whole USDT. */
  amountExpected: number;
  confirmations: number;
  /** Fractional tolerance, e.g. 0.02 for 2%. */
  amountTolerance: number;
}

export interface VerifyResult {
  ok: boolean;
  failure: VerifyFailure | null;
  /** Base units actually transferred to our wallet across all matching logs. */
  amountRaw: bigint;
  /** The same amount as a decimal string, for storage and display. */
  amountUsdt: string;
  senderAddress: string | null;
  confirmationsSeen: number;
  /** Everything the check saw, stored so an admin is not guessing later. */
  detail: Record<string, unknown>;
}

/**
 * A 32-byte log topic holds a 20-byte address right-aligned and zero-padded.
 * Take the last 40 hex characters, not a fixed offset, so a topic written
 * without the 0x prefix still parses.
 */
export function topicToAddress(topic: string): string {
  const hex = topic.startsWith("0x") ? topic.slice(2) : topic;
  return `0x${hex.slice(-40)}`.toLowerCase();
}

/** Parse a hex quantity. Always BigInt — 10^18 exceeds Number.MAX_SAFE_INTEGER. */
export function hexToBigInt(hex: string): bigint {
  if (!hex || hex === "0x") return 0n;
  return BigInt(hex.startsWith("0x") ? hex : `0x${hex}`);
}

/**
 * Render base units as a decimal string.
 *
 * String arithmetic, never floating point: 2.5 USDT is 2500000000000000000
 * base units, and converting that through a double loses the low digits of
 * every amount it touches.
 */
export function formatUnits(raw: bigint, decimals: bigint = USDT_BSC_DECIMALS): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const divisor = 10n ** decimals;
  const whole = abs / divisor;
  const fraction = abs % divisor;

  if (fraction === 0n) return `${negative ? "-" : ""}${whole}`;

  const fractionStr = fraction.toString().padStart(Number(decimals), "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}.${fractionStr}`;
}

/**
 * Convert a plan price to base units.
 *
 * `amount` is accepted as a string wherever the caller has one, because a
 * double cannot hold most decimal prices exactly: `(2.01).toFixed(18)` is
 * "2.009999999999999787", and feeding that through would under-count the
 * payment by a hair on every single transaction.
 *
 * When a number is unavoidable it is normalised through `toPrecision(15)`
 * first, which is inside a double's honest precision and rounds the
 * representation error away before any digits are read.
 */
export function usdtToBaseUnits(
  amount: number | string,
  decimals: bigint = USDT_BSC_DECIMALS,
): bigint {
  const text =
    typeof amount === "string"
      ? amount.trim()
      : // 15 significant digits is the most a double represents reliably;
        // past that the error itself starts being printed.
        Number.parseFloat(amount.toPrecision(15)).toString();

  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;

  const [whole = "0", fractionRaw = ""] = unsigned.split(".");

  // Truncate rather than round: crediting a fraction of a base unit that was
  // never sent is the wrong direction to be wrong in.
  const fraction = fractionRaw.padEnd(Number(decimals), "0").slice(0, Number(decimals));

  const value = BigInt(whole || "0") * 10n ** decimals + BigInt(fraction || "0");
  return negative ? -value : value;
}

/**
 * Decide whether a transaction paid for a subscription.
 *
 * Every condition must hold. The order matters only for which reason is
 * reported — a failed transaction is more useful to a student than "no
 * matching transfer", which is what they would otherwise be told.
 */
export function verifyTransfer(input: VerifyInput): VerifyResult {
  const {
    receipt,
    currentBlock,
    walletAddress,
    amountExpected,
    confirmations,
    amountTolerance,
  } = input;

  const wallet = walletAddress.toLowerCase();
  const blockNumber = Number(hexToBigInt(receipt.blockNumber));
  const confirmationsSeen = Math.max(0, currentBlock - blockNumber + 1);

  const base = {
    amountRaw: 0n,
    amountUsdt: "0",
    senderAddress: null as string | null,
    confirmationsSeen,
  };

  // `status: 0x1` is success. A reverted transfer moved nothing, however real
  // the transaction hash is.
  if (hexToBigInt(receipt.status) !== 1n) {
    return {
      ...base,
      ok: false,
      failure: "tx_failed",
      detail: { reason: "transaction reverted", blockNumber },
    };
  }

  // Success is not finality. BSC has reorgs, and a transfer that is undone
  // after we activated is a subscription nobody paid for.
  if (confirmationsSeen < confirmations) {
    return {
      ...base,
      ok: false,
      failure: "insufficient_confirmations",
      detail: { blockNumber, currentBlock, confirmationsSeen, required: confirmations },
    };
  }

  // Sum every matching Transfer in the receipt. One transaction can carry more
  // than one — a batching contract, or a wallet that splits — and crediting
  // only the first would under-count a payment that did arrive in full.
  let total = 0n;
  let sender: string | null = null;
  let sawUsdtLog = false;

  for (const log of receipt.logs) {
    // The contract check is what stops a lookalike token buying a
    // subscription. Checked before anything else about the log.
    if (log.address.toLowerCase() !== USDT_BSC_CONTRACT) continue;
    sawUsdtLog = true;

    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.topics.length < 3) continue;

    // topics[1] is `from`, topics[2] is `to`. Our wallet must be the
    // recipient — paying ourselves from our own wallet is not a payment.
    if (topicToAddress(log.topics[2]) !== wallet) continue;

    total += hexToBigInt(log.data);
    sender ??= topicToAddress(log.topics[1]);
  }

  if (total === 0n) {
    return {
      ...base,
      ok: false,
      failure: "no_matching_transfer",
      detail: {
        reason: sawUsdtLog
          ? "USDT transfers present but none to our wallet"
          : "no USDT (BEP-20) transfer in this transaction",
        expectedWallet: wallet,
        expectedContract: USDT_BSC_CONTRACT,
        logCount: receipt.logs.length,
      },
    };
  }

  // The student types the amount by hand, so a few cents short is ordinary.
  // Tolerance is applied to the expected amount, in base units, so no float
  // comparison decides whether someone paid.
  const expectedRaw = usdtToBaseUnits(amountExpected);
  const toleranceRaw =
    (expectedRaw * BigInt(Math.round(amountTolerance * 10_000))) / 10_000n;
  const minimumRaw = expectedRaw - toleranceRaw;

  const observed = {
    amountRaw: total,
    amountUsdt: formatUnits(total),
    senderAddress: sender,
    confirmationsSeen,
  };

  if (total < minimumRaw) {
    return {
      ...observed,
      ok: false,
      failure: "amount_too_low",
      detail: {
        expected: amountExpected.toFixed(2),
        minimumAccepted: formatUnits(minimumRaw),
        observed: formatUnits(total),
      },
    };
  }

  // Overpayment is accepted and the difference is not credited. Stated on the
  // payment page; refusing it would strand money that genuinely arrived.
  return {
    ...observed,
    ok: true,
    failure: null,
    detail: {
      expected: amountExpected.toFixed(2),
      observed: formatUnits(total),
      overpaid: total > expectedRaw ? formatUnits(total - expectedRaw) : null,
      confirmationsSeen,
      contract: USDT_BSC_CONTRACT,
      wallet,
    },
  };
}

/** A 32-byte transaction hash. */
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

export function isValidTxHash(value: string): boolean {
  return TX_HASH_RE.test(value.trim());
}
