-- =============================================================================
-- Migration 011: AI conversation tutor
--
-- Spec section 4D: roughly ten minutes of conversation built on the lesson's
-- topic, text, target vocabulary, learning objective and the student's level.
-- Section 7 constrains it hard: stay on topic, keep corrections brief, avoid
-- long lectures, and — the part that needs a table rather than a prompt —
-- "the duration and usage of AI conversations must be limited by the
-- lesson/curriculum configuration."
--
-- A limit a model is merely asked to respect is not a limit. Turns are counted
-- and time is measured here, and the server refuses past the cap regardless of
-- what the model would have said next. This is also the single most expensive
-- AI feature in the product, so the cap is the cost control too.
--
-- Idempotent — safe to run multiple times on any database state.
-- =============================================================================

BEGIN;

-- ─── A conversation ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conversation_sessions (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id        INTEGER     REFERENCES lessons(id) ON DELETE CASCADE,
  /** The conversation block that started it, for the topic and its config. */
  block_id         INTEGER     REFERENCES content_blocks(id) ON DELETE SET NULL,

  /** active | completed | abandoned */
  status           TEXT        NOT NULL DEFAULT 'active',

  /**
   * The caps this session was opened under, copied rather than read live.
   * A curriculum edit mid-conversation must not silently change the rules a
   * student is already playing by.
   */
  max_turns        INTEGER     NOT NULL DEFAULT 20,
  max_minutes      INTEGER     NOT NULL DEFAULT 10,

  /** Student turns taken. The AI's replies are not counted against them. */
  turn_count       INTEGER     NOT NULL DEFAULT 0,

  /** Target words from the lesson that the student actually used. */
  vocabulary_used  TEXT[]      NOT NULL DEFAULT '{}',

  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at         TIMESTAMPTZ,
  /** Written when the session closes: what was covered and how it went. */
  summary          JSONB,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversation_sessions_status_check') THEN
    ALTER TABLE conversation_sessions
      ADD CONSTRAINT conversation_sessions_status_check
      CHECK (status IN ('active', 'completed', 'abandoned'));
  END IF;

  -- The limits 031 set, not the 100 turns / 120 minutes this first had. The
  -- schema push drops this constraint on every run (Drizzle does not declare
  -- it) and this file runs before 031, so re-adding the old limits failed on
  -- any administrator's conversation 031 allows, and stopped the migration.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversation_sessions_caps_check') THEN
    ALTER TABLE conversation_sessions
      ADD CONSTRAINT conversation_sessions_caps_check
      CHECK (max_turns > 0 AND max_turns <= 10000 AND max_minutes > 0 AND max_minutes <= 1440);
  END IF;
END $$;

-- One live conversation per student. Without this a student could open five
-- and burn five times the quota in parallel, each of which passed its own
-- check.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_sessions_one_active_per_user
  ON conversation_sessions (user_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS conversation_sessions_user_idx
  ON conversation_sessions (user_id, started_at);

-- ─── The turns ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conversation_turns (
  id             SERIAL PRIMARY KEY,
  session_id     INTEGER     NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  /** student | tutor */
  role           TEXT        NOT NULL,
  content        TEXT        NOT NULL,

  /** Set when the student spoke rather than typed — reuses speech assessment. */
  media_asset_id INTEGER     REFERENCES media_assets(id) ON DELETE SET NULL,
  /** What the recogniser heard, when the turn was spoken. */
  transcript     TEXT,

  /** Provider/model/token accounting for the reply this turn produced. */
  ai_meta        JSONB,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversation_turns_role_check') THEN
    ALTER TABLE conversation_turns
      ADD CONSTRAINT conversation_turns_role_check
      CHECK (role IN ('student', 'tutor'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS conversation_turns_session_idx
  ON conversation_turns (session_id, created_at);

COMMIT;
