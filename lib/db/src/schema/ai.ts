import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  integer,
  text,
  real,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Runtime AI configuration.
 *
 * Which provider, which model per task, and how much each plan may use are
 * decisions that change more often than the code, and the commercial split is
 * not settled. They live in the database and are edited from the admin panel,
 * so pricing a new tier or switching models is a row, not a deploy.
 */

/** The kinds of work an AI model is asked to do here. */
export const AI_TASKS = [
  "open_answer",
  "placement_analysis",
  "conversation",
  "feedback",
  "weakness_analysis",
  "transcription",
  /**
   * One pass over a diarized peer-call transcript. Its own task rather than
   * part of `feedback`: the most expensive unit in the product, so it needs its
   * own per-plan allowance and its own off switch.
   */
  "peer_call_analysis",
] as const;

export type AITask = (typeof AI_TASKS)[number];

/** Global switch and budget. Exactly one row, id = 1. */
export const aiSettingsTable = pgTable("ai_settings", {
  id: integer("id").primaryKey().default(1),
  /** Master kill switch — false means no AI call is made, whatever else is set. */
  enabled: boolean("enabled").notNull().default(false),
  /** Soft ceiling in USD per calendar month. Spend past it is refused. */
  monthlyBudgetUsd: real("monthly_budget_usd"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type AiSettings = typeof aiSettingsTable.$inferSelect;

/**
 * An endpoint plus credentials. Every provider worth using speaks the OpenAI
 * chat-completions shape, so one row describes NVIDIA NIM, DeepSeek, Groq or a
 * local server equally.
 */
export const aiProvidersTable = pgTable(
  "ai_providers",
  {
    id: serial("id").primaryKey(),
    label: text("label").notNull(),
    /**
     * chat   — text in, text out
     * speech — audio in, transcript out
     *
     * Separate because they are separate purchases: a chat model cannot hear,
     * and an ASR endpoint cannot reason.
     */
    role: text("role", { enum: ["chat", "speech"] }).notNull().default("chat"),
    baseUrl: text("base_url").notNull(),
    /** AES-256-GCM ciphertext. Never returned by any endpoint. */
    apiKeyEncrypted: text("api_key_encrypted"),
    /** Last four characters, so two keys can be told apart in the UI. */
    apiKeyHint: text("api_key_hint"),
    isActive: boolean("is_active").notNull().default(false),

    /**
     * Price per million tokens, which is how providers quote them. Null means
     * unknown, and an unknown price records a null cost rather than a guess —
     * a fabricated cost is worse than none, because the budget acts on it.
     */
    inputPricePerMtok: real("input_price_per_mtok"),
    outputPricePerMtok: real("output_price_per_mtok"),

    /**
     * Price per minute of audio, for `role = 'speech'`.
     *
     * Transcription is not sold by the token and cannot be costed as if it
     * were: the token fields stay null on a speech provider, so every
     * transcription recorded a null cost and the monthly budget could not see
     * it. That is not a rounding error — multichannel ASR is roughly 90% of
     * what an evaluated peer call costs.
     *
     * Multichannel is billed PER CHANNEL, so a stereo recording costs twice
     * this rate per minute. The adapter reports how many channels it billed
     * rather than leaving the caller to assume.
     */
    pricePerMinute: real("price_per_minute"),

    createdBy: integer("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    // "Which provider is in use" must have a single answer per role.
    oneActivePerRole: uniqueIndex("ai_providers_one_active_per_role")
      .on(table.role)
      .where(sql`${table.isActive}`),
  }),
);

export type AiProvider = typeof aiProvidersTable.$inferSelect;

/**
 * Per-task model choice. Grading a one-line answer and running a ten-minute
 * conversation do not want the same model, or the same temperature.
 */
export const aiTaskSettingsTable = pgTable("ai_task_settings", {
  id: serial("id").primaryKey(),
  task: text("task", { enum: AI_TASKS }).notNull().unique(),
  providerId: integer("provider_id").references(() => aiProvidersTable.id, {
    onDelete: "set null",
  }),
  modelId: text("model_id"),
  temperature: real("temperature").notNull().default(0.2),
  maxTokens: integer("max_tokens").notNull().default(512),
  enabled: boolean("enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type AiTaskSettings = typeof aiTaskSettingsTable.$inferSelect;

/**
 * How much of each task a plan may use per day. Replaces the hardcoded
 * DAILY_LIMITS map, so pricing a new tier is a row rather than a deploy.
 */
export const aiPlanPoliciesTable = pgTable(
  "ai_plan_policies",
  {
    id: serial("id").primaryKey(),
    planCode: text("plan_code").notNull(),
    task: text("task", { enum: AI_TASKS }).notNull(),
    /** Requests per rolling day. 0 = denied, -1 = unlimited. Burst control. */
    dailyLimit: integer("daily_limit").notNull().default(0),
    /**
     * Requests per calendar month — the unit the plans are actually sold in.
     * -1 unlimited, 0 denied, null = fall back to the daily limit alone.
     */
    monthlyLimit: integer("monthly_limit"),
    /**
     * Conversation minutes per calendar month.
     *
     * Conversation cost is driven by duration, not by how many times the model
     * was called, so a request count cannot express "ten minutes per lesson".
     * Only meaningful for duration-based tasks.
     */
    monthlyMinutes: integer("monthly_minutes"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    planTaskUnique: uniqueIndex("ai_plan_policies_plan_code_task_key").on(
      table.planCode,
      table.task,
    ),
  }),
);

export type AiPlanPolicy = typeof aiPlanPoliciesTable.$inferSelect;
