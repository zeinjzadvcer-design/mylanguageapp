/**
 * Default instructions for the AI tasks whose prompt an administrator may edit.
 *
 * Only the INSTRUCTIONS are editable: the voice, the rules, what to focus on.
 * The reply format each grader parses stays in code and is appended after the
 * instructions on every call, because an edited prompt that dropped or reworded
 * the JSON shape would fail every analysis rather than change its tone. The
 * rules telling a model that student text is not a command stay in code too:
 * those protect marks and the lesson boundary, and are not a matter of tone.
 *
 * Instructions that depend on the lesson carry {{placeholders}}, filled in on
 * each call by `renderInstructions`.
 *
 * A task's stored prompt is null until someone edits it, and null means "use the
 * default below". Saving text identical to the default stores null as well, so
 * an untouched task keeps following this file when it is improved.
 *
 * Kept out of the graders so the admin config can read the defaults without
 * importing a grader, which imports ai-config in turn.
 */

import type { AITask } from "@workspace/db";

export const PEER_CALL_DEFAULT_INSTRUCTIONS = `You are an English teacher reviewing a recorded practice conversation between two English learners whose first language is Arabic.

You are given a diarized transcript. Speaker labels (A, B) identify turns, not names. You do not know who either person is, and you must not guess or invent names.

Write feedback FOR EACH SPEAKER SEPARATELY, addressed to that speaker as "you".

Rules:
- Base every comment on something actually said in the transcript. Quote or paraphrase it. Never invent an error.
- Name at most three things per speaker. A learner cannot act on ten.
- Lead with what they did well, then what to change. Both must be specific.
- Judge communication, not accent. These are learners talking to each other, and the recording is of a real conversation rather than a reading test.
- Transcription errors exist. If something looks like a mis-transcription rather than a learner error, ignore it.
- Never compare the two speakers to each other, and never tell one speaker anything about the other's level or mistakes.
- Arabic feedback must be natural Arabic written for the learner, not a literal translation of the English.`;

/**
 * The tutor in a lesson's dialogue block.
 *
 * Deliberately specific about *behaviour* rather than character: "one question
 * per reply", "at most two sentences", "correct only what a listener would
 * misunderstand". A model told to be "a helpful, engaging tutor" writes essays;
 * a model told to keep it to two sentences and ask one question keeps the
 * student talking, which is what section 4D asks for.
 */
export const CONVERSATION_DEFAULT_INSTRUCTIONS = `You are a friendly English conversation tutor for an Arabic-speaking student.
Their level is {{level}}. Use language they can understand at that level — short sentences, common words. Never show off vocabulary they have not met.
The lesson is "{{title}}".
Its learning objectives: {{objectives}}
The student was asked: {{prompt}}
Target vocabulary to work into the conversation naturally: {{vocabulary}}
{{lesson_text}}
{{script}}
HOW TO REPLY
- At most two short sentences, then ONE question. Never more than one question.
- The student should be doing most of the talking. You are not.
{{when_script}}- Follow the dialogue above: ask its questions, in its order, in your own simple words. Do not invent a different conversation and do not skip ahead.
{{when_script}}- Give the student room on each step. If their answer is short, or misses what the dialogue asked for, stay on that step and ask them to say more — an example, a reason, or a detail — before moving on. Only advance once they have genuinely answered it.
- Stay on this lesson's topic. If they wander, bring them back with a question.
- If they make a mistake that would confuse a listener, correct it in a few words
  and move on. Ignore small slips. Never list their errors.
- Do not explain grammar at length. Do not lecture. Do not write paragraphs.
- Write only in English, except a single Arabic word if they are truly stuck.`;

/** Marking a written answer, in a lesson's open-ended block or a quiz. */
export const OPEN_ANSWER_DEFAULT_INSTRUCTIONS = `You are marking one short written answer from an Arabic-speaking student learning English.
The student's level is {{level}}. Judge them against that level, not against a native speaker.
Score each dimension from 0 to 100:
- relevance: does it actually answer the question?
- grammar: correctness, judged against what is reasonable at this level
- vocabulary: range and accuracy of word choice
- clarity: can a reader follow it?
- levelAppropriate: is it what a {{learner_level}} learner should produce?
A good answer should cover: {{key_points}}
The answer was asked to be at least {{min_words}} words.
Then write feedbackAr: at most two short sentences of feedback IN ARABIC,
naming the single most useful thing to fix. Be encouraging and concrete.
Do not list every mistake. Do not lecture.
Optionally add feedbackEn with the same feedback in English.`;

/** The advice sentence on a speaking or pronunciation block. */
export const SPEECH_FEEDBACK_DEFAULT_INSTRUCTIONS = `You advise an Arabic-speaking student on their spoken English.
You are given measurements that have already been computed. Do not
invent a score, do not contradict the numbers, and do not ask for
the audio — you cannot hear it.

Write feedbackAr: at most two short sentences IN ARABIC naming the
single most useful thing to work on next. If specific words were
missed, name two or three of them. Be encouraging and concrete.

If a model answer is given, it is what the task asked for. Say in a
few words whether they actually covered it, and name the one thing
they left out. Judge only whether the content was addressed — never
require their wording to match the model's.

Prefer advice that points at material the student already has:
re-reading the passage while listening to the recording, practising
the named words. Do not suggest more conversation practice.`;

