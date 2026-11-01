/**
 * Student-to-student voice practice (spec section 11).
 *
 * WHAT THIS IS NOT
 * ─────────────────
 * It is not the conversation tutor with a person on the other end. No model is
 * called, no AI quota is spent, and nothing here reads the AI configuration.
 * The audio never reaches the server at all: it is a direct WebRTC connection
 * between two browsers. All this module does is decide who talks to whom, carry
 * the handful of setup messages between them, and stop a call when it should
 * stop.
 *
 * WHAT IS ENFORCED HERE RATHER THAN ASKED OF THE CLIENT
 * ─────────────────────────────────────────────────────
 *   One live call per student   A partial unique index, so two matchers racing
 *                               cannot put one person in two calls.
 *   Daily call limit            Counted in Postgres, like the media upload
 *                               limit — not in Redis, because a Redis outage
 *                               must degrade this feature, not stop it.
 *   Maximum call length         Checked whenever either side polls; the server
 *                               ends the call whatever the browser thinks.
 *   Blocks                      Applied in the matching query, in both
 *                               directions, and again in the pure matcher.
 *
 * WHY THERE IS NO BACKGROUND JOB
 * ───────────────────────────────
 * Everything that expires — an unanswered ring, an over-long call, a queue
 * entry whose owner closed the tab — expires when someone next polls, and
 * during a call both sides poll every second. A sweeper would add a moving part
 * to catch the case where nobody is looking, which is exactly the case where
 * nothing is harmed by waiting.
 */

import { eq, and, or, ne, gte, lt, sql, desc, inArray, asc, isNotNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  db,
  usersTable,
  studentProfilesTable,
  levelsTable,
  practiceProfilesTable,
  practiceQueueTable,
  practiceSessionsTable,
  practiceBlocksTable,
  practiceReportsTable,
  practiceSignalsTable,
  type PracticeSession,
} from "@workspace/db";
import {
  bestPracticeMatch,
  CANDIDATE_STALE_MS,
  type PracticeCandidate,
  type PracticeSeeker,
} from "./scoring/practice-match";
import { logger } from "../lib/logger";
import { audit } from "./cms-audit";

// ─── Server-enforced bounds ───────────────────────────────────────────────────

/** Calls one student may start in a rolling day. Abuse control, not cost control. */
const DAILY_CALL_LIMIT = parseInt(process.env.PRACTICE_DAILY_CALL_LIMIT ?? "20", 10);

/** A call is ended by the server past this, however long the browsers hold on. */
const MAX_CALL_MINUTES = parseInt(process.env.PRACTICE_MAX_CALL_MINUTES ?? "30", 10);

/** How long a proposed pairing rings before it is given up on. */
const RING_TIMEOUT_MS = parseInt(process.env.PRACTICE_RING_TIMEOUT_MS ?? "45000", 10);

/**
 * How long BOTH sides must be silent before a live call is treated as
 * abandoned.
 *
 * Both browsers poll once a second during a call, so ten missed polls is a
 * clear departure rather than a slow network. The alternative — waiting for
 * `MAX_CALL_MINUTES + 2` — left both students locked out of voice practice for
 * up to seventeen minutes after one of them closed a laptop, because the
 * one-live-per-person index refuses anyone already in a call.
 */
const ABANDONED_AFTER_MS = parseInt(
  process.env.PRACTICE_ABANDONED_AFTER_MS ?? "30000",
  10,
);

/**
 * How long two browsers get to complete the WebRTC handshake before the call is
 * declared failed. Without a TURN relay some pairs never connect at all — see
 * docs/features/voice-practice.md — and hanging on "connecting…" forever is the
 * worst way to tell someone that.
 */
const CONNECT_TIMEOUT_MS = parseInt(process.env.PRACTICE_CONNECT_TIMEOUT_MS ?? "30000", 10);

/** Tag hygiene: enough to be useful, short enough not to be a message channel. */
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 40;

// ─── Refusals ─────────────────────────────────────────────────────────────────

export type PracticeBlockedReason =
  | "NOT_OPTED_IN"
  | "ALREADY_IN_CALL"
  | "NOT_IN_CALL"
  | "NOT_YOURS"
  | "NOT_WAITING"
  | "SESSION_ENDED"
  | "SELF"
  | "DAILY_LIMIT";

