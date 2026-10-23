import { Router, type IRouter } from "express";
import { eq, and, asc, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
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
  vocabularyTable,
  studentProfilesTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { cached, CK, TTL } from "../services/cache";
import {
  getCompletedLessonIds,
  getCompletedBlockIds,
  deriveLessonStateWithOrders,
  getStudentCurriculumContext,
  getCurriculumLevels,
  resolveAudioUrl,
  deriveLessonScore,
  getMissingRequiredBlockIds,
  maybeAdvanceLevel,
  findNextLesson,
  publishedLessonFilter,
} from "../services/learning";
import { assertUsableRecording, MediaValidationError } from "../services/media";
import { gradeLessonActivity } from "../services/grading-runner";
import { jobs } from "../services/jobs";

const router: IRouter = Router();

// ─── GET /lessons ─────────────────────────────────────────────────────────────
// Returns lessons in the caller's curriculum with authoritative state values.
//
// requireAuth rather than requireStudent, here and on every lesson route below.
// Taking a lesson is not student-only: an admin or content manager needs to walk
// the real student flow to check their own content, and refusing them left the
// level page listing nothing at all. Every handler resolves the caller's own
// curriculum context and answers 403 when there is none, so a role without a
// student profile is turned away by the data rather than by the role check.
router.get("/lessons", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const levelId = req.query.levelId ? parseInt(req.query.levelId as string, 10) : undefined;

  const ctx = await getStudentCurriculumContext(userId);
  if (!ctx) {
    res.status(403).json({ error: "No curriculum assigned. Complete placement test first." });
    return;
  }

  // Determine current level order for state derivation
  let currentLevelOrder: number | null = null;
  if (ctx.currentLevelId) {
    const [lvl] = await db
      .select({ order: levelsTable.order })
      .from(levelsTable)
      .where(eq(levelsTable.id, ctx.currentLevelId))
      .limit(1);
    currentLevelOrder = lvl?.order ?? null;
  }

  // Only show lessons from the student's curriculum
  const levelIds = await db
    .select({ id: levelsTable.id, order: levelsTable.order })
    .from(levelsTable)
    .where(eq(levelsTable.curriculumId, ctx.curriculumId));

  const allowedLevelIds = levelIds.map((l) => l.id);
  const levelOrderMap = new Map(levelIds.map((l) => [l.id, l.order]));

  if (allowedLevelIds.length === 0) {
    res.json([]);
    return;
  }

  const whereFilter = levelId
    ? and(
        eq(lessonsTable.levelId, levelId),
        inArray(lessonsTable.levelId, allowedLevelIds),
        publishedLessonFilter(),
      )
    : and(inArray(lessonsTable.levelId, allowedLevelIds), publishedLessonFilter());

  const [lessons, completedIds, progressRows] = await Promise.all([
    db.select().from(lessonsTable).where(whereFilter).orderBy(asc(lessonsTable.order)),
    getCompletedLessonIds(userId),
    db
      .select()
      .from(lessonProgressTable)
      .where(eq(lessonProgressTable.userId, userId)),
  ]);

  // Group lessons by level for sequential unlock calculation
  const lessonsByLevel = new Map<number, typeof lessons>();
  for (const lesson of lessons) {
    const arr = lessonsByLevel.get(lesson.levelId) ?? [];
    arr.push(lesson);
    lessonsByLevel.set(lesson.levelId, arr);
  }

  const result = lessons.map((lesson) => {
    const levelOrder = levelOrderMap.get(lesson.levelId) ?? 999;
    const levelLessons = (lessonsByLevel.get(lesson.levelId) ?? []).sort(
      (a, b) => a.order - b.order,
    );
    const idx = levelLessons.findIndex((l) => l.id === lesson.id);
    const prevLessonId = idx > 0 ? levelLessons[idx - 1].id : null;
    const progressRow = progressRows.find((p) => p.lessonId === lesson.id);
    const state = deriveLessonStateWithOrders(
      lesson,
      levelOrder,
      currentLevelOrder,
      completedIds,
      prevLessonId,
      progressRow?.status,
    );

    return {
      id: lesson.id,
      levelId: lesson.levelId,
      title: lesson.title,
      titleAr: lesson.titleAr,
      description: lesson.description ?? null,
      descriptionAr: lesson.descriptionAr ?? null,
      order: lesson.order,
      lessonType: lesson.lessonType,
      estimatedMinutes: lesson.estimatedMinutes,
      state,
      // Legacy compatibility
      isUnlocked: state !== "LOCKED",
      isCompleted: state === "COMPLETED",
      bestScore: progressRow?.bestScore ?? null,
      xpReward: lesson.xpReward,
    };
  });

  res.json(result);
});

