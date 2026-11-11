import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  real,
  jsonb,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { lessonsTable, contentBlocksTable, exercisesTable } from "./levels";

export const lessonProgressTable = pgTable("lesson_progress", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  lessonId: integer("lesson_id").notNull().references(() => lessonsTable.id, { onDelete: "cascade" }),
  /** Pinned content version this progress record refers to */
  contentVersion: integer("content_version").notNull().default(1),
  status: text("status", {
    enum: ["not_started", "in_progress", "completed", "passed", "failed"],
  }).notNull().default("not_started"),
  bestScore: real("best_score"),
  lastScore: real("last_score"),
  speakingScore: real("speaking_score"),
  attempts: integer("attempts").notNull().default(0),
  passed: boolean("passed").notNull().default(false),
  xpEarned: integer("xp_earned").notNull().default(0),
  timeSpentSeconds: integer("time_spent_seconds").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  userLessonUnique: uniqueIndex("lesson_progress_user_lesson_unique").on(table.userId, table.lessonId),
  userIdIdx: index("lesson_progress_user_id_idx").on(table.userId),
    lessonProgressUserStartedIdx: index("lesson_progress_user_started_idx").on(table.userId, table.startedAt).where(sql`(started_at IS NOT NULL)`),
  }));

export type LessonProgress = typeof lessonProgressTable.$inferSelect;

export const exerciseAttemptsTable = pgTable("exercise_attempts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  exerciseId: integer("exercise_id").notNull(),
  selectedOptionId: text("selected_option_id").notNull(),
  correct: boolean("correct").notNull(),
  attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ExerciseAttempt = typeof exerciseAttemptsTable.$inferSelect;

/**
 * Server-authoritative per-block completion record.
 * Unique per user + lesson + block + contentVersion so that
 * revisits on a newer content version start fresh.
 */
export const lessonBlockProgressTable = pgTable("lesson_block_progress", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  lessonId: integer("lesson_id").notNull().references(() => lessonsTable.id, { onDelete: "cascade" }),
  blockId: integer("block_id").notNull().references(() => contentBlocksTable.id, { onDelete: "cascade" }),
  contentVersion: integer("content_version").notNull().default(1),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  userLessonBlockVersionUnique: uniqueIndex("lbp_user_lesson_block_version_unique").on(
    table.userId, table.lessonId, table.blockId, table.contentVersion,
  ),
  userLessonIdx: index("lbp_user_lesson_idx").on(table.userId, table.lessonId),
}));

export type LessonBlockProgress = typeof lessonBlockProgressTable.$inferSelect;

/**
 * Detailed activity attempt log for learning analytics and server-side grading.
 */
export const learningActivityAttemptsTable = pgTable("learning_activity_attempts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  lessonId: integer("lesson_id").notNull().references(() => lessonsTable.id, { onDelete: "cascade" }),
  blockId: integer("block_id").notNull().references(() => contentBlocksTable.id, { onDelete: "cascade" }),
  /** Nullable — passive/reading blocks have no exercise */
  exerciseId: integer("exercise_id").references(() => exercisesTable.id, { onDelete: "set null" }),
  contentVersion: integer("content_version").notNull().default(1),
  /**
   * Activity type: mcq | speaking | pronunciation | open_ended |
   *                fill_blank | translation | passive
   */
  activityType: text("activity_type").notNull(),
  /**
   * Client-generated idempotency key — unique per user so duplicate
   * submissions return the original attempt unchanged.
   */
  clientSubmissionId: text("client_submission_id").notNull(),
  /** For MCQ */
  selectedOptionId: text("selected_option_id"),
  /** For open-ended / fill-blank / translation */
  responseText: text("response_text"),
  /** Storage key for recorded media (speaking / pronunciation) */
  mediaReference: text("media_reference"),
  /**
   * The uploaded recording for this attempt. Preferred over `mediaReference`,
   * which predates real uploads and holds whatever string a client sent.
   */
  mediaAssetId: integer("media_asset_id"),
  /** Duration of audio recording in seconds */
  recordingDurationSeconds: integer("recording_duration_seconds"),
  /** Server-graded correctness (null for pending / non-gradable) */
  isCorrect: boolean("is_correct"),
  /** Weighted score 0–100 or null */
  score: real("score"),
  /**
   * Evaluation status:
   *   graded   — server has a final result
   *   pending  — awaiting async AI evaluation
   *   skipped  — not evaluated (passive block)
   */
  evaluationStatus: text("evaluation_status", {
    enum: ["graded", "pending", "skipped"],
  }).notNull().default("graded"),
  /** Arbitrary metadata (client timing, retries, etc.) */
  /** Feedback from an AI or a teacher, in the target and learner languages. */
  feedback: text("feedback"),
  feedbackAr: text("feedback_ar"),
  /** auto | ai | teacher | pending — who decided the score above. */
  gradedBy: text("graded_by", { enum: ["auto", "ai", "teacher", "pending"] })
    .notNull()
    .default("auto"),
  /** Provider/model/token accounting for any AI call made on this attempt. */
  aiMeta: jsonb("ai_meta"),

  /** What the speech recogniser heard — the evidence behind a speaking score. */
  transcript: text("transcript"),
  /** 0-100, from aligning the transcript against the passage. Null when open speaking. */
  pronunciationScore: real("pronunciation_score"),
  /** 0-100, from the word timings. */
  fluencyScore: real("fluency_score"),
  /** Rate, pauses, run length, and the word-by-word alignment. */
  speechMetrics: jsonb("speech_metrics"),

  /** How many times grading has been tried. Caps the sweeper's retries. */
  gradingAttempts: integer("grading_attempts").notNull().default(0),
  lastGradingError: text("last_grading_error"),
  lastGradedAt: timestamp("last_graded_at", { withTimezone: true }),
  /** Which member of staff marked it, when a human did. */
  gradedByUserId: integer("graded_by_user_id").references(() => usersTable.id, {
    onDelete: "set null",
  }),

  metadata: jsonb("metadata"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  userClientSubmissionIdUnique: uniqueIndex("laa_user_client_submission_id_unique").on(
    table.userId, table.clientSubmissionId,
  ),
  userLessonIdx: index("laa_user_lesson_idx").on(table.userId, table.lessonId),
  userBlockIdx: index("laa_user_block_idx").on(table.userId, table.blockId),
    laaMediaAssetIdx: index("laa_media_asset_idx").on(table.mediaAssetId).where(sql`(media_asset_id IS NOT NULL)`),
    laaPendingIdx: index("laa_pending_idx").on(table.submittedAt).where(sql`(evaluation_status = 'pending'::text)`),
    laaSweepIdx: index("laa_sweep_idx").on(table.submittedAt).where(sql`(evaluation_status = 'pending'::text)`),
    laaGradedByCheck: check("laa_graded_by_check", sql`graded_by = ANY (ARRAY['auto'::text, 'ai'::text, 'teacher'::text, 'pending'::text])`),
    laaSpeechScoresCheck: check("laa_speech_scores_check", sql`((pronunciation_score IS NULL) OR ((pronunciation_score >= (0)::double precision) AND (pronunciation_score <= (100)::double precision))) AND ((fluency_score IS NULL) OR ((fluency_score >= (0)::double precision) AND (fluency_score <= (100)::double precision)))`),
  }));

export type LearningActivityAttempt = typeof learningActivityAttemptsTable.$inferSelect;
