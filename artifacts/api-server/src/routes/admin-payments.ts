/**
 * Admin payment review.
 *
 * The queue an admin works through to turn a claimed payment into an active
 * subscription. ShamCash submissions always land here — a human reads the
 * receipt. Crypto submissions land here only when the on-chain check could not
 * decide: the right amount at the right address activates without anyone
 * looking.
 *
 * Approve and reject both delegate to services/subscription-activation.ts,
 * which owns the transaction. Nothing in this file changes a subscription.
 */

import { Router, type IRouter } from "express";
import { asc, count, eq } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  paymentSubmissionsTable,
  paymentSettingsTable,
  studentSubscriptionsTable,
  mediaAssetsTable,
  usersTable,
} from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import {
  activateSubscription,
  rejectSubmission,
} from "../services/subscription-activation";
import { resolvePlaybackUrl } from "../services/media";
import { SETTINGS_ROW_ID } from "../services/payment-settings";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const STATUSES = ["pending", "verifying", "approved", "rejected"] as const;

/**
 * GET /admin/payment-submissions
 *
 * Oldest first: a review queue is worked front to back, and the student who
 * has been waiting longest should be served first. The student's own list is
 * newest-first, which is the opposite and deliberate.
 */
router.get("/admin/payment-submissions", requireAdmin, async (req, res): Promise<void> => {
  const statusParam = typeof req.query.status === "string" ? req.query.status : "pending";
  const status = (STATUSES as readonly string[]).includes(statusParam)
    ? (statusParam as (typeof STATUSES)[number])
    : "pending";

  const rows = await db
    .select({
      submission: paymentSubmissionsTable,
      studentName: usersTable.name,
      studentEmail: usersTable.email,
      planCode: studentSubscriptionsTable.planCode,
      planNameAr: studentSubscriptionsTable.planNameAr,
    })
    .from(paymentSubmissionsTable)
    .innerJoin(usersTable, eq(usersTable.id, paymentSubmissionsTable.userId))
    .innerJoin(
      studentSubscriptionsTable,
      eq(studentSubscriptionsTable.id, paymentSubmissionsTable.subscriptionId),
    )
    .where(eq(paymentSubmissionsTable.status, status))
    .orderBy(asc(paymentSubmissionsTable.createdAt))
    .limit(100);

  // Receipt images are private objects; the admin gets a short-lived signed URL
  // rather than a bucket path. Resolved per row because each is a separate
  // object, and skipped entirely for crypto submissions, which have no image.
  const result = await Promise.all(
    rows.map(async (r) => {
      // resolvePlaybackUrl runs its own access check; canReadAsset already
      // admits staff roles to a student's own upload, which is exactly the
      // case here. A failure must not hide the whole queue — the admin can
      // still see the submission and ask for a re-upload.
      const receiptUrl = r.submission.receiptMediaId
        ? await resolvePlaybackUrl(r.submission.receiptMediaId, {
            userId: req.session.userId!,
            role: req.session.role,
          }).catch((err) => {
            logger.warn(
              { err, submissionId: r.submission.id },
              "Could not resolve receipt URL",
            );
            return null;
          })
        : null;

      return {
        id: r.submission.id,
        subscriptionId: r.submission.subscriptionId,
        userId: r.submission.userId,
        studentName: r.studentName,
        studentEmail: r.studentEmail,
        planCode: r.planCode,
        planNameAr: r.planNameAr,
        method: r.submission.method,
        status: r.submission.status,
        amountExpected: r.submission.amountExpected,
        receiptUrl,
        studentNote: r.submission.studentNote ?? null,
        txHash: r.submission.txHash ?? null,
        amountObserved: r.submission.amountObserved ?? null,
        senderAddress: r.submission.senderAddress ?? null,
        /** What the automatic check saw, so the admin is not guessing. */
        verificationLog: r.submission.verificationLog ?? null,
        reviewNote: r.submission.reviewNote ?? null,
        createdAt: r.submission.createdAt.toISOString(),
        reviewedAt: r.submission.reviewedAt?.toISOString() ?? null,
      };
    }),
  );

  res.json(result);
});

/**
 * GET /admin/payment-submissions/count
 *
 * Drives the badge on the admin dashboard. Separate from the list so the badge
 * can poll cheaply without pulling a hundred rows and signing their receipts.
 */
router.get(
  "/admin/payment-submissions/count",
  requireAdmin,
  async (_req, res): Promise<void> => {
    const [row] = await db
      .select({ value: count() })
      .from(paymentSubmissionsTable)
      .where(eq(paymentSubmissionsTable.status, "pending"));

    res.json({ pending: row?.value ?? 0 });
  },
);

const reviewSchema = z.object({
  reviewNote: z.string().trim().max(1000).optional(),
});