// ─── Lesson content bundle (cached) ──────────────────────────────────────────

interface LessonContentBundle {
  lesson: {
    id: number;
    levelId: number;
    title: string;
    titleAr: string;
    description: string | null;
    descriptionAr: string | null;
    order: number;
    lessonType: string;
    estimatedMinutes: number;
    xpReward: number;
    passingScore: number;
    contentVersion: number;
    objectives: string[] | null;
    objectivesAr: string[] | null;
  };
  levelCode: string;
  levelOrder: number;
  levelId: number;
  levelCurriculumId: number;
  contentBlocks: Array<{
    id: number;
    type: string;
    order: number;
    title: string | null;
    titleAr: string | null;
    instructions: string | null;
    instructionsAr: string | null;
    isRequired: boolean;
    estimatedMinutes: number | null;
    config: unknown;
    content: string | null;
    contentAr: string | null;
    audioNote: string | null;
    vocabularyItems: Array<{
      id: number;
      levelId: number;
      lessonId: number | null;
      word: string;
      translation: string;
      exampleSentence: string | null;
      exampleSentenceAr: string | null;
      pronunciation: string | null;
      audioNote: string | null;
    }> | null;
    exerciseId: number | null;
    exerciseType: string | null;
    question: string | null;
    questionAr: string | null;
    options: Array<{ id: string; text: string; textAr: string | null }> | null;
    prompt: string | null;
    promptAr: string | null;
    exampleAudio: string | null;
    audioUrl: string | null;
    referenceMediaId: number | null;
    /** Optional illustration media. No grading meaning. */
    imageMediaId: number | null;
    audioMediaId: number | null;
  }>;
}

/**
 * Treats a blank string as a missing value. The CMS writes "" for text fields
 * left untouched, so `??` alone would prefer an empty block column over a real
 * value stored on the exercise.
 */
function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.trim() === "" ? null : value;
}

