-- =============================================================================
-- Migration 033: Admin-set placement rules
--
-- One row, edited from /admin/placement-rules. Null rules mean the built-in
-- defaults, which is what it starts as, so nothing changes until an
-- administrator saves different rules.
-- =============================================================================

CREATE TABLE IF NOT EXISTS placement_settings (
  id integer PRIMARY KEY DEFAULT 1,
  rules jsonb,
  updated_by integer REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO placement_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMENT ON COLUMN placement_settings.rules IS
  'Difficulty weights, score needed per level, writing weight and skill cut-offs. Null means the defaults in the API.';
