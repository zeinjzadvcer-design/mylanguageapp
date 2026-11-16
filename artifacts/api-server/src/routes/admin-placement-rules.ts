/**
 * How placement turns answers into a level — read, previewed and saved from
 * /admin/placement-rules. Saved rules apply to placements taken afterwards;
 * students already placed keep their level.
 */

import { Router, type IRouter } from "express";
import { z } from "zod";
import { count, eq } from "drizzle-orm";
import {
  db,
  aiTaskSettingsTable,
  placementOptionsTable,
  placementQuestionsTable,
  usersTable,
} from "@workspace/db";
import { requirePermission } from "../middlewares/auth";
import {
  DEFAULT_PLACEMENT_RULES,
  PLACEMENT_LEVEL_CODES,
  placementRulesProblems,
  placementScenarios,
  type PreviewQuestion,
} from "../services/scoring/placement";
import {
  getPlacementRules,
  placementRulesSchema,
  placementRulesUpdate,
  savePlacementRules,
} from "../services/placement-rules";

const router: IRouter = Router();

/** The active questions, as the preview needs them: one row each, with its option count. */
async function previewQuestions(): Promise<PreviewQuestion[]> {
  const questions = await db
    .select({
      type: placementQuestionsTable.type,
      difficulty: placementQuestionsTable.difficulty,
      optionCount: count(placementOptionsTable.id),
    })
    .from(placementQuestionsTable)
    .leftJoin(placementOptionsTable, eq(placementOptionsTable.questionId, placementQuestionsTable.id))
    .where(eq(placementQuestionsTable.isActive, true))
    .groupBy(placementQuestionsTable.id);
  return questions.map((q) => ({
    type: q.type === "written" ? "written" : "choice",
    difficulty: q.difficulty,
    optionCount: Number(q.optionCount),
  }));
}

/** Rules that fit the shape but contradict themselves get every problem back at once. */
function problemsResponse(problems: string[]) {
  return { error: problems[0], problems };
}

router.get("/admin/placement-rules", requirePermission("settings.manage"), async (_req, res): Promise<void> => {
  const [rules, update, questions, [aiTask]] = await Promise.all([
    getPlacementRules(),
    placementRulesUpdate(),
    previewQuestions(),
    db
      .select({ enabled: aiTaskSettingsTable.enabled })
      .from(aiTaskSettingsTable)
      .where(eq(aiTaskSettingsTable.task, "placement_analysis"))
      .limit(1),
  ]);

  let updatedByName: string | null = null;
  if (update?.updatedBy) {
    const [u] = await db
      .select({ name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, update.updatedBy))
      .limit(1);
    updatedByName = u?.name ?? null;
  }

  res.json({
    rules,
    defaults: DEFAULT_PLACEMENT_RULES,
    levelCodes: PLACEMENT_LEVEL_CODES,
    updatedAt: update?.updatedAt ?? null,
    updatedByName,
    aiAdjustmentEnabled: aiTask?.enabled ?? false,
    questions: {
      choice: questions.filter((q) => q.type === "choice").length,
      written: questions.filter((q) => q.type === "written").length,
    },
  });
});

const previewSchema = z.object({
  rules: placementRulesSchema,
  /** The mark assumed for every written answer; null leaves writing unmarked. */
  writingScore: z.number().finite().min(0).max(100).nullable().default(null),
});

router.post("/admin/placement-rules/preview", requirePermission("settings.manage"), async (req, res): Promise<void> => {
  const parsed = previewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.errors });
    return;
  }
  const { rules, writingScore } = parsed.data;
  const problems = placementRulesProblems(rules);
  res.json({
    problems,
    scenarios: problems.length ? [] : placementScenarios(await previewQuestions(), rules, writingScore),
  });
});

router.put("/admin/placement-rules", requirePermission("settings.manage"), async (req, res): Promise<void> => {
  const parsed = z.object({ rules: placementRulesSchema }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.errors });
    return;
  }
  const problems = placementRulesProblems(parsed.data.rules);
  if (problems.length) {
    res.status(400).json(problemsResponse(problems));
    return;
  }
  await savePlacementRules(parsed.data.rules, req.session.userId!);
  res.json({ rules: parsed.data.rules });
});

export default router;