export class PracticeBlockedError extends Error {
  readonly reason: PracticeBlockedReason;
  constructor(reason: PracticeBlockedReason, message: string) {
    super(message);
    this.name = "PracticeBlockedError";
    this.reason = reason;
  }
}

// ─── Preferences ──────────────────────────────────────────────────────────────

export interface PracticePreferences {
  isAvailable: boolean;
  goals: string[];
  interests: string[];
  professionalField: string | null;
  availableHours: number[];
}

function cleanTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().slice(0, MAX_TAG_LENGTH);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** The student's own preferences. Absent until they have opted in once. */
export async function getPreferences(userId: number): Promise<PracticePreferences | null> {
  const [row] = await db
    .select()
    .from(practiceProfilesTable)
    .where(eq(practiceProfilesTable.userId, userId))
    .limit(1);

  if (!row) return null;
  return {
    isAvailable: row.isAvailable,
    goals: row.goals,
    interests: row.interests,
    professionalField: row.professionalField,
    availableHours: row.availableHours,
  };
}

export async function savePreferences(
  userId: number,
  input: PracticePreferences,
): Promise<PracticePreferences> {
  const values = {
    isAvailable: input.isAvailable,
    goals: cleanTags(input.goals),
    interests: cleanTags(input.interests),
    professionalField: input.professionalField?.trim().slice(0, MAX_TAG_LENGTH) || null,
    availableHours: [...new Set(input.availableHours.filter((h) => h >= 0 && h <= 23))].sort(
      (a, b) => a - b,
    ),
  };

  await db
    .insert(practiceProfilesTable)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: practiceProfilesTable.userId, set: values });

  // Opting out is not just a flag: it has to take the student out of the pool
  // they are sitting in right now, or they keep being offered to people until
  // their poll goes stale.
  if (!values.isAvailable) {
    await db.delete(practiceQueueTable).where(eq(practiceQueueTable.userId, userId));
  }

  return values;
}

// ─── Who is who ───────────────────────────────────────────────────────────────

interface StudentFacts {
  levelOrder: number | null;
  preferences: PracticePreferences | null;
}

async function loadStudent(userId: number): Promise<StudentFacts> {
  const [level] = await db
    .select({ order: levelsTable.order })
    .from(studentProfilesTable)
    .leftJoin(levelsTable, eq(levelsTable.id, studentProfilesTable.currentLevelId))
    .where(eq(studentProfilesTable.userId, userId))
    .limit(1);

  return {
    levelOrder: level?.order ?? null,
    preferences: await getPreferences(userId),
  };
}

/**
 * Everyone in a block relationship with this student, in either direction.
 *
 * One row is written per block, and this is where it becomes symmetric: the
 * blocker never sees the blocked, and the blocked never sees the blocker.
 */
async function blockedWith(userId: number): Promise<number[]> {
  const rows = await db
    .select({
      blockerId: practiceBlocksTable.blockerId,
      blockedId: practiceBlocksTable.blockedId,
    })
    .from(practiceBlocksTable)
    .where(
      or(
        eq(practiceBlocksTable.blockerId, userId),
        eq(practiceBlocksTable.blockedId, userId),
      ),
    );

  return rows.map((r) => (r.blockerId === userId ? r.blockedId : r.blockerId));
}

async function busyUserIds(): Promise<number[]> {
  const rows = await db
    .select({
      requesterId: practiceSessionsTable.requesterId,
      partnerId: practiceSessionsTable.partnerId,
    })
    .from(practiceSessionsTable)
    .where(inArray(practiceSessionsTable.status, ["waiting", "active"]));

  return rows.flatMap((r) => [r.requesterId, r.partnerId]);
}

async function callsToday(userId: number): Promise<number> {
  const since = new Date(Date.now() - 24 * 3_600_000);
  const [{ used }] = await db
    .select({ used: sql<number>`count(*)::int` })
    .from(practiceSessionsTable)
    .where(
      and(
        or(
          eq(practiceSessionsTable.requesterId, userId),
          eq(practiceSessionsTable.partnerId, userId),
        ),
        gte(practiceSessionsTable.matchedAt, since),
      ),
    );
  return used;
}

// ─── Sessions, as the student sees them ───────────────────────────────────────

export interface PracticeSessionView {
  sessionId: number;
  status: PracticeSession["status"];
  /** True when this student's browser makes the WebRTC offer. */
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
  /** Seconds left before the server ends the call. */
  secondsRemaining: number | null;
  endReason: PracticeSession["endReason"];
}

