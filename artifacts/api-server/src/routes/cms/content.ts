/**
 * CMS Content Blocks + Exercises
 *
 * Content blocks are the composable building blocks within a lesson.
 * Each block may optionally have one linked exercise.
 */

import { Router, type IRouter } from "express";
import { eq, and, asc, inArray } from "drizzle-orm";
import {
  db, lessonsTable, contentBlocksTable, exercisesTable, exerciseOptionsTable,
} from "@workspace/db";
import { requirePermission } from "../../middlewares/auth";
import { refuseLessonChange, refuseLoadedLessonChange } from "./lesson-guard";
import { audit } from "../../services/cms-audit";
import { isFilledOption, openEndedSettings } from "../../services/lesson-content";
import { invalidate, CK } from "../../services/cache";

const router: IRouter = Router();

// ─── Content block CRUD ────────────────────────────────────────────────────

/** List blocks for a lesson (admin/content view — includes inactive) */
router.get("/cms/lessons/:lessonId/blocks", requirePermission("content.view"), async (req, res): Promise<void> => {
  const lessonId = parseInt(req.params.lessonId as string, 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson ID" }); return; }

  const blocks = await db.select().from(contentBlocksTable)
    .where(eq(contentBlocksTable.lessonId, lessonId))
    .orderBy(asc(contentBlocksTable.order));

  // Ordered explicitly: without it Postgres returns rows in physical order, so
  // an UPDATE relocates the row and the question changes position on save.
  const exercisesForLesson = await db.select().from(exercisesTable)
    .where(eq(exercisesTable.lessonId, lessonId))
    .orderBy(asc(exercisesTable.ordering), asc(exercisesTable.id));

  const exerciseIds = exercisesForLesson.map(e => e.id);
  const allOptions = exerciseIds.length > 0
    ? await db.select().from(exerciseOptionsTable).where(inArray(exerciseOptionsTable.exerciseId, exerciseIds))
    : [];

  res.json(blocks.map(block => {
    // A block may hold several questions. `exercise`/`options` describe the
    // first, so callers written before that keep working.
    const blockExercises = exercisesForLesson.filter(e => e.contentBlockId === block.id);
    const first = blockExercises[0];
    return {
      ...block,
      // How students answer it and whether AI marks it, as the server applies
      // them: the editor shows these rather than guessing the defaults.
      openEnded: block.type === "open_ended" ? openEndedSettings(block.config) : null,
      exercise: first ?? null,
      options: first ? allOptions.filter(o => o.exerciseId === first.id) : [],
      exercises: blockExercises.map(e => ({
        ...e,
        options: allOptions.filter(o => o.exerciseId === e.id),
      })),
    };
  }));
});

/** Create a new content block */
router.post("/cms/lessons/:lessonId/blocks", requirePermission("content.edit"), async (req, res): Promise<void> => {
  const lessonId = parseInt(req.params.lessonId as string, 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson ID" }); return; }

  const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
  if (!lesson || lesson.softDeletedAt) { res.status(404).json({ error: "Lesson not found" }); return; }
  if (refuseLoadedLessonChange(req, res, lesson)) return;

  const {
    type, order, title, titleAr, instructions, instructionsAr,
    content, contentAr, audioNote, prompt, promptAr, exampleAudio,
    isRequired, estimatedMinutes, isActive, config,
    expectsReferenceReading, referenceMediaId,
    imageMediaId, audioMediaId, imageMediaKey, audioMediaKey,
  } = req.body;

  if (!type || order === undefined) {
    res.status(400).json({ error: "type and order are required" });
    return;
  }

  const [block] = await db.insert(contentBlocksTable).values({
    lessonId, type, order,
    title: title ?? null, titleAr: titleAr ?? null,
    instructions: instructions ?? null, instructionsAr: instructionsAr ?? null,
    content: content ?? null, contentAr: contentAr ?? null,
    audioNote: audioNote ?? null, prompt: prompt ?? null, promptAr: promptAr ?? null,
    exampleAudio: exampleAudio ?? null,
    isRequired: isRequired !== undefined ? isRequired : true,
    estimatedMinutes: estimatedMinutes ?? null,
    isActive: isActive !== undefined ? isActive : true,
    config: config ?? null,
    expectsReferenceReading: expectsReferenceReading ?? false,
    referenceMediaId: referenceMediaId ?? null,
    imageMediaId: imageMediaId ?? null,
    audioMediaId: audioMediaId ?? null,
    imageMediaKey: imageMediaKey ?? null,
    audioMediaKey: audioMediaKey ?? null,
  }).returning();

  await audit(req.session.userId!, "create", "content_block", block.id, null, null, { lessonId, type });
  await invalidate(CK.lessonContent(lessonId));
  res.status(201).json(block);
});

/** Update a content block */
router.patch("/cms/lessons/:lessonId/blocks/:blockId", requirePermission("content.edit"), async (req, res): Promise<void> => {
  const lessonId = parseInt(req.params.lessonId as string, 10);
  const blockId = parseInt(req.params.blockId as string, 10);
  if (isNaN(lessonId) || isNaN(blockId)) { res.status(400).json({ error: "Invalid ID" }); return; }

  if (await refuseLessonChange(req, res, lessonId)) return;

  const allowed = ["type", "order", "title", "titleAr", "instructions", "instructionsAr",
    "content", "contentAr", "audioNote", "prompt", "promptAr", "exampleAudio",
    "isRequired", "estimatedMinutes", "isActive", "config",
    // Decides whether a spoken answer can be scored for pronunciation: without
    // a set passage there is nothing to align a transcript against.
    "expectsReferenceReading", "referenceMediaId",
    // Optional illustration media, allowed on every block type.
    "imageMediaId", "audioMediaId", "imageMediaKey", "audioMediaKey"];
  const update: Record<string, unknown> = { updatedAt: new Date() };
  for (const f of allowed) {
    if (req.body[f] !== undefined) update[f] = req.body[f];
  }

  const [block] = await db.update(contentBlocksTable).set(update)
    .where(and(eq(contentBlocksTable.id, blockId), eq(contentBlocksTable.lessonId, lessonId)))
    .returning();
  if (!block) { res.status(404).json({ error: "Block not found" }); return; }

  await audit(req.session.userId!, "update", "content_block", blockId, null, null, { lessonId });
  await invalidate(CK.lessonContent(lessonId));
  res.json(block);
});

/** Delete a content block (and its exercise + options via CASCADE) */
router.delete("/cms/lessons/:lessonId/blocks/:blockId", requirePermission("content.edit"), async (req, res): Promise<void> => {
  const lessonId = parseInt(req.params.lessonId as string, 10);
  const blockId = parseInt(req.params.blockId as string, 10);
  if (isNaN(lessonId) || isNaN(blockId)) { res.status(400).json({ error: "Invalid ID" }); return; }

  if (await refuseLessonChange(req, res, lessonId)) return;

  await db.delete(contentBlocksTable)
    .where(and(eq(contentBlocksTable.id, blockId), eq(contentBlocksTable.lessonId, lessonId)));
  await audit(req.session.userId!, "delete", "content_block", blockId, null, null, { lessonId });
  await invalidate(CK.lessonContent(lessonId));
  res.json({ deleted: true });
});

/** Reorder blocks: body = { blockIds: number[] } — ordered array of block IDs */
router.post("/cms/lessons/:lessonId/blocks/reorder", requirePermission("content.edit"), async (req, res): Promise<void> => {
  const lessonId = parseInt(req.params.lessonId as string, 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson ID" }); return; }

  if (await refuseLessonChange(req, res, lessonId)) return;

  const { blockIds } = req.body;
  if (!Array.isArray(blockIds) || blockIds.some(id => typeof id !== "number")) {
    res.status(400).json({ error: "blockIds must be an array of numbers" });
    return;
  }

  for (let i = 0; i < blockIds.length; i++) {
    await db.update(contentBlocksTable)
      .set({ order: i + 1 })
      .where(and(eq(contentBlocksTable.id, blockIds[i]), eq(contentBlocksTable.lessonId, lessonId)));
  }
  await invalidate(CK.lessonContent(lessonId));
  res.json({ reordered: true });
});

// ─── Exercise CRUD ─────────────────────────────────────────────────────────

/** Create exercise for a block */
router.post("/cms/lessons/:lessonId/blocks/:blockId/exercise", requirePermission("content.edit"), async (req, res): Promise<void> => {
  const lessonId = parseInt(req.params.lessonId as string, 10);
  const blockId = parseInt(req.params.blockId as string, 10);
  if (isNaN(lessonId) || isNaN(blockId)) { res.status(400).json({ error: "Invalid ID" }); return; }

  if (await refuseLessonChange(req, res, lessonId)) return;

  const {
    exerciseType, question, questionAr, correctOptionId,
    explanation, explanationAr, prompt, promptAr,
    instructionsText, instructionsAr, modelAnswer, modelAnswerAr,
    expectedConcepts, difficulty, points, ordering, audioUrl,
    options,
  } = req.body;

  if (!question) { res.status(400).json({ error: "question is required" }); return; }

  // Append after the questions already on this block, so a block holding
  // several questions keeps a stable, author-visible order.
  const siblings = await db
    .select({ ordering: exercisesTable.ordering })
    .from(exercisesTable)
    .where(and(eq(exercisesTable.lessonId, lessonId), eq(exercisesTable.contentBlockId, blockId)));
  const nextOrdering = siblings.reduce((max, s) => Math.max(max, s.ordering ?? 0), 0) + 1;

  const [exercise] = await db.insert(exercisesTable).values({
    lessonId, contentBlockId: blockId,
    exerciseType: exerciseType ?? "mcq",
    question, questionAr: questionAr ?? null,
    correctOptionId: correctOptionId ?? "",
    explanation: explanation ?? null, explanationAr: explanationAr ?? null,
    prompt: prompt ?? null, promptAr: promptAr ?? null,
    instructionsText: instructionsText ?? null, instructionsAr: instructionsAr ?? null,
    modelAnswer: modelAnswer ?? null, modelAnswerAr: modelAnswerAr ?? null,
    expectedConcepts: expectedConcepts ?? null,
    difficulty: difficulty ?? null, points: points ?? 10,
    ordering: ordering ?? nextOrdering, audioUrl: audioUrl ?? null,
  }).returning();

  // Create options if provided
  const createdOptions = [];
  if (Array.isArray(options)) {
    // Blank rows from the four-option form are not options, and students saw
    // them as empty answers to choose from.
    for (const opt of options.filter(isFilledOption)) {
      const [o] = await db.insert(exerciseOptionsTable).values({
        exerciseId: exercise.id, optionId: opt.optionId, text: opt.text, textAr: opt.textAr ?? null,
      }).returning();
      createdOptions.push(o);
    }
  }

  await audit(req.session.userId!, "create", "exercise", exercise.id, null, null, { lessonId, blockId });
  await invalidate(CK.lessonContent(lessonId));
  res.status(201).json({ ...exercise, options: createdOptions });
});

/** Update exercise */
router.patch("/cms/lessons/:lessonId/exercises/:exerciseId", requirePermission("content.edit"), async (req, res): Promise<void> => {
  const lessonId = parseInt(req.params.lessonId as string, 10);
  const exerciseId = parseInt(req.params.exerciseId as string, 10);
  if (isNaN(lessonId) || isNaN(exerciseId)) { res.status(400).json({ error: "Invalid ID" }); return; }

  if (await refuseLessonChange(req, res, lessonId)) return;

  const allowed = ["exerciseType", "question", "questionAr", "correctOptionId",
    "explanation", "explanationAr", "prompt", "promptAr",
    "instructionsText", "instructionsAr", "modelAnswer", "modelAnswerAr",
    "expectedConcepts", "difficulty", "points", "ordering", "audioUrl"];
  const update: Record<string, unknown> = { updatedAt: new Date() };
  for (const f of allowed) {
    if (req.body[f] !== undefined) update[f] = req.body[f];
  }

  const [exercise] = await db.update(exercisesTable).set(update)
    .where(and(eq(exercisesTable.id, exerciseId), eq(exercisesTable.lessonId, lessonId)))
    .returning();
  if (!exercise) { res.status(404).json({ error: "Exercise not found" }); return; }

  // Replace options if provided
  if (Array.isArray(req.body.options)) {
    await db.delete(exerciseOptionsTable).where(eq(exerciseOptionsTable.exerciseId, exerciseId));
    for (const opt of req.body.options.filter(isFilledOption)) {
      await db.insert(exerciseOptionsTable).values({
        exerciseId, optionId: opt.optionId, text: opt.text, textAr: opt.textAr ?? null,
      });
    }
  }

  await invalidate(CK.lessonContent(lessonId));
  res.json(exercise);
});

/** Delete exercise */
router.delete("/cms/lessons/:lessonId/exercises/:exerciseId", requirePermission("content.edit"), async (req, res): Promise<void> => {
  const lessonId = parseInt(req.params.lessonId as string, 10);
  const exerciseId = parseInt(req.params.exerciseId as string, 10);
  if (isNaN(lessonId) || isNaN(exerciseId)) { res.status(400).json({ error: "Invalid ID" }); return; }

  if (await refuseLessonChange(req, res, lessonId)) return;

  await db.delete(exercisesTable).where(and(eq(exercisesTable.id, exerciseId), eq(exercisesTable.lessonId, lessonId)));
  await invalidate(CK.lessonContent(lessonId));
  res.json({ deleted: true });
});

export default router;
