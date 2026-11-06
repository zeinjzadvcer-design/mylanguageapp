/**
 * Voice practice with another student.
 *
 * A hand-written client, like conversation-api.ts and quiz-api.ts. Every rule
 * — who may be matched, how long a call may run, how many calls a day — is
 * enforced by the server; this file only carries requests and reports refusals
 * by their code, so the screen can say the right thing rather than "error".
 */

const base = () => `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

export class PracticeError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "PracticeError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${base()}${path}`, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!r.ok) {
    let payload: { error?: string; code?: string } = {};
    try {
      payload = await r.json();
    } catch {
      // Non-JSON body; the status is all there is.
    }
    throw new PracticeError(
      payload.error ?? `${method} ${path} → ${r.status}`,
      r.status,
      payload.code ?? null,
    );
  }

  return r.json();
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PracticePreferences {
  isAvailable: boolean;
  goals: string[];
  interests: string[];
  professionalField: string | null;
  availableHours: number[];
}

export interface PracticeLimits {
  dailyCallLimit: number;
  maxCallMinutes: number;
  ringTimeoutMs: number;
  connectTimeoutMs: number;
}

export type PracticeSessionStatus = "waiting" | "active" | "ended" | "declined";

export interface PracticeSessionView {
  sessionId: number;
  status: PracticeSessionStatus;
  /** True when this browser makes the WebRTC offer. */
  isCaller: boolean;
  partner: {
    userId: number;
    name: string;
    levelCode: string | null;
    interests: string[];
    professionalField: string | null;
  };
  matchScore: number | null;
  startedAt: string | null;
  secondsRemaining: number | null;
  endReason: string | null;
}

export interface PracticeStatus {
  session: PracticeSessionView | null;
  queued: boolean;
  waiting: number;
  secondsWaiting: number;
}

export interface IceConfig {
  iceServers: RTCIceServer[];
  /** False means STUN only: some pairs will not connect at all. */
  hasTurn: boolean;
  connectTimeoutMs: number;
  /** "relay" hides each student's IP address from the other. Absent on an older server. */
  iceTransportPolicy?: RTCIceTransportPolicy;
}

export type SignalKind = "offer" | "answer" | "ice" | "bye";

export interface SignalMessage {
  id: number;
  kind: SignalKind;
  payload: unknown;
  createdAt: string;
}

export type ReportReason = "harassment" | "inappropriate" | "spam" | "language" | "other";

export interface PracticeCall {
  sessionId: number;
  partnerId: number;
  partnerName: string;
  startedAt: string | null;
  durationSeconds: number | null;
  endReason: string | null;
}

/**
 * An opt-in evaluation of one call.
 *
 * Only ever carries the viewer's OWN feedback — the other participant's is not
 * sent to this browser at all, because it is a judgement about them that they
 * did not agree to share.
 */
export interface CallEvaluation {
  id: number;
  sessionId: number;
  status:
    | "requested"
    | "consented"
    | "declined"
    | "uploaded"
    | "analyzing"
    | "completed"
    | "failed"
    | "expired";
  isRequester: boolean;
  /** This viewer still has to answer the consent question. */
  awaitingYourConsent: boolean;
  requestedAt: string;
  durationSeconds: number | null;
  feedback: string | null;
  feedbackAr: string | null;
  summary: string | null;
  summaryAr: string | null;
  /** The speaker-to-person guess was weak; the screen says so. */
  attributionUncertain: boolean;
  error: string | null;
}

// ─── Calls ────────────────────────────────────────────────────────────────────

export const practiceApi = {
  getProfile: () =>
    request<{ profile: PracticePreferences | null; limits: PracticeLimits }>(
      "GET",
      "/practice/profile",
    ),

  saveProfile: (prefs: PracticePreferences) =>
    request<{ profile: PracticePreferences }>("PUT", "/practice/profile", prefs),

  joinQueue: () =>
    request<{ session: PracticeSessionView | null; waiting: number }>(
      "POST",
      "/practice/queue",
    ),

  leaveQueue: () => request<{ ok: true }>("DELETE", "/practice/queue"),

  /** Refreshes presence and closes anything overdue, so it is a POST. */
  poll: () => request<PracticeStatus>("POST", "/practice/poll", {}),

  accept: (sessionId: number) =>
    request<{ session: PracticeSessionView }>(
      "POST",
      `/practice/sessions/${sessionId}/accept`,
      {},
    ),

  end: (sessionId: number, reason?: "ended_by_user" | "declined" | "connection_failed") =>
    request<{ session: PracticeSessionView }>("POST", `/practice/sessions/${sessionId}/end`, {
      reason,
    }),

  iceServers: () => request<IceConfig>("GET", "/practice/ice-servers"),

  sendSignal: (sessionId: number, kind: SignalKind, payload: unknown) =>
    request<{ ok: true }>("POST", `/practice/sessions/${sessionId}/signal`, { kind, payload }),

  readSignals: (sessionId: number, after: number) =>
    request<{ signals: SignalMessage[] }>(
      "GET",
      `/practice/sessions/${sessionId}/signals?after=${after}`,
    ),

  // ─── Evaluation (opt-in, needs both participants) ──────────────────────────

  /** Ask for feedback on a finished call. Asking is this side's consent. */
  requestEvaluation: (sessionId: number) =>
    request<{ evaluation: CallEvaluation }>(
      "POST",
      `/practice/sessions/${sessionId}/evaluate`,
      {},
    ),

  /** Answer someone else's request. A refusal is final. */
  respondToEvaluation: (evaluationId: number, agree: boolean) =>
    request<{ evaluation: CallEvaluation }>(
      "POST",
      `/practice/evaluations/${evaluationId}/respond`,
      { agree },
    ),

  /** Reserve a presigned PUT. Refused until both sides have agreed. */
  beginRecordingUpload: (
    evaluationId: number,
    body: { contentType: string; sizeBytes: number; durationSec?: number | null },
  ) =>
    request<{ mediaId: number; key: string; upload: { url: string; headers?: Record<string, string> } }>(
      "POST",
      `/practice/evaluations/${evaluationId}/recording`,
      body,
    ),

  /** Confirm the bytes landed; the server then queues the analysis. */
  completeRecordingUpload: (
    evaluationId: number,
    mediaId: number,
    /** True when the recording has own-mic and peer on separate channels. */
    channelSeparated: boolean,
  ) =>
    request<{ evaluation: CallEvaluation }>(
      "POST",
      `/practice/evaluations/${evaluationId}/recording/complete`,
      { mediaId, channelSeparated },
    ),

  listEvaluations: () =>
    request<{ evaluations: CallEvaluation[] }>("GET", "/practice/evaluations"),

  getEvaluation: (evaluationId: number) =>
    request<{ evaluation: CallEvaluation }>("GET", `/practice/evaluations/${evaluationId}`),

  block: (userId: number, sessionId: number | null) =>
    request<{ ok: true }>("POST", "/practice/block", { userId, sessionId }),

  unblock: (userId: number) => request<{ ok: true }>("DELETE", `/practice/block/${userId}`),

  blocks: () =>
    request<{ blocks: Array<{ userId: number; name: string; createdAt: string }> }>(
      "GET",
      "/practice/blocks",
    ),

  report: (input: {
    userId: number;
    sessionId: number | null;
    reason: ReportReason;
    detail: string | null;
    alsoBlock: boolean;
  }) => request<{ reportId: number }>("POST", "/practice/report", input),

  history: () => request<{ calls: PracticeCall[] }>("GET", "/practice/history"),
};
