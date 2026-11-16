import { describe, expect, it } from "vitest";
import { rulesFromStored, sameRules } from "./placement-rules";
import { DEFAULT_PLACEMENT_RULES } from "./scoring/placement";

describe("stored placement rules", () => {
  it("nothing saved means the defaults", () => {
    expect(rulesFromStored(null)).toBe(DEFAULT_PLACEMENT_RULES);
  });

  it("a saved change is used, and fields saved before they existed take their defaults", () => {
    const r = rulesFromStored({ writingWeight: 3, levelThresholds: { "B1.1": 55 } });
    expect(r.writingWeight).toBe(3);
    expect(r.levelThresholds["B1.1"]).toBe(55);
    expect(r.levelThresholds["A2.2"]).toBe(DEFAULT_PLACEMENT_RULES.levelThresholds["A2.2"]);
    expect(r.difficultyWeights).toEqual(DEFAULT_PLACEMENT_RULES.difficultyWeights);
  });

  it("an unusable row never stops a student being placed", () => {
    expect(rulesFromStored({ writingWeight: "lots" })).toBe(DEFAULT_PLACEMENT_RULES);
    expect(rulesFromStored({ levelThresholds: { "A1.1": 50 } })).toBe(DEFAULT_PLACEMENT_RULES);
  });

  it("recognises the defaults whatever order their fields arrive in", () => {
    const shuffled = JSON.parse(JSON.stringify({ ...DEFAULT_PLACEMENT_RULES, strongAt: DEFAULT_PLACEMENT_RULES.strongAt }));
    expect(sameRules(shuffled, DEFAULT_PLACEMENT_RULES)).toBe(true);
    expect(sameRules({ ...shuffled, weakBelow: 50 }, DEFAULT_PLACEMENT_RULES)).toBe(false);
  });
});
