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

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, paymentSubmissionsTable, studentSubscriptionsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { cryptoConfig } from "./crypto-config";
import {
  provesClaim,
  verifyTransfer,
  type RpcReceipt,
  type VerifyResult,
} from "./crypto-verify-policy";
import { activateSubscription, flagForReview, notifyRejection } from "./subscription-activation";
import { USDT_AMOUNT_HOLD_MS } from "./usdt-amount";

/**
 * Every write this verifier makes is conditional on the row still being open.
 *
 * The check itself runs outside any lock (it is an RPC round trip), and two
 * runs can overlap: the fire-and-forget check from the POST and the sweeper.
 * Without the condition, a run that saw "not enough confirmations yet" could
 * write `verifying` over an `approved` the other run had just set, or over an
 * admin's decision.
 */
function stillUnresolved(submissionId: number) {
  return and(
    eq(paymentSubmissionsTable.id, submissionId),
    inArray(paymentSubmissionsTable.status, ["pending", "verifying"]),
  );
}

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

/** The moments a transaction is judged against. */
interface ClaimTiming {
  subscriptionOpenedAt: Date;
  amountHeldUntil: Date | null;
  submittedAt: Date;
}

/**
 * The window a subscription's amount was its own.
 *
 * From when the amount was given out, so a later holder of a released amount
 * cannot claim a transfer made before they held it, and until the hold ended,
 * so an earlier holder cannot claim one made after.
 */
function claimTiming(
  subscription: { usdtAmountAt: Date | null; createdAt: Date } | undefined,
  submittedAt: Date,
): ClaimTiming {
  const heldFrom = subscription?.usdtAmountAt;
  return {
    subscriptionOpenedAt: heldFrom ?? subscription?.createdAt ?? submittedAt,
    amountHeldUntil: heldFrom ? new Date(heldFrom.getTime() + USDT_AMOUNT_HOLD_MS) : null,
    submittedAt,
  };
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
  amountExpected: number | string,
  /**
   * The address that must have received the transfer — the one snapshotted on
   * the submission, not the current setting, so an admin changing the address
   * cannot re-point a payment that is already being checked.
   */
  walletAddress: string,
  timing: ClaimTiming,
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

    // The receipt has no timestamp; the block it was mined in does. A node that
    // cannot return a block it just gave a receipt for is lagging, not a
    // statement about the payment.
    const block = await rpcCall<{ timestamp: string } | null>("eth_getBlockByNumber", [
      receipt.blockNumber,
      false,
    ]);
    if (!block) return { reachable: false, found: false, result: null };

    const result = verifyTransfer({
      receipt,
      currentBlock,
      walletAddress,
      amountExpected,
      confirmations: config.confirmations,
      blockTimestamp: Number(BigInt(block.timestamp)),
      subscriptionOpenedAt: timing.subscriptionOpenedAt,
      amountHeldUntil: timing.amountHeldUntil,
      submittedAt: timing.submittedAt,
      maxAgeDays: config.maxAgeDays,
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
        .where(stillUnresolved(submissionId));
    }
    return;
  }

  // Already decided — by an admin, or by an earlier run of this job.
  if (submission.status === "approved" || submission.status === "rejected") return;

  const [subscription] = await db
    .select({
      createdAt: studentSubscriptionsTable.createdAt,
      usdtAmountAt: studentSubscriptionsTable.usdtAmountAt,
    })
    .from(studentSubscriptionsTable)
    .where(eq(studentSubscriptionsTable.id, submission.subscriptionId))
    .limit(1);

  // Passed as the stored string: the amount is compared exactly.
  const check = await checkTransaction(
    submission.txHash,
    submission.amountExpected,
    submission.expectedWalletAddress,
    claimTiming(subscription, submission.createdAt),
  );

  const previousLog = (submission.verificationLog ?? {}) as Record<string, unknown>;
  const attempts = Number(previousLog.attempts ?? 0) + 1;

  // The chain was unreachable. Record the attempt and leave everything else
  // alone: an RPC outage must never look like a bad payment.
  if (!check.reachable) {
    await db
      .update(paymentSubmissionsTable)
      .set({
        // `attempts` deliberately not advanced. It counts real answers from
        // the chain, and spending the retry budget on an outage would send a
        // good payment to manual review as soon as the network came back.
        verificationLog: {
          ...previousLog,
          lastCheckedAt: new Date().toISOString(),
          lastOutcome: "rpc_unreachable",
        },
      })
      .where(stillUnresolved(submissionId));
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
      .where(stillUnresolved(submissionId));
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
      .where(stillUnresolved(submissionId));
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
    .where(stillUnresolved(submissionId));

  // reviewerId null: nobody approved this, the chain did.
  const outcome = await activateSubscription(submissionId, null);

  if (!outcome.ok) {
    logger.error(
      { submissionId, reason: outcome.reason },
      "On-chain payment verified but activation failed",
    );
    // The money is on chain; a person has to decide what it bought. Without
    // this the row would sit in `verifying` and be re-checked forever.
    await flagForReview(submissionId, { activationFailed: outcome.reason });
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
 * Free a transaction hash from a claim the chain does not support.
 *
 * Hashes are public: anyone can copy a stranger's from the receiving wallet's
 * history and submit it. Such a claim can never verify, but it holds the unique
 * index, so the student who really paid would be told "already used". When the
 * chain shows the hash paid exactly the amount this subscription holds, the
 * unproven claim is closed so the real one can take its place.
 *
 * Returns whether the hash is now free. A claim already confirmed on chain, or
 * approved, is never touched.
 */
export async function displaceUnprovenClaim(
  txHash: string,
  claimant: {
    id: number;
    usdtAmount: string | null;
    usdtAmountAt: Date | null;
    createdAt: Date;
  },
  walletAddress: string,
): Promise<boolean> {
  if (claimant.usdtAmount === null) return false;

  const { result } = await checkTransaction(
    txHash,
    claimant.usdtAmount,
    walletAddress,
    claimTiming(claimant, new Date()),
  );
  if (!result || !provesClaim(result)) return false;

  const displaced = await db
    .update(paymentSubmissionsTable)
    .set({
      status: "rejected",
      reviewedAt: new Date(),
      reviewNote: "This transaction was matched to a different payment.",
    })
    .where(
      and(
        sql`lower(${paymentSubmissionsTable.txHash}) = ${txHash}`,
        inArray(paymentSubmissionsTable.status, ["pending", "verifying"]),
        isNull(paymentSubmissionsTable.confirmedAt),
      ),
    )
    .returning({
      id: paymentSubmissionsTable.id,
      userId: paymentSubmissionsTable.userId,
      subscriptionId: paymentSubmissionsTable.subscriptionId,
      reviewNote: paymentSubmissionsTable.reviewNote,
    });

  if (displaced.length === 0) return false;

  for (const d of displaced) {
    await notifyRejection(d.userId, d.id, d.subscriptionId, d.reviewNote ?? "");
  }

  logger.warn(
    { txHash, displacedSubmissionId: displaced[0].id, subscriptionId: claimant.id },
    "Closed a claim on a transaction that paid a different subscription",
  );
  return true;
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
