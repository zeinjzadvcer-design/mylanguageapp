import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { real } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import { mediaAssetsTable } from "./cms";

/**
 * Student-to-student voice practice (spec section 11).
 *
 * Separate from the AI tutor: no model is called, no AI quota is spent, and the
 * audio never reaches the server — it is a direct peer-to-peer WebRTC call
 * between two browsers, and it is not recorded.
 *
 * This is the only feature in the product where one student's action affects
 * another, which is why blocking and reporting are part of it rather than a
 * later addition.
 */

/**
 * What a student wants to practise, and whether they are open to being matched.
 *
 * `isAvailable` is the opt-in to the feature. Being in the queue is a separate,
 * momentary thing — see practiceQueueTable.
 */
export const practiceProfilesTable = pgTable(
  "practice_profiles",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),

    isAvailable: boolean("is_available").notNull().default(false),

    /** Free-text tags; matching compares them lowercased. */
    goals: text("goals").array().notNull().default([]),
    interests: text("interests").array().notNull().default([]),
    professionalField: text("professional_field"),

    /**
     * Hours of the day in UTC (0–23) rather than a calendar. The question is
     * "is this person likely to be around now", and a set of hours answers it
     * in one comparison.
     */
    availableHours: integer("available_hours").array().notNull().default([]),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    userIdUnique: uniqueIndex("practice_profiles_user_id_unique").on(table.userId),
  }),
);

export type PracticeProfile = typeof practiceProfilesTable.$inferSelect;

/**
 * Who is waiting for a partner right now.
 *
 * `lastSeenAt` is refreshed by every poll, and matching ignores rows that have
 * gone quiet. A student who closes the tab drops out of consideration by
 * itself, which is why nothing has to be deleted on the way out.
 */
export const practiceQueueTable = pgTable(
  "practice_queue",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdUnique: uniqueIndex("practice_queue_user_id_unique").on(table.userId),
    lastSeenIdx: index("practice_queue_last_seen_idx").on(table.lastSeenAt),
  }),
);

export type PracticeQueueEntry = typeof practiceQueueTable.$inferSelect;

/** One call between two students. */
export const practiceSessionsTable = pgTable(
  "practice_sessions",
  {
    id: serial("id").primaryKey(),
    /** Waited first; their browser makes the WebRTC offer. */
    requesterId: integer("requester_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    partnerId: integer("partner_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),

    status: text("status", { enum: ["waiting", "active", "ended", "declined"] })
      .notNull()
      .default("waiting"),

    /** What the matcher scored this pair, kept so a bad match can be explained. */
    matchScore: integer("match_score"),

    matchedAt: timestamp("matched_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when the partner accepts, not when the pair is proposed. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds"),

    /**
     * When each side was last heard from, refreshed by their own poll.
     *
     * Two columns rather than one because the two browsers fail independently:
     * one student's tab crashing is the common case, and a single "last seen"
     * would be kept alive by the other side still polling, which is exactly the
     * situation this is meant to detect.
     *
     * Null until the call goes `active`. A ringing call is already bounded by
     * `RING_TIMEOUT_MS`, so presence only becomes interesting once a call is
     * live and expected to be polled every second.
     */
    requesterSeenAt: timestamp("requester_seen_at", { withTimezone: true }),
    partnerSeenAt: timestamp("partner_seen_at", { withTimezone: true }),

    endReason: text("end_reason", {
      enum: [
        "ended_by_user",
        "blocked",
        "timeout",
        "not_answered",
        "connection_failed",
        "declined",
      ],
    }),
    endedBy: integer("ended_by").references(() => usersTable.id, { onDelete: "set null" }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One live call per person on each side. These do not by themselves stop
    // someone being requester of one and partner of another — the service
    // checks both columns — but they do stop the race that matters: two
    // matchers picking the same waiting student a millisecond apart.
    oneLivePerRequester: uniqueIndex("practice_sessions_one_live_per_requester")
      .on(table.requesterId)
      .where(sql`${table.status} IN ('waiting', 'active')`),
    oneLivePerPartner: uniqueIndex("practice_sessions_one_live_per_partner")
      .on(table.partnerId)
      .where(sql`${table.status} IN ('waiting', 'active')`),
    requesterIdx: index("practice_sessions_requester_idx").on(
      table.requesterId,
      table.matchedAt,
    ),
    partnerIdx: index("practice_sessions_partner_idx").on(table.partnerId, table.matchedAt),
  }),
);

export type PracticeSession = typeof practiceSessionsTable.$inferSelect;

/**
 * Append-only. A block is permanent unless the student reverses it, and it
 * works both ways round from one row: the matching query looks in both
 * directions. Writing a mirrored row would tell the blocked student something
 * about the block, which is not information they are owed.
 */
