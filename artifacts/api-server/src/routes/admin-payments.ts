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
import { randomBytes } from "node:crypto";
import { asc, count, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  paymentSubmissionsTable,
  paymentSettingsTable,
  subscriptionPlansTable,
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
import { invalidate, CK } from "../services/cache";
import { checkWalletAddress } from "../services/crypto-config";
import { refreshSypRate, sptodayConfigured } from "../services/syp-rate";
import { OLD_PER_NEW } from "../services/syp-rate-policy";
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
      planName: studentSubscriptionsTable.planName,
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
        planName: r.planName,
        planNameAr: r.planNameAr,
        method: r.submission.method,
        status: r.submission.status,
        amountExpected: r.submission.amountExpected,
        receiptUrl,
        studentNote: r.submission.studentNote ?? null,
        operationNumber: r.submission.operationNumber ?? null,
        amountClaimedSyp: r.submission.amountClaimedSyp ?? null,
        amountExpectedSyp: r.submission.amountExpectedSyp ?? null,
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
    // Both statuses, because both are a payment nobody has resolved. A
    // submission stuck in `verifying` — its SMS never arrived, or the student
    // mistyped the number — needs an admin exactly as much as a `pending` one,
    // and counting only `pending` made those invisible.
    const [row] = await db
      .select({ value: count() })
      .from(paymentSubmissionsTable)
      .where(
        inArray(paymentSubmissionsTable.status, ["pending", "verifying"]),
      );

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
      if (outcome.reason === "subscription_not_pending") {
        // Approving would restart a subscription that is already active (or
        // revive a cancelled one). The payment is probably a second one for
        // the same plan, which is a refund conversation, not an activation.
        res.status(code).json({
          error:
            "This subscription is no longer waiting for payment; it was already activated or cancelled. Reject this submission and settle it with the student.",
          errorAr:
            "هذا الاشتراك لم يعد بانتظار الدفع، فقد تم تفعيله أو إلغاؤه. ارفض هذا الطلب وتواصل مع الطالب.",
          code: outcome.reason,
        });
        return;
      }
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
   * Media ids from the upload handshake, purpose `payment_qr`. Verified below —
   * a client could otherwise point either at any asset in the bucket.
   */
  walletQrMediaId: z.number().int().positive().nullable().optional(),
  walletAccountName: z.string().trim().max(200).nullable().optional(),
  walletAccountNumber: z.string().trim().max(100).nullable().optional(),
  walletInstructionsAr: z.string().trim().max(4000).nullable().optional(),
  walletMerchantPhone: z.string().trim().max(40).nullable().optional(),

  /** Null removes it. Validated as a BEP-20 address below. */
  cryptoWalletAddress: z.string().trim().max(100).nullable().optional(),
  cryptoQrMediaId: z.number().int().positive().nullable().optional(),

  sypRateAuto: z.boolean().optional(),
  sypUnit: z.enum(["new", "old"]).optional(),
});

type SettingsRow = typeof paymentSettingsTable.$inferSelect;

/**
 * What the admin screen is given. One builder for GET and PATCH, so the two
 * cannot drift apart.
 */
async function settingsResponse(row: SettingsRow | undefined) {
  // Who last changed the crypto details, by name. The address decides where
  // money goes and nothing reviews a crypto payment, so a change has to be
  // visibly attributable to someone.
  let cryptoUpdatedByName: string | null = null;
  if (row?.cryptoUpdatedBy) {
    const [user] = await db
      .select({ name: usersTable.name, email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, row.cryptoUpdatedBy))
      .limit(1);
    cryptoUpdatedByName = user?.name || user?.email || null;
  }

  return {
    walletProvider: row?.walletProvider ?? "syriatel_cash",
    walletQrMediaId: row?.walletQrMediaId ?? null,
    walletAccountName: row?.walletAccountName ?? null,
    walletAccountNumber: row?.walletAccountNumber ?? null,
    walletInstructionsAr: row?.walletInstructionsAr ?? null,
    walletMerchantPhone: row?.walletMerchantPhone ?? null,
    // Whether a token exists, never the token: it is shown once, when
    // generated, because anything holding it can mint a subscription.
    hasIngestToken: Boolean(row?.smsIngestToken),

    cryptoWalletAddress: row?.cryptoWalletAddress ?? null,
    cryptoQrMediaId: row?.cryptoQrMediaId ?? null,
    cryptoUpdatedAt: row?.cryptoUpdatedAt?.toISOString() ?? null,
    cryptoUpdatedByName,

    sypRateAuto: row?.sypRateAuto ?? false,
    sypUnit: row?.sypUnit === "old" ? "old" : "new",
    sypRate: row?.sypRate ?? null,
    sypRateFetchedAt: row?.sypRateFetchedAt?.toISOString() ?? null,
    sypRateSourceUpdatedAt: row?.sypRateSourceUpdatedAt?.toISOString() ?? null,
    sypRateError: row?.sypRateError ?? null,
    // Whether a key is configured, never the key itself.
    sptodayConfigured: sptodayConfigured(),

    updatedAt: row?.updatedAt?.toISOString() ?? null,
  };
}

