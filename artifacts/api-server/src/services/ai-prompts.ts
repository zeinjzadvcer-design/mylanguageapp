/**
 * Default instructions for the AI tasks whose prompt an administrator may edit.
 *
 * Only the INSTRUCTIONS are editable: the voice, the rules, what to focus on.
 * The reply format each grader parses stays in code and is appended after the
 * instructions on every call, because an edited prompt that dropped or reworded
 * the JSON shape would fail every analysis rather than change its tone.
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

/** Tasks whose instructions the admin panel may replace, and their defaults. */
export const DEFAULT_TASK_PROMPTS: Partial<Record<AITask, string>> = {
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
