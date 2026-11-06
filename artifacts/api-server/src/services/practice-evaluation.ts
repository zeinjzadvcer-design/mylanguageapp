/**
 * Opt-in evaluation of a peer practice call.
 *
 * THE CONSTRAINT THAT SHAPES ALL OF THIS
 * ───────────────────────────────────────
 * The call is peer-to-peer and is not recorded. That is a promise the feature
 * makes to students, so evaluation cannot work by reaching for a recording —
 * there isn't one. A recording only exists because a student chose to make one,
 * and because the OTHER student agreed to it.
 *
 * Which gives the flow its shape:
 *
 *   requested → (other side agrees) → consented → uploaded → analyzing →
 *   completed
 *
 * and two refusals that are terminal rather than retried: `declined`, because
 * someone said no, and `expired`, because nobody answered in time.
 *
 * WHAT IS GUARDED, AND WHY HERE
 * ──────────────────────────────
 *   * Audio is rejected unless BOTH consent timestamps are set. The route
 *     checks too; this is the check that cannot be forgotten by a new caller.
 *   * Only the two participants can see anything, and each sees only their own
 *     feedback. The other person's feedback is never returned, because it is
 *     a judgement about them that they did not share.
 *   * The recording is deleted as soon as the transcript exists, including on
 *     failure. An evaluation that keeps audio around is a recording archive
 *     with extra steps.
 */

import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  db,
  practiceCallEvaluationsTable,
  practiceSessionsTable,
  mediaAssetsTable,
  type PracticeCallEvaluation,
} from "@workspace/db";
import { analysePeerCall, MIN_DURATION_SECONDS } from "./graders/peer-call";
import { GradingUnavailableError } from "./graders/open-answer";
import { storage } from "./storage";
import { logger } from "../lib/logger";
import { resolvePlanCode } from "./ai-quota";

/**
 * How long the other participant has to answer a request. Long enough that
 * someone who closed the tab can come back; short enough that a forgotten
 * request does not block a fresh one for days.
 */
const CONSENT_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * How long a `consented` row may wait for its audio.
 *
 * Much shorter than the consent window, because what it is waiting for is
 * different: consent waits on a PERSON, who may reasonably take a day. This
 * waits on an upload from a browser tab that is holding the only copy of the
 * recording in memory — once that tab closes or reloads, the audio is gone and
 * the row can never complete. Holding it for 48 hours would leave the pair
 * unable to evaluate any further call, because of the one-live-per-call index.
 */
const UPLOAD_WINDOW_MS = 15 * 60 * 1000;

/**
 * A call can only be evaluated while the recording is plausibly still in the
 * browser that made it. Past this the request is pointless.
 */
const REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;

export type EvaluationRefusal =
  | "SESSION_NOT_FOUND"
  | "NOT_A_PARTICIPANT"
  | "CALL_NOT_ENDED"
  | "CALL_TOO_SHORT"
  | "TOO_LATE"
  | "ALREADY_REQUESTED"
  | "NOT_FOUND"
  | "NOT_CONSENTED"
  | "ALREADY_DECLINED"
  | "WRONG_STATE";

