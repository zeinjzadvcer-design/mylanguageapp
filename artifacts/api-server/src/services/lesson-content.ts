/**
 * The shape a lesson's blocks take for the student.
 *
 * Shared by the student lesson route and the CMS preview, so a content manager
 * previewing a lesson sees exactly what a student would — same fields, same
 * fallbacks, same answer keys withheld. The preview used to render raw rows on
 * its own, which is how it drifted from the real player: it never showed the
 * attached image or played the attached audio.
 */

import type { ContentBlock, Exercise, ExerciseOption, Vocabulary } from "@workspace/db";
import { resolveAudioUrl } from "./learning";

/**
 * Treats a blank string as a missing value. The CMS writes "" for text fields
 * left untouched, so `??` alone would prefer an empty block column over a real
 * value stored on the exercise.
 */
export function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.trim() === "" ? null : value;
}

/**
 * True for blocks whose answer is a recording.
 *
 * A text block joins them when the author asked the student to read it aloud:
 * the recording is matched word by word against the passage, the same
 * arithmetic a pronunciation block uses.
 */
export function isRecordingBlock(block: Pick<ContentBlock, "type" | "expectsReferenceReading">): boolean {
  return (
    block.type === "speaking_prompt" ||
    block.type === "pronunciation_guide" ||
    (block.type === "text" && block.expectsReferenceReading)
  );
}

/**
 * The group a block belongs to, when an author added items to it.
 *
 * A pronunciation or listening block keeps its word, passage and audio on the
 * block row itself, so a second item is a second block. The editor links them
 * with a `groupId` in `config` — a JSON column every block already has — and
 * the student sees one block with several items. Blocks without one, which is
 * every block authored before grouping existed, are a group of their own.
 */
export function groupIdOf(config: unknown): string | null {
  const id = (config as { groupId?: unknown } | null)?.groupId;
  return typeof id === "string" && id !== "" ? id : null;
}

export function toStudentContentBlocks(
  blocks: ContentBlock[],
  exercises: Exercise[],
  allOptions: ExerciseOption[],
  vocab: Vocabulary[],
) {
  return blocks.map((block) => {
    // A block can hold several questions; the singular fields below describe
    // the first, and `questions` carries them all.
    // Callers pass exercises already ordered; filter preserves that order.
    const blockExercises = exercises.filter((e) => e.contentBlockId === block.id);
    const exercise = blockExercises[0] ?? null;
    const optionsFor = (exerciseId: number) =>
      allOptions
        .filter((o) => o.exerciseId === exerciseId)
        .map((o) => ({ id: o.optionId, text: o.text, textAr: o.textAr ?? null }));
    const options = exercise ? optionsFor(exercise.id) : null;

    return {
      id: block.id,
      type: block.type,
      order: block.order,
      title: block.title ?? null,
      titleAr: block.titleAr ?? null,
      instructions: block.instructions ?? null,
      instructionsAr: block.instructionsAr ?? null,
      isRequired: block.isRequired,
      estimatedMinutes: block.estimatedMinutes ?? null,
      config: block.config ?? null,
      groupId: groupIdOf(block.config),
      content: block.content ?? null,
      contentAr: block.contentAr ?? null,
      audioNote: block.audioNote ?? null,
      /** The student reads `content` aloud and is scored against it. */
      expectsReferenceReading: block.expectsReferenceReading,
      vocabularyItems:
        block.type === "vocabulary_list"
          ? vocab.map((v) => ({
              id: v.id,
              levelId: v.levelId,
              lessonId: v.lessonId ?? null,
              word: v.word,
              translation: v.translation,
              exampleSentence: v.exampleSentence ?? null,
              exampleSentenceAr: v.exampleSentenceAr ?? null,
              pronunciation: v.pronunciation ?? null,
              audioNote: v.audioNote ?? null,
            }))
          : null,
      exerciseId: exercise?.id ?? null,
      exerciseType: exercise?.exerciseType ?? null,
      question: exercise?.question ?? null,
      questionAr: exercise?.questionAr ?? null,
      // Never expose correctOptionId before submission
      options,
      /**
       * Every question on this block, in order. Answer keys stay server-side.
       *
       * Speaking and open-ended blocks hold several prompts the same way MCQ
       * blocks hold several questions, so each item carries its own prompt and
       * instructions rather than borrowing the block's.
       */
      questions: blockExercises.map((e) => ({
        exerciseId: e.id,
        exerciseType: e.exerciseType,
        question: e.question,
        questionAr: e.questionAr ?? null,
        options: optionsFor(e.id),
        prompt: emptyToNull(e.prompt) ?? emptyToNull(e.question),
        promptAr: emptyToNull(e.promptAr) ?? emptyToNull(e.questionAr),
        instructions: emptyToNull(e.instructionsText),
        instructionsAr: emptyToNull(e.instructionsAr),
      })),
      // The CMS speaking and open-ended editors write the question onto the
      // exercise row, while every other block type carries it on the block
      // itself. Fall back to the exercise so a block authored that way still
      // shows its prompt instead of an empty screen. `question` is the
      // open-ended editor's field, `prompt` the speaking one's. Empty strings
      // count as absent: the editor saves "" rather than NULL for a field it
      // never filled.
      prompt:
        emptyToNull(block.prompt) ??
        emptyToNull(exercise?.prompt) ??
        emptyToNull(exercise?.question) ??
        null,
      promptAr:
        emptyToNull(block.promptAr) ??
        emptyToNull(exercise?.promptAr) ??
        emptyToNull(exercise?.questionAr) ??
        null,
      exampleAudio: block.exampleAudio ?? null,
      audioUrl: resolveAudioUrl(block, exercise),
      // Resolved to a playable URL by the client through /media/:id/url rather
      // than presigned here — a lesson can hold many blocks, and signing every
      // one on every load would be wasted work for the ones never played.
      referenceMediaId: block.referenceMediaId ?? null,
      // Resolved to a playable URL by the client, same as referenceMediaId.
      imageMediaId: block.imageMediaId ?? null,
      audioMediaId: block.audioMediaId ?? null,
    };
  });
}

export type StudentContentBlock = ReturnType<typeof toStudentContentBlocks>[number];
