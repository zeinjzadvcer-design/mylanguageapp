/**
 * Speech to text.
 *
 * Uses the OpenAI `/audio/transcriptions` shape, which Groq's Whisper endpoints
 * and OpenAI itself both implement — the two realistic cheap options. It is a
 * *different* request shape from chat completions (multipart upload, not JSON),
 * which is why the AI configuration keeps a separate `speech` provider role: a
 * chat model cannot hear, and an ASR endpoint cannot reason.
 *
 * WHAT IS ASKED FOR AND WHY
 * ──────────────────────────
 * `verbose_json` with word-level timestamps, not plain text. The transcript
 * alone gives pronunciation accuracy; the *timings* are what make fluency
 * measurable — how long the student hesitated is not in the words. Without
 * timings the fluency half of the assessment cannot be computed at all, so the
 * caller is told when they are missing rather than being handed silent zeroes.
 *
 * NVIDIA Riva ASR does not speak this shape. If that is the endpoint you want,
 * it needs its own client here; the configuration slot is ready for it.
 */

import { AIProviderError } from "./openai-compatible";
import type { ResolvedTaskConfig } from "../ai-config";

export interface TranscribedWord {
  word: string;
  start: number;
  end: number;
}

/**
 * One continuous stretch of speech by one speaker.
 *
 * Only produced when diarization was asked for — a peer call, where telling the
 * two students apart is the whole point. `speaker` is the provider's own label
 * ("A", "B"), which identifies nobody by itself: mapping a label to a student is
 * done separately, and only ever as a guess the caller can see.
 */
export interface TranscriptUtterance {
  speaker: string;
  text: string;
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
}

export interface TranscriptionResult {
  text: string;
  /** Seconds. Falls back to the last word's end time when not reported. */
  durationSeconds: number;
  /** Empty when the provider did not return word timings. */
  words: TranscribedWord[];
  /** True when timings came back, so fluency can be measured. */
  hasWordTimings: boolean;
  modelId: string;
  /** Per-speaker turns. Empty unless diarization was requested and supported. */
  utterances?: TranscriptUtterance[];
  /**
   * How many audio channels the provider billed for.
   *
   * Reported rather than inferred because ASR is sold by the minute PER
   * CHANNEL: the stereo recording that gives peer calls exact speaker
   * attribution costs twice a mono one. A caller that had to guess would
   * silently halve the recorded cost of every evaluated call.
   */
  billedChannels: number;
}

interface VerboseTranscription {
  text?: string;
  duration?: number | string;
  words?: Array<{ word?: string; start?: number; end?: number }>;
  segments?: Array<{ start?: number; end?: number }>;
  error?: { message?: string };
}

const DEFAULT_TIMEOUT_MS = parseInt(process.env.AI_ASR_TIMEOUT_MS ?? "60000", 10);

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/audio/transcriptions`;
}

/**
 * Transcribe one recording.
 *
 * `languageHint` matters more than it looks: telling Whisper the audio is
 * English stops it from "helpfully" transcribing a struggling learner's heavily
 * accented English as Arabic, which would score every word wrong.
 */
export async function transcribe(
  config: ResolvedTaskConfig,
  audio: Uint8Array,
  opts: { fileName: string; contentType: string; languageHint?: string },
): Promise<TranscriptionResult> {
  const form = new FormData();
  // Copied into a fresh ArrayBuffer: a Uint8Array from the S3 client can be a
  // view onto a larger pooled buffer, and Blob would otherwise capture the
  // whole pool rather than just this object's bytes.
  const bytes = new Uint8Array(audio.byteLength);
  bytes.set(audio);
  form.append("file", new Blob([bytes.buffer], { type: opts.contentType }), opts.fileName);
  form.append("model", config.modelId);
  form.append("response_format", "verbose_json");
  // Bracketed key: the array form these APIs expect in multipart.
  form.append("timestamp_granularities[]", "word");
  if (opts.languageHint) form.append("language", opts.languageHint);
  // Zero temperature: transcription should be the same every time, because the
  // score computed from it must be.
  form.append("temperature", "0");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(endpoint(config.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        // Content-Type is deliberately unset: fetch must add the multipart
        // boundary itself, and setting it by hand breaks the request.
        Accept: "application/json",
      },
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new AIProviderError(
      aborted
        ? `Transcription timed out after ${DEFAULT_TIMEOUT_MS}ms`
        : "Could not reach the speech provider",
      0,
      true,
    );
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();

  if (!response.ok) {
    let detail = raw.slice(0, 300);
    try {
      const parsed = JSON.parse(raw) as VerboseTranscription;
      if (parsed.error?.message) detail = parsed.error.message;
    } catch {
      // Not JSON; the truncated body is the best available message.
    }
    throw new AIProviderError(
      `Speech provider returned ${response.status}: ${detail}`,
      response.status,
      response.status === 429 || response.status >= 500,
    );
  }

  let data: VerboseTranscription;
  try {
    data = JSON.parse(raw) as VerboseTranscription;
  } catch {
    throw new AIProviderError("Speech provider returned a response that was not JSON", 0, false);
  }

  if (typeof data.text !== "string") {
    throw new AIProviderError("Speech provider returned no transcript", 0, true);
  }

  const words: TranscribedWord[] = (data.words ?? [])
    .filter(
      (w): w is { word: string; start: number; end: number } =>
        typeof w.word === "string" &&
        typeof w.start === "number" &&
        typeof w.end === "number",
    )
    .map((w) => ({ word: w.word, start: w.start, end: w.end }));

  // Providers report duration as a number or a string, and some omit it. Fall
  // back to the end of the last word, then to the last segment.
  const reported =
    typeof data.duration === "number"
      ? data.duration
      : typeof data.duration === "string"
        ? parseFloat(data.duration)
        : NaN;

  const fromWords = words.length > 0 ? Math.max(...words.map((w) => w.end)) : 0;
  const fromSegments =
    data.segments?.length && typeof data.segments[data.segments.length - 1]?.end === "number"
      ? (data.segments[data.segments.length - 1].end as number)
      : 0;

  const durationSeconds = Number.isFinite(reported)
    ? reported
    : Math.max(fromWords, fromSegments);

  return {
    text: data.text.trim(),
    durationSeconds,
    words,
    hasWordTimings: words.length > 0,
    modelId: config.modelId,
    // This API has no multichannel mode: it mixes down and bills once.
    billedChannels: 1,
  };
}
