/**
 * The free lesson: the one lesson students on the free plan may open.
 *
 * Chosen by an admin or a lesson editor from the CMS. While it is set on a
 * published lesson, a free-plan student in that lesson's curriculum can open
 * that lesson — whatever its track, and without using an allowance — and no
 * other (entitlement-policy.ts, `limitedToFreeLesson`). Students in another
 * curriculum, and everyone while none is chosen or the chosen one is not
 * published, keep the free plan's monthly allowance of any lesson in its track.
 *
 * Every route that lists or opens lessons asks `studentLessonView` how this
 * student sees them, so the rule is decided in one place.
 */

import { and, eq, isNull, or, type SQL } from "drizzle-orm";
import { db, lessonProgressTable, lessonsTable, levelsTable } from "@workspace/db";
import { cached, invalidate, invalidatePrefix, CK, TTL } from "./cache";
import { getStudentCurriculumContext } from "./learning";
import {
  lessonOpenDenial,
  lessonTrackFilter,
  limitedToFreeLesson,
  studentLessonState,
  type Entitlement,
  type LessonDenial,
  type LessonState,
} from "./entitlements";

interface FreeLesson {
  id: number;
  curriculumId: number;
}

/** The chosen free lesson and its curriculum, or null when none is chosen and published. */
export async function getFreeLesson(): Promise<FreeLesson | null> {
  // Wrapped: the cache treats a stored null as a miss.
  const { lesson } = await cached(CK.freeLesson(), TTL.FREE_LESSON, async () => {
    const [row] = await db
      .select({ id: lessonsTable.id, curriculumId: levelsTable.curriculumId })
      .from(lessonsTable)
      .innerJoin(levelsTable, eq(levelsTable.id, lessonsTable.levelId))
      .where(
        and(
          eq(lessonsTable.isFreeLesson, true),
          eq(lessonsTable.status, "published"),
          isNull(lessonsTable.softDeletedAt),
        ),
      )
      .limit(1);
    return { lesson: row ?? null };
  });
  return lesson;
}

/** The free lesson's id when it is in this curriculum, else null. */
async function freeLessonIn(curriculumId: number | null): Promise<number | null> {
  if (curriculumId === null) return null;
  const free = await getFreeLesson();
  return free && free.curriculumId === curriculumId ? free.id : null;
}

/**
 * Make `lessonId` the free lesson, or clear it with null.
 *
 * In one transaction, the old one first: the unique index allows one free
 * lesson, so setting the new one before clearing the old would be refused.
 */
export async function setFreeLesson(lessonId: number | null): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(lessonsTable).set({ isFreeLesson: false }).where(eq(lessonsTable.isFreeLesson, true));
    if (lessonId !== null) {
      await tx.update(lessonsTable).set({ isFreeLesson: true }).where(eq(lessonsTable.id, lessonId));
    }
  });
  await Promise.all([invalidate(CK.freeLesson()), invalidatePrefix("v1:levels:c:")]);
}

/** How one student sees lessons. Built by studentLessonView. */
export interface StudentLessonView {
  /** The free lesson that applies to this student, or null. */
  freeLessonId: number | null;
  /** Limited to the free lesson: on the free plan, with one chosen in their curriculum. */
  freeOnly: boolean;
  /** Which lessons they are shown: their track, plus the free lesson when it applies. */
  filter: SQL | undefined;
  /** A lesson's state for them, from its state in the curriculum. */
  state(curriculumState: LessonState, lessonId: number, progress?: { startedAt: Date | null } | null): LessonState;
  /** Why a lesson in `state` is locked by the plan, when it is; else null. */
  lockedReason(state: LessonState, lessonId: number, progress?: { startedAt: Date | null } | null): "free_lesson_only" | null;
}

/**
 * How this student sees lessons in `curriculumId`.
 *
 * `entitlement` null is a visitor who is not signed in: every lesson, in its
 * curriculum state, with no plan applied.
 */
export async function studentLessonView(
  entitlement: Entitlement | null,
  curriculumId: number | null,
): Promise<StudentLessonView> {
  const freeLessonId = entitlement && !entitlement.unlimited ? await freeLessonIn(curriculumId) : null;
  const freeOnly = entitlement !== null && limitedToFreeLesson(entitlement, freeLessonId);
  const ownTrack = entitlement ? lessonTrackFilter(entitlement) : undefined;
  const started = (p?: { startedAt: Date | null } | null) => Boolean(p?.startedAt);

  return {
    freeLessonId,
    freeOnly,
    filter: freeOnly && ownTrack ? or(ownTrack, eq(lessonsTable.id, freeLessonId!)) : ownTrack,
    state: (curriculumState, lessonId, progress) =>
      studentLessonState(curriculumState, {
        freeOnly,
        isFree: lessonId === freeLessonId,
        started: started(progress),
      }),
    lockedReason: (state, lessonId, progress) =>
      freeOnly && state === "LOCKED" && lessonId !== freeLessonId && !started(progress)
        ? "free_lesson_only"
        : null,
  };
}

/**
 * Why this student may not open a lesson, or null when they may.
 *
 * For the routes that accept work on a lesson without loading the student's
 * curriculum themselves. Reads the curriculum and progress only when a free
 * lesson is chosen, so the common path costs one cached lookup.
 */
export async function lessonOpenDenialFor(
  userId: number,
  entitlement: Entitlement,
  lesson: { id: number; track: string },
): Promise<LessonDenial | null> {
  if (entitlement.unlimited) return null;
  let freeLessonId: number | null = null;
  if (!entitlement.isPaid && (await getFreeLesson())) {
    freeLessonId = await freeLessonIn((await getStudentCurriculumContext(userId))?.curriculumId ?? null);
  }
  let alreadyStarted = false;
  if (limitedToFreeLesson(entitlement, freeLessonId) && lesson.id !== freeLessonId) {
    const [progress] = await db
      .select({ startedAt: lessonProgressTable.startedAt })
      .from(lessonProgressTable)
      .where(and(eq(lessonProgressTable.userId, userId), eq(lessonProgressTable.lessonId, lesson.id)))
      .limit(1);
    alreadyStarted = Boolean(progress?.startedAt);
  }
  return lessonOpenDenial({ entitlement, lessonId: lesson.id, lessonTrack: lesson.track, freeLessonId, alreadyStarted });
}
