/**
 * CMS Lesson Management
 *
 * Status transitions enforced server-side:
 *   draft      → in_review  (content_manager + admin: submit for review)
 *   in_review  → approved   (reviewer + admin: approve)
 *   in_review  → draft      (reviewer + admin: reject → back to draft)
 *   approved   → published  (admin only)
 *   published  → draft      (admin only: unpublish)
 *   any        → archived   (admin only)
 *   archived   → draft      (admin only: restore)
 *
 * Admin can also bypass the review step and publish directly from draft/approved.
 */

import { Router, type IRouter } from "express";
import { eq, and, isNull, desc, ilike, inArray, asc, sql } from "drizzle-orm";
import {
  db, pool,
  lessonsTable, levelsTable, curriculaTable,
  contentBlocksTable, exercisesTable, exerciseOptionsTable, vocabularyTable,
} from "@workspace/db";
import { requireAdmin, requireContentManager, requireCMSAccess, requireReviewer } from "../../middlewares/auth";
import { audit } from "../../services/cms-audit";
import { invalidate, invalidatePrefix, CK } from "../../services/cache";
import { toStudentContentBlocks } from "../../services/lesson-content";

const router: IRouter = Router();

// ─── List / search ─────────────────────────────────────────────────────────

router.get("/cms/lessons", requireCMSAccess, async (req, res): Promise<void> => {
  const page = Math.max(1, parseInt((req.query.page as string) ?? "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) ?? "20", 10)));
  const offset = (page - 1) * limit;

  const status = req.query.status as string | undefined;
  const levelId = req.query.levelId ? parseInt(req.query.levelId as string, 10) : undefined;
  const curriculumId = req.query.curriculumId ? parseInt(req.query.curriculumId as string, 10) : undefined;
  const search = (req.query.search as string | undefined)?.trim();

  // Build WHERE clauses
  const conditions: string[] = [`l.soft_deleted_at IS NULL`];
  const params: unknown[] = [];

  if (status) { params.push(status); conditions.push(`l.status = $${params.length}`); }
  if (levelId && !isNaN(levelId)) { params.push(levelId); conditions.push(`l.level_id = $${params.length}`); }
  if (search) { params.push(`%${search}%`); conditions.push(`(l.title ILIKE $${params.length} OR l.title_ar ILIKE $${params.length})`); }

  // Join curricula filter
  let joinClause = `JOIN levels lv ON lv.id = l.level_id`;
  if (curriculumId && !isNaN(curriculumId)) {
    params.push(curriculumId);
    conditions.push(`lv.curriculum_id = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const [countResult, rows] = await Promise.all([
    pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM lessons l ${joinClause} ${where}`,
      params
    ),
    pool.query<{
      id: number; level_id: number; title: string; title_ar: string;
      status: string; lesson_type: string; estimated_minutes: number;
      order: number; xp_reward: number; passing_score: number;
      is_published: boolean; difficulty: string | null; tags: string[] | null;
      created_at: Date; updated_at: Date; level_code: string; curriculum_id: number;
    }>(
      `SELECT l.id, l.level_id, l.title, l.title_ar, l.status, l.lesson_type,
              l.estimated_minutes, l.order, l.xp_reward, l.passing_score,
              l.is_published, l.difficulty, l.tags, l.created_at, l.updated_at,
              lv.code AS level_code, lv.curriculum_id
       FROM lessons l ${joinClause}
       ${where}
       ORDER BY lv.curriculum_id, lv.order, l.order
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
  ]);

  res.json({
    lessons: rows.rows.map(l => ({
      id: l.id, levelId: l.level_id, levelCode: l.level_code,
      curriculumId: l.curriculum_id,
      title: l.title, titleAr: l.title_ar,
      status: l.status, lessonType: l.lesson_type,
      estimatedMinutes: l.estimated_minutes, order: l.order,
      xpReward: l.xp_reward, passingScore: l.passing_score,
      difficulty: l.difficulty, tags: l.tags,
      createdAt: l.created_at, updatedAt: l.updated_at,
    })),
    total: parseInt(countResult.rows[0].count, 10),
    page, limit,
  });
});

// ─── Get single lesson (full metadata, no content blocks) ─────────────────

router.get("/cms/lessons/:id", requireCMSAccess, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid lesson ID" }); return; }

  const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, id)).limit(1);
  if (!lesson || lesson.softDeletedAt) { res.status(404).json({ error: "Lesson not found" }); return; }

  const [level] = await db.select().from(levelsTable).where(eq(levelsTable.id, lesson.levelId)).limit(1);

  res.json({
    id: lesson.id, levelId: lesson.levelId, levelCode: level?.code,
    curriculumId: level?.curriculumId,
    title: lesson.title, titleAr: lesson.titleAr,
    subtitle: lesson.subtitle, subtitleAr: lesson.subtitleAr,
    description: lesson.description, descriptionAr: lesson.descriptionAr,
    order: lesson.order, lessonType: lesson.lessonType,
    estimatedMinutes: lesson.estimatedMinutes,
    status: lesson.status, isPublished: lesson.isPublished,
    contentVersion: lesson.contentVersion,
    xpReward: lesson.xpReward, passingScore: lesson.passingScore,
    difficulty: lesson.difficulty, tags: lesson.tags,
    objectives: lesson.objectives, objectivesAr: lesson.objectivesAr,
    teacherNotes: lesson.teacherNotes,
    createdAt: lesson.createdAt, updatedAt: lesson.updatedAt,
  });
});

// ─── Preview (full content, any status) ──────────────────────────────────

router.get("/cms/lessons/:id/preview", requireCMSAccess, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid lesson ID" }); return; }

  const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, id)).limit(1);
  if (!lesson || lesson.softDeletedAt) { res.status(404).json({ error: "Lesson not found" }); return; }

  const [level, blocks, exercises, vocab] = await Promise.all([
    db.select().from(levelsTable).where(eq(levelsTable.id, lesson.levelId)).limit(1).then(r => r[0]),
    db.select().from(contentBlocksTable).where(eq(contentBlocksTable.lessonId, id)).orderBy(asc(contentBlocksTable.order)),
    // Ordered explicitly: without it Postgres returns rows in physical order,
    // so an UPDATE rewrites the row and the question jumps position on save.
    db.select().from(exercisesTable).where(eq(exercisesTable.lessonId, id))
      .orderBy(asc(exercisesTable.ordering), asc(exercisesTable.id)),
    db.select().from(vocabularyTable).where(eq(vocabularyTable.lessonId, id)),
  ]);

  const exerciseIds = exercises.map(e => e.id);
  const allOptions = exerciseIds.length > 0
    ? await db.select().from(exerciseOptionsTable).where(inArray(exerciseOptionsTable.exerciseId, exerciseIds))
    : [];

  res.json({
    isPreview: true,
    lesson: { ...lesson, levelCode: level?.code },
    contentBlocks: blocks.map(block => {
      // A block may hold several questions. `exercise`/`options` still describe
      // the first so existing single-question callers keep working.
      // Already ordered by the query; filter preserves that order.
      const blockExercises = exercises.filter(e => e.contentBlockId === block.id);
      const first = blockExercises[0];
      return {
        ...block,
        exercise: first ?? null,
        options: first ? allOptions.filter(o => o.exerciseId === first.id) : null,
        exercises: blockExercises.map(e => ({
          ...e,
          options: allOptions.filter(o => o.exerciseId === e.id),
        })),
      };
    }),
    vocabulary: vocab,
    /**
     * The blocks exactly as the student lesson route shapes them, so the
     * preview can run the real player instead of an approximation of it.
     * Inactive blocks are left out because a student never sees them.
     */
    studentBlocks: toStudentContentBlocks(
      blocks.filter(b => b.isActive),
      exercises,
      allOptions,
      vocab,
    ),
    /**
     * Answer keys, which the student route withholds. The preview grades MCQ
     * answers locally with these, so an author can check the marked answer
     * without anything being recorded.
     */
    answerKeys: Object.fromEntries(exercises.map(e => [e.id, {
      correctOptionId: e.correctOptionId || null,
      explanation: e.explanation ?? null,
      explanationAr: e.explanationAr ?? null,
    }])),
  });
});

// ─── Create ───────────────────────────────────────────────────────────────

router.post("/cms/lessons", requireContentManager, async (req, res): Promise<void> => {
  const { levelId, title, titleAr, lessonType, estimatedMinutes, order,
    description, descriptionAr, subtitle, subtitleAr,
    objectives, objectivesAr, difficulty, tags, teacherNotes,
    xpReward, passingScore } = req.body;

  if (!levelId || !title || !titleAr || !order) {
    res.status(400).json({ error: "levelId, title, titleAr, and order are required" });
    return;
  }
  const [level] = await db.select().from(levelsTable).where(eq(levelsTable.id, levelId)).limit(1);
  if (!level) { res.status(400).json({ error: "Level not found" }); return; }

  const [lesson] = await db.insert(lessonsTable).values({
    levelId, title, titleAr,
    subtitle: subtitle ?? null, subtitleAr: subtitleAr ?? null,
    description: description ?? null, descriptionAr: descriptionAr ?? null,
    order, lessonType: lessonType ?? "general",
    estimatedMinutes: estimatedMinutes ?? 35,
    isPublished: false, status: "draft",
    xpReward: xpReward ?? 50, passingScore: passingScore ?? 75,
    difficulty: difficulty ?? "intermediate",
    tags: tags ?? null, objectives: objectives ?? null, objectivesAr: objectivesAr ?? null,
    teacherNotes: teacherNotes ?? null,
    createdBy: req.session.userId,
  }).returning();

  await audit(req.session.userId!, "create", "lesson", lesson.id, null, "draft", { title });
  await invalidatePrefix("v1:levels:c:");

  res.status(201).json({ id: lesson.id, status: lesson.status, title: lesson.title });
});

// ─── Update metadata ───────────────────────────────────────────────────────

router.patch("/cms/lessons/:id", requireContentManager, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid lesson ID" }); return; }

  const [existing] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, id)).limit(1);
  if (!existing || existing.softDeletedAt) { res.status(404).json({ error: "Lesson not found" }); return; }

  // content_manager cannot edit published/archived lessons — they must be unpublished by admin first
  if (req.session.role !== "admin" && ["published", "archived"].includes(existing.status)) {
    res.status(403).json({
      error: `Cannot edit a ${existing.status} lesson. Ask an admin to unpublish it first.`,
    }); return;
  }

  // Published lessons get a content version bump (admin bypass)
  const bumpVersion = existing.status === "published";

  const allowed = ["levelId", "title", "titleAr", "subtitle", "subtitleAr",
    "description", "descriptionAr", "order", "lessonType", "estimatedMinutes",
    "xpReward", "passingScore", "difficulty", "tags",
    "objectives", "objectivesAr", "teacherNotes"];
  const update: Record<string, unknown> = {};
  for (const f of allowed) {
    if (req.body[f] !== undefined) update[f] = req.body[f];
  }
  if (bumpVersion) update.contentVersion = existing.contentVersion + 1;

  const [lesson] = await db.update(lessonsTable).set(update).where(eq(lessonsTable.id, id)).returning();
  await audit(req.session.userId!, "update", "lesson", id, existing.status, existing.status, { title: lesson.title });
  await Promise.all([invalidate(CK.lessonContent(id)), invalidatePrefix("v1:levels:c:")]);

  res.json({ id: lesson.id, status: lesson.status, contentVersion: lesson.contentVersion });
});

// ─── Status transitions ────────────────────────────────────────────────────

async function transitionLesson(
  req: any, res: any,
  allowedFrom: string[],
  newStatus: string,
  syncIsPublished?: boolean,
): Promise<void> {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid lesson ID" }); return; }

  const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, id)).limit(1);
  if (!lesson || lesson.softDeletedAt) { res.status(404).json({ error: "Lesson not found" }); return; }

  if (!allowedFrom.includes(lesson.status)) {
    res.status(422).json({
      error: `Cannot transition from '${lesson.status}' to '${newStatus}'`,
      currentStatus: lesson.status,
    });
    return;
  }

  const update: Record<string, unknown> = { status: newStatus };
  if (syncIsPublished !== undefined) update.isPublished = syncIsPublished;

  await db.update(lessonsTable).set(update).where(eq(lessonsTable.id, id));
  await audit(req.session.userId!, newStatus === "published" ? "publish" : newStatus === "archived" ? "archive" : newStatus === "draft" && lesson.status === "published" ? "unpublish" : newStatus, "lesson", id, lesson.status, newStatus, { title: lesson.title });
  await Promise.all([invalidate(CK.lessonContent(id)), invalidatePrefix("v1:levels:c:")]);

  res.json({ id, status: newStatus });
}

/** Content manager submits lesson for review */
router.post("/cms/lessons/:id/submit", requireContentManager, (req, res) =>
  transitionLesson(req, res, ["draft"], "in_review"));

/** Reviewer or admin approves — inserts a lesson_reviews record so the history is complete */
router.post("/cms/lessons/:id/approve", requireReviewer, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid lesson ID" }); return; }

  const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, id)).limit(1);
  if (!lesson || lesson.softDeletedAt) { res.status(404).json({ error: "Lesson not found" }); return; }
  if (lesson.status !== "in_review") {
    res.status(422).json({ error: "Only in_review lessons can be approved" }); return;
  }

  // approve is called with no body, and req.body is undefined for a bodyless POST.
  const { notes } = req.body ?? {};
  await db.update(lessonsTable).set({ status: "approved" }).where(eq(lessonsTable.id, id));
  await pool.query(
    `INSERT INTO lesson_reviews (lesson_id, reviewer_id, decision, notes) VALUES ($1, $2, $3, $4)`,
    [id, req.session.userId, "approved", notes ?? null]
  );
  await audit(req.session.userId!, "approve", "lesson", id, "in_review", "approved", { notes });
  await Promise.all([invalidate(CK.lessonContent(id)), invalidatePrefix("v1:levels:c:")]);

  res.json({ id, status: "approved", notes });
});

/** Reviewer or admin rejects → back to draft */
router.post("/cms/lessons/:id/reject", requireReviewer, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid lesson ID" }); return; }

  const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, id)).limit(1);
  if (!lesson || lesson.softDeletedAt) { res.status(404).json({ error: "Lesson not found" }); return; }
  if (lesson.status !== "in_review") {
    res.status(422).json({ error: "Only in_review lessons can be rejected" }); return;
  }

  const { notes } = req.body ?? {};
  await db.update(lessonsTable).set({ status: "draft" }).where(eq(lessonsTable.id, id));
  await pool.query(
    `INSERT INTO lesson_reviews (lesson_id, reviewer_id, decision, notes) VALUES ($1, $2, $3, $4)`,
    [id, req.session.userId, "rejected", notes ?? null]
  );
  await audit(req.session.userId!, "reject", "lesson", id, "in_review", "draft", { notes });
  res.json({ id, status: "draft", notes });
});

/** Admin publishes (must be approved first, or admin bypasses from draft/approved) */
router.post("/cms/lessons/:id/publish", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid lesson ID" }); return; }

  const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, id)).limit(1);
  if (!lesson || lesson.softDeletedAt) { res.status(404).json({ error: "Lesson not found" }); return; }

  // Validate: must have at least one active content block
  const blockCount = await pool.query<{ count: string }>(
    `SELECT COUNT(*) FROM content_blocks WHERE lesson_id = $1 AND is_active = true`, [id]
  );
  if (parseInt(blockCount.rows[0].count, 10) === 0) {
    res.status(422).json({
      error: "Cannot publish: lesson must have at least one active content block",
      validationErrors: ["contentBlocks"],
    });
    return;
  }

  // Validate: any MCQ blocks must have a correct answer
  const brokenMCQs = await pool.query<{ id: number }>(
    `SELECT e.id FROM exercises e
     JOIN content_blocks cb ON cb.id = e.content_block_id
     WHERE cb.lesson_id = $1 AND e.exercise_type = 'mcq'
       AND (e.correct_option_id IS NULL OR e.correct_option_id = '')`, [id]
  );
  if (brokenMCQs.rows.length > 0) {
    res.status(422).json({
      error: "Cannot publish: all MCQ exercises must have a correct answer",
      validationErrors: ["mcqCorrectAnswer"],
    });
    return;
  }

  if (!["draft", "approved"].includes(lesson.status)) {
    res.status(422).json({ error: `Cannot publish from status '${lesson.status}'` }); return;
  }

  await db.update(lessonsTable).set({ status: "published", isPublished: true }).where(eq(lessonsTable.id, id));
  await audit(req.session.userId!, "publish", "lesson", id, lesson.status, "published", { title: lesson.title });
  await Promise.all([invalidate(CK.lessonContent(id)), invalidatePrefix("v1:levels:c:")]);
  res.json({ id, status: "published" });
});

/** Admin unpublishes → back to draft */
router.post("/cms/lessons/:id/unpublish", requireAdmin, (req, res) =>
  transitionLesson(req, res, ["published"], "draft", false));

/** Admin archives */
router.post("/cms/lessons/:id/archive", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid lesson ID" }); return; }
  const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, id)).limit(1);
  if (!lesson || lesson.softDeletedAt) { res.status(404).json({ error: "Lesson not found" }); return; }
  await db.update(lessonsTable).set({ status: "archived", isPublished: false }).where(eq(lessonsTable.id, id));
  await audit(req.session.userId!, "archive", "lesson", id, lesson.status, "archived");
  await Promise.all([invalidate(CK.lessonContent(id)), invalidatePrefix("v1:levels:c:")]);
  res.json({ id, status: "archived" });
});

/** Admin restores → draft */
router.post("/cms/lessons/:id/restore", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid lesson ID" }); return; }
  const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, id)).limit(1);
  if (!lesson) { res.status(404).json({ error: "Lesson not found" }); return; }
  await db.update(lessonsTable).set({ status: "draft", isPublished: false }).where(eq(lessonsTable.id, id));
  await audit(req.session.userId!, "restore", "lesson", id, "archived", "draft");
  res.json({ id, status: "draft" });
});

/** Soft-delete a lesson.
 * Admin: can delete any lesson at any status.
 * Content manager: can only delete lessons in draft or in_review (not published/archived).
 */
router.delete("/cms/lessons/:id", requireContentManager, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid lesson ID" }); return; }
  const [lesson] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, id)).limit(1);
  if (!lesson || lesson.softDeletedAt) { res.status(404).json({ error: "Lesson not found" }); return; }

  // content_manager may only delete non-published lessons
  if (req.session.role !== "admin" && ["published", "archived"].includes(lesson.status)) {
    res.status(403).json({ error: `Cannot delete a ${lesson.status} lesson. Ask an admin.` }); return;
  }

  await db.update(lessonsTable).set({ softDeletedAt: new Date(), isPublished: false, status: "archived" }).where(eq(lessonsTable.id, id));
  await audit(req.session.userId!, "delete", "lesson", id, lesson.status, "archived");
  await Promise.all([invalidate(CK.lessonContent(id)), invalidatePrefix("v1:levels:c:")]);
  res.json({ id, deleted: true, archived: true });
});

// ─── Duplicate ─────────────────────────────────────────────────────────────

router.post("/cms/lessons/:id/duplicate", requireContentManager, async (req, res): Promise<void> => {
  const srcId = parseInt(req.params.id as string, 10);
  if (isNaN(srcId)) { res.status(400).json({ error: "Invalid lesson ID" }); return; }

  const [src] = await db.select().from(lessonsTable).where(eq(lessonsTable.id, srcId)).limit(1);
  if (!src || src.softDeletedAt) { res.status(404).json({ error: "Lesson not found" }); return; }

  // Deep copy: lesson → blocks → exercises → options → vocab links
  const [newLesson] = await db.insert(lessonsTable).values({
    levelId: src.levelId,
    title: `${src.title} (Copy)`, titleAr: `${src.titleAr} (نسخة)`,
    subtitle: src.subtitle, subtitleAr: src.subtitleAr,
    description: src.description, descriptionAr: src.descriptionAr,
    order: src.order + 100, // place after original
    lessonType: src.lessonType, estimatedMinutes: src.estimatedMinutes,
    isPublished: false, status: "draft",
    xpReward: src.xpReward, passingScore: src.passingScore,
    difficulty: src.difficulty, tags: src.tags,
    objectives: src.objectives, objectivesAr: src.objectivesAr,
    teacherNotes: src.teacherNotes, createdBy: req.session.userId,
  }).returning();

  const srcBlocks = await db.select().from(contentBlocksTable).where(eq(contentBlocksTable.lessonId, srcId)).orderBy(asc(contentBlocksTable.order));
  const srcExercises = await db.select().from(exercisesTable).where(eq(exercisesTable.lessonId, srcId));
  const srcVocab = await db.select().from(vocabularyTable).where(eq(vocabularyTable.lessonId, srcId));

  const blockIdMap = new Map<number, number>();

  for (const block of srcBlocks) {
    const [nb] = await db.insert(contentBlocksTable).values({
      lessonId: newLesson.id, type: block.type, order: block.order,
      title: block.title, titleAr: block.titleAr,
      instructions: block.instructions, instructionsAr: block.instructionsAr,
      content: block.content, contentAr: block.contentAr,
      audioNote: block.audioNote, prompt: block.prompt, promptAr: block.promptAr,
      exampleAudio: block.exampleAudio,
      isRequired: block.isRequired, estimatedMinutes: block.estimatedMinutes,
      isActive: block.isActive, config: block.config,
    }).returning();
    blockIdMap.set(block.id, nb.id);
  }

  for (const ex of srcExercises) {
    const newBlockId = ex.contentBlockId ? blockIdMap.get(ex.contentBlockId) : null;
    const [newEx] = await db.insert(exercisesTable).values({
      lessonId: newLesson.id, contentBlockId: newBlockId ?? null,
      exerciseType: ex.exerciseType,
      question: ex.question, questionAr: ex.questionAr,
      correctOptionId: ex.correctOptionId,
      explanation: ex.explanation, explanationAr: ex.explanationAr,
      prompt: ex.prompt, promptAr: ex.promptAr,
      instructionsText: ex.instructionsText, instructionsAr: ex.instructionsAr,
      modelAnswer: ex.modelAnswer, modelAnswerAr: ex.modelAnswerAr,
      expectedConcepts: ex.expectedConcepts,
      difficulty: ex.difficulty, points: ex.points, ordering: ex.ordering,
    }).returning();

    const srcOptions = await db.select().from(exerciseOptionsTable).where(eq(exerciseOptionsTable.exerciseId, ex.id));
    for (const opt of srcOptions) {
      await db.insert(exerciseOptionsTable).values({ exerciseId: newEx.id, optionId: opt.optionId, text: opt.text, textAr: opt.textAr });
    }
  }

  // Vocabulary: create new items linked to the new lesson
  for (const v of srcVocab) {
    await db.insert(vocabularyTable).values({
      levelId: v.levelId, lessonId: newLesson.id,
      word: v.word, translation: v.translation, definition: v.definition,
      partOfSpeech: v.partOfSpeech, exampleSentence: v.exampleSentence,
      exampleSentenceAr: v.exampleSentenceAr, pronunciation: v.pronunciation,
      audioNote: v.audioNote, difficulty: v.difficulty, tags: v.tags,
    });
  }

  await audit(req.session.userId!, "duplicate", "lesson", newLesson.id, null, "draft", { sourceId: srcId, title: newLesson.title });
  res.status(201).json({ id: newLesson.id, status: "draft", title: newLesson.title });
});

export default router;
