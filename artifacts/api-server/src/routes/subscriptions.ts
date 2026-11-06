import { Router, type IRouter } from "express";
import { eq, and, desc, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  subscriptionPlansTable,
  studentSubscriptionsTable,
  paymentSubmissionsTable,
  mediaAssetsTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { cached, CK, TTL } from "../services/cache";
import { getWalletDetails, getCryptoDetails } from "../services/payment-settings";
import { checkWalletAddress } from "../services/crypto-config";
import { getPricingConfig, priceSypFor } from "../services/syp-rate";
import { subscriptionInForce } from "../services/entitlements";
import { isValidTxHash } from "../services/crypto-verify-policy";
import { verifySubmission } from "../services/crypto-verify";
import { sweepUnmatchedSms } from "../services/wallet-sms";

const router: IRouter = Router();

/**
 * GET /subscription-plans
 * Cache: 1 h — plan definitions are extremely stable; change requires admin action.
 * Subscription ACCESS STATUS is NOT cached here (that remains DB-authoritative).
 */
router.get("/subscription-plans", async (_req, res): Promise<void> => {
  const plans = await cached(CK.subPlans(), TTL.SUBSCRIPTION_PLANS, async () => {
    const [rows, pricing] = await Promise.all([
      db
        .select()
        .from(subscriptionPlansTable)
        .where(eq(subscriptionPlansTable.isActive, true)),
      getPricingConfig(),
    ]);
    return rows.map((p) => {
      // The price a student is charged: computed from the stored rate when
      // automatic pricing is on, the admin's figure otherwise. Cached with the
      // plans, and invalidated whenever the rate or a price changes.
      const effective = priceSypFor(pricing, p.priceUsd, p.priceSyp);
      return {
      id: p.id,
      code: p.code,
      name: p.name,
      nameAr: p.nameAr,
      description: p.description ?? null,
      descriptionAr: p.descriptionAr ?? null,
      priceUsd: p.priceUsd,
      currency: p.currency,
      billingCycle: p.billingCycle,
      features: p.features ?? [],
      featuresAr: p.featuresAr ?? [],
      includesConversationPartner: p.includesConversationPartner,
      lessonTrack: p.lessonTrack,
      lessonsPerMonth: p.lessonsPerMonth,
      callsPerMonth: p.callsPerMonth,
      priceSyp: effective === null ? null : effective.toFixed(2),
      /**
       * The admin's own figure, whatever the mode. The admin screen edits this
       * one; students only ever see `priceSyp`.
       */
      priceSypManual: p.priceSyp,
      };
    });
  });

  res.json(plans);
});

/**
 * GET /subscription
 * Per-user subscription status — authoritative, never cached.
 */
router.get("/subscription", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  // The same test the lesson gate applies (services/entitlements.ts): active
  // AND not past its expiry. Filtering on status alone kept showing a lapsed
  // subscription as "active, valid until …" until the hourly sweep flipped its
  // status — while every lesson was already locked, because the gate checks
  // the timestamp. The page and the gate must agree on what the student has.
  const [sub] = await db.select().from(studentSubscriptionsTable)
    .where(subscriptionInForce(userId))
    .limit(1);

  if (!sub) {
    res.json({
      id: 0,
      studentId: userId,
      planCode: "free",
      planName: "Free Plan",
      planNameAr: "الخطة المجانية",
      status: "active",
      startedAt: new Date().toISOString(),
      expiresAt: null,
      paymentMethod: null,
      paymentNote: null,
    });
    return;
  }

  res.json({
    id: sub.id,
    studentId: userId,
    planCode: sub.planCode,
    planName: sub.planName,
    planNameAr: sub.planNameAr,
    status: sub.status,
    startedAt: sub.startedAt.toISOString(),
    expiresAt: sub.expiresAt?.toISOString() ?? null,
    paymentMethod: sub.paymentMethod ?? null,
    paymentNote: sub.paymentNote ?? null,
  });
});

/**
 * Payment methods we accept.
 *
 * Whitelisted, like planCode. Previously this value went straight from the
 * request body into the database and into an interpolated note string.
 */
/**
 * `sham_cash` is absent: it is retained in the database enum for the rows that
 * already carry it, but no new submission may name it.
 */
