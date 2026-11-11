/**
 * The free lesson: the one lesson students on the free plan may open.
 *
 * Chosen by an admin or a lesson editor from the CMS. While it is set on a
 * published lesson, a free-plan student can open that lesson — whatever its
 * track, and without using an allowance — and no other (entitlement-policy.ts,
 * `limitedToFreeLesson`). With none chosen, or the chosen one unpublished or
 * deleted, the free plan falls back to its monthly allowance of any lesson in
 * its track, so nothing breaks while the choice is being made.
 */

import { and, eq, isNull } from "drizzle-orm";
import { db, lessonProgressTable, lessonsTable } from "@workspace/db";
import { cached, invalidate, invalidatePrefix, CK, TTL } from "./cache";
import {
  lessonOpenDenial,
  limitedToFreeLesson,
  type Entitlement,
  type LessonDenial,
} from "./entitlement-policy";

/** The free lesson's id, or null when none is chosen and published. */
export async function getFreeLessonId(): Promise<number | null> {
  // Wrapped: the cache treats a stored null as a miss.
  const { id } = await cached(CK.freeLesson(), TTL.FREE_LESSON, async () => {
    const [row] = await db
      .select({ id: lessonsTable.id })
      .from(lessonsTable)
      .where(
        and(
          eq(lessonsTable.isFreeLesson, true),
          eq(lessonsTable.status, "published"),
          isNull(lessonsTable.softDeletedAt),
        ),
      )
      .limit(1);
    return { id: row?.id ?? null };
  });
  return id;
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

/**
 * Why this student may not open a lesson, or null when they may.
 *
 * For the routes that serve a lesson's content or accept work on it. Reads the
 * student's progress only when the answer depends on it.
 */
export async function lessonOpenDenialFor(
  userId: number,
  entitlement: Entitlement,
  lesson: { id: number; track: string },
): Promise<LessonDenial | null> {
  if (entitlement.unlimited) return null;
  const freeLessonId = await getFreeLessonId();
  let alreadyStarted = false;
  if (limitedToFreeLesson(entitlement, freeLessonId) && lesson.id !== freeLessonId) {
    const [progress] = await db
      .select({ startedAt: lessonProgressTable.startedAt })
      .from(lessonProgressTable)
      .where(and(eq(lessonProgressTable.userId, userId), eq(lessonProgressTable.lessonId, lesson.id)))
      .limit(1);
    alreadyStarted = Boolean(progress?.startedAt);
  }
  return lessonOpenDenial({
    entitlement,
    lessonId: lesson.id,
    lessonTrack: lesson.track,
    freeLessonId,
    alreadyStarted,
  });
}
