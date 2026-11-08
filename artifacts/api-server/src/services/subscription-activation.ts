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

import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  db,
  paymentSubmissionsTable,
  studentSubscriptionsTable,
  subscriptionPlansTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { addBillingCycle } from "./entitlement-policy";
import { skipLevelWithoutLessons } from "./learning";

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
  | "plan_not_found"
  /**
   * The subscription this payment was for is no longer waiting for one: a
   * different submission already activated it, or it was cancelled. The money
   * may well be real (a student who paid twice), so this needs a person, not
   * a second activation that would restart the period and reset the quota.
   */
  | "subscription_not_pending";

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
  let activatedUserId: number | null = null;

  const result = await db.transaction(async (tx): Promise<ActivationOutcome> => {
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

    // One activation per student at a time. The row locks below cover one
    // subscription; two payments settling at once for DIFFERENT plans would
    // each see no other active row and both activate, leaving the student on
    // two plans with whichever `.limit(1)` happened to return deciding access.
    // Classid 4243 namespaces this against the lesson-start lock (4242).
    await tx.execute(sql`select pg_advisory_xact_lock(4243, ${submission.userId})`);

    // Locked too: two different submissions for one subscription (two tx
    // hashes, or a stale receipt approved after the SMS path activated it)
    // each hold their own submission lock, so only this one serialises them.
    const [subscription] = await tx
      .select()
      .from(studentSubscriptionsTable)
      .where(eq(studentSubscriptionsTable.id, submission.subscriptionId))
      .limit(1)
      .for("update");

    if (!subscription) return { ok: false, reason: "submission_not_found" as const };

    // Activation happens once per subscription. Re-activating an active one
    // would restart its period (the student pays twice for one month) and
    // reset the monthly quota; activating a cancelled one would cancel the
    // plan the student is on now in favour of one they abandoned.
    if (subscription.status !== "pending_payment") {
      return { ok: false, reason: "subscription_not_pending" as const };
    }

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
        // The quota period's anchor, set once here.
        //
        // getEntitlement falls back to `startedAt` when this is null, so the
        // allowance works either way — but only while they agree. A renewal
        // will set `startedAt` again, and without its own anchor the monthly
        // allowance would silently reset at that moment.
        periodStartedAt: startedAt,
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

    activatedUserId = subscription.userId;
    return { ok: true, subscriptionId: subscription.id, alreadyActive: false };
  });

  // After the commit, and never allowed to fail it: the student has paid, and
  // where they sit in the curriculum can be corrected later.
  if (activatedUserId !== null) {
    await skipLevelWithoutLessons(activatedUserId).catch((err) => {
      logger.error({ err, userId: activatedUserId }, "Could not skip an empty level after activation");
    });
  }

  return result;
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

/**
 * Hand an unresolved submission to an admin, with the reason recorded.
 *
 * Used by the automatic verifiers when they cannot finish the job themselves.
 * Conditional on the submission still being unresolved: a verifier's check
 * runs outside any lock, so by the time it writes, an admin or a concurrent
 * run may already have approved or rejected the row, and that decision must
 * not be overwritten back to `pending`.
 */
export async function flagForReview(
  submissionId: number,
  log: Record<string, unknown>,
): Promise<void> {
  await db
    .update(paymentSubmissionsTable)
    .set({
      status: "pending",
      verificationLog: sql`coalesce(${paymentSubmissionsTable.verificationLog}, '{}'::jsonb) || ${JSON.stringify(
        { ...log, needsReview: true },
      )}::jsonb`,
    })
    .where(
      and(
        eq(paymentSubmissionsTable.id, submissionId),
        inArray(paymentSubmissionsTable.status, ["pending", "verifying"]),
      ),
    );
}