const PAYMENT_METHODS = ["syriatel_cash", "crypto_usdt_bep20"] as const;
type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * The four sellable plans. `free` is absent deliberately: it is what a student
 * has before paying, not something to buy.
 */
const SELLABLE_PLANS = [
  "general_basic",
  "general_plus",
  "pro_basic",
  "pro_plus",
] as const;

/**
 * How long a SYP quote holds. Long enough to pay in a wallet app and come back,
 * short enough that a returning student is not held to last week's rate.
 */
const QUOTE_VALID_MS = 48 * 3600_000;

const createSubscriptionSchema = z.object({
  planCode: z.enum(SELLABLE_PLANS),
  paymentMethod: z.enum(PAYMENT_METHODS),
});

/**
 * POST /subscription
 *
 * Opens a subscription at `pending_payment`. It grants nothing: the student
 * then submits proof of payment, and activation happens only once that proof
 * is verified — see services/subscription-activation.ts.
 *
 * Three things this deliberately does NOT do, each of which it used to:
 *
 *   * It does not cancel the student's current subscription. Doing that before
 *     the new one was paid for downgraded anyone who abandoned an upgrade.
 *     Superseding happens inside the activation transaction.
 *   * It does not set `expiresAt`. The clock starts when payment is confirmed,
 *     or a subscription approved three days later loses three days.
 *   * It does not interpolate request values into a note string.
 */
router.post("/subscription", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;

  const parsed = createSubscriptionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid plan code or payment method" });
    return;
  }
  const { planCode, paymentMethod } = parsed.data;

  const [plan] = await db.select().from(subscriptionPlansTable)
    .where(eq(subscriptionPlansTable.code, planCode)).limit(1);
  if (!plan) { res.status(400).json({ error: "Plan not found" }); return; }

  // Crypto is offered only once an admin has set a receiving address or QR.
  // The UI hides the option otherwise; this refuses a request that bypasses it,
  // which would leave a student with a pending subscription and nowhere to pay.
  if (paymentMethod === "crypto_usdt_bep20" && !(await getCryptoDetails()).configured) {
    res.status(409).json({
      error: "Crypto payments are not available",
      errorAr: "الدفع بالعملات الرقمية غير متاح حالياً.",
    });
    return;
  }

  // The SYP price is quoted now and the payment is checked against the quote.
  // With an automatic rate the price moves, and a student who reads 290 ل.س and
  // pays it must not be checked against 295 because the rate refreshed while
  // they were in their wallet app.
  const quote = priceSypFor(await getPricingConfig(), plan.priceUsd, plan.priceSyp);
  const quoteFields = {
    quotedPriceSyp: quote === null ? null : quote.toFixed(2),
    quotedAt: new Date(),
  };

  // Reuse an existing unpaid attempt for the same plan rather than opening a
  // second one. A student who reloads the payment page should not accumulate
  // pending subscriptions, each with its own submissions, for one purchase.
  const [existingPending] = await db
    .select()
    .from(studentSubscriptionsTable)
    .where(
      and(
        eq(studentSubscriptionsTable.userId, userId),
        eq(studentSubscriptionsTable.status, "pending_payment"),
        eq(studentSubscriptionsTable.planCode, planCode),
      ),
    )
    .limit(1);

  // A reused attempt takes the method chosen now and a fresh quote once the
  // old one is stale — a quote from last week would hold a student to a rate
  // the market has left behind, in either direction.
  const quoteStale =
    !existingPending?.quotedAt ||
    Date.now() - existingPending.quotedAt.getTime() > QUOTE_VALID_MS;

  const sub = existingPending
    ? (
        await db
          .update(studentSubscriptionsTable)
          .set({ paymentMethod, ...(quoteStale ? quoteFields : {}) })
          .where(eq(studentSubscriptionsTable.id, existingPending.id))
          .returning()
      )[0]
    : (
        await db.insert(studentSubscriptionsTable).values({
          userId,
          planCode,
          planName: plan.name,
          planNameAr: plan.nameAr,
          status: "pending_payment",
          paymentMethod,
          startedAt: new Date(),
          ...quoteFields,
          // expiresAt stays null until activation sets it.
        }).returning()
      )[0];

  res.json({
    id: sub.id,
    studentId: userId,
    planCode: sub.planCode,
    planName: sub.planName,
    planNameAr: sub.planNameAr,
    status: sub.status,
    startedAt: sub.startedAt.toISOString(),
    expiresAt: sub.expiresAt?.toISOString() ?? null,
    paymentMethod: sub.paymentMethod ?? null,
    paymentNote: sub.paymentNote ?? null,
    priceUsd: plan.priceUsd,
    /** The quoted SYP price — what the payment step shows and checks against. */
    priceSyp: sub.quotedPriceSyp ?? null,
  });
});