async function loadLessonContent(lessonId: number): Promise<LessonContentBundle | null> {
  const [lesson] = await db
    .select()
    .from(lessonsTable)
    .where(and(eq(lessonsTable.id, lessonId), publishedLessonFilter()))
    .limit(1);
  if (!lesson) return null;

  const [level, blocks, exercises, vocab] = await Promise.all([
    db
      .select()
      .from(levelsTable)
      .where(eq(levelsTable.id, lesson.levelId))
      .limit(1)
      .then((r) => r[0]),
    db
      .select()
      .from(contentBlocksTable)
      .where(and(eq(contentBlocksTable.lessonId, lessonId), eq(contentBlocksTable.isActive, true)))
      .orderBy(asc(contentBlocksTable.order)),
    // Ordered so a question keeps its position for the student across saves.
    db.select().from(exercisesTable).where(eq(exercisesTable.lessonId, lessonId))
      .orderBy(asc(exercisesTable.ordering), asc(exercisesTable.id)),
    db.select().from(vocabularyTable).where(eq(vocabularyTable.lessonId, lessonId)),
  ]);

  const exerciseIds = exercises.map((e) => e.id);
  const allOptions =
    exerciseIds.length > 0
      ? await db
          .select()
          .from(exerciseOptionsTable)
          .where(inArray(exerciseOptionsTable.exerciseId, exerciseIds))
      : [];

  const contentBlocks = blocks.map((block) => {
    // A block can hold several questions; the singular fields below describe
    // the first, and `questions` carries them all.
    // Already ordered by the query; filter preserves that order.
    const blockExercises = exercises.filter((e) => e.contentBlockId === block.id);
    const exercise = blockExercises[0] ?? null;
    const optionsFor = (exerciseId: number) =>
      allOptions
        .filter((o) => o.exerciseId === exerciseId)
        .map((o) => ({ id: o.optionId, text: o.text, textAr: o.textAr ?? null }));
    const options = exercise ? optionsFor(exercise.id) : null;

    return {
      id: block.id,
      type: block.type,
      order: block.order,
      title: block.title ?? null,
      titleAr: block.titleAr ?? null,
      instructions: block.instructions ?? null,
      instructionsAr: block.instructionsAr ?? null,
      isRequired: block.isRequired,
      estimatedMinutes: block.estimatedMinutes ?? null,
      config: block.config ?? null,
      content: block.content ?? null,
      contentAr: block.contentAr ?? null,
      audioNote: block.audioNote ?? null,
      vocabularyItems:
        block.type === "vocabulary_list"
          ? vocab.map((v) => ({
              id: v.id,
              levelId: v.levelId,
              lessonId: v.lessonId ?? null,
              word: v.word,
              translation: v.translation,
              exampleSentence: v.exampleSentence ?? null,
              exampleSentenceAr: v.exampleSentenceAr ?? null,
              pronunciation: v.pronunciation ?? null,
              audioNote: v.audioNote ?? null,
            }))
          : null,
      exerciseId: exercise?.id ?? null,
      exerciseType: exercise?.exerciseType ?? null,
      question: exercise?.question ?? null,
      questionAr: exercise?.questionAr ?? null,
      // Never expose correctOptionId before submission
      options,
      /** Every question on this block, in order. Answer keys stay server-side. */
      questions: blockExercises.map((e) => ({
        exerciseId: e.id,
        exerciseType: e.exerciseType,
        question: e.question,
        questionAr: e.questionAr ?? null,
        options: optionsFor(e.id),
      })),
      // The CMS speaking and open-ended editors write the question onto the
      // exercise row, while every other block type carries it on the block
      // itself. Fall back to the exercise so a block authored that way still
      // shows its prompt instead of an empty screen. `question` is the
      // open-ended editor's field, `prompt` the speaking one's. Empty strings
      // count as absent: the editor saves "" rather than NULL for a field it
      // never filled.
      prompt:
        emptyToNull(block.prompt) ??
        emptyToNull(exercise?.prompt) ??
        emptyToNull(exercise?.question) ??
        null,
      promptAr:
        emptyToNull(block.promptAr) ??
        emptyToNull(exercise?.promptAr) ??
        emptyToNull(exercise?.questionAr) ??
        null,
      exampleAudio: block.exampleAudio ?? null,
      audioUrl: resolveAudioUrl(block, exercise),
      // Resolved to a playable URL by the client through /media/:id/url rather
      // than presigned here — a lesson can hold many blocks, and signing every
      // one on every load would be wasted work for the ones never played.
      referenceMediaId: block.referenceMediaId ?? null,
      // Resolved to a playable URL by the client, same as referenceMediaId.
      imageMediaId: block.imageMediaId ?? null,
      audioMediaId: block.audioMediaId ?? null,
    };
  });

  return {
    lesson: {
      id: lesson.id,
      levelId: lesson.levelId,
      title: lesson.title,
      titleAr: lesson.titleAr,
      description: lesson.description ?? null,
      descriptionAr: lesson.descriptionAr ?? null,
      order: lesson.order,
      lessonType: lesson.lessonType,
      estimatedMinutes: lesson.estimatedMinutes,
      xpReward: lesson.xpReward,
      passingScore: lesson.passingScore,
      contentVersion: lesson.contentVersion,
      objectives: lesson.objectives ?? null,
      objectivesAr: lesson.objectivesAr ?? null,
    },
    levelCode: level?.code ?? "",
    levelOrder: level?.order ?? 1,
    levelId: level?.id ?? lesson.levelId,
    levelCurriculumId: level?.curriculumId ?? 0,
    contentBlocks,
  };
}

// ─── GET /lessons/:lessonId ───────────────────────────────────────────────────

