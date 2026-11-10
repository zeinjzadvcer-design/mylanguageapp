/**
 * CMS Catalog Management: Languages, Curricula, Levels
 */

import { Router, type IRouter } from "express";
import { eq, asc } from "drizzle-orm";
import { db, languagesTable, curriculaTable, levelsTable } from "@workspace/db";
import { requirePermission } from "../../middlewares/auth";
import { audit } from "../../services/cms-audit";
import { invalidate, invalidatePrefix, CK } from "../../services/cache";

const router: IRouter = Router();

// ─── Languages ─────────────────────────────────────────────────────────────

router.get("/cms/languages", requirePermission("content.view"), async (_req, res): Promise<void> => {
  const rows = await db.select().from(languagesTable).orderBy(asc(languagesTable.name));
  res.json(rows);
});

router.post("/cms/languages", requirePermission("catalog.manage"), async (req, res): Promise<void> => {
  const { code, name, nameNative, rtl, isActive } = req.body;
  if (!code || !name || !nameNative) {
    res.status(400).json({ error: "code, name, and nameNative are required" }); return;
  }
  const [lang] = await db.insert(languagesTable).values({
    code, name, nameNative, rtl: rtl ?? false, isActive: isActive !== false,
  }).returning();
  await audit(req.session.userId!, "create", "language", lang.id, null, null, { code, name });
  await invalidate(CK.langList());
  res.status(201).json(lang);
});

router.patch("/cms/languages/:id", requirePermission("catalog.manage"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  const allowed = ["name", "nameNative", "rtl", "isActive"];
  const update: Record<string, unknown> = {};
  for (const f of allowed) { if (req.body[f] !== undefined) update[f] = req.body[f]; }
  const [lang] = await db.update(languagesTable).set(update).where(eq(languagesTable.id, id)).returning();
  if (!lang) { res.status(404).json({ error: "Language not found" }); return; }
  await audit(req.session.userId!, "update", "language", id, null, null);
  await invalidate(CK.langList());
  res.json(lang);
});

// ─── Curricula ─────────────────────────────────────────────────────────────

router.get("/cms/curricula", requirePermission("content.view"), async (_req, res): Promise<void> => {
  const rows = await db.select().from(curriculaTable).orderBy(asc(curriculaTable.id));
  res.json(rows);
});

router.post("/cms/curricula", requirePermission("catalog.manage"), async (req, res): Promise<void> => {
  const { targetLanguageCode, learnerLanguageCode, name, nameInLearnerLanguage,
    levelFramework, description, descriptionInLearnerLanguage, isActive } = req.body;
  if (!targetLanguageCode || !learnerLanguageCode || !name || !nameInLearnerLanguage) {
    res.status(400).json({ error: "targetLanguageCode, learnerLanguageCode, name, nameInLearnerLanguage are required" }); return;
  }
  const [c] = await db.insert(curriculaTable).values({
    targetLanguageCode, learnerLanguageCode, name, nameInLearnerLanguage,
    levelFramework: levelFramework ?? "custom",
    description: description ?? null, descriptionInLearnerLanguage: descriptionInLearnerLanguage ?? null,
    isActive: isActive !== false,
  }).returning();
  await audit(req.session.userId!, "create", "curriculum", c.id, null, null, { name });
  await invalidate(CK.curriculaList());
  res.status(201).json(c);
});

router.patch("/cms/curricula/:id", requirePermission("catalog.manage"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  const allowed = ["name", "nameInLearnerLanguage", "levelFramework", "description",
    "descriptionInLearnerLanguage", "isActive"];
  const update: Record<string, unknown> = {};
  for (const f of allowed) { if (req.body[f] !== undefined) update[f] = req.body[f]; }
  const [c] = await db.update(curriculaTable).set(update).where(eq(curriculaTable.id, id)).returning();
  if (!c) { res.status(404).json({ error: "Curriculum not found" }); return; }
  await audit(req.session.userId!, "update", "curriculum", id, null, null);
  await invalidate(CK.curriculaList());
  res.json(c);
});

// ─── Levels ────────────────────────────────────────────────────────────────

router.get("/cms/levels", requirePermission("content.view"), async (req, res): Promise<void> => {
  const curriculumId = req.query.curriculumId ? parseInt(req.query.curriculumId as string, 10) : undefined;
  const rows = curriculumId && !isNaN(curriculumId)
    ? await db.select().from(levelsTable).where(eq(levelsTable.curriculumId, curriculumId)).orderBy(asc(levelsTable.order))
    : await db.select().from(levelsTable).orderBy(asc(levelsTable.curriculumId), asc(levelsTable.order));
  res.json(rows);
});

router.post("/cms/levels", requirePermission("catalog.manage"), async (req, res): Promise<void> => {
  const { curriculumId, code, name, nameAr, description, descriptionAr, order } = req.body;
  if (!curriculumId || !code || !name || !nameAr || order === undefined) {
    res.status(400).json({ error: "curriculumId, code, name, nameAr, order are required" }); return;
  }
  const [level] = await db.insert(levelsTable).values({
    curriculumId, code, name, nameAr,
    description: description ?? null, descriptionAr: descriptionAr ?? null, order,
  }).returning();
  await audit(req.session.userId!, "create", "level", level.id, null, null, { code, name });
  await invalidatePrefix("v1:levels:c:");
  res.status(201).json(level);
});

router.patch("/cms/levels/:id", requirePermission("catalog.manage"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  const allowed = [
    "code", "name", "nameAr", "description", "descriptionAr", "order",
    "evaluationUnlockPercent",
  ];
  const update: Record<string, unknown> = {};
  for (const f of allowed) { if (req.body[f] !== undefined) update[f] = req.body[f]; }

  if ("evaluationUnlockPercent" in update) {
    const pct = update.evaluationUnlockPercent;
    if (typeof pct !== "number" || !Number.isInteger(pct) || pct < 0 || pct > 100) {
      res.status(400).json({ error: "evaluationUnlockPercent must be a whole number between 0 and 100" });
      return;
    }
  }

  const [level] = await db.update(levelsTable).set(update).where(eq(levelsTable.id, id)).returning();
  if (!level) { res.status(404).json({ error: "Level not found" }); return; }
  await audit(req.session.userId!, "update", "level", id, null, null);
  await invalidatePrefix("v1:levels:c:");
  res.json(level);
});

/** Reorder levels: body = { levelIds: number[] } */
router.post("/cms/levels/reorder", requirePermission("catalog.manage"), async (req, res): Promise<void> => {
  const { levelIds } = req.body;
  if (!Array.isArray(levelIds)) { res.status(400).json({ error: "levelIds must be an array" }); return; }
  for (let i = 0; i < levelIds.length; i++) {
    await db.update(levelsTable).set({ order: i + 1 }).where(eq(levelsTable.id, levelIds[i]));
  }
  await invalidatePrefix("v1:levels:c:");
  res.json({ reordered: true });
});

export default router;