export class EvaluationRefusedError extends Error {
  readonly reason: EvaluationRefusal;
  constructor(reason: EvaluationRefusal, message: string) {
    super(message);
    this.name = "EvaluationRefusedError";
    this.reason = reason;
  }
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** The call, but only if this user was in it. */
async function participantSession(sessionId: number, userId: number) {
  const [session] = await db
    .select()
    .from(practiceSessionsTable)
    .where(eq(practiceSessionsTable.id, sessionId))
    .limit(1);

  if (!session) {
    throw new EvaluationRefusedError("SESSION_NOT_FOUND", "That call does not exist.");
  }
  if (session.requesterId !== userId && session.partnerId !== userId) {
    // Deliberately the same shape of answer as a missing call: whether a given
    // session id exists is not something a non-participant should learn.
    throw new EvaluationRefusedError("NOT_A_PARTICIPANT", "That call does not exist.");
  }
  return session;
}

/** True once both participants have agreed. The gate on accepting audio. */
function bothConsented(evaluation: PracticeCallEvaluation): boolean {
  return evaluation.requesterConsentedAt !== null && evaluation.partnerConsentedAt !== null;
}

// ─── Requesting ───────────────────────────────────────────────────────────────

export interface EvaluationView {
  id: number;
  sessionId: number;
  status: PracticeCallEvaluation["status"];
  /** True when this viewer is the one who asked for the evaluation. */
  isRequester: boolean;
  /** True when this viewer still has to answer the consent question. */
  awaitingYourConsent: boolean;
  requestedAt: string;
  durationSeconds: number | null;
  /** Only ever this viewer's own feedback. */
  feedback: string | null;
  feedbackAr: string | null;
  /** Shared, non-attributed. */
  summary: string | null;
  summaryAr: string | null;
  /**
   * Whether the speaker-to-person mapping was confident. False means the
   * feedback may be swapped, and the UI says so rather than hiding it.
   */
  attributionUncertain: boolean;
  error: string | null;
}

/**
 * Render one evaluation for one viewer.
 *
 * TWO DIFFERENT "REQUESTERS" LIVE HERE, and conflating them is a real bug that
 * shipped once already. The `requester_*` / `partner_*` COLUMNS are named after
 * the two sides of the CALL — `practice_sessions.requester_id` placed it — while
 * `requestedBy` is whoever asked for the EVALUATION, which may be either of
 * them. Keying the columns off `requestedBy` inverted both the consent flag and
 * the feedback whenever the call's partner was the one who asked for feedback.
 *
 * So the column side is decided by the SESSION, and is passed in; `isRequester`
 * stays a separate question about this evaluation.
 */
function viewFor(
  evaluation: PracticeCallEvaluation,
  userId: number,
  /** True when this viewer is `practice_sessions.requester_id` for the call. */
  viewerIsSessionRequester: boolean,
): EvaluationView {
  const isRequester = evaluation.requestedBy === userId;
  const mine = viewerIsSessionRequester
    ? { en: evaluation.requesterFeedback, ar: evaluation.requesterFeedbackAr }
    : { en: evaluation.partnerFeedback, ar: evaluation.partnerFeedbackAr };

  const myConsent = viewerIsSessionRequester
    ? evaluation.requesterConsentedAt
    : evaluation.partnerConsentedAt;

  return {
    id: evaluation.id,
    sessionId: evaluation.sessionId,
    status: evaluation.status,
    isRequester,
    awaitingYourConsent: evaluation.status === "requested" && myConsent === null,
    requestedAt: evaluation.requestedAt.toISOString(),
    durationSeconds: evaluation.durationSeconds ?? null,
    feedback: mine.en ?? null,
    feedbackAr: mine.ar ?? null,
    summary: evaluation.summary ?? null,
    summaryAr: evaluation.summaryAr ?? null,
    attributionUncertain: (evaluation.speakerMappingConfidence ?? 1) < 0.6,
    error: evaluation.error ?? null,
  };
}

/**
 * Ask for feedback on a call. Records the asker's own consent at the same time
 * — asking IS consenting on their side — and leaves the other participant to
 * answer.
 */
export async function requestEvaluation(
  sessionId: number,
  userId: number,
): Promise<EvaluationView> {
  const session = await participantSession(sessionId, userId);

  if (session.status !== "ended") {
    throw new EvaluationRefusedError(
      "CALL_NOT_ENDED",
      "The call has to finish before it can be evaluated.",
    );
  }

  const duration = session.durationSeconds ?? 0;
  if (duration < MIN_DURATION_SECONDS) {
    throw new EvaluationRefusedError(
      "CALL_TOO_SHORT",
      `The call was too short to evaluate (under ${MIN_DURATION_SECONDS} seconds).`,
    );
  }

  const endedAt = session.endedAt ?? session.matchedAt;
  if (Date.now() - endedAt.getTime() > REQUEST_WINDOW_MS) {
    throw new EvaluationRefusedError(
      "TOO_LATE",
      "Feedback can only be requested within a day of the call.",
    );
  }

  const now = new Date();
  const isRequesterSide = session.requesterId === userId;

  try {
    const [row] = await db
      .insert(practiceCallEvaluationsTable)
      .values({
        sessionId,
        requestedBy: userId,
        status: "requested",
        // Whoever asked has consented by asking. The other side has not.
        requesterConsentedAt: isRequesterSide ? now : null,
        partnerConsentedAt: isRequesterSide ? null : now,
      })
      .returning();
    return viewFor(row, userId, isRequesterSide);
  } catch (err) {
    // The partial unique index: an evaluation is already in play for this call.
    if (isUniqueViolation(err)) {
      throw new EvaluationRefusedError(
        "ALREADY_REQUESTED",
        "Feedback has already been requested for this call.",
      );
    }
    throw err;
  }
}

/**
 * Was this a unique-constraint violation?
 *
 * Drizzle wraps the driver error, so the Postgres `code` is not on the thrown
 * object — it is further down the `cause` chain. Reading `err.code` directly
 * missed it, and the "already requested" case surfaced as a 500 carrying the
 * raw INSERT statement: no useful message for the student, and the schema
 * printed into a response. Matches the walk in routes/cms/quizzes.ts.
 */
function isUniqueViolation(err: unknown): boolean {
  let cursor: unknown = err;
  for (let depth = 0; cursor && depth < 5; depth++) {
    const candidate = cursor as { code?: string; cause?: unknown };
    if (candidate.code === "23505") return true;
    cursor = candidate.cause;
  }
  return false;
}

/**
 * The other participant's answer.
 *
 * A refusal is final and recorded as such. Re-asking means a new row, so a "no"
 * is never quietly overwritten by a second request.
 */
export async function respondToEvaluation(
  evaluationId: number,
  userId: number,
  agree: boolean,
): Promise<EvaluationView> {
  const evaluation = await loadParticipantEvaluation(evaluationId, userId);

  if (evaluation.status === "declined") {
    throw new EvaluationRefusedError(
      "ALREADY_DECLINED",
      "This request was already declined.",
    );
  }
  if (evaluation.status !== "requested") {
    throw new EvaluationRefusedError(
      "WRONG_STATE",
      "This request has already been answered.",
    );
  }

  const session = await participantSession(evaluation.sessionId, userId);
  const isRequesterSide = session.requesterId === userId;
  const now = new Date();

  if (!agree) {
    const [row] = await db
      .update(practiceCallEvaluationsTable)
      .set({ status: "declined", updatedAt: now })
      .where(eq(practiceCallEvaluationsTable.id, evaluationId))
      .returning();
    return viewFor(row, userId, isRequesterSide);
  }

  const [row] = await db
    .update(practiceCallEvaluationsTable)
    .set({
      ...(isRequesterSide
        ? { requesterConsentedAt: now }
        : { partnerConsentedAt: now }),
      updatedAt: now,
    })
    .where(eq(practiceCallEvaluationsTable.id, evaluationId))
    .returning();

  // Only once both sides are in does the row become uploadable.
  if (bothConsented(row)) {
    const [ready] = await db
      .update(practiceCallEvaluationsTable)
      .set({ status: "consented", updatedAt: now })
      .where(eq(practiceCallEvaluationsTable.id, evaluationId))
      .returning();
    return viewFor(ready, userId, isRequesterSide);
  }

  return viewFor(row, userId, isRequesterSide);
}

async function loadParticipantEvaluation(
  evaluationId: number,
  userId: number,
): Promise<PracticeCallEvaluation> {
  const [row] = await db
    .select()
    .from(practiceCallEvaluationsTable)
    .where(eq(practiceCallEvaluationsTable.id, evaluationId))
    .limit(1);

  if (!row) {
    throw new EvaluationRefusedError("NOT_FOUND", "That request does not exist.");
  }
  // Throws unless the caller was in the call.
  await participantSession(row.sessionId, userId);
  return row;
}

// ─── The recording ────────────────────────────────────────────────────────────

/**
 * Attach the uploaded recording. Refused unless both participants consented —
 * the one check that must hold no matter which route grows next.
 */
export async function attachRecording(
  evaluationId: number,
  userId: number,
  mediaAssetId: number,
  /** The client recorded the uploader and the peer on separate channels. */
  channelSeparated = false,
): Promise<EvaluationView> {
  const evaluation = await loadParticipantEvaluation(evaluationId, userId);

  if (!bothConsented(evaluation)) {
    throw new EvaluationRefusedError(
      "NOT_CONSENTED",
      "Both people on the call have to agree before the recording can be uploaded.",
    );
  }
  if (evaluation.status !== "consented") {
    throw new EvaluationRefusedError(
      "WRONG_STATE",
      "This evaluation is not waiting for a recording.",
    );
  }

  const [row] = await db
    .update(practiceCallEvaluationsTable)
    .set({ mediaAssetId, channelSeparated, status: "uploaded", updatedAt: new Date() })
    .where(eq(practiceCallEvaluationsTable.id, evaluationId))
    .returning();

  const session = await participantSession(row.sessionId, userId);
  return viewFor(row, userId, session.requesterId === userId);
}

// ─── Analysis ─────────────────────────────────────────────────────────────────

/**
 * Transcribe and analyse one uploaded recording, then delete the audio.
 *
 * Runs out of band: ASR over a 20-minute call plus one model pass is far longer
 * than a request should wait on. Called by the job queue, and by the sweeper for
 * anything that was left behind.
 */
export async function analyseEvaluation(evaluationId: number): Promise<void> {
  // Claim it, so two workers cannot pay for the same analysis twice.
  const claimed = await db
    .update(practiceCallEvaluationsTable)
    .set({ status: "analyzing", updatedAt: new Date() })
    .where(
      and(
        eq(practiceCallEvaluationsTable.id, evaluationId),
        eq(practiceCallEvaluationsTable.status, "uploaded"),
      ),
    )
    .returning();

  const evaluation = claimed[0];
  if (!evaluation) return; // Someone else took it, or it is not ready.

  const finish = async (patch: Partial<PracticeCallEvaluation>) => {
    await db
      .update(practiceCallEvaluationsTable)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(practiceCallEvaluationsTable.id, evaluationId));
  };