router.get("/lessons/:lessonId", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.lessonId) ? req.params.lessonId[0] : req.params.lessonId;
  const lessonId = parseInt(raw, 10);
  if (isNaN(lessonId)) {
    res.status(400).json({ error: "Invalid lesson ID" });
    return;
  }

  const userId = req.session.userId!;

  // Load static content from cache
  const bundle = await cached(CK.lessonContent(lessonId), TTL.LESSON_CONTENT, () =>
    loadLessonContent(lessonId),
  );

  if (!bundle) {
    res.status(404).json({ error: "Lesson not found" });
    return;
  }

  // Enforce curriculum access
  const ctx = await getStudentCurriculumContext(userId);
  if (!ctx || ctx.curriculumId !== bundle.levelCurriculumId) {
    res.status(403).json({ error: "You do not have access to this lesson" });
    return;
  }

  const [completedIds, progressRow, currentLevel] = await Promise.all([
    getCompletedLessonIds(userId),
    db
      .select()
      .from(lessonProgressTable)
      .where(
        and(
          eq(lessonProgressTable.userId, userId),
          eq(lessonProgressTable.lessonId, lessonId),
        ),
      )
      .limit(1)
      .then((r) => r[0] ?? null),
    ctx.currentLevelId
      ? db
          .select({ order: levelsTable.order })
          .from(levelsTable)
          .where(eq(levelsTable.id, ctx.currentLevelId))
          .limit(1)
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
  ]);

  // Find the previous lesson in order for unlock derivation
  const prevLessonId = await (async () => {
    if (bundle.lesson.order <= 1) return null;
    const siblings = await db
      .select({ id: lessonsTable.id, order: lessonsTable.order })
      .from(lessonsTable)
      .where(
        and(
          eq(lessonsTable.levelId, bundle.lesson.levelId),
          eq(lessonsTable.status, "published"),
          isNull(lessonsTable.softDeletedAt),
        ),
      )
      .orderBy(asc(lessonsTable.order));
    const idx = siblings.findIndex((l) => l.id === lessonId);
    return idx > 0 ? siblings[idx - 1].id : null;
  })();

  const currentLevelOrder = currentLevel?.order ?? null;
  const state = deriveLessonStateWithOrders(
    bundle.lesson,
    bundle.levelOrder,
    currentLevelOrder,
    completedIds,
    prevLessonId,
    progressRow?.status,
  );

  // Enforce that locked lessons are not accessible for detail
  if (state === "LOCKED") {
    res.status(403).json({ error: "This lesson is locked" });
    return;
  }

  const completedBlockIds = await getCompletedBlockIds(
    userId,
    lessonId,
    bundle.lesson.contentVersion,
  );

  res.json({
    id: bundle.lesson.id,
    levelId: bundle.lesson.levelId,
    levelCode: bundle.levelCode,
    title: bundle.lesson.title,
    titleAr: bundle.lesson.titleAr,
    description: bundle.lesson.description,
    descriptionAr: bundle.lesson.descriptionAr,
    order: bundle.lesson.order,
    lessonType: bundle.lesson.lessonType,
    estimatedMinutes: bundle.lesson.estimatedMinutes,
    contentVersion: bundle.lesson.contentVersion,
    state,
    // Legacy
    isUnlocked: true,
    isCompleted: state === "COMPLETED",
    bestScore: progressRow?.bestScore ?? null,
    xpReward: bundle.lesson.xpReward,
    passingScore: bundle.lesson.passingScore,
    contentBlocks: bundle.contentBlocks,
    completedBlockIds,
    objectives: bundle.lesson.objectives,
    objectivesAr: bundle.lesson.objectivesAr,
  });
});

// ─── POST /lessons/:lessonId/start ────────────────────────────────────────────

router.post("/lessons/:lessonId/start", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.lessonId) ? req.params.lessonId[0] : req.params.lessonId;
  const lessonId = parseInt(raw, 10);
  const userId = req.session.userId!;

  if (isNaN(lessonId)) {
    res.status(400).json({ error: "Invalid lesson ID" });
    return;
  }

  const [lessonRow] = await db
    .select()
    .from(lessonsTable)
    .where(and(eq(lessonsTable.id, lessonId), publishedLessonFilter()))
    .limit(1);

  if (!lessonRow) {
    res.status(404).json({ error: "Lesson not found" });
    return;
  }

  // Enforce curriculum access
  const ctx = await getStudentCurriculumContext(userId);
  if (!ctx) {
    res.status(403).json({ error: "No curriculum assigned" });
    return;
  }

  const [level] = await db
    .select()
    .from(levelsTable)
    .where(eq(levelsTable.id, lessonRow.levelId))
    .limit(1);

  if (!level || level.curriculumId !== ctx.curriculumId) {
    res.status(403).json({ error: "This lesson does not belong to your curriculum" });
    return;
  }

  // Check unlock state
  const [completedIds, currentLevel] = await Promise.all([
    getCompletedLessonIds(userId),
    ctx.currentLevelId
      ? db
          .select({ order: levelsTable.order })
          .from(levelsTable)
          .where(eq(levelsTable.id, ctx.currentLevelId))
          .limit(1)
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
  ]);

  const siblings = await db
    .select({ id: lessonsTable.id, order: lessonsTable.order })
    .from(lessonsTable)
    .where(
      and(
        eq(lessonsTable.levelId, lessonRow.levelId),
        publishedLessonFilter(),
      ),
    )
    .orderBy(asc(lessonsTable.order));

  const idx = siblings.findIndex((l) => l.id === lessonId);
  const prevLessonId = idx > 0 ? siblings[idx - 1].id : null;
  const currentLevelOrder = currentLevel?.order ?? null;

  const state = deriveLessonStateWithOrders(
    lessonRow,
    level.order,
    currentLevelOrder,
    completedIds,
    prevLessonId,
    null,
  );

  if (state === "LOCKED") {
    res.status(403).json({ error: "This lesson is locked" });
    return;
  }

  const [existing] = await db
    .select()
    .from(lessonProgressTable)
    .where(
      and(
        eq(lessonProgressTable.userId, userId),
        eq(lessonProgressTable.lessonId, lessonId),
      ),
    )
    .limit(1);

  if (existing) {
    // Preserve completed revisit history — don't overwrite completedAt/passed
    if (existing.status === "not_started" || existing.status === "completed" || existing.status === "passed" || existing.status === "failed") {
      await db
        .update(lessonProgressTable)
        .set({ status: "in_progress", startedAt: existing.startedAt ?? new Date() })
        .where(eq(lessonProgressTable.id, existing.id));
    }
    res.json({
      ...existing,
      status: "in_progress",
      startedAt: existing.startedAt ?? new Date(),
      nextLessonUnlocked: false,
    });
    return;
  }

  const [progress] = await db
    .insert(lessonProgressTable)
    .values({
      userId,
      lessonId,
      contentVersion: lessonRow.contentVersion,
      status: "in_progress",
      attempts: 0,
      passed: false,
      xpEarned: 0,
      startedAt: new Date(),
    })
    .returning();

  res.json({ ...progress, nextLessonUnlocked: false });
});

