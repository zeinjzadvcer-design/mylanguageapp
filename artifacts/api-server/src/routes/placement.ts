import { Router, type IRouter, type Request, type Response } from "express";
import { resolvePlanCode } from "../services/ai-quota";
import { eq, asc } from "drizzle-orm";
import { and } from "drizzle-orm";
import {
  db,
  placementQuestionsTable,
  placementOptionsTable,
  placementResultsTable,
  studentProfilesTable,
  levelsTable,
  curriculaTable } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { setStudentLevel } from "../services/progression";
import {
  scorePlacement,
  applyLevelAdjustment,
  type AnsweredQuestion,
} from "../services/scoring/placement";
import { analysePlacement } from "../services/placement-analysis";
import { gradeOpenAnswer } from "../services/graders/open-answer";
import { getPlacementRules } from "../services/placement-rules";
import { logger } from "../lib/logger";
import { withRedis } from "../services/redis";

const router: IRouter = Router();

router.get("/placement-test", async (req, res): Promise<void> => {
  const questions = await db
    .select()
    .from(placementQuestionsTable)
    .where(eq(placementQuestionsTable.isActive, true))
    .orderBy(asc(placementQuestionsTable.order));
  const allOptions = await db.select().from(placementOptionsTable);

  const questionsWithOptions = questions.map((q) => ({
    id: q.id,
    questionText: q.questionText,
    questionTextAr: q.questionTextAr,
    type: q.type,
    // The skill is shown so the test can be grouped into sections a student
    // understands — "Reading", "Grammar" — rather than one undifferentiated
    // list of twenty questions.
    skill: q.skill,
    passage: q.passage,
    // The clip a listening question is about. Resolved to a playable URL by the
    // client through /media/:id/url — without it the question is unanswerable.
    mediaId: q.mediaId ?? null,
    order: q.order,
    options: allOptions
      .filter((o) => o.questionId === q.id)
      .map((o) => ({ id: o.optionId, text: o.text, textAr: o.textAr ?? null })),
  }));

  res.json({ questions: questionsWithOptions });
});

/** Raised inside the save when another submission completed placement first. */
class PlacementAlreadyCompleted extends Error {}

router.post("/placement-test/submit", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;

  // One submission at a time per student. Marking calls the AI outside the
  // plan allowance, and the "already completed" check below only sees
  // submissions that have finished — so without this, many sent at once would
  // each be marked and each place the student. Redis down: the save itself
  // still refuses a second placement.
  const lockKey = `v1:placement:submit:${userId}`;
  const locked = await withRedis(
    async (r) => (await r.set(lockKey, "1", "EX", 120, "NX")) === "OK",
    true,
  );
  if (!locked) {
    res.status(409).json({
      error: "Your placement test is already being marked.",
      errorAr: "يجري تقييم اختبار تحديد المستوى الخاص بك الآن.",
    });
    return;
  }
  try {
    await submitPlacement(req, res, userId);
  } catch (err) {
    if (!(err instanceof PlacementAlreadyCompleted)) throw err;
    res.status(409).json({ error: "Placement test already completed" });
  } finally {
    await withRedis((r) => r.del(lockKey), 0);
  }
});

