import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  subscriptionPlansTable,
  studentSubscriptionsTable,
  paymentSubmissionsTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { cached, CK, TTL } from "../services/cache";

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

export default router;
