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
  getEntitlement,
  previousLessonInTrack,
  subscriptionInForce,
} from "../services/entitlements";
import {
  getCompletedLessonIds,
  deriveLessonStateWithOrders,
  getCurriculumLevels,
  publishedLessonFilter,
} from "../services/learning";
import { studentLessonView } from "../services/free-lesson";

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
      // In force, not merely `active`: the same test the lesson gate uses.
      .where(subscriptionInForce(userId))
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

  // Get all published lessons in current level, in the student's track only:
  // the other track's lessons are not theirs to see or count.
  const entitlement = await getEntitlement(userId, req.session.role);
  // The same view the curriculum pages use, so a student limited to the free
  // lesson is shown it here and not offered lessons they cannot open.
  const view = await studentLessonView(entitlement, profile.curriculumId ?? null);
  const allLessonsInLevel = currentLevel
    ? await db
        .select()
        .from(lessonsTable)
        .where(
          and(
            eq(lessonsTable.levelId, currentLevel.id),
            view.filter,
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
    const prevLessonId = previousLessonInTrack(allLessonsInLevel, idx);
    const progressRow = allProgress.find((p) => p.lessonId === lesson.id);
    const state = view.state(
      deriveLessonStateWithOrders(
        lesson,
        currentLevel?.order ?? 0,
        currentLevelOrder,
        completedIds,
        prevLessonId,
        progressRow?.status,
      ),
      lesson.id,
      progressRow,
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
      lockedReason: view.lockedReason(state, lesson.id, progressRow),
      isFreeLesson: lesson.id === view.freeLessonId,
    };
  });

  const completedInLevel = allLessonsInLevel.filter((l) => completedIds.has(l.id)).length;

  // Next lesson: first non-completed available lesson
  let nextLesson = lessonSummaries.find(
    (l) => l.state === "AVAILABLE" || l.state === "IN_PROGRESS",
  );

  // Limited to the free lesson, and it sits in another level: that lesson is
  // still the one to offer, since nothing in this level opens.
  if (!nextLesson && view.freeOnly && view.freeLessonId !== null && !completedIds.has(view.freeLessonId)) {
    const [free] = await db
      .select({ lesson: lessonsTable, levelCode: levelsTable.code })
      .from(lessonsTable)
      .innerJoin(levelsTable, eq(levelsTable.id, lessonsTable.levelId))
      .where(eq(lessonsTable.id, view.freeLessonId))
      .limit(1);
    if (free) {
      const progressRow = allProgress.find((p) => p.lessonId === free.lesson.id);
      const state = progressRow?.startedAt ? ("IN_PROGRESS" as const) : ("AVAILABLE" as const);
      nextLesson = {
        id: free.lesson.id,
        levelId: free.lesson.levelId,
        levelCode: free.levelCode,
        title: free.lesson.title,
        titleAr: free.lesson.titleAr,
        description: free.lesson.description ?? null,
        descriptionAr: free.lesson.descriptionAr ?? null,
        order: free.lesson.order,
        lessonType: free.lesson.lessonType,
        estimatedMinutes: free.lesson.estimatedMinutes,
        state,
        isUnlocked: true,
        isCompleted: false,
        bestScore: progressRow?.bestScore ?? null,
        xpReward: free.lesson.xpReward,
        lockedReason: null,
        isFreeLesson: true,
      };
    }
  }

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