  if (evaluation.mediaAssetId === null) {
    await finish({ status: "failed", error: "The recording was missing." });
    return;
  }

  const [asset] = await db
    .select()
    .from(mediaAssetsTable)
    .where(eq(mediaAssetsTable.id, evaluation.mediaAssetId))
    .limit(1);

  if (!asset) {
    await finish({ status: "failed", error: "The recording was missing." });
    return;
  }

  const [session] = await db
    .select()
    .from(practiceSessionsTable)
    .where(eq(practiceSessionsTable.id, evaluation.sessionId))
    .limit(1);

  // Quota and cost are charged to whoever asked for the evaluation. The other
  // participant agreed to be analysed; they did not agree to pay for it out of
  // their own monthly allowance.
  const payer = evaluation.requestedBy;

  try {
    const verdict = await analysePeerCall(
      {
        evaluationId,
        mediaKey: asset.key,
        mimeType: asset.mimeType,
        callDurationSeconds: session?.durationSeconds ?? null,
        channelSeparated: evaluation.channelSeparated,
      },
      { userId: payer, subscriptionPlan: await resolvePlanCode(payer) },
    );

    // ── Map transcript labels onto the two actual people ──────────────────
    //
    // Two routes, and the difference matters to the student:
    //
    //   CERTAIN   The recording was channel-separated, so the uploader is on
    //             their own channel by construction. `uploaderLabel` is a fact.
    //   GUESSED   Mono fallback. All that is left is "whoever placed the call
    //             probably spoke first", which is close to a coin toss — so it
    //             is recorded as such and the student is warned.
    //
    // Note the uploader is whoever REQUESTED the evaluation, which may be
    // either side of the call; the stored columns are named after the call's
    // sides, so the two have to be related explicitly rather than assumed.
    const labels = verdict.speakers.map((s) => s.speaker).sort();
    const uploaderIsSessionRequester = session?.requesterId === evaluation.requestedBy;

    let uploaderLabel: string;
    let confidence: number;
    if (verdict.uploaderLabel) {
      uploaderLabel = verdict.uploaderLabel;
      confidence = 1;
    } else {
      const firstLabel = verdict.transcript[0]?.speaker ?? labels[0];
      // The caller's browser sends the offer, so the caller tends to speak
      // first. Weak, and priced as weak.
      uploaderLabel = uploaderIsSessionRequester
        ? firstLabel
        : (labels.find((l) => l !== firstLabel) ?? firstLabel);
      confidence = uploaderIsSessionRequester ? 0.7 : 0.5;
    }

    const otherLabel = labels.find((l) => l !== uploaderLabel) ?? null;
    const forLabel = (label: string | null) =>
      label === null ? null : (verdict.speakers.find((s) => s.speaker === label) ?? null);

    const uploaderSide = forLabel(uploaderLabel);
    const otherSide = forLabel(otherLabel);

    // Back onto the call's own sides, which is how the columns are keyed.
    const requesterLabel = uploaderIsSessionRequester ? uploaderLabel : (otherLabel ?? uploaderLabel);
    const requesterSide = uploaderIsSessionRequester ? uploaderSide : otherSide;
    const partnerSide = uploaderIsSessionRequester ? otherSide : uploaderSide;

    await finish({
      status: "completed",
      transcript: verdict.transcript,
      durationSeconds: verdict.durationSeconds,
      requesterSpeakerLabel: requesterLabel,
      speakerMappingConfidence: confidence,
      requesterFeedback: requesterSide?.feedback ?? null,
      requesterFeedbackAr: requesterSide?.feedbackAr ?? null,
      partnerFeedback: partnerSide?.feedback ?? null,
      partnerFeedbackAr: partnerSide?.feedbackAr ?? null,
      summary: verdict.summary || null,
      summaryAr: verdict.summaryAr || null,
      completedAt: new Date(),
      error: null,
    });
  } catch (err) {
    const reason =
      err instanceof GradingUnavailableError
        ? err.message
        : "The call could not be evaluated.";
    if (!(err instanceof GradingUnavailableError)) {
      logger.error({ err, evaluationId }, "Peer-call analysis failed");
    }
    await finish({ status: "failed", error: reason });
  } finally {
    // The audio goes either way. A failed evaluation is not a reason to keep a
    // recording of two students talking.
    await discardRecording(evaluationId);
  }
}

