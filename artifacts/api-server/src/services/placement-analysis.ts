/**
 * Reading a placement result.
 *
 * Spec section 2 asks the AI to determine the starting level and identify
 * strengths, weaknesses, skills requiring improvement and recommended areas of
 * effort.
 *
 * The level is not asked for outright. It is computed in `scoring/placement.ts`
 * and offered to the model, which may move it by at most one sub-level with a
 * stated reason — see `applyLevelAdjustment`, which enforces that regardless of
 * what comes back. What the model is genuinely for is the part arithmetic
 * cannot do: reading an uneven profile and saying something useful about it in
 * the student's own language.
 *
 * Everything here is optional. A placement with no AI still assigns a level,
 * still reports per-skill scores, and still names strengths and weaknesses —
 * those come from the arithmetic. Only the sentence and the adjustment are
 * lost, and a student is never held up waiting for them.
 */

import { z } from "zod";
import type { AITask } from "@workspace/db";
import { resolveTaskConfig, computeCostUsd } from "./ai-config";
import { chatJson } from "./ai-providers";
import { checkAndIncrement, recordUsage } from "./ai-quota";
import type { PlacementOutcome } from "./scoring/placement";
import { logger } from "../lib/logger";

const TASK: AITask = "placement_analysis";

const analysisSchema = z.object({
  /** May differ from the computed level by at most one step; enforced later. */
  suggestedLevelCode: z.string().max(10).optional(),
  adjustmentReason: z.string().max(300).optional(),
  analysisAr: z.string().min(1).max(800),
});

export interface PlacementAnalysis {
  suggestedLevelCode: string | null;
  adjustmentReason: string | null;
  /** Two or three sentences of Arabic for the student. */
  analysisAr: string;
  meta: { provider: string; modelId: string; tokensUsed: number };
}

/**
 * Ask for a reading of the result.
 *
 * Returns null whenever it cannot be had — AI off, no provider, out of quota,
 * provider unreachable, malformed response. A new student must never be blocked
 * at the door because a model was unavailable.
 */
export async function analysePlacement(
  outcome: PlacementOutcome,
  availableLevelCodes: string[],
  /** `quotaExempt` as for the grader: placement is taken once, on whatever plan. */
  ctx: { userId: number; subscriptionPlan: string | null; quotaExempt?: boolean },
): Promise<PlacementAnalysis | null> {
  let config;
  try {
    config = await resolveTaskConfig(TASK);
  } catch {
    return null;
  }

  try {
    if (!ctx.quotaExempt) {
      await checkAndIncrement({
        userId: ctx.userId,
        subscriptionPlan: ctx.subscriptionPlan,
        task: TASK,
        feature: "open_answer_evaluation",
      });
    }
  } catch {
    return null;
  }

  const scored = outcome.skills
    .filter((s) => s.score !== null)
    .map((s) => `${s.skill}: ${s.score}/100 (${s.answered} question(s))`);

  const facts = [
    `Overall weighted score: ${outcome.overall}/100.`,
    `The test placed them at ${outcome.levelCode}.`,
    "",
    "Per skill:",
    ...scored,
    "",
    outcome.strengths.length ? `Strongest: ${outcome.strengths.join(", ")}.` : "",
    outcome.weaknesses.length ? `Weakest: ${outcome.weaknesses.join(", ")}.` : "",
    "",
    `The levels available are: ${availableLevelCodes.join(", ")}.`,
  ]
    .filter(Boolean)
    .join("\n");

  const started = Date.now();
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let succeeded = false;

  try {
    const result = await chatJson(
      config,
      [
        {
          role: "system",
          content: [
            "You are reviewing a placement test for an Arabic-speaking student",
            "starting an English course.",
            "",
            "The level has already been calculated from their answers. You may",
            "suggest moving it by ONE step up or down — and only one — if the",
            "profile genuinely warrants it: for example, someone strong in",
            "reading but very weak in grammar may be better placed a step lower.",
            "Any larger change will be ignored. If the calculated level looks",
            "right, omit suggestedLevelCode entirely.",
            "",
            "Then write analysisAr: two or three short sentences IN ARABIC for",
            "the student. Say what they are good at first, then what to work on.",
            "Be encouraging. Do not list every score back to them. Do not",
            "promise anything about how fast they will progress.",
            "",
            'Reply with ONLY a JSON object with keys: suggestedLevelCode',
            "(optional), adjustmentReason (optional), analysisAr.",
          ].join("\n"),
        },
        { role: "user", content: facts },
      ],
      (value) => analysisSchema.parse(value),
    );

    usage = result.usage;
    succeeded = true;

    return {
      suggestedLevelCode: result.value.suggestedLevelCode ?? null,
      adjustmentReason: result.value.adjustmentReason ?? null,
      analysisAr: result.value.analysisAr.trim(),
      meta: {
        provider: config.providerLabel,
        modelId: result.modelId,
        tokensUsed: usage.totalTokens,
      },
    };
  } catch (err) {
    logger.info(
      { err: err instanceof Error ? err.message : err },
      "Placement analysis unavailable — the computed level stands",
    );
    return null;
  } finally {
    void recordUsage({
      userId: ctx.userId,
      subscriptionPlan: ctx.subscriptionPlan,
      task: TASK,
      feature: "open_answer_evaluation",
      provider: config.providerLabel,
      modelId: config.modelId,
      tokensUsed: usage.totalTokens,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costUsd: computeCostUsd(config, usage) ?? undefined,
      succeeded,
      latencyMs: Date.now() - started,
    });
  }
}