async function viewFor(
  session: PracticeSession,
  userId: number,
): Promise<PracticeSessionView> {
  const isCaller = session.requesterId === userId;
  const partnerId = isCaller ? session.partnerId : session.requesterId;

  const [partner] = await db
    .select({
      userId: usersTable.id,
      name: usersTable.name,
      levelCode: levelsTable.code,
      interests: practiceProfilesTable.interests,
      professionalField: practiceProfilesTable.professionalField,
    })
    .from(usersTable)
    .leftJoin(studentProfilesTable, eq(studentProfilesTable.userId, usersTable.id))
    .leftJoin(levelsTable, eq(levelsTable.id, studentProfilesTable.currentLevelId))
    .leftJoin(practiceProfilesTable, eq(practiceProfilesTable.userId, usersTable.id))
    .where(eq(usersTable.id, partnerId))
    .limit(1);

  const secondsRemaining =
    session.status === "active" && session.startedAt
      ? Math.max(
          0,
          Math.round(
            (session.startedAt.getTime() + MAX_CALL_MINUTES * 60_000 - Date.now()) / 1000,
          ),
        )
      : null;

  return {
    sessionId: session.id,
    status: session.status,
    isCaller,
    partner: {
      userId: partnerId,
      name: partner?.name ?? "—",
      levelCode: partner?.levelCode ?? null,
      interests: partner?.interests ?? [],
      professionalField: partner?.professionalField ?? null,
    },
    matchScore: session.matchScore,
    startedAt: session.startedAt?.toISOString() ?? null,
    secondsRemaining,
    endReason: session.endReason,
  };
}

async function liveSessionFor(userId: number): Promise<PracticeSession | null> {
  const [session] = await db
    .select()
    .from(practiceSessionsTable)
    .where(
      and(
        inArray(practiceSessionsTable.status, ["waiting", "active"]),
        or(
          eq(practiceSessionsTable.requesterId, userId),
          eq(practiceSessionsTable.partnerId, userId),
        ),
      ),
    )
    .orderBy(desc(practiceSessionsTable.matchedAt))
    .limit(1);

  return session ?? null;
}

/**
 * Close a session that has outlived one of its bounds.
 *
 * Called from the polling path rather than a background job: both sides poll
 * every second during a call, so "when someone looks" and "promptly" are the
 * same thing here.
 */
async function expireIfDue(session: PracticeSession): Promise<PracticeSession> {
  const now = Date.now();

  if (
    session.status === "waiting" &&
    now - session.matchedAt.getTime() > RING_TIMEOUT_MS
  ) {
    return closeSession(session, "not_answered", null);
  }

  if (session.status === "active" && session.startedAt) {
    if (now - session.startedAt.getTime() > MAX_CALL_MINUTES * 60_000) {
      return closeSession(session, "timeout", null);
    }
  }

  return session;
}

/**
 * Note that one participant is still watching this call.
 *
 * Fire-and-forget by intent: this runs on a once-per-second poll, and a failed
 * presence write must never turn a working call into an error. The cost of
 * losing one is that the sweeper's view of this side is one second staler.
 */
async function touchSessionPresence(
  session: PracticeSession,
  userId: number,
): Promise<void> {
  const column =
    session.requesterId === userId ? "requesterSeenAt" : "partnerSeenAt";

  try {
    await db
      .update(practiceSessionsTable)
      .set({ [column]: new Date() })
      .where(eq(practiceSessionsTable.id, session.id));
  } catch (err) {
    logger.debug({ err, sessionId: session.id, userId }, "Presence write failed");
  }
}

async function closeSession(
  session: PracticeSession,
  reason: NonNullable<PracticeSession["endReason"]>,
  endedBy: number | null,
): Promise<PracticeSession> {
  const endedAt = new Date();
  const durationSeconds = session.startedAt
    ? Math.max(0, Math.round((endedAt.getTime() - session.startedAt.getTime()) / 1000))
    : 0;

  const [updated] = await db
    .update(practiceSessionsTable)
    .set({
      status: reason === "declined" || reason === "not_answered" ? "declined" : "ended",
      endedAt,
      durationSeconds,
      endReason: reason,
      endedBy,
    })
    .where(eq(practiceSessionsTable.id, session.id))
    .returning();

  // The handshake messages are dead weight the moment the call is over, and
  // they are the only place a student's SDP has been written down.
  await db
    .delete(practiceSignalsTable)
    .where(eq(practiceSignalsTable.sessionId, session.id));

  return updated ?? session;
}