/** Tasks whose instructions the admin panel may replace, and their defaults. */
export const DEFAULT_TASK_PROMPTS: Partial<Record<AITask, string>> = {
  conversation: CONVERSATION_DEFAULT_INSTRUCTIONS,
  open_answer: OPEN_ANSWER_DEFAULT_INSTRUCTIONS,
  feedback: SPEECH_FEEDBACK_DEFAULT_INSTRUCTIONS,
  peer_call_analysis: PEER_CALL_DEFAULT_INSTRUCTIONS,
};

/** Generous for instructions, small enough not to inflate every call's cost. */
export const MAX_TASK_PROMPT_CHARS = 8_000;

export function isPromptEditable(task: AITask): boolean {
  return DEFAULT_TASK_PROMPTS[task] !== undefined;
}

/** The stored override when there is one, otherwise the default. */
export function taskInstructions(task: AITask, stored: string | null | undefined): string {
  const custom = stored?.trim();
  return custom ? custom : (DEFAULT_TASK_PROMPTS[task] ?? "");
}

// ─── Placeholders ─────────────────────────────────────────────────────────────

export interface PromptPlaceholder {
  name: string;
  /** Shown beside the editor, so an admin need not read this file. */
  description: string;
  /**
   * Must stay in an edited prompt. Set on the ones carrying what a content
   * manager authored: without them that work would be silently ignored while
   * the lesson still looked correct in the CMS.
   */
  required: boolean;
}

/** What each task's instructions may refer to. A task absent here has none. */
export const TASK_PROMPT_PLACEHOLDERS: Partial<Record<AITask, PromptPlaceholder[]>> = {
  conversation: [
    { name: "level", description: "The student's level, e.g. A2.1.", required: true },
    { name: "title", description: "The lesson's title.", required: true },
    { name: "objectives", description: "The lesson's learning objectives.", required: true },
    { name: "prompt", description: "What the block asks the student to talk about.", required: true },
    { name: "vocabulary", description: "The lesson's target words.", required: true },
    {
      name: "lesson_text",
      description: "The reading passage with its heading, on a line of its own.",
      required: true,
    },
    {
      name: "script",
      description: "The block's authored dialogue with its heading, on a line of its own.",
      required: true,
    },
    {
      name: "when_script",
      description: "Inserts nothing. Start a line with it to send that line only when the block has a script.",
      required: false,
    },
  ],
  open_answer: [
    { name: "level", description: "The student's level, e.g. A2.1.", required: true },
    {
      name: "learner_level",
      description: 'The student\'s level, or "beginner" when it is unknown.',
      required: false,
    },
    { name: "key_points", description: "What a good answer should cover.", required: true },
    { name: "min_words", description: "The minimum words the block asked for.", required: true },
  ],
};

/** Inserts nothing and only decides whether its line is sent. */
const LINE_CONDITION = "when_script";

/** Matches anything brace-delimited, so a typo is reported and not sent as text. */
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

function placeholdersIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1]!);
}

/**
 * Fill instructions in with one call's data.
 *
 * A line with a placeholder that has no value (null) is left out whole, so a
 * lesson with no objectives does not send "Its learning objectives: ". Filled
 * in one pass: a value is authored or student-derived text, and a `{{script}}`
 * written inside it must stay literal rather than being expanded.
 */
export function renderInstructions(
  template: string,
  values: Record<string, string | null>,
): string {
  return template
    .split("\n")
    .filter((line) => placeholdersIn(line).every((name) => values[name] != null))
    .map((line) => line.replace(PLACEHOLDER, (_match, name: string) => values[name] ?? ""))
    .join("\n");
}

/**
 * Why these instructions cannot be saved, or null when they can.
 *
 * Checked at save, where the admin can act on it. A mistyped placeholder would
 * otherwise drop its line for every student, with nothing visibly wrong.
 */
export function promptTemplateProblem(task: AITask, text: string): string | null {
  const allowed = TASK_PROMPT_PLACEHOLDERS[task] ?? [];
  const used = new Set(placeholdersIn(text));

  const unknown = [...used].filter((name) => !allowed.some((p) => p.name === name));
  if (unknown.length > 0) {
    const available = allowed.length
      ? `Available: ${allowed.map((p) => `{{${p.name}}}`).join(", ")}`
      : "This task has no placeholders";
    return `Unknown placeholder: ${unknown.map((name) => `{{${name}}}`).join(", ")}. ${available}.`;
  }

  const missing = allowed.filter((p) => p.required && !used.has(p.name));
  if (missing.length > 0) {
    return `These placeholders must stay in the instructions: ${missing
      .map((p) => `{{${p.name}}}`)
      .join(", ")}.`;
  }

  // A line goes when any placeholder on it is empty, so two on one line would
  // let a lesson with no word limit silently lose its key points as well.
  for (const line of text.split("\n")) {
    const onLine = new Set(placeholdersIn(line).filter((name) => name !== LINE_CONDITION));
    if (onLine.size > 1) {
      return `Put each placeholder on its own line: ${[...onLine]
        .map((name) => `{{${name}}}`)
        .join(" and ")} share one.`;
    }
  }

  return null;
}
