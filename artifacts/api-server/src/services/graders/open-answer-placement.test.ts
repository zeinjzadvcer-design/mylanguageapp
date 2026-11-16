import { beforeEach, describe, expect, it, vi } from "vitest";

// The grader's outside world: a configured task, a plan quota, a model reply.
vi.mock("../ai-config", () => ({
  resolveTaskConfig: vi.fn(async () => ({ modelId: "m", providerLabel: "test", systemPrompt: null })),
  computeCostUsd: vi.fn(() => 0),
  AIUnavailableError: class extends Error {},
}));
vi.mock("../ai-quota", () => ({
  checkAndIncrement: vi.fn(async () => {
    throw Object.assign(new Error("This AI feature is not included in your plan."), {
      code: "AI_QUOTA_PLAN_INELIGIBLE",
    });
  }),
  recordUsage: vi.fn(async () => {}),
}));
vi.mock("../ai-providers", () => ({
  AIProviderError: class extends Error {},
  chatJson: vi.fn(async (_config: unknown, _messages: unknown, validate: (v: unknown) => unknown) => ({
    value: validate({
      relevance: 80, grammar: 70, vocabulary: 60, clarity: 70, levelAppropriate: 60, feedbackAr: "جيد",
    }),
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    modelId: "m",
  })),
}));

import { buildMessages, gradeOpenAnswer, GradingUnavailableError } from "./open-answer";
import { checkAndIncrement } from "../ai-quota";

const input = { question: "Describe your town.", studentAnswer: "My town is small and quiet.", levelCode: "A2" };
const freeStudent = { userId: 7, subscriptionPlan: "free" };

beforeEach(() => {
  vi.mocked(checkAndIncrement).mockClear();
});

describe("placement writing and the plan allowance", () => {
  it("a free-plan answer in a lesson is refused by the plan", async () => {
    await expect(gradeOpenAnswer(input, freeStudent)).rejects.toBeInstanceOf(GradingUnavailableError);
  });

  it("placement marks it anyway, without touching the plan's allowance", async () => {
    const verdict = await gradeOpenAnswer(input, { ...freeStudent, quotaExempt: true });
    expect(verdict.score).toBeGreaterThan(0);
    expect(checkAndIncrement).not.toHaveBeenCalled();
  });

  it("judges the answer against the question's level, not a beginner's", () => {
    const system = buildMessages(input).find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("The student's level is A2");
    expect(system).not.toContain("beginner");
  });
});
