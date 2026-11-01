/**
 * Polling for a spoken answer's verdict.
 *
 * Speech assessment runs in the background — it downloads the recording and
 * waits on a recogniser — so the submit response can only say "pending". The
 * student would otherwise record, upload, and never learn the outcome.
 *
 * Hand-written for the same reason as the other clients here: this endpoint is
 * not in `openapi.yaml`.
 */

const base = () => `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

export interface SpeechMetrics {
  speechRate?: number;
  pauseCount?: number;
  meanLengthOfRun?: number;
  fillersPer100Words?: number;
  problemWords?: string[];
  fluencyUnavailable?: boolean;
}

export interface AttemptVerdict {
  attemptId: number;
  blockId: number;
  evaluationStatus: "graded" | "pending" | "skipped";
  correct: boolean | null;
  score: number | null;
  feedback: string | null;
  feedbackAr: string | null;
  transcript: string | null;
  pronunciationScore: number | null;
  fluencyScore: number | null;
  speechMetrics: SpeechMetrics | null;
}

export async function getAttemptVerdict(
  lessonId: number,
  attemptId: number,
): Promise<AttemptVerdict> {
  const r = await fetch(`${base()}/lessons/${lessonId}/attempts/${attemptId}`, {
    credentials: "include",
  });
  if (!r.ok) throw new Error(`Attempt ${attemptId} → ${r.status}`);
  return r.json();
}

/**
 * Wait for a verdict, giving up rather than polling forever.
 *
 * Backs off as it goes: transcription usually lands in a few seconds, but a
 * queued job behind a slow provider can take longer, and hammering the API for
 * a minute helps nobody. Returns the last state seen — still `pending` is a
 * legitimate answer, and the UI says so honestly rather than pretending.
 */
export async function pollAttemptVerdict(
  lessonId: number,
  attemptId: number,
  opts: { signal?: AbortSignal } = {},
): Promise<AttemptVerdict | null> {
  /**
   * What matters is the worst wait after the verdict is ready, not the delays.
   *
   * The old schedule — 1500, 2000, 3000, 4000, 6000, 8000 — checked at 1.5s,
   * 3.5s, 6.5s, then 10.5s. Its gaps grew fastest exactly where the answer was
   * most likely to arrive, so a verdict ready at 8s sat unseen for 2.5s and one
   * ready at 12s for 4.5s. Measured across a verdict landing anywhere from 2 to
   * 14 seconds, the worst wait was 5.5s.
   *
   * A BACKING-OFF schedule is the wrong shape here. Transcription lands in a
   * fairly predictable window, so the interval should be flat across it and
   * back off only afterwards. Near-constant at one second through 12.7s brings
   * the worst wait in that range to 1.7s and the typical one to 0.7s.
   *
   * The cost is more requests — seventeen rather than six, though only while an
   * assessment is actually running. Each is a cheap read, and sessions no
   * longer touch PostgreSQL, so the polling itself is close to free.
   */
  const delays = [700, ...Array(12).fill(1000), 2000, 3000, 4000, 5000];

  for (const delay of delays) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (opts.signal?.aborted) return null;

    try {
      const verdict = await getAttemptVerdict(lessonId, attemptId);
      if (verdict.evaluationStatus !== "pending") return verdict;
    } catch {
      // A failed poll is not a failed assessment. Keep trying; the last
      // attempt's result is what gets reported.
    }
  }

  try {
    return await getAttemptVerdict(lessonId, attemptId);
  } catch {
    return null;
  }
}