async function readSettings(): Promise<SettingsRow | undefined> {
  const [row] = await db
    .select()
    .from(paymentSettingsTable)
    .where(eq(paymentSettingsTable.id, SETTINGS_ROW_ID))
    .limit(1);
  return row;
}

/**
 * Whether a media id is a completed payment-QR upload.
 *
 * Without this an admin could set a QR to any asset id — including another
 * student's private recording, which would then be served to everyone.
 */
async function isPaymentQr(mediaId: number): Promise<boolean> {
  const [asset] = await db
    .select({ purpose: mediaAssetsTable.purpose, status: mediaAssetsTable.status })
    .from(mediaAssetsTable)
    .where(eq(mediaAssetsTable.id, mediaId))
    .limit(1);
  return Boolean(asset && asset.purpose === "payment_qr" && asset.status === "ready");
}

/** GET /admin/payment-settings — what students are currently shown. */
router.get("/admin/payment-settings", requireAdmin, async (_req, res): Promise<void> => {
  res.json(await settingsResponse(await readSettings()));
});

/**
 * PATCH /admin/payment-settings
 *
 * Partial by design: an admin reissuing a QR should not have to retype an
 * account number, and a typo in one field must not blank the others. Only the
 * keys actually sent are written.
 */
router.patch("/admin/payment-settings", requireAdmin, async (req, res): Promise<void> => {
  const parsed = settingsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payment settings" });
    return;
  }
  const patch = parsed.data;

  for (const id of [patch.walletQrMediaId, patch.cryptoQrMediaId]) {
    if (id != null && !(await isPaymentQr(id))) {
      res.status(400).json({ error: "That media id is not a completed payment QR upload" });
      return;
    }
  }

  const update: Record<string, unknown> = { updatedBy: req.session.userId! };
  if ("walletQrMediaId" in patch) update.walletQrMediaId = patch.walletQrMediaId;
  if ("walletAccountName" in patch) update.walletAccountName = patch.walletAccountName;
  if ("walletAccountNumber" in patch) update.walletAccountNumber = patch.walletAccountNumber;
  if ("walletInstructionsAr" in patch) update.walletInstructionsAr = patch.walletInstructionsAr;
  if ("walletMerchantPhone" in patch) update.walletMerchantPhone = patch.walletMerchantPhone;

  // ── Crypto: validated, and every change attributed ──────────────────────
  const touchesCrypto = "cryptoWalletAddress" in patch || "cryptoQrMediaId" in patch;
  if ("cryptoWalletAddress" in patch) {
    const raw = patch.cryptoWalletAddress;
    if (raw === null || raw === undefined || raw === "") {
      update.cryptoWalletAddress = null;
    } else {
      const checked = checkWalletAddress(raw);
      if (!checked.ok) {
        res.status(400).json(
          checked.error === "tron_address"
            ? {
                error: "That is a TRON (TRC-20) address. Payments here are on BNB Smart Chain (BEP-20) — use the BEP-20 deposit address, which starts with 0x.",
                errorAr: "هذا عنوان على شبكة ترون (TRC-20). الدفع هنا على شبكة BNB Smart Chain (BEP-20) — استخدم عنوان الإيداع الذي يبدأ بـ 0x.",
                code: "TRON_ADDRESS",
              }
            : {
                error: "That is not a valid BEP-20 address: it should be 0x followed by 40 hexadecimal characters.",
                errorAr: "العنوان غير صالح: يجب أن يبدأ بـ 0x ويليه 40 خانة.",
                code: "MALFORMED_ADDRESS",
              },
        );
        return;
      }
      update.cryptoWalletAddress = checked.address;
    }
  }
  if ("cryptoQrMediaId" in patch) update.cryptoQrMediaId = patch.cryptoQrMediaId;
  if (touchesCrypto) {
    update.cryptoUpdatedBy = req.session.userId!;
    update.cryptoUpdatedAt = new Date();
  }

  // ── Pricing ─────────────────────────────────────────────────────────────
  const before = await readSettings();
  if ("sypRateAuto" in patch) update.sypRateAuto = patch.sypRateAuto;
  if ("sypUnit" in patch && patch.sypUnit && patch.sypUnit !== before?.sypUnit) {
    update.sypUnit = patch.sypUnit;
    // The stored rate is expressed in the old unit setting. Re-express it
    // rather than leaving it a hundred times too large or too small until the
    // next fetch twelve hours away.
    if (before?.sypRate != null) {
      const rate = Number(before.sypRate);
      update.sypRate = (patch.sypUnit === "new" ? rate / OLD_PER_NEW : rate * OLD_PER_NEW).toFixed(4);
    }
  }

  const [row] = await db
    .update(paymentSettingsTable)
    .set(update)
    .where(eq(paymentSettingsTable.id, SETTINGS_ROW_ID))
    .returning();

  // A quote is a number in the unit that was set when it was taken, so a unit
  // change makes every open quote wrong by a factor of 100: a student could
  // send a hundredth of the price and be checked against the stale figure.
  // Cleared, so their next step is priced in the new unit.
  if (update.sypUnit) {
    await db
      .update(studentSubscriptionsTable)
      .set({ quotedPriceSyp: null, quotedAt: null })
      .where(eq(studentSubscriptionsTable.status, "pending_payment"));
  }

  const pricingChanged = "sypRateAuto" in patch || "sypUnit" in patch;

  // Turning automatic pricing on with no rate yet: fetch one now, so the
  // admin sees the result on this screen rather than twelve hours later.
  if (patch.sypRateAuto && row?.sypRate == null && sptodayConfigured()) {
    await refreshSypRate();
  }
  // Every price students see is derived from these, and plans are cached.
  if (pricingChanged) await invalidate(CK.subPlans());

  logger.info(
    {
      adminId: req.session.userId,
      fields: Object.keys(patch),
      // Logged in full: an address change is the one edit here that decides
      // where money goes with no review behind it.
      ...("cryptoWalletAddress" in patch
        ? { cryptoWalletAddress: update.cryptoWalletAddress ?? null }
        : {}),
    },
    "Payment settings updated",
  );

  res.json(await settingsResponse(await readSettings()));
});

