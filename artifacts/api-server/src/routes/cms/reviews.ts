/**
 * CMS Reviews + Audit Log
 */

import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { requirePermission } from "../../middlewares/auth";

const router: IRouter = Router();

// ─── Review queue ──────────────────────────────────────────────────────────

/** Lessons currently in_review — for the review queue page */
router.get("/cms/reviews", requirePermission("content.view"), async (_req, res): Promise<void> => {
  const rows = await pool.query<{
    id: number; title: string; title_ar: string; status: string;
    level_code: string; updated_at: Date;
  }>(
    `SELECT l.id, l.title, l.title_ar, l.status, lv.code AS level_code, l.updated_at
     FROM lessons l
     JOIN levels lv ON lv.id = l.level_id
     WHERE l.status = 'in_review' AND l.soft_deleted_at IS NULL
     ORDER BY l.updated_at ASC`
  );

  type ReviewRow = { lesson_id: number; decision: string; notes: string | null; created_at: Date };
  const lessonIds = rows.rows.map(r => r.id);
  const reviewHistory: ReviewRow[] = lessonIds.length > 0
    ? (await pool.query<ReviewRow>(
        `SELECT lesson_id, decision, notes, created_at FROM lesson_reviews
         WHERE lesson_id = ANY($1) ORDER BY created_at DESC`,
        [lessonIds]
      )).rows
    : [];

  const reviewsByLesson: Record<number, ReviewRow[]> = {};
  for (const r of reviewHistory) {
    if (!reviewsByLesson[r.lesson_id]) reviewsByLesson[r.lesson_id] = [];
    reviewsByLesson[r.lesson_id].push(r);
  }

  res.json(rows.rows.map(r => ({
    id: r.id, title: r.title, titleAr: r.title_ar,
    status: r.status, levelCode: r.level_code, updatedAt: r.updated_at,
    reviews: reviewsByLesson[r.id] ?? [],
  })));
});

/** All review records for a lesson */
router.get("/cms/reviews/lesson/:lessonId", requirePermission("content.view"), async (req, res): Promise<void> => {
  const lessonId = parseInt(req.params.lessonId as string, 10);
  if (isNaN(lessonId)) { res.status(400).json({ error: "Invalid lesson ID" }); return; }

  const rows = await pool.query(
    `SELECT lr.*, u.name AS reviewer_name, u.email AS reviewer_email
     FROM lesson_reviews lr
     JOIN users u ON u.id = lr.reviewer_id
     WHERE lr.lesson_id = $1 ORDER BY lr.created_at DESC`,
    [lessonId]
  );
  res.json(rows.rows);
});

// ─── Audit log ─────────────────────────────────────────────────────────────

router.get("/cms/audit", requirePermission("content.view"), async (req, res): Promise<void> => {
  const page = Math.max(1, parseInt((req.query.page as string) ?? "1", 10));
  const limit = Math.min(200, Math.max(1, parseInt((req.query.limit as string) ?? "50", 10)));
  const offset = (page - 1) * limit;

  const action = req.query.action as string | undefined;
  const contentType = req.query.contentType as string | undefined;
  const userId = req.query.userId ? parseInt(req.query.userId as string, 10) : undefined;

  const conditions: string[] = [];
  const params: unknown[] = [limit, offset];

  if (action) { params.push(action); conditions.push(`a.action = $${params.length}`); }
  if (contentType) { params.push(contentType); conditions.push(`a.content_type = $${params.length}`); }
  if (userId && !isNaN(userId)) { params.push(userId); conditions.push(`a.user_id = $${params.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const [countRes, rows] = await Promise.all([
    pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM cms_audit_logs a ${where}`,
      params.slice(2)
    ),
    pool.query(
      `SELECT a.*, u.name AS user_name, u.email AS user_email
       FROM cms_audit_logs a
       JOIN users u ON u.id = a.user_id
       ${where}
       ORDER BY a.created_at DESC
       LIMIT $1 OFFSET $2`,
      params
    ),
  ]);

  res.json({
    logs: rows.rows,
    total: parseInt(countRes.rows[0].count, 10),
    page, limit,
  });
});

export default router;
