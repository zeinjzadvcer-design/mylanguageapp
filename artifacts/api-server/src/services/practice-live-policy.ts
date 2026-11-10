/**
 * Live call state in Valkey — the rules, with no Redis or database behind them.
 *
 * Split from practice-live.ts for the same reason the other `*-policy.ts`
 * modules are: these decide whether a call is over and which setup messages a
 * browser sees, and they should be covered by tests that run anywhere.
 */

import type { PracticeSession } from "@workspace/db";

/** The session columns that are timestamps, revived from their JSON strings. */
const DATE_FIELDS = [
  "matchedAt",
  "startedAt",
  "endedAt",
  "requesterSeenAt",
  "partnerSeenAt",
  "createdAt",
] as const;

/**
 * One student's live call as cached, tagged with the generation it was read at.
 *
 * `gen` is the student's write counter when the database was read. Any change to
 * a call the student is in bumps the counter, so an entry whose `gen` no longer
 * matches is out of date and is read again — including one written by a poll
 * that raced the change, which a plain delete-on-write would leave behind.
 */
export interface CachedLiveCall {
  gen: number;
  session: PracticeSession | null;
}

export function encodeLiveCall(entry: CachedLiveCall): string {
  return JSON.stringify(entry);
}

/** The cached call, or null when the value cannot be read. */
export function decodeLiveCall(raw: string | null): CachedLiveCall | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { gen?: unknown; session?: Record<string, unknown> | null };
    if (typeof parsed.gen !== "number") return null;
    if (!parsed.session) return { gen: parsed.gen, session: null };
    const session = { ...parsed.session };
    for (const field of DATE_FIELDS) {
      const value = session[field];
      session[field] = typeof value === "string" ? new Date(value) : value ?? null;
    }
    return { gen: parsed.gen, session: session as unknown as PracticeSession };
  } catch {
    return null;
  }
}

/** Whether a cached entry may be used: read at the student's current generation. */
export function isCurrent(entry: CachedLiveCall | null, gen: number): entry is CachedLiveCall {
  return entry !== null && entry.gen === gen;
}

/**
 * Whether both sides of a call have stopped polling.
 *
 * Each side's last poll must be KNOWN: a missing value means Valkey has no
 * record — a restart, or a call from before presence moved here — and a call is
 * never closed on no evidence. The sweeper's time limit closes those instead.
 */
export function bothQuiet(lastSeen: readonly (number | null)[], cutoffMs: number): boolean {
  return lastSeen.length > 0 && lastSeen.every((seen) => seen !== null && seen < cutoffMs);
}

/** One WebRTC setup message as stored. */
export interface StoredSignal {
  id: number;
  kind: string;
  payload: unknown;
  createdAt: string;
}

/** Messages kept per recipient per call; a handshake needs a few dozen. */
export const SIGNAL_LIST_MAX = 200;

/** Most messages handed over in one read, as before. */
export const SIGNAL_READ_MAX = 100;

/**
 * Where a call's message numbering starts.
 *
 * The browser asks for messages after the highest id it has seen. Numbering
 * from the current time in microseconds puts every id above the ids the
 * Postgres table handed out, so a call that spans the deploy keeps receiving
 * messages, and stays well inside a safe JavaScript integer.
 */
export function signalIdBase(nowMs: number): number {
  return nowMs * 1000;
}

/** The messages after `afterId`, oldest first, at most SIGNAL_READ_MAX. */
export function signalsAfter(stored: readonly string[], afterId: number): StoredSignal[] {
  const out: StoredSignal[] = [];
  for (const raw of stored) {
    try {
      const signal = JSON.parse(raw) as StoredSignal;
      if (typeof signal.id === "number" && signal.id > afterId) out.push(signal);
    } catch {
      // A value nobody can read is skipped rather than failing the read.
    }
  }
  out.sort((a, b) => a.id - b.id);
  return out.slice(0, SIGNAL_READ_MAX);
}
