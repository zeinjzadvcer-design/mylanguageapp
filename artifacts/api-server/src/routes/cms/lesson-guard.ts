/**
 * The one check every CMS route runs before changing a lesson or its content.
 *
 * The rule lives in services/access-policy.ts (`lessonChangeDenial`); this
 * loads the lesson and answers the request when the change is refused.
 */

import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db, lessonsTable } from "@workspace/db";
import { lessonChangeDenial } from "../../services/access-policy";

/** Whether the caller may change this lesson, for display. */
export function canChangeLesson(
  req: Request,
  lesson: { status: string; createdBy: number | null },
): boolean {
  return lessonChangeDenial({ role: req.session.role, userId: req.session.userId }, lesson) === null;
}

/**
 * Refuse the request when the caller may not change the lesson.
 *
 * Sends the 404 or 403 itself and returns true when the caller should stop.
 * The role was confirmed against the database by `requirePermission`, which
 * every CMS route runs first, so the session's copy is current here.
 */
export async function refuseLessonChange(
  req: Request,
  res: Response,
  lessonId: number,
): Promise<boolean> {
  const [lesson] = await db
    .select({
      status: lessonsTable.status,
      createdBy: lessonsTable.createdBy,
      softDeletedAt: lessonsTable.softDeletedAt,
    })
    .from(lessonsTable)
    .where(eq(lessonsTable.id, lessonId))
    .limit(1);

  if (!lesson || lesson.softDeletedAt) {
    res.status(404).json({ error: "Lesson not found" });
    return true;
  }
  return refuseLoadedLessonChange(req, res, lesson);
}

/**
 * As `refuseLessonChange`, for a route that has already loaded the lesson (and
 * answered 404 itself), so it is not read a second time.
 */
export function refuseLoadedLessonChange(
  req: Request,
  res: Response,
  lesson: { status: string; createdBy: number | null },
): boolean {
  const denial = lessonChangeDenial(
    { role: req.session.role, userId: req.session.userId },
    lesson,
  );
  if (denial) {
    res.status(403).json(denial);
    return true;
  }
  return false;
}

/**
 * A lesson id from a request body: a positive whole number, or one written as a
 * string ("42"), which the database would accept as the same id. Null detaches
 * the word; undefined leaves it unchanged. Anything else is refused, so the
 * ownership check always runs on the lesson the write will actually use.
 */
export function lessonIdFrom(value: unknown): number | null | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const id = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : "invalid";
}
