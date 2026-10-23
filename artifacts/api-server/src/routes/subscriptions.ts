import { Router, type IRouter } from "express";
import { eq, and, desc, sql } from "drizzle-orm";
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
import { getShamCashDetails } from "../services/payment-settings";

const router: IRouter = Router();

/**
 * GET /subscription-plans
 * Cache: 1 h — plan definitions are extremely stable; change requires admin action.
 * Subscription ACCESS STATUS is NOT cached here (that remains DB-authoritative).
 */
router.get("/subscription-plans", async (_req, res): Promise<void> => {
  const plans = await cached(CK.subPlans(), TTL.SUBSCRIPTION_PLANS, async () => {
    const rows = await db
      .select()
      .from(subscriptionPlansTable)
      .where(eq(subscriptionPlansTable.isActive, true));
    return rows.map((p) => ({
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
      freeLessonQuota: p.freeLessonQuota,
    }));
  });

  res.json(plans);
});

/**
 * GET /subscription
 * Per-user subscription status — authoritative, never cached.
 */
router.get("/subscription", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const [sub] = await db.select().from(studentSubscriptionsTable)
    .where(and(eq(studentSubscriptionsTable.userId, userId), eq(studentSubscriptionsTable.status, "active")))
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
const PAYMENT_METHODS = ["sham_cash", "crypto_usdt_bep20"] as const;
type PaymentMethod = (typeof PAYMENT_METHODS)[number];

const createSubscriptionSchema = z.object({
  planCode: z.enum(["general_english", "professional_english"]),
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

  const sub = existingPending ?? (
    await db.insert(studentSubscriptionsTable).values({
      userId,
      planCode,
      planName: plan.name,
      planNameAr: plan.nameAr,
      status: "pending_payment",
      paymentMethod,
      startedAt: new Date(),
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
  const shamCash = await getShamCashDetails();
  res.json({ shamCash });
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
          eq(paymentSubmissionsTable.status, "pending"),
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
        method: "sham_cash",
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

export default router;
