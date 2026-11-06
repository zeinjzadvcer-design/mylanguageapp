import { Router, type IRouter } from "express";
import { eq, and, desc, inArray } from "drizzle-orm";
import {
  db,
  lessonProgressTable,
  lessonsTable,
  levelsTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { getWeaknessReport } from "../services/weakness";
import { resolvePlanCode } from "../services/ai-quota";

const router: IRouter = Router();

router.get("/review/recent", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;

  const recentProgress = await db.select().from(lessonProgressTable)
    .where(and(eq(lessonProgressTable.userId, userId), eq(lessonProgressTable.passed, true)))
    .orderBy(desc(lessonProgressTable.completedAt))
    .limit(10);

  if (recentProgress.length === 0) {
    res.json([]);
    return;
  }

  // Batch-fetch all lessons in a single query (was N+1)
  const lessonIds = recentProgress.map((p) => p.lessonId);
  const lessons = await db.select().from(lessonsTable).where(inArray(lessonsTable.id, lessonIds));
  const lessonMap = new Map(lessons.map((l) => [l.id, l]));

  // Batch-fetch all levels referenced by those lessons
  const levelIds = [...new Set(lessons.map((l) => l.levelId))];
  const levels = levelIds.length > 0
    ? await db.select().from(levelsTable).where(inArray(levelsTable.id, levelIds))
    : [];
  const levelMap = new Map(levels.map((l) => [l.id, l]));

  const result = recentProgress
    .map((p) => {
      const lesson = lessonMap.get(p.lessonId);
      if (!lesson) return null;
      const level = levelMap.get(lesson.levelId);
      return {
        id: lesson.id,
        levelId: lesson.levelId,
        levelCode: level?.code ?? "",
        title: lesson.title,
        titleAr: lesson.titleAr,
        description: lesson.description ?? null,
        descriptionAr: lesson.descriptionAr ?? null,
        order: lesson.order,
        lessonType: lesson.lessonType,
        estimatedMinutes: lesson.estimatedMinutes,
        isUnlocked: true,
        isCompleted: true,
        bestScore: p.bestScore ?? null,
        xpReward: lesson.xpReward,
      };
    })
    .filter(Boolean);

  res.json(result);
});

router.get("/review/weak-areas", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;

  const progress = await db.select().from(lessonProgressTable)
    .where(and(eq(lessonProgressTable.userId, userId)))
    .orderBy(desc(lessonProgressTable.attempts));

  // Weak areas: attempted but best score < 75% or failed
  const weakProgress = progress
    .filter((p) => p.bestScore !== null && p.bestScore < 75)
    .slice(0, 10);

  if (weakProgress.length === 0) {
    res.json([]);
    return;
  }

  // Batch-fetch all lessons in a single query (was N+1)
  const lessonIds = weakProgress.map((p) => p.lessonId);
  const lessons = await db.select().from(lessonsTable).where(inArray(lessonsTable.id, lessonIds));
  const lessonMap = new Map(lessons.map((l) => [l.id, l]));

  const result = weakProgress
    .map((p) => {
      const lesson = lessonMap.get(p.lessonId);
      if (!lesson) return null;
      return {
        lessonId: p.lessonId,
        lessonTitle: lesson.title,
        lessonTitleAr: lesson.titleAr,
        bestScore: p.bestScore ?? 0,
        attempts: p.attempts,
        lessonType: lesson.lessonType,
      };
    })
    .filter(Boolean);

  res.json(result);
});

/**
 * The student's skill profile: what they are good at, what needs work, and
 * which existing lessons to go back to.
 *
 * The profile and the recommendations are computed from marks already recorded
 * and cost nothing, so this is safe to call on every dashboard load. The Arabic
 * advice sentence costs a model call and is only written when `advice=true` is
 * asked for — and even then, failing to get it does not fail the request.
 */
router.get("/review/skills", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const withAdvice = req.query.advice === "true";

  res.json(
    await getWeaknessReport(userId, {
      // Shared with every other AI feature, so an admin is unlimited here too.
      subscriptionPlan: await resolvePlanCode(userId),
      withAdvice,
    }),
  );
});

export default router;
