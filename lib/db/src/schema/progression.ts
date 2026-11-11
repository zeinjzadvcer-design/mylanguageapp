import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { levelsTable } from "./levels";
import { curriculaTable } from "./languages";
import { quizAttemptsTable } from "./quizzes";

/**
 * Every change to a student's level, and why it happened.
 *
 * `student_profiles.current_level_id` is the answer to "where is this student
 * now"; this table is the answer to "how did they get there". Nothing writes
 * current_level_id directly — every write goes through
 * `services/progression.ts#setStudentLevel`, which appends a row here in the
 * same transaction. That makes promotion auditable, makes an administrator
 * override (spec section 2) reversible, and gives the weakness engine a
 * timeline to reason over later.
 */
export const levelProgressionsTable = pgTable(
  "level_progressions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    curriculumId: integer("curriculum_id")
      .notNull()
      .references(() => curriculaTable.id),

    /** Null for the very first placement — the student had no level before. */
    fromLevelId: integer("from_level_id").references(() => levelsTable.id),
    toLevelId: integer("to_level_id")
      .notNull()
      .references(() => levelsTable.id),

    /**
     * placement       — the initial placement test assigned this level
     * evaluation      — the student passed the level's evaluation test
     * admin_override  — an administrator moved them by hand
     */
    reason: text("reason", {
      enum: ["placement", "evaluation", "admin_override"],
    }).notNull(),

    /** The evaluation attempt that earned the promotion, when reason = evaluation. */
    quizAttemptId: integer("quiz_attempt_id").references(
      () => quizAttemptsTable.id,
      { onDelete: "set null" },
    ),

    /** The administrator who made the change, when reason = admin_override. */
    decidedByUserId: integer("decided_by_user_id").references(
      () => usersTable.id,
    ),

    /** Free-text justification, required for an override. */
    note: text("note"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userIdx: index("level_progressions_user_idx").on(
      table.userId,
      table.createdAt,
    ),
    levelProgressionsOnePerAttempt: uniqueIndex("level_progressions_one_per_attempt").on(table.quizAttemptId).where(sql`(quiz_attempt_id IS NOT NULL)`),
    levelProgressionsReasonCheck: check("level_progressions_reason_check", sql`reason = ANY (ARRAY['placement'::text, 'evaluation'::text, 'admin_override'::text])`),
  }),
);

export type LevelProgression = typeof levelProgressionsTable.$inferSelect;
export type NewLevelProgression = typeof levelProgressionsTable.$inferInsert;
