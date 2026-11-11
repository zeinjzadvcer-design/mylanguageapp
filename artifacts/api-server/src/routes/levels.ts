import { Router, type IRouter } from "express";
import { eq, asc, and, inArray, isNull, or, type SQL } from "drizzle-orm";
import {
  db,
  levelsTable,
  lessonsTable,
  lessonProgressTable,
  studentProfilesTable,
  curriculaTable,
} from "@workspace/db";
import {
  getCompletedLessonIds,
  deriveLessonStateWithOrders,
  publishedLessonFilter,
} from "../services/learning";
import {
  getEntitlement,
  lessonTrackFilter,
  limitedToFreeLesson,
  previousLessonInTrack,
  stateForFreeLessonStudent,
  type LessonState,
} from "../services/entitlements";
import { getFreeLessonId } from "../services/free-lesson";

const router: IRouter = Router();

/**
 * Which lessons a signed-in student is shown, and how their state is read.
 *
 * `filter` is the track condition; undefined (both tracks) for staff and for a
 * visitor who is not signed in, who sees the catalogue rather than any one
 * plan's content. A free-plan student limited to the free lesson is shown it
 * whatever its track (`freeOnly`), and every other lesson reads as locked.
 */
async function lessonViewFor(
  userId: number | undefined,
  role: string | undefined,
): Promise<{ filter: SQL | undefined; freeOnly: boolean; freeLessonId: number | null }> {
  const freeLessonId = await getFreeLessonId();
  if (!userId) return { filter: undefined, freeOnly: false, freeLessonId };
  const entitlement = await getEntitlement(userId, role);
  const trackFilter = lessonTrackFilter(entitlement);
  const freeOnly = limitedToFreeLesson(entitlement, freeLessonId);
  const filter = freeOnly && trackFilter ? or(trackFilter, eq(lessonsTable.id, freeLessonId!)) : trackFilter;
  return { filter, freeOnly, freeLessonId };
}

/** A lesson's state as this student sees it. */
function viewState(
  view: { freeOnly: boolean; freeLessonId: number | null },
  state: LessonState,
  lessonId: number,
  progress: { startedAt: Date | null } | undefined,
): LessonState {
  return view.freeOnly
    ? stateForFreeLessonStudent(state, { isFree: lessonId === view.freeLessonId, started: Boolean(progress?.startedAt) })
    : state;
}

/** Resolve which curriculum to use: from query param or student's enrolled curriculum or platform default */
async function resolveCurriculumId(
  queryCurriculumId: number | undefined,
  userId: number | undefined,
): Promise<number | null> {
  if (queryCurriculumId) return queryCurriculumId;

  if (userId) {
    const [profile] = await db
      .select({ curriculumId: studentProfilesTable.curriculumId })
      .from(studentProfilesTable)
      .where(eq(studentProfilesTable.userId, userId))
      .limit(1);
    if (profile?.curriculumId) return profile.curriculumId;
  }

  const [defaultC] = await db
    .select({ id: curriculaTable.id })
    .from(curriculaTable)
    .where(eq(curriculaTable.isActive, true))
    .orderBy(curriculaTable.id)
    .limit(1);
  return defaultC?.id ?? null;
}

