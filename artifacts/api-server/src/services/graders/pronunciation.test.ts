import { describe, it, expect } from "vitest";
import { combineScores, feedbackSystemPrompt } from "./pronunciation";

describe("feedbackSystemPrompt", () => {
  it("uses the default when nothing is stored", () => {
    expect(feedbackSystemPrompt(null)).toContain("You advise an Arabic-speaking student");
  });

  it("uses an admin's wording, and an edit cannot lose the reply format", () => {
    const p = feedbackSystemPrompt("Be very encouraging.");
    expect(p).toContain("Be very encouraging.");
    expect(p).not.toContain("You advise an Arabic-speaking student");
    expect(p).toContain('{"feedbackAr": "..."}');
  });
});

describe("combineScores", () => {
  it("weights pronunciation above fluency for a read-aloud task", () => {
    // The task was to say these words. Fluency matters, but less.
    expect(combineScores(80, 40)).toBe(68);
    expect(combineScores(40, 80)).toBe(52);
  });

  it("uses fluency alone when there was no passage to read", () => {
    expect(combineScores(null, 72)).toBe(72);
  });

  it("does not fold an unmeasured fluency in as a zero", () => {
    // A recogniser that returns no word timings makes fluency unknown, not
    // zero. Averaging the unknown in would drop a student who read the passage
    // at 78% down to 55% for a limitation of the transcription service.
    expect(combineScores(78, 0, false)).toBe(78);
  });

  it("scores zero when neither half could be measured", () => {
    expect(combineScores(null, 0, false)).toBe(0);
  });

  it("returns whole numbers", () => {
    expect(Number.isInteger(combineScores(77, 63))).toBe(true);
  });
});
