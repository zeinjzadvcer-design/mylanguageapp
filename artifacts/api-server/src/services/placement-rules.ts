/**
 * The placement rules in force, as an administrator last saved them.
 *
 * Read on every placement, so they are kept in memory briefly: placement is
 * rare, but a saved change should reach every server within half a minute
 * without a deploy. The server that saved them sees the change at once.
 */

import { z } from "zod";
import { db, placementSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  DEFAULT_PLACEMENT_RULES,
  PLACEMENT_LEVEL_CODES,
  placementRulesProblems,
  type PlacementRules,
} from "./scoring/placement";
import { logger } from "../lib/logger";

const weight = z.number().finite().min(0.1).max(10);
const percent = z.number().finite().min(0).max(100);

/** The shape of a full set of rules, as the admin page sends them. */
export const placementRulesSchema = z.object({
  difficultyWeights: z.object({ A1: weight, A2: weight, B1: weight, B2: weight, C1: weight, C2: weight }),
  levelThresholds: z.object(
    Object.fromEntries(PLACEMENT_LEVEL_CODES.map((c) => [c, percent.nullable()])) as Record<
      (typeof PLACEMENT_LEVEL_CODES)[number],
      z.ZodNullable<typeof percent>
    >,
  ),
  writingWeight: z.number().finite().min(0).max(10),
  weakBelow: percent,
  strongAt: percent,
});

/**
 * Stored rules over the defaults, field by field: a rule added after the row
 * was saved takes its default instead of making the whole row unreadable.
 * Anything unusable falls back to the defaults entirely, so a bad row can
 * never stop a student being placed.
 */
export function rulesFromStored(stored: unknown): PlacementRules {
  if (!stored || typeof stored !== "object") return DEFAULT_PLACEMENT_RULES;
  const s = stored as Partial<PlacementRules>;
  const merged = {
    ...DEFAULT_PLACEMENT_RULES,
    ...s,
    difficultyWeights: { ...DEFAULT_PLACEMENT_RULES.difficultyWeights, ...(s.difficultyWeights ?? {}) },
    levelThresholds: { ...DEFAULT_PLACEMENT_RULES.levelThresholds, ...(s.levelThresholds ?? {}) },
  };
  const parsed = placementRulesSchema.safeParse(merged);
  if (!parsed.success || placementRulesProblems(parsed.data).length > 0) {
    logger.error({ stored }, "Stored placement rules are unusable; placing with the defaults");
    return DEFAULT_PLACEMENT_RULES;
  }
  return parsed.data;
}

export function sameRules(a: PlacementRules, b: PlacementRules): boolean {
  const levels = PLACEMENT_LEVEL_CODES.every((c) => a.levelThresholds[c] === b.levelThresholds[c]);
  const weights = (Object.keys(b.difficultyWeights) as Array<keyof PlacementRules["difficultyWeights"]>).every(
    (d) => a.difficultyWeights[d] === b.difficultyWeights[d],
  );
  return (
    levels &&
    weights &&
    a.writingWeight === b.writingWeight &&
    a.weakBelow === b.weakBelow &&
    a.strongAt === b.strongAt
  );
}

const CACHE_MS = 30_000;
let cached: { rules: PlacementRules; at: number } | null = null;

export async function getPlacementRules(): Promise<PlacementRules> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.rules;
  const [row] = await db
    .select({ rules: placementSettingsTable.rules })
    .from(placementSettingsTable)
    .where(eq(placementSettingsTable.id, 1))
    .limit(1);
  const rules = rulesFromStored(row?.rules);
  cached = { rules, at: Date.now() };
  return rules;
}

/** When the rules were last saved, and by whom; null when never. */
export async function placementRulesUpdate(): Promise<{ updatedAt: Date; updatedBy: number | null } | null> {
  const [row] = await db
    .select({
      rules: placementSettingsTable.rules,
      updatedAt: placementSettingsTable.updatedAt,
      updatedBy: placementSettingsTable.updatedBy,
    })
    .from(placementSettingsTable)
    .where(eq(placementSettingsTable.id, 1))
    .limit(1);
  return row?.rules ? { updatedAt: row.updatedAt, updatedBy: row.updatedBy } : null;
}

/** Save checked rules. Saving the defaults stores null, so later changes to the defaults reach this site. */
export async function savePlacementRules(rules: PlacementRules, userId: number): Promise<void> {
  const value = sameRules(rules, DEFAULT_PLACEMENT_RULES) ? null : rules;
  await db
    .insert(placementSettingsTable)
    .values({ id: 1, rules: value, updatedBy: userId })
    .onConflictDoUpdate({
      target: placementSettingsTable.id,
      set: { rules: value, updatedBy: userId, updatedAt: new Date() },
    });
  cached = { rules, at: Date.now() };
}