/**
 * GET /subscription/payment-submissions
 *
 * The student's own submissions, newest first, so the payment page can show
 * what is under review and why anything was rejected.
 */
router.get(
  "/subscription/payment-submissions",
  requireAuth,
  async (req, res): Promise<void> => {
    const userId = req.session.userId!;

    const rows = await db
      .select()
      .from(paymentSubmissionsTable)
      .where(eq(paymentSubmissionsTable.userId, userId))
      .orderBy(desc(paymentSubmissionsTable.createdAt))
      .limit(20);

    res.json(
      rows.map((r) => ({
        id: r.id,
        subscriptionId: r.subscriptionId,
        method: r.method,
        status: r.status,
        amountExpected: r.amountExpected,
        txHash: r.txHash ?? null,
        studentNote: r.studentNote ?? null,
        // The admin's note is shown to the student: a rejection they cannot
        // see the reason for is a support ticket.
        reviewNote: r.reviewNote ?? null,
        createdAt: r.createdAt.toISOString(),
        reviewedAt: r.reviewedAt?.toISOString() ?? null,
      })),
    );
  },
);

/**
 * GET /subscription/payment-details
 *
 * Everything a student needs on screen to pay. ShamCash details come from the
 * admin-managed settings row; the crypto side is step 4.
 */
router.get("/subscription/payment-details", requireAuth, async (_req, res): Promise<void> => {
  const [wallet, crypto] = await Promise.all([getWalletDetails(), getCryptoDetails()]);

  res.json({
    wallet,
    crypto: {
      ...crypto,
      /**
       * The network, carried explicitly so the UI can shout about it. A
       * student who sends TRC-20 USDT to a 0x address loses the money
       * permanently, and 0x addresses look valid on Ethereum too.
       */
      network: "BEP20",
      networkLabel: "BNB Smart Chain (BEP-20)",
      tokenSymbol: "USDT",
    },
  });
});

const submissionSchema = z.object({
  subscriptionId: z.number().int().positive(),
  /**
   * The receipt image, from the media upload handshake. Required for ShamCash:
   * a claim with no proof is not reviewable, and an admin would have to reject
   * it anyway.
   */
  receiptMediaId: z.number().int().positive(),
  /** The student describing what they did. Shown to the admin as-is. */
  studentNote: z.string().trim().max(2000).optional(),
});

/**
 * POST /subscription/payment-submissions
 *
 * A student saying "I paid, here is the proof". Creates a pending submission
 * for an admin to review; it grants nothing on its own.
 */
