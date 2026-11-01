/**
 * Speech to text via AssemblyAI.
 *
 * A separate adapter from `openai-audio.ts` because AssemblyAI is not
 * OpenAI-shaped. Three things differ and all three break the other adapter:
 *
 *   auth      `authorization: <key>` — the raw key, no "Bearer " prefix
 *   flow      upload, then submit, then POLL — not one multipart round trip
 *   units     word timings come back in MILLISECONDS, not seconds
 *
 * Exposes the same `transcribe` contract as the OpenAI adapter, so the
 * pronunciation grader and the conversation service do not care which engine is
 * behind the `transcription` task.
 *
 * WHY THIS ENGINE IS WORTH THE EXTRA ADAPTER
 * ───────────────────────────────────────────
 * It is the cheapest managed ASR at the time of writing and — unlike Groq's
 * Whisper endpoints — reachable from the networks this project is developed on.
 * It also reports word-level timings, without which the fluency half of the
 * speech assessment cannot be computed at all.
 */

import { AIProviderError } from "./openai-compatible";
import type { ResolvedTaskConfig } from "../ai-config";
import type {
  TranscriptionResult,
  TranscribedWord,
  TranscriptUtterance,
} from "./openai-audio";

/** Upload and submit are quick; the wait is in `pollTranscript`. */
const REQUEST_TIMEOUT_MS = parseInt(process.env.AI_ASR_TIMEOUT_MS ?? "60000", 10);

/**
 * How long to wait for a transcript before giving up.
 *
 * Generous because this is a queue, not a synchronous call: a cold queue can
 * sit for tens of seconds before processing starts. The caller leaves the
 * attempt pending on failure, so a timeout costs a retry, not a lost recording.
 */
const POLL_TIMEOUT_MS = parseInt(process.env.AI_ASR_POLL_TIMEOUT_MS ?? "180000", 10);

/**
 * How long to wait between asking whether the transcript is ready.
 *
 * A flat 2000 ms meant up to two seconds of every job was spent not knowing an
 * answer that already existed, in front of a student watching a spinner.
 *
 * A fast start then a flat 1500 ms, which measures as a worst case of 1.25 s
 * against the old 1.75 s for a transcript landing anywhere in the first twelve
 * seconds. The cap stays BELOW the old interval deliberately: a schedule that
 * backs off past 2000 ms is worse than what it replaced for any job slower
 * than its ramp, which is the mistake the first attempt at this made.
 *
 * Modest — about half a second — and the client's own poll schedule was the
 * larger share of the delay. The cost is ~122 requests across the three-minute
 * timeout rather than 90, and almost no job runs that long.
 */
const POLL_SCHEDULE_MS = [500, 500, 750, 1000];
const POLL_INTERVAL_MAX_MS = 1500;

/** Wait before poll number `n` (zero-based). */
function pollDelay(n: number): number {
  return POLL_SCHEDULE_MS[n] ?? POLL_INTERVAL_MAX_MS;
}

interface AssemblyWord {
  text?: string;
  start?: number;
  end?: number;
}

interface AssemblyUtterance {
  speaker?: string | null;
  /** Present in multichannel mode: "1" is the first channel, "2" the second. */
  channel?: string | null;
  text?: string | null;
  start?: number | null;
  end?: number | null;
}

interface AssemblyTranscript {
  id?: string;
  status?: "queued" | "processing" | "completed" | "error";
  text?: string | null;
  words?: AssemblyWord[] | null;
  utterances?: AssemblyUtterance[] | null;
  audio_duration?: number | null;
  error?: string | null;
}

function base(config: ResolvedTaskConfig): string {
  return config.baseUrl.replace(/\/+$/, "");
}

function headers(config: ResolvedTaskConfig): Record<string, string> {
  // Not "Bearer": AssemblyAI takes the bare key in this header.
  return { authorization: config.apiKey };
}

