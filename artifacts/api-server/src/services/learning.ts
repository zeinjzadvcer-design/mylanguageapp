/**
 * Learning Service
 *
 * Centralises access-control, state derivation, and scoring logic
 * for the student learning engine so that route handlers stay thin.
 */

import { eq, and, asc, isNull, inArray } from "drizzle-orm";
import {
  db,
  lessonsTable,
  levelsTable,
  contentBlocksTable,
  exercisesTable,
  exerciseOptionsTable,
  lessonProgressTable,
  lessonBlockProgressTable,
  learningActivityAttemptsTable,
  studentProfilesTable,
  curriculaTable,
} from "@workspace/db";
import { getEntitlement, lessonTrackFilter } from "./entitlements";

// ─── Types ────────────────────────────────────────────────────────────────────

export type LessonState = "LOCKED" | "AVAILABLE" | "IN_PROGRESS" | "COMPLETED";

export interface StudentCurriculumContext {
  curriculumId: number;
  currentLevelId: number | null;
}

// ─── Curriculum context ───────────────────────────────────────────────────────

/**
 * Load the student's curriculum context (curriculum + current level).
 * Returns null if the student has no profile / no placement.
 */
export async function getStudentCurriculumContext(
  userId: number,
): Promise<StudentCurriculumContext | null> {
  const [profile] = await db
    .select({
      curriculumId: studentProfilesTable.curriculumId,
      currentLevelId: studentProfilesTable.currentLevelId,
    })
    .from(studentProfilesTable)
    .where(eq(studentProfilesTable.userId, userId))
    .limit(1);

  if (!profile?.curriculumId) return null;

  return {
    curriculumId: profile.curriculumId,
    currentLevelId: profile.currentLevelId ?? null,
  };
}

// ─── Published lesson filter ──────────────────────────────────────────────────

/** Canonical filter for student-visible lessons */
export function publishedLessonFilter() {
  return and(eq(lessonsTable.status, "published"), isNull(lessonsTable.softDeletedAt));
}

// ─── Lesson state derivation ──────────────────────────────────────────────────

/**
 * Derive the client-facing state for a single lesson.
 *
 * Access rules:
 *  - Levels below current level → AVAILABLE (review access)
 *  - Current level → sequential: first lesson AVAILABLE, rest unlock after previous completed
 *  - Future levels → LOCKED
 *  - A completed lesson remains accessible (COMPLETED)
 *
 * @param lesson           The lesson to evaluate
 * @param level            The level the lesson belongs to
 * @param currentLevelId   Student's current level ID (null = not placed)
 * @param completedIds     Set of lesson IDs the student has passed
 * @param prevLessonId     The previous lesson in order within the same level (null if first)
 */
export function deriveLessonState(
  lesson: { id: number; order: number },
  level: { id: number; order: number },
  currentLevelId: number | null,
  completedIds: Set<number>,
  prevLessonId: number | null,
): LessonState {
  if (completedIds.has(lesson.id)) return "COMPLETED";

  if (!currentLevelId) return "LOCKED";

  // Future levels are locked
  if (level.id !== currentLevelId) {
    // Need to compare level orders — we work with level.order vs current level order
    // Caller must pass in the current level's order for this check.
    // We handle this by making the caller pass currentLevelOrder.
    return "LOCKED";
  }

  // Current level: sequential unlock
  if (prevLessonId === null) {
    // First lesson in the level
    return "AVAILABLE";
  }
  if (completedIds.has(prevLessonId)) return "AVAILABLE";
  return "LOCKED";
}

/**
 * Extended version that accepts level orders for cross-level comparison.
 */
// deriveLessonStateWithOrders lives in entitlement-policy.ts, which has no
// database import, so the progression rules can be tested without a live
// DATABASE_URL. Re-exported here so callers keep one import.
export { deriveLessonStateWithOrders } from "./entitlement-policy";

// ─── Completed lesson IDs ─────────────────────────────────────────────────────

export async function getCompletedLessonIds(userId: number): Promise<Set<number>> {
  const rows = await db
    .select({ lessonId: lessonProgressTable.lessonId })
    .from(lessonProgressTable)
    .where(and(eq(lessonProgressTable.userId, userId), eq(lessonProgressTable.passed, true)));
  return new Set(rows.map((r) => r.lessonId));
}

// ─── Block progress ───────────────────────────────────────────────────────────

export async function getCompletedBlockIds(
  userId: number,
  lessonId: number,
  contentVersion: number,
): Promise<number[]> {
  const rows = await db
    .select({ blockId: lessonBlockProgressTable.blockId })
    .from(lessonBlockProgressTable)
    .where(
      and(
        eq(lessonBlockProgressTable.userId, userId),
        eq(lessonBlockProgressTable.lessonId, lessonId),
        eq(lessonBlockProgressTable.contentVersion, contentVersion),
      ),
    );
  return rows.map((r) => r.blockId);
}

// ─── Audio URL resolution ─────────────────────────────────────────────────────

