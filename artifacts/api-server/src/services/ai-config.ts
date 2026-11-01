/**
 * Runtime AI configuration: read, write, and keep the credentials safe.
 *
 * Nothing about the AI setup is compiled in. The provider endpoint, the API
 * key, the model for each task and the per-plan limits all live in the database
 * and are edited from the admin panel, because they change more often than the
 * code and the commercial split is not settled yet.
 *
 * API keys are encrypted at rest with AES-256-GCM. They are decrypted only to
 * make a request and are never returned by any endpoint — the panel shows the
 * last four characters so two keys can be told apart, and nothing more.
 */

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import {
  db,
  aiSettingsTable,
  aiProvidersTable,
  aiTaskSettingsTable,
  aiPlanPoliciesTable,
  AI_TASKS,
  type AITask,
  pool,
} from "@workspace/db";
import { logger } from "../lib/logger";

// ─── Encryption ───────────────────────────────────────────────────────────────

/**
 * A key stored in plaintext is a key that leaks with the next database dump, so
 * this refuses to store one at all rather than degrading quietly. Set
 * AI_CONFIG_SECRET to any long random string; the KDF turns it into a key.
 */
export class ConfigSecretMissingError extends Error {
  constructor() {
    super(
      "AI_CONFIG_SECRET is not set, so API keys cannot be stored securely. " +
        "Generate one with: openssl rand -hex 32",
    );
    this.name = "ConfigSecretMissingError";
  }
}

/** Fixed salt: the secret is already high-entropy, and a stored salt would have
 * to live beside the ciphertext anyway. What matters is that the derived key is
 * not the raw env var. */
const KDF_SALT = "ascension.ai-config.v1";

let cachedKey: Buffer | null = null;

function encryptionKey(): Buffer {
  const secret = process.env.AI_CONFIG_SECRET;
  if (!secret || secret.length < 16) throw new ConfigSecretMissingError();
  if (!cachedKey) cachedKey = scryptSync(secret, KDF_SALT, 32);
  return cachedKey;
}

export function isEncryptionAvailable(): boolean {
  const secret = process.env.AI_CONFIG_SECRET;
  return Boolean(secret && secret.length >= 16);
}

/** `v1.<iv>.<authTag>.<ciphertext>`, all base64url. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(stored: string): string {
  const [version, ivB64, tagB64, dataB64] = stored.split(".");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("Stored API key is not in a recognised format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivB64, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** The tail of a key, for recognition in the UI. Never enough to use. */
export function keyHint(apiKey: string): string {
  return apiKey.length <= 4 ? "••••" : `••••${apiKey.slice(-4)}`;
}

/**
 * Compare two secrets without leaking their relative contents through timing.
 * Used to tell "the admin re-sent the same key" from "the admin rotated it".
 */
