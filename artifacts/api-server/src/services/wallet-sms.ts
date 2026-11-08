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

import { and, asc, count, desc, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import {
  db,
  paymentSettingsTable,
  paymentSubmissionsTable,
  walletSmsMessagesTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { SETTINGS_ROW_ID } from "./payment-settings";
import {
  isTrustedSender,
  isTrustedServiceCenter,
  parseAllowedSenders,
  parseAllowedServiceCenters,
  parseConfirmationSms,
  SMS_ACTIVATIONS_PER_HOUR,
  SUBMISSION_WINDOW_MS,
  type ParsedSms,
} from "./wallet-sms-policy";

// Re-exported so callers have one import for the whole concern; the parsing
// rules live in wallet-sms-policy.ts, which has no database import.
export { parseConfirmationSms, SUBMISSION_WINDOW_MS, type ParsedSms };
import { activateSubscription, flagForReview } from "./subscription-activation";

/** Who a confirmation may come from. See isTrustedSender. */
const ALLOWED_SENDERS = parseAllowedSenders(process.env.WALLET_SMS_SENDERS);

/** Which SMS centres a confirmation may arrive through. See isTrustedServiceCenter. */
const ALLOWED_SERVICE_CENTERS = parseAllowedServiceCenters(process.env.WALLET_SMS_SERVICE_CENTERS);

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
   * Stored but not believed: its sender is not in WALLET_SMS_SENDERS, or it
   * came through an SMS centre not in WALLET_SMS_SERVICE_CENTERS. Kept, with
   * its sender, so a wrong setting can be seen and corrected.
   */
  | "stored_untrusted_sender"
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
  serviceCenter?: string | null;
  receivedAt: Date;
}): Promise<{ outcome: IngestOutcome; messageId: number | null }> {
  const serviceCenter = input.serviceCenter ?? null;

  // An untrusted message is stored with nothing parsed out of it, so no sweep
  // or later submission can ever pair with it.
  const trusted =
    isTrustedSender(input.sender, ALLOWED_SENDERS) &&
    isTrustedServiceCenter(serviceCenter, ALLOWED_SERVICE_CENTERS);
  const parsed = trusted
    ? parseConfirmationSms(input.rawText)
    : { operationNumber: null, amountSyp: null };

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

  // Logged, not stored: this is how the value for WALLET_SMS_SERVICE_CENTERS
  // is read off a genuine message.
  logger.info({ messageId, sender: input.sender, serviceCenter }, "Wallet SMS received");

  if (!trusted) {
    logger.warn(
      { messageId, sender: input.sender, serviceCenter },
      "Wallet SMS ignored: sender or SMS centre is not on the allowed list",
    );
    return { outcome: "stored_untrusted_sender", messageId };
  }

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

/** Whether the SMS path has used up this hour's unreviewed activations. */
async function smsActivationLimitReached(): Promise<boolean> {
  const [row] = await db
    .select({ value: count() })
    .from(paymentSubmissionsTable)
    .where(
      and(
        eq(paymentSubmissionsTable.method, "syriatel_cash"),
        eq(paymentSubmissionsTable.status, "approved"),
        // No reviewer means the SMS approved it, not a person.
        isNull(paymentSubmissionsTable.reviewedBy),
        gte(paymentSubmissionsTable.reviewedAt, new Date(Date.now() - 3_600_000)),
      ),
    );
  return (row?.value ?? 0) >= SMS_ACTIVATIONS_PER_HOUR;
}

/** Whether this claim re-uses an identifier an admin has already rejected. */
function isResubmission(log: unknown): boolean {
  return (log as { resubmittedAfterRejection?: boolean } | null)?.resubmittedAfterRejection === true;
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
        // A number can have a rejected claim and a later open one; the unique
        // index allows at most one that is not rejected.
        ne(paymentSubmissionsTable.status, "rejected"),
      ),
    )
    .limit(1);

  if (!submission) return false;
  if (submission.status === "approved") return false;

  const [message] = await db
    .select()
    .from(walletSmsMessagesTable)
    .where(eq(walletSmsMessagesTable.id, messageId))
    .limit(1);

  if (!message) return false;

  // The window runs from the payment (when the handset received the SMS) to
  // when the student submitted the number. Measured between those two events,
  // not against the clock at match time: a student who submitted promptly
  // must not fall outside it because the companion app forwarded late. A
  // negative gap (submitted before the SMS arrived) is inside the window.
  const gap = submission.createdAt.getTime() - message.receivedAt.getTime();
  const withinWindow = gap <= SUBMISSION_WINDOW_MS;

  // Amounts are compared as strings through Number only for the comparison
  // itself; both sides are SQL numeric, so neither was ever a float.
  const expected = Number(submission.amountExpectedSyp ?? "0");
  const observed = Number(message.parsedAmountSyp ?? "0");
  const amountOk = expected > 0 && observed >= expected;

  // A person already said no to this identifier once, so the SMS is evidence
  // for them to weigh and never grounds to activate on its own.
  const resubmitted = isResubmission(submission.verificationLog);

  // Asked last and only for a payment that would otherwise activate.
  const overLimit =
    withinWindow && amountOk && !resubmitted && (await smsActivationLimitReached());
  if (overLimit) {
    logger.error(
      { submissionId: submission.id, limit: SMS_ACTIVATIONS_PER_HOUR },
      "Wallet SMS activation limit reached; sending to review. Check for forged confirmations.",
    );
  }

  const verification = {
    source: "wallet_sms",
    ...(resubmitted ? { resubmittedAfterRejection: true } : {}),
    smsMessageId: messageId,
    operationNumber,
    amountExpectedSyp: submission.amountExpectedSyp,
    amountObservedSyp: message.parsedAmountSyp,
    receivedAt: message.receivedAt.toISOString(),
    submittedAt: submission.createdAt.toISOString(),
    withinWindow,
    amountOk,
    ...(overLimit ? { overHourlyLimit: true } : {}),
  };

  // Recorded whichever way this goes: the message has found its submission.
  await db
    .update(walletSmsMessagesTable)
    .set({ matchedSubmissionId: submission.id, matchedAt: new Date() })
    .where(eq(walletSmsMessagesTable.id, messageId));

  // Every write below is conditional on the submission still being open: this
  // runs outside any lock, and an admin may have decided it meanwhile.
  const stillOpen = and(
    eq(paymentSubmissionsTable.id, submission.id),
    inArray(paymentSubmissionsTable.status, ["pending", "verifying"]),
  );

  if (!withinWindow || !amountOk || resubmitted || overLimit) {
    // Left for an admin rather than rejected. A short payment or a late
    // submission is a judgement call (the money did arrive), and the log
    // above tells them exactly what was seen.
    await db
      .update(paymentSubmissionsTable)
      .set({
        status: "pending",
        amountObserved: message.parsedAmountSyp,
        verificationLog: { ...verification, needsReview: true },
      })
      .where(stillOpen);

    logger.info(
      { submissionId: submission.id, withinWindow, amountOk, resubmitted },
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
    .where(stillOpen);

  // reviewerId null: no human approved this, the SMS did.
  const outcome = await activateSubscription(submission.id, null);

  if (!outcome.ok) {
    logger.error(
      { submissionId: submission.id, reason: outcome.reason },
      "Wallet SMS verified but activation failed",
    );
    // The money arrived; a person has to decide what it bought.
    await flagForReview(submission.id, { activationFailed: outcome.reason });
    return false;
  }

  logger.info(
    { submissionId: submission.id, subscriptionId: outcome.subscriptionId },
    "Subscription activated by wallet SMS",
  );
  return true;
}

/**
 * Try to settle one submission against the messages already stored.
 *
 * Called the moment a student submits (the SMS usually landed first) and by
 * the sweep. Looks the message up by operation number with no age limit, so a
 * late submission still finds its SMS and reaches the needs-review path,
 * rather than sitting in `verifying` with nothing ever touching it.
 */
export async function matchSubmission(submissionId: number): Promise<boolean> {
  const [submission] = await db
    .select({
      id: paymentSubmissionsTable.id,
      status: paymentSubmissionsTable.status,
      operationNumber: paymentSubmissionsTable.operationNumber,
      createdAt: paymentSubmissionsTable.createdAt,
      verificationLog: paymentSubmissionsTable.verificationLog,
    })
    .from(paymentSubmissionsTable)
    .where(
      and(
        eq(paymentSubmissionsTable.id, submissionId),
        eq(paymentSubmissionsTable.method, "syriatel_cash"),
      ),
    )
    .limit(1);

  if (!submission?.operationNumber) return false;
  // A resubmission is already in the admin queue, and comes through here only
  // to have its SMS attached as evidence.
  if (submission.status !== "verifying" && !isResubmission(submission.verificationLog)) {
    return false;
  }

  // The newest copy: a redelivered message is stored again, and any copy
  // carries the same payment.
  const [message] = await db
    .select({ id: walletSmsMessagesTable.id })
    .from(walletSmsMessagesTable)
    .where(eq(walletSmsMessagesTable.parsedOperationNumber, submission.operationNumber))
    .orderBy(desc(walletSmsMessagesTable.receivedAt))
    .limit(1);

  if (message) return matchMessage(message.id, submission.operationNumber);

  // No SMS has ever carried this number. Waiting is right for a while (the
  // forwarder may be offline), but not forever: past the window it is most
  // likely a mistyped number, and only an admin can sort that out with the
  // student, who is blocked from resubmitting while this is open.
  if (Date.now() - submission.createdAt.getTime() > SUBMISSION_WINDOW_MS) {
    await flagForReview(submission.id, {
      source: "wallet_sms",
      lastOutcome: "no_sms_received",
      note: "No confirmation SMS with this operation number arrived. The number may be mistyped, or the companion app may not be forwarding.",
    });
    logger.info({ submissionId }, "Wallet submission saw no SMS within the window; sent for review");
  }
  return false;
}

/**
 * Settle submissions still waiting on their SMS.
 *
 * Walks open SUBMISSIONS rather than stored messages. Messages accumulate
 * without bound (retries, redeliveries, transfers unrelated to the app) and a
 * sweep over them starved real payments behind noise; open submissions are
 * few, each one is a student waiting, and the oldest go first.
 */
export async function sweepWalletSubmissions(): Promise<number> {
  const rows = await db
    .select({ id: paymentSubmissionsTable.id })
    .from(paymentSubmissionsTable)
    .where(
      and(
        eq(paymentSubmissionsTable.method, "syriatel_cash"),
        eq(paymentSubmissionsTable.status, "verifying"),
      ),
    )
    .orderBy(asc(paymentSubmissionsTable.createdAt))
    .limit(100);

  let matched = 0;
  for (const row of rows) {
    try {
      if (await matchSubmission(row.id)) matched++;
    } catch (err) {
      // One bad row must not stop the sweep for everyone else.
      logger.error({ err, submissionId: row.id }, "Wallet SMS sweep failed for a submission");
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
