/**
 * The AI conversation tutor.
 *
 * Every limit is enforced server-side; this client only reports what it is
 * told. `turnsRemaining` and `minutesRemaining` come back with each reply so
 * the student can see the conversation is bounded rather than discovering it
 * when it stops.
 */

const base = () => `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

export class ConversationError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "ConversationError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${base()}${path}`, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!r.ok) {
    let payload: { error?: string; code?: string } = {};
    try {
      payload = await r.json();
    } catch {
      // Non-JSON body; the status is all there is.
    }
    throw new ConversationError(
      payload.error ?? `${method} ${path} → ${r.status}`,
      r.status,
      payload.code ?? null,
    );
  }

  return r.json();
}

export interface ConversationTurn {
  role: "student" | "tutor";
  content: string;
  createdAt?: string;
}

export interface ActiveSession {
  sessionId: number;
  lessonId: number | null;
  /** The dialogue block it belongs to; a lesson can hold several. */
  blockId?: number | null;
  turns: ConversationTurn[];
  turnsUsed: number;
  turnsRemaining: number;
  minutesRemaining: number;
  vocabularyUsed: string[];
}

export interface StartResult {
  sessionId: number;
  greeting: string;
  maxTurns: number;
  maxMinutes: number;
  targetVocabulary: string[];
}

export interface TurnResult {
  reply: string;
  /** What the recogniser heard, when the turn was spoken. */
  transcript?: string | null;
  turnsUsed: number;
  turnsRemaining: number;
  minutesRemaining: number;
  vocabularyUsed: string[];
  ended: boolean;
}

export const getActiveConversation = () =>
  request<{ session: ActiveSession | null }>("GET", "/conversation/active");

export const startConversation = (lessonId: number, blockId: number | null) =>
  request<StartResult>("POST", "/conversation/start", { lessonId, blockId });

/**
 * One turn. Send `message` for a typed reply, or `mediaId` for a spoken one —
 * the server transcribes the recording and uses that as the turn, so the client
 * never has to guess at what was said.
 */
export const sendTurn = (
  sessionId: number,
  payload: { message?: string; mediaId?: number },
) => request<TurnResult>("POST", `/conversation/${sessionId}/turn`, payload);

export const endConversation = (sessionId: number) =>
  request<{ ended: boolean }>("POST", `/conversation/${sessionId}/end`);