// ─── POST /lessons/:lessonId/blocks/:blockId/submit ───────────────────────────

const submitBlockSchema = z.object({
  clientSubmissionId: z.string().min(1),
  /** Which question on the block is being answered. Omitted means the first. */
  exerciseId: z.number().int().positive().optional(),
  selectedOptionId: z.string().optional(),
  responseText: z.string().optional(),
  mediaReference: z.string().optional(),
  /** A media_assets id from the upload handshake. Verified before it is stored. */
  mediaId: z.number().int().positive().optional(),
  recordingDurationSeconds: z.number().int().min(0).optional(),
  timeSpentSeconds: z.number().int().min(0).optional(),
});

router.post(
  "/lessons/:lessonId/blocks/:blockId/submit",
  requireAuth,
  async (req, res): Promise<void> => {
    const lessonId = parseInt(
      Array.isArray(req.params.lessonId) ? req.params.lessonId[0] : req.params.lessonId,
      10,
    );
    const blockId = parseInt(
      Array.isArray(req.params.blockId) ? req.params.blockId[0] : req.params.blockId,
      10,
    );
    const userId = req.session.userId!;

    if (isNaN(lessonId) || isNaN(blockId)) {
      res.status(400).json({ error: "Invalid lesson or block ID" });
      return;
    }

    const parsed = submitBlockSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parsed.error.errors.map((e) => ({ path: e.path.join("."), message: e.message })),
      });
      return;
    }

    const {
      clientSubmissionId,
      exerciseId: requestedExerciseId,
      selectedOptionId,
      responseText,
      mediaReference,
      mediaId,
      recordingDurationSeconds,
    } = parsed.data;

    // Idempotency check
    const [existingAttempt] = await db
      .select()
      .from(learningActivityAttemptsTable)
      .where(
        and(
          eq(learningActivityAttemptsTable.userId, userId),
          eq(learningActivityAttemptsTable.clientSubmissionId, clientSubmissionId),
        ),
      )
      .limit(1);

    if (existingAttempt) {
      res.json({
        attemptId: existingAttempt.id,
        blockId: existingAttempt.blockId,
        completed: true,
        correct: existingAttempt.isCorrect ?? null,
        score: existingAttempt.score ?? null,
        evaluationStatus: existingAttempt.evaluationStatus,
      });
      return;
    }

    // Validate lesson is published and accessible
    const [lessonRow] = await db
      .select()
      .from(lessonsTable)
      .where(and(eq(lessonsTable.id, lessonId), publishedLessonFilter()))
      .limit(1);

    if (!lessonRow) {
      res.status(404).json({ error: "Lesson not found" });
      return;
    }

    // Validate block belongs to lesson and is active
    const [block] = await db
      .select()
      .from(contentBlocksTable)
      .where(
        and(
          eq(contentBlocksTable.id, blockId),
          eq(contentBlocksTable.lessonId, lessonId),
          eq(contentBlocksTable.isActive, true),
        ),
      )
      .limit(1);

    if (!block) {
      res.status(404).json({ error: "Block not found in this lesson" });
      return;
    }

    // Enforce curriculum access
    const ctx = await getStudentCurriculumContext(userId);
    if (!ctx) {
      res.status(403).json({ error: "No curriculum assigned" });
      return;
    }

    const [level] = await db
      .select({ curriculumId: levelsTable.curriculumId })
      .from(levelsTable)
      .where(eq(levelsTable.id, lessonRow.levelId))
      .limit(1);

    if (!level || level.curriculumId !== ctx.curriculumId) {
      res.status(403).json({ error: "This lesson does not belong to your curriculum" });
      return;
    }

    // A recording is only accepted once the server has confirmed it exists in
    // the bucket and belongs to this student — see services/media.ts. Without
    // this check a student could attach anybody's audio to their own attempt.
    if (mediaId !== undefined) {
      try {
        await assertUsableRecording(mediaId, userId, "lesson_activity");
      } catch (err) {
        if (err instanceof MediaValidationError) {
          res.status(err.code === "NOT_FOUND" ? 404 : 400).json({
            error: err.message,
            code: err.code,
          });
          return;
        }
        throw err;
      }
    }

    // Find the exercise being answered. Scoping by block and lesson as well as
    // id is what stops an exercise from another lesson being submitted here.
    const [exercise] = await db
      .select()
      .from(exercisesTable)
      .where(
        and(
          eq(exercisesTable.contentBlockId, blockId),
          eq(exercisesTable.lessonId, lessonId),
          ...(requestedExerciseId ? [eq(exercisesTable.id, requestedExerciseId)] : []),
        ),
      )
      .orderBy(asc(exercisesTable.id))
      .limit(1);

    if (requestedExerciseId && !exercise) {
      res.status(404).json({ error: "Exercise not found on this block" });
      return;
    }

    let activityType = "passive";
    let isCorrect: boolean | null = null;
    let score: number | null = null;
    let evaluationStatus: "graded" | "pending" | "skipped" = "skipped";
    let explanation: string | null = null;
    let explanationAr: string | null = null;

    if (exercise) {
      activityType = exercise.exerciseType;

      if (exercise.exerciseType === "mcq") {
        if (!selectedOptionId) {
          res.status(400).json({ error: "selectedOptionId is required for MCQ" });
          return;
        }

        // Validate option belongs to this exercise
        const [option] = await db
          .select()
          .from(exerciseOptionsTable)
          .where(
            and(
              eq(exerciseOptionsTable.exerciseId, exercise.id),
              eq(exerciseOptionsTable.optionId, selectedOptionId),
            ),
          )
          .limit(1);

        if (!option) {
          res.status(400).json({ error: "Invalid option for this exercise" });
          return;
        }

        // Server-side grading — never trust client
        isCorrect = exercise.correctOptionId === selectedOptionId;
        score = isCorrect ? 100 : 0;
        evaluationStatus = "graded";
        explanation = exercise.explanation ?? null;
        explanationAr = exercise.explanationAr ?? null;
      } else if (
        exercise.exerciseType === "speaking" ||
        exercise.exerciseType === "pronunciation"
      ) {
        // Accept recorded metadata; score async
        evaluationStatus = "pending";
        isCorrect = null;
        score = null;
      } else {
        // open_ended, fill_blank, translation
        evaluationStatus = "pending";
        isCorrect = null;
        score = null;
      }
    }

    // Persist attempt
    const [attempt] = await db
      .insert(learningActivityAttemptsTable)
      .values({
        userId,
        lessonId,
        blockId,
        exerciseId: exercise?.id ?? null,
        contentVersion: lessonRow.contentVersion,
        activityType,
        clientSubmissionId,
        selectedOptionId: selectedOptionId ?? null,
        responseText: responseText ?? null,
        mediaReference: mediaReference ?? null,
        mediaAssetId: mediaId ?? null,
        recordingDurationSeconds: recordingDurationSeconds ?? null,
        isCorrect,
        score,
        evaluationStatus,
        metadata: null,
      })
      .returning();

    // Mark block progress complete
    await db
      .insert(lessonBlockProgressTable)
      .values({
        userId,
        lessonId,
        blockId,
        contentVersion: lessonRow.contentVersion,
        completedAt: new Date(),
      })
      .onConflictDoNothing();

    // An open-ended answer is graded here and now rather than in the background:
    // feedback is the entire point of the activity (spec section 4C), and a
    // student who has moved on will not come back for it. Failure is safe —
    // gradeLessonActivity returns null and the attempt stays pending, so the
    // lesson never stalls on the model being slow or absent.
    let verdict = null;
    // `responseText` OR a recording: a spoken open-ended answer is transcribed
    // inside gradeLessonActivity, so audio alone is enough to grade on.
    if (
      evaluationStatus === "pending" &&
      activityType === "open_ended" &&
      (responseText || mediaId !== undefined)
    ) {
      verdict = await gradeLessonActivity(attempt.id);
    }

    const responsePayload: Record<string, unknown> = {
      attemptId: attempt.id,
      blockId,
      completed: true,
      correct: verdict ? verdict.correct : isCorrect,
      score: verdict ? verdict.score : score,
      evaluationStatus: verdict ? "graded" : evaluationStatus,
    };

    if (verdict) {
      responsePayload.feedbackAr = verdict.feedback;
      responsePayload.feedback = verdict.feedbackEn;
      responsePayload.dimensions = verdict.dimensions;
    }

    // Only expose explanation after MCQ submission
    if (exercise?.exerciseType === "mcq") {
      responsePayload.explanation = explanation;
      responsePayload.explanationAr = explanationAr;
    }

    res.json(responsePayload);

    // A recording is assessed after the response is sent: it downloads audio
    // and waits on a speech recogniser, which is seconds of work. The student
    // moves on and the verdict appears in their progress when it lands.
    if (
      evaluationStatus === "pending" &&
      mediaId !== undefined &&
      activityType !== "open_ended"
    ) {
      jobs.enqueue("assess_speaking_activity", { activityAttemptId: attempt.id });
    }
  },
);