router.get("/levels", async (req, res): Promise<void> => {
  const userId = req.session?.userId;
  const queryCurriculumId = req.query.curriculumId
    ? parseInt(req.query.curriculumId as string, 10)
    : undefined;
  const curriculumId = await resolveCurriculumId(queryCurriculumId, userId);

  const where = curriculumId ? eq(levelsTable.curriculumId, curriculumId) : undefined;
  const levels = await db
    .select()
    .from(levelsTable)
    .where(where)
    .orderBy(asc(levelsTable.order));

  // Fetch curriculum metadata
  const curriculum = curriculumId
    ? await db
        .select()
        .from(curriculaTable)
        .where(eq(curriculaTable.id, curriculumId))
        .limit(1)
        .then((r) => r[0] ?? null)
    : null;

  const completedIds = userId ? await getCompletedLessonIds(userId) : new Set<number>();

  // Fetch all published lessons for the curriculum's levels
  const levelIds = levels.map((l) => l.id);
  const view = await lessonViewFor(userId, req.session?.role);
  const allLessons =
    levelIds.length > 0
      ? await db
          .select()
          .from(lessonsTable)
          .where(and(
            // This curriculum's levels only. It read every published lesson
            // in every curriculum and then used the ones for these levels.
            inArray(lessonsTable.levelId, levelIds),
            eq(lessonsTable.status, "published"),
            isNull(lessonsTable.softDeletedAt),
            view.filter,
          ))
      : [];

  let profile = null;
  if (userId) {
    const [p] = await db
      .select()
      .from(studentProfilesTable)
      .where(eq(studentProfilesTable.userId, userId))
      .limit(1);
    profile = p;
  }
  const currentLevelId = profile?.currentLevelId ?? null;
  const currentLevel = currentLevelId
    ? levels.find((l) => l.id === currentLevelId)
    : null;
  const currentLevelOrder = currentLevel?.order ?? null;

  const allProgress = userId
    ? await db
        .select()
        .from(lessonProgressTable)
        .where(eq(lessonProgressTable.userId, userId))
    : [];

  const result = levels.map((level) => {
    const levelLessons = allLessons
      .filter((l) => l.levelId === level.id)
      .sort((a, b) => a.order - b.order);

    let completedInLevel = 0;
    const lessonStateCounts = { LOCKED: 0, AVAILABLE: 0, IN_PROGRESS: 0, COMPLETED: 0 };

    levelLessons.forEach((lesson, idx) => {
      const prevLessonId = previousLessonInTrack(levelLessons, idx);
      const progressRow = allProgress.find((p) => p.lessonId === lesson.id);
      const state = viewState(
        view,
        deriveLessonStateWithOrders(
          lesson,
          level.order,
          currentLevelOrder,
          completedIds,
          prevLessonId,
          progressRow?.status,
        ),
        lesson.id,
        progressRow,
      );
      lessonStateCounts[state]++;
      if (state === "COMPLETED") completedInLevel++;
    });

    const isCurrentLevel = level.id === currentLevelId;
    const isUnlocked = isCurrentLevel || (currentLevelOrder !== null && level.order <= currentLevelOrder);
    const isCompleted =
      levelLessons.length > 0 && completedInLevel === levelLessons.length;

    return {
      id: level.id,
      curriculumId: level.curriculumId,
      code: level.code,
      name: level.name,
      nameAr: level.nameAr,
      description: level.description ?? null,
      descriptionAr: level.descriptionAr ?? null,
      order: level.order,
      totalLessons: levelLessons.length,
      completedLessons: completedInLevel,
      isUnlocked,
      isCompleted,
      lessonStateCounts,
    };
  });

  res.json({
    curriculum: curriculum
      ? {
          id: curriculum.id,
          name: curriculum.name,
          nameInLearnerLanguage: curriculum.nameInLearnerLanguage,
          targetLanguageCode: curriculum.targetLanguageCode,
          learnerLanguageCode: curriculum.learnerLanguageCode,
          levelFramework: curriculum.levelFramework,
        }
      : null,
    levels: result,
  });
});

