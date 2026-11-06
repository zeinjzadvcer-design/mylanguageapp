import { Router, type IRouter } from "express";
import { eq, and, inArray, isNull, asc } from "drizzle-orm";
import {
  db,
  usersTable,
  studentProfilesTable,
  lessonProgressTable,
  lessonsTable,
  levelsTable,
  studentSubscriptionsTable,
  curriculaTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import {
  getCompletedLessonIds,
  deriveLessonStateWithOrders,
  getCurriculumLevels,
  publishedLessonFilter,
} from "../services/learning";

const router: IRouter = Router();

router.get("/dashboard", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;

  const [[user], [profile], [subscription]] = await Promise.all([
    db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1),
    db
      .select()
      .from(studentProfilesTable)
      .where(eq(studentProfilesTable.userId, userId))
      .limit(1),
    db
      .select()
      .from(studentSubscriptionsTable)
      .where(
        and(
          eq(studentSubscriptionsTable.userId, userId),
          eq(studentSubscriptionsTable.status, "active"),
        ),
      )
      .limit(1),
  ]);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  // Handle no-placement safely
  if (!profile) {
    res.json({
      student: {
        id: null,
        userId: user.id,
        name: user.name,
        email: user.email,
        currentLevelCode: null,
        currentLevelId: null,
        curriculumId: null,
        streakDays: 0,
        totalLessonsCompleted: 0,
        totalXp: 0,
        placementCompleted: false,
        subscriptionPlan: subscription?.planCode ?? null,
        bio: null,
        preferredLanguage: user.preferredLanguage,
        country: user.country,
        createdAt: user.createdAt,
      },
      currentCurriculum: null,
      currentLevel: null,
      nextLesson: null,
      lessonStateCounts: { locked: 0, available: 0, inProgress: 0, completed: 0 },
      lessons: [],
      totalLessonsCompleted: 0,
      totalLessonsInLevel: 0,
      levelProgressPercent: 0,
      weeklyProgress: { lessonsThisWeek: 0, xpThisWeek: 0, streakDays: 0 },
      recentActivity: [],
    });
    return;
  }

  // Fetch current level and curriculum in parallel
  const [currentLevelResult, curriculum] = await Promise.all([
    profile.currentLevelId
      ? db
          .select()
          .from(levelsTable)
          .where(eq(levelsTable.id, profile.currentLevelId))
          .limit(1)
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
    profile.curriculumId
      ? db
          .select()
          .from(curriculaTable)
          .where(eq(curriculaTable.id, profile.curriculumId))
          .limit(1)
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
  ]);

  const currentLevel = currentLevelResult;

  // Get all levels in the curriculum for ordering
  const allCurriculumLevels = profile.curriculumId
    ? await getCurriculumLevels(profile.curriculumId)
    : [];

  // Get all published lessons in current level
  const allLessonsInLevel = currentLevel
    ? await db
        .select()
        .from(lessonsTable)
        .where(
          and(
            eq(lessonsTable.levelId, currentLevel.id),
            publishedLessonFilter(),
          ),
        )
        .orderBy(asc(lessonsTable.order))
    : [];

  const [completedIds, allProgress] = await Promise.all([
    getCompletedLessonIds(userId),
    db.select().from(lessonProgressTable).where(eq(lessonProgressTable.userId, userId)),
  ]);

  // Derive lesson states for current level
  const currentLevelOrder = currentLevel?.order ?? null;
  const lessonStateCounts = { LOCKED: 0, AVAILABLE: 0, IN_PROGRESS: 0, COMPLETED: 0 };
  const lessonSummaries = allLessonsInLevel.map((lesson, idx) => {
    const prevLessonId = idx > 0 ? allLessonsInLevel[idx - 1].id : null;
    const progressRow = allProgress.find((p) => p.lessonId === lesson.id);
    const state = deriveLessonStateWithOrders(
      lesson,
      currentLevel?.order ?? 0,
      currentLevelOrder,
      completedIds,
      prevLessonId,
      progressRow?.status,
    );
    lessonStateCounts[state]++;
    // The full LessonSummary the spec promises. It used to stop at seven
    // fields, so the dashboard read estimatedMinutes off nextLesson and showed
    // "undefined minutes".
    return {
      id: lesson.id,
      levelId: lesson.levelId,
      levelCode: currentLevel?.code ?? "",
      title: lesson.title,
      titleAr: lesson.titleAr,
      description: lesson.description ?? null,
      descriptionAr: lesson.descriptionAr ?? null,
      order: lesson.order,
      lessonType: lesson.lessonType,
      estimatedMinutes: lesson.estimatedMinutes,
      state,
      isUnlocked: state !== "LOCKED",
      isCompleted: state === "COMPLETED",
      bestScore: progressRow?.bestScore ?? null,
      xpReward: lesson.xpReward,
    };
  });

  const completedInLevel = allLessonsInLevel.filter((l) => completedIds.has(l.id)).length;

  // Next lesson: first non-completed available lesson
  const nextLesson = lessonSummaries.find(
    (l) => l.state === "AVAILABLE" || l.state === "IN_PROGRESS",
  );

  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weeklyCompleted = allProgress.filter(
    (p) => p.completedAt && p.completedAt >= weekAgo && p.passed,
  );
  const xpThisWeek = weeklyCompleted.reduce((sum, p) => sum + p.xpEarned, 0);

  // Recent activity — 5 most recently completed
  const recentProgress = allProgress
    .filter((p) => p.completedAt !== null)
    .sort(
      (a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0),
    )
    .slice(0, 5);

  const recentActivity: Array<{
    lessonId: number;
    lessonTitle: string;
    lessonTitleAr: string;
    completedAt: string;
    score: number;
    passed: boolean;
  }> = [];

  if (recentProgress.length > 0) {
    const recentLessonIds = recentProgress.map((p) => p.lessonId);
    const fetchedLessons = await db
      .select()
      .from(lessonsTable)
      .where(inArray(lessonsTable.id, recentLessonIds));
    const lessonMap = new Map(fetchedLessons.map((l) => [l.id, l]));
    for (const p of recentProgress) {
      const lesson = lessonMap.get(p.lessonId);
      if (lesson) {
        recentActivity.push({
          lessonId: p.lessonId,
          lessonTitle: lesson.title,
          lessonTitleAr: lesson.titleAr,
          completedAt: p.completedAt!.toISOString(),
          score: p.lastScore ?? 0,
          passed: p.passed,
        });
      }
    }
  }

  const levelProgressPercent =
    allLessonsInLevel.length > 0
      ? (completedInLevel / allLessonsInLevel.length) * 100
      : 0;

  res.json({
    student: {
      id: profile.id,
      userId: user.id,
      name: user.name,
      email: user.email,
      currentLevelCode: currentLevel?.code ?? null,
      currentLevelId: profile.currentLevelId ?? null,
      curriculumId: profile.curriculumId ?? null,
      streakDays: profile.streakDays,
      totalLessonsCompleted: completedIds.size,
      totalXp: profile.totalXp,
      placementCompleted: profile.placementCompleted,
      subscriptionPlan: subscription?.planCode ?? null,
      bio: profile.bio ?? null,
      preferredLanguage: user.preferredLanguage,
      country: user.country,
      createdAt: user.createdAt,
    },
    currentCurriculum: curriculum
      ? {
          id: curriculum.id,
          name: curriculum.name,
          nameInLearnerLanguage: curriculum.nameInLearnerLanguage,
          targetLanguageCode: curriculum.targetLanguageCode,
          learnerLanguageCode: curriculum.learnerLanguageCode,
          levelFramework: curriculum.levelFramework,
          totalLevels: allCurriculumLevels.length,
        }
      : null,
    currentLevel: currentLevel
      ? {
          id: currentLevel.id,
          curriculumId: currentLevel.curriculumId,
          code: currentLevel.code,
          name: currentLevel.name,
          nameAr: currentLevel.nameAr,
          description: currentLevel.description ?? null,
          descriptionAr: currentLevel.descriptionAr ?? null,
          order: currentLevel.order,
          totalLessons: allLessonsInLevel.length,
          completedLessons: completedInLevel,
          isUnlocked: true,
          isCompleted: completedInLevel === allLessonsInLevel.length,
        }
      : null,
    nextLesson: nextLesson ?? null,
    // Keyed as the spec defines them. The internal tally is keyed by lesson
    // state, and sending it as-is left every count on the dashboard blank.
    lessonStateCounts: {
      locked: lessonStateCounts.LOCKED,
      available: lessonStateCounts.AVAILABLE,
      inProgress: lessonStateCounts.IN_PROGRESS,
      completed: lessonStateCounts.COMPLETED,
    },
    lessons: lessonSummaries,
    totalLessonsCompleted: completedIds.size,
    totalLessonsInLevel: allLessonsInLevel.length,
    levelProgressPercent,
    weeklyProgress: {
      lessonsThisWeek: weeklyCompleted.length,
      xpThisWeek,
      streakDays: profile.streakDays,
    },
    recentActivity,
  });
});

export default router;
