import { describe, it, expect } from "vitest";
import type { ContentBlock, Exercise, ExerciseOption } from "@workspace/db";
import { groupIdOf, isRecordingBlock, toStudentContentBlocks } from "./lesson-content";

function block(overrides: Partial<ContentBlock>): ContentBlock {
  return {
    id: 1, lessonId: 10, quizId: null, type: "text", order: 1,
    title: null, titleAr: null, instructions: null, instructionsAr: null,
    content: null, contentAr: null, audioNote: null, prompt: null, promptAr: null,
    exampleAudio: null, referenceMediaId: null, imageMediaId: null, audioMediaId: null,
    imageMediaKey: null, audioMediaKey: null, expectsReferenceReading: false,
    isRequired: true, estimatedMinutes: null, isActive: true, config: null,
    createdAt: new Date(), updatedAt: null,
    ...overrides,
  };
}

function exercise(overrides: Partial<Exercise>): Exercise {
  return {
    id: 100, lessonId: 10, contentBlockId: 1, exerciseType: "speaking",
    question: "", questionAr: null, correctOptionId: "", explanation: null,
    explanationAr: null, prompt: null, promptAr: null, instructionsText: null,
    instructionsAr: null, modelAnswer: null, modelAnswerAr: null,
    expectedConcepts: null, difficulty: null, points: 10, ordering: 0,
    audioUrl: null, createdAt: new Date(), updatedAt: null,
    ...overrides,
  };
}

describe("isRecordingBlock", () => {
  it("treats a text block as a recording block only when it is read aloud", () => {
    expect(isRecordingBlock(block({ type: "text" }))).toBe(false);
    expect(isRecordingBlock(block({ type: "text", expectsReferenceReading: true }))).toBe(true);
  });

  it("always treats speaking and pronunciation blocks as recording blocks", () => {
    expect(isRecordingBlock(block({ type: "speaking_prompt" }))).toBe(true);
    expect(isRecordingBlock(block({ type: "pronunciation_guide" }))).toBe(true);
  });

  it("never treats explanation or review blocks as recording blocks", () => {
    // The flag only means something on a text block.
    expect(isRecordingBlock(block({ type: "explanation", expectsReferenceReading: true }))).toBe(false);
    expect(isRecordingBlock(block({ type: "review", expectsReferenceReading: true }))).toBe(false);
  });
});

describe("toStudentContentBlocks — several items in one block", () => {
  it("gives each speaking prompt its own text", () => {
    const [b] = toStudentContentBlocks(
      [block({ type: "speaking_prompt", prompt: "Describe your morning" })],
      [
        exercise({ id: 1, prompt: "Describe your morning", question: "Describe your morning", ordering: 1 }),
        exercise({ id: 2, prompt: "Describe your weekend", promptAr: "صف عطلتك", instructionsAr: "تحدث لدقيقة", question: "Describe your weekend", ordering: 2 }),
      ],
      [],
      [],
    );
    expect(b.questions).toHaveLength(2);
    expect(b.questions[1]).toMatchObject({
      exerciseId: 2,
      prompt: "Describe your weekend",
      promptAr: "صف عطلتك",
      instructionsAr: "تحدث لدقيقة",
    });
  });

  it("falls back to the question for an open-ended item with no prompt", () => {
    // The open-ended editor writes `question`, never `prompt`.
    const [b] = toStudentContentBlocks(
      [block({ type: "open_ended" })],
      [exercise({ exerciseType: "open_ended", prompt: "", question: "Why?", questionAr: "لماذا؟" })],
      [],
      [],
    );
    expect(b.questions[0].prompt).toBe("Why?");
    expect(b.questions[0].promptAr).toBe("لماذا؟");
  });

  it("never exposes an MCQ answer key", () => {
    const options: ExerciseOption[] = [
      { id: 1, exerciseId: 100, optionId: "a", text: "A", textAr: null },
      { id: 2, exerciseId: 100, optionId: "b", text: "B", textAr: null },
    ];
    const [b] = toStudentContentBlocks(
      [block({ type: "mcq" })],
      [exercise({ exerciseType: "mcq", question: "Pick", correctOptionId: "b" })],
      options,
      [],
    );
    expect(JSON.stringify(b)).not.toContain("correctOptionId");
  });

  it("tells the player a text block is read aloud", () => {
    const [b] = toStudentContentBlocks(
      [block({ type: "text", content: "Hello world", expectsReferenceReading: true })],
      [],
      [],
      [],
    );
    expect(b.expectsReferenceReading).toBe(true);
  });
});

describe("groupIdOf — items added as separate blocks", () => {
  it("reads the group id an author linked items with", () => {
    expect(groupIdOf({ groupId: "g1", maxTurns: 6 })).toBe("g1");
  });

  it("treats every block authored before grouping as ungrouped", () => {
    // Existing lessons have config null, or config without a group id.
    expect(groupIdOf(null)).toBeNull();
    expect(groupIdOf({ maxTurns: 6 })).toBeNull();
    expect(groupIdOf({ groupId: "" })).toBeNull();
    expect(groupIdOf({ groupId: 7 })).toBeNull();
  });

  it("passes the group id to the player", () => {
    const [b] = toStudentContentBlocks(
      [block({ type: "pronunciation_guide", config: { groupId: "g1" } })],
      [], [], [],
    );
    expect(b.groupId).toBe("g1");
  });
});
