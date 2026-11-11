import {
  pgTable,
  serial,
  integer,
  text,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import { lessonsTable, contentBlocksTable } from "./levels";
import { mediaAssetsTable } from "./cms";

/**
 * The AI conversation tutor (spec sections 4D and 7).
 *
 * A conversation is bounded, on both turns and minutes, and the bounds are
 * enforced by the server rather than requested of the model. Section 7 requires
 * the duration and usage to be limited by configuration; a limit a model is
 * merely asked to respect is not a limit. It is also the most expensive feature
 * in the product, so the cap is the cost control too.
 */
export const conversationSessionsTable = pgTable(
  "conversation_sessions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    lessonId: integer("lesson_id").references(() => lessonsTable.id, {
      onDelete: "cascade",
    }),
    /** The conversation block that started it — its topic and its config. */
    blockId: integer("block_id").references(() => contentBlocksTable.id, {
      onDelete: "set null",
    }),

    status: text("status", { enum: ["active", "completed", "abandoned"] })
      .notNull()
      .default("active"),

    /**
     * Copied from the block's configuration when the session opens, not read
     * live: a curriculum edit mid-conversation must not change the rules a
     * student is already playing by.
     */
    maxTurns: integer("max_turns").notNull().default(20),
    maxMinutes: integer("max_minutes").notNull().default(10),

    /** Student turns taken. The tutor's replies do not count against them. */
    turnCount: integer("turn_count").notNull().default(0),

    /** Target words from the lesson the student actually used. */
    vocabularyUsed: text("vocabulary_used").array().notNull().default([]),

    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /** Written when the session closes: what was covered and how it went. */
    summary: jsonb("summary"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One live conversation per student. Without this a student could open
    // several and spend several times the quota in parallel, each of which
    // passed its own check.
    oneActivePerUser: uniqueIndex("conversation_sessions_one_active_per_user")
      .on(table.userId)
      .where(sql`${table.status} = 'active'`),
    userIdx: index("conversation_sessions_user_idx").on(table.userId, table.startedAt),
    conversationSessionsCapsCheck: check("conversation_sessions_caps_check", sql`(max_turns > 0) AND (max_turns <= 10000) AND (max_minutes > 0) AND (max_minutes <= 1440)`),
    conversationSessionsStatusCheck: check("conversation_sessions_status_check", sql`status = ANY (ARRAY['active'::text, 'completed'::text, 'abandoned'::text])`),
  }),
);

export type ConversationSession = typeof conversationSessionsTable.$inferSelect;

export const conversationTurnsTable = pgTable(
  "conversation_turns",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => conversationSessionsTable.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["student", "tutor"] }).notNull(),
    content: text("content").notNull(),

    /** Set when the student spoke rather than typed. */
    mediaAssetId: integer("media_asset_id").references(() => mediaAssetsTable.id, {
      onDelete: "set null",
    }),
    /** What the recogniser heard, when the turn was spoken. */
    transcript: text("transcript"),

    aiMeta: jsonb("ai_meta"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionIdx: index("conversation_turns_session_idx").on(
      table.sessionId,
      table.createdAt,
    ),
    conversationTurnsRoleCheck: check("conversation_turns_role_check", sql`role = ANY (ARRAY['student'::text, 'tutor'::text])`),
  }),
);

export type ConversationTurn = typeof conversationTurnsTable.$inferSelect;
