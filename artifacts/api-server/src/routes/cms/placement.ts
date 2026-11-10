/**
 * CMS Placement Test Management
 *
 * The placement test decides every student's starting level, and until now it
 * could only be changed with SQL — the one piece of curriculum the curriculum
 * team did not own (spec section 1 lists "Evaluation tests" among the things
 * they define).
 *
 * Answer keys (`isCorrect`) live here and are never sent to a student: the
 * student-facing route in `routes/placement.ts` builds its own payload and
 * grades server-side.
 */

import { Router, type IRouter } from "express";
import { eq, asc, sql } from "drizzle-orm";
import {
  db,
  placementQuestionsTable,
  placementOptionsTable,
} from "@workspace/db";
import { requirePermission } from "../../middlewares/auth";
import { audit } from "../../services/cms-audit";

const router: IRouter = Router();

/** Every question with its options, in the order students see them. */
router.get("/cms/placement/questions", requirePermission("content.view"), async (_req, res): Promise<void> => {
  const [questions, options] = await Promise.all([
    db.select().from(placementQuestionsTable).orderBy(asc(placementQuestionsTable.order), asc(placementQuestionsTable.id)),
    db.select().from(placementOptionsTable).orderBy(asc(placementOptionsTable.optionId)),
  ]);

  res.json({
    questions: questions.map((q) => ({
      ...q,
      options: options.filter((o) => o.questionId === q.id),
    })),
  });
});

const QUESTION_FIELDS = [
  "questionText", "questionTextAr", "type", "skill",
  "difficulty", "passage", "mediaId", "isActive", "order",
] as const;

/** Replace a question's options wholesale — simpler than diffing ids. */
async function replaceOptions(
  questionId: number,
  options: Array<{ optionId: string; text: string; textAr?: string | null; isCorrect?: boolean }>,
): Promise<void> {
  await db.delete(placementOptionsTable).where(eq(placementOptionsTable.questionId, questionId));
  for (const o of options) {
    await db.insert(placementOptionsTable).values({
      questionId,
      optionId: o.optionId,
      text: o.text,
      textAr: o.textAr ?? null,
      isCorrect: !!o.isCorrect,
    });
  }
}

router.post("/cms/placement/questions", requirePermission("content.edit"), async (req, res): Promise<void> => {
  const { options } = req.body;

  // A new question is created blank and filled in afterwards, the same way a
  // content block is — so emptiness is not an error here. What must not happen
  // is a blank question reaching students, which is checked on activation
  // below rather than at creation.

  // Append to the end of the test unless an explicit position is given.
  const [{ maxOrder }] = await db
    .select({ maxOrder: sql<number>`coalesce(max("order"), 0)::int` })
    .from(placementQuestionsTable);

  const values: Record<string, unknown> = { order: maxOrder + 1 };
  for (const f of QUESTION_FIELDS) {
    if (req.body[f] !== undefined) values[f] = req.body[f];
  }
  // A blank question starts inactive whatever the client asked for: students
  // sit the active set, and an empty question there is unanswerable.
  if (!values.questionText || !values.questionTextAr) values.isActive = false;

  const [question] = await db
    .insert(placementQuestionsTable)
    .values(values as typeof placementQuestionsTable.$inferInsert)
    .returning();

  if (Array.isArray(options)) await replaceOptions(question.id, options);

  await audit(req.session.userId!, "create", "placement_question", question.id, null, null);
  res.status(201).json(question);
});

router.patch("/cms/placement/questions/:id", requirePermission("content.edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid question ID" }); return; }

  const update: Record<string, unknown> = {};
  for (const f of QUESTION_FIELDS) {
    if (req.body[f] !== undefined) update[f] = req.body[f];
  }

  // Validation belongs here rather than at creation: a question may be saved
  // half-finished for as long as the author likes, but the moment it is active
  // a student will be asked it, so it has to have both texts and — unless it is
  // a written question — a marked correct answer.
  if (update.isActive === true || (update.isActive === undefined && req.body.isActive === true)) {
    const [existing] = await db
      .select()
      .from(placementQuestionsTable)
      .where(eq(placementQuestionsTable.id, id))
      .limit(1);
    if (!existing) { res.status(404).json({ error: "Question not found" }); return; }

    const text = (update.questionText ?? existing.questionText) as string;
    const textAr = (update.questionTextAr ?? existing.questionTextAr) as string;
    const type = (update.type ?? existing.type) as string;

    if (!text?.trim() || !textAr?.trim()) {
      res.status(422).json({
        error: "An active question needs both the English and Arabic text.",
        code: "QUESTION_INCOMPLETE",
      });
      return;
    }

    if (type !== "written") {
      const options = Array.isArray(req.body.options)
        ? req.body.options
        : await db.select().from(placementOptionsTable).where(eq(placementOptionsTable.questionId, id));
      const filled = options.filter((o: { text?: string }) => o.text?.trim());
      if (filled.length < 2) {
        res.status(422).json({
          error: "An active question needs at least two options.",
          code: "QUESTION_INCOMPLETE",
        });
        return;
      }
      if (!options.some((o: { isCorrect?: boolean; text?: string }) => o.isCorrect && o.text?.trim())) {
        res.status(422).json({
          error: "Mark which option is the correct answer.",
          code: "QUESTION_NO_ANSWER",
        });
        return;
      }
    }
  }

  const [question] = Object.keys(update).length
    ? await db.update(placementQuestionsTable).set(update).where(eq(placementQuestionsTable.id, id)).returning()
    : await db.select().from(placementQuestionsTable).where(eq(placementQuestionsTable.id, id)).limit(1);

  if (!question) { res.status(404).json({ error: "Question not found" }); return; }

  if (Array.isArray(req.body.options)) await replaceOptions(id, req.body.options);

  await audit(req.session.userId!, "update", "placement_question", id, null, null);
  res.json(question);
});

/**
 * Hard delete, not soft.
 *
 * `placement_results` stores the scored outcome rather than per-question rows,
 * so removing a question cannot orphan a student's result. Deactivating is
 * still the gentler option and is what `isActive` is for.
 */
router.delete("/cms/placement/questions/:id", requirePermission("content.edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid question ID" }); return; }

  await db.delete(placementQuestionsTable).where(eq(placementQuestionsTable.id, id));
  await audit(req.session.userId!, "delete", "placement_question", id, null, null);
  res.json({ deleted: true });
});

/** Reorder the whole test in one call. */
router.post("/cms/placement/questions/reorder", requirePermission("content.edit"), async (req, res): Promise<void> => {
  const { questionIds } = req.body;
  if (!Array.isArray(questionIds)) {
    res.status(400).json({ error: "questionIds array is required" });
    return;
  }

  for (let i = 0; i < questionIds.length; i++) {
    await db
      .update(placementQuestionsTable)
      .set({ order: i + 1 })
      .where(eq(placementQuestionsTable.id, questionIds[i]));
  }

  await audit(req.session.userId!, "reorder", "placement_question", 0, null, null);
  res.json({ reordered: true });
});

export default router;