/**
 * Delete the recording and forget it. The transcript stays — it is what the
 * feedback was built from and what a student would appeal against — but the
 * audio does not.
 */
async function discardRecording(evaluationId: number): Promise<void> {
  const [row] = await db
    .select({ mediaAssetId: practiceCallEvaluationsTable.mediaAssetId })
    .from(practiceCallEvaluationsTable)
    .where(eq(practiceCallEvaluationsTable.id, evaluationId))
    .limit(1);

  if (!row?.mediaAssetId) return;

  const [asset] = await db
    .select({ key: mediaAssetsTable.key })
    .from(mediaAssetsTable)
    .where(eq(mediaAssetsTable.id, row.mediaAssetId))
    .limit(1);

  // Unlink first: a storage delete that fails must not leave the row pointing
  // at audio the student was told had been removed.
  await db
    .update(practiceCallEvaluationsTable)
    .set({ mediaAssetId: null })
    .where(eq(practiceCallEvaluationsTable.id, evaluationId));

  if (asset?.key) {
    try {
      await storage.remove(asset.key);
      await db.delete(mediaAssetsTable).where(eq(mediaAssetsTable.id, row.mediaAssetId));
    } catch (err) {
      // Logged loudly: this is the promise that the recording does not outlive
      // the analysis, and a silent failure to keep it is not acceptable.
      logger.error(
        { err, evaluationId, key: asset.key },
        "Could not delete peer-call recording after analysis",
      );
    }
  }
}

