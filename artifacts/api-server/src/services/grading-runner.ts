/**
 * Turning AI verdicts into recorded marks.
 *
 * The grader in `graders/open-answer.ts` judges one answer. This module decides
 * which answers need judging, records what came back, and re-finalises whatever
 * depended on the result — including promotion, when the attempt was a level
 * evaluation.
 *
 * TWO RULES
 * ─────────
 * 1. A failure to grade is never a bad mark. Every path that cannot get a
 *    verdict leaves the work `pending` for a teacher. Being unable to reach a
 *    model must not cost a student marks.
 * 2. Finalising is idempotent. It recomputes from the stored responses rather
 *    than adjusting a running total, so running it twice — a retry, a late
 *    verdict, a teacher re-grading — converges instead of drifting.
 */

import { eq, and } from "drizzle-orm";
import {
  db,
  quizzesTable,
  quizAttemptsTable,
  quizResponsesTable,
  contentBlocksTable,
  learningActivityAttemptsTable,
  mediaAssetsTable,
  exercisesTable,
  lessonsTable,
  levelsTable,
} from "@workspace/db";
import {
  gradeOpenAnswer,
  GradingUnavailableError,
  type OpenAnswerVerdict,
} from "./graders/open-answer";
import { assessSpeech, type SpeechVerdict } from "./graders/pronunciation";
import { resolvePlanCode } from "./ai-quota";
import { readingText } from "./lesson-content";
import { transcribeSpokenTurn } from "./conversation";
import {
  blockPoints,
  isNonScoring,
  type QuizBlockConfig,
} from "./quiz-grading";
import { applyEvaluationOutcome } from "./progression";
import { logger } from "../lib/logger";

/** Block types an open-answer grader can actually judge. */
const TEXT_ASSESSED = new Set(["writing", "image_describe"]);
/** Block types whose answer is a recording. */
const SPEECH_ASSESSED = new Set(["speaking_prompt"]);

/** Shape a speech verdict into the columns both attempt tables share. */
function speechColumns(verdict: SpeechVerdict) {
  return {
    score: verdict.score,
    transcript: verdict.transcript,
    pronunciationScore: verdict.pronunciationScore,
    fluencyScore: verdict.fluencyScore,
    speechMetrics: {
      ...verdict.metrics,
      problemWords: verdict.problemWords,
      fluencyUnavailable: verdict.fluencyUnavailable,
      alignment: verdict.alignment
        ? {
            matched: verdict.alignment.matched,
            substituted: verdict.alignment.substituted,
            deleted: verdict.alignment.deleted,
            inserted: verdict.alignment.inserted,
            wordErrorRate: verdict.alignment.wordErrorRate,
            coverage: verdict.alignment.coverage,
            words: verdict.alignment.words,
          }
        : null,
    },
  };
}

/**
 * The plan a student's quota is charged against.
 * No active subscription means the free plan, which is what the seeded
 * policies deny — so an unsubscribed student cannot spend tokens.
 */
async function getPlanCode(userId: number): Promise<string> {
  return resolvePlanCode(userId);
}

/** The level code an answer should be judged against. */
async function getLevelCodeForLesson(lessonId: number): Promise<string | null> {
  const [row] = await db
    .select({ code: levelsTable.code })
    .from(lessonsTable)
    .innerJoin(levelsTable, eq(lessonsTable.levelId, levelsTable.id))
    .where(eq(lessonsTable.id, lessonId))
    .limit(1);
  return row?.code ?? null;
}

// ─── Quiz attempts ────────────────────────────────────────────────────────────

/**
 * Grade every text answer in an attempt that is still waiting, then finalise.
 *
 * Blocks are graded one after another rather than in parallel: the quota is
 * per-request, and firing five concurrent calls would let a student exceed a
 * limit that each individual call passed. Sequential also keeps a burst from
 * one submission off the provider's rate limit.
 */