router.post(
  "/subscription/payment-submissions",
  requireAuth,
  async (req, res): Promise<void> => {
    const userId = req.session.userId!;

    const parsed = submissionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "A receipt image and subscription are required" });
      return;
    }
    const { subscriptionId, receiptMediaId, studentNote } = parsed.data;

    // The subscription must be the caller's own and still awaiting payment.
    // Checked rather than trusted: the id comes from the request body, and
    // without this a student could attach a receipt to someone else's
    // subscription and have an admin activate it.
    const [subscription] = await db
      .select()
      .from(studentSubscriptionsTable)
      .where(
        and(
          eq(studentSubscriptionsTable.id, subscriptionId),
          eq(studentSubscriptionsTable.userId, userId),
          eq(studentSubscriptionsTable.status, "pending_payment"),
        ),
      )
      .limit(1);

    if (!subscription) {
      res.status(404).json({ error: "No pending subscription found" });
      return;
    }

    // The receipt must be this student's own completed upload of the right
    // purpose — the same check assertUsableRecording makes for audio, for the
    // same reason: a media id from the body is otherwise a pointer to any
    // object in the bucket.
    const [asset] = await db
      .select({
        ownerUserId: mediaAssetsTable.ownerUserId,
        purpose: mediaAssetsTable.purpose,
        status: mediaAssetsTable.status,
      })
      .from(mediaAssetsTable)
      .where(eq(mediaAssetsTable.id, receiptMediaId))
      .limit(1);

    if (
      !asset ||
      asset.purpose !== "payment_receipt" ||
      asset.status !== "ready" ||
      asset.ownerUserId !== userId
    ) {
      res.status(400).json({ error: "That receipt upload is not usable" });
      return;
    }

    // Don't stack submissions: a student who sends a second receipt while one
    // is still pending would otherwise give the admin two rows to reconcile
    // for one payment.
    const [existingPending] = await db
      .select({ id: paymentSubmissionsTable.id })
      .from(paymentSubmissionsTable)
      .where(
        and(
          eq(paymentSubmissionsTable.subscriptionId, subscriptionId),
          // Both unresolved statuses. Blocking only on `pending` let a student
          // whose first claim was still `verifying` open a second one, leaving
          // an admin two rows to reconcile for one payment. A `rejected`
          // submission is deliberately NOT counted: correcting a refused
          // receipt is exactly what a student should be able to do.
          inArray(paymentSubmissionsTable.status, ["pending", "verifying"]),
        ),
      )
      .limit(1);

    if (existingPending) {
      res.status(409).json({
        error: "A payment for this subscription is already under review",
        submissionId: existingPending.id,
      });
      return;
    }

    const [plan] = await db
      .select({ priceUsd: subscriptionPlansTable.priceUsd })
      .from(subscriptionPlansTable)
      .where(sql`${subscriptionPlansTable.code} = ${subscription.planCode}`)
      .limit(1);

    if (!plan) {
      res.status(400).json({ error: "Plan not found" });
      return;
    }

    const [submission] = await db
      .insert(paymentSubmissionsTable)
      .values({
        subscriptionId,
        userId,
        method: "syriatel_cash",
        status: "pending",
        // Snapshotted: a price change before review must not invalidate a
        // payment that was correct when it was made.
        amountExpected: plan.priceUsd.toFixed(2),
        receiptMediaId,
        studentNote: studentNote ?? null,
      })
      .returning();

    res.status(201).json({
      id: submission.id,
      subscriptionId: submission.subscriptionId,
      method: submission.method,
      status: submission.status,
      amountExpected: submission.amountExpected,
      createdAt: submission.createdAt.toISOString(),
    });
  },
);

const cryptoSubmissionSchema = z.object({
  subscriptionId: z.number().int().positive(),
  txHash: z.string().trim(),
});

/**
 * POST /subscription/crypto-submissions
 *
 * The automated path. A student sends USDT to our wallet and gives us the
 * transaction hash; we look it up on BNB Smart Chain and, if it genuinely paid
 * the right amount to the right address with the right token, activate without
 * anyone reviewing it.
 */
