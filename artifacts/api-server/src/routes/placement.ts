import { Router, type IRouter } from "express";
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

router.post("/placement-test/submit", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;

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

  // Validate each answer. A written question carries text instead of an option,
  // so the two shapes are checked separately rather than demanding both.
  const optionsByQuestion = new Map<number, string>();
  let writtenAnswer: string | null = null;

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

    if (question.type === "written") {
      if (typeof responseText === "string" && responseText.trim().length > 0) {
        writtenAnswer = responseText.trim().slice(0, 4000);
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

  for (const question of questions) {
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

  // A written answer is graded by the same grader lessons and quizzes use.
  // Inline, because placement happens once and the student is waiting for a
  // result they cannot proceed without — but never fatal: a failure here simply
  // leaves writing unscored.
  let writingScore: number | null = null;
  if (writtenAnswer) {
    try {
      const verdict = await gradeOpenAnswer(
        {
          question: questions.find((q) => q.type === "written")?.questionText ?? "Write about yourself.",
          studentAnswer: writtenAnswer,
          passingScore: 60,
        },
        { userId, subscriptionPlan: await resolvePlanCode(userId) },
      );
      writingScore = verdict.score;
    } catch {
      // AI unavailable, over quota, or the answer was empty. The placement
      // still completes on the objective questions alone.
    }
  }

  const outcome = scorePlacement(graded, writingScore);

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
    subscriptionPlan: await resolvePlanCode(userId),
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
      writingSample: writtenAnswer,
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

    await tx
      .update(studentProfilesTable)
      .set({ placementCompleted: true })
      .where(eq(studentProfilesTable.userId, userId));
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
});

export default router;
