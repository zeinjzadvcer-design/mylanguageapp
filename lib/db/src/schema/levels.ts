import { pgTable, text, serial, integer, boolean, timestamp, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { curriculaTable } from "./languages";
import { usersTable } from "./users";

export const levelsTable = pgTable("levels", {
  id: serial("id").primaryKey(),
  curriculumId: integer("curriculum_id")
    .notNull()
    .references(() => curriculaTable.id),
  code: text("code").notNull(),
  name: text("name").notNull(),
  nameAr: text("name_ar").notNull(),
  description: text("description"),
  descriptionAr: text("description_ar"),
  order: integer("order").notNull(),
  totalLessons: integer("total_lessons").notNull().default(0),

  /**
   * How much of this level a student must finish before its evaluation test
   * unlocks, as a percentage of the level's published lessons (spec section 10:
   * "after completing the required lessons"). 100 = every lesson must be passed.
   * Administrator-configurable per level.
   */
  evaluationUnlockPercent: integer("evaluation_unlock_percent").notNull().default(100),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  curriculumCodeUnique: uniqueIndex("levels_curriculum_code_unique").on(
    table.curriculumId,
    table.code,
  ),
}));

export type Level = typeof levelsTable.$inferSelect;

/**
 * Lesson status lifecycle:
 *   draft → in_review → approved → published → archived
 * Admins can also directly draft/unpublish/archive without the review step.
 */