export function sameSecret(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ─── Resolved configuration ───────────────────────────────────────────────────

export interface ResolvedTaskConfig {
  task: AITask;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  temperature: number;
  maxTokens: number;
  providerLabel: string;
  /** Per million tokens. Null when the price has not been entered. */
  inputPricePerMtok: number | null;
  outputPricePerMtok: number | null;
  /**
   * Per minute of audio, for speech providers. Null on a chat provider, and
   * null on a speech provider whose price has not been entered.
   */
  pricePerMinute: number | null;
}

/**
 * What one call cost, or null when the prices are not known.
 *
 * Null rather than zero on purpose: a call recorded as costing nothing is
 * indistinguishable from a free one, and the monthly budget would happily let
 * an unpriced provider run forever. The panel shows unpriced providers so the
 * gap is visible rather than silent.
 */
export function computeCostUsd(
  config: Pick<ResolvedTaskConfig, "inputPricePerMtok" | "outputPricePerMtok">,
  usage: { promptTokens: number; completionTokens: number },
): number | null {
  const { inputPricePerMtok: inPrice, outputPricePerMtok: outPrice } = config;
  if (inPrice == null && outPrice == null) return null;
  const input = (usage.promptTokens / 1_000_000) * (inPrice ?? 0);
  const output = (usage.completionTokens / 1_000_000) * (outPrice ?? 0);
  return input + output;
}

/**
 * What one transcription cost, or null when the rate is not known.
 *
 * Separate from `computeCostUsd` because speech is a different purchase, sold
 * by the minute rather than the token. Costing it with the token function
 * returned null on every call, which left ASR — roughly 90% of an evaluated
 * peer call — invisible to the monthly budget ceiling.
 *
 * `channels` is not a detail: multichannel transcription is billed per
 * channel, so the stereo recording that gives peer calls exact speaker
 * attribution costs twice the mono rate. Defaults to 1 so a caller that does
 * not know cannot silently halve the bill.
 */
export function computeAudioCostUsd(
  config: Pick<ResolvedTaskConfig, "pricePerMinute">,
  usage: { durationSeconds: number; channels?: number },
): number | null {
  const rate = config.pricePerMinute;
  if (rate == null) return null;
  if (!Number.isFinite(usage.durationSeconds) || usage.durationSeconds <= 0) return 0;
  const channels = Math.max(1, usage.channels ?? 1);
  return (usage.durationSeconds / 60) * rate * channels;
}

/** Why a task cannot run. Each maps to something an admin can go and fix. */
export type AIUnavailableReason =
  | "GLOBALLY_DISABLED"
  | "TASK_DISABLED"
  | "NO_PROVIDER"
  | "NO_MODEL"
  | "NO_API_KEY"
  | "BUDGET_EXCEEDED";

export class AIUnavailableError extends Error {
  readonly reason: AIUnavailableReason;
  constructor(reason: AIUnavailableReason, message: string) {
    super(message);
    this.name = "AIUnavailableError";
    this.reason = reason;
  }
}

/**
 * Configuration is read per call rather than cached at startup.
 *
 * An admin who turns AI off, or swaps a model, expects it to take effect now —
 * not after the next deploy or a cache expiry. These are two indexed reads on a
 * path that is about to make a network call to an LLM taking hundreds of
 * milliseconds, so the cost is not worth optimising away.
 */
export async function resolveTaskConfig(task: AITask): Promise<ResolvedTaskConfig> {
  const [settings] = await db.select().from(aiSettingsTable).limit(1);

  if (!settings?.enabled) {
    throw new AIUnavailableError(
      "GLOBALLY_DISABLED",
      "AI is switched off for this deployment.",
    );
  }

  const [row] = await db
    .select({
      taskSettings: aiTaskSettingsTable,
      provider: aiProvidersTable,
    })
    .from(aiTaskSettingsTable)
    .leftJoin(aiProvidersTable, eq(aiTaskSettingsTable.providerId, aiProvidersTable.id))
    .where(eq(aiTaskSettingsTable.task, task))
    .limit(1);

  if (!row?.taskSettings.enabled) {
    throw new AIUnavailableError("TASK_DISABLED", `The ${task} task is switched off.`);
  }
  if (!row.provider || !row.provider.isActive) {
    throw new AIUnavailableError(
      "NO_PROVIDER",
      `No active provider is configured for the ${task} task.`,
    );
  }
  if (!row.taskSettings.modelId) {
    throw new AIUnavailableError("NO_MODEL", `No model is chosen for the ${task} task.`);
  }
  if (!row.provider.apiKeyEncrypted) {
    throw new AIUnavailableError(
      "NO_API_KEY",
      `No API key is stored for provider "${row.provider.label}".`,
    );
  }

  if (settings.monthlyBudgetUsd != null) {
    const spent = await monthToDateSpendUsd();
    if (spent >= settings.monthlyBudgetUsd) {
      throw new AIUnavailableError(
        "BUDGET_EXCEEDED",
        `This month's AI budget ($${settings.monthlyBudgetUsd}) has been reached.`,
      );
    }
  }

  return {
    task,
    baseUrl: row.provider.baseUrl,
    apiKey: decryptSecret(row.provider.apiKeyEncrypted),
    modelId: row.taskSettings.modelId,
    temperature: row.taskSettings.temperature,
    maxTokens: row.taskSettings.maxTokens,
    providerLabel: row.provider.label,
    inputPricePerMtok: row.provider.inputPricePerMtok,
    outputPricePerMtok: row.provider.outputPricePerMtok,
    pricePerMinute: row.provider.pricePerMinute,
  };
}

/** Spend so far this calendar month, from the usage log. */
export async function monthToDateSpendUsd(): Promise<number> {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);

  try {
    const r = await pool.query<{ total: string | null }>(
      `SELECT COALESCE(SUM(cost_usd), 0)::text AS total
         FROM ai_usage_logs
        WHERE created_at >= $1`,
      [start],
    );
    return parseFloat(r.rows[0]?.total ?? "0");
  } catch (err) {
    // A budget check that cannot read the log must not block teaching. Log it
    // and let the call through — the daily per-plan limits still apply.
    logger.error({ err }, "Failed to read month-to-date AI spend");
    return 0;
  }
}

