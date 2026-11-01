-- =============================================================================
-- Migration 021: Per-minute pricing for speech providers
--
-- WHY
-- ───
-- `ai_providers` priced everything per million tokens, because that is how chat
-- models are sold. Transcription is not: it is sold per MINUTE OF AUDIO, and a
-- speech provider therefore had no price field it could use.
--
-- The consequence was not a rounding error. `computeCostUsd` returns null when
-- both token prices are null — deliberately, so an unpriced provider is visible
-- rather than silently free — so every transcription recorded no cost at all.
-- And `ai_settings.monthly_budget_usd` is enforced by summing
-- `ai_usage_logs.cost_usd`, which meant the budget ceiling could not see
-- transcription spend.
--
-- That is the dominant cost of the peer-call feature: multichannel ASR is
-- roughly 90% of an evaluated call ($0.10 of $0.111 on a 20-minute call). The
-- budget guard was blind to almost all of it.
--
-- WHAT THIS DOES NOT DO
-- ─────────────────────
-- It does not set a price. The column is nullable and starts null, exactly like
-- the token prices, because a price that is guessed is worse than one that is
-- absent: the budget acts on it. An administrator enters the real rate at
-- /admin/ai-settings, and until they do, transcription keeps recording a null
-- cost and the panel shows the provider as unpriced.
--
-- AssemblyAI Universal-2 is $0.0025/minute at the time of writing. Multichannel
-- doubles that because it is billed per channel, which the application handles
-- by reporting how many channels were billed rather than assuming one.
-- =============================================================================

ALTER TABLE ai_providers
  ADD COLUMN IF NOT EXISTS price_per_minute real;

COMMENT ON COLUMN ai_providers.price_per_minute IS
  'USD per minute of audio, for role = speech. Null means the price has not been entered, and transcription then records a null cost rather than a guessed one. Multichannel is billed per channel, so a stereo recording costs this rate twice over.';

-- `ai_providers_prices_check` (migration 007) guards the two token prices
-- against negatives. The new column needs the same guard, and the constraint
-- has to be replaced rather than added to — a CHECK cannot be extended in
-- place. Dropped by name first so this is re-runnable: every migration here is
-- applied at least twice (push, then SQL) on a deploy.
--
-- The API already rejects a negative price, but that is one caller. This is the
-- rule itself: a price below zero would subtract from the monthly spend total
-- and open the budget ceiling rather than close it.
ALTER TABLE ai_providers
  DROP CONSTRAINT IF EXISTS ai_providers_prices_check;

ALTER TABLE ai_providers
  ADD CONSTRAINT ai_providers_prices_check
  CHECK (
    (input_price_per_mtok  IS NULL OR input_price_per_mtok  >= 0) AND
    (output_price_per_mtok IS NULL OR output_price_per_mtok >= 0) AND
    (price_per_minute      IS NULL OR price_per_minute      >= 0)
  );
