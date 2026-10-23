-- =============================================================================
-- Migration 020: Optional illustration media on a lesson block
--
-- WHY NEW COLUMNS RATHER THAN REUSING `reference_media_id`
-- ────────────────────────────────────────────────────────
-- `content_blocks.reference_media_id` already holds a recording, but it has a
-- specific meaning: it is the MODEL PRONUNCIATION a student listens to before
-- reading a passage aloud, and `expects_reference_reading` decides whether a
-- transcript gets aligned against it. Reusing it for "a picture to look at" or
-- "a clip to listen to" would make that field mean two unrelated things, and the
-- pronunciation grader would start seeing media it cannot align.
--
-- So illustration media gets its own columns. Both are optional, on every block
-- type, and carry no grading semantics at all — if one is set, the student sees
-- it; if not, nothing changes.
--
-- WHY TWO COLUMNS AND NOT ONE
-- ───────────────────────────
-- A block can legitimately want both: a picture of a café and a clip of the
-- conversation that happens in it. One nullable column would force authors to
-- choose, and a `media_kind` discriminator would have to be kept in step with
-- the asset's own MIME type — two sources of truth for the same fact.
-- =============================================================================

ALTER TABLE content_blocks
  ADD COLUMN IF NOT EXISTS image_media_id integer
    REFERENCES media_assets (id) ON DELETE SET NULL;

ALTER TABLE content_blocks
  ADD COLUMN IF NOT EXISTS audio_media_id integer
    REFERENCES media_assets (id) ON DELETE SET NULL;

-- The storage KEY as well as the id, matching how `audio_note` already pairs
-- with `reference_media_id`. The id is what the student's client resolves to a
-- signed URL; the key is what the CMS picker displays and matches against the
-- media library so an author can see what is attached. Without it the picker
-- shows an empty slot even though media is attached.
ALTER TABLE content_blocks
  ADD COLUMN IF NOT EXISTS image_media_key text;

ALTER TABLE content_blocks
  ADD COLUMN IF NOT EXISTS audio_media_key text;

-- ON DELETE SET NULL, not CASCADE: deleting a media asset must never delete the
-- lesson block that happened to illustrate it. The block simply loses its
-- picture.

COMMENT ON COLUMN content_blocks.image_media_id IS
  'Optional illustration shown to the student. No grading meaning — unlike reference_media_id, which is the model pronunciation.';

COMMENT ON COLUMN content_blocks.audio_media_id IS
  'Optional audio clip played to the student. No grading meaning — unlike reference_media_id, which is aligned against for pronunciation scoring.';

-- Partial indexes: almost every block will have neither, so indexing only the
-- rows that do keeps these small. Used when a media asset is deleted and the
-- blocks referencing it have to be found.
CREATE INDEX IF NOT EXISTS content_blocks_image_media_idx
  ON content_blocks (image_media_id)
  WHERE image_media_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS content_blocks_audio_media_idx
  ON content_blocks (audio_media_id)
  WHERE audio_media_id IS NOT NULL;
