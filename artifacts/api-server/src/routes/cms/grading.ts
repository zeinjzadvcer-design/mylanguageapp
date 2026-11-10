/**
 * The marking queue: work a human has to finish.
 *
 * Everything AI cannot mark ends up here — a provider outage, an exhausted
 * quota, a recording that will not transcribe, a model that keeps returning
 * nonsense. The grading sweeper retries a bounded number of times and then
 * gives up, on purpose: "broken forever" becomes "escalated to a person".
 *
 * Marking here does the same thing AI grading does — records the score, then
 * re-finalises the attempt, which is what releases a held promotion. A teacher
 * clearing this queue is not doing bookkeeping; they are unblocking students.
 */

import { Router, type IRouter } from "express";
import { z } from "zod";
import { eq, and, desc, sql } from "drizzle-orm";
import {
  db,
  quizResponsesTable,
  quizAttemptsTable,
  quizzesTable,
  contentBlocksTable,
  exercisesTable,
  learningActivityAttemptsTable,
  lessonsTable,
  usersTable,
  mediaAssetsTable,
} from "@workspace/db";
import { requirePermission } from "../../middlewares/auth";
import { finaliseQuizAttempt } from "../../services/grading-runner";
import {
  sweepStalePending,
  countPendingWork,
  MAX_ATTEMPTS,
} from "../../services/grading-sweeper";
import { resolvePlaybackUrl } from "../../services/media";
import { audit } from "../../services/cms-audit";
import { logger } from "../../lib/logger";

const router: IRouter = Router();

// ─── The queue ────────────────────────────────────────────────────────────────

/**
 * Everything waiting on a human, oldest first.
 *
 * Oldest first because a student who submitted three days ago has been waiting
 * three days. Sorting by anything else buries them.
 */
router.get("/cms/grading/queue", requirePermission("grading.manage"), async (req, res): Promise<void> => {
  const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) ?? "50", 10)));
  // By default show only what the sweeper has given up on — the rest may still
  // resolve by itself, and a queue full of work that will clear on its own is a
  // queue nobody trusts.
  const includeRetrying = req.query.all === "true";

  const attemptsFilter = includeRetrying
    ? sql`TRUE`
    : sql`${quizResponsesTable.gradingAttempts} >= ${MAX_ATTEMPTS}`;

  const quizItems = await db
    .select({
      id: quizResponsesTable.id,
      kind: sql<string>`'quiz_response'`,
      attemptId: quizResponsesTable.attemptId,
      blockType: contentBlocksTable.type,
      prompt: contentBlocksTable.prompt,
      expectsReferenceReading: contentBlocksTable.expectsReferenceReading,
      referenceText: contentBlocksTable.content,
      response: quizResponsesTable.response,
      transcript: quizResponsesTable.transcript,
      mediaAssetId: quizResponsesTable.mediaAssetId,
      gradingAttempts: quizResponsesTable.gradingAttempts,
      lastGradingError: quizResponsesTable.lastGradingError,
      submittedAt: quizAttemptsTable.submittedAt,
      studentName: usersTable.name,
      studentId: usersTable.id,
      context: quizzesTable.title,
    })
    .from(quizResponsesTable)
    .innerJoin(quizAttemptsTable, eq(quizAttemptsTable.id, quizResponsesTable.attemptId))
    .innerJoin(quizzesTable, eq(quizzesTable.id, quizAttemptsTable.quizId))
    .innerJoin(contentBlocksTable, eq(contentBlocksTable.id, quizResponsesTable.blockId))
    .innerJoin(usersTable, eq(usersTable.id, quizAttemptsTable.userId))
    .where(and(eq(quizResponsesTable.gradedBy, "pending"), attemptsFilter))
    .orderBy(quizResponsesTable.createdAt)
    .limit(limit);

  const activityFilter = includeRetrying
    ? sql`TRUE`
    : sql`${learningActivityAttemptsTable.gradingAttempts} >= ${MAX_ATTEMPTS}`;

  const activityItems = await db
    .select({
      id: learningActivityAttemptsTable.id,
      kind: sql<string>`'lesson_activity'`,
      attemptId: learningActivityAttemptsTable.id,
      blockType: contentBlocksTable.type,
      // A speaking block can hold several prompts, one per exercise; the
      // block's own prompt is only the first. Show the one this recording
      // answered, falling back to the block for blocks without exercises.
      prompt: sql<string | null>`coalesce(nullif(${exercisesTable.prompt}, ''), nullif(${exercisesTable.question}, ''), ${contentBlocksTable.prompt})`,
      expectsReferenceReading: contentBlocksTable.expectsReferenceReading,
      referenceText: contentBlocksTable.content,
      response: sql<unknown>`to_jsonb(${learningActivityAttemptsTable.responseText})`,
      transcript: learningActivityAttemptsTable.transcript,
      mediaAssetId: learningActivityAttemptsTable.mediaAssetId,
      gradingAttempts: learningActivityAttemptsTable.gradingAttempts,
      lastGradingError: learningActivityAttemptsTable.lastGradingError,
      submittedAt: learningActivityAttemptsTable.submittedAt,
      studentName: usersTable.name,
      studentId: usersTable.id,
      context: lessonsTable.title,
    })
    .from(learningActivityAttemptsTable)
    .innerJoin(contentBlocksTable, eq(contentBlocksTable.id, learningActivityAttemptsTable.blockId))
    .leftJoin(exercisesTable, eq(exercisesTable.id, learningActivityAttemptsTable.exerciseId))
    .innerJoin(lessonsTable, eq(lessonsTable.id, learningActivityAttemptsTable.lessonId))
    .innerJoin(usersTable, eq(usersTable.id, learningActivityAttemptsTable.userId))
    .where(and(eq(learningActivityAttemptsTable.evaluationStatus, "pending"), activityFilter))
    .orderBy(learningActivityAttemptsTable.submittedAt)
    .limit(limit);

  const items = [...quizItems, ...activityItems].sort(
    (a, b) =>
      new Date(a.submittedAt ?? 0).getTime() - new Date(b.submittedAt ?? 0).getTime(),
  );

  res.json({
    items,
    counts: await countPendingWork(),
    maxAttempts: MAX_ATTEMPTS,
    showingOnlyExhausted: !includeRetrying,
  });
});