// ─── Reading ──────────────────────────────────────────────────────────────────

/** This user's evaluations, newest first. Each row carries only their own feedback. */
export async function listEvaluations(userId: number): Promise<EvaluationView[]> {
  const rows = await db
    .select({
      evaluation: practiceCallEvaluationsTable,
      sessionRequesterId: practiceSessionsTable.requesterId,
    })
    .from(practiceCallEvaluationsTable)
    .innerJoin(
      practiceSessionsTable,
      eq(practiceSessionsTable.id, practiceCallEvaluationsTable.sessionId),
    )
    .where(
      or(
        eq(practiceSessionsTable.requesterId, userId),
        eq(practiceSessionsTable.partnerId, userId),
      ),
    )
    .orderBy(desc(practiceCallEvaluationsTable.requestedAt))
    .limit(50);

  return rows.map((r) => viewFor(r.evaluation, userId, r.sessionRequesterId === userId));
}

export async function getEvaluation(
  evaluationId: number,
  userId: number,
): Promise<EvaluationView> {
  const row = await loadParticipantEvaluation(evaluationId, userId);
  const session = await participantSession(row.sessionId, userId);
  return viewFor(row, userId, session.requesterId === userId);
}

// ─── Expiry ───────────────────────────────────────────────────────────────────

/**
 * Close out requests nobody answered, and recover anything stuck mid-flight.
 *
 * Expiring a request matters: the partial unique index means one abandoned
 * request would otherwise stop the pair ever evaluating another call.
 */