// ─── The queue ────────────────────────────────────────────────────────────────

export interface QueueResult {
  /** The pairing, when one was found straight away. */
  session: PracticeSessionView | null;
  /** How many other students are waiting — shown so an empty pool looks empty. */
  waiting: number;
}

/**
 * Join the pool, and take a partner if one is already there.
 *
 * Matching happens on joining rather than on a timer: the person who arrives
 * last is the one with the freshest picture of who is waiting.
 */
/**
 * Close calls that nothing is looking at any more.
 *
 * `expireIfDue` runs on the polling path, on the stated assumption that "both
 * sides poll every second during a call, so when someone looks and promptly are
 * the same thing". That holds while polls arrive — and silently stops holding
 * when they do not: a browser crash, a closed laptop, or (as happened here) the
 * polls being rate-limited. The call then stays `active` forever, which is not
 * a cosmetic problem: the partial unique index on status means BOTH students are
 * locked out of ever starting another call, and the end-of-call hand-off that
 * offers an evaluation never runs.
 *
 * So this is a safety net with a different trigger — a timer rather than a
 * request — for exactly the case the polling path cannot cover.
 *
 * Deliberately generous: `MAX_CALL_MINUTES` plus a grace period, so a live call
 * whose polls are merely slow is never cut off by this. The polling path remains
 * the thing that ends calls normally.
 */
export async function closeAbandonedSessions(): Promise<number> {
  const now = Date.now();
  // `MAX_CALL_MINUTES` is the cap on a call that is being POLLED; past it the
  // polling path closes it. This net is for calls nobody is polling at all, so
  // it only needs to outlast a brief network stall — not a whole extra call.
  // At cap + 5 a closed tab held both students out of voice practice for 35
  // minutes, because the one-live-per-person index refuses anyone already in a
  // call. The client now releases the call on `pagehide`, so this is the net
  // under that, not the primary mechanism.
  const activeCutoff = new Date(now - (MAX_CALL_MINUTES + 2) * 60_000);
  const waitingCutoff = new Date(now - RING_TIMEOUT_MS * 4);
  // Both sides quiet for this long means nobody is in the call any more. Ten
  // times the one-second poll interval: long enough that a brief network stall
  // or a rate-limited poll is not mistaken for a departure, short enough that
  // a crashed tab frees both students in seconds rather than minutes.
  const presenceCutoff = new Date(now - ABANDONED_AFTER_MS);

  const stale = await db
    .select()
    .from(practiceSessionsTable)
    .where(
      or(
        and(
          eq(practiceSessionsTable.status, "active"),
          lt(practiceSessionsTable.startedAt, activeCutoff),
        ),
        // Both participants have gone quiet. Each side's presence must be
        // KNOWN to be stale: a null means that side has not polled since the
        // column existed, so a call in flight when this shipped is left to the
        // `activeCutoff` rule above rather than closed on no evidence.
        and(
          eq(practiceSessionsTable.status, "active"),
          isNotNull(practiceSessionsTable.requesterSeenAt),
          isNotNull(practiceSessionsTable.partnerSeenAt),
          lt(practiceSessionsTable.requesterSeenAt, presenceCutoff),
          lt(practiceSessionsTable.partnerSeenAt, presenceCutoff),
        ),
        and(
          eq(practiceSessionsTable.status, "waiting"),
          lt(practiceSessionsTable.matchedAt, waitingCutoff),
        ),
      ),
    )
    .limit(50);

  for (const session of stale) {
    await closeSession(
      session,
      session.status === "waiting" ? "not_answered" : "timeout",
      null,
    );
  }

  if (stale.length > 0) {
    logger.info({ count: stale.length }, "Closed abandoned practice calls");
  }
  return stale.length;
}