/**
 * The current verdict on one activity attempt.
 *
 * A spoken answer is assessed in the background, so the submit response can only
 * say "pending". This is how the student finds out what it came to without
 * reloading the lesson — the block polls it a few times after recording.
 */
router.get(
  "/lessons/:lessonId/attempts/:attemptId",
  requireAuth,
  async (req, res): Promise<void> => {
    const attemptId = parseInt(
      Array.isArray(req.params.attemptId) ? req.params.attemptId[0] : req.params.attemptId,
      10,
    );
    if (isNaN(attemptId)) {
      res.status(400).json({ error: "Invalid attempt ID" });
      return;
    }

    const [attempt] = await db
      .select()
      .from(learningActivityAttemptsTable)
      .where(
        and(
          eq(learningActivityAttemptsTable.id, attemptId),
          // Scoped to the caller: an attempt id must not be a way to read
          // another student's marks.
          eq(learningActivityAttemptsTable.userId, req.session.userId!),
        ),
      )
      .limit(1);

    if (!attempt) {
      res.status(404).json({ error: "Attempt not found" });
      return;
    }

    const metrics = (attempt.speechMetrics ?? null) as Record<string, unknown> | null;

    res.json({
      attemptId: attempt.id,
      blockId: attempt.blockId,
      evaluationStatus: attempt.evaluationStatus,
      correct: attempt.isCorrect,
      score: attempt.score,
      feedback: attempt.feedback,
      feedbackAr: attempt.feedbackAr,
      transcript: attempt.transcript,
      pronunciationScore: attempt.pronunciationScore,
      fluencyScore: attempt.fluencyScore,
      // The full word-by-word alignment is large and only useful to a teacher;
      // the student needs the headline numbers and what to practise.
      speechMetrics: metrics
        ? {
            speechRate: metrics.speechRate,
            pauseCount: metrics.pauseCount,
            meanLengthOfRun: metrics.meanLengthOfRun,
            fillersPer100Words: metrics.fillersPer100Words,
            problemWords: metrics.problemWords,
            fluencyUnavailable: metrics.fluencyUnavailable,
          }
        : null,
    });
  },
);

