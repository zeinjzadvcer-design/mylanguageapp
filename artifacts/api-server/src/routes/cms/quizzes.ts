/**
 * CMS Quizzes
 *
 * A quiz is an ordered timeline of content blocks — the same block model
 * lessons use, parented by quiz_id instead of lesson_id. Everything that
 * understands a lesson block therefore understands a quiz block.
 *
 * Lifecycle mirrors lessons: draft → in_review → approved → published →
 * archived. Student-facing routes only ever serve 'published'.
 */

import { Router, type IRouter } from "express";
import { eq, and, asc, desc, isNull, sql } from "drizzle-orm";
import { db, quizzesTable, contentBlocksTable } from "@workspace/db";
import { requirePermission } from "../../middlewares/auth";
import { hasPermission } from "../../services/access-policy";
import { audit } from "../../services/cms-audit";
import { notifyQuizPublished } from "../../services/notifications";

const router: IRouter = Router();

/** Block types a quiz timeline can hold. */
const QUIZ_BLOCK_TYPES = [
  "mcq",
  "multi_select",
  "writing",
  "listening",
  "speaking_prompt",
  "image_describe",
  "video",
  "audio",
  "text",
  "explanation",
  "spelling",
] as const;

type QuizBlockType = (typeof QUIZ_BLOCK_TYPES)[number];

const isQuizBlockType = (v: unknown): v is QuizBlockType =>
  typeof v === "string" && (QUIZ_BLOCK_TYPES as readonly string[]).includes(v);

/**
 * Turn a database constraint violation into something an author can act on.
 *
 * A level may have only one published evaluation, enforced by a partial unique
 * index. Without this the violation surfaces as a 500 with a Postgres index
 * name in it, which tells a curriculum manager nothing about what they did
 * wrong or what to do instead.
 *
 * Returns true when it handled the error and sent a response.
 */
function handleConstraint(err: unknown, res: import("express").Response): boolean {
  // Drizzle wraps the driver error, so the Postgres SQLSTATE and constraint
  // name are on the cause, not on what was thrown. Walking the chain is what
  // makes this work at all — checking only the top level silently never
  // matches, and every violation surfaces as a raw 500 with SQL in it.
  let cursor: unknown = err;
  let code: string | undefined;
  let constraint = "";

  for (let depth = 0; cursor && depth < 5; depth++) {
    const candidate = cursor as { code?: string; constraint?: string; cause?: unknown };
    if (typeof candidate.code === "string" && !code) code = candidate.code;
    if (typeof candidate.constraint === "string" && !constraint) {
      constraint = candidate.constraint;
    }
    if (code === "23505") break;
    cursor = candidate.cause;
  }

  if (code !== "23505") return false;

  if (constraint.includes("evaluation_per_level")) {
    res.status(409).json({
      error:
        "This level already has a published evaluation. Unpublish it first, " +
        "or publish this one after archiving the old one.",
      code: "EVALUATION_ALREADY_PUBLISHED",
    });
    return true;
  }

  res.status(409).json({ error: "That change conflicts with an existing record." });
  return true;
}

/** Statuses a content_manager may not mutate; only an admin can, post-unpublish. */
const LOCKED_STATUSES = ["published", "archived"];

async function loadEditableQuiz(
  id: number,
  role: string | undefined,
): Promise<{ quiz?: typeof quizzesTable.$inferSelect; error?: string; status?: number }> {
  const [quiz] = await db
    .select()
    .from(quizzesTable)
    .where(and(eq(quizzesTable.id, id), isNull(quizzesTable.softDeletedAt)))
    .limit(1);

  if (!quiz) return { error: "Quiz not found", status: 404 };
  if (!hasPermission(role, "content.publish") && LOCKED_STATUSES.includes(quiz.status)) {
    return {
      error: `Cannot edit a ${quiz.status} quiz. Unpublish it first or contact an admin.`,
      status: 403,
    };
  }
  return { quiz };
}

// ─── Quiz CRUD ───────────────────────────────────────────────────────────────

