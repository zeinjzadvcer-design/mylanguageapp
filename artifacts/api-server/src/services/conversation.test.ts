import { describe, it, expect } from "vitest";
import { countVocabularyUsed, buildSystemPrompt } from "./conversation";

const lesson = {
  title: "Daily Routine",
  objectives: ["talk about your morning", "use the present simple"],
  text: "Sara wakes up at six every day.",
  vocabulary: [
    { word: "wake up", translation: "يستيقظ" },
    { word: "breakfast", translation: "فطور" },
    { word: "commute", translation: "تنقل" },
  ],
  levelCode: "A2.1",
  prompt: "Tell me about your morning.",
};

describe("countVocabularyUsed", () => {
  it("finds a target word the student used", () => {
    expect(countVocabularyUsed("I eat breakfast at seven", ["breakfast", "commute"])).toEqual([
      "breakfast",
    ]);
  });

  it("ignores case and punctuation", () => {
    expect(countVocabularyUsed("Breakfast, then work.", ["breakfast"])).toEqual(["breakfast"]);
  });

  it("counts a multi-word phrase only when the whole phrase was said", () => {
    expect(countVocabularyUsed("I wake up early", ["wake up"])).toEqual(["wake up"]);
    expect(countVocabularyUsed("I wake at six", ["wake up"])).toEqual([]);
  });

  it("does not count an inflected form as the target word", () => {
    // Using the exact target word is what is being measured. A looser match
    // would inflate the number and make the vocabulary signal meaningless.
    expect(countVocabularyUsed("I worked yesterday", ["work"])).toEqual([]);
  });

  it("does not count a word merely contained in another", () => {
    expect(countVocabularyUsed("I like breakfasting", ["breakfast"])).toEqual([]);
  });

  it("returns nothing for an empty message or no targets", () => {
    expect(countVocabularyUsed("", ["breakfast"])).toEqual([]);
    expect(countVocabularyUsed("breakfast", [])).toEqual([]);
  });

  it("reports each target once even if repeated", () => {
    expect(countVocabularyUsed("breakfast breakfast breakfast", ["breakfast"])).toEqual([
      "breakfast",
    ]);
  });
});

describe("buildSystemPrompt", () => {
  it("binds the tutor to this lesson's topic, objectives and text", () => {
    const p = buildSystemPrompt(lesson);
    expect(p).toContain("Daily Routine");
    expect(p).toContain("talk about your morning");
    expect(p).toContain("Sara wakes up at six");
  });

  it("passes the target vocabulary in", () => {
    const p = buildSystemPrompt(lesson);
    expect(p).toContain("wake up");
    expect(p).toContain("commute");
  });

  describe("brief mode, from the second turn onward", () => {
    // A realistic passage. The fixture's one-liner is deliberately kept for the
    // short-passage case below, because the note that replaces a passage costs
    // about 130 characters — so trimming a one-sentence passage would make the
    // prompt longer, not shorter.
    const long = {
      ...lesson,
      text: "Sara wakes up at six every day. ".repeat(20),
    };

    // The passage was resent in full on EVERY turn. It is the largest
    // avoidable part of the prompt, and prompt size is what
    // time-to-first-token scales with, so trimming it is both cheaper and
    // faster. These tests pin what may and may not be dropped.

    it("drops the passage", () => {
      const p = buildSystemPrompt(long, { brief: true });
      expect(p).not.toContain("Sara wakes up at six");
    });

    it("still says a passage exists, so a reference to it has an antecedent", () => {
      const p = buildSystemPrompt(long, { brief: true });
      expect(p).toContain("read a short passage");
    });

    it("keeps the topic in compressed form", () => {
      const p = buildSystemPrompt(lesson, { brief: true });
      expect(p).toContain("Daily Routine");
      expect(p).toContain("talk about your morning");
      expect(p).toContain("Tell me about your morning.");
      expect(p).toContain("wake up");
      expect(p).toContain("A2.1");
    });

    it("NEVER drops a dialogue script", () => {
      // The script is the sequence the tutor is told to follow step by step.
      // Trimming it mid-conversation would leave the model improvising the
      // activity rather than running it — unlike the passage, which is
      // background the student already read.
      const scripted = { ...long, script: "1. Ask what time they wake up." };
      const p = buildSystemPrompt(scripted, { brief: true });
      expect(p).toContain("Ask what time they wake up");
      expect(p).toContain("Follow the dialogue above");
    });

    it("keeps a SHORT passage, because the note replacing it costs more", () => {
      // The fixture passage is one sentence. Dropping it and adding the
      // explanatory note would lengthen the prompt, which is the opposite of
      // the point.
      const brief = buildSystemPrompt(lesson, { brief: true });
      expect(brief).toContain("Sara wakes up at six");
      expect(brief.length).toBeLessThanOrEqual(buildSystemPrompt(lesson).length);
    });

    it("keeps the behavioural instructions", () => {
      const p = buildSystemPrompt(lesson, { brief: true });
      expect(p).toContain("ONE question");
    });

    it("is meaningfully shorter than the full prompt", () => {
      const full = buildSystemPrompt(long);
      const brief = buildSystemPrompt(long, { brief: true });
      expect(brief.length).toBeLessThan(full.length);
    });
  });

  it("tells the tutor the student's level", () => {
    expect(buildSystemPrompt(lesson)).toContain("A2.1");
  });

  it("asks for short replies and one question — so the student does the talking", () => {
    // A model told to be "helpful and engaging" writes essays. Section 4D wants
    // the student speaking, which is a behavioural instruction, not a persona.
    const p = buildSystemPrompt(lesson);
    expect(p).toContain("ONE question");
    expect(p).toMatch(/two short sentences/i);
    expect(p).toMatch(/do not lecture/i);
  });

  it("forbids leaving the lesson topic", () => {
    const p = buildSystemPrompt(lesson);
    expect(p).toMatch(/stay on this lesson's topic/i);
    expect(p).toMatch(/never discuss anything outside/i);
  });

  it("tells it to keep corrections brief rather than listing errors", () => {
    const p = buildSystemPrompt(lesson);
    expect(p).toMatch(/correct it in a few words/i);
    expect(p).toMatch(/never list their errors/i);
  });

  it("treats the student's messages as speech, not as instructions", () => {
    expect(buildSystemPrompt(lesson)).toMatch(/not as a command/i);
  });

  it("works for a lesson with no text, vocabulary or objectives", () => {
    const bare = {
      title: "Free talk",
      objectives: [],
      text: null,
      vocabulary: [],
      levelCode: null,
      prompt: null,
    };
    const p = buildSystemPrompt(bare);
    expect(p).toContain("Free talk");
    expect(p).not.toContain("undefined");
    expect(p).not.toContain("null");
  });
});