export async function joinQueue(userId: number): Promise<QueueResult> {
  const { levelOrder, preferences } = await loadStudent(userId);

  if (!preferences?.isAvailable) {
    throw new PracticeBlockedError(
      "NOT_OPTED_IN",
      "Set your practice preferences and opt in before looking for a partner.",
    );
  }

  const existing = await liveSessionFor(userId);
  if (existing) {
    const live = await expireIfDue(existing);
    if (live.status === "waiting" || live.status === "active") {
      throw new PracticeBlockedError("ALREADY_IN_CALL", "You are already in a call.");
    }
  }

  if ((await callsToday(userId)) >= DAILY_CALL_LIMIT) {
    throw new PracticeBlockedError(
      "DAILY_LIMIT",
      `You have reached today's limit of ${DAILY_CALL_LIMIT} practice calls.`,
    );
  }

  const now = new Date();

  // Refresh presence first, so a student who is polling never looks stale to
  // the person about to match with them.
  await db
    .insert(practiceQueueTable)
    .values({ userId, joinedAt: now, lastSeenAt: now })
    .onConflictDoUpdate({
      target: practiceQueueTable.userId,
      set: { lastSeenAt: now },
    });

  return tryMatch(userId, levelOrder, preferences, now);
}

/**
 * Look through the pool once and take a partner if there is a good one.
 *
 * Shared by joining and by polling, because the pool changes between polls and
 * whoever looks next should get the benefit of it.
 */
async function tryMatch(
  userId: number,
  levelOrder: number | null,
  preferences: PracticePreferences,
  now: Date,
): Promise<QueueResult> {
  const candidates = await loadCandidates(userId, now);
  const seeker: PracticeSeeker = {
    userId,
    levelOrder,
    goals: preferences.goals,
    interests: preferences.interests,
    professionalField: preferences.professionalField,
    availableHours: preferences.availableHours,
  };

  const match = bestPracticeMatch(seeker, candidates, {
    blockedUserIds: await blockedWith(userId),
    busyUserIds: await busyUserIds(),
    now,
  });

  if (!match) {
    // Not an error. Nobody is available right now is a real answer, and the
    // student stays in the queue for whoever arrives next.
    return { session: null, waiting: candidates.length };
  }

  try {
    const [created] = await db
      .insert(practiceSessionsTable)
      .values({
        // The one who was already waiting places the call, so the person who
        // just arrived is the one whose screen rings.
        requesterId: match.userId,
        partnerId: userId,
        status: "waiting",
        matchScore: match.score,
        matchedAt: now,
      })
      .returning();

    await db
      .delete(practiceQueueTable)
      .where(inArray(practiceQueueTable.userId, [userId, match.userId]));

    return { session: await viewFor(created!, userId), waiting: candidates.length - 1 };
  } catch (err) {
    // Two matchers picked the same waiting student a millisecond apart and the
    // partial unique index caught the loser. Nothing is broken; this student
    // simply stays in the queue and tries again on the next poll.
    logger.debug({ err, userId }, "Practice match lost a race — staying in the queue");
    return { session: null, waiting: Math.max(0, candidates.length - 1) };
  }
}

async function loadCandidates(userId: number, now: Date): Promise<PracticeCandidate[]> {
  const freshSince = new Date(now.getTime() - CANDIDATE_STALE_MS);

  const rows = await db
    .select({
      userId: practiceQueueTable.userId,
      joinedAt: practiceQueueTable.joinedAt,
      lastSeenAt: practiceQueueTable.lastSeenAt,
      levelOrder: levelsTable.order,
      goals: practiceProfilesTable.goals,
      interests: practiceProfilesTable.interests,
      professionalField: practiceProfilesTable.professionalField,
      availableHours: practiceProfilesTable.availableHours,
    })
    .from(practiceQueueTable)
    .innerJoin(
      practiceProfilesTable,
      eq(practiceProfilesTable.userId, practiceQueueTable.userId),
    )
    .leftJoin(studentProfilesTable, eq(studentProfilesTable.userId, practiceQueueTable.userId))
    .leftJoin(levelsTable, eq(levelsTable.id, studentProfilesTable.currentLevelId))
    .where(
      and(
        ne(practiceQueueTable.userId, userId),
        eq(practiceProfilesTable.isAvailable, true),
        gte(practiceQueueTable.lastSeenAt, freshSince),
      ),
    )
    .orderBy(asc(practiceQueueTable.joinedAt))
    .limit(200);

  return rows.map((r) => ({
    userId: r.userId,
    levelOrder: r.levelOrder ?? null,
    goals: r.goals ?? [],
    interests: r.interests ?? [],
    professionalField: r.professionalField ?? null,
    availableHours: r.availableHours ?? [],
    waitingSince: r.joinedAt,
    lastSeenAt: r.lastSeenAt,
  }));
}

