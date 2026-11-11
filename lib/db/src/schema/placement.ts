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
  index,
  check,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { levelsTable } from "./levels";
import { curriculaTable } from "./languages";

export const placementQuestionsTable = pgTable("placement_questions", {
  id: serial("id").primaryKey(),
  questionText: text("question_text").notNull(),
  questionTextAr: text("question_text_ar").notNull(),
  type: text("type", { enum: ["mcq", "fill_blank", "written"] }).notNull().default("mcq"),
  /**
   * Which skill this question tests. The whole per-skill breakdown depends on
   * this being right — an untagged question can only contribute to a total.
   */
  skill: text("skill", {
    enum: ["reading", "listening", "vocabulary", "grammar", "comprehension", "writing"],
  })
    .notNull()
    .default("grammar"),
  /** Roughly the level this question sits at. Position in the list is not difficulty. */
  difficulty: text("difficulty", { enum: ["A1", "A2", "B1", "B2", "C1", "C2"] })
    .notNull()
    .default("A1"),
  /** Reading and listening questions share a passage. */
  passage: text("passage"),
  mediaId: integer("media_id"),
  isActive: boolean("is_active").notNull().default(true),
  order: integer("order").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
    placementQuestionsActiveIdx: index("placement_questions_active_idx").on(t.order).where(sql`is_active`),
    placementQuestionsTypeCheck: check("placement_questions_type_check", sql`type = ANY (ARRAY['mcq'::text, 'fill_blank'::text, 'written'::text])`),
    placementQuestionsDifficultyCheck: check("placement_questions_difficulty_check", sql`difficulty = ANY (ARRAY['A1'::text, 'A2'::text, 'B1'::text, 'B2'::text, 'C1'::text, 'C2'::text])`),
    placementQuestionsSkillCheck: check("placement_questions_skill_check", sql`skill = ANY (ARRAY['reading'::text, 'listening'::text, 'vocabulary'::text, 'grammar'::text, 'comprehension'::text, 'writing'::text])`),
}));

export type PlacementQuestion = typeof placementQuestionsTable.$inferSelect;

export const placementOptionsTable = pgTable("placement_options", {
  id: serial("id").primaryKey(),
  questionId: integer("question_id").notNull().references(() => placementQuestionsTable.id, { onDelete: "cascade" }),
  optionId: text("option_id").notNull(), // 'a', 'b', 'c', 'd'
  text: text("text").notNull(),
  textAr: text("text_ar"),
  isCorrect: boolean("is_correct").notNull().default(false),
});

export type PlacementOption = typeof placementOptionsTable.$inferSelect;

export const placementResultsTable = pgTable("placement_results", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  /** Which curriculum was being tested */
  curriculumId: integer("curriculum_id").references(() => curriculaTable.id),
  score: integer("score").notNull(),
  total: integer("total").notNull(),
  percentage: real("percentage").notNull(),
  /** Human-readable level code for historical reference */
  assignedLevelCode: text("assigned_level_code").notNull(),
  /** FK to the actual level record assigned */
  assignedLevelId: integer("assigned_level_id").references(() => levelsTable.id),

  /** One entry per skill tested — what makes strengths and weaknesses possible. */
  skillScores: jsonb("skill_scores"),
  strengths: text("strengths").array(),
  weaknesses: text("weaknesses").array(),
  /** The AI's reading of the result, in Arabic. Null when AI was unavailable. */
  analysisAr: text("analysis_ar"),

  writingSample: text("writing_sample"),
  writingScore: real("writing_score"),

  /**
   * What the arithmetic produced, before any AI adjustment. Kept so an
   * adjustment can be traced and reversed — an assignment nobody can explain is
   * one nobody can defend to a student.
   */
  computedLevelCode: text("computed_level_code"),
  adjustmentReason: text("adjustment_reason"),

  completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
    placementResultsWritingScoreCheck: check("placement_results_writing_score_check", sql`(writing_score IS NULL) OR ((writing_score >= (0)::double precision) AND (writing_score <= (100)::double precision))`),
}));

export type PlacementResult = typeof placementResultsTable.$inferSelect;
