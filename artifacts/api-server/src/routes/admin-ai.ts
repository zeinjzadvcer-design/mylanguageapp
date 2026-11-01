/**
 * AI configuration panel, admin only.
 *
 * Everything about the AI setup is editable here at runtime: which endpoint,
 * which key, which model per task, and how much each plan may use. Nothing is
 * compiled in, so switching provider or pricing a new tier needs no deploy.
 *
 * API keys go in and never come out. A stored key is returned only as a
 * last-four hint; there is no endpoint that reveals one, because an admin
 * session should not be enough to exfiltrate the credential.
 */

import { Router, type IRouter } from "express";
import { z } from "zod";
import { eq, and, ne } from "drizzle-orm";
import {
  db,
  aiSettingsTable,
  aiProvidersTable,
  aiTaskSettingsTable,
  aiPlanPoliciesTable,
  AI_TASKS,
  type AITask,
} from "@workspace/db";
import { requireAdmin } from "../middlewares/auth";
import {
  getAdminConfig,
  getUsageSummary,
  getUsageTotals,
  getUsageByUser,
  encryptSecret,
  decryptSecret,
  keyHint,
  isEncryptionAvailable,
  ConfigSecretMissingError,
} from "../services/ai-config";
import {
  listModels,
  testConnection,
  AIProviderError,
} from "../services/ai-providers/openai-compatible";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const isTask = (v: unknown): v is AITask =>
  typeof v === "string" && (AI_TASKS as readonly string[]).includes(v);

function handleError(err: unknown, res: import("express").Response): void {
  if (err instanceof ConfigSecretMissingError) {
    // 503, not 500: the request is fine, the deployment is missing a secret.
    res.status(503).json({ error: err.message, code: "NO_CONFIG_SECRET" });
    return;
  }
  if (err instanceof AIProviderError) {
    // 502: we reached (or failed to reach) an upstream, and it is upstream's
    // answer being reported — not a fault in this request.
    res.status(502).json({
      error: err.message,
      code: "PROVIDER_ERROR",
      providerStatus: err.status,
      retryable: err.retryable,
    });
    return;
  }
  throw err;
}

/**
 * Load a provider and its decrypted key.
 * The key never leaves this module — it goes straight into an upstream call.
 */
type LoadedProvider =
  | { ok: true; provider: typeof aiProvidersTable.$inferSelect; apiKey: string }
  | { ok: false; error: string; status: number };

async function loadProviderWithKey(id: number): Promise<LoadedProvider> {
  const [provider] = await db
    .select()
    .from(aiProvidersTable)
    .where(eq(aiProvidersTable.id, id))
    .limit(1);

  if (!provider) return { ok: false, error: "Provider not found", status: 404 };
  if (!provider.apiKeyEncrypted) {
    return { ok: false, error: "This provider has no API key stored", status: 400 };
  }
  return { ok: true, provider, apiKey: decryptSecret(provider.apiKeyEncrypted) };
}

// ─── Read ─────────────────────────────────────────────────────────────────────

router.get("/admin/ai/config", requireAdmin, async (_req, res): Promise<void> => {
  res.json(await getAdminConfig());
});

router.get("/admin/ai/usage", requireAdmin, async (req, res): Promise<void> => {
  const days = Math.min(365, Math.max(1, parseInt((req.query.days as string) ?? "30", 10)));
  // Three views of the same window: what each task costs, what the whole
  // product costs, and which students cost the most. The last is what says
  // whether the per-plan limits are actually binding.
  const [rows, totals, byUser] = await Promise.all([
    getUsageSummary(days),
    getUsageTotals(days),
    getUsageByUser(days, 20),
  ]);
  res.json({ days, rows, totals, byUser });
});

// ─── Global settings ──────────────────────────────────────────────────────────

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  monthlyBudgetUsd: z.number().min(0).nullable().optional(),
});

router.patch("/admin/ai/settings", requireAdmin, async (req, res): Promise<void> => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.errors });
    return;
  }

  // Turning AI on without a way to store credentials would fail at the first
  // real call; refuse here where the message can be acted on.
  if (parsed.data.enabled === true && !isEncryptionAvailable()) {
    res.status(503).json({
      error:
        "AI_CONFIG_SECRET is not set, so API keys cannot be stored. Set it before enabling AI.",
      code: "NO_CONFIG_SECRET",
    });
    return;
  }

  const [updated] = await db
    .update(aiSettingsTable)
    .set(parsed.data)
    .where(eq(aiSettingsTable.id, 1))
    .returning();

  logger.info({ by: req.session.userId, ...parsed.data }, "AI settings changed");
  res.json(updated);
});

// ─── Providers ────────────────────────────────────────────────────────────────

const providerCreateSchema = z.object({
  label: z.string().min(1).max(80),
  role: z.enum(["chat", "speech"]).default("chat"),
  baseUrl: z.string().url(),
  apiKey: z.string().min(8).optional(),
  isActive: z.boolean().optional(),
  /** Per million tokens. Null clears a price back to "unknown". */
  inputPricePerMtok: z.number().min(0).nullable().optional(),
  outputPricePerMtok: z.number().min(0).nullable().optional(),
  /**
   * Per minute of audio, for a speech provider — transcription is not sold by
   * the token. Null clears it back to "unknown", and an unknown price records
   * a null cost rather than a guessed one.
   */
  pricePerMinute: z.number().min(0).nullable().optional(),
});

