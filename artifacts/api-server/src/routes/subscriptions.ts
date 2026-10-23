import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, subscriptionPlansTable, studentSubscriptionsTable } from "@workspace/db";
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

router.post("/subscription", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const { planCode, paymentMethod, paymentReference } = req.body;

  if (!["general_english", "professional_english"].includes(planCode)) {
    res.status(400).json({ error: "Invalid plan code" });
    return;
  }

  const [plan] = await db.select().from(subscriptionPlansTable)
    .where(eq(subscriptionPlansTable.code, planCode)).limit(1);
  if (!plan) { res.status(400).json({ error: "Plan not found" }); return; }

  const paymentNote = `Payment method: ${paymentMethod}. Reference: ${paymentReference ?? "N/A"}. Awaiting verification.`;

  // Deactivate old active subscriptions
  await db.update(studentSubscriptionsTable)
    .set({ status: "cancelled" })
    .where(and(eq(studentSubscriptionsTable.userId, userId), eq(studentSubscriptionsTable.status, "active")));

  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + 1);

  const [sub] = await db.insert(studentSubscriptionsTable).values({
    userId,
    planCode,
    planName: plan.name,
    planNameAr: plan.nameAr,
    status: "pending_payment",
    paymentMethod,
    paymentReference: paymentReference ?? null,
    paymentNote,
    startedAt: new Date(),
    expiresAt,
  }).returning();

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

export default router;
