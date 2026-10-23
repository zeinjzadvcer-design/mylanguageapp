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
import { requireContentManager, requireCMSAccess } from "../../middlewares/auth";
import { audit } from "../../services/cms-audit";
import { invalidate, CK } from "../../services/cache";

const router: IRouter = Router();

// ─── Content block CRUD ────────────────────────────────────────────────────

/** List blocks for a lesson (admin/content view — includes inactive) */
router.get("/cms/lessons/:lessonId/blocks", requireCMSAccess, async (req, res): Promise<void> => {
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
router.post("/cms/lessons/:lessonId/blocks", requireContentManager, async (req, res): Promise<void> => {
  const lessonId = parseInt(req.params.lessonId as string, 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson ID" }); return; }

  const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
  if (!lesson || lesson.softDeletedAt) { res.status(404).json({ error: "Lesson not found" }); return; }
  // content_manager cannot mutate published/archived lessons; only admins can do so after unpublishing
  if (req.session.role !== "admin" && ["published", "archived"].includes(lesson.status)) {
    res.status(403).json({ error: `Cannot edit a ${lesson.status} lesson. Unpublish it first or contact an admin.` }); return;
  }

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
router.patch("/cms/lessons/:lessonId/blocks/:blockId", requireContentManager, async (req, res): Promise<void> => {
  const lessonId = parseInt(req.params.lessonId as string, 10);
  const blockId = parseInt(req.params.blockId as string, 10);
  if (isNaN(lessonId) || isNaN(blockId)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const [parentLesson] = await db.select({ status: lessonsTable.status }).from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
  if (!parentLesson) { res.status(404).json({ error: "Lesson not found" }); return; }
  if (req.session.role !== "admin" && ["published", "archived"].includes(parentLesson.status)) {
    res.status(403).json({ error: `Cannot edit blocks of a ${parentLesson.status} lesson.` }); return;
  }

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
router.delete("/cms/lessons/:lessonId/blocks/:blockId", requireContentManager, async (req, res): Promise<void> => {
  const lessonId = parseInt(req.params.lessonId as string, 10);
  const blockId = parseInt(req.params.blockId as string, 10);
  if (isNaN(lessonId) || isNaN(blockId)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const [pLesson] = await db.select({ status: lessonsTable.status }).from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
  if (pLesson && req.session.role !== "admin" && ["published", "archived"].includes(pLesson.status)) {
    res.status(403).json({ error: `Cannot delete blocks from a ${pLesson.status} lesson.` }); return;
  }

  await db.delete(contentBlocksTable)
    .where(and(eq(contentBlocksTable.id, blockId), eq(contentBlocksTable.lessonId, lessonId)));
  await audit(req.session.userId!, "delete", "content_block", blockId, null, null, { lessonId });
  await invalidate(CK.lessonContent(lessonId));
  res.json({ deleted: true });
});

/** Reorder blocks: body = { blockIds: number[] } — ordered array of block IDs */
router.post("/cms/lessons/:lessonId/blocks/reorder", requireContentManager, async (req, res): Promise<void> => {
  const lessonId = parseInt(req.params.lessonId as string, 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson ID" }); return; }

  const [rLesson] = await db.select({ status: lessonsTable.status }).from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
  if (rLesson && req.session.role !== "admin" && ["published", "archived"].includes(rLesson.status)) {
    res.status(403).json({ error: `Cannot reorder blocks of a ${rLesson.status} lesson.` }); return;
  }

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
router.post("/cms/lessons/:lessonId/blocks/:blockId/exercise", requireContentManager, async (req, res): Promise<void> => {
  const lessonId = parseInt(req.params.lessonId as string, 10);
  const blockId = parseInt(req.params.blockId as string, 10);
  if (isNaN(lessonId) || isNaN(blockId)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const [exLesson] = await db.select({ status: lessonsTable.status }).from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
  if (exLesson && req.session.role !== "admin" && ["published", "archived"].includes(exLesson.status)) {
    res.status(403).json({ error: `Cannot add exercises to a ${exLesson.status} lesson.` }); return;
  }

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
    for (const opt of options) {
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
router.patch("/cms/lessons/:lessonId/exercises/:exerciseId", requireContentManager, async (req, res): Promise<void> => {
  const lessonId = parseInt(req.params.lessonId as string, 10);
  const exerciseId = parseInt(req.params.exerciseId as string, 10);
  if (isNaN(lessonId) || isNaN(exerciseId)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const [upLesson] = await db.select({ status: lessonsTable.status }).from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
  if (upLesson && req.session.role !== "admin" && ["published", "archived"].includes(upLesson.status)) {
    res.status(403).json({ error: `Cannot update exercises of a ${upLesson.status} lesson.` }); return;
  }

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
    for (const opt of req.body.options) {
      await db.insert(exerciseOptionsTable).values({
        exerciseId, optionId: opt.optionId, text: opt.text, textAr: opt.textAr ?? null,
      });
    }
  }

  await invalidate(CK.lessonContent(lessonId));
  res.json(exercise);
});

/** Delete exercise */
router.delete("/cms/lessons/:lessonId/exercises/:exerciseId", requireContentManager, async (req, res): Promise<void> => {
  const lessonId = parseInt(req.params.lessonId as string, 10);
  const exerciseId = parseInt(req.params.exerciseId as string, 10);
  if (isNaN(lessonId) || isNaN(exerciseId)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const [delLesson] = await db.select({ status: lessonsTable.status }).from(lessonsTable).where(eq(lessonsTable.id, lessonId)).limit(1);
  if (delLesson && req.session.role !== "admin" && ["published", "archived"].includes(delLesson.status)) {
    res.status(403).json({ error: `Cannot delete exercises from a ${delLesson.status} lesson.` }); return;
  }

  await db.delete(exercisesTable).where(and(eq(exercisesTable.id, exerciseId), eq(exercisesTable.lessonId, lessonId)));
  await invalidate(CK.lessonContent(lessonId));
  res.json({ deleted: true });
});

export default router;
