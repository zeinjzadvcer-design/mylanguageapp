/**
 * USDT (BEP-20) payment verification.
 *
 * The student gives us a transaction hash, which is what makes this path
 * automatable at all: without it we would be matching anonymous incoming
 * transfers to pending orders by amount and timing. With it, verification is a
 * lookup of one known transaction.
 *
 * Reads the chain's own event log over public JSON-RPC rather than an explorer
 * API. BscScan's free tier was retired in December 2025 and BNB Smart Chain is
 * paid-tier only on Etherscan V2 — but the better reason is that a Transfer
 * event is the chain's own record, where an explorer endpoint is that record
 * plus someone else's interpretation of it.
 */

import { and, eq } from "drizzle-orm";
import { db, paymentSubmissionsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { cryptoConfig } from "./crypto-config";
import {
  verifyTransfer,
  type RpcReceipt,
  type VerifyResult,
} from "./crypto-verify-policy";
import { activateSubscription } from "./subscription-activation";

/** How long one RPC call may take before the next endpoint is tried. */
const RPC_TIMEOUT_MS = parseInt(process.env.BSC_RPC_TIMEOUT_MS ?? "10000", 10);

class RpcError extends Error {}

/**
 * Call every configured endpoint in turn until one answers.
 *
 * Public RPC endpoints rate-limit and drop connections, so a single failure is
 * expected traffic rather than an outage. Only when all of them fail does this
 * throw — and that must not be read as "the payment is invalid", which is why
 * the caller keeps such a submission pending rather than rejecting it.
 */
async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const { rpcUrls } = cryptoConfig();
  let lastError: unknown = null;

  for (const url of rpcUrls) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: controller.signal,
        });

        if (!response.ok) throw new RpcError(`HTTP ${response.status}`);

        const body = (await response.json()) as {
          result?: T;
          error?: { message?: string };
        };

        if (body.error) throw new RpcError(body.error.message ?? "RPC error");
        return body.result as T;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      lastError = err;
      logger.warn({ err, url, method }, "BSC RPC call failed, trying next endpoint");
    }
  }

  throw new RpcError(
    `All BSC RPC endpoints failed for ${method}: ${String(lastError)}`,
  );
}

export interface ChainCheck {
  /** False when the chain could not be reached — NOT a failed payment. */
  reachable: boolean;
  result: VerifyResult | null;
  /** Null when the transaction is not on chain at all. */
  found: boolean;
}

/**
 * Look one transaction up and decide whether it paid for `amountExpected`.
 *
 * Two calls: the receipt, and the current block height for the confirmation
 * count. No history search and no indexer — the hash names the transaction.
 */
export async function checkTransaction(
  txHash: string,
  amountExpected: number,
  /**
   * The address that must have received the transfer — the one snapshotted on
   * the submission, not the current setting, so an admin changing the address
   * cannot re-point a payment that is already being checked.
   */
  walletAddress: string,
): Promise<ChainCheck> {
  const config = cryptoConfig();

  try {
    const [receipt, blockHex] = await Promise.all([
      rpcCall<RpcReceipt | null>("eth_getTransactionReceipt", [txHash]),
      rpcCall<string>("eth_blockNumber", []),
    ]);

    // A receipt of null means the node has not seen it: either not yet mined,
    // or never existed. Both are "come back later" rather than "rejected" —
    // the caller retries, and gives up only after a bounded number of tries.
    if (!receipt) {
      return { reachable: true, found: false, result: null };
    }

    const currentBlock = Number(BigInt(blockHex));

    const result = verifyTransfer({
      receipt,
      currentBlock,
      walletAddress,
      amountExpected,
      confirmations: config.confirmations,
      amountTolerance: config.amountTolerance,
    });

    return { reachable: true, found: true, result };
  } catch (err) {
    logger.error({ err, txHash }, "Could not reach BSC to verify a payment");
    return { reachable: false, found: false, result: null };
  }
}

/** How many times a submission is re-checked before a human is asked. */
const MAX_ATTEMPTS = parseInt(process.env.CRYPTO_VERIFY_MAX_ATTEMPTS ?? "8", 10);

/**
 * Verify one submission and act on the answer.
 *
 * Three outcomes, and the difference between them is what keeps this honest:
 *
 *   verified        → activate, no human involved
 *   definitely bad  → leave pending for an admin, with the reason recorded
 *   can't tell yet  → leave pending and retry; the chain may catch up
 *
 * Nothing here rejects a submission outright. A student who mistyped a hash
 * and a student whose transaction is three blocks from confirmed look similar
 * from here, and only one of them deserves a refusal — so the decision goes to
 * an admin, who can see the verification log explaining what was found.
 */