/** 429 and 5xx are worth retrying; a bad key or a malformed request is not. */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new AIProviderError(
      aborted ? `${what} timed out after ${ms}ms` : `Could not reach the AI provider`,
      0,
      true,
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Step 1: hand over the bytes, get back a URL only AssemblyAI can read. */
async function upload(config: ResolvedTaskConfig, audio: Uint8Array): Promise<string> {
  // Copied into a fresh ArrayBuffer: a Uint8Array from the S3 client can be a
  // view onto a larger pooled buffer, and we would otherwise send the pool.
  const bytes = new Uint8Array(audio.byteLength);
  bytes.set(audio);

  const response = await withTimeout(
    (signal) =>
      fetch(`${base(config)}/v2/upload`, {
        method: "POST",
        headers: { ...headers(config), "content-type": "application/octet-stream" },
        body: bytes,
        signal,
      }),
    REQUEST_TIMEOUT_MS,
    "Audio upload",
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new AIProviderError(
      `Audio upload failed: ${response.status} ${detail.slice(0, 200)}`,
      response.status,
      isRetryable(response.status),
    );
  }

  const data = (await response.json()) as { upload_url?: string };
  if (!data.upload_url) {
    throw new AIProviderError("Audio upload returned no URL", 0, true);
  }
  return data.upload_url;
}

/** Step 2: queue the job. */
async function submit(
  config: ResolvedTaskConfig,
  audioUrl: string,
  languageHint?: string,
  diarize?: boolean,
  multichannel?: boolean,
): Promise<string> {
  const body: Record<string, unknown> = {
    audio_url: audioUrl,
    // Off, deliberately. Formatting rewrites spoken words into written forms —
    // "three" becomes "3" — and the read-aloud score is a word-by-word
    // comparison against the reference passage. A student who said the word
    // correctly would be marked wrong for how the engine chose to spell it.
    format_text: false,
  };
  // Telling it the audio is English stops a struggling learner's heavily
  // accented English being "helpfully" transcribed as Arabic, which would
  // score every word wrong.
  if (languageHint) body.language_code = languageHint;
  // Peer calls only. Two students share one recording, so feedback is useless
  // unless their turns can be told apart. Left off everywhere else: it costs
  // extra processing and a read-aloud recording has one speaker by definition.
  if (multichannel) {
    // Preferred over diarization when the client could record in stereo: each
    // channel is transcribed on its own, so a turn's channel IS the speaker.
    // Diarization only clusters voices — it cannot say which cluster is which
    // person, and guessing that was wrong about half the time.
    body.multichannel = true;
  } else if (diarize) {
    body.speaker_labels = true;
    // The call is one-to-one. Saying so stops a noisy line or a bystander's
    // voice being split out as a third participant and attributed to nobody.
    body.speakers_expected = 2;
  }

  const response = await withTimeout(
    (signal) =>
      fetch(`${base(config)}/v2/transcript`, {
        method: "POST",
        headers: { ...headers(config), "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      }),
    REQUEST_TIMEOUT_MS,
    "Transcription request",
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new AIProviderError(
      `Transcription request failed: ${response.status} ${detail.slice(0, 200)}`,
      response.status,
      isRetryable(response.status),
    );
  }

  const data = (await response.json()) as AssemblyTranscript;
  if (!data.id) {
    throw new AIProviderError("Transcription request returned no id", 0, true);
  }
  return data.id;
}

/** Step 3: wait for it. */
async function pollTranscript(
  config: ResolvedTaskConfig,
  id: string,
): Promise<AssemblyTranscript> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let attempt = 0;

  for (;;) {
    const response = await withTimeout(
      (signal) =>
        fetch(`${base(config)}/v2/transcript/${id}`, { headers: headers(config), signal }),
      REQUEST_TIMEOUT_MS,
      "Transcription poll",
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new AIProviderError(
        `Transcription poll failed: ${response.status} ${detail.slice(0, 200)}`,
        response.status,
        isRetryable(response.status),
      );
    }

    const data = (await response.json()) as AssemblyTranscript;

    if (data.status === "completed") return data;
    if (data.status === "error") {
      throw new AIProviderError(
        `Transcription failed: ${data.error ?? "unknown error"}`,
        0,
        false,
      );
    }

    if (Date.now() >= deadline) {
      throw new AIProviderError(
        `Transcription did not finish within ${POLL_TIMEOUT_MS}ms`,
        0,
        true,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, pollDelay(attempt)));
    attempt += 1;
  }
}

/**
 * Transcribe one recording.
 *
 * `fileName` and `contentType` are accepted for contract parity with the
 * OpenAI adapter but are not sent: this API sniffs the format from the bytes.
 */
export async function transcribe(
  config: ResolvedTaskConfig,
  audio: Uint8Array,
  opts: {
    fileName: string;
    contentType: string;
    languageHint?: string;
    diarize?: boolean;
    multichannel?: boolean;
  },
): Promise<TranscriptionResult> {
  const audioUrl = await upload(config, audio);
  const id = await submit(
    config,
    audioUrl,
    opts.languageHint,
    opts.diarize,
    opts.multichannel,
  );
  const result = await pollTranscript(config, id);

  // Milliseconds on the wire, seconds in our contract. Getting this wrong would
  // not throw — it would silently report every pause as 1000x too long and make
  // every fluency score nonsense.
  const words: TranscribedWord[] = (result.words ?? [])
    .filter((w): w is Required<AssemblyWord> =>
      typeof w.text === "string" && typeof w.start === "number" && typeof w.end === "number",
    )
    .map((w) => ({ word: w.text, start: w.start / 1000, end: w.end / 1000 }));

  const text = (result.text ?? "").trim();

  // `audio_duration` is already seconds. Falling back to the last word's end
  // keeps fluency measurable when the field is absent.
  const durationSeconds =
    typeof result.audio_duration === "number" && result.audio_duration > 0
      ? result.audio_duration
      : (words.at(-1)?.end ?? 0);

  // Milliseconds here too, same as `words`.
  // `Required<T>` removes the `?` but not the `| null`, so these are narrowed
  // by hand rather than with a type predicate over the wire shape.
  const utterances: TranscriptUtterance[] = [];
  for (const u of result.utterances ?? []) {
    const { text, start, end } = u;
    // In multichannel mode the channel is the identity and `speaker` may be
    // absent; with diarization it is the other way round. Either is enough to
    // label a turn, and the channel is preferred because it is a fact rather
    // than a clustering result.
    const speaker =
      typeof u.channel === "string" && u.channel !== ""
        ? `channel-${u.channel}`
        : typeof u.speaker === "string"
          ? u.speaker
          : null;
    if (
      speaker === null ||
      typeof text !== "string" ||
      typeof start !== "number" ||
      typeof end !== "number"
    ) {
      continue;
    }
    const trimmedText = text.trim();
    if (trimmedText === "") continue;
    utterances.push({ speaker, text: trimmedText, start: start / 1000, end: end / 1000 });
  }

  return {
    text,
    durationSeconds,
    words,
    hasWordTimings: words.length > 0,
    modelId: config.modelId || "assemblyai",
    // Multichannel is billed per channel, and the recordings this mode is used
    // for are always the two-channel peer-call ones (own mic left, peer right).
    billedChannels: opts.multichannel ? 2 : 1,
    ...(utterances.length > 0 ? { utterances } : {}),
  };
}
