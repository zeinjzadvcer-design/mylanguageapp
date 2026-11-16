-- =============================================================================
-- Migration 032: Announcements an admin sends to students
--
-- One row per send. Each student's copy is a normal notification of kind
-- 'announcement', so the bell needs no new table to read from.
-- =============================================================================

CREATE TABLE IF NOT EXISTS announcements (
  id serial PRIMARY KEY,
  title text,
  title_ar text,
  body text,
  body_ar text,
  link text,
  plan_codes text[],
  recipient_count integer NOT NULL DEFAULT 0,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN announcements.plan_codes IS
  'Plans the announcement went to, free included. Null means every student.';
