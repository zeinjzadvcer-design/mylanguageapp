-- =============================================================================
-- Migration 022: Plan access model — content track + free lesson quota
--
-- WHAT THE PRODUCT ACTUALLY SELLS
-- ───────────────────────────────
-- A new student takes the placement test (اختبار تحديد المستوى) for free, then
-- gets ONE lesson from the general track at their placed level. After that
-- every lesson locks until a plan is active.
--
-- The two paid plans are MUTUALLY EXCLUSIVE CONTENT TRACKS, not tiers:
--
--   free                  $0   general track, ONE lesson only
--   general_english       $2   general track, every level
--   professional_english  $4   professional track, every level
--
-- Neither paid plan is a superset of the other. A general subscriber must not
-- see professional lessons, and a professional subscriber must not see general
-- ones. They carry a similar number of lessons; the content differs.
--
-- WHY `lessons_access` HAS TO GO
-- ──────────────────────────────
-- The old column was text with enum ('a1_only' | 'full' | 'professional_only'),
-- and it cannot express any of the above:
--
--   * It conflates "which content" with "how much content". Free access is not
--     level-scoped at all — it is one lesson at whatever level placement
--     assigned, which varies per student.
--   * Both paid plans were seeded as 'full', so professional_english granted
--     exactly what general_english granted. The paywall it implied did not
--     distinguish the two tracks it was supposed to sell.
--   * 'professional_only' was never used by any row or any query.
--
-- Nothing enforced it either: the column was read in exactly one place, echoed
-- to the client in routes/subscriptions.ts, and no route ever gated on it. So
-- every student had full access to every lesson in both tracks regardless of
-- plan. Dropping it removes a field that promised a rule it never applied.
--
-- WHY TWO COLUMNS INSTEAD OF A RICHER ENUM
-- ────────────────────────────────────────
-- "Which content" and "how much of it" are orthogonal. Any single enum has to
-- enumerate the product of both, and gains a new value every time either side
-- changes — which is how 'a1_only' and 'professional_only' came to mean
-- different kinds of thing. Two columns let a free professional trial exist
-- later by setting ('professional', 1), with no migration and no new value.
-- =============================================================================

-- WHY A NEW `lessons.track` AND NOT `lessons.lesson_type`
-- ───────────────────────────────────────────────────────
-- `lesson_type` looks like the obvious discriminator and is the wrong one. It
-- already means the lesson's PEDAGOGICAL FORMAT — 'reading', 'pronunciation',
-- 'speaking', 'vocabulary', 'grammar', 'conversation', 'assessment' — and that
-- meaning is load-bearing: services/weakness.ts picks remedial lessons by
-- matching 'reading'/'pronunciation'/'speaking', and the student UI chooses a
-- lesson's icon and colour from it.
--
-- Track and format are orthogonal. A professional reading lesson is both
-- 'reading' and 'professional'; one column cannot hold both, and overloading
-- it would force authors to give up the format whenever they set the track,
-- silently breaking weakness targeting for every professional lesson.
--
-- So the track gets its own column, defaulting to 'general' so that every
-- lesson that exists today keeps being sold exactly as it is now.
ALTER TABLE lessons
  ADD COLUMN IF NOT EXISTS track text NOT NULL DEFAULT 'general';

COMMENT ON COLUMN lessons.track IS
  'Which plan track sells this lesson: general or professional. Orthogonal to lesson_type, which is the pedagogical format.';

-- Every lesson-listing query filters on this, so it is read on the hot path.
CREATE INDEX IF NOT EXISTS lessons_track_idx ON lessons (track);

-- Which lessons this plan unlocks. Matched against `lessons.track`.
-- Plain text, not an enum, to match the content side: lesson_type was
-- deliberately widened from a pgEnum so new values need only an INSERT (see
-- docs/multi-curriculum-arch.md), and an enum here would re-impose on the plan
-- side the constraint that was lifted on the content side.
ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS lesson_track text NOT NULL DEFAULT 'general';

-- How many distinct lessons a subscriber may START. NULL means unlimited.
--
-- NULL rather than a sentinel like 0 or -1: "no limit" is genuinely the absence
-- of a limit, and SQL comparisons against NULL already fail closed. A 0 would
-- read as "no lessons at all" to anyone scanning the table.
ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS free_lesson_quota integer;

COMMENT ON COLUMN subscription_plans.lesson_track IS
  'Which content track this plan unlocks. Matched against lessons.track. Tracks are mutually exclusive, not nested.';

COMMENT ON COLUMN subscription_plans.free_lesson_quota IS
  'Maximum distinct lessons a subscriber may start. NULL = unlimited. 1 on the free plan: the single trial lesson after placement.';

-- Backfill by plan code. Spelled out per row rather than derived from the old
-- lessons_access value, because that value does not carry the track: both paid
-- plans held 'full', so there is nothing in the old column to derive the
-- general/professional split from.
UPDATE subscription_plans
   SET lesson_track = 'general', free_lesson_quota = 1
 WHERE code = 'free';

UPDATE subscription_plans
   SET lesson_track = 'general', free_lesson_quota = NULL
 WHERE code = 'general_english';

UPDATE subscription_plans
   SET lesson_track = 'professional', free_lesson_quota = NULL
 WHERE code = 'professional_english';

-- Any plan added since this migration was written keeps the column default
-- ('general', unlimited) rather than silently granting nothing. A plan that
-- grants no lessons is a support ticket; a plan that grants the common case is
-- merely imprecise, and an admin can correct it.

ALTER TABLE subscription_plans
  DROP COLUMN IF EXISTS lessons_access;

-- Index the track: every lesson-listing request resolves the caller's plan, so
-- this is read on the hot path. Small table, but the lookup is per-request.
CREATE INDEX IF NOT EXISTS subscription_plans_lesson_track_idx
  ON subscription_plans (lesson_track);

-- The free-lesson quota counts DISTINCT lessons a student has started, read
-- from lesson_progress on every start attempt. lesson_progress already has
-- lesson_progress_user_id_idx and a unique index on (user_id, lesson_id), so
-- the count is served from existing indexes and needs nothing new here.