export const practiceBlocksTable = pgTable(
  "practice_blocks",
  {
    id: serial("id").primaryKey(),
    blockerId: integer("blocker_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    blockedId: integer("blocked_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    /** The call it happened in, for an administrator reading a report. */
    sessionId: integer("session_id").references(() => practiceSessionsTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pairUnique: uniqueIndex("practice_blocks_pair_unique").on(
      table.blockerId,
      table.blockedId,
    ),
    blockedIdx: index("practice_blocks_blocked_idx").on(table.blockedId),
  }),
);

export type PracticeBlock = typeof practiceBlocksTable.$inferSelect;

/**
 * Append-only, for a person to review.
 *
 * Nothing here is acted on automatically. An account is not suspended because
 * two people reported it, because two people can be wrong and a suspended
 * student cannot appeal to a script.
 */
export const practiceReportsTable = pgTable(
  "practice_reports",
  {
    id: serial("id").primaryKey(),
    reporterId: integer("reporter_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    reportedId: integer("reported_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    sessionId: integer("session_id").references(() => practiceSessionsTable.id, {
      onDelete: "set null",
    }),

    reason: text("reason", {
      enum: ["harassment", "inappropriate", "spam", "language", "other"],
    }).notNull(),
    detail: text("detail"),

    status: text("status", { enum: ["open", "reviewed", "actioned"] })
      .notNull()
      .default("open"),
    reviewedBy: integer("reviewed_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index("practice_reports_status_idx").on(table.status, table.createdAt),
    reportedIdx: index("practice_reports_reported_idx").on(
      table.reportedId,
      table.createdAt,
    ),
  }),
);

export type PracticeReport = typeof practiceReportsTable.$inferSelect;

/**
 * The WebRTC signalling mailbox.
 *
 * `id` is the cursor: a client asks for everything after the highest id it has
 * seen. Nothing needs deleting for correctness, and a client that misses a poll
 * catches up on the next one.
 */
export const practiceSignalsTable = pgTable(
  "practice_signals",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => practiceSessionsTable.id, { onDelete: "cascade" }),
    fromUserId: integer("from_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    toUserId: integer("to_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),

    kind: text("kind", { enum: ["offer", "answer", "ice", "bye"] }).notNull(),
    payload: jsonb("payload").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    inboxIdx: index("practice_signals_inbox_idx").on(
      table.sessionId,
      table.toUserId,
      table.id,
    ),
  }),
);

export type PracticeSignal = typeof practiceSignalsTable.$inferSelect;


/**
 * Opt-in evaluation of one peer call.
 *
 * The call itself is not recorded — that is a property of the feature, not a
 * gap. So feedback on a call can only exist if the students choose to produce
 * a recording for it, and BOTH of them have to agree before any audio is
 * accepted: one person cannot have the other's voice analysed.
 *
 * Kept out of `practiceSessionsTable` on purpose. Consent is per person and
 * needs a timestamp per person; almost no call is ever evaluated, so these
 * columns would be null on nearly every session row; and a session row is read
 * once a second per participant for the length of a call, which is no place to
 * park a transcript.
 */
export const practiceCallEvaluationsTable = pgTable(
  "practice_call_evaluations",
  {
    id: serial("id").primaryKey(),

    sessionId: integer("session_id")
      .notNull()
      .references(() => practiceSessionsTable.id, { onDelete: "cascade" }),

    /** Who asked. The other participant still has to agree. */
    requestedBy: integer("requested_by")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),

    status: text("status", {
      enum: [
        "requested",
        "consented",
        "declined",
        "uploaded",
        "analyzing",
        "completed",
        "failed",
        "expired",
      ],
    })
      .notNull()
      .default("requested"),

    // Per person and timestamped, because "they both agreed" has to still be
    // answerable months later.
    requesterConsentedAt: timestamp("requester_consented_at", { withTimezone: true }),
    partnerConsentedAt: timestamp("partner_consented_at", { withTimezone: true }),

    /**
     * The uploaded recording. Cleared once the transcript exists: keeping the
     * audio would turn an opt-in evaluation into a recording archive.
     */
    mediaAssetId: integer("media_asset_id").references(() => mediaAssetsTable.id, {
      onDelete: "set null",
    }),

    /**
     * True when the recording has the uploader's own microphone on one channel
     * and the peer on the other. Attribution is then exact; false means it had
     * to be guessed and the student is told so.
     */
    channelSeparated: boolean("channel_separated").notNull().default(false),

    /** Diarized turns: `[{ speaker, text, start, end }]`. */
    transcript: jsonb("transcript"),

    /**
     * Which provider label ("A"/"B") was taken to be the requester. A guess —
     * diarization labels nobody — so it is shown as an attribution that may be
     * wrong rather than as fact.
     */
    requesterSpeakerLabel: text("requester_speaker_label"),
    speakerMappingConfidence: real("speaker_mapping_confidence"),

    // Each participant reads only their own.
    requesterFeedbackAr: text("requester_feedback_ar"),
    requesterFeedback: text("requester_feedback"),
    partnerFeedbackAr: text("partner_feedback_ar"),
    partnerFeedback: text("partner_feedback"),

    /** Shared, non-attributed observations about the conversation. */
    summaryAr: text("summary_ar"),
    summary: text("summary"),

    durationSeconds: integer("duration_seconds"),
    error: text("error"),

    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (table) => ({
    // One live evaluation per call. A declined or failed attempt leaves the
    // predicate, so it does not block a fresh request.
    oneLive: uniqueIndex("practice_call_evaluations_one_live")
      .on(table.sessionId)
      .where(sql`${table.status} IN ('requested', 'consented', 'uploaded', 'analyzing')`),
    sessionIdx: index("practice_call_evaluations_session_idx").on(table.sessionId),
    requestedByIdx: index("practice_call_evaluations_requested_by_idx").on(
      table.requestedBy,
      table.requestedAt,
    ),
  }),
);

export type PracticeCallEvaluation = typeof practiceCallEvaluationsTable.$inferSelect;