router.post(
  "/subscription/crypto-submissions",
  requireAuth,
  async (req, res): Promise<void> => {
    const userId = req.session.userId!;

    // Offered only once an admin has set an address or a QR.
    const crypto = await getCryptoDetails();
    if (!crypto.configured) {
      res.status(503).json({
        error: "Crypto payments are not available",
        errorAr: "الدفع بالعملات الرقمية غير متاح حالياً.",
      });
      return;
    }

    const parsed = cryptoSubmissionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "A subscription and transaction hash are required" });
      return;
    }

    const subscriptionId = parsed.data.subscriptionId;
    // Normalised once. The unique index is on lower(tx_hash), so storing mixed
    // case would let the same transaction be submitted twice in two spellings.
    const txHash = parsed.data.txHash.toLowerCase();

    if (!isValidTxHash(txHash)) {
      res.status(400).json({
        error: "That does not look like a BNB Smart Chain transaction hash",
        errorAr: "معرّف العملية غير صحيح. يجب أن يبدأ بـ 0x ويتكون من 64 خانة.",
      });
      return;
    }

    const [subscription] = await db
      .select()
      .from(studentSubscriptionsTable)
      .where(
        and(
          eq(studentSubscriptionsTable.id, subscriptionId),
          eq(studentSubscriptionsTable.userId, userId),
          eq(studentSubscriptionsTable.status, "pending_payment"),
        ),
      )
      .limit(1);

    if (!subscription) {
      res.status(404).json({ error: "No pending subscription found" });
      return;
    }

    const [plan] = await db
      .select({ priceUsd: subscriptionPlansTable.priceUsd })
      .from(subscriptionPlansTable)
      .where(sql`${subscriptionPlansTable.code} = ${subscription.planCode}`)
      .limit(1);

    if (!plan) {
      res.status(400).json({ error: "Plan not found" });
      return;
    }

    let submissionId: number;

    try {
      const [submission] = await db
        .insert(paymentSubmissionsTable)
        .values({
          subscriptionId,
          userId,
          method: "crypto_usdt_bep20",
          // `verifying` when the chain can decide; `pending` when there is no
          // address to check the recipient against (a QR-only setup), so it
          // goes straight to an admin instead of waiting on a check that
          // cannot succeed.
          status: crypto.autoVerify ? "verifying" : "pending",
          amountExpected: plan.priceUsd.toFixed(2),
          txHash,
          // The address it is checked against, fixed now. A later change in
          // settings must not re-point a payment that is already in flight.
          expectedWalletAddress: crypto.walletAddress,
        })
        .returning();
      submissionId = submission.id;
    } catch (err) {
      // The unique index on lower(tx_hash) is what stops one paid transaction
      // buying ten subscriptions. Catching the violation here turns it into a
      // clear refusal rather than a 500 — and it is the database, not a prior
      // SELECT, that decides, so two simultaneous submissions cannot both win.
      const code =
        (err as { code?: string })?.code ??
        (err as { cause?: { code?: string } })?.cause?.code;
      if (code === "23505") {
        res.status(409).json({
          error: "That transaction has already been used for a subscription",
          errorAr: "تم استخدام معرّف هذه العملية مسبقاً لاشتراك آخر.",
        });
        return;
      }
      throw err;
    }

    // Check now so a student who already has their confirmations is activated
    // while they are still looking at the screen. Not awaited: an RPC round
    // trip must not hold the response open, and the sweeper re-checks anything
    // this misses.
    if (crypto.autoVerify) {
      void verifySubmission(submissionId).catch(() => {
        // Already logged inside; the sweeper will try again.
      });
    }

    res.status(201).json({
      id: submissionId,
      subscriptionId,
      method: "crypto_usdt_bep20",
      status: crypto.autoVerify ? "verifying" : "pending",
      amountExpected: plan.priceUsd.toFixed(2),
    });
  },
);

const walletSubmissionSchema = z.object({
  subscriptionId: z.number().int().positive(),
  /**
   * رقم العملية from the payer's SMS. Digits only, and bounded: Syriatel's are
   * around twelve, but the exact length is undocumented and the point of the
   * check is to reject obvious nonsense, not to assert a format Syriatel never
   * promised.
   */
  operationNumber: z.string().trim().regex(/^\d{4,24}$/),
  /** What the student says they transferred, in SYP. */
  amountSyp: z.number().positive().max(100_000_000),
  studentNote: z.string().trim().max(2000).optional(),
  /** Optional: a receipt screenshot, if they took one. */
  receiptMediaId: z.number().int().positive().optional(),
});

/**
 * POST /subscription/wallet-submissions
 *
 * A Syriatel Cash payment. The student gives the operation number from their
 * own confirmation SMS; the companion app forwards the merchant's copy of the
 * same message, and the two are matched on that number.
 *
 * Verification is therefore automatic when both halves are present — but this
 * endpoint never activates anything itself. It records the claim and lets the
 * matcher decide, so a submission that arrives before its SMS (or after, which
 * is the common order) is handled the same way.
 */
