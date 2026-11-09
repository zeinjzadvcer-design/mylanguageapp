import { describe, it, expect } from "vitest";
import {
  DEFAULT_TASK_PROMPTS,
  TASK_PROMPT_PLACEHOLDERS,
  isPromptEditable,
  promptTemplateProblem,
  renderInstructions,
  taskInstructions,
} from "./ai-prompts";

describe("renderInstructions", () => {
  it("fills in placeholders, tolerating spaces inside the braces", () => {
    expect(renderInstructions("Level {{level}} / {{ level }}", { level: "A2" })).toBe(
      "Level A2 / A2",
    );
  });

  it("leaves out a whole line when its placeholder has no value", () => {
    expect(renderInstructions("one\nGoals: {{goals}}\ntwo", { goals: null })).toBe("one\ntwo");
  });

  it("keeps a line for an empty value, which is how a conditional line works", () => {
    expect(renderInstructions("{{when}}- rule", { when: "" })).toBe("- rule");
    expect(renderInstructions("{{when}}- rule\nend", { when: null })).toBe("end");
  });

  it("keeps blank lines an admin wrote", () => {
    expect(renderInstructions("a\n\nb", {})).toBe("a\n\nb");
  });

  it("does not expand placeholders that arrive inside a value", () => {
    // A value is authored or student-derived text, so it must stay literal.
    expect(renderInstructions("{{a}}", { a: "{{b}}", b: "secret" })).toBe("{{b}}");
  });

  it("does not treat replacement patterns in a value as special", () => {
    expect(renderInstructions("{{a}}", { a: "costs $& more" })).toBe("costs $& more");
  });
});

describe("taskInstructions", () => {
  it("uses the default when nothing is stored, or only whitespace", () => {
    const fallback = DEFAULT_TASK_PROMPTS.conversation;
    expect(taskInstructions("conversation", null)).toBe(fallback);
    expect(taskInstructions("conversation", "   ")).toBe(fallback);
  });

  it("uses the stored text otherwise", () => {
    expect(taskInstructions("conversation", " Be brief. ")).toBe("Be brief.");
  });
});

describe("which prompts are editable", () => {
  it.each(["conversation", "open_answer", "feedback", "peer_call_analysis"] as const)(
    "%s is editable",
    (task) => expect(isPromptEditable(task)).toBe(true),
  );

  it("leaves transcription, which has no prompt, alone", () => {
    expect(isPromptEditable("transcription")).toBe(false);
  });
});

describe("promptTemplateProblem", () => {
  it("accepts every default as it stands", () => {
    for (const [task, text] of Object.entries(DEFAULT_TASK_PROMPTS)) {
      expect(promptTemplateProblem(task as keyof typeof DEFAULT_TASK_PROMPTS, text)).toBeNull();
    }
  });

  it("uses every placeholder it declares in the default", () => {
    // A declared placeholder the default never uses could not be restored from
    // the text, and the panel would be describing something that does nothing.
    for (const [task, placeholders] of Object.entries(TASK_PROMPT_PLACEHOLDERS)) {
      const text = DEFAULT_TASK_PROMPTS[task as keyof typeof DEFAULT_TASK_PROMPTS]!;
      for (const { name } of placeholders) expect(text).toContain(`{{${name}}}`);
    }
  });

  it("refuses a mistyped placeholder and says which ones exist", () => {
    const text = `${DEFAULT_TASK_PROMPTS.conversation}\nHello {{titel}}`;
    const problem = promptTemplateProblem("conversation", text);
    expect(problem).toContain("{{titel}}");
    expect(problem).toContain("{{title}}");
  });

  it("refuses removing a placeholder that carries authored content", () => {
    const text = DEFAULT_TASK_PROMPTS.conversation!.replace("{{script}}\n", "");
    expect(promptTemplateProblem("conversation", text)).toContain("{{script}}");
  });

  it("allows removing an optional placeholder", () => {
    const text = DEFAULT_TASK_PROMPTS.conversation!.replaceAll("{{when_script}}", "");
    expect(promptTemplateProblem("conversation", text)).toBeNull();
  });

  it("refuses two placeholders on one line, since either could drop the other", () => {
    const text = DEFAULT_TASK_PROMPTS.open_answer!.replace(
      "A good answer should cover: {{key_points}}\nThe answer was asked to be at least {{min_words}} words.",
      "Cover: {{key_points}}. Minimum {{min_words}} words.",
    );
    const problem = promptTemplateProblem("open_answer", text);
    expect(problem).toContain("own line");
    expect(problem).toContain("{{key_points}}");
  });

  it("lets a conditional share a line with one placeholder", () => {
    const text = `${DEFAULT_TASK_PROMPTS.conversation}\n{{when_script}}Use these: {{vocabulary}}`;
    expect(promptTemplateProblem("conversation", text)).toBeNull();
  });

  it("refuses placeholders on a task that has none", () => {
    expect(promptTemplateProblem("feedback", "Hello {{level}}")).toContain("no placeholders");
  });
});