/**
 * Resolve an audio URL from block or exercise fields.
 * Priority: exercise.audioUrl → block.exampleAudio → block.audioNote
 */
export function resolveAudioUrl(
  block: { audioNote?: string | null; exampleAudio?: string | null },
  exercise?: { audioUrl?: string | null } | null,
): string | null {
  return exercise?.audioUrl ?? block.exampleAudio ?? block.audioNote ?? null;
}

// ─── Curriculum level ordering ────────────────────────────────────────────────

/**
 * Fetch all levels for a curriculum ordered by their `order` column.
 */
export async function getCurriculumLevels(curriculumId: number) {
  return db
    .select()
    .from(levelsTable)
    .where(eq(levelsTable.curriculumId, curriculumId))
    .orderBy(asc(levelsTable.order));
}

// ─── Level advancement ────────────────────────────────────────────────────────

/**
 * Check if the student has completed all published lessons in their current
 * level and if so advance to the next level in the same curriculum.
 * Returns the new currentLevelId (unchanged if no advancement happened).
 */
export async function maybeAdvanceLevel(
  userId: number,
  completedLessonId: number,
  role?: string,
): Promise<{ advanced: boolean; newLevelId: number | null }> {
  const [profile] = await db
    .select()
    .from(studentProfilesTable)
    .where(eq(studentProfilesTable.userId, userId))
    .limit(1);

  if (!profile?.currentLevelId || !profile.curriculumId) {
    return { advanced: false, newLevelId: profile?.currentLevelId ?? null };
  }

  // All published lessons in current level, in the student's own track: a
  // level is finished when the lessons their plan covers are, never waiting
  // on the other track's lessons, which they cannot open.
  const entitlement = await getEntitlement(userId, role);
  const levelLessons = await db
    .select({ id: lessonsTable.id })
    .from(lessonsTable)
    .where(
      and(
        eq(lessonsTable.levelId, profile.currentLevelId),
        lessonTrackFilter(entitlement),
        eq(lessonsTable.status, "published"),
        isNull(lessonsTable.softDeletedAt),
      ),
    );

  const completedIds = await getCompletedLessonIds(userId);
  // Include the just-completed lesson
  completedIds.add(completedLessonId);

  const allDone = levelLessons.every((l) => completedIds.has(l.id));
  if (!allDone) return { advanced: false, newLevelId: profile.currentLevelId };

  // Find the next level in the curriculum
  const [currentLevel] = await db
    .select({ order: levelsTable.order })
    .from(levelsTable)
    .where(eq(levelsTable.id, profile.currentLevelId))
    .limit(1);

  if (!currentLevel) return { advanced: false, newLevelId: profile.currentLevelId };

  const levels = await getCurriculumLevels(profile.curriculumId);
  const nextLevel = levels.find((l) => l.order > currentLevel.order);

  if (!nextLevel) return { advanced: false, newLevelId: profile.currentLevelId };

  await db
    .update(studentProfilesTable)
    .set({ currentLevelId: nextLevel.id })
    .where(eq(studentProfilesTable.userId, userId));

  return { advanced: true, newLevelId: nextLevel.id };
}

// ─── Server-side MCQ grading ──────────────────────────────────────────────────

/**
 * Grade an MCQ exercise server-side.
 * Returns null for non-MCQ exercises (caller should handle those separately).
 */
export async function gradeExercise(
  exerciseId: number,
  selectedOptionId: string,
): Promise<{ correct: boolean; correctOptionId: string } | null> {
  const [exercise] = await db
    .select({ exerciseType: exercisesTable.exerciseType, correctOptionId: exercisesTable.correctOptionId })
    .from(exercisesTable)
    .where(eq(exercisesTable.id, exerciseId))
    .limit(1);

  if (!exercise || exercise.exerciseType !== "mcq") return null;

  return {
    correct: exercise.correctOptionId === selectedOptionId,
    correctOptionId: exercise.correctOptionId,
  };
}

// ─── Score derivation ─────────────────────────────────────────────────────────

/**
 * Derive the lesson score from the latest graded MCQ attempts on required blocks.
 * If there are no graded required MCQ blocks, returns 100.
 * Uses exercise.points for weighting.
 */
