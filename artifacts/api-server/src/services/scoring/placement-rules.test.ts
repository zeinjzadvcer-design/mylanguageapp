import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLACEMENT_RULES,
  levelForScore,
  placementRulesProblems,
  placementScenarios,
  scorePlacement,
  type AnsweredQuestion,
  type PlacementRules,
  type PreviewQuestion,
} from "./placement";

const rules = (patch: Partial<PlacementRules> = {}): PlacementRules => ({
  ...DEFAULT_PLACEMENT_RULES,
  ...patch,
  difficultyWeights: { ...DEFAULT_PLACEMENT_RULES.difficultyWeights, ...(patch.difficultyWeights ?? {}) },
  levelThresholds: { ...DEFAULT_PLACEMENT_RULES.levelThresholds, ...(patch.levelThresholds ?? {}) },
});

const grammar = (difficulty: AnsweredQuestion["difficulty"], correct: boolean): AnsweredQuestion => ({
  skill: "grammar",
  difficulty,
  correct,
});

describe("placement rules — defaults", () => {
  it("place exactly as the fixed table did", () => {
    const table: Array<[number, string]> = [
      [0, "A1.1"], [21, "A1.1"], [22, "A1.2"], [38, "A2.1"], [48, "A2.2"], [58, "B1.1"],
      [67, "B1.2"], [76, "B2.1"], [85, "B2.2"], [91, "B2.2"], [92, "C1.1"], [100, "C1.1"],
    ];
    for (const [score, level] of table) expect(levelForScore(score, DEFAULT_PLACEMENT_RULES)).toBe(level);
  });

  it("are themselves valid", () => {
    expect(placementRulesProblems(DEFAULT_PLACEMENT_RULES)).toEqual([]);
  });
});

describe("placement rules — an administrator's changes", () => {
  it("a lower score for B1.1 places the same student higher", () => {
    const answers = [grammar("A1", true), grammar("A2", true), grammar("B1", false), grammar("B2", false)];
    const before = scorePlacement(answers);
    const after = scorePlacement(answers, null, rules({ levelThresholds: { ...DEFAULT_PLACEMENT_RULES.levelThresholds, "B1.1": 35 } }));
    expect(before.overall).toBe(after.overall);
    expect(before.levelCode).toBe("A1.2");
    expect(after.levelCode).toBe("B1.1");
  });

  it("weights decide what a hard question is worth", () => {
    const answers = [grammar("A1", false), grammar("B2", true)];
    const flat = rules({ difficultyWeights: { A1: 1, A2: 1, B1: 1, B2: 1, C1: 1, C2: 1 } });
    expect(scorePlacement(answers, null, flat).overall).toBe(50);
    expect(scorePlacement(answers).overall).toBe(69);
  });

  it("a level left blank is never assigned", () => {
    const noC1 = rules({ levelThresholds: { ...DEFAULT_PLACEMENT_RULES.levelThresholds, "C1.1": null } });
    expect(levelForScore(100, noC1)).toBe("B2.2");
  });

  it("writing counts at the chosen worth, and at 0 is shown without moving the level", () => {
    const answers = [grammar("A1", true), grammar("A2", false)];
    const counted = scorePlacement(answers, 100, rules({ writingWeight: 2.3 }));
    const shown = scorePlacement(answers, 100, rules({ writingWeight: 0 }));
    expect(counted.overall).toBe(Math.round(((1 + 2.3) / (1 + 1.3 + 2.3)) * 100));
    expect(shown.overall).toBe(scorePlacement(answers).overall);
    expect(shown.skills.find((s) => s.skill === "writing")!.score).toBe(100);
  });

  it("every written answer counts, not only the last", () => {
    const answers = [grammar("A1", true)];
    const two = scorePlacement(answers, [40, 80]);
    const writing = two.skills.find((s) => s.skill === "writing")!;
    expect(writing).toEqual({ skill: "writing", score: 60, answered: 2 });
    const w = DEFAULT_PLACEMENT_RULES.writingWeight;
    expect(two.overall).toBe(Math.round(((1 + 0.4 * w + 0.8 * w) / (1 + 2 * w)) * 100));
  });

  it("strength and weakness cut-offs move with the rules", () => {
    const answers = [grammar("A1", true), grammar("A1", true), grammar("A1", true), grammar("A1", false)];
    expect(scorePlacement(answers).strengths).toEqual([]);
    expect(scorePlacement(answers, null, rules({ strongAt: 75 })).strengths).toEqual(["grammar"]);
  });
});

describe("placement rules — what is refused", () => {
  const thresholds = DEFAULT_PLACEMENT_RULES.levelThresholds;

  it("levels whose scores do not climb", () => {
    expect(placementRulesProblems(rules({ levelThresholds: { ...thresholds, "B1.1": 40 } }))).toHaveLength(1);
  });

  it("a lowest level that does not start at 0", () => {
    const problems = placementRulesProblems(rules({ levelThresholds: { ...thresholds, "A1.1": 5 } }));
    expect(problems[0]).toMatch(/A1\.1/);
  });

  it("no level at all", () => {
    const none = Object.fromEntries(Object.keys(thresholds).map((k) => [k, null])) as PlacementRules["levelThresholds"];
    expect(placementRulesProblems(rules({ levelThresholds: none }))).toHaveLength(1);
  });

  it("a weakness cut-off at or above the strength one", () => {
    expect(placementRulesProblems(rules({ weakBelow: 80, strongAt: 80 }))).toHaveLength(1);
  });
});

describe("placement preview", () => {
  const test: PreviewQuestion[] = [
    { type: "choice", difficulty: "A1", optionCount: 4 },
    { type: "choice", difficulty: "A2", optionCount: 4 },
    { type: "choice", difficulty: "B1", optionCount: 4 },
    { type: "choice", difficulty: "B2", optionCount: 4 },
    { type: "written", difficulty: "A2", optionCount: 0 },
  ];

  it("shows guessing, nothing right, and each step up", () => {
    const s = placementScenarios(test, DEFAULT_PLACEMENT_RULES, null);
    expect(s.map((x) => x.key)).toEqual(["guess", "none", "upTo:A1", "upTo:A2", "upTo:B1", "upTo:B2"]);
    expect(s.find((x) => x.key === "guess")!.overall).toBe(25);
    expect(s.find((x) => x.key === "none")!.levelCode).toBe("A1.1");
    expect(s.find((x) => x.key === "upTo:B2")!.overall).toBe(100);
  });

  it("matches what scoring would give the same answers", () => {
    const s = placementScenarios(test, DEFAULT_PLACEMENT_RULES, 50);
    const upToA2 = scorePlacement([grammar("A1", true), grammar("A2", true), grammar("B1", false), grammar("B2", false)], [50]);
    expect(s.find((x) => x.key === "upTo:A2")).toMatchObject({ overall: upToA2.overall, levelCode: upToA2.levelCode });
  });
});
