-- =============================================================================
-- Migration 030: Admin-set limit on simultaneous voice practice calls
--
-- One row, edited from /admin/ai. Null means no limit, which is what it starts
-- as, so nothing changes until an administrator sets a number.
-- =============================================================================

CREATE TABLE IF NOT EXISTS practice_settings (
  id integer PRIMARY KEY DEFAULT 1,
  max_concurrent_calls integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO practice_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMENT ON COLUMN practice_settings.max_concurrent_calls IS
  'Calls that may be ringing or connected at once across the whole site. Null means no limit.';