export async function gradeQuizAttempt(attemptId: number): Promise<void> {
  const [attempt] = await db
    .select()
    .from(quizAttemptsTable)
    .where(eq(quizAttemptsTable.id, attemptId))
    .limit(1);

  if (!attempt) return;

  const [quiz] = await db
    .select()
    .from(quizzesTable)
    .where(eq(quizzesTable.id, attempt.quizId))
    .limit(1);

  const pending = await db
    .select({
      response: quizResponsesTable,
      block: contentBlocksTable,
    })
    .from(quizResponsesTable)
    .innerJoin(contentBlocksTable, eq(quizResponsesTable.blockId, contentBlocksTable.id))
    .where(
      and(
        eq(quizResponsesTable.attemptId, attemptId),
        eq(quizResponsesTable.gradedBy, "pending"),
      ),
    );

  const planCode = await getPlanCode(attempt.userId);

  const levelCode = quiz?.levelId ? await getLevelCode(quiz.levelId) : null;

  for (const { response, block } of pending) {
    if (SPEECH_ASSESSED.has(block.type)) {
      await gradeSpokenResponse({
        responseId: response.id,
        mediaAssetId: response.mediaAssetId,
        block,
        levelCode,
        userId: attempt.userId,
        planCode,
        attemptId,
      });
      continue;
    }

    if (!TEXT_ASSESSED.has(block.type)) continue;

    const config = (block.config ?? null) as QuizBlockConfig | null;
    const answer = extractText(response.response);
    if (!answer) continue;

    let verdict: OpenAnswerVerdict;
    try {
      verdict = await gradeOpenAnswer(
        {
          question: block.prompt ?? block.title ?? "Answer the question.",
          studentAnswer: answer,
          keyPoints: config?.keyPoints,
          minWords: config?.minWords ?? null,
          passingScore: quiz?.passingScore ?? 75,
        },
        { userId: attempt.userId, subscriptionPlan: planCode },
      );
    } catch (err) {
      if (err instanceof GradingUnavailableError) {
        // Left pending on purpose — a teacher can still mark it, and the
        // student is not penalised for our provider being unavailable.
        logger.info(
          { attemptId, blockId: block.id, reason: err.reason },
          "Open answer left pending: grading unavailable",
        );
        continue;
      }
      logger.error({ err, attemptId, blockId: block.id }, "Open answer grading failed");
      continue;
    }

    await db
      .update(quizResponsesTable)
      .set({
        score: verdict.score,
        gradedBy: "ai",
        feedback: verdict.feedbackEn,
        feedbackAr: verdict.feedback,
        aiMeta: { ...verdict.meta, dimensions: verdict.dimensions },
        updatedAt: new Date(),
      })
      .where(eq(quizResponsesTable.id, response.id));
  }

  await finaliseQuizAttempt(attemptId);
}

/**
 * Recompute an attempt's score from its stored responses.
 *
 * Deliberately recomputed from scratch rather than adjusted, so this converges
 * however many times it runs. Pass/fail is withheld until nothing is pending —
 * a student must not be told they failed on a partial mark.
 */
