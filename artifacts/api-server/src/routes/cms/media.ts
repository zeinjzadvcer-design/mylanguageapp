/**
 * CMS Media Asset Registry
 *
 * Stores metadata references only. Actual files must be uploaded
 * to object storage (CDN/S3) separately. This endpoint records the key
 * and metadata so content creators can attach audio/images to lessons.
 */

import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { requirePermission } from "../../middlewares/auth";
import { isRegistrableCurriculumKey } from "../../services/storage";

const router: IRouter = Router();

/**
 * Curriculum material only. Student recordings, payment receipts and the
 * payment QR codes live in the same table, but they are not the CMS's to list,
 * register or delete: listing them showed content staff every receipt's key and
 * owner, and deleting one could remove the QR students pay with.
 */
const CURRICULUM = `owner_user_id IS NULL AND purpose = 'curriculum'`;

router.get("/cms/media", requirePermission("content.view"), async (req, res): Promise<void> => {
  const page = Math.max(1, parseInt((req.query.page as string) ?? "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) ?? "30", 10)));
  const offset = (page - 1) * limit;
  const mimeType = req.query.mimeType as string | undefined;

  const params: unknown[] = [limit, offset];
  const where = mimeType ? `WHERE ${CURRICULUM} AND mime_type ILIKE $3` : `WHERE ${CURRICULUM}`;
  if (mimeType) params.push(`${mimeType}%`);

  const [countRes, rows] = await Promise.all([
    pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM media_assets WHERE ${CURRICULUM}${mimeType ? " AND mime_type ILIKE $1" : ""}`,
      mimeType ? [`${mimeType}%`] : []
    ),
    pool.query(
      `SELECT * FROM media_assets ${where} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      params
    ),
  ]);

  res.json({
    // Mapped to camelCase explicitly. This is a raw pool query, not Drizzle, so
    // `SELECT *` hands back the column names as they are in Postgres —
    // `mime_type`, `original_name`. Every client reads camelCase, so the media
    // picker was filtering on `mimeType` and finding it undefined on every row:
    // the library looked empty even with files in it, and the existing audio
    // pickers were listing nothing either.
    items: rows.rows.map((r) => ({
      id: r.id,
      key: r.key,
      originalName: r.original_name,
      mimeType: r.mime_type,
      sizeBytes: r.size_bytes,
      durationSec: r.duration_sec,
      language: r.language,
      speaker: r.speaker,
      accent: r.accent,
      transcript: r.transcript,
      status: r.status,
      purpose: r.purpose,
      ownerUserId: r.owner_user_id,
      createdBy: r.created_by,
      createdAt: r.created_at,
      uploadedAt: r.uploaded_at,
    })),
    total: parseInt(countRes.rows[0].count, 10),
    page, limit,
  });
});

router.post("/cms/media", requirePermission("content.edit"), async (req, res): Promise<void> => {
  const { key, originalName, mimeType, sizeBytes, durationSec,
    language, speaker, accent, transcript } = req.body;

  if (!key || !mimeType) {
    res.status(400).json({ error: "key and mimeType are required" }); return;
  }

  // Validate MIME type: only audio, image, video allowed
  if (!/^(audio|image|video)\//.test(mimeType)) {
    res.status(400).json({ error: "Only audio, image, and video MIME types are allowed" }); return;
  }

  // A registered row has no owner, so anyone signed in can play it. Pointing
  // one at a student's recording or receipt would publish it.
  if (typeof key !== "string" || !isRegistrableCurriculumKey(key)) {
    res.status(400).json({
      error: "That key cannot be registered. Use a plain path outside the recordings/ and payments/ folders.",
      code: "INVALID_KEY",
    });
    return;
  }
  const taken = await pool.query(`SELECT 1 FROM media_assets WHERE key = $1 LIMIT 1`, [key]);
  if (taken.rowCount) {
    res.status(409).json({ error: "That key is already registered.", code: "KEY_TAKEN" });
    return;
  }

  const result = await pool.query<{ id: number }>(
    `INSERT INTO media_assets (key, original_name, mime_type, size_bytes, duration_sec, language, speaker, accent, transcript, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [key, originalName ?? null, mimeType, sizeBytes ?? null, durationSec ?? null,
     language ?? null, speaker ?? null, accent ?? null, transcript ?? null,
     req.session.userId]
  );

  res.status(201).json({ id: result.rows[0].id, key, mimeType });
});

router.delete("/cms/media/:id", requirePermission("content.edit"), async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  const result = await pool.query(`DELETE FROM media_assets WHERE id = $1 AND ${CURRICULUM}`, [id]);
  if (!result.rowCount) { res.status(404).json({ error: "Media not found" }); return; }
  res.json({ deleted: true });
});

export default router;