export async function deriveLessonScore(
  userId: number,
  lessonId: number,
  contentVersion: number,
): Promise<number> {
  // Get all required active blocks for this lesson
  const requiredBlocks = await db
    .select({ id: contentBlocksTable.id })
    .from(contentBlocksTable)
    .where(
      and(
        eq(contentBlocksTable.lessonId, lessonId),
        eq(contentBlocksTable.isRequired, true),
        eq(contentBlocksTable.isActive, true),
      ),
    );

  if (requiredBlocks.length === 0) return 100;

  const requiredBlockIds = requiredBlocks.map((b) => b.id);

  // Get exercises for required blocks
  const requiredExercises = await db
    .select({
      id: exercisesTable.id,
      contentBlockId: exercisesTable.contentBlockId,
      exerciseType: exercisesTable.exerciseType,
      points: exercisesTable.points,
    })
    .from(exercisesTable)
    .where(
      and(
        eq(exercisesTable.lessonId, lessonId),
        inArray(exercisesTable.contentBlockId, requiredBlockIds),
      ),
    );

  const mcqExercises = requiredExercises.filter((e) => e.exerciseType === "mcq");

  if (mcqExercises.length === 0) return 100;

  const exerciseIds = mcqExercises.map((e) => e.id);

  // Get latest attempt per exercise for this user+lesson+contentVersion
  const attempts = await db
    .select({
      blockId: learningActivityAttemptsTable.blockId,
      exerciseId: learningActivityAttemptsTable.exerciseId,
      isCorrect: learningActivityAttemptsTable.isCorrect,
      evaluationStatus: learningActivityAttemptsTable.evaluationStatus,
      submittedAt: learningActivityAttemptsTable.submittedAt,
    })
    .from(learningActivityAttemptsTable)
    .where(
      and(
        eq(learningActivityAttemptsTable.userId, userId),
        eq(learningActivityAttemptsTable.lessonId, lessonId),
        eq(learningActivityAttemptsTable.contentVersion, contentVersion),
        inArray(learningActivityAttemptsTable.exerciseId as any, exerciseIds),
      ),
    )
    .orderBy(asc(learningActivityAttemptsTable.submittedAt));

  // Keep only the latest attempt per exercise
  const latestByExercise = new Map<number, { isCorrect: boolean | null }>();
  for (const a of attempts) {
    if (a.exerciseId !== null) {
      latestByExercise.set(a.exerciseId, { isCorrect: a.isCorrect });
    }
  }

  let totalPoints = 0;
  let earnedPoints = 0;

  for (const ex of mcqExercises) {
    const pts = ex.points ?? 10;
    totalPoints += pts;
    const attempt = latestByExercise.get(ex.id);
    if (attempt?.isCorrect === true) {
      earnedPoints += pts;
    }
  }

  if (totalPoints === 0) return 100;
  return Math.round((earnedPoints / totalPoints) * 100);
}

// ─── Missing required block IDs ───────────────────────────────────────────────

/**
 * Returns IDs of required active blocks that have not been completed yet
 * for the given lesson + contentVersion.
 */
export async function getMissingRequiredBlockIds(
  userId: number,
  lessonId: number,
  contentVersion: number,
): Promise<number[]> {
  const requiredBlocks = await db
    .select({ id: contentBlocksTable.id })
    .from(contentBlocksTable)
    .where(
      and(
        eq(contentBlocksTable.lessonId, lessonId),
        eq(contentBlocksTable.isRequired, true),
        eq(contentBlocksTable.isActive, true),
      ),
    );

  if (requiredBlocks.length === 0) return [];

  const completedBlockIds = new Set(await getCompletedBlockIds(userId, lessonId, contentVersion));

  return requiredBlocks.filter((b) => !completedBlockIds.has(b.id)).map((b) => b.id);
}

// ─── Next lesson ──────────────────────────────────────────────────────────────

/**
 * Find the next published lesson for a student after completing the given lesson.
 * Looks within the same level first (by order), then does not advance — that is
 * handled by maybeAdvanceLevel.
 */
export async function findNextLesson(
  lessonId: number,
): Promise<{ id: number; title: string; titleAr: string } | null> {
  const [lesson] = await db
    .select({ levelId: lessonsTable.levelId, order: lessonsTable.order, track: lessonsTable.track })
    .from(lessonsTable)
    .where(eq(lessonsTable.id, lessonId))
    .limit(1);

  if (!lesson) return null;

  const [next] = await db
    .select({ id: lessonsTable.id, title: lessonsTable.title, titleAr: lessonsTable.titleAr })
    .from(lessonsTable)
    .where(
      and(
        eq(lessonsTable.levelId, lesson.levelId),
        // Next in the same track: the other track's lessons are not this
        // student's to be sent to.
        eq(lessonsTable.track, lesson.track),
        eq(lessonsTable.status, "published"),
        isNull(lessonsTable.softDeletedAt),
      ),
    )
    .orderBy(asc(lessonsTable.order));

  // Find the next one after current order
  const allInLevel = await db
    .select({ id: lessonsTable.id, title: lessonsTable.title, titleAr: lessonsTable.titleAr, order: lessonsTable.order })
    .from(lessonsTable)
    .where(
      and(
        eq(lessonsTable.levelId, lesson.levelId),
        // Next in the same track: the other track's lessons are not this
        // student's to be sent to.
        eq(lessonsTable.track, lesson.track),
        eq(lessonsTable.status, "published"),
        isNull(lessonsTable.softDeletedAt),
      ),
    )
    .orderBy(asc(lessonsTable.order));

  const nextLesson = allInLevel.find((l) => l.order > lesson.order);
  return nextLesson ? { id: nextLesson.id, title: nextLesson.title, titleAr: nextLesson.titleAr } : null;
}
