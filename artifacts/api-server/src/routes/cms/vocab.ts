/**
 * CMS Vocabulary Management
 */

import { Router, type IRouter } from "express";
import { eq, and, isNull, ilike, or } from "drizzle-orm";
import { db, pool, vocabularyTable } from "@workspace/db";
import { requirePermission } from "../../middlewares/auth";
import { audit } from "../../services/cms-audit";
import { invalidate, invalidatePrefix, CK } from "../../services/cache";

const router: IRouter = Router();

router.get("/cms/vocabulary", requirePermission("content.view"), async (req, res): Promise<void> => {
  const page = Math.max(1, parseInt((req.query.page as string) ?? "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) ?? "30", 10)));
  const offset = (page - 1) * limit;
  const search = (req.query.search as string | undefined)?.trim();
  const levelId = req.query.levelId ? parseInt(req.query.levelId as string, 10) : undefined;
  const lessonId = req.query.lessonId ? parseInt(req.query.lessonId as string, 10) : undefined;

  const conditions: string[] = ["deleted_at IS NULL"];
  const params: unknown[] = [];

  if (search) { params.push(`%${search}%`); conditions.push(`(word ILIKE $${params.length} OR translation ILIKE $${params.length})`); }
  if (levelId && !isNaN(levelId)) { params.push(levelId); conditions.push(`level_id = $${params.length}`); }
  if (lessonId && !isNaN(lessonId)) { params.push(lessonId); conditions.push(`lesson_id = $${params.length}`); }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const [countRes, rows] = await Promise.all([
    pool.query<{ count: string }>(`SELECT COUNT(*) FROM vocabulary ${where}`, params),
    pool.query(
      `SELECT * FROM vocabulary ${where} ORDER BY word LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
  ]);

  res.json({
    items: rows.rows,
    total: parseInt(countRes.rows[0].count, 10),
    page, limit,
  });
});

router.post("/cms/vocabulary", requirePermission("content.edit"), async (req, res): Promise<void> => {
  const { levelId, lessonId, word, translation, definition, partOfSpeech,
    exampleSentence, exampleSentenceAr, pronunciation, audioNote,
    difficulty, tags } = req.body;

  if (!levelId || !word || !translation) {
    res.status(400).json({ error: "levelId, word, and translation are required" }); return;
  }

  const [item] = await db.insert(vocabularyTable).values({
    levelId, lessonId: lessonId ?? null,
    word, translation, definition: definition ?? null,
    partOfSpeech: partOfSpeech ?? null,
    exampleSentence: exampleSentence ?? null, exampleSentenceAr: exampleSentenceAr ?? null,
    pronunciation: pronunciation ?? null, audioNote: audioNote ?? null,
    difficulty: difficulty ?? null, tags: tags ?? null,
  }).returning();

  await audit(req.session.userId!, "create", "vocabulary", item.id, null, null, { word });
  if (lessonId) await invalidate(CK.vocabByLesson(lessonId));
  await invalidate(CK.vocabByLevel(levelId));
  res.status(201).json(item);
});

router.patch("/cms/vocabulary/:id", requirePermission("content.edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const [existing] = await db.select().from(vocabularyTable).where(eq(vocabularyTable.id, id)).limit(1);
  if (!existing || existing.deletedAt) { res.status(404).json({ error: "Vocabulary item not found" }); return; }

  const allowed = ["levelId", "lessonId", "word", "translation", "definition",
    "partOfSpeech", "exampleSentence", "exampleSentenceAr",
    "pronunciation", "audioNote", "difficulty", "tags"];
  const update: Record<string, unknown> = { updatedAt: new Date() };
  for (const f of allowed) { if (req.body[f] !== undefined) update[f] = req.body[f]; }

  const [item] = await db.update(vocabularyTable).set(update).where(eq(vocabularyTable.id, id)).returning();
  await audit(req.session.userId!, "update", "vocabulary", id, null, null);
  if (existing.lessonId) await invalidate(CK.vocabByLesson(existing.lessonId));
  await invalidate(CK.vocabByLevel(existing.levelId));
  res.json(item);
});

router.delete("/cms/vocabulary/:id", requirePermission("content.edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const [item] = await db.select().from(vocabularyTable).where(eq(vocabularyTable.id, id)).limit(1);
  if (!item) { res.status(404).json({ error: "Vocabulary item not found" }); return; }

  await db.update(vocabularyTable).set({ deletedAt: new Date() }).where(eq(vocabularyTable.id, id));
  await audit(req.session.userId!, "delete", "vocabulary", id, null, null, { word: item.word });
  if (item.lessonId) await invalidate(CK.vocabByLesson(item.lessonId));
  await invalidate(CK.vocabByLevel(item.levelId));
  res.json({ deleted: true });
});

export default router;
