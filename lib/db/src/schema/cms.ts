import { sql } from "drizzle-orm";
/**
 * CMS-specific tables: media assets, audit logs, lesson reviews.
 * These are internal admin tables not exposed to students.
 */

import {
  pgTable,
  text,
  serial,
  integer,
  real,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { lessonsTable } from "./levels";

/**
 * Stores references/metadata for media files.
 * Actual file bytes live in object storage (CDN/S3).
 * This table holds only the key (path/URL) and descriptive metadata.
 */
export const mediaAssetsTable = pgTable("media_assets", {
  id: serial("id").primaryKey(),
  /** Storage key / URL reference. Always generated server-side, never client-supplied. */
  key: text("key").notNull(),
  originalName: text("original_name"),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes"),
  durationSec: real("duration_sec"),
  language: text("language"),
  speaker: text("speaker"),
  accent: text("accent"),
  transcript: text("transcript"),

  /**
   * The student whose recording this is. Null means curriculum material — a
   * reference reading, a listening clip — which any authenticated student may
   * play. A non-null owner may only be played back by that student or by staff
   * grading their work.
   */
  ownerUserId: integer("owner_user_id").references(() => usersTable.id, {
    onDelete: "cascade",
  }),

  /**
   * pending  — presigned, bytes not confirmed in the bucket yet
   * ready    — the object was found at the expected key and passed its checks
   * failed   — confirmation was attempted and the object was missing or invalid
   *
   * Only `ready` assets may be attached to an attempt. A row sitting at
   * `pending` is an upload the browser started and never finished.
   */
  status: text("status", { enum: ["pending", "ready", "failed"] })
    .notNull()
    .default("ready"),

  /** What the upload is for — 'lesson_activity', 'quiz_response', 'curriculum'. */
  purpose: text("purpose").notNull().default("curriculum"),

  uploadedAt: timestamp("uploaded_at", { withTimezone: true }),

  /**
   * Who uploaded it. Set null rather than blocking when that account is
   * deleted — a student's recordings cascade away with them, but an orphaned
   * authorship record must not make the account undeletable.
   */
  createdBy: integer("created_by").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  ownerIdx: index("media_assets_owner_idx").on(table.ownerUserId, table.createdAt),
    mediaAssetsKeyUnique: uniqueIndex("media_assets_key_unique").on(table.key),
    mediaAssetsPendingIdx: index("media_assets_pending_idx").on(table.createdAt).where(sql`(status = 'pending'::text)`),
    mediaAssetsStatusCheck: check("media_assets_status_check", sql`status = ANY (ARRAY['pending'::text, 'ready'::text, 'failed'::text])`),
  }));

export type MediaAsset = typeof mediaAssetsTable.$inferSelect;

/**
 * Append-only audit log for significant CMS actions.
 * Never update or delete rows from this table.
 */
export const cmsAuditLogsTable = pgTable("cms_audit_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  /** Action verb: create | update | publish | unpublish | archive | restore | delete | submit_review | approve | reject | duplicate */
  action: text("action").notNull(),
  /** Content entity type: lesson | content_block | exercise | vocabulary | language | curriculum | level | media */
  contentType: text("content_type").notNull(),
  contentId: integer("content_id"),
  prevStatus: text("prev_status"),
  newStatus: text("new_status"),
  /** Optional JSON bag of additional context (title, level, etc.) */
  meta: jsonb("meta"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
    cmsAuditLogsContentIdx: index("cms_audit_logs_content_idx").on(t.contentType, t.contentId),
    cmsAuditLogsUserIdx: index("cms_audit_logs_user_idx").on(t.userId),
    cmsAuditLogsCreatedIdx: index("cms_audit_logs_created_idx").on(t.createdAt.desc().nullsFirst()),
}));

export type CmsAuditLog = typeof cmsAuditLogsTable.$inferSelect;

/**
 * Records the review decisions made on lessons during the review workflow.
 */
export const lessonReviewsTable = pgTable("lesson_reviews", {
  id: serial("id").primaryKey(),
  lessonId: integer("lesson_id").notNull().references(() => lessonsTable.id, { onDelete: "cascade" }),
  reviewerId: integer("reviewer_id").notNull().references(() => usersTable.id),
  /** approved | rejected */
  decision: text("decision").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
    lessonReviewsLessonIdx: index("lesson_reviews_lesson_idx").on(t.lessonId),
}));

export type LessonReview = typeof lessonReviewsTable.$inferSelect;