const providerUpdateSchema = providerCreateSchema.partial();

/**
 * Make one provider the active one for its role.
 *
 * A partial unique index enforces at most one active per role, so the previous
 * holder has to be stood down in the same transaction — otherwise the insert
 * fails on a constraint the admin never sees.
 */
async function activate(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  id: number,
  role: string,
): Promise<void> {
  await tx
    .update(aiProvidersTable)
    .set({ isActive: false })
    .where(and(eq(aiProvidersTable.role, role as "chat" | "speech"), ne(aiProvidersTable.id, id)));
  await tx
    .update(aiProvidersTable)
    .set({ isActive: true })
    .where(eq(aiProvidersTable.id, id));
}

router.post("/admin/ai/providers", requireAdmin, async (req, res): Promise<void> => {
  const parsed = providerCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.errors });
    return;
  }
  const {
    label,
    role,
    baseUrl,
    apiKey,
    isActive,
    inputPricePerMtok,
    outputPricePerMtok,
    pricePerMinute,
  } = parsed.data;

  try {
    const created = await db.transaction(async (tx) => {
      const [provider] = await tx
        .insert(aiProvidersTable)
        .values({
          label,
          role,
          baseUrl,
          apiKeyEncrypted: apiKey ? encryptSecret(apiKey) : null,
          apiKeyHint: apiKey ? keyHint(apiKey) : null,
          inputPricePerMtok: inputPricePerMtok ?? null,
          outputPricePerMtok: outputPricePerMtok ?? null,
          pricePerMinute: pricePerMinute ?? null,
          createdBy: req.session.userId!,
        })
        .returning();

      if (isActive) await activate(tx, provider.id, role);
      return provider;
    });

    logger.info({ by: req.session.userId, providerId: created.id, role }, "AI provider created");
    res.status(201).json({
      id: created.id,
      label: created.label,
      role: created.role,
      baseUrl: created.baseUrl,
      apiKeyHint: created.apiKeyHint,
      hasApiKey: Boolean(created.apiKeyEncrypted),
      inputPricePerMtok: created.inputPricePerMtok,
      outputPricePerMtok: created.outputPricePerMtok,
      pricePerMinute: created.pricePerMinute,
      isActive: isActive ?? false,
    });
  } catch (err) {
    handleError(err, res);
  }
});

router.patch("/admin/ai/providers/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid provider ID" });
    return;
  }

  const parsed = providerUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.errors });
    return;
  }

  const [existing] = await db
    .select()
    .from(aiProvidersTable)
    .where(eq(aiProvidersTable.id, id))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Provider not found" });
    return;
  }

  const {
    label,
    baseUrl,
    apiKey,
    isActive,
    role,
    inputPricePerMtok,
    outputPricePerMtok,
    pricePerMinute,
  } =
    parsed.data;
  const patch: Record<string, unknown> = {};
  if (label !== undefined) patch.label = label;
  if (baseUrl !== undefined) patch.baseUrl = baseUrl;
  if (role !== undefined) patch.role = role;
  if (inputPricePerMtok !== undefined) patch.inputPricePerMtok = inputPricePerMtok;
  if (outputPricePerMtok !== undefined) patch.outputPricePerMtok = outputPricePerMtok;
  if (pricePerMinute !== undefined) patch.pricePerMinute = pricePerMinute;

  // An absent apiKey means "leave the stored one alone" — the panel cannot
  // send back a key it was never given, so absence must not clear it.
  if (apiKey !== undefined) {
    try {
      patch.apiKeyEncrypted = encryptSecret(apiKey);
      patch.apiKeyHint = keyHint(apiKey);
    } catch (err) {
      handleError(err, res);
      return;
    }
  }

  try {
    const updated = await db.transaction(async (tx) => {
      if (Object.keys(patch).length > 0) {
        await tx.update(aiProvidersTable).set(patch).where(eq(aiProvidersTable.id, id));
      }
      if (isActive === true) {
        await activate(tx, id, (role ?? existing.role) as string);
      } else if (isActive === false) {
        await tx
          .update(aiProvidersTable)
          .set({ isActive: false })
          .where(eq(aiProvidersTable.id, id));
      }
      const [row] = await tx
        .select()
        .from(aiProvidersTable)
        .where(eq(aiProvidersTable.id, id))
        .limit(1);
      return row;
    });

    logger.info(
      { by: req.session.userId, providerId: id, fields: Object.keys(patch), isActive },
      "AI provider updated",
    );

    res.json({
      id: updated.id,
      label: updated.label,
      role: updated.role,
      baseUrl: updated.baseUrl,
      apiKeyHint: updated.apiKeyHint,
      hasApiKey: Boolean(updated.apiKeyEncrypted),
      inputPricePerMtok: updated.inputPricePerMtok,
      outputPricePerMtok: updated.outputPricePerMtok,
      pricePerMinute: updated.pricePerMinute,
      isActive: updated.isActive,
    });
  } catch (err) {
    handleError(err, res);
  }
});

