/**
 * CMS Dashboard
 * GET /cms/stats — counts by entity and lesson status, recently modified
 */
import { Router, type IRouter } from "express";
import { eq, isNull, desc, sql } from "drizzle-orm";
import {
  db, pool,
  lessonsTable, levelsTable, curriculaTable, languagesTable, vocabularyTable,
} from "@workspace/db";
import { requirePermission } from "../../middlewares/auth";

const router: IRouter = Router();

router.get("/cms/stats", requirePermission("content.view"), async (req, res): Promise<void> => {
  const [
    langCount, curriculaCount, levelCount,
    lessonStatusRows, recentLessons, vocabCount,
  ] = await Promise.all([
    pool.query<{ count: string }>(`SELECT COUNT(*) FROM languages`),
    pool.query<{ count: string }>(`SELECT COUNT(*) FROM curricula`),
    pool.query<{ count: string }>(`SELECT COUNT(*) FROM levels`),
    pool.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*) as count FROM lessons WHERE soft_deleted_at IS NULL GROUP BY status`
    ),
    db.select({
      id: lessonsTable.id,
      title: lessonsTable.title,
      status: lessonsTable.status,
      levelId: lessonsTable.levelId,
      updatedAt: lessonsTable.updatedAt,
    })
      .from(lessonsTable)
      .where(isNull(lessonsTable.softDeletedAt))
      .orderBy(desc(lessonsTable.updatedAt))
      .limit(10),
    pool.query<{ count: string }>(`SELECT COUNT(*) FROM vocabulary WHERE deleted_at IS NULL`),
  ]);

  const statusCounts: Record<string, number> = {};
  for (const row of lessonStatusRows.rows) {
    statusCounts[row.status] = parseInt(row.count, 10);
  }

  res.json({
    languages: parseInt(langCount.rows[0].count, 10),
    curricula: parseInt(curriculaCount.rows[0].count, 10),
    levels: parseInt(levelCount.rows[0].count, 10),
    vocabulary: parseInt(vocabCount.rows[0].count, 10),
    lessons: {
      draft: statusCounts.draft ?? 0,
      in_review: statusCounts.in_review ?? 0,
      approved: statusCounts.approved ?? 0,
      published: statusCounts.published ?? 0,
      archived: statusCounts.archived ?? 0,
      total: Object.values(statusCounts).reduce((a, b) => a + b, 0),
    },
    recentLessons,
  });
});

export default router;