export async function finaliseQuizAttempt(attemptId: number): Promise<void> {
  const [attempt] = await db
    .select()
    .from(quizAttemptsTable)
    .where(eq(quizAttemptsTable.id, attemptId))
    .limit(1);

  if (!attempt || attempt.status === "in_progress") return;

  const [quiz] = await db
    .select()
    .from(quizzesTable)
    .where(eq(quizzesTable.id, attempt.quizId))
    .limit(1);

  const blocks = await db
    .select()
    .from(contentBlocksTable)
    .where(
      and(
        eq(contentBlocksTable.quizId, attempt.quizId),
        eq(contentBlocksTable.isActive, true),
      ),
    );

  const responses = await db
    .select()
    .from(quizResponsesTable)
    .where(eq(quizResponsesTable.attemptId, attemptId));

  const byBlock = new Map(responses.map((r) => [r.blockId, r]));

  let earned = 0;
  let gradedPoints = 0;
  let pending = 0;

  for (const block of blocks) {
    if (isNonScoring(block.type)) continue;
    const points = blockPoints((block.config ?? null) as QuizBlockConfig | null);
    const response = byBlock.get(block.id);

    if (!response || response.score === null) {
      pending += 1;
      continue;
    }
    earned += (response.score / 100) * points;
    gradedPoints += points;
  }

  const score = gradedPoints > 0 ? (earned / gradedPoints) * 100 : 0;
  const complete = pending === 0;

  await db
    .update(quizAttemptsTable)
    .set({
      status: complete ? "graded" : "grading",
      score,
      passed: complete ? score >= (quiz?.passingScore ?? 75) : null,
      pendingReviewCount: pending,
      gradedAt: complete ? new Date() : null,
    })
    .where(eq(quizAttemptsTable.id, attemptId));

  if (complete) {
    // Promotion was withheld while anything was pending. Now that every block
    // has a verdict, the evaluation outcome can be applied — the call is safe
    // to make repeatedly and does nothing for a non-evaluation quiz.
    try {
      const outcome = await applyEvaluationOutcome(attemptId);
      if (outcome.promoted) {
        logger.info(
          { attemptId, userId: attempt.userId, toLevelId: outcome.toLevelId },
          "Student promoted after AI grading completed",
        );
      }
    } catch (err) {
      logger.error({ err, attemptId }, "Failed to apply evaluation outcome after grading");
    }
  }
}

/** Assess one recorded quiz answer and record the result. */
async function gradeSpokenResponse(args: {
  responseId: number;
  mediaAssetId: number | null;
  block: typeof contentBlocksTable.$inferSelect;
  levelCode: string | null;
  userId: number;
  planCode: string;
  attemptId: number;
}): Promise<void> {
  const { responseId, mediaAssetId, block, levelCode, userId, planCode, attemptId } = args;

  if (!mediaAssetId) return;

  const [asset] = await db
    .select()
    .from(mediaAssetsTable)
    .where(eq(mediaAssetsTable.id, mediaAssetId))
    .limit(1);

  if (!asset || asset.status !== "ready") return;

  let verdict: SpeechVerdict;
  try {
    verdict = await assessSpeech(
      {
        mediaKey: asset.key,
        mimeType: asset.mimeType,
        // Only a set passage can be aligned against. An open speaking prompt
        // has nothing to compare to, so it is scored on fluency alone.
        referenceText: block.expectsReferenceReading ? block.content : null,
        levelCode,
        prompt: block.prompt,
      },
      { userId, subscriptionPlan: planCode },
    );
  } catch (err) {
    if (err instanceof GradingUnavailableError) {
      logger.info(
        { attemptId, blockId: block.id, reason: err.reason },
        "Spoken answer left pending: assessment unavailable",
      );
      return;
    }
    logger.error({ err, attemptId, blockId: block.id }, "Speech assessment failed");
    return;
  }

  await db
    .update(quizResponsesTable)
    .set({
      ...speechColumns(verdict),
      gradedBy: "ai",
      feedbackAr: verdict.feedback,
      aiMeta: verdict.meta,
      updatedAt: new Date(),
    })
    .where(eq(quizResponsesTable.id, responseId));
}

/** The level code a quiz or lesson belongs to, for fluency expectations. */
async function getLevelCode(levelId: number): Promise<string | null> {
  const [row] = await db
    .select({ code: levelsTable.code })
    .from(levelsTable)
    .where(eq(levelsTable.id, levelId))
    .limit(1);
  return row?.code ?? null;
}

// ─── Lesson activities ────────────────────────────────────────────────────────

/**
 * Grade one open-ended answer submitted inside a lesson.
 *
 * Returns the verdict, or null when it could not be graded — the caller keeps
 * the attempt pending and lets the student carry on. A lesson must never stall
 * on an AI call.
 */
/**
 * The authored concept list, as a list.
 *
 * Stored as free text, so it arrives however the author typed it: commas,
 * newlines, or semicolons. Splitting on all three is more forgiving than
 * demanding one format from a non-technical content manager.
 */
