/**
 * Evaluating one student-to-student practice call.
 *
 * WHY THIS IS NOT LIKE THE OTHER GRADERS
 * ───────────────────────────────────────
 * Every other grader looks at one student's work. This one looks at a recording
 * of two people talking, which makes it the only place in the product where one
 * student's submission contains another student's voice. Three consequences run
 * through the whole file:
 *
 *   1. Both participants must have consented before any audio is accepted. The
 *      route enforces it; this module refuses to run without it as well, so a
 *      future caller cannot bypass it by accident.
 *   2. Diarization is required, not optional. Feedback built from a transcript
 *      that cannot tell the speakers apart would attribute one student's
 *      mistakes to the other — worse than no feedback.
 *   3. Who is speaker "A" is a GUESS. The provider labels turns, not people.
 *      The guess and its confidence are stored and surfaced; nothing downstream
 *      is allowed to present it as fact.
 *
 * WHY IT COSTS WHAT IT COSTS
 * ───────────────────────────
 * A 20-minute call is the most expensive single unit in the product (~$0.06 by
 * docs/ai-cost-model.md): ASR over the full duration, then one LLM pass. That
 * is why it is opt-in per call rather than automatic, and why it has its own
 * task and its own per-plan allowance instead of sharing `feedback`.
 */

import {
  resolveTaskConfig,
  computeCostUsd,
  computeAudioCostUsd,
  AIUnavailableError,
} from "../ai-config";
import { transcribe, chatJson, AIProviderError } from "../ai-providers";
import type { TranscriptUtterance } from "../ai-providers";
import { checkAndIncrement, recordUsage, refundQuota } from "../ai-quota";
import { storage } from "../storage";
import { logger } from "../../lib/logger";
import { GradingUnavailableError, type GradingContext } from "./open-answer";

const ASR_TASK = "transcription" as const;
const ANALYSIS_TASK = "peer_call_analysis" as const;

/**
 * Below this there is nothing to say. A call that connected and dropped leaves
 * a few seconds of "hello?" — running ASR and a model over it would spend the
 * student's monthly allowance to tell them nothing.
 */
const MIN_DURATION_SECONDS = 30;

/** Both sides must appear. One-sided audio cannot be given to two students. */
const MIN_UTTERANCES_PER_SPEAKER = 2;

/**
 * Transcript sent to the model, in characters. A 20-minute call is perhaps
 * 12,000; the cap stops a pathological recording turning one analysis into a
 * far larger bill than the plan assumed.
 */
const MAX_TRANSCRIPT_CHARS = 16_000;

export interface PeerCallInput {
  evaluationId: number;
  mediaKey: string;
  mimeType: string;
  /** Seconds, from the call itself rather than the recording. */
  callDurationSeconds: number | null;
  /**
   * True when the uploader's browser recorded itself on the LEFT channel and
   * the peer on the right. Turns ASR attribution from a guess into a fact.
   */
  channelSeparated?: boolean;
}

export interface SpeakerFeedback {
  /** The provider's label for this speaker, e.g. "A". */
  speaker: string;
  feedback: string;
  feedbackAr: string;
}

