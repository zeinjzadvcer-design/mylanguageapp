import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, vocabularyTable } from "@workspace/db";
import { cached, CK, TTL } from "../services/cache";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

/**
 * GET /vocabulary?lessonId=&levelId=
 * Cache: 15 min per lesson/level. Vocabulary is stable between admin updates.
 */
// Signed in: the only caller is the student's own vocabulary page, and the
// unfiltered list is the whole table, which nobody outside the app needs.
router.get("/vocabulary", requireAuth, async (req, res): Promise<void> => {
  const lessonId = req.query.lessonId ? parseInt(req.query.lessonId as string, 10) : undefined;
  const levelId  = req.query.levelId  ? parseInt(req.query.levelId  as string, 10) : undefined;

  const mapItem = (v: typeof vocabularyTable.$inferSelect) => ({
    id: v.id,
    levelId: v.levelId,
    lessonId: v.lessonId ?? null,
    word: v.word,
    translation: v.translation,
    /** The explanation, as opposed to the one-word translation. */
    definition: v.definition ?? null,
    exampleSentence: v.exampleSentence ?? null,
    exampleSentenceAr: v.exampleSentenceAr ?? null,
    pronunciation: v.pronunciation ?? null,
    audioNote: v.audioNote ?? null,
  });

  if (lessonId && !isNaN(lessonId)) {
    const items = await cached(CK.vocabByLesson(lessonId), TTL.VOCABULARY, () =>
      db.select().from(vocabularyTable).where(eq(vocabularyTable.lessonId, lessonId)).then(r => r.map(mapItem)),
    );
    res.json(items);
    return;
  }

  if (levelId && !isNaN(levelId)) {
    const items = await cached(CK.vocabByLevel(levelId), TTL.VOCABULARY, () =>
      db.select().from(vocabularyTable).where(eq(vocabularyTable.levelId, levelId)).then(r => r.map(mapItem)),
    );
    res.json(items);
    return;
  }

  // No filter: the vocabulary page asks for everything. Cached like the other
  // two, rather than reading the whole table on every visit.
  const items = await cached(CK.vocabAll(), TTL.VOCABULARY, () =>
    db.select().from(vocabularyTable).then((r) => r.map(mapItem)),
  );
  res.json(items);
});

export default router;