// ─── Per-plan limits ──────────────────────────────────────────────────────────

/**
 * The daily allowance for one plan on one task.
 *
 * Returns 0 (denied) when no policy row exists. Defaulting to "allowed" would
 * mean a task added later is silently free for everyone, which is exactly the
 * accident the budget ceiling exists to prevent.
 */
export async function getDailyLimit(
  planCode: string | null,
  task: AITask,
): Promise<number> {
  const [policy] = await db
    .select({ dailyLimit: aiPlanPoliciesTable.dailyLimit })
    .from(aiPlanPoliciesTable)
    .where(
      and(
        eq(aiPlanPoliciesTable.planCode, planCode ?? "free"),
        eq(aiPlanPoliciesTable.task, task),
      ),
    )
    .limit(1);

  return policy?.dailyLimit ?? 0;
}

export interface PlanAllowance {
  /** Requests per rolling day. Burst control. */
  daily: number;
  /** Requests per calendar month, or null when only the daily limit applies. */
  monthly: number | null;
  /** Conversation minutes per calendar month, or null when not duration-based. */
  monthlyMinutes: number | null;
}

/**
 * The full allowance for a plan and task.
 *
 * The plans are sold by the month — twelve lessons, eight calls — so the
 * monthly figures are the ones that bound cost. The daily limit remains as
 * anti-abuse burst control, not as the economic cap.
 *
 * Absent policy row means denied, for the same reason as `getDailyLimit`.
 */
export async function getPlanAllowance(
  planCode: string | null,
  task: AITask,
): Promise<PlanAllowance> {
  const [policy] = await db
    .select({
      dailyLimit: aiPlanPoliciesTable.dailyLimit,
      monthlyLimit: aiPlanPoliciesTable.monthlyLimit,
      monthlyMinutes: aiPlanPoliciesTable.monthlyMinutes,
    })
    .from(aiPlanPoliciesTable)
    .where(
      and(
        eq(aiPlanPoliciesTable.planCode, planCode ?? "free"),
        eq(aiPlanPoliciesTable.task, task),
      ),
    )
    .limit(1);

  return {
    daily: policy?.dailyLimit ?? 0,
    monthly: policy?.monthlyLimit ?? null,
    monthlyMinutes: policy?.monthlyMinutes ?? null,
  };
}

// ─── Admin reads ──────────────────────────────────────────────────────────────

/** The whole configuration, with every secret stripped. */
export async function getAdminConfig() {
  const [settings] = await db.select().from(aiSettingsTable).limit(1);

  const providers = await db
    .select({
      id: aiProvidersTable.id,
      label: aiProvidersTable.label,
      role: aiProvidersTable.role,
      baseUrl: aiProvidersTable.baseUrl,
      apiKeyHint: aiProvidersTable.apiKeyHint,
      hasApiKey: sql<boolean>`${aiProvidersTable.apiKeyEncrypted} IS NOT NULL`,
      inputPricePerMtok: aiProvidersTable.inputPricePerMtok,
      outputPricePerMtok: aiProvidersTable.outputPricePerMtok,
      pricePerMinute: aiProvidersTable.pricePerMinute,
      isActive: aiProvidersTable.isActive,
      updatedAt: aiProvidersTable.updatedAt,
    })
    .from(aiProvidersTable)
    .orderBy(aiProvidersTable.role, aiProvidersTable.id);

  const tasks = await db.select().from(aiTaskSettingsTable).orderBy(aiTaskSettingsTable.task);
  const policies = await db
    .select()
    .from(aiPlanPoliciesTable)
    .orderBy(aiPlanPoliciesTable.planCode, aiPlanPoliciesTable.task);

  return {
    settings: {
      enabled: settings?.enabled ?? false,
      monthlyBudgetUsd: settings?.monthlyBudgetUsd ?? null,
      monthToDateSpendUsd: await monthToDateSpendUsd(),
      // Surfaced so the panel can explain why saving a key is refused, rather
      // than showing an opaque error.
      encryptionAvailable: isEncryptionAvailable(),
    },
    providers,
    tasks,
    policies,
    availableTasks: AI_TASKS,
  };
}

