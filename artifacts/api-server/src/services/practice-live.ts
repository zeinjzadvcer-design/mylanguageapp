/**
 * Live call state in Valkey.
 *
 * WHY
 * ───
 * Everyone in a call, or waiting for one, polls twice a second. Before this,
 * each status poll read the call and the partner's card from Postgres and wrote
 * the student's presence back, and each signal poll read the call and the
 * message table again. Measured under load that was most of the database's
 * work, for data that is worthless a minute later.
 *
 * WHAT LIVES HERE, AND WHAT DOES NOT
 * ──────────────────────────────────
 *   Presence          A key per side of a call, holding the last poll's time.
 *                     The sweeper reads these to close abandoned calls.
 *   Setup messages    A list per recipient per call, deleted when it ends.
 *   The live call     A cached copy per student, checked against a counter
 *                     every change to the call bumps (see CachedLiveCall).
 *   Partner card      Name, level and interests, which do not change mid-call.
 *
 * Postgres stays the record of every call: creating, answering and ending one
 * still writes there, and this module only spares it the per-second reads and
 * writes. Every function returns `undefined` or `false` when Valkey is not
 * configured, and the caller then does what it did before — so a deployment
 * without REDIS_URL behaves exactly as it always has.
 */

import type { PracticeSession } from "@workspace/db";
import { redis, isRedisAvailable } from "./redis";
import { logger } from "../lib/logger";
import {
  decodeLiveCall,
  encodeLiveCall,
  isCurrent,
  signalIdBase,
  signalsAfter,
  SIGNAL_LIST_MAX,
  type StoredSignal,
} from "./practice-live-policy";

/** How long a cached live call is trusted before it is read again anyway. */
const LIVE_TTL_S = 15;

/** Long enough to outlast the longest call; the sweeper reads these. */
const PRESENCE_TTL_S = 3600;

/** Partner cards and setup messages, kept no longer than a call can last. */
const CALL_DATA_TTL_S = 3600;

const keys = {
  live: (userId: number) => `practice:live:${userId}`,
  gen: (userId: number) => `practice:gen:${userId}`,
  seen: (sessionId: number, userId: number) => `practice:seen:${sessionId}:${userId}`,
  card: (sessionId: number, viewerId: number) => `practice:card:${sessionId}:${viewerId}`,
  signals: (sessionId: number, toUserId: number) => `practice:sig:${sessionId}:${toUserId}`,
  signalSeq: (sessionId: number) => `practice:sigseq:${sessionId}`,
  matchGate: (userId: number) => `practice:matchgate:${userId}`,
};

/** Whether this deployment keeps call state in Valkey at all. */
export function liveStateEnabled(): boolean {
  return redis !== null;
}

/** The client, when it can be used right now. */
function client() {
  return redis && isRedisAvailable() ? redis : null;
}

/**
 * Mark a change to a call these students are in.
 *
 * Called after every write to a call. Bumping the counter makes any cached copy
 * — including one a concurrent poll is about to write — read as out of date.
 * A failure is logged and otherwise ignored: the cached copy also expires on
 * its own within LIVE_TTL_S.
 */
export async function callChanged(...userIds: number[]): Promise<void> {
  const r = client();
  if (!r) return;
  try {
    const batch = r.pipeline();
    for (const id of userIds) batch.incr(keys.gen(id));
    await batch.exec();
  } catch (err) {
    logger.warn({ err, userIds }, "Could not mark a practice call as changed");
  }
}

/**
 * This student's live call, from the cache when it is current.
 *
 * `load` reads the database and is called on a miss; its answer is cached at
 * the generation read BEFORE it ran, so a change made meanwhile still wins.
 */
export async function liveCallFor(
  userId: number,
  load: () => Promise<PracticeSession | null>,
): Promise<PracticeSession | null> {
  const r = client();
  if (!r) return load();

  let gen = 0;
  try {
    const [raw, genRaw] = await r.mget(keys.live(userId), keys.gen(userId));
    gen = Number(genRaw ?? 0);
    const cached = decodeLiveCall(raw);
    if (isCurrent(cached, gen)) return cached.session;
  } catch (err) {
    logger.debug({ err, userId }, "Live call cache unreadable; using the database");
    return load();
  }

  const session = await load();
  try {
    await r.set(keys.live(userId), encodeLiveCall({ gen, session }), "EX", LIVE_TTL_S);
  } catch (err) {
    logger.debug({ err, userId }, "Could not cache a live call");
  }
  return session;
}

/** A value derived from a call that does not change while it lasts. */
export async function cachedForCall<T>(
  sessionId: number,
  viewerId: number,
  build: () => Promise<T>,
): Promise<T> {
  const r = client();
  if (!r) return build();
  try {
    const raw = await r.get(keys.card(sessionId, viewerId));
    if (raw) return JSON.parse(raw) as T;
  } catch (err) {
    logger.debug({ err, sessionId }, "Partner card cache unreadable");
    return build();
  }
  const value = await build();
  try {
    await r.set(keys.card(sessionId, viewerId), JSON.stringify(value), "EX", CALL_DATA_TTL_S);
  } catch {
    // Building it again next poll is the cost.
  }
  return value;
}

