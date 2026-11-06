/**
 * Syriatel Cash confirmation SMS — parsing and matching.
 *
 * When a merchant account receives money, Syriatel texts the merchant phone:
 *
 *     تم استلام مبلغ 1 ل.س بنجاح. رقم العملية هو 600123456789
 *
 * The payer's own SMS carries the same operation number. That shared key is
 * what makes this path automatable: the student submits the number, a companion
 * app on the merchant phone forwards the message, and the two are matched on an
 * exact value — not inferred from amount and timing, which is what every other
 * Syrian wallet integration is reduced to.
 *
 * WHY THE NUMBER CAN BE TRUSTED
 * ─────────────────────────────
 * Syriatel sends it only to the payer and the merchant, and it appears nowhere
 * public, so a student who did not pay cannot know one. It is a bearer secret
 * rather than a reference — which is also why a submission is bounded in time
 * and a number may be claimed exactly once.
 *
 * The raw text is always stored before parsing is attempted. A reworded message
 * can then be re-read later against what Syriatel actually sent, rather than
 * against a guess at it.
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  paymentSettingsTable,
  paymentSubmissionsTable,
  walletSmsMessagesTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { SETTINGS_ROW_ID } from "./payment-settings";
import {
  parseConfirmationSms,
  SUBMISSION_WINDOW_MS,
  type ParsedSms,
} from "./wallet-sms-policy";

// Re-exported so callers have one import for the whole concern; the parsing
// rules live in wallet-sms-policy.ts, which has no database import.
export { parseConfirmationSms, SUBMISSION_WINDOW_MS, type ParsedSms };
import { activateSubscription } from "./subscription-activation";

/** What became of an ingested message. */
export type IngestOutcome =
  /** Paired with a submission, which is now active. */
  | "matched"
  /**
   * Stored, but the message could not be read. The signal that Syriatel's
   * wording changed — the raw text is kept so it can be re-parsed later.
   */
  | "stored_unparsed"
  /**
   * Stored, but no submission carries this operation number YET.
   *
   * Not a failure and not final: the usual ordering is that a student pays,
   * the SMS lands, and only then do they type the number in. The sweep pairs
   * them when the submission arrives.
   */
  | "stored_unmatched";

/**
 * Store a forwarded message, then try to match it to a pending submission.
 *
 * Idempotent on the operation number: the companion app is expected to retry,
 * so a message re-sent after a dropped response is recognised rather than
 * matched twice. That is enforced by a unique index, not by the lookup below,
 * because two retries can arrive together.
 */
export async function ingestSms(input: {
  rawText: string;
  sender: string | null;
  receivedAt: Date;
}): Promise<{ outcome: IngestOutcome; messageId: number | null }> {
  const parsed = parseConfirmationSms(input.rawText);

  // Stored unconditionally, including a redelivery of a message already seen.
  //
  // A forwarded SMS is not a spent payment: the message may arrive before its
  // student submits, in which case it matches nothing on arrival and must
  // still be matchable later. Refusing the second copy burned the operation
  // number and stranded a payment that was entirely real.
  //
  // What may be claimed only once is the SUBMISSION, enforced by a unique
  // index on payment_submissions.operation_number. Double activation is
  // prevented by activateSubscription being idempotent on the submission's
  // status, not by refusing to store a row.
  const [row] = await db
    .insert(walletSmsMessagesTable)
    .values({
      rawText: input.rawText,
      sender: input.sender,
      receivedAt: input.receivedAt,
      parsedOperationNumber: parsed.operationNumber,
      parsedAmountSyp: parsed.amountSyp,
    })
    .returning({ id: walletSmsMessagesTable.id });
  const messageId = row.id;

  if (!parsed.operationNumber) {
    // Stored but unreadable. Worth a warning rather than a silent row: this is
    // how a reworded message announces itself.
    logger.warn(
      { messageId, sender: input.sender },
      "Wallet SMS stored but could not be parsed — the message format may have changed",
    );
    return { outcome: "stored_unparsed", messageId };
  }

  const matched = await matchMessage(messageId, parsed.operationNumber);
  return {
    outcome: matched ? "matched" : "stored_unmatched",
    messageId,
  };
}

/**
 * Find the submission this message pays for, and activate it.
 *
 * A message with no submission yet is left alone, not discarded: students
 * routinely pay first and submit a minute later, and the sweep below pairs
 * them up when the submission arrives.
 */