router.delete("/admin/ai/providers/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid provider ID" });
    return;
  }

  const result = await db.transaction(async (tx) => {
    // The foreign key sets provider_id to null, but it cannot clear `enabled`.
    // Leaving a task enabled with no provider is precisely the "configured but
    // broken on every call" state the enable-time guard refuses to create, so
    // stand those tasks down in the same transaction.
    const orphaned = await tx
      .update(aiTaskSettingsTable)
      .set({ enabled: false, providerId: null })
      .where(eq(aiTaskSettingsTable.providerId, id))
      .returning({ task: aiTaskSettingsTable.task });

    const deleted = await tx
      .delete(aiProvidersTable)
      .where(eq(aiProvidersTable.id, id))
      .returning({ id: aiProvidersTable.id });

    return { deleted: deleted.length > 0, disabledTasks: orphaned.map((t) => t.task) };
  });

  if (!result.deleted) {
    res.status(404).json({ error: "Provider not found" });
    return;
  }

  logger.info(
    { by: req.session.userId, providerId: id, disabledTasks: result.disabledTasks },
    "AI provider deleted",
  );
  res.json({ deleted: true, disabledTasks: result.disabledTasks });
});

/** What this endpoint offers — so the panel shows a list, not a text box. */
router.get("/admin/ai/providers/:id/models", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid provider ID" });
    return;
  }

  try {
    const loaded = await loadProviderWithKey(id);
    if (!loaded.ok) {
      res.status(loaded.status).json({ error: loaded.error });
      return;
    }
    res.json({ models: await listModels(loaded.provider.baseUrl, loaded.apiKey) });
  } catch (err) {
    handleError(err, res);
  }
});

/** One tiny real call, so a wrong key is found here and not mid-lesson. */
router.post("/admin/ai/providers/:id/test", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(req.params.id as string, 10);
  const modelId = req.body?.modelId;

  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid provider ID" });
    return;
  }
  if (typeof modelId !== "string" || modelId.length === 0) {
    res.status(400).json({ error: "modelId is required" });
    return;
  }

  try {
    const loaded = await loadProviderWithKey(id);
    if (!loaded.ok) {
      res.status(loaded.status).json({ error: loaded.error });
      return;
    }
    res.json(await testConnection(loaded.provider.baseUrl, loaded.apiKey, modelId));
  } catch (err) {
    handleError(err, res);
  }
});

// ─── Per-task settings ────────────────────────────────────────────────────────

const taskSchema = z.object({
  providerId: z.number().int().positive().nullable().optional(),
  modelId: z.string().min(1).max(200).nullable().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(32768).optional(),
  enabled: z.boolean().optional(),
});

router.patch("/admin/ai/tasks/:task", requireAdmin, async (req, res): Promise<void> => {
  const task = req.params.task as string;
  if (!isTask(task)) {
    res.status(400).json({ error: `Unknown task. Expected one of: ${AI_TASKS.join(", ")}` });
    return;
  }

  const parsed = taskSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.errors });
    return;
  }

  const [current] = await db
    .select()
    .from(aiTaskSettingsTable)
    .where(eq(aiTaskSettingsTable.task, task))
    .limit(1);

  const next = { ...current, ...parsed.data };

  // Enabling a task that cannot run would look configured while failing on
  // every call. Refuse it with the specific thing that is missing.
  if (next.enabled) {
    if (!next.providerId) {
      res.status(400).json({ error: "Choose a provider before enabling this task" });
      return;
    }
    if (!next.modelId) {
      res.status(400).json({ error: "Choose a model before enabling this task" });
      return;
    }
  }

  const [updated] = await db
    .update(aiTaskSettingsTable)
    .set(parsed.data)
    .where(eq(aiTaskSettingsTable.task, task))
    .returning();

  logger.info({ by: req.session.userId, task, ...parsed.data }, "AI task settings changed");
  res.json(updated);
});

// ─── Per-plan limits ──────────────────────────────────────────────────────────

const policySchema = z.object({
  planCode: z.string().min(1).max(60),
  task: z.string().refine(isTask, "Unknown task"),
  /** -1 = unlimited, 0 = denied. */
  dailyLimit: z.number().int().min(-1),
});

router.put("/admin/ai/policies", requireAdmin, async (req, res): Promise<void> => {
  const parsed = policySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.errors });
    return;
  }
  const { planCode, task, dailyLimit } = parsed.data;

  const [row] = await db
    .insert(aiPlanPoliciesTable)
    .values({ planCode, task: task as AITask, dailyLimit })
    .onConflictDoUpdate({
      target: [aiPlanPoliciesTable.planCode, aiPlanPoliciesTable.task],
      set: { dailyLimit, updatedAt: new Date() },
    })
    .returning();

  logger.info({ by: req.session.userId, planCode, task, dailyLimit }, "AI plan policy changed");
  res.json(row);
});

export default router;