export async function leaveQueue(userId: number): Promise<void> {
  await db.delete(practiceQueueTable).where(eq(practiceQueueTable.userId, userId));
}

// ─── Polling ──────────────────────────────────────────────────────────────────

export interface PracticeStatus {
  session: PracticeSessionView | null;
  /** True while this student is in the pool waiting for someone. */
  queued: boolean;
  waiting: number;
  secondsWaiting: number;
}

/**
 * What is happening for this student right now.
 *
 * This is also where presence is refreshed and where anything overdue is
 * closed, which is why the client polls it while queued and while in a call.
 */
export async function pollStatus(userId: number): Promise<PracticeStatus> {
  const now = new Date();

  const existing = await liveSessionFor(userId);
  if (existing) {
    const session = await expireIfDue(existing);
    // Record that this side is still here, but only while the call is live and
    // not after `expireIfDue` has just closed it — writing presence onto an
    // ended call would be noise, and the row is no longer polled anyway.
    if (session.status === "active") {
      await touchSessionPresence(session, userId);
    }
    return {
      session: await viewFor(session, userId),
      queued: false,
      waiting: 0,
      secondsWaiting: 0,
    };
  }

  const [entry] = await db
    .update(practiceQueueTable)
    .set({ lastSeenAt: now })
    .where(eq(practiceQueueTable.userId, userId))
    .returning();

  if (!entry) {
    return { session: null, queued: false, waiting: 0, secondsWaiting: 0 };
  }

  const { levelOrder, preferences } = await loadStudent(userId);
  if (!preferences?.isAvailable) {
    // They opted out in another tab. Leave the pool rather than keep offering
    // them to people.
    await leaveQueue(userId);
    return { session: null, queued: false, waiting: 0, secondsWaiting: 0 };
  }

  // Nobody matched with us while we waited, so look from this side too.
  const result = await tryMatch(userId, levelOrder, preferences, now);

  return {
    session: result.session,
    queued: result.session === null,
    waiting: result.waiting,
    secondsWaiting: Math.round((now.getTime() - entry.joinedAt.getTime()) / 1000),
  };
}

// ─── Accepting, declining, ending ─────────────────────────────────────────────

async function loadOwnSession(sessionId: number, userId: number): Promise<PracticeSession> {
  const [session] = await db
    .select()
    .from(practiceSessionsTable)
    .where(eq(practiceSessionsTable.id, sessionId))
    .limit(1);

  if (!session) throw new PracticeBlockedError("NOT_IN_CALL", "That call does not exist.");
  if (session.requesterId !== userId && session.partnerId !== userId) {
    throw new PracticeBlockedError("NOT_YOURS", "That call is not yours.");
  }
  return session;
}

export async function acceptSession(
  sessionId: number,
  userId: number,
): Promise<PracticeSessionView> {
  const session = await loadOwnSession(sessionId, userId);

  if (session.status === "active") return viewFor(session, userId);
  if (session.status !== "waiting") {
    throw new PracticeBlockedError("SESSION_ENDED", "That call has already finished.");
  }
  if (Date.now() - session.matchedAt.getTime() > RING_TIMEOUT_MS) {
    await closeSession(session, "not_answered", null);
    throw new PracticeBlockedError("SESSION_ENDED", "That call was not answered in time.");
  }

  const [updated] = await db
    .update(practiceSessionsTable)
    .set({ status: "active", startedAt: new Date() })
    .where(
      and(
        eq(practiceSessionsTable.id, sessionId),
        eq(practiceSessionsTable.status, "waiting"),
      ),
    )
    .returning();

  return viewFor(updated ?? session, userId);
}

/**
 * End a call, or decline one that is still ringing.
 *
 * Unilateral and immediate by design: someone who needs to get out of a
 * conversation is not made to confirm it first. The other side finds out on its
 * next poll, at most a second later.
 */
export async function endSession(
  sessionId: number,
  userId: number,
  reason: "ended_by_user" | "declined" | "connection_failed" = "ended_by_user",
): Promise<PracticeSessionView> {
  const session = await loadOwnSession(sessionId, userId);

  if (session.status === "ended" || session.status === "declined") {
    return viewFor(session, userId);
  }

  const effective = session.status === "waiting" && reason === "ended_by_user" ? "declined" : reason;
  return viewFor(await closeSession(session, effective, userId), userId);
}

