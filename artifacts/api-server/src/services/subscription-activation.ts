/**
 * Subscription Activation
 *
 * The one place a subscription becomes active. Both callers go through it:
 * the admin approving a ShamCash receipt, and the crypto verifier confirming a
 * transaction on-chain. One activation path, not two — a refund, later, is its
 * inverse, and there is nothing single to invert if this logic is scattered.
 *
 * WHY expiresAt IS SET HERE AND NOT AT REQUEST TIME
 * ─────────────────────────────────────────────────
 * POST /subscription used to stamp `expiresAt` when the student asked to
 * subscribe. A subscription approved three days later silently lost three days
 * — the student paid for a month and got twenty-seven days. The clock starts
 * when the payment is confirmed.
 *
 * WHY THE OLD SUBSCRIPTION IS SUPERSEDED HERE AND NOT AT REQUEST TIME
 * ──────────────────────────────────────────────────────────────────
 * It used to be cancelled when the student asked to upgrade, before they had
 * paid for anything. A student who started an upgrade and then abandoned it
 * downgraded themselves to free. Nothing touches the current subscription
 * until the new one is paid for.
 */

import { and, eq, ne, sql } from "drizzle-orm";
import {
  db,
  paymentSubmissionsTable,
  studentSubscriptionsTable,
  subscriptionPlansTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { addBillingCycle } from "./entitlement-policy";

// Re-exported: callers of the activation service should not have to know the
// date arithmetic lives in the db-free policy module.
export { addBillingCycle };

/** What happened. Activation is idempotent, so "already done" is a success. */
export type ActivationOutcome =
  | { ok: true; subscriptionId: number; alreadyActive: boolean }
  | { ok: false; reason: ActivationFailure };

export type ActivationFailure =
  | "submission_not_found"
  | "already_rejected"
  | "plan_not_found";

/**
 * Approve a payment submission and activate the subscription it paid for.
 *
 * `reviewerId` is the admin who approved it, or null when the crypto verifier
 * approved it without a human.
 *
 * Everything happens in one transaction: a half-applied activation would leave
 * a student paid-but-locked-out, or active with the submission still pending
 * so it could be approved a second time.
 */
export async function activateSubscription(
  submissionId: number,
  reviewerId: number | null,
  reviewNote?: string,
): Promise<ActivationOutcome> {
  return db.transaction(async (tx) => {
    // FOR UPDATE: two admins clicking approve on the same row, or an admin
    // racing the verifier, must serialise here rather than both activating.
    const [submission] = await tx
      .select()
      .from(paymentSubmissionsTable)
      .where(eq(paymentSubmissionsTable.id, submissionId))
      .limit(1)
      .for("update");

    if (!submission) return { ok: false, reason: "submission_not_found" as const };

    // Idempotency. A double-approve finds the work already done and says so
    // rather than extending the subscription a second time.
    if (submission.status === "approved") {
      return {
        ok: true,
        subscriptionId: submission.subscriptionId,
        alreadyActive: true,
      };
    }

    if (submission.status === "rejected") {
      return { ok: false, reason: "already_rejected" as const };
    }

    const [subscription] = await tx
      .select()
      .from(studentSubscriptionsTable)
      .where(eq(studentSubscriptionsTable.id, submission.subscriptionId))
      .limit(1);

    if (!subscription) return { ok: false, reason: "submission_not_found" as const };

    // `student_subscriptions.planCode` is plain text while
    // `subscription_plans.code` is a narrow enum, so this compares as text.
    // A subscription naming a plan that no longer exists fails closed below
    // rather than activating on a guessed billing cycle.
    const [plan] = await tx
      .select({ billingCycle: subscriptionPlansTable.billingCycle })
      .from(subscriptionPlansTable)
      .where(sql`${subscriptionPlansTable.code} = ${subscription.planCode}`)
      .limit(1);

    if (!plan) return { ok: false, reason: "plan_not_found" as const };

    // The subscription being replaced, if any. Read before it is cancelled so
    // the new row can record what it superseded.
    const [previous] = await tx
      .select({ id: studentSubscriptionsTable.id })
      .from(studentSubscriptionsTable)
      .where(
        and(
          eq(studentSubscriptionsTable.userId, subscription.userId),
          eq(studentSubscriptionsTable.status, "active"),
          ne(studentSubscriptionsTable.id, subscription.id),
        ),
      )
      .limit(1);

    if (previous) {
      await tx
        .update(studentSubscriptionsTable)
        .set({ status: "cancelled" })
        .where(eq(studentSubscriptionsTable.id, previous.id));
    }

    // The clock starts now, not when the student asked.
    const startedAt = new Date();
    const expiresAt = addBillingCycle(startedAt, plan.billingCycle);

    await tx
      .update(studentSubscriptionsTable)
      .set({
        status: "active",
        startedAt,
        expiresAt,
        supersedesId: previous?.id ?? null,
      })
      .where(eq(studentSubscriptionsTable.id, subscription.id));

    await tx
      .update(paymentSubmissionsTable)
      .set({
        status: "approved",
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
        ...(reviewNote ? { reviewNote } : {}),
      })
      .where(eq(paymentSubmissionsTable.id, submissionId));

    logger.info(
      {
        submissionId,
        subscriptionId: subscription.id,
        userId: subscription.userId,
        planCode: subscription.planCode,
        reviewerId,
        supersededId: previous?.id ?? null,
        expiresAt,
      },
      "Subscription activated",
    );

    return { ok: true, subscriptionId: subscription.id, alreadyActive: false };
  });
}

/**
 * Reject a payment submission.
 *
 * The subscription row is left at `pending_payment` rather than cancelled, so
 * the student can correct the problem — upload a clearer receipt, submit the
 * right transaction hash — against the same subscription instead of starting
 * again and losing the audit trail.
 */
export async function rejectSubmission(
  submissionId: number,
  reviewerId: number,
  reviewNote: string,
): Promise<ActivationOutcome> {
  return db.transaction(async (tx) => {
    const [submission] = await tx
      .select()
      .from(paymentSubmissionsTable)
      .where(eq(paymentSubmissionsTable.id, submissionId))
      .limit(1)
      .for("update");

    if (!submission) return { ok: false, reason: "submission_not_found" as const };

    // An approved submission is not rejectable: the student already has what
    // they paid for, and taking it back is a refund, which is a different
    // operation with different bookkeeping.
    if (submission.status === "approved") {
      return { ok: false, reason: "already_rejected" as const };
    }

    await tx
      .update(paymentSubmissionsTable)
      .set({
        status: "rejected",
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
        reviewNote,
      })
      .where(eq(paymentSubmissionsTable.id, submissionId));

    logger.info({ submissionId, reviewerId }, "Payment submission rejected");

    return { ok: true, subscriptionId: submission.subscriptionId, alreadyActive: false };
  });
}

/**
 * Mark active subscriptions whose expiry has passed.
 *
 * Access does not depend on this running: services/entitlements.ts filters on
 * the timestamp, so a subscription stops opening lessons the moment it expires
 * whether or not the sweep has caught up. This keeps the stored status honest
 * — for the admin screens, for reporting, and so a student sees "expired"
 * rather than "active" on a subscription that no longer works.
 */
export async function expireSubscriptions(): Promise<number> {
  const result = await db
    .update(studentSubscriptionsTable)
    .set({ status: "expired" })
    .where(
      and(
        eq(studentSubscriptionsTable.status, "active"),
        sql`${studentSubscriptionsTable.expiresAt} is not null`,
        sql`${studentSubscriptionsTable.expiresAt} <= now()`,
      ),
    )
    .returning({ id: studentSubscriptionsTable.id });

  if (result.length > 0) {
    logger.info({ count: result.length }, "Subscriptions expired");
  }

  return result.length;
}