/** Recent AI spend and volume, for the panel's usage summary. */
export async function getUsageSummary(days = 30) {
  const since = new Date(Date.now() - days * 86_400_000);
  try {
    const r = await pool.query(
      `SELECT COALESCE(task, feature) AS task,
              COUNT(*)::int                AS calls,
              SUM(CASE WHEN succeeded THEN 0 ELSE 1 END)::int AS failures,
              COALESCE(SUM(tokens_used), 0)::int AS tokens,
              COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd
         FROM ai_usage_logs
        WHERE created_at >= $1
        GROUP BY COALESCE(task, feature)
        ORDER BY cost_usd DESC`,
      [since],
    );
    return r.rows;
  } catch (err) {
    logger.error({ err }, "Failed to read AI usage summary");
    return [];
  }
}

/** Requests this user has made today, per task — for showing remaining quota. */
export async function getTodayUsageByTask(userId: number): Promise<Record<string, number>> {
  const since = new Date(Date.now() - 86_400_000);
  const r = await pool.query<{ task: string; calls: string }>(
    `SELECT COALESCE(task, feature) AS task, COUNT(*) AS calls
       FROM ai_usage_logs
      WHERE user_id = $1 AND created_at >= $2
      GROUP BY COALESCE(task, feature)`,
    [userId, since],
  );
  return Object.fromEntries(r.rows.map((row) => [row.task, parseInt(row.calls, 10)]));
}

/**
 * Spend per student over a window, worst first.
 *
 * This is the number that says whether the quotas actually bind. The per-task
 * summary above shows what the product costs in aggregate; this shows whether
 * any one student is costing more than their subscription brings in. A heavy
 * user above the plan price means the limits are set wrong, not that the model
 * choice is wrong.
 */
export async function getUsageByUser(days = 30, limit = 20) {
  const since = new Date(Date.now() - days * 86_400_000);
  try {
    const r = await pool.query(
      `SELECT l.user_id,
              u.email,
              u.name,
              COALESCE(s.plan_code, 'free')        AS plan_code,
              COUNT(*)::int                        AS calls,
              COALESCE(SUM(l.cost_usd), 0)::float8 AS cost_usd,
              COALESCE(SUM(l.tokens_used), 0)::int AS tokens
         FROM ai_usage_logs l
         LEFT JOIN users u ON u.id = l.user_id
         LEFT JOIN LATERAL (
           SELECT plan_code FROM student_subscriptions
            WHERE user_id = l.user_id AND status = 'active'
            ORDER BY started_at DESC LIMIT 1
         ) s ON true
        WHERE l.created_at >= $1
        GROUP BY l.user_id, u.email, u.name, s.plan_code
        ORDER BY cost_usd DESC
        LIMIT $2`,
      [since, limit],
    );
    return r.rows;
  } catch (err) {
    logger.error({ err }, "Failed to read AI usage by user");
    return [];
  }
}

/**
 * Headline numbers for the window: total spend, and the average and worst spend
 * per active student. The average is what the cost model predicted; the worst
 * is what an unbounded quota looks like.
 */
export async function getUsageTotals(days = 30) {
  const since = new Date(Date.now() - days * 86_400_000);
  try {
    const r = await pool.query(
      `SELECT COALESCE(SUM(cost_usd), 0)::float8              AS total_cost_usd,
              COUNT(*)::int                                   AS calls,
              COALESCE(SUM(CASE WHEN succeeded THEN 0 ELSE 1 END), 0)::int AS failures,
              COUNT(DISTINCT user_id)::int                    AS active_users
         FROM ai_usage_logs
        WHERE created_at >= $1`,
      [since],
    );
    const perUser = await pool.query(
      `SELECT COALESCE(AVG(c), 0)::float8 AS avg_cost_usd,
              COALESCE(MAX(c), 0)::float8 AS max_cost_usd
         FROM (SELECT user_id, SUM(cost_usd) AS c
                 FROM ai_usage_logs
                WHERE created_at >= $1
                GROUP BY user_id) t`,
      [since],
    );
    return { ...r.rows[0], ...perUser.rows[0] };
  } catch (err) {
    logger.error({ err }, "Failed to read AI usage totals");
    return {
      total_cost_usd: 0, calls: 0, failures: 0,
      active_users: 0, avg_cost_usd: 0, max_cost_usd: 0,
    };
  }
}