/** A playback URL for a recording in the queue. Staff may hear any student's. */
router.get("/cms/grading/media/:mediaId", requirePermission("grading.manage"), async (req, res): Promise<void> => {
  const mediaId = parseInt(req.params.mediaId as string, 10);
  if (isNaN(mediaId)) {
    res.status(400).json({ error: "Invalid media ID" });
    return;
  }

  const url = await resolvePlaybackUrl(mediaId, {
    userId: req.session.userId!,
    role: req.session.role,
  });

  if (!url) {
    res.status(404).json({ error: "Recording not found" });
    return;
  }
  res.json({ url });
});

// ─── Marking ──────────────────────────────────────────────────────────────────

const markSchema = z.object({
  score: z.number().min(0).max(100),
  feedbackAr: z.string().max(1000).optional(),
  feedback: z.string().max(1000).optional(),
});

/**
 * Mark one quiz response by hand, then re-finalise the attempt.
 *
 * Re-finalising is the point: it recomputes the attempt's score, decides
 * pass/fail once nothing is outstanding, and applies promotion if the quiz was
 * a level evaluation. Recording the score without it would leave the student
 * exactly as stuck as before.
 */
router.post(
  "/cms/grading/quiz-responses/:id",
  requirePermission("grading.manage"),
  async (req, res): Promise<void> => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid response ID" });
      return;
    }

    const parsed = markSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.errors });
      return;
    }

    const [response] = await db
      .select()
      .from(quizResponsesTable)
      .where(eq(quizResponsesTable.id, id))
      .limit(1);

    if (!response) {
      res.status(404).json({ error: "Response not found" });
      return;
    }

    await db
      .update(quizResponsesTable)
      .set({
        score: parsed.data.score,
        gradedBy: "teacher",
        gradedByUserId: req.session.userId!,
        feedbackAr: parsed.data.feedbackAr ?? null,
        feedback: parsed.data.feedback ?? null,
        lastGradedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(quizResponsesTable.id, id));

    await finaliseQuizAttempt(response.attemptId);

    const [attempt] = await db
      .select()
      .from(quizAttemptsTable)
      .where(eq(quizAttemptsTable.id, response.attemptId))
      .limit(1);

    await audit(req.session.userId!, "grade", "quiz_response", id, "pending", "teacher", {
      score: parsed.data.score,
      attemptId: response.attemptId,
    });

    logger.info(
      { by: req.session.userId, responseId: id, score: parsed.data.score },
      "Quiz response marked by hand",
    );

    res.json({
      marked: true,
      attempt: attempt
        ? {
            id: attempt.id,
            status: attempt.status,
            score: attempt.score,
            passed: attempt.passed,
            pendingReviewCount: attempt.pendingReviewCount,
          }
        : null,
    });
  },
);