export const lessonsTable = pgTable("lessons", {
  id: serial("id").primaryKey(),
  levelId: integer("level_id").notNull().references(() => levelsTable.id),
  title: text("title").notNull(),
  titleAr: text("title_ar").notNull(),
  subtitle: text("subtitle"),
  subtitleAr: text("subtitle_ar"),
  description: text("description"),
  descriptionAr: text("description_ar"),
  order: integer("order").notNull(),
  lessonType: text("lesson_type").notNull().default("general"),
  estimatedMinutes: integer("estimated_minutes").notNull().default(35),
  /** Legacy field — kept in sync with status='published' for backward compatibility */
  isPublished: boolean("is_published").notNull().default(false),
  /**
   * CMS lifecycle status.
   * Student APIs only serve lessons where status = 'published'.
   */
  status: text("status").notNull().default("draft"),
  /** Incremented each time published content is edited. Lets student records stay linked to the version they experienced. */
  contentVersion: integer("content_version").notNull().default(1),
  xpReward: integer("xp_reward").notNull().default(50),
  passingScore: integer("passing_score").notNull().default(75),
  difficulty: text("difficulty").default("intermediate"),
  tags: text("tags").array(),
  objectives: text("objectives").array(),
  objectivesAr: text("objectives_ar").array(),
  teacherNotes: text("teacher_notes"),
  /** FK to the user who created this lesson. Null for legacy seeded content. */
  createdBy: integer("created_by").references(() => usersTable.id),
  /** Soft-delete timestamp. Non-null = soft-deleted. */
  softDeletedAt: timestamp("soft_deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type Lesson = typeof lessonsTable.$inferSelect;

/**
 * Content blocks are the building blocks of a lesson.
 * Block types are stored as plain text so new block types can be added
 * by inserting rows — no schema change needed.
 */
export const contentBlocksTable = pgTable("content_blocks", {
  id: serial("id").primaryKey(),
  /**
   * A block belongs to EITHER a lesson OR a quiz — exactly one of these is
   * set, enforced by the content_blocks_parent_ck CHECK constraint.
   * quizId is untyped here to avoid a circular import with ./quizzes.
   */
  lessonId: integer("lesson_id").references(() => lessonsTable.id, { onDelete: "cascade" }),
  quizId: integer("quiz_id"),
  type: text("type").notNull(),
  order: integer("order").notNull(),
  title: text("title"),
  titleAr: text("title_ar"),
  /** Student-facing instructions for this block */
  instructions: text("instructions"),
  instructionsAr: text("instructions_ar"),
  /** Primary text content (reading, explanation, etc.) */
  content: text("content"),
  contentAr: text("content_ar"),
  audioNote: text("audio_note"),
  prompt: text("prompt"),
  promptAr: text("prompt_ar"),
  exampleAudio: text("example_audio"),
  /** Uploaded reference recording for this block, when there is one. */
  referenceMediaId: integer("reference_media_id"),
  /**
   * Optional illustration media, on any block type. Distinct from
   * `referenceMediaId`, which is the model pronunciation a read-aloud block is
   * scored against — these two carry no grading meaning at all. Either, both or
   * neither may be set; the student is shown whatever is there.
   */
  imageMediaId: integer("image_media_id"),
  audioMediaId: integer("audio_media_id"),
  /**
   * The storage key beside each id, the way `audioNote` pairs with
   * `referenceMediaId`. The id is resolved to a signed URL for the student; the
   * key is what the CMS picker shows the author and matches in the library.
   */
  imageMediaKey: text("image_media_key"),
  audioMediaKey: text("audio_media_key"),
  /**
   * True when the student is reading a set passage, so pronunciation can be
   * measured against `content`. False for open speaking, where only fluency
   * can be measured — there is nothing to align a transcript to.
   */
  expectsReferenceReading: boolean("expects_reference_reading").notNull().default(false),
  /** Whether this block must be completed for lesson progression */
  isRequired: boolean("is_required").notNull().default(true),
  /** Estimated time for this block in minutes */
  estimatedMinutes: integer("estimated_minutes"),
  isActive: boolean("is_active").notNull().default(true),
  /** Flexible block-type-specific configuration */
  config: jsonb("config"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
});

export type ContentBlock = typeof contentBlocksTable.$inferSelect;

export const exercisesTable = pgTable("exercises", {
  id: serial("id").primaryKey(),
  lessonId: integer("lesson_id").notNull().references(() => lessonsTable.id, { onDelete: "cascade" }),
  contentBlockId: integer("content_block_id"),
  /**
   * Exercise type: mcq | speaking | pronunciation | open_ended | fill_blank | translation
   * Stored as plain text so new types can be added without schema changes.
   */
  exerciseType: text("exercise_type").notNull().default("mcq"),
  question: text("question").notNull(),
  questionAr: text("question_ar"),
  /** For MCQ: the ID of the correct option */
  correctOptionId: text("correct_option_id").notNull().default(""),
  explanation: text("explanation"),
  explanationAr: text("explanation_ar"),
  /** For speaking/pronunciation: the spoken prompt */
  prompt: text("prompt"),
  promptAr: text("prompt_ar"),
  /** Custom instructions beyond the default */
  instructionsText: text("instructions_text"),
  instructionsAr: text("instructions_ar"),
  /** Model answer for open-ended or speaking exercises */
  modelAnswer: text("model_answer"),
  modelAnswerAr: text("model_answer_ar"),
  /** Comma-separated key concepts the AI/reviewer expects in the response */
  expectedConcepts: text("expected_concepts"),
  difficulty: text("difficulty"),
  points: integer("points").default(10),
  ordering: integer("ordering").default(0),
  audioUrl: text("audio_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
});

export type Exercise = typeof exercisesTable.$inferSelect;

export const exerciseOptionsTable = pgTable("exercise_options", {
  id: serial("id").primaryKey(),
  exerciseId: integer("exercise_id").notNull().references(() => exercisesTable.id, { onDelete: "cascade" }),
  optionId: text("option_id").notNull(),
  text: text("text").notNull(),
  textAr: text("text_ar"),
});

export type ExerciseOption = typeof exerciseOptionsTable.$inferSelect;

export const vocabularyTable = pgTable("vocabulary", {
  id: serial("id").primaryKey(),
  levelId: integer("level_id").notNull().references(() => levelsTable.id),
  lessonId: integer("lesson_id").references(() => lessonsTable.id),
  word: text("word").notNull(),
  translation: text("translation").notNull(),
  definition: text("definition"),
  partOfSpeech: text("part_of_speech"),
  exampleSentence: text("example_sentence"),
  exampleSentenceAr: text("example_sentence_ar"),
  pronunciation: text("pronunciation"),
  audioNote: text("audio_note"),
  difficulty: text("difficulty"),
  tags: text("tags").array(),
  /** Soft-delete timestamp */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
});

export type Vocabulary = typeof vocabularyTable.$inferSelect;
