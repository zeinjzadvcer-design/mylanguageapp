import { Router, type IRouter } from "express";
import { eq, and, isNull } from "drizzle-orm";
import {
  db,
  exercisesTable,
  exerciseOptionsTable,
  exerciseAttemptsTable,
  contentBlocksTable,
  lessonsTable,
  levelsTable,
  studentProfilesTable,
} from "@workspace/db";
import { requireAuth, currentRole } from "../middlewares/auth";
import { getStudentCurriculumContext, publishedLessonFilter } from "../services/learning";

const router: IRouter = Router();

/**
 * Legacy exercise submit endpoint.
 * Grades server-side and enforces lesson access — does not leak the answer key.
 */
router.post("/exercises/:exerciseId/submit", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.exerciseId)
    ? req.params.exerciseId[0]
    : req.params.exerciseId;
  const exerciseId = parseInt(raw, 10);
  if (isNaN(exerciseId)) {
    res.status(400).json({ error: "Invalid exercise ID" });
    return;
  }

  const { selectedOptionId } = req.body;
  if (!selectedOptionId || typeof selectedOptionId !== "string") {
    res.status(400).json({ error: "selectedOptionId is required" });
    return;
  }

  const [exercise] = await db
    .select()
    .from(exercisesTable)
    .where(eq(exercisesTable.id, exerciseId))
    .limit(1);

  if (!exercise) {
    res.status(404).json({ error: "Exercise not found" });
    return;
  }

  // Validate option belongs to this exercise (prevent foreign option injection)
  const [option] = await db
    .select()
    .from(exerciseOptionsTable)
    .where(
      and(
        eq(exerciseOptionsTable.exerciseId, exerciseId),
        eq(exerciseOptionsTable.optionId, selectedOptionId),
      ),
    )
    .limit(1);

  if (!option) {
    res.status(400).json({ error: "Invalid option for this exercise" });
    return;
  }

  // Validate lesson is published and student has access
  const [lesson] = await db
    .select()
    .from(lessonsTable)
    .where(and(eq(lessonsTable.id, exercise.lessonId), publishedLessonFilter()))
    .limit(1);

  if (!lesson) {
    res.status(404).json({ error: "Exercise lesson not found or not published" });
    return;
  }

  // Enforce curriculum access for students (admins/content managers bypass)
  const userId = req.session.userId!;
  // Current, not from login: staff skip the check below, and a former staff
  // member must not keep doing so.
  const role = await currentRole(req);
  if (!role) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  if (role === "student") {
    const ctx = await getStudentCurriculumContext(userId);
    if (ctx) {
      const [level] = await db
        .select({ curriculumId: levelsTable.curriculumId })
        .from(levelsTable)
        .where(eq(levelsTable.id, lesson.levelId))
        .limit(1);

      if (!level || level.curriculumId !== ctx.curriculumId) {
        res.status(403).json({ error: "You do not have access to this exercise" });
        return;
      }
    }
  }

  // Server-side grading — never trust client
  const correct = exercise.correctOptionId === selectedOptionId;

  await db.insert(exerciseAttemptsTable).values({
    userId,
    exerciseId,
    selectedOptionId,
    correct,
  });

  // Return result without exposing correctOptionId
  res.json({
    correct,
    explanation: exercise.explanation ?? null,
    explanationAr: exercise.explanationAr ?? null,
  });
});

export default router;