// ─── POST /lessons/:lessonId/complete ─────────────────────────────────────────

router.post("/lessons/:lessonId/complete", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.lessonId) ? req.params.lessonId[0] : req.params.lessonId;
  const lessonId = parseInt(raw, 10);
  const userId = req.session.userId!;

  if (isNaN(lessonId)) {
    res.status(400).json({ error: "Invalid lesson ID" });
    return;
  }

  const bodySchema = z.object({
    timeSpentSeconds: z.number().int().min(0).optional(),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { timeSpentSeconds } = parsed.data;

  const [lesson] = await db
    .select()
    .from(lessonsTable)
    .where(and(eq(lessonsTable.id, lessonId), publishedLessonFilter()))
    .limit(1);

  if (!lesson) {
    res.status(404).json({ error: "Lesson not found" });
    return;
  }

  // Enforce curriculum access
  const ctx = await getStudentCurriculumContext(userId);
  if (!ctx) {
    res.status(403).json({ error: "No curriculum assigned" });
    return;
  }

  const [level] = await db
    .select({ curriculumId: levelsTable.curriculumId })
    .from(levelsTable)
    .where(eq(levelsTable.id, lesson.levelId))
    .limit(1);

  if (!level || level.curriculumId !== ctx.curriculumId) {
    res.status(403).json({ error: "This lesson does not belong to your curriculum" });
    return;
  }

  // Check for missing required blocks
  const missingRequiredBlockIds = await getMissingRequiredBlockIds(
    userId,
    lessonId,
    lesson.contentVersion,
  );

  if (missingRequiredBlockIds.length > 0) {
    res.status(422).json({
      error: "Required blocks not completed",
      missingRequiredBlockIds,
    });
    return;
  }

  // Derive score server-side — ignore any client-submitted score
  const score = await deriveLessonScore(userId, lessonId, lesson.contentVersion);
  const passed = score >= lesson.passingScore;
  const xpEarned = passed ? lesson.xpReward : Math.floor(lesson.xpReward * 0.25);

  const [existing] = await db
    .select()
    .from(lessonProgressTable)
    .where(
      and(
        eq(lessonProgressTable.userId, userId),
        eq(lessonProgressTable.lessonId, lessonId),
      ),
    )
    .limit(1);

  let progress;

  if (existing) {
    const newBest =
      existing.bestScore === null ? score : Math.max(existing.bestScore, score);
    const wasAlreadyPassed = existing.passed;

    [progress] = await db
      .update(lessonProgressTable)
      .set({
        status: passed ? "passed" : "completed",
        lastScore: score,
        bestScore: newBest,
        attempts: existing.attempts + 1,
        passed: wasAlreadyPassed || passed,
        // Award XP only once
        xpEarned: wasAlreadyPassed ? existing.xpEarned : passed ? xpEarned : existing.xpEarned,
        // Preserve original completedAt on revisits if already completed
        completedAt: existing.completedAt ?? new Date(),
        timeSpentSeconds: existing.timeSpentSeconds + (timeSpentSeconds ?? 0),
      })
      .where(eq(lessonProgressTable.id, existing.id))
      .returning();

    if (passed && !wasAlreadyPassed) {
      await db
        .update(studentProfilesTable)
        .set({ totalXp: sql`total_xp + ${xpEarned}` })
        .where(eq(studentProfilesTable.userId, userId));
    }
  } else {
    [progress] = await db
      .insert(lessonProgressTable)
      .values({
        userId,
        lessonId,
        contentVersion: lesson.contentVersion,
        status: passed ? "passed" : "completed",
        lastScore: score,
        bestScore: score,
        attempts: 1,
        passed,
        xpEarned,
        timeSpentSeconds: timeSpentSeconds ?? 0,
        startedAt: new Date(),
        completedAt: new Date(),
      })
      .returning();

    if (passed) {
      await db
        .update(studentProfilesTable)
        .set({ totalXp: sql`total_xp + ${xpEarned}` })
        .where(eq(studentProfilesTable.userId, userId));
    }
  }

  // Maybe advance to next level
  const { advanced, newLevelId } = await maybeAdvanceLevel(userId, lessonId);

  // Find next lesson
  const nextLessonRow = await findNextLesson(lessonId);

  res.json({
    ...progress,
    score,
    nextLessonId: nextLessonRow?.id ?? null,
    nextLessonUnlocked: passed && !!nextLessonRow,
    levelAdvanced: advanced,
    newLevelId,
  });
});

// ─── GET /lessons/:lessonId/progress ─────────────────────────────────────────

router.get("/lessons/:lessonId/progress", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.lessonId) ? req.params.lessonId[0] : req.params.lessonId;
  const lessonId = parseInt(raw, 10);
  const userId = req.session.userId!;

  if (isNaN(lessonId)) {
    res.status(400).json({ error: "Invalid lesson ID" });
    return;
  }

  const [progress] = await db
    .select()
    .from(lessonProgressTable)
    .where(
      and(
        eq(lessonProgressTable.userId, userId),
        eq(lessonProgressTable.lessonId, lessonId),
      ),
    )
    .limit(1);

  if (!progress) {
    res.status(404).json({ error: "No progress found" });
    return;
  }

  res.json({ ...progress, nextLessonUnlocked: false });
});

export default router;