/** List quizzes, newest first. Supports ?status= and ?search=. */
router.get("/cms/quizzes", requirePermission("content.view"), async (req, res): Promise<void> => {
  const page = Math.max(1, parseInt((req.query.page as string) ?? "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) ?? "20", 10) || 20));
  const status = req.query.status as string | undefined;
  const search = (req.query.search as string | undefined)?.trim();

  const filters = [isNull(quizzesTable.softDeletedAt)];
  if (status) filters.push(eq(quizzesTable.status, status));
  if (search) filters.push(sql`(${quizzesTable.title} ILIKE ${"%" + search + "%"} OR ${quizzesTable.titleAr} ILIKE ${"%" + search + "%"})`);

  const where = and(...filters);

  const [rows, [{ count }]] = await Promise.all([
    db.select().from(quizzesTable).where(where)
      .orderBy(desc(quizzesTable.updatedAt))
      .limit(limit).offset((page - 1) * limit),
    db.select({ count: sql<number>`count(*)::int` }).from(quizzesTable).where(where),
  ]);

  // Block counts drive the "N blocks" label in the list without a second trip.
  const counts = await db
    .select({ quizId: contentBlocksTable.quizId, n: sql<number>`count(*)::int` })
    .from(contentBlocksTable)
    .where(sql`${contentBlocksTable.quizId} IS NOT NULL`)
    .groupBy(contentBlocksTable.quizId);

  const byQuiz = new Map(counts.map((c) => [c.quizId, c.n]));

  res.json({
    quizzes: rows.map((q) => ({ ...q, blockCount: byQuiz.get(q.id) ?? 0 })),
    total: count,
    page,
    limit,
  });
});

/** Full quiz with its ordered timeline. */
router.get("/cms/quizzes/:id", requirePermission("content.view"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid quiz ID" }); return; }

  const [quiz] = await db.select().from(quizzesTable)
    .where(and(eq(quizzesTable.id, id), isNull(quizzesTable.softDeletedAt))).limit(1);
  if (!quiz) { res.status(404).json({ error: "Quiz not found" }); return; }

  const blocks = await db.select().from(contentBlocksTable)
    .where(eq(contentBlocksTable.quizId, id))
    .orderBy(asc(contentBlocksTable.order));

  res.json({ ...quiz, blocks });
});

/**
 * Guard the level_evaluation shape before it reaches the database.
 *
 * The same rules exist as CHECK constraints in migration 004 — this layer is
 * here to turn them into an editable message for the curriculum team instead of
 * a 500 from a constraint violation.
 */
function validateEvaluationShape(
  kind: unknown,
  levelId: unknown,
  cooldownHours: unknown,
): string | null {
  if (kind !== undefined && kind !== null && kind !== "practice" && kind !== "level_evaluation") {
    return "kind must be 'practice' or 'level_evaluation'";
  }
  if (kind === "level_evaluation" && (levelId === undefined || levelId === null)) {
    return "A level evaluation must be attached to a level (levelId is required)";
  }
  if (
    cooldownHours !== undefined && cooldownHours !== null &&
    (typeof cooldownHours !== "number" || !Number.isInteger(cooldownHours) || cooldownHours < 0)
  ) {
    return "cooldownHours must be a non-negative whole number of hours";
  }
  return null;
}

/** Create a quiz. Starts in draft with an empty timeline. */
router.post("/cms/quizzes", requirePermission("content.edit"), async (req, res): Promise<void> => {
  const {
    title, titleAr, description, descriptionAr, instructions, instructionsAr,
    levelId, timeLimitSec, maxAttempts, passingScore, xpReward,
    shuffleBlocks, revealAnswers, tags, teacherNotes, kind, cooldownHours,
  } = req.body;

  if (!title || !titleAr) {
    res.status(400).json({ error: "title and titleAr are required" });
    return;
  }

  const kindError = validateEvaluationShape(kind, levelId, cooldownHours);
  if (kindError) {
    res.status(400).json({ error: kindError });
    return;
  }

  let quiz;
  try {
    [quiz] = await db.insert(quizzesTable).values({
    title, titleAr,
    description: description ?? null,
    descriptionAr: descriptionAr ?? null,
    instructions: instructions ?? null,
    instructionsAr: instructionsAr ?? null,
    levelId: levelId ?? null,
    timeLimitSec: timeLimitSec ?? null,
    maxAttempts: maxAttempts ?? null,
    passingScore: passingScore ?? 75,
    xpReward: xpReward ?? 50,
    shuffleBlocks: shuffleBlocks ?? false,
    revealAnswers: revealAnswers ?? "after_submit",
    kind: kind ?? "practice",
    cooldownHours: cooldownHours ?? null,
    tags: tags ?? null,
    teacherNotes: teacherNotes ?? null,
      createdBy: req.session.userId!,
    }).returning();
  } catch (err) {
    if (handleConstraint(err, res)) return;
    throw err;
  }

  await audit(req.session.userId!, "create", "quiz", quiz.id, null, quiz.status, { title });
  res.status(201).json(quiz);
});

/** Update quiz settings. */
router.patch("/cms/quizzes/:id", requirePermission("content.edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid quiz ID" }); return; }

  const { quiz, error, status } = await loadEditableQuiz(id, req.session.role);
  if (!quiz) { res.status(status!).json({ error }); return; }

  const editable = [
    "title", "titleAr", "description", "descriptionAr", "instructions",
    "instructionsAr", "levelId", "timeLimitSec", "maxAttempts", "passingScore",
    "xpReward", "shuffleBlocks", "revealAnswers", "tags", "teacherNotes",
    "kind", "cooldownHours",
  ] as const;

  const patch: Record<string, unknown> = {};
  for (const key of editable) {
    if (key in req.body) patch[key] = req.body[key];
  }
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "No editable fields supplied" });
    return;
  }

  // Validate against the quiz as it will be, not as it was — clearing levelId
  // and setting kind in the same request must not slip past a field-by-field
  // check.
  const kindError = validateEvaluationShape(
    "kind" in patch ? patch.kind : quiz.kind,
    "levelId" in patch ? patch.levelId : quiz.levelId,
    "cooldownHours" in patch ? patch.cooldownHours : quiz.cooldownHours,
  );
  if (kindError) {
    res.status(400).json({ error: kindError });
    return;
  }

  let updated;
  try {
    [updated] = await db.update(quizzesTable).set(patch)
      .where(eq(quizzesTable.id, id)).returning();
  } catch (err) {
    if (handleConstraint(err, res)) return;
    throw err;
  }

  await audit(req.session.userId!, "update", "quiz", id, quiz.status, updated.status, {
    fields: Object.keys(patch),
  });
  res.json(updated);
});