async function matchMessage(
  messageId: number,
  operationNumber: string,
): Promise<boolean> {
  const [submission] = await db
    .select()
    .from(paymentSubmissionsTable)
    .where(
      and(
        eq(paymentSubmissionsTable.operationNumber, operationNumber),
        eq(paymentSubmissionsTable.method, "syriatel_cash"),
      ),
    )
    .limit(1);

  if (!submission) return false;
  if (submission.status === "approved" || submission.status === "rejected") {
    return false;
  }

  const [message] = await db
    .select()
    .from(walletSmsMessagesTable)
    .where(eq(walletSmsMessagesTable.id, messageId))
    .limit(1);

  if (!message) return false;

  // The window is measured from when the handset received the message, so a
  // companion app that was offline does not eat the student's time.
  const age = Date.now() - message.receivedAt.getTime();
  const withinWindow = age <= SUBMISSION_WINDOW_MS;

  // Amounts are compared as strings through Number only for the comparison
  // itself; both sides are SQL numeric, so neither was ever a float.
  const expected = Number(submission.amountExpectedSyp ?? "0");
  const observed = Number(message.parsedAmountSyp ?? "0");
  const amountOk = expected > 0 && observed >= expected;

  const verification = {
    source: "wallet_sms",
    smsMessageId: messageId,
    operationNumber,
    amountExpectedSyp: submission.amountExpectedSyp,
    amountObservedSyp: message.parsedAmountSyp,
    receivedAt: message.receivedAt.toISOString(),
    withinWindow,
    amountOk,
  };

  if (!withinWindow || !amountOk) {
    // Left for an admin rather than rejected. A short payment or a late
    // submission is a judgement call — the money did arrive — and the log
    // above tells them exactly what was seen.
    await db
      .update(paymentSubmissionsTable)
      .set({
        status: "pending",
        amountObserved: message.parsedAmountSyp,
        verificationLog: { ...verification, needsReview: true },
      })
      .where(eq(paymentSubmissionsTable.id, submission.id));

    logger.info(
      { submissionId: submission.id, withinWindow, amountOk },
      "Wallet SMS matched a submission but needs review",
    );
    return false;
  }

  await db
    .update(paymentSubmissionsTable)
    .set({
      amountObserved: message.parsedAmountSyp,
      confirmedAt: new Date(),
      verificationLog: verification,
    })
    .where(eq(paymentSubmissionsTable.id, submission.id));

  await db
    .update(walletSmsMessagesTable)
    .set({ matchedSubmissionId: submission.id, matchedAt: new Date() })
    .where(eq(walletSmsMessagesTable.id, messageId));

  // reviewerId null: no human approved this, the SMS did.
  const outcome = await activateSubscription(submission.id, null);

  if (!outcome.ok) {
    logger.error(
      { submissionId: submission.id, reason: outcome.reason },
      "Wallet SMS verified but activation failed",
    );
    return false;
  }

  logger.info(
    { submissionId: submission.id, subscriptionId: outcome.subscriptionId },
    "Subscription activated by wallet SMS",
  );
  return true;
}

/**
 * Pair stored messages with submissions that arrived after them.
 *
 * The common ordering: a student pays, the SMS lands, and only then do they
 * open the app and type the number. Nothing triggers a re-check at that
 * moment, so without this sweep that payment would wait for an admin.
 */
export async function sweepUnmatchedSms(): Promise<number> {
  const rows = await db
    .select({
      id: walletSmsMessagesTable.id,
      operationNumber: walletSmsMessagesTable.parsedOperationNumber,
    })
    .from(walletSmsMessagesTable)
    .where(
      and(
        isNull(walletSmsMessagesTable.matchedSubmissionId),
        sql`${walletSmsMessagesTable.parsedOperationNumber} is not null`,
        // Older than the window can never match now; leaving them out keeps
        // the sweep bounded as the table grows.
        sql`${walletSmsMessagesTable.receivedAt} > now() - make_interval(secs => ${
          SUBMISSION_WINDOW_MS / 1000
        })`,
      ),
    )
    .orderBy(desc(walletSmsMessagesTable.receivedAt))
    .limit(100);

  let matched = 0;
  for (const row of rows) {
    if (!row.operationNumber) continue;
    try {
      if (await matchMessage(row.id, row.operationNumber)) matched++;
    } catch (err) {
      // One bad message must not stop the sweep for everyone else.
      logger.error({ err, messageId: row.id }, "Wallet SMS sweep failed for a message");
    }
  }
  return matched;
}

/**
 * The companion app's bearer token, or null when none is configured.
 *
 * Null means the ingest endpoint refuses everything: an open ingest would let
 * anyone POST a fabricated confirmation and mint themselves a subscription.
 */
export async function getIngestToken(): Promise<string | null> {
  const [row] = await db
    .select({ token: paymentSettingsTable.smsIngestToken })
    .from(paymentSettingsTable)
    .where(eq(paymentSettingsTable.id, SETTINGS_ROW_ID))
    .limit(1);
  return row?.token ?? null;
}