/** Mark one lesson activity by hand. */
router.post(
  "/cms/grading/activities/:id",
  requirePermission("grading.manage"),
  async (req, res): Promise<void> => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid attempt ID" });
      return;
    }

    const parsed = markSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.errors });
      return;
    }

    const [attempt] = await db
      .select()
      .from(learningActivityAttemptsTable)
      .where(eq(learningActivityAttemptsTable.id, id))
      .limit(1);

    if (!attempt) {
      res.status(404).json({ error: "Attempt not found" });
      return;
    }

    const [lesson] = await db
      .select({ passingScore: lessonsTable.passingScore })
      .from(lessonsTable)
      .where(eq(lessonsTable.id, attempt.lessonId))
      .limit(1);

    await db
      .update(learningActivityAttemptsTable)
      .set({
        score: parsed.data.score,
        isCorrect: parsed.data.score >= (lesson?.passingScore ?? 75),
        evaluationStatus: "graded",
        gradedBy: "teacher",
        gradedByUserId: req.session.userId!,
        feedbackAr: parsed.data.feedbackAr ?? null,
        feedback: parsed.data.feedback ?? null,
        lastGradedAt: new Date(),
      })
      .where(eq(learningActivityAttemptsTable.id, id));

    await audit(req.session.userId!, "grade", "lesson_activity", id, "pending", "teacher", {
      score: parsed.data.score,
      lessonId: attempt.lessonId,
    });

    res.json({ marked: true });
  },
);

// ─── Operations ───────────────────────────────────────────────────────────────

/**
 * Run the sweep now.
 *
 * The timer runs it every ten minutes; this is for the case where an
 * administrator has just fixed the AI configuration and does not want to wait
 * to find out whether it worked.
 */
router.post("/cms/grading/sweep", requirePermission("grading.manage"), async (req, res): Promise<void> => {
  const result = await sweepStalePending();
  logger.info({ by: req.session.userId, ...result }, "Grading sweep run on demand");
  res.json({ ...result, counts: await countPendingWork() });
});

/**
 * Give an item back to the sweeper.
 *
 * Resets the retry count, for when the reason it kept failing has been fixed —
 * a provider swapped, a quota raised — and the work deserves another go rather
 * than a human's time.
 */
router.post("/cms/grading/retry/:kind/:id", requirePermission("grading.manage"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  const kind = req.params.kind as string;
  if (isNaN(id) || !["quiz_response", "lesson_activity"].includes(kind)) {
    res.status(400).json({ error: "Invalid kind or ID" });
    return;
  }

  if (kind === "quiz_response") {
    await db
      .update(quizResponsesTable)
      .set({ gradingAttempts: 0, lastGradingError: null })
      .where(eq(quizResponsesTable.id, id));
  } else {
    await db
      .update(learningActivityAttemptsTable)
      .set({ gradingAttempts: 0, lastGradingError: null })
      .where(eq(learningActivityAttemptsTable.id, id));
  }

  res.json({ reset: true });
});

/** Recently marked work, so a reviewer can see and correct what they did. */
router.get("/cms/grading/recent", requirePermission("grading.manage"), async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: quizResponsesTable.id,
      score: quizResponsesTable.score,
      gradedBy: quizResponsesTable.gradedBy,
      markedAt: quizResponsesTable.lastGradedAt,
      markerName: usersTable.name,
    })
    .from(quizResponsesTable)
    .leftJoin(usersTable, eq(usersTable.id, quizResponsesTable.gradedByUserId))
    .where(eq(quizResponsesTable.gradedBy, "teacher"))
    .orderBy(desc(quizResponsesTable.lastGradedAt))
    .limit(25);

  res.json({ items: rows });
});

export default router;