export async function verifySubmission(submissionId: number): Promise<void> {
  const [submission] = await db
    .select()
    .from(paymentSubmissionsTable)
    .where(eq(paymentSubmissionsTable.id, submissionId))
    .limit(1);

  if (!submission || !submission.txHash) return;

  // Paid against a QR with no address configured. There is nothing to compare
  // the recipient against, so the chain cannot confirm this payment was ours —
  // it goes to an admin, who can see the transaction and decide.
  if (!submission.expectedWalletAddress) {
    if (submission.status === "verifying") {
      await db
        .update(paymentSubmissionsTable)
        .set({
          status: "pending",
          verificationLog: {
            lastOutcome: "no_wallet_address",
            needsReview: true,
            note: "No receiving address was configured when this was submitted, so it cannot be verified on chain. Check the transaction by hand.",
          },
        })
        .where(eq(paymentSubmissionsTable.id, submissionId));
    }
    return;
  }

  // Already decided — by an admin, or by an earlier run of this job.
  if (submission.status === "approved" || submission.status === "rejected") return;

  const amountExpected = Number(submission.amountExpected);
  const check = await checkTransaction(
    submission.txHash,
    amountExpected,
    submission.expectedWalletAddress,
  );

  const previousLog = (submission.verificationLog ?? {}) as Record<string, unknown>;
  const attempts = Number(previousLog.attempts ?? 0) + 1;

  // The chain was unreachable. Record the attempt and leave everything else
  // alone: an RPC outage must never look like a bad payment.
  if (!check.reachable) {
    await db
      .update(paymentSubmissionsTable)
      .set({
        verificationLog: {
          ...previousLog,
          attempts,
          lastCheckedAt: new Date().toISOString(),
          lastOutcome: "rpc_unreachable",
        },
      })
      .where(eq(paymentSubmissionsTable.id, submissionId));
    return;
  }

  if (!check.found || !check.result) {
    const exhausted = attempts >= MAX_ATTEMPTS;
    await db
      .update(paymentSubmissionsTable)
      .set({
        // Back to `pending` once we stop retrying, so it surfaces in the admin
        // queue instead of sitting in `verifying` where nobody looks.
        status: exhausted ? "pending" : "verifying",
        verificationLog: {
          ...previousLog,
          attempts,
          lastCheckedAt: new Date().toISOString(),
          lastOutcome: "not_found_on_chain",
          needsReview: exhausted,
          note: exhausted
            ? "This transaction was not found on BNB Smart Chain after repeated checks. It may be on a different network, or the hash may be wrong."
            : "Not seen on chain yet; still checking.",
        },
      })
      .where(eq(paymentSubmissionsTable.id, submissionId));
    return;
  }

  const { result } = check;

  const log = {
    ...previousLog,
    attempts,
    lastCheckedAt: new Date().toISOString(),
    lastOutcome: result.ok ? "verified" : result.failure,
    ...result.detail,
  };

  if (!result.ok) {
    // Only a confirmation shortfall is worth waiting for; everything else is
    // as true now as it will be in ten minutes.
    const retryable = result.failure === "insufficient_confirmations";
    const exhausted = attempts >= MAX_ATTEMPTS;

    await db
      .update(paymentSubmissionsTable)
      .set({
        status: retryable && !exhausted ? "verifying" : "pending",
        amountObserved: result.amountRaw > 0n ? result.amountUsdt : null,
        senderAddress: result.senderAddress,
        verificationLog: { ...log, needsReview: !retryable || exhausted },
      })
      .where(eq(paymentSubmissionsTable.id, submissionId));
    return;
  }

  // Verified. Record what was seen first, so the evidence is stored even if
  // activation then fails for an unrelated reason.
  await db
    .update(paymentSubmissionsTable)
    .set({
      amountObserved: result.amountUsdt,
      senderAddress: result.senderAddress,
      confirmedAt: new Date(),
      verificationLog: log,
    })
    .where(eq(paymentSubmissionsTable.id, submissionId));

  // reviewerId null: nobody approved this, the chain did.
  const outcome = await activateSubscription(submissionId, null);

  if (!outcome.ok) {
    logger.error(
      { submissionId, reason: outcome.reason },
      "On-chain payment verified but activation failed",
    );
    return;
  }

  logger.info(
    {
      submissionId,
      subscriptionId: outcome.subscriptionId,
      amount: result.amountUsdt,
      sender: result.senderAddress,
    },
    "Subscription activated by on-chain verification",
  );
}

/**
 * Re-check submissions still waiting on the chain.
 *
 * Needed because the common failure is "not confirmed yet": a student submits
 * a hash seconds after sending, and the required confirmations arrive a minute
 * later with no further request to trigger a re-check.
 */
export async function sweepPendingVerifications(): Promise<number> {

  const rows = await db
    .select({ id: paymentSubmissionsTable.id })
    .from(paymentSubmissionsTable)
    .where(
      and(
        eq(paymentSubmissionsTable.status, "verifying"),
        eq(paymentSubmissionsTable.method, "crypto_usdt_bep20"),
      ),
    )
    .limit(50);

  for (const row of rows) {
    try {
      await verifySubmission(row.id);
    } catch (err) {
      // One bad submission must not stop the sweep for everyone else.
      logger.error({ err, submissionId: row.id }, "Verification sweep failed for a submission");
    }
  }

  return rows.length;
}

export { MAX_ATTEMPTS };