/** Soft-delete. */
router.delete("/cms/quizzes/:id", requirePermission("content.edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid quiz ID" }); return; }

  const { quiz, error, status } = await loadEditableQuiz(id, req.session.role);
  if (!quiz) { res.status(status!).json({ error }); return; }

  await db.update(quizzesTable).set({ softDeletedAt: new Date() })
    .where(eq(quizzesTable.id, id));

  await audit(req.session.userId!, "delete", "quiz", id, quiz.status, null, {});
  res.json({ deleted: true });
});

// ─── Timeline blocks ─────────────────────────────────────────────────────────

/** The block palette the timeline editor offers. */
router.get("/cms/quiz-block-types", requirePermission("content.view"), (_req, res): void => {
  res.json({ types: QUIZ_BLOCK_TYPES });
});

/** Append a block to the timeline. Order defaults to the end. */
router.post("/cms/quizzes/:id/blocks", requirePermission("content.edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid quiz ID" }); return; }

  const { quiz, error, status } = await loadEditableQuiz(id, req.session.role);
  if (!quiz) { res.status(status!).json({ error }); return; }

  const { type } = req.body;
  if (!isQuizBlockType(type)) {
    res.status(400).json({
      error: `Invalid block type. Expected one of: ${QUIZ_BLOCK_TYPES.join(", ")}`,
    });
    return;
  }

  // Append unless the caller pins a position.
  let order = req.body.order;
  if (typeof order !== "number") {
    const [{ max }] = await db
      .select({ max: sql<number>`coalesce(max(${contentBlocksTable.order}), 0)::int` })
      .from(contentBlocksTable)
      .where(eq(contentBlocksTable.quizId, id));
    order = max + 1;
  }

  const {
    title, titleAr, instructions, instructionsAr, content, contentAr,
    audioNote, prompt, promptAr, exampleAudio, isRequired,
    estimatedMinutes, config, expectsReferenceReading, referenceMediaId,
  } = req.body;

  const [block] = await db.insert(contentBlocksTable).values({
    quizId: id,
    lessonId: null,
    type, order,
    title: title ?? null, titleAr: titleAr ?? null,
    instructions: instructions ?? null, instructionsAr: instructionsAr ?? null,
    content: content ?? null, contentAr: contentAr ?? null,
    audioNote: audioNote ?? null,
    prompt: prompt ?? null, promptAr: promptAr ?? null,
    exampleAudio: exampleAudio ?? null,
    isRequired: isRequired ?? true,
    estimatedMinutes: estimatedMinutes ?? null,
    config: config ?? null,
    // Decides whether a spoken answer can be scored for pronunciation at all:
    // without a set passage there is nothing to align a transcript against.
    expectsReferenceReading: expectsReferenceReading ?? false,
    referenceMediaId: referenceMediaId ?? null,
  }).returning();

  await audit(req.session.userId!, "create", "content_block", block.id, null, null, {
    quizId: id, type,
  });
  res.status(201).json(block);
});