export async function expireStaleEvaluations(): Promise<number> {
  const consentCutoff = new Date(Date.now() - CONSENT_WINDOW_MS);

  const expired = await db
    .update(practiceCallEvaluationsTable)
    .set({ status: "expired", updatedAt: new Date() })
    .where(
      and(
        eq(practiceCallEvaluationsTable.status, "requested"),
        sql`${practiceCallEvaluationsTable.requestedAt} < ${consentCutoff}`,
      ),
    )
    .returning({ id: practiceCallEvaluationsTable.id });

  // `consented` and `analyzing` rows that went nowhere: the tab holding the
  // recording closed before uploading, or a worker died mid-analysis.
  const uploadCutoff = new Date(Date.now() - UPLOAD_WINDOW_MS);
  const abandoned = await db
    .update(practiceCallEvaluationsTable)
    .set({
      status: "failed",
      error: "The recording was not uploaded in time.",
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(practiceCallEvaluationsTable.status, ["consented", "analyzing"]),
        sql`${practiceCallEvaluationsTable.requestedAt} < ${uploadCutoff}`,
      ),
    )
    .returning({ id: practiceCallEvaluationsTable.id });

  for (const row of abandoned) {
    await discardRecording(row.id);
  }

  return expired.length + abandoned.length;
}

/** Uploaded recordings still waiting to be analysed. Used by the sweeper. */
export async function pendingAnalysisIds(limit = 5): Promise<number[]> {
  const rows = await db
    .select({ id: practiceCallEvaluationsTable.id })
    .from(practiceCallEvaluationsTable)
    .where(eq(practiceCallEvaluationsTable.status, "uploaded"))
    .orderBy(practiceCallEvaluationsTable.requestedAt)
    .limit(limit);
  return rows.map((r) => r.id);
}

export { CONSENT_WINDOW_MS, REQUEST_WINDOW_MS, UPLOAD_WINDOW_MS };