router.get("/levels/:levelId", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.levelId) ? req.params.levelId[0] : req.params.levelId;
  const levelId = parseInt(raw, 10);
  if (isNaN(levelId)) {
    res.status(400).json({ error: "Invalid level ID" });
    return;
  }

  const [level] = await db
    .select()
    .from(levelsTable)
    .where(eq(levelsTable.id, levelId))
    .limit(1);
  if (!level) {
    res.status(404).json({ error: "Level not found" });
    return;
  }

  const [curriculum] = await db
    .select()
    .from(curriculaTable)
    .where(eq(curriculaTable.id, level.curriculumId))
    .limit(1);

  const userId = req.session?.userId;
  const completedIds = userId ? await getCompletedLessonIds(userId) : new Set<number>();

  let profile = null;
  if (userId) {
    const [p] = await db
      .select()
      .from(studentProfilesTable)
      .where(eq(studentProfilesTable.userId, userId))
      .limit(1);
    profile = p;
  }

  const currentLevelId = profile?.currentLevelId ?? null;
  const allLevels = await db
    .select({ id: levelsTable.id, order: levelsTable.order })
    .from(levelsTable)
    .where(eq(levelsTable.curriculumId, level.curriculumId))
    .orderBy(asc(levelsTable.order));

  const currentLevelRecord = currentLevelId
    ? allLevels.find((l) => l.id === currentLevelId)
    : null;
  const currentLevelOrder = currentLevelRecord?.order ?? null;

  const view = await lessonViewFor(userId, req.session?.role);
  const levelLessons = await db
    .select()
    .from(lessonsTable)
    .where(
      and(
        eq(lessonsTable.levelId, levelId),
        view.filter,
        publishedLessonFilter(),
      ),
    )
    .orderBy(asc(lessonsTable.order));

  const allProgress = userId
    ? await db
        .select()
        .from(lessonProgressTable)
        .where(eq(lessonProgressTable.userId, userId))
    : [];

  let completedInLevel = 0;
  const lessonStateCounts = { LOCKED: 0, AVAILABLE: 0, IN_PROGRESS: 0, COMPLETED: 0 };

  const lessonSummaries = levelLessons.map((lesson, idx) => {
    const prevLessonId = previousLessonInTrack(levelLessons, idx);
    const progressRow = allProgress.find((p) => p.lessonId === lesson.id);
    const state = viewState(
      view,
      deriveLessonStateWithOrders(
        lesson,
        level.order,
        currentLevelOrder,
        completedIds,
        prevLessonId,
        progressRow?.status,
      ),
      lesson.id,
      progressRow,
    );
    lessonStateCounts[state]++;
    if (state === "COMPLETED") completedInLevel++;

    return {
      id: lesson.id,
      levelId: lesson.levelId,
      levelCode: level.code,
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
      // Shown to everyone: a paying student may like to know which one it is.
      isFreeLesson: lesson.id === view.freeLessonId,
      // Locked by the plan rather than by progression, so the screen can point
      // to the plans instead of "finish the previous lesson".
      lockedReason:
        view.freeOnly && state === "LOCKED" && lesson.id !== view.freeLessonId && !progressRow?.startedAt
          ? ("free_lesson_only" as const)
          : null,
    };
  });

  const isCurrentLevel = level.id === currentLevelId;
  const isUnlocked =
    isCurrentLevel ||
    (currentLevelOrder !== null && level.order <= currentLevelOrder);
  const isCompleted =
    levelLessons.length > 0 && completedInLevel === levelLessons.length;

  res.json({
    id: level.id,
    curriculumId: level.curriculumId,
    code: level.code,
    name: level.name,
    nameAr: level.nameAr,
    description: level.description ?? null,
    descriptionAr: level.descriptionAr ?? null,
    order: level.order,
    totalLessons: levelLessons.length,
    completedLessons: completedInLevel,
    isUnlocked,
    isCompleted,
    lessonStateCounts,
    curriculum: curriculum
      ? {
          id: curriculum.id,
          name: curriculum.name,
          nameInLearnerLanguage: curriculum.nameInLearnerLanguage,
          targetLanguageCode: curriculum.targetLanguageCode,
          learnerLanguageCode: curriculum.learnerLanguageCode,
          levelFramework: curriculum.levelFramework,
        }
      : null,
    lessons: lessonSummaries,
  });
});

export default router;