/** Update one block. */
router.patch("/cms/quizzes/:id/blocks/:blockId", requirePermission("content.edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  const blockId = parseInt(req.params.blockId as string, 10);
  if (isNaN(id) || isNaN(blockId)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const { quiz, error, status } = await loadEditableQuiz(id, req.session.role);
  if (!quiz) { res.status(status!).json({ error }); return; }

  if ("type" in req.body && !isQuizBlockType(req.body.type)) {
    res.status(400).json({
      error: `Invalid block type. Expected one of: ${QUIZ_BLOCK_TYPES.join(", ")}`,
    });
    return;
  }

  const editable = [
    "type", "order", "title", "titleAr", "instructions", "instructionsAr",
    "content", "contentAr", "audioNote", "prompt", "promptAr", "exampleAudio",
    "isRequired", "estimatedMinutes", "isActive", "config",
    "expectsReferenceReading", "referenceMediaId",
  ] as const;

  const patch: Record<string, unknown> = {};
  for (const key of editable) {
    if (key in req.body) patch[key] = req.body[key];
  }
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "No editable fields supplied" });
    return;
  }
  patch.updatedAt = new Date();

  const [updated] = await db.update(contentBlocksTable).set(patch)
    .where(and(eq(contentBlocksTable.id, blockId), eq(contentBlocksTable.quizId, id)))
    .returning();

  if (!updated) { res.status(404).json({ error: "Block not found on this quiz" }); return; }

  await audit(req.session.userId!, "update", "content_block", blockId, null, null, { quizId: id });
  res.json(updated);
});

