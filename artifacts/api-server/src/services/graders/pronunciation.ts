/**
 * Assessing a spoken answer.
 *
 * Spec section 4A: the student reads a prepared passage aloud, and a score of
 * 75% or better passes. That number gates progress, so it is measured, not
 * guessed:
 *
 *   1. Speech to text, with word timings.
 *   2. Align the transcript against the passage → pronunciation score.
 *   3. Compute fluency from the timings → fluency score.
 *   4. Optionally, one small model call to turn the numbers into a sentence
 *      of Arabic advice.
 *
 * Only step 4 involves a language model, and only for wording. Steps 2 and 3
 * are arithmetic, which is why the same recording always produces the same
 * score and why a student who disputes one can be shown exactly which words
 * were missed.
 *
 * WHAT THIS DOES NOT DO
 * ──────────────────────
 * It is not phoneme-level assessment. A word mispronounced badly enough that
 * the recogniser hears a different word is caught; a subtle vowel error the
 * recogniser resolves correctly is not. For a read-aloud exercise that is the
 * right signal — did they say the words on the page — but it is not the same
 * thing a dedicated pronunciation-assessment API measures, and the docs say so.
 */

import { z } from "zod";
import type { AITask } from "@workspace/db";
import {
  resolveTaskConfig,
  computeCostUsd,
  computeAudioCostUsd,
  AIUnavailableError,
} from "../ai-config";
import { transcribe } from "../ai-providers";
import { chatJson, AIProviderError } from "../ai-providers";
import { checkAndIncrement, recordUsage } from "../ai-quota";
import { storage } from "../storage";
import {
  alignTranscript,
  pronunciationScore,
  countFillers,
  type AlignmentResult,
} from "../scoring/alignment";
import {
  computeFluencyMetrics,
  scoreFluency,
  type FluencyMetrics,
} from "../scoring/fluency";
import { GradingUnavailableError, type GradingContext } from "./open-answer";
import { logger } from "../../lib/logger";

const ASR_TASK: AITask = "transcription";
const FEEDBACK_TASK: AITask = "feedback";

export interface SpeechInput {
  /** Storage key of the student's recording. */
  mediaKey: string;
  mimeType: string;
  /** The passage the student was asked to read. Null for open speaking. */
  referenceText: string | null;
  /** Judged against this level's fluency expectations. */
  levelCode: string | null;
  /** What the block asked, used only for the feedback sentence. */
  prompt?: string | null;
  /**
   * The answer a content manager authored as the standard, for an open speaking
   * prompt. Pronunciation and fluency stay arithmetic — this reaches only the
   * adviser, so its sentence can say whether the student addressed the task.
   */
  modelAnswer?: string | null;
}

export interface SpeechVerdict {
  transcript: string;
  /** Null when there was no passage to compare against. */
  pronunciationScore: number | null;
  fluencyScore: number;
  /** The overall mark recorded for the block. */
  score: number;
  metrics: FluencyMetrics;
  /** Null when there was no passage. */
  alignment: AlignmentResult | null;
  /** Reference words that were wrong or missed — what to practise. */
  problemWords: string[];
  /** Arabic. Null when the feedback task is off or unavailable. */
  feedback: string | null;
  /** True when the recogniser returned no word timings, so fluency is a guess. */
  fluencyUnavailable: boolean;
  meta: { provider: string; modelId: string; tokensUsed: number };
}

const feedbackSchema = z.object({
  feedbackAr: z.string().min(1).max(400),
});

/**
 * How the two halves combine into the recorded mark.
 *
 * Pronunciation dominates a read-aloud exercise: the task was to say these
 * words, and fluency is secondary to having said them. With no passage to read,
 * fluency is all there is.
 *
 * When the recogniser returned no word timings, fluency is not zero — it is
 * unknown, and folding an unknown in as a zero would drop a student who read
 * the passage at 78% down to 55%. They would be marked down for a limitation of
 * the transcription service. In that case the mark is pronunciation alone.
 */
export function combineScores(
  pronunciation: number | null,
  fluency: number,
  fluencyMeasured = true,
): number {
  if (!fluencyMeasured) return pronunciation ?? 0;
  if (pronunciation === null) return fluency;
  return Math.round(pronunciation * 0.7 + fluency * 0.3);
}

