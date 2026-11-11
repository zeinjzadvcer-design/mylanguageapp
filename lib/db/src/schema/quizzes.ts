import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  real,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { levelsTable } from "./levels";

/**
 * A quiz is an ordered sequence of content blocks — the same block model
 * lessons use — assembled on a timeline by a teacher.
 *
 * Blocks live in `content_blocks`, which is parented by EITHER `lesson_id` OR
 * `quiz_id` (exactly one, enforced by a CHECK constraint). Sharing the block
 * table means the student renderer, the block editor, and AI assessment all
 * work against one shape instead of two parallel ones.
 */
export const quizzesTable = pgTable("quizzes", {
  id: serial("id").primaryKey(),

  title: text("title").notNull(),
  titleAr: text("title_ar").notNull(),
  description: text("description"),
  descriptionAr: text("description_ar"),
  instructions: text("instructions"),
  instructionsAr: text("instructions_ar"),

  /** Optional placement in the curriculum. A quiz can stand alone. */
  levelId: integer("level_id").references(() => levelsTable.id),

  /**
   * What this quiz is for.
   *
   *   practice          — ordinary quiz, no effect on the student's level
   *   level_evaluation  — the gate at the end of a level (spec section 10).
   *                       Passing it promotes the student to the next level.
   *
   * A level_evaluation MUST carry a levelId, and a level may have at most one
   * published evaluation. Both invariants are enforced in the database.
   */
  kind: text("kind", { enum: ["practice", "level_evaluation"] })
    .notNull()
    .default("practice"),

  /**
   * Hours a student must wait after a failed attempt before retrying.
   * Null = retry immediately. Only meaningful for level_evaluation quizzes,
   * where the point is to send the student back to the curriculum first.
   */
  cooldownHours: integer("cooldown_hours"),

  /** Null = untimed. Otherwise the whole attempt must finish within this. */
  timeLimitSec: integer("time_limit_sec"),
  /** Null = unlimited retries. */
  maxAttempts: integer("max_attempts"),
  passingScore: integer("passing_score").notNull().default(75),
  xpReward: integer("xp_reward").notNull().default(50),
  /** Present blocks in random order (blocks with pinned order stay put). */
  shuffleBlocks: boolean("shuffle_blocks").notNull().default(false),
  /** Show per-question feedback as the student goes, vs. only at the end. */
  revealAnswers: text("reveal_answers").notNull().default("after_submit"),

  /**
   * Same CMS lifecycle as lessons: draft → in_review → approved → published
   * → archived. Student APIs only ever serve 'published'.
   */
  status: text("status").notNull().default("draft"),
  contentVersion: integer("content_version").notNull().default(1),

  tags: text("tags").array(),
  teacherNotes: text("teacher_notes"),

  createdBy: integer("created_by").references(() => usersTable.id),
  softDeletedAt: timestamp("soft_deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => ({
    quizzesStatusIdx: index("quizzes_status_idx").on(t.status),
    quizzesLevelIdx: index("quizzes_level_idx").on(t.levelId),
    quizzesKindIdx: index("quizzes_kind_idx").on(t.kind),
    quizzesOnePublishedEvaluationPerLevel: uniqueIndex("quizzes_one_published_evaluation_per_level").on(t.levelId).where(sql`((kind = 'level_evaluation'::text) AND (status = 'published'::text) AND (soft_deleted_at IS NULL))`),
    quizzesCooldownHoursCheck: check("quizzes_cooldown_hours_check", sql`(cooldown_hours IS NULL) OR (cooldown_hours >= 0)`),
    quizzesEvaluationNeedsLevelCheck: check("quizzes_evaluation_needs_level_check", sql`(kind <> 'level_evaluation'::text) OR (level_id IS NOT NULL)`),
    quizzesKindCheck: check("quizzes_kind_check", sql`kind = ANY (ARRAY['practice'::text, 'level_evaluation'::text])`),
}));
export type Quiz = typeof quizzesTable.$inferSelect;
export type NewQuiz = typeof quizzesTable.$inferInsert;