/**
 * POST /admin/payment-settings/syp-rate/refresh
 *
 * Fetch the rate now rather than waiting for the twelve-hour cycle. Each call
 * spends one of the free tier's hundred a month, so the screen offers it as a
 * deliberate button, not something that runs on every visit.
 */
router.post(
  "/admin/payment-settings/syp-rate/refresh",
  requireAdmin,
  async (_req, res): Promise<void> => {
    if (!sptodayConfigured()) {
      res.status(503).json({ error: "SPTODAY_API_KEY is not configured" });
      return;
    }
    const outcome = await refreshSypRate();
    const body = await settingsResponse(await readSettings());
    res.status(outcome.ok ? 200 : 502).json(body);
  },
);

const planPriceSchema = z.object({
  priceUsd: z.number().min(0).max(100000).optional(),
  /**
   * Null withdraws the plan from the local wallet: the submission endpoint
   * refuses a plan with no SYP price rather than guessing a rate.
   */
  priceSyp: z.number().min(0).max(1_000_000_000).nullable().optional(),
});

/**
 * PATCH /admin/subscription-plans/:code/price
 *
 * Both prices are set by hand. The SYP figure is deliberately not derived from
 * the USD one: on 2026-11-02 the official CBS rate was ~122 SYP/USD while the
 * Damascus parallel market was ~143, and verifying a payment against the wrong
 * one either rejects a correct transfer or under-collects. Which rate a
 * student actually transacts at is a business judgement, not an API lookup.
 */
router.patch(
  "/admin/subscription-plans/:code/price",
  requireAdmin,
  async (req, res): Promise<void> => {
    const code = String(req.params.code);

    const parsed = planPriceSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid price" });
      return;
    }

    const update: Record<string, unknown> = {};
    if (parsed.data.priceUsd !== undefined) update.priceUsd = parsed.data.priceUsd;
    // `in` rather than `!== undefined`: an explicit null is meaningful here,
    // and is how a plan is withdrawn from the wallet.
    // `in` rather than a truthiness test, so an explicit null is honoured —
    // but zod leaves the type as `number | null | undefined`, and only null is
    // the withdrawal signal.
    if ("priceSyp" in parsed.data) {
      const syp = parsed.data.priceSyp;
      if (syp !== undefined) update.priceSyp = syp === null ? null : syp.toFixed(2);
    }

    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }

    const [row] = await db
      .update(subscriptionPlansTable)
      .set(update)
      .where(sql`${subscriptionPlansTable.code} = ${code}`)
      .returning({
        code: subscriptionPlansTable.code,
        priceUsd: subscriptionPlansTable.priceUsd,
        priceSyp: subscriptionPlansTable.priceSyp,
      });

    if (!row) {
      res.status(404).json({ error: "No such plan" });
      return;
    }

    // Plan definitions are cached for an hour, so a price change would
    // otherwise not reach students until it expired.
    await invalidate(CK.subPlans());

    logger.info({ adminId: req.session.userId, code, ...update }, "Plan price updated");
    res.json(row);
  },
);

/**
 * POST /admin/payment-settings/ingest-token
 *
 * Generates the companion app's bearer token and returns it ONCE.
 *
 * Never readable afterwards: anything that can POST a forwarded SMS can mint a
 * subscription, so the token is write-only from the server's side. Rotating it
 * invalidates the old one immediately, which is the intended way to retire a
 * lost handset.
 */
router.post(
  "/admin/payment-settings/ingest-token",
  requireAdmin,
  async (req, res): Promise<void> => {
    // 32 bytes of CSPRNG. Not a uuid: this is a credential, and a uuid's
    // structure is partly predictable.
    const token = randomBytes(32).toString("base64url");

    await db
      .update(paymentSettingsTable)
      .set({ smsIngestToken: token, updatedBy: req.session.userId! })
      .where(eq(paymentSettingsTable.id, SETTINGS_ROW_ID));

    logger.info(
      { adminId: req.session.userId },
      "Companion app ingest token rotated",
    );

    res.json({ token });
  },
);

export default router;