/**
 * Assess one recording.
 *
 * Throws `GradingUnavailableError` for every case where the right answer is
 * "leave it pending" — AI off, no speech provider, out of quota, provider
 * unreachable. A failure to assess must never become a bad mark, because the
 * mark gates progression.
 */
export async function assessSpeech(
  input: SpeechInput,
  ctx: GradingContext,
): Promise<SpeechVerdict> {
  let asrConfig;
  try {
    asrConfig = await resolveTaskConfig(ASR_TASK);
  } catch (err) {
    if (err instanceof AIUnavailableError) {
      throw new GradingUnavailableError(err.reason, err.message);
    }
    throw err;
  }

  try {
    await checkAndIncrement({
      userId: ctx.userId,
      subscriptionPlan: ctx.subscriptionPlan,
      task: ASR_TASK,
      feature: "pronunciation_evaluation",
    });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    throw new GradingUnavailableError(
      code ?? "QUOTA_UNAVAILABLE",
      err instanceof Error ? err.message : "Quota check failed",
    );
  }

  // Fetch the bytes only after the quota is claimed: no point paying the
  // download if the request was never going to be allowed.
  let audio: Uint8Array;
  try {
    audio = await storage.download(input.mediaKey);
  } catch (err) {
    logger.error({ err, key: input.mediaKey }, "Could not download recording for assessment");
    throw new GradingUnavailableError("AUDIO_UNAVAILABLE", "The recording could not be read");
  }

  const started = Date.now();
  let succeeded = false;
  let tokensUsed = 0;
  // Captured here so the `finally` can record it even when scoring throws
  // after the provider has already billed for the audio.
  let audioCostUsd: number | null = null;

  try {
    const asr = await transcribe(asrConfig, audio, {
      fileName: input.mediaKey.split("/").pop() ?? "recording.webm",
      contentType: input.mimeType,
      // Telling the recogniser the audio is English stops it transcribing a
      // heavily accented learner as Arabic, which would score every word wrong.
      languageHint: "en",
    });
    succeeded = true;
    audioCostUsd = computeAudioCostUsd(asrConfig, {
      durationSeconds: asr.durationSeconds,
      channels: asr.billedChannels,
    });

    const alignment = input.referenceText
      ? alignTranscript(input.referenceText, asr.text)
      : null;

    const pronunciation = alignment ? pronunciationScore(alignment) : null;

    // Counted from the transcript, not from the alignment: open speaking has
    // no passage to align against, and taking the count from there meant its
    // fillers were never counted at all.
    const metrics = computeFluencyMetrics(
      asr.words,
      asr.durationSeconds,
      countFillers(asr.text),
    );
    const fluency = scoreFluency(metrics, input.levelCode);

    const verdict: SpeechVerdict = {
      transcript: asr.text,
      pronunciationScore: pronunciation,
      fluencyScore: fluency.score,
      score: combineScores(pronunciation, fluency.score, asr.hasWordTimings),
      metrics,
      alignment,
      problemWords: alignment?.problemWords.slice(0, 12) ?? [],
      feedback: null,
      // Without timings there is nothing to measure fluency from. Say so rather
      // than reporting a zero that looks like a judgement.
      fluencyUnavailable: !asr.hasWordTimings,
      meta: {
        provider: asrConfig.providerLabel,
        modelId: asr.modelId,
        tokensUsed: 0,
      },
    };

    verdict.feedback = await writeFeedback(verdict, input, ctx);
    return verdict;
  } catch (err) {
    if (err instanceof AIProviderError) {
      throw new GradingUnavailableError("PROVIDER_ERROR", err.message);
    }
    throw err;
  } finally {
    void recordUsage({
      userId: ctx.userId,
      subscriptionPlan: ctx.subscriptionPlan,
      task: ASR_TASK,
      feature: "pronunciation_evaluation",
      provider: asrConfig.providerLabel,
      modelId: asrConfig.modelId,
      // Transcription is billed by audio length, not tokens, so the token
      // count stays zero and the cost is computed from the duration.
      tokensUsed,
      costUsd: audioCostUsd ?? undefined,
      succeeded,
      latencyMs: Date.now() - started,
    });
  }
}