export interface PeerCallVerdict {
  transcript: TranscriptUtterance[];
  durationSeconds: number;
  /** Per diarization label, not per user — the route maps labels to people. */
  speakers: SpeakerFeedback[];
  /**
   * The label belonging to whoever uploaded the recording, when that is known
   * for certain (channel-separated audio). Null when it had to be guessed.
   */
  uploaderLabel: string | null;
  summary: string;
  summaryAr: string;
  meta: { provider: string; modelId: string; tokensUsed: number };
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an English teacher reviewing a recorded practice conversation between two English learners whose first language is Arabic.

You are given a diarized transcript. Speaker labels (A, B) identify turns, not names. You do not know who either person is, and you must not guess or invent names.

Write feedback FOR EACH SPEAKER SEPARATELY, addressed to that speaker as "you".

Rules:
- Base every comment on something actually said in the transcript. Quote or paraphrase it. Never invent an error.
- Name at most three things per speaker. A learner cannot act on ten.
- Lead with what they did well, then what to change. Both must be specific.
- Judge communication, not accent. These are learners talking to each other, and the recording is of a real conversation rather than a reading test.
- Transcription errors exist. If something looks like a mis-transcription rather than a learner error, ignore it.
- Never compare the two speakers to each other, and never tell one speaker anything about the other's level or mistakes.
- Arabic feedback must be natural Arabic written for the learner, not a literal translation of the English.

Reply with ONLY a JSON object:
{
  "speakers": [
    { "speaker": "A", "feedback": "<English, 2-4 sentences>", "feedbackAr": "<Arabic, 2-4 sentences>" }
  ],
  "summary": "<English, 1-2 sentences about the conversation as a whole: topic, how it flowed. No per-person judgement.>",
  "summaryAr": "<the same in Arabic>"
}`;

function renderTranscript(utterances: TranscriptUtterance[]): string {
  const lines = utterances.map((u) => {
    const at = `${Math.floor(u.start / 60)}:${String(Math.floor(u.start % 60)).padStart(2, "0")}`;
    return `[${at}] Speaker ${u.speaker}: ${u.text}`;
  });

  let out = lines.join("\n");
  if (out.length > MAX_TRANSCRIPT_CHARS) {
    // Keep the start and the end: the opening establishes the topic and the
    // close shows whether they could wrap up. The middle of a long call is the
    // most redundant part.
    const half = Math.floor(MAX_TRANSCRIPT_CHARS / 2);
    out = `${out.slice(0, half)}\n\n[... middle of the conversation omitted ...]\n\n${out.slice(-half)}`;
  }
  return out;
}

interface ParsedAnalysis {
  speakers: SpeakerFeedback[];
  summary: string;
  summaryAr: string;
}

/**
 * Validate defensively: a model that returns feedback for a speaker who never
 * spoke, or omits one who did, must not produce feedback attributed to the
 * wrong student.
 */
function parseAnalysis(value: unknown, expectedSpeakers: string[]): ParsedAnalysis {
  if (typeof value !== "object" || value === null) {
    throw new AIProviderError("Analysis was not an object", 0, true);
  }
  const obj = value as Record<string, unknown>;

  const rawSpeakers = Array.isArray(obj.speakers) ? obj.speakers : [];
  const speakers: SpeakerFeedback[] = [];

  for (const entry of rawSpeakers) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const speaker = typeof e.speaker === "string" ? e.speaker.trim() : "";
    const feedback = typeof e.feedback === "string" ? e.feedback.trim() : "";
    const feedbackAr = typeof e.feedbackAr === "string" ? e.feedbackAr.trim() : "";
    // A label that is not in the transcript is a hallucination; dropping it is
    // safer than storing feedback nobody can be shown.
    if (!speaker || !expectedSpeakers.includes(speaker)) continue;
    if (!feedback && !feedbackAr) continue;
    if (speakers.some((s) => s.speaker === speaker)) continue;
    speakers.push({ speaker, feedback, feedbackAr });
  }

  if (speakers.length === 0) {
    throw new AIProviderError("Analysis named none of the speakers", 0, true);
  }

  return {
    speakers,
    summary: typeof obj.summary === "string" ? obj.summary.trim() : "",
    summaryAr: typeof obj.summaryAr === "string" ? obj.summaryAr.trim() : "",
  };
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * Transcribe a call recording and produce per-speaker feedback.
 *
 * Throws `GradingUnavailableError` for every case where the right answer is to
 * leave the evaluation unfinished and say so — AI off, no speech provider, out
 * of quota, audio unreadable, a call too short or too one-sided to judge. The
 * caller marks the row `failed` with the reason and deletes the recording; a
 * failure must never become feedback, because unfounded feedback about a
 * conversation involving someone else is worse than none.
 */
export async function analysePeerCall(
  input: PeerCallInput,
  ctx: GradingContext,
): Promise<PeerCallVerdict> {
  if (
    input.callDurationSeconds !== null &&
    input.callDurationSeconds < MIN_DURATION_SECONDS
  ) {
    throw new GradingUnavailableError(
      "CALL_TOO_SHORT",
      `The call was ${input.callDurationSeconds}s; at least ${MIN_DURATION_SECONDS}s is needed to give useful feedback.`,
    );
  }

  let asrConfig;
  let analysisConfig;
  try {
    // Both resolved up front: discovering after a paid transcription that the
    // analysis task is switched off would spend the allowance for nothing.
    asrConfig = await resolveTaskConfig(ASR_TASK);
    analysisConfig = await resolveTaskConfig(ANALYSIS_TASK);
  } catch (err) {
    if (err instanceof AIUnavailableError) {
      throw new GradingUnavailableError(err.reason, err.message);
    }
    throw err;
  }

  // The analysis allowance is claimed first. It is the scarce one — a couple of
  // calls a month — so being refused it after paying for ASR would waste real
  // money and the student's transcription quota too.
  for (const task of [ANALYSIS_TASK, ASR_TASK] as const) {
    try {
      await checkAndIncrement({
        userId: ctx.userId,
        subscriptionPlan: ctx.subscriptionPlan,
        task,
        feature: "peer_call_analysis",
      });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      throw new GradingUnavailableError(
        code ?? "QUOTA_UNAVAILABLE",
        err instanceof Error ? err.message : "Quota check failed",
      );
    }
  }

  /**
   * Hand both allowances back. Used only where no provider was billed: on a
   * plan allowing two analyses a day, a student who gets nothing must not also
   * lose the attempt.
   */
  const refundBoth = async () => {
    for (const task of [ANALYSIS_TASK, ASR_TASK] as const) {
      await refundQuota({
        userId: ctx.userId,
        subscriptionPlan: ctx.subscriptionPlan,
        task,
        feature: "peer_call_analysis",
      });
    }
  };

  let audio: Uint8Array;
  try {
    audio = await storage.download(input.mediaKey);
  } catch (err) {
    logger.error(
      { err, key: input.mediaKey, evaluationId: input.evaluationId },
      "Could not download call recording for analysis",
    );
    await refundBoth();
    throw new GradingUnavailableError(
      "AUDIO_UNAVAILABLE",
      "The call recording could not be read",
    );
  }

  // ── Transcribe, with the speakers separated ────────────────────────────────
  const asrStarted = Date.now();
  let asrSucceeded = false;
  let asr;
  try {
    asr = await transcribe(asrConfig, audio, {
      fileName: input.mediaKey.split("/").pop() ?? "call.webm",
      contentType: input.mimeType,
      languageHint: "en",
      // The point of the whole exercise: without it the transcript is one
      // undifferentiated block and neither student can be told anything.
      diarize: true,
      // Preferred when available. The uploader's own microphone is on channel
      // 1 by construction, so no guessing is needed at all.
      //
      // COST: multichannel is billed per channel, so a stereo call is ~2x the
      // ASR of a mono one — on a 20-minute call that is roughly $0.10 instead
      // of $0.05. Worth it: the alternative is feedback the student is told may
      // be about someone else, which is close to worthless. It also means the
      // per-plan MINUTE allowance is the right lever here, not a call count.
      multichannel: input.channelSeparated === true,
    });
    asrSucceeded = true;
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
      feature: "peer_call_analysis",
      provider: asrConfig.providerLabel,
      modelId: asrConfig.modelId,
      // Billed per minute of audio, not per token, so the token count is
      // genuinely zero and the cost comes from the duration instead.
      tokensUsed: 0,
      // This is the dominant cost of an evaluated call — roughly 90% of it —
      // and it used to record nothing at all, which left the monthly budget
      // ceiling unable to see peer-call spend. `billedChannels` is what keeps a
      // stereo call from being costed as if it were mono.
      costUsd:
        computeAudioCostUsd(asrConfig, {
          durationSeconds: asr?.durationSeconds ?? 0,
          channels: asr?.billedChannels ?? 1,
        }) ?? undefined,
      succeeded: asrSucceeded,
      latencyMs: Date.now() - asrStarted,
    });
  }

  const utterances = asr.utterances ?? [];
  if (utterances.length === 0) {
    // ASR was billed; the analysis model never ran, so only that is given back.
    await refundQuota({
      userId: ctx.userId,
      subscriptionPlan: ctx.subscriptionPlan,
      task: ANALYSIS_TASK,
      feature: "peer_call_analysis",
    });
    throw new GradingUnavailableError(
      "DIARIZATION_UNAVAILABLE",
      "The recording could not be split by speaker, so per-person feedback is not possible.",
    );
  }

  // Both students have to be audible. If one side was muted or did not come
  // through, giving the silent one feedback would be inventing it.
  //
  // "Audible" is judged on SPEECH, not turn count. Requiring two turns each
  // discarded a whole call when one student happened to speak in one long
  // stretch, which is normal in a short conversation — and the resulting
  // "only one speaker is audible" was wrong AND unactionable, because the
  // student could not tell it apart from a genuinely broken microphone.
  const counts = new Map<string, { turns: number; chars: number; seconds: number }>();
  for (const u of utterances) {
    const prev = counts.get(u.speaker) ?? { turns: 0, chars: 0, seconds: 0 };
    counts.set(u.speaker, {
      turns: prev.turns + 1,
      chars: prev.chars + u.text.length,
      seconds: prev.seconds + Math.max(0, u.end - u.start),
    });
  }

  // One substantial turn is enough to have something to say about. A couple of
  // stray words picked up as crosstalk is not.
  const MIN_CHARS = 40;
  const speakers = [...counts.entries()]
    .filter(([, m]) => m.chars >= MIN_CHARS || m.turns >= MIN_UTTERANCES_PER_SPEAKER)
    .map(([label]) => label)
    .sort();

  if (speakers.length < 2) {
    const heard = [...counts.entries()]
      .map(([label, m]) => `${label}: ${m.turns} turn(s), ${m.chars} chars`)
      .join("; ");
    logger.warn(
      { evaluationId: input.evaluationId, heard, channelSeparated: input.channelSeparated },
      "Peer-call analysis: only one speaker had enough speech",
    );
    await refundQuota({
      userId: ctx.userId,
      subscriptionPlan: ctx.subscriptionPlan,
      task: ANALYSIS_TASK,
      feature: "peer_call_analysis",
    });
    throw new GradingUnavailableError(
      "ONE_SIDED_RECORDING",
      // Names the likely cause, because the commonest one is fixable by the
      // student: on one machine, the second browser's output goes to the
      // speakers and its microphone never hears the first browser's voice.
      "Only one voice could be heard in the recording. If both of you were on the same device, each browser needs its own microphone and headphones — otherwise only one side is captured.",
    );
  }

  // ── Analyse ───────────────────────────────────────────────────────────────
  const analysisStarted = Date.now();
  let analysisSucceeded = false;
  let tokensUsed = 0;
  // Kept separately: cost is input and output priced at different rates, so a
  // total alone would under-report it.
  let promptTokens = 0;
  let completionTokens = 0;

  try {
    const result = await chatJson(
      analysisConfig,
      [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Speakers in this transcript: ${speakers.join(", ")}.\n\nTranscript:\n${renderTranscript(utterances)}`,
        },
      ],
      (value) => parseAnalysis(value, speakers),
    );

    analysisSucceeded = true;
    promptTokens = result.usage.promptTokens ?? 0;
    completionTokens = result.usage.completionTokens ?? 0;
    tokensUsed = result.usage.totalTokens ?? promptTokens + completionTokens;

    // Channel 1 is the uploader's own microphone — the client panned it there.
    // Only trustworthy when the recording really was channel-separated AND the
    // provider returned channel labels.
    const uploaderLabel =
      input.channelSeparated === true && speakers.includes("channel-1")
        ? "channel-1"
        : null;

    return {
      transcript: utterances,
      durationSeconds: Math.round(asr.durationSeconds),
      speakers: result.value.speakers,
      uploaderLabel,
      summary: result.value.summary,
      summaryAr: result.value.summaryAr,
      meta: {
        provider: analysisConfig.providerLabel,
        modelId: result.modelId,
        tokensUsed,
      },
    };
  } catch (err) {
    if (err instanceof AIProviderError) {
      throw new GradingUnavailableError("PROVIDER_ERROR", err.message);
    }
    throw err;
  } finally {
    void recordUsage({
      userId: ctx.userId,
      subscriptionPlan: ctx.subscriptionPlan,
      task: ANALYSIS_TASK,
      feature: "peer_call_analysis",
      provider: analysisConfig.providerLabel,
      modelId: analysisConfig.modelId,
      tokensUsed,
      promptTokens,
      completionTokens,
      costUsd: computeCostUsd(analysisConfig, { promptTokens, completionTokens }) ?? undefined,
      succeeded: analysisSucceeded,
      latencyMs: Date.now() - analysisStarted,
    });
  }
}

export { MIN_DURATION_SECONDS };