/** Record that this side of a call is still polling. False when not stored here. */
export async function notePresence(sessionId: number, userId: number): Promise<boolean> {
  const r = client();
  if (!r) return false;
  try {
    await r.set(keys.seen(sessionId, userId), String(Date.now()), "EX", PRESENCE_TTL_S);
    return true;
  } catch (err) {
    logger.debug({ err, sessionId, userId }, "Presence write failed");
    return false;
  }
}

/**
 * Each side's last poll, in the order given; null where there is no record.
 * Undefined when Valkey cannot be asked, so the caller knows nothing was learnt.
 */
export async function presenceOf(
  pairs: readonly { sessionId: number; userId: number }[],
): Promise<(number | null)[] | undefined> {
  const r = client();
  if (!r || pairs.length === 0) return pairs.length === 0 ? [] : undefined;
  try {
    const values = await r.mget(...pairs.map((p) => keys.seen(p.sessionId, p.userId)));
    return values.map((v) => (v === null ? null : Number(v)));
  } catch (err) {
    logger.warn({ err }, "Could not read practice presence");
    return undefined;
  }
}

/**
 * Whether this student may look for a match now, and if not, the last count.
 *
 * Someone arriving in the queue matches at once, so the students already
 * waiting do not each need to search every second; every few seconds is
 * enough to notice a partner freeing up.
 */
export async function matchGate(
  userId: number,
  intervalMs: number,
): Promise<{ open: true } | { open: false; waiting: number } | undefined> {
  const r = client();
  if (!r) return undefined;
  try {
    const opened = await r.set(keys.matchGate(userId), "-1", "PX", intervalMs, "NX");
    if (opened === "OK") return { open: true };
    const waiting = Number(await r.get(keys.matchGate(userId)));
    return { open: false, waiting: Number.isFinite(waiting) && waiting >= 0 ? waiting : 0 };
  } catch {
    return undefined;
  }
}

/** Remember the last count shown, for polls between searches. */
export async function rememberWaiting(userId: number, waiting: number): Promise<void> {
  const r = client();
  if (!r) return;
  try {
    // XX: only while the gate is still closed. KEEPTTL: it must still open on
    // time. ioredis has no typed overload for the pair.
    await r.call("SET", keys.matchGate(userId), String(waiting), "XX", "KEEPTTL");
  } catch {
    // The next poll shows 0 instead; the next search corrects it.
  }
}

/** Store one setup message for the other side of a call. */
export async function pushSignal(
  sessionId: number,
  fromUserId: number,
  toUserId: number,
  kind: string,
  payload: unknown,
): Promise<void> {
  const r = redis!;
  const seq = keys.signalSeq(sessionId);
  const [, idResult] = (await r
    .multi()
    .set(seq, String(signalIdBase(Date.now())), "EX", CALL_DATA_TTL_S, "NX")
    .incr(seq)
    .exec()) as [unknown, [Error | null, number]];
  if (idResult[0]) throw idResult[0];

  const signal: StoredSignal & { fromUserId: number } = {
    id: idResult[1],
    kind,
    payload,
    createdAt: new Date().toISOString(),
    fromUserId,
  };
  const list = keys.signals(sessionId, toUserId);
  const results = await r
    .pipeline()
    .rpush(list, JSON.stringify(signal))
    .ltrim(list, -SIGNAL_LIST_MAX, -1)
    .expire(list, CALL_DATA_TTL_S)
    .exec();
  const failed = results?.find(([err]) => err)?.[0];
  if (failed) throw failed;
}

/** This student's messages in a call after `afterId`. */
export async function readStoredSignals(
  sessionId: number,
  userId: number,
  afterId: number,
): Promise<StoredSignal[]> {
  const stored = await redis!.lrange(keys.signals(sessionId, userId), 0, -1);
  return signalsAfter(stored, afterId).map(({ id, kind, payload, createdAt }) => ({
    id,
    kind,
    payload,
    createdAt,
  }));
}

/**
 * Everything a finished call left in Valkey.
 *
 * The setup messages are the only place a student's SDP was written down, so
 * they go the moment the call ends, as the Postgres rows always did.
 */
export async function forgetCall(session: PracticeSession): Promise<void> {
  const r = client();
  if (!r) return;
  const people = [session.requesterId, session.partnerId];
  try {
    await r.del(
      keys.signalSeq(session.id),
      ...people.map((id) => keys.signals(session.id, id)),
      ...people.map((id) => keys.card(session.id, id)),
      ...people.map((id) => keys.seen(session.id, id)),
    );
  } catch (err) {
    // Every one of these expires within the hour regardless.
    logger.warn({ err, sessionId: session.id }, "Could not clear a finished call from Valkey");
  }
}