// ─── Signalling ───────────────────────────────────────────────────────────────

export type SignalKind = "offer" | "answer" | "ice" | "bye";

export interface SignalMessage {
  id: number;
  kind: SignalKind;
  payload: unknown;
  createdAt: string;
}

/**
 * Hand one WebRTC setup message to the other side of a call.
 *
 * The recipient is derived from the session, never taken from the request: a
 * student can only ever send into their own call, to the one other person in
 * it.
 */
export async function sendSignal(
  sessionId: number,
  userId: number,
  kind: SignalKind,
  payload: unknown,
): Promise<void> {
  const session = await loadOwnSession(sessionId, userId);
  if (session.status !== "waiting" && session.status !== "active") {
    throw new PracticeBlockedError("SESSION_ENDED", "That call has already finished.");
  }

  const toUserId = session.requesterId === userId ? session.partnerId : session.requesterId;

  await db.insert(practiceSignalsTable).values({
    sessionId,
    fromUserId: userId,
    toUserId,
    kind,
    payload: payload as object,
  });
}

/** Everything addressed to this student in this call after `afterId`. */
export async function readSignals(
  sessionId: number,
  userId: number,
  afterId: number,
): Promise<SignalMessage[]> {
  await loadOwnSession(sessionId, userId);

  const rows = await db
    .select({
      id: practiceSignalsTable.id,
      kind: practiceSignalsTable.kind,
      payload: practiceSignalsTable.payload,
      createdAt: practiceSignalsTable.createdAt,
    })
    .from(practiceSignalsTable)
    .where(
      and(
        eq(practiceSignalsTable.sessionId, sessionId),
        eq(practiceSignalsTable.toUserId, userId),
        sql`${practiceSignalsTable.id} > ${afterId}`,
      ),
    )
    .orderBy(asc(practiceSignalsTable.id))
    .limit(100);

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    payload: r.payload,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * What the browser should hand to RTCPeerConnection.
 *
 * Served from the server rather than hard-coded in the bundle so a TURN relay
 * can be added by setting environment variables, without shipping new client
 * code — and so TURN credentials never sit in a public JavaScript file.
 *
 * With no TURN configured this is STUN only, and roughly one connection in five
 * will not establish. The client is told as much and says so plainly rather
 * than sitting on "connecting…".
 */
export function iceServers(): {
  iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }>;
  hasTurn: boolean;
  connectTimeoutMs: number;
} {
  const stun = (process.env.PRACTICE_STUN_URLS ??
    "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

  // An entry with an empty url list is not "no STUN", it is a malformed
  // configuration: RTCPeerConnection throws on construction and the call never
  // starts. Leave the entry out instead.
  const servers: Array<{ urls: string | string[]; username?: string; credential?: string }> =
    stun.length > 0 ? [{ urls: stun }] : [];

  const turnUrls = (process.env.PRACTICE_TURN_URLS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

  if (turnUrls.length > 0) {
    servers.push({
      urls: turnUrls,
      username: process.env.PRACTICE_TURN_USERNAME,
      credential: process.env.PRACTICE_TURN_CREDENTIAL,
    });
  }

  return {
    iceServers: servers,
    hasTurn: turnUrls.length > 0,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
  };
}

// ─── Blocking and reporting ───────────────────────────────────────────────────

/**
 * Block someone, permanently and in both directions.
 *
 * Takes effect immediately: if the two are in a call together it ends right
 * now, and the matcher will not put them together again.
 */
export async function blockUser(
  userId: number,
  blockedId: number,
  sessionId: number | null,
): Promise<void> {
  if (userId === blockedId) {
    throw new PracticeBlockedError("SELF", "You cannot block yourself.");
  }

  await db
    .insert(practiceBlocksTable)
    .values({ blockerId: userId, blockedId, sessionId })
    .onConflictDoNothing();

  // Audited here rather than in the route because a block also happens as a
  // side effect of reporting someone. A block ends a call and changes who a
  // student will ever meet again; every one of them gets a row, however it was
  // triggered.
  await audit(userId, "practice_block", "practice_user", blockedId, null, "blocked", {
    sessionId,
  });

  const live = await liveSessionFor(userId);
  if (live && (live.requesterId === blockedId || live.partnerId === blockedId)) {
    await closeSession(live, "blocked", userId);
  }
}

export async function unblockUser(userId: number, blockedId: number): Promise<void> {
  await db
    .delete(practiceBlocksTable)
    .where(
      and(
        eq(practiceBlocksTable.blockerId, userId),
        eq(practiceBlocksTable.blockedId, blockedId),
      ),
    );

  await audit(userId, "practice_unblock", "practice_user", blockedId, "blocked", null, {});
}

export async function listBlocks(
  userId: number,
): Promise<Array<{ userId: number; name: string; createdAt: string }>> {
  const rows = await db
    .select({
      userId: usersTable.id,
      name: usersTable.name,
      createdAt: practiceBlocksTable.createdAt,
    })
    .from(practiceBlocksTable)
    .innerJoin(usersTable, eq(usersTable.id, practiceBlocksTable.blockedId))
    .where(eq(practiceBlocksTable.blockerId, userId))
    .orderBy(desc(practiceBlocksTable.createdAt));

  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

export type ReportReason = "harassment" | "inappropriate" | "spam" | "language" | "other";

/**
 * Report someone to an administrator.
 *
 * Nothing is decided here. The row goes into a queue a person works through,
 * because an account suspended by a threshold cannot appeal to a script, and
 * two people can be wrong about the same third person.
 */
export async function reportUser(input: {
  reporterId: number;
  reportedId: number;
  sessionId: number | null;
  reason: ReportReason;
  detail: string | null;
  alsoBlock: boolean;
}): Promise<{ reportId: number }> {
  if (input.reporterId === input.reportedId) {
    throw new PracticeBlockedError("SELF", "You cannot report yourself.");
  }

  const [row] = await db
    .insert(practiceReportsTable)
    .values({
      reporterId: input.reporterId,
      reportedId: input.reportedId,
      sessionId: input.sessionId,
      reason: input.reason,
      detail: input.detail?.slice(0, 2000) ?? null,
    })
    .returning({ id: practiceReportsTable.id });

  if (input.alsoBlock) {
    await blockUser(input.reporterId, input.reportedId, input.sessionId);
  }

  return { reportId: row!.id };
}

// ─── History ──────────────────────────────────────────────────────────────────

export async function recentCalls(
  userId: number,
  limit = 20,
): Promise<
  Array<{
    sessionId: number;
    partnerName: string;
    partnerId: number;
    startedAt: string | null;
    durationSeconds: number | null;
    endReason: string | null;
  }>
> {
  // The same table joined twice, once for each side of the call.
  const requester = alias(usersTable, "requester_user");
  const partner = alias(usersTable, "partner_user");

  const rows = await db
    .select({
      sessionId: practiceSessionsTable.id,
      requesterId: practiceSessionsTable.requesterId,
      partnerId: practiceSessionsTable.partnerId,
      startedAt: practiceSessionsTable.startedAt,
      durationSeconds: practiceSessionsTable.durationSeconds,
      endReason: practiceSessionsTable.endReason,
      requesterName: requester.name,
      partnerName: partner.name,
    })
    .from(practiceSessionsTable)
    .innerJoin(requester, eq(requester.id, practiceSessionsTable.requesterId))
    .innerJoin(partner, eq(partner.id, practiceSessionsTable.partnerId))
    .where(
      or(
        eq(practiceSessionsTable.requesterId, userId),
        eq(practiceSessionsTable.partnerId, userId),
      ),
    )
    .orderBy(desc(practiceSessionsTable.matchedAt))
    .limit(limit);

  return rows.map((r) => {
    const isCaller = r.requesterId === userId;
    return {
      sessionId: r.sessionId,
      partnerId: isCaller ? r.partnerId : r.requesterId,
      partnerName: isCaller ? r.partnerName : r.requesterName,
      startedAt: r.startedAt?.toISOString() ?? null,
      durationSeconds: r.durationSeconds,
      endReason: r.endReason,
    };
  });
}

export const PRACTICE_LIMITS = {
  dailyCallLimit: DAILY_CALL_LIMIT,
  maxCallMinutes: MAX_CALL_MINUTES,
  ringTimeoutMs: RING_TIMEOUT_MS,
  connectTimeoutMs: CONNECT_TIMEOUT_MS,
};
