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
  index,
  foreignKey,
  check,
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
    aiProvidersPricesCheck: check("ai_providers_prices_check", sql`((input_price_per_mtok IS NULL) OR (input_price_per_mtok >= (0)::double precision)) AND ((output_price_per_mtok IS NULL) OR (output_price_per_mtok >= (0)::double precision)) AND ((price_per_minute IS NULL) OR (price_per_minute >= (0)::double precision))`),
    aiProvidersRoleCheck: check("ai_providers_role_check", sql`role = ANY (ARRAY['chat'::text, 'speech'::text])`),
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
  /**
   * Administrator-edited instructions. Null means the default in code
   * (api-server services/ai-prompts.ts); only some tasks honour it.
   */
  systemPrompt: text("system_prompt"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => ({
    aiTaskSettingsMaxTokensCheck: check("ai_task_settings_max_tokens_check", sql`(max_tokens > 0) AND (max_tokens <= 32768)`),
    aiTaskSettingsTemperatureCheck: check("ai_task_settings_temperature_check", sql`(temperature >= (0)::double precision) AND (temperature <= (2)::double precision)`),
    aiTaskSettingsTaskCheck: check("ai_task_settings_task_check", sql`task = ANY (ARRAY['open_answer'::text, 'placement_analysis'::text, 'conversation'::text, 'feedback'::text, 'weakness_analysis'::text, 'transcription'::text, 'peer_call_analysis'::text])`),
}));

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
    aiPlanPoliciesDailyLimitCheck: check("ai_plan_policies_daily_limit_check", sql`daily_limit >= '-1'::integer`),
  }),
);

export type AiPlanPolicy = typeof aiPlanPoliciesTable.$inferSelect;

/**
 * One row per AI call: who, which task, tokens and cost. Quotas and the cost
 * figures on the admin screen are counted from here (services/ai-config.ts,
 * which queries it in SQL).
 *
 * Created and changed by the SQL migrations (001, 006, 007, 016), and
 * described here exactly as they left it, names included. DESC indexes say
 * nullsFirst() because that is what a plain DESC in SQL means; Drizzle's
 * .desc() alone means NULLS LAST, a different index. While it was missing
 * from this schema, the schema push could not tell a new table from a rename
 * of this one and stopped to ask; and hiding it from the push instead made its
 * id sequence look like something to drop. Change it with a SQL migration,
 * then match it here, so the push finds nothing to do.
 */
export const aiUsageLogsTable = pgTable(
  "ai_usage_logs",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    feature: text("feature").notNull(),
    modelId: text("model_id"),
    provider: text("provider"),
    tokensUsed: integer("tokens_used").notNull().default(0),
    costUsd: real("cost_usd"),
    succeeded: boolean("succeeded").notNull().default(true),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    task: text("task"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
  },
  (t) => ({
    userFk: foreignKey({
      name: "ai_usage_logs_user_id_fkey",
      columns: [t.userId],
      foreignColumns: [usersTable.id],
    }).onDelete("cascade"),
    createdAtIdx: index("ai_usage_logs_created_at_idx").on(t.createdAt),
    createdIdx: index("ai_usage_logs_created_idx").on(t.createdAt.desc().nullsFirst()),
    taskCreatedIdx: index("ai_usage_logs_task_created_idx").on(t.task, t.createdAt.desc().nullsFirst()),
    userCreatedIdx: index("ai_usage_logs_user_created_idx").on(t.userId, t.createdAt.desc().nullsFirst()),
    userIdIdx: index("ai_usage_logs_user_id_idx").on(t.userId, t.createdAt),
  }),
);

export type AiUsageLog = typeof aiUsageLogsTable.$inferSelect;
