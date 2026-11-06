import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import {
  db, usersTable, studentProfilesTable, lessonProgressTable,
  studentSubscriptionsTable, levelsTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { subscriptionInForce } from "../services/entitlements";

const router: IRouter = Router();

/** Build the profile response shape, joining levels to get currentLevelCode for display */
async function buildProfileResponse(userId: number) {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  const [profile] = await db
    .select()
    .from(studentProfilesTable)
    .where(eq(studentProfilesTable.userId, userId))
    .limit(1);
  const [subscription] = await db
    .select()
    .from(studentSubscriptionsTable)
    // In force, not merely `active`: the same test the lesson gate uses.
    .where(subscriptionInForce(userId))
    .limit(1);

  const completedRows = await db
    .select()
    .from(lessonProgressTable)
    .where(and(eq(lessonProgressTable.userId, userId), eq(lessonProgressTable.passed, true)));

  // Derive currentLevelCode from the FK — preserved for frontend compatibility
  const [currentLevel] = profile?.currentLevelId
    ? await db.select().from(levelsTable).where(eq(levelsTable.id, profile.currentLevelId)).limit(1)
    : [undefined];

  return {
    id: profile?.id ?? null,
    userId: user?.id ?? null,
    name: user?.name ?? null,
    email: user?.email ?? null,
    // Derived from join — not stored directly in student_profiles anymore
    currentLevelCode: currentLevel?.code ?? null,
    currentLevelId: profile?.currentLevelId ?? null,
    curriculumId: profile?.curriculumId ?? null,
    streakDays: profile?.streakDays ?? 0,
    totalLessonsCompleted: completedRows.length,
    totalXp: profile?.totalXp ?? 0,
    placementCompleted: profile?.placementCompleted ?? false,
    subscriptionPlan: subscription?.planCode ?? null,
    bio: profile?.bio ?? null,
    preferredLanguage: user?.preferredLanguage ?? "ar",
    country: user?.country ?? "SY",
    createdAt: user?.createdAt ?? null,
  };
}

router.get("/profile", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  const [profile] = await db
    .select()
    .from(studentProfilesTable)
    .where(eq(studentProfilesTable.userId, userId))
    .limit(1);
  if (!user || !profile) { res.status(404).json({ error: "Profile not found" }); return; }
  res.json(await buildProfileResponse(userId));
});

router.patch("/profile", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const { name, bio, preferredLanguage, country } = req.body;

  const userUpdate: Record<string, unknown> = {};
  if (name) userUpdate.name = name;
  if (preferredLanguage) userUpdate.preferredLanguage = preferredLanguage;
  if (country) userUpdate.country = country;

  if (Object.keys(userUpdate).length > 0) {
    await db.update(usersTable).set(userUpdate).where(eq(usersTable.id, userId));
  }

  if (bio !== undefined) {
    await db.update(studentProfilesTable).set({ bio }).where(eq(studentProfilesTable.userId, userId));
  }

  res.json(await buildProfileResponse(userId));
});

export default router;
