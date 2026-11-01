-- =============================================================================
-- Migration 019: Per-participant presence on a live call
--
-- WHY
-- ───
-- A call is ended by `expireIfDue`, which runs ON THE POLLING PATH. Its stated
-- assumption is that both sides poll every second during a call, so "when
-- someone looks" and "promptly" are the same thing.
--
-- That assumption stops holding the moment polls stop: a crashed tab, a closed
-- laptop, a phone losing signal. The call then stays `active` with nobody
-- watching it, and because of the partial unique indexes on `status`, BOTH
-- students are locked out of starting another call — not just the one whose
-- browser died.
--
-- Two mitigations already exist, and neither closes the hole:
--
--   * the client releases the call on `pagehide` via `sendBeacon` — which does
--     not fire on a hard crash, a kill, or a dead battery;
--   * `closeAbandonedSessions` in the sweeper closes calls past
--     MAX_CALL_MINUTES + 2 — correct, but that is up to ~17 minutes of both
--     students being unable to practise.
--
-- These two columns let the sweeper tell "nobody is here any more" from "this
-- call is merely long", which is the distinction it currently cannot make. The
-- data already flows on every poll; it just was not being written down.
--
-- WHY TWO COLUMNS, NOT ONE
-- ─────────────────────────
-- The two browsers fail independently, and one side crashing is the common
-- case. A single `last_seen_at` would be refreshed by whichever side is still
-- polling, so it would look healthy in exactly the situation worth detecting.
--
-- NULLABLE ON PURPOSE
-- ───────────────────
-- Null means "has not polled since this column existed". A ringing call is
-- already bounded by RING_TIMEOUT_MS, so presence only matters once a call is
-- active — and the sweeper treats null as "fall back to the old startedAt
-- rule", so calls already in flight when this migration lands are unaffected
-- rather than closed instantly.
-- =============================================================================

ALTER TABLE practice_sessions
  ADD COLUMN IF NOT EXISTS requester_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS partner_seen_at   timestamptz;

COMMENT ON COLUMN practice_sessions.requester_seen_at IS
  'When the requester last polled this call. Null until they poll. Used with partner_seen_at to close a call both sides have stopped watching, which otherwise locks both students out of voice practice.';

COMMENT ON COLUMN practice_sessions.partner_seen_at IS
  'When the partner last polled this call. Null until they poll. See requester_seen_at.';

-- The sweeper scans for active calls and compares both timestamps. The existing
-- indexes are keyed by participant, not by status, so this gives that scan
-- something to use instead of a sequential scan over every call ever made.
CREATE INDEX IF NOT EXISTS practice_sessions_active_presence_idx
  ON practice_sessions (status, started_at)
  WHERE status = 'active';