router.post(
  "/subscription/wallet-submissions",
  requireAuth,
  async (req, res): Promise<void> => {
    const userId = req.session.userId!;

    const parsed = walletSubmissionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "A subscription, operation number and amount are required",
        errorAr: "رقم العملية والمبلغ مطلوبان.",
      });
      return;
    }
    const { subscriptionId, operationNumber, amountSyp, studentNote, receiptMediaId } =
      parsed.data;

    // The subscription must be the caller's own and still awaiting payment.
    // Checked rather than trusted: the id comes from the request body, and
    // without this a student could attach a payment to someone else's.
    const [subscription] = await db
      .select()
      .from(studentSubscriptionsTable)
      .where(
        and(
          eq(studentSubscriptionsTable.id, subscriptionId),
          eq(studentSubscriptionsTable.userId, userId),
          eq(studentSubscriptionsTable.status, "pending_payment"),
        ),
      )
      .limit(1);

    if (!subscription) {
      res.status(404).json({ error: "No pending subscription found" });
      return;
    }

    const [plan] = await db
      .select({
        priceUsd: subscriptionPlansTable.priceUsd,
        priceSyp: subscriptionPlansTable.priceSyp,
      })
      .from(subscriptionPlansTable)
      .where(sql`${subscriptionPlansTable.code} = ${subscription.planCode}`)
      .limit(1);

    if (!plan) {
      res.status(400).json({ error: "Plan not found" });
      return;
    }

    // No SYP price means an admin has not set one, and there is nothing to
    // verify the payment against. Refusing is the only honest answer: guessing
    // a rate here would either reject a correct payment or undercharge.
    // The quote the student was shown when they opened this subscription, while
    // it holds; the current price after that. Checking against the live price
    // instead would fail a correct payment whenever the rate moved in between.
    const quoteFresh =
      subscription.quotedPriceSyp !== null &&
      subscription.quotedAt !== null &&
      Date.now() - subscription.quotedAt.getTime() <= QUOTE_VALID_MS;
    const currentPrice = priceSypFor(await getPricingConfig(), plan.priceUsd, plan.priceSyp);
    const expectedSyp = quoteFresh
      ? subscription.quotedPriceSyp
      : currentPrice === null
        ? null
        : currentPrice.toFixed(2);

    if (expectedSyp === null) {
      res.status(503).json({
        error: "This plan has no Syrian pound price configured",
        errorAr: "لم يتم تحديد سعر هذه الباقة بالليرة السورية بعد.",
      });
      return;
    }

    // Don't stack submissions: a second claim while one is pending gives the
    // admin two rows to reconcile for one payment.
    const [existingPending] = await db
      .select({ id: paymentSubmissionsTable.id })
      .from(paymentSubmissionsTable)
      .where(
        and(
          eq(paymentSubmissionsTable.subscriptionId, subscriptionId),
          // Both unresolved statuses. Blocking only on `pending` let a student
          // whose first claim was still `verifying` open a second one, leaving
          // an admin two rows to reconcile for one payment. A `rejected`
          // submission is deliberately NOT counted: correcting a refused
          // receipt is exactly what a student should be able to do.
          inArray(paymentSubmissionsTable.status, ["pending", "verifying"]),
        ),
      )
      .limit(1);

    if (existingPending) {
      res.status(409).json({
        error: "A payment for this subscription is already under review",
        submissionId: existingPending.id,
      });
      return;
    }

    let submissionId: number;
    try {
      const [submission] = await db
        .insert(paymentSubmissionsTable)
        .values({
          subscriptionId,
          userId,
          method: "syriatel_cash",
          // `verifying`, not `pending`: the matcher decides next, and a claim
          // nobody has checked yet should not sit in the admin queue.
          status: "verifying",
          amountExpected: plan.priceUsd.toFixed(2),
          amountExpectedSyp: expectedSyp,
          amountClaimedSyp: amountSyp.toFixed(2),
          operationNumber,
          studentNote: studentNote ?? null,
          receiptMediaId: receiptMediaId ?? null,
        })
        .returning();
      submissionId = submission.id;
    } catch (err) {
      // The unique index on operation_number is what stops one payment buying
      // several subscriptions. Catching it here turns the violation into a
      // clear refusal rather than a 500 — and it is the database, not a prior
      // SELECT, that decides, so two simultaneous claims cannot both win.
      // Drizzle wraps the driver error, so the Postgres code can be on the
      // error or on its cause.
      if (
        (err as { code?: string })?.code === "23505" ||
        (err as { cause?: { code?: string } })?.cause?.code === "23505"
      ) {
        res.status(409).json({
          error: "That operation number has already been used",
          errorAr: "تم استخدام رقم هذه العملية مسبقاً.",
        });
        return;
      }
      throw err;
    }

    // Try to match straight away, in case the SMS already arrived — which is
    // the usual order. Not awaited: the student should not wait on it, and the
    // sweep re-checks anything this misses.
    void sweepUnmatchedSms().catch(() => {
      // Already logged inside; the sweeper will try again.
    });

    res.status(201).json({
      id: submissionId,
      subscriptionId,
      method: "syriatel_cash",
      status: "verifying",
      amountExpected: plan.priceUsd.toFixed(2),
      amountExpectedSyp: expectedSyp,
    });
  },
);

export default router;