function splitConcepts(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\r\n,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export async function gradeLessonActivity(
  activityAttemptId: number,
): Promise<OpenAnswerVerdict | null> {
  const [attempt] = await db
    .select()
    .from(learningActivityAttemptsTable)
    .where(eq(learningActivityAttemptsTable.id, activityAttemptId))
    .limit(1);

  if (!attempt || attempt.evaluationStatus !== "pending") {
    return null;
  }

  // A spoken open-ended answer arrives as audio with no text. Transcribe it
  // first and store the transcript, so the rubric grader below sees the same
  // shape whether the student typed or spoke, and so a teacher reviewing the
  // attempt can read what was said.
  let studentAnswer = attempt.responseText;
  if (!studentAnswer && attempt.mediaAssetId) {
    const [asset] = await db
      .select()
      .from(mediaAssetsTable)
      .where(eq(mediaAssetsTable.id, attempt.mediaAssetId))
      .limit(1);

    if (!asset || asset.status !== "ready") return null;

    try {
      studentAnswer = await transcribeSpokenTurn(asset.key, asset.mimeType, {
        userId: attempt.userId,
        subscriptionPlan: await getPlanCode(attempt.userId),
      });
    } catch (err) {
      // Leave it pending rather than failing it: the sweeper will try again,
      // and a transcription outage must not mark a student's answer wrong.
      logger.info(
        { activityAttemptId, err },
        "Spoken answer left pending: transcription unavailable",
      );
      return null;
    }

    await db
      .update(learningActivityAttemptsTable)
      .set({ responseText: studentAnswer })
      .where(eq(learningActivityAttemptsTable.id, attempt.id));
  }

  if (!studentAnswer) return null;

  const [exercise] = attempt.exerciseId
    ? await db
        .select()
        .from(exercisesTable)
        .where(eq(exercisesTable.id, attempt.exerciseId))
        .limit(1)
    : [null];

  const [lesson] = await db
    .select({ passingScore: lessonsTable.passingScore })
    .from(lessonsTable)
    .where(eq(lessonsTable.id, attempt.lessonId))
    .limit(1);

  const [planCode, levelCode] = await Promise.all([
    getPlanCode(attempt.userId),
    getLevelCodeForLesson(attempt.lessonId),
  ]);

  let verdict: OpenAnswerVerdict;
  // What a content manager authored as the standard to judge against. Both
  // fields are free text in the CMS — `expected_concepts` is typically a comma
  // or newline separated list — so they are split rather than assumed to be
  // one phrase. Without these the model was marking answers against the
  // question alone, which is not what the author specified.
  const keyPoints = [
    ...splitConcepts(exercise?.expectedConcepts),
    ...(exercise?.modelAnswer ? [`A model answer: ${exercise.modelAnswer}`] : []),
  ];

  try {
    verdict = await gradeOpenAnswer(
      {
        question: exercise?.question ?? exercise?.prompt ?? "Answer the question.",
        studentAnswer,
        keyPoints: keyPoints.length > 0 ? keyPoints : undefined,
        levelCode,
        passingScore: lesson?.passingScore ?? 75,
      },
      { userId: attempt.userId, subscriptionPlan: planCode },
    );
  } catch (err) {
    if (err instanceof GradingUnavailableError) {
      logger.info(
        { activityAttemptId, reason: err.reason },
        "Lesson answer left pending: grading unavailable",
      );
      return null;
    }
    logger.error({ err, activityAttemptId }, "Lesson answer grading failed");
    return null;
  }

  await db
    .update(learningActivityAttemptsTable)
    .set({
      score: verdict.score,
      isCorrect: verdict.correct,
      evaluationStatus: "graded",
      gradedBy: "ai",
      feedback: verdict.feedbackEn,
      feedbackAr: verdict.feedback,
      aiMeta: { ...verdict.meta, dimensions: verdict.dimensions },
    })
    .where(eq(learningActivityAttemptsTable.id, activityAttemptId));

  return verdict;
}

/**
 * Assess a recording submitted inside a lesson.
 *
 * Runs as a background job rather than inline, unlike the written-answer path:
 * this downloads the audio and waits on a speech recogniser, which is seconds
 * of work. Holding a student's lesson open for that would break the rule that
 * the lesson flow never stalls on AI.
 */
export async function gradeSpeakingActivity(
  activityAttemptId: number,
): Promise<SpeechVerdict | null> {
  const [attempt] = await db
    .select()
    .from(learningActivityAttemptsTable)
    .where(eq(learningActivityAttemptsTable.id, activityAttemptId))
    .limit(1);

  if (!attempt || attempt.evaluationStatus !== "pending" || !attempt.mediaAssetId) {
    return null;
  }

  const [asset] = await db
    .select()
    .from(mediaAssetsTable)
    .where(eq(mediaAssetsTable.id, attempt.mediaAssetId))
    .limit(1);

  if (!asset || asset.status !== "ready") return null;

  const [block] = await db
    .select()
    .from(contentBlocksTable)
    .where(eq(contentBlocksTable.id, attempt.blockId))
    .limit(1);

  const [lesson] = await db
    .select({ levelId: lessonsTable.levelId })
    .from(lessonsTable)
    .where(eq(lessonsTable.id, attempt.lessonId))
    .limit(1);

  // The task may be authored on the exercise rather than the block.
  const [exercise] = attempt.exerciseId
    ? await db
        .select()
        .from(exercisesTable)
        .where(eq(exercisesTable.id, attempt.exerciseId))
        .limit(1)
    : [null];

  const [planCode, levelCode] = await Promise.all([
    getPlanCode(attempt.userId),
    lesson ? getLevelCode(lesson.levelId) : Promise.resolve(null),
  ]);

  let verdict: SpeechVerdict;
  try {
    verdict = await assessSpeech(
      {
        mediaKey: asset.key,
        mimeType: asset.mimeType,
        referenceText: block?.expectsReferenceReading ? readingText(block.content) : null,
        levelCode,
        // A content manager may author the task on the block or on its
        // exercise — the Corner Café lesson puts everything on the exercise and
        // leaves the block's own prompt empty. Falling through means the
        // assessor is told what was asked either way.
        //
        // The exercise comes first: a speaking block can hold several prompts,
        // one per exercise, and the block's own prompt only mirrors the first.
        // Blank strings count as absent — the editor saves "" for empty fields.
        prompt:
          [exercise?.prompt, block?.prompt, exercise?.question].find(
            (p): p is string => !!p && p.trim() !== "",
          ) ?? undefined,
        modelAnswer: exercise?.modelAnswer ?? null,
      },
      { userId: attempt.userId, subscriptionPlan: planCode },
    );
  } catch (err) {
    if (err instanceof GradingUnavailableError) {
      logger.info(
        { activityAttemptId, reason: err.reason },
        "Spoken answer left pending: assessment unavailable",
      );
      return null;
    }
    logger.error({ err, activityAttemptId }, "Speech assessment failed");
    return null;
  }

  const [lessonRow] = await db
    .select({ passingScore: lessonsTable.passingScore })
    .from(lessonsTable)
    .where(eq(lessonsTable.id, attempt.lessonId))
    .limit(1);

  await db
    .update(learningActivityAttemptsTable)
    .set({
      ...speechColumns(verdict),
      isCorrect: verdict.score >= (lessonRow?.passingScore ?? 75),
      evaluationStatus: "graded",
      gradedBy: "ai",
      feedbackAr: verdict.feedback,
      aiMeta: verdict.meta,
    })
    .where(eq(learningActivityAttemptsTable.id, activityAttemptId));

  return verdict;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** A quiz `response` is a JSON bag; pull the written text out of it. */
function extractText(response: unknown): string | null {
  if (typeof response === "string") return response.trim() || null;
  if (response && typeof response === "object") {
    const text = (response as Record<string, unknown>).text;
    if (typeof text === "string") return text.trim() || null;
  }
  return null;
}

export { getPlanCode };