/** POST /admin/payment-submissions/:id/approve */
router.post(
  "/admin/payment-submissions/:id/approve",
  requireAdmin,
  async (req, res): Promise<void> => {
    const submissionId = parseInt(String(req.params.id), 10);
    if (isNaN(submissionId)) {
      res.status(400).json({ error: "Invalid submission id" });
      return;
    }

    const parsed = reviewSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid review note" });
      return;
    }

    const outcome = await activateSubscription(
      submissionId,
      req.session.userId!,
      parsed.data.reviewNote,
    );

    if (!outcome.ok) {
      const code = outcome.reason === "submission_not_found" ? 404 : 409;
      res.status(code).json({ error: outcome.reason });
      return;
    }

    res.json({
      subscriptionId: outcome.subscriptionId,
      // True when this approval was a no-op because the submission was already
      // approved — two admins clicking at once, or a retried request.
      alreadyActive: outcome.alreadyActive,
    });
  },
);

const rejectSchema = z.object({
  // Required, unlike on approve: a rejection the student cannot see a reason
  // for is a support ticket, and this text is shown to them.
  reviewNote: z.string().trim().min(1).max(1000),
});

/** POST /admin/payment-submissions/:id/reject */
router.post(
  "/admin/payment-submissions/:id/reject",
  requireAdmin,
  async (req, res): Promise<void> => {
    const submissionId = parseInt(String(req.params.id), 10);
    if (isNaN(submissionId)) {
      res.status(400).json({ error: "Invalid submission id" });
      return;
    }

    const parsed = rejectSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "A reason is required to reject a payment" });
      return;
    }

    const outcome = await rejectSubmission(
      submissionId,
      req.session.userId!,
      parsed.data.reviewNote,
    );

    if (!outcome.ok) {
      const code = outcome.reason === "submission_not_found" ? 404 : 409;
      res.status(code).json({ error: outcome.reason });
      return;
    }

    res.json({ ok: true });
  },
);

// ─── ShamCash receive settings ────────────────────────────────────────────────

const settingsSchema = z.object({
  /**
   * A media id from the upload handshake, purpose `payment_qr`. Verified
   * below — a client could otherwise point this at any asset in the bucket.
   */
  shamCashQrMediaId: z.number().int().positive().nullable().optional(),
  shamCashAccountName: z.string().trim().max(200).nullable().optional(),
  shamCashAccountNumber: z.string().trim().max(100).nullable().optional(),
  shamCashInstructionsAr: z.string().trim().max(4000).nullable().optional(),
});

/** GET /admin/payment-settings — what students are currently shown. */
router.get("/admin/payment-settings", requireAdmin, async (_req, res): Promise<void> => {
  const [row] = await db
    .select()
    .from(paymentSettingsTable)
    .where(eq(paymentSettingsTable.id, SETTINGS_ROW_ID))
    .limit(1);

  res.json({
    shamCashQrMediaId: row?.shamCashQrMediaId ?? null,
    shamCashAccountName: row?.shamCashAccountName ?? null,
    shamCashAccountNumber: row?.shamCashAccountNumber ?? null,
    shamCashInstructionsAr: row?.shamCashInstructionsAr ?? null,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  });
});

/**
 * PATCH /admin/payment-settings
 *
 * Partial by design: an admin reissuing the QR should not have to retype the
 * account number, and a typo in one field must not blank the others.
 */
router.patch("/admin/payment-settings", requireAdmin, async (req, res): Promise<void> => {
  const parsed = settingsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payment settings" });
    return;
  }

  const patch = parsed.data;

  // Verify the media id really is a ready payment QR before pointing students
  // at it. Without this an admin could set it to any asset id — including
  // another student's private recording, which would then be served to
  // everyone as a "QR".
  if (patch.shamCashQrMediaId != null) {
    const [asset] = await db
      .select({
        purpose: mediaAssetsTable.purpose,
        status: mediaAssetsTable.status,
      })
      .from(mediaAssetsTable)
      .where(eq(mediaAssetsTable.id, patch.shamCashQrMediaId))
      .limit(1);

    if (!asset || asset.purpose !== "payment_qr" || asset.status !== "ready") {
      res.status(400).json({
        error: "That media id is not a completed payment QR upload",
      });
      return;
    }
  }

  // Only the keys actually sent are written, so an omitted field keeps its
  // value rather than being overwritten with undefined.
  const update: Record<string, unknown> = { updatedBy: req.session.userId! };
  if ("shamCashQrMediaId" in patch) update.shamCashQrMediaId = patch.shamCashQrMediaId;
  if ("shamCashAccountName" in patch) update.shamCashAccountName = patch.shamCashAccountName;
  if ("shamCashAccountNumber" in patch) update.shamCashAccountNumber = patch.shamCashAccountNumber;
  if ("shamCashInstructionsAr" in patch) update.shamCashInstructionsAr = patch.shamCashInstructionsAr;

  const [row] = await db
    .update(paymentSettingsTable)
    .set(update)
    .where(eq(paymentSettingsTable.id, SETTINGS_ROW_ID))
    .returning();

  logger.info(
    { adminId: req.session.userId, fields: Object.keys(patch) },
    "ShamCash payment settings updated",
  );

  res.json({
    shamCashQrMediaId: row?.shamCashQrMediaId ?? null,
    shamCashAccountName: row?.shamCashAccountName ?? null,
    shamCashAccountNumber: row?.shamCashAccountNumber ?? null,
    shamCashInstructionsAr: row?.shamCashInstructionsAr ?? null,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  });
});

export default router;