/**
 * One student's run at a quiz. Created when they start, finalised on submit.
 * Kept separate from lesson progress because a quiz can be retaken and each
 * attempt is scored independently.
 */
export const quizAttemptsTable = pgTable("quiz_attempts", {
  id: serial("id").primaryKey(),
  quizId: integer("quiz_id")
    .notNull()
    .references(() => quizzesTable.id, { onDelete: "cascade" }),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),

  /** Which version of the quiz this attempt saw. */
  contentVersion: integer("content_version").notNull().default(1),
  /** in_progress | submitted | grading | graded | abandoned */
  status: text("status").notNull().default("in_progress"),

  /** 0-100, null until grading finishes. */
  score: real("score"),
  passed: boolean("passed"),
  /** Blocks still waiting on an AI or teacher verdict. */
  pendingReviewCount: integer("pending_review_count").notNull().default(0),

  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  gradedAt: timestamp("graded_at", { withTimezone: true }),
}, (t) => ({
    quizAttemptsUserQuizIdx: index("quiz_attempts_user_quiz_idx").on(t.userId, t.quizId),
    quizAttemptsStatusIdx: index("quiz_attempts_status_idx").on(t.status),
    quizAttemptsOneActiveIdx: uniqueIndex("quiz_attempts_one_active_idx").on(t.userId, t.quizId).where(sql`(status = 'in_progress'::text)`),
}));
export type QuizAttempt = typeof quizAttemptsTable.$inferSelect;

/**
 * One answer to one block within an attempt.
 *
 * `response` is a JSON bag whose shape depends on the block type — selected
 * option ids for MCQ, text for writing, a media_assets key for speaking.
 * Grading is deliberately split: `autoScore` lands immediately for
 * objectively-checkable blocks, while AI/teacher verdicts fill in later.
 */
export const quizResponsesTable = pgTable("quiz_responses", {
  id: serial("id").primaryKey(),
  attemptId: integer("attempt_id")
    .notNull()
    .references(() => quizAttemptsTable.id, { onDelete: "cascade" }),
  blockId: integer("block_id").notNull(),

  response: jsonb("response"),
  /** Uploaded audio/video for speaking blocks — a media_assets key. */
  mediaKey: text("media_key"),
  /** The same upload as a real reference. Preferred over `mediaKey`. */
  mediaAssetId: integer("media_asset_id"),
  /** Speech-to-text output, once transcription completes. */
  transcript: text("transcript"),

  /** 0-100. Null while awaiting assessment. */
  score: real("score"),
  /** auto | ai | teacher | pending */
  gradedBy: text("graded_by").notNull().default("pending"),
  feedback: text("feedback"),
  feedbackAr: text("feedback_ar"),

  /** Provider/model/token accounting for any AI call made on this response. */
  aiMeta: jsonb("ai_meta"),

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

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
}, (t) => ({
    quizResponsesAttemptBlockIdx: uniqueIndex("quiz_responses_attempt_block_idx").on(t.attemptId, t.blockId),
    quizResponsesPendingIdx: index("quiz_responses_pending_idx").on(t.gradedBy).where(sql`(graded_by = 'pending'::text)`),
    quizResponsesMediaAssetIdx: index("quiz_responses_media_asset_idx").on(t.mediaAssetId).where(sql`(media_asset_id IS NOT NULL)`),
    quizResponsesSweepIdx: index("quiz_responses_sweep_idx").on(t.createdAt).where(sql`(graded_by = 'pending'::text)`),
    quizResponsesSpeechScoresCheck: check("quiz_responses_speech_scores_check", sql`((pronunciation_score IS NULL) OR ((pronunciation_score >= (0)::double precision) AND (pronunciation_score <= (100)::double precision))) AND ((fluency_score IS NULL) OR ((fluency_score >= (0)::double precision) AND (fluency_score <= (100)::double precision)))`),
}));
export type QuizResponse = typeof quizResponsesTable.$inferSelect;