async function submitPlacement(req: Request, res: Response, userId: number): Promise<void> {
  // Reject retaking placement once completed (409)
  const [profile] = await db
    .select()
    .from(studentProfilesTable)
    .where(eq(studentProfilesTable.userId, userId))
    .limit(1);

  if (profile?.placementCompleted) {
    res.status(409).json({ error: "Placement test already completed" });
    return;
  }

  const { answers } = req.body;
  if (!Array.isArray(answers) || answers.length === 0) {
    res.status(400).json({ error: "Answers array is required" });
    return;
  }

  const questions = await db
    .select()
    .from(placementQuestionsTable)
    .orderBy(asc(placementQuestionsTable.order));
  const allOptions = await db.select().from(placementOptionsTable);

  // Validate: no duplicate question IDs in submitted answers
  const submittedQuestionIds = answers.map((a: { questionId: unknown }) => a.questionId);
  const uniqueSubmittedIds = new Set(submittedQuestionIds);
  if (uniqueSubmittedIds.size !== submittedQuestionIds.length) {
    res.status(400).json({ error: "Duplicate question IDs in answers" });
    return;
  }

  // Validate: all submitted question IDs must exist in the actual test
  const validQuestionIds = new Set(questions.map((q) => q.id));
  for (const qid of submittedQuestionIds) {
    if (!validQuestionIds.has(qid as number)) {
      res.status(400).json({ error: `Unknown question ID: ${qid}` });
      return;
    }
  }

  const questionById = new Map(questions.map((q) => [q.id, q]));
  // Only the questions the test shows count. A question switched off since the
  // student loaded the test is ignored, not counted against them.
  const activeQuestions = questions.filter((q) => q.isActive);

  // Validate each answer. A written question carries text instead of an option,
  // so the two shapes are checked separately rather than demanding both.
  const optionsByQuestion = new Map<number, string>();
  /** Each written question's answer, so each is marked against its own question. */
  const writtenAnswers = new Map<number, string>();

  for (const answer of answers) {
    const { questionId, selectedOptionId, responseText } = answer as {
      questionId: number;
      selectedOptionId?: string;
      responseText?: string;
    };
    const question = questionById.get(questionId);
    if (!question) {
      res.status(400).json({ error: `Unknown question ID: ${questionId}` });
      return;
    }
    if (!question.isActive) continue;

    if (question.type === "written") {
      if (typeof responseText === "string" && responseText.trim().length > 0) {
        writtenAnswers.set(questionId, responseText.trim().slice(0, 4000));
      }
      continue;
    }

    if (!selectedOptionId) {
      res.status(400).json({ error: `Question ${questionId} needs a selected option` });
      return;
    }
    // Validate option belongs to the question (reject foreign options)
    const validOptions = allOptions.filter(
      (o) => o.questionId === questionId && o.optionId === selectedOptionId,
    );
    if (validOptions.length === 0) {
      res.status(400).json({ error: `Invalid option '${selectedOptionId}' for question ${questionId}` });
      return;
    }
    optionsByQuestion.set(questionId, selectedOptionId);
  }

  // Score every objective question, tagged with the skill and difficulty it was
  // written for — that labelling is what makes a per-skill breakdown possible
  // at all. Unanswered counts as incorrect.
  const graded: AnsweredQuestion[] = [];
  let correct = 0;

  for (const question of activeQuestions) {
    if (question.type === "written") continue;
    const selectedOptionId = optionsByQuestion.get(question.id);
    const isCorrect = selectedOptionId
      ? allOptions.some(
          (o) =>
            o.questionId === question.id &&
            o.optionId === selectedOptionId &&
            o.isCorrect,
        )
      : false;
    if (isCorrect) correct++;
    graded.push({
      skill: question.skill as AnsweredQuestion["skill"],
      difficulty: question.difficulty as AnsweredQuestion["difficulty"],
      correct: isCorrect,
    });
  }

  const total = graded.length;
  const percentage = total > 0 ? (correct / total) * 100 : 0;

  // Written answers are graded by the same grader lessons and quizzes use.
  // Inline, because placement happens once and the student is waiting for a
  // result they cannot proceed without — but never fatal: a failure here simply
  // leaves that answer unscored.
  //
  // Not counted against the plan: students take placement straight after
  // registering, nearly always on the free plan, whose allowance is zero — so
  // the writing was never marked at all. Each answer is judged against the
  // level its question was written for; with no level the grader assumed
  // "beginner" and scored generously.
  const planCode = await resolvePlanCode(userId);
  const written = activeQuestions.filter((q) => q.type === "written" && writtenAnswers.has(q.id));
  const writingScores = (
    await Promise.all(
      written.map(async (q) => {
        try {
          const verdict = await gradeOpenAnswer(
            {
              question: q.questionText,
              studentAnswer: writtenAnswers.get(q.id)!,
              levelCode: q.difficulty,
              passingScore: 60,
            },
            { userId, subscriptionPlan: planCode, quotaExempt: true },
          );
          return verdict.score;
        } catch (err) {
          // AI off, out of budget, or the provider failed. The placement still
          // completes on everything else; the reason is logged for the admin.
          logger.warn(
            { userId, questionId: q.id, reason: (err as { reason?: string })?.reason ?? String(err) },
            "Placement writing left unmarked",
          );
          return null;
        }
      }),
    )
  ).filter((s): s is number => s !== null);

  const writingSample = written.length
    ? written.map((q) => writtenAnswers.get(q.id)!).join("\n\n---\n\n")
    : null;
  const writingScore = writingScores.length
    ? Math.round(writingScores.reduce((a, b) => a + b, 0) / writingScores.length)
    : null;

  const rules = await getPlacementRules();
  const outcome = scorePlacement(graded, writingScores, rules);

  // Resolve the student's curriculum
  let curriculumId = profile?.curriculumId ?? null;
  if (!curriculumId) {
    const [defaultCurriculum] = await db
      .select({ id: curriculaTable.id })
      .from(curriculaTable)
      .where(eq(curriculaTable.isActive, true))
      .orderBy(curriculaTable.id)
      .limit(1);
    curriculumId = defaultCurriculum?.id ?? null;
  }

  if (!curriculumId) {
    res.status(500).json({ error: "No curriculum configured — cannot assign a level" });
    return;
  }

  // Every level in this curriculum, in order — both to resolve the computed
  // level code to a row and to bound what the AI is allowed to suggest.
  const levels = await db
    .select()
    .from(levelsTable)
    .where(eq(levelsTable.curriculumId, curriculumId))
    .orderBy(asc(levelsTable.order));

  if (levels.length === 0) {
    res.status(500).json({ error: "No levels found in curriculum — cannot assign a level" });
    return;
  }

  const orderedCodes = levels.map((l) => l.code);

  // The AI reads the profile and may move the level by one step. It cannot do
  // more than that: applyLevelAdjustment enforces the bound whatever comes
  // back, and a placement with no AI at all still assigns a level.
  const analysis = await analysePlacement(outcome, orderedCodes, {
    userId,
    subscriptionPlan: planCode,
    quotaExempt: true,
  });

  const { levelCode, adjusted } = applyLevelAdjustment(
    outcome,
    analysis?.suggestedLevelCode,
    orderedCodes,
  );

  // The computed code is a CEFR label; a curriculum may not use those at all.
  // Fall back to position rather than failing: an unusual level scheme should
  // not stop a student being placed.
  const level =
    levels.find((l) => l.code === levelCode) ??
    levels[Math.min(levels.length - 1, Math.floor((outcome.overall / 100) * levels.length))];

  const skillScores = Object.fromEntries(
    outcome.skills.filter((s) => s.score !== null).map((s) => [s.skill, s.score]),
  );

  // Save result and update profile transactionally.
  // The level itself is written through setStudentLevel rather than here, so
  // that placement lands in level_progressions like every other level change
  // and an administrator override later has something to override.
  await db.transaction(async (tx) => {
    // Claimed first and only once: a second submission that got this far
    // (Redis down, or the lock expired) is refused here, before it can write
    // a second result or move the student again.
    if (profile) {
      const claimed = await tx
        .update(studentProfilesTable)
        .set({ placementCompleted: true })
        .where(and(eq(studentProfilesTable.userId, userId), eq(studentProfilesTable.placementCompleted, false)))
        .returning({ userId: studentProfilesTable.userId });
      if (claimed.length === 0) throw new PlacementAlreadyCompleted();
    }

    await tx.insert(placementResultsTable).values({
      userId,
      curriculumId,
      score: correct,
      total,
      percentage,
      assignedLevelCode: level.code,
      assignedLevelId: level.id,
      skillScores,
      strengths: outcome.strengths,
      weaknesses: outcome.weaknesses,
      analysisAr: analysis?.analysisAr ?? null,
      writingSample,
      writingScore,
      computedLevelCode: outcome.levelCode,
      adjustmentReason: adjusted ? (analysis?.adjustmentReason ?? "AI adjustment") : null,
    });

    await setStudentLevel(
      {
        userId,
        curriculumId,
        toLevelId: level.id,
        reason: "placement",
        note:
          `Placement: ${outcome.overall}% weighted` +
          (adjusted ? ` — moved from ${outcome.levelCode} (${analysis?.adjustmentReason ?? "AI"})` : ""),
      },
      tx,
    );
  });

  res.json({
    score: correct,
    total,
    percentage,
    // The weighted figure the level actually came from. `percentage` is kept
    // for the existing client contract, but it is not what decided anything.
    weightedScore: outcome.overall,
    assignedLevelCode: level.code,
    assignedLevelName: level.name,
    assignedLevelNameAr: level.nameAr,
    computedLevelCode: outcome.levelCode,
    adjusted,
    adjustmentReason: adjusted ? (analysis?.adjustmentReason ?? null) : null,
    skillScores,
    strengths: outcome.strengths,
    weaknesses: outcome.weaknesses,
    writingScore,
    analysisAr: analysis?.analysisAr ?? null,
    message: `You have been placed at ${level.name}`,
    messageAr: `تم تصنيفك في مستوى ${level.nameAr}`,
  });
}

export default router;