/** Remove a block from the timeline. */
router.delete("/cms/quizzes/:id/blocks/:blockId", requirePermission("content.edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  const blockId = parseInt(req.params.blockId as string, 10);
  if (isNaN(id) || isNaN(blockId)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const { quiz, error, status } = await loadEditableQuiz(id, req.session.role);
  if (!quiz) { res.status(status!).json({ error }); return; }

  const [deleted] = await db.delete(contentBlocksTable)
    .where(and(eq(contentBlocksTable.id, blockId), eq(contentBlocksTable.quizId, id)))
    .returning();

  if (!deleted) { res.status(404).json({ error: "Block not found on this quiz" }); return; }

  await audit(req.session.userId!, "delete", "content_block", blockId, null, null, { quizId: id });
  res.json({ deleted: true });
});

/**
 * Reorder the timeline. Body: { blockIds: [3, 1, 2] } — the complete, ordered
 * list of this quiz's blocks. Rejects a partial list so a dropped id can never
 * silently strand a block at a stale position.
 */
router.post("/cms/quizzes/:id/blocks/reorder", requirePermission("content.edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid quiz ID" }); return; }

  const { quiz, error, status } = await loadEditableQuiz(id, req.session.role);
  if (!quiz) { res.status(status!).json({ error }); return; }

  const { blockIds } = req.body;
  if (!Array.isArray(blockIds) || blockIds.some((b) => typeof b !== "number")) {
    res.status(400).json({ error: "blockIds must be an array of numbers" });
    return;
  }

  const existing = await db.select({ id: contentBlocksTable.id })
    .from(contentBlocksTable).where(eq(contentBlocksTable.quizId, id));
  const existingIds = new Set(existing.map((b) => b.id));

  if (blockIds.length !== existingIds.size || !blockIds.every((b) => existingIds.has(b))) {
    res.status(400).json({
      error: "blockIds must list every block on this quiz exactly once",
      expected: [...existingIds],
    });
    return;
  }

  await db.transaction(async (tx) => {
    for (const [index, blockId] of blockIds.entries()) {
      await tx.update(contentBlocksTable)
        .set({ order: index + 1, updatedAt: new Date() })
        .where(and(eq(contentBlocksTable.id, blockId), eq(contentBlocksTable.quizId, id)));
    }
  });

  await audit(req.session.userId!, "update", "quiz", id, null, null, { reordered: blockIds });
  res.json({ reordered: true, order: blockIds });
});

// ─── Lifecycle ───────────────────────────────────────────────────────────────

/** A quiz needs at least one block before it can leave draft. */
async function blockCount(quizId: number): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(contentBlocksTable)
    .where(eq(contentBlocksTable.quizId, quizId));
  return n;
}

function transition(
  path: string,
  next: string,
  guard: ReturnType<typeof requirePermission>,
  allowedFrom: string[],
) {
  router.post(`/cms/quizzes/:id/${path}`, guard, async (req, res): Promise<void> => {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid quiz ID" }); return; }

    const [quiz] = await db.select().from(quizzesTable)
      .where(and(eq(quizzesTable.id, id), isNull(quizzesTable.softDeletedAt))).limit(1);
    if (!quiz) { res.status(404).json({ error: "Quiz not found" }); return; }

    if (!allowedFrom.includes(quiz.status)) {
      res.status(409).json({
        error: `Cannot ${path} a quiz in '${quiz.status}' status. Allowed from: ${allowedFrom.join(", ")}.`,
      });
      return;
    }

    if ((next === "in_review" || next === "published") && (await blockCount(id)) === 0) {
      res.status(400).json({ error: "A quiz needs at least one block before it can be published." });
      return;
    }

    let updated;
    try {
      [updated] = await db.update(quizzesTable)
        .set({
          status: next,
        // Publishing an edited quiz bumps the version so in-flight attempts
        // stay pinned to the version the student actually saw.
          ...(next === "published" ? { contentVersion: quiz.contentVersion + 1 } : {}),
        })
        .where(eq(quizzesTable.id, id)).returning();
    } catch (err) {
      if (handleConstraint(err, res)) return;
      throw err;
    }

    await audit(req.session.userId!, path, "quiz", id, quiz.status, next, {});
    // Announced to the students who can now take it. Never throws.
    if (next === "published") await notifyQuizPublished(id);
    res.json({ id: updated.id, status: updated.status });
  });
}

transition("submit", "in_review", requirePermission("content.edit"), ["draft"]);
transition("approve", "approved", requirePermission("content.review"), ["in_review"]);
transition("reject", "draft", requirePermission("content.review"), ["in_review"]);
transition("publish", "published", requirePermission("content.publish"), ["approved", "draft"]);
transition("unpublish", "draft", requirePermission("content.publish"), ["published"]);
transition("archive", "archived", requirePermission("content.publish"), ["published", "draft", "approved"]);
transition("restore", "draft", requirePermission("content.publish"), ["archived"]);

export default router;