/**
 * One short model call turning the numbers into a sentence of Arabic advice.
 *
 * Deliberately separate, deliberately optional, and deliberately given only the
 * measurements — never the audio and never a request for a score. If it fails
 * or the task is switched off, the student still gets their marks; they just do
 * not get the sentence. That is the whole reason feedback is a different task
 * from assessment.
 */
async function writeFeedback(
  verdict: SpeechVerdict,
  input: SpeechInput,
  ctx: GradingContext,
): Promise<string | null> {
  let config;
  try {
    config = await resolveTaskConfig(FEEDBACK_TASK);
  } catch {
    return null;
  }

  try {
    await checkAndIncrement({
      userId: ctx.userId,
      subscriptionPlan: ctx.subscriptionPlan,
      task: FEEDBACK_TASK,
      feature: "pronunciation_evaluation",
    });
  } catch {
    return null;
  }

  const facts = [
    input.referenceText
      ? `Read-aloud accuracy: ${verdict.pronunciationScore}% of the passage said correctly.`
      : `Open speaking, no set passage.`,
    verdict.problemWords.length
      ? `Words they got wrong or skipped: ${verdict.problemWords.join(", ")}.`
      : `No words were missed.`,
    `Speaking pace: ${verdict.metrics.speechRate} words per minute.`,
    `Pauses: ${verdict.metrics.pauseCount} (${verdict.metrics.longPauseCount} of a second or more).`,
    `Words between pauses: ${verdict.metrics.meanLengthOfRun}.`,
    `Hesitation sounds per 100 words: ${verdict.metrics.fillersPer100Words}.`,
    input.levelCode ? `The student's level is ${input.levelCode}.` : "",
    input.prompt ? `They were asked: ${input.prompt}` : "",
    // Content, not pronunciation. Given only to the adviser: the marks above
    // remain measurements, so a student who spoke clearly is never penalised
    // here for choosing different words than the author did.
    input.modelAnswer ? `A model answer covers: ${input.modelAnswer.slice(0, 600)}` : "",
    verdict.transcript ? `What they actually said: ${verdict.transcript}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const started = Date.now();
  let succeeded = false;
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  try {
    const result = await chatJson(
      config,
      [
        {
          role: "system",
          content: [
            "You advise an Arabic-speaking student on their spoken English.",
            "You are given measurements that have already been computed. Do not",
            "invent a score, do not contradict the numbers, and do not ask for",
            "the audio — you cannot hear it.",
            "",
            "Write feedbackAr: at most two short sentences IN ARABIC naming the",
            "single most useful thing to work on next. If specific words were",
            "missed, name two or three of them. Be encouraging and concrete.",
            "",
            "If a model answer is given, it is what the task asked for. Say in a",
            "few words whether they actually covered it, and name the one thing",
            "they left out. Judge only whether the content was addressed — never",
            "require their wording to match the model's.",
            "",
            "Prefer advice that points at material the student already has:",
            "re-reading the passage while listening to the recording, practising",
            "the named words. Do not suggest more conversation practice.",
            "",
            'Reply with ONLY a JSON object: {"feedbackAr": "..."}',
          ].join("\n"),
        },
        { role: "user", content: facts },
      ],
      (value) => feedbackSchema.parse(value),
    );

    usage = result.usage;
    succeeded = true;
    return result.value.feedbackAr.trim();
  } catch (err) {
    // The marks are already computed and safe. Losing the sentence is a
    // degradation, not a failure.
    logger.info(
      { err: err instanceof Error ? err.message : err },
      "Speech feedback sentence unavailable",
    );
    return null;
  } finally {
    void recordUsage({
      userId: ctx.userId,
      subscriptionPlan: ctx.subscriptionPlan,
      task: FEEDBACK_TASK,
      feature: "pronunciation_evaluation",
      provider: config.providerLabel,
      modelId: config.modelId,
      tokensUsed: usage.totalTokens,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costUsd: computeCostUsd(config, usage) ?? undefined,
      succeeded,
      latencyMs: Date.now() - started,
    });
  }
}
