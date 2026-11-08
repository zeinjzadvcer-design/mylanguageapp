-- =============================================================================
-- Migration 025: Four plans with monthly quotas, and Syriatel Cash
--
-- Two changes that have to land together, because the second verifies payments
-- for the first.
--
-- 1. THE PRODUCT IS FOUR PLANS, NOT TWO
-- ─────────────────────────────────────
--                        lessons/mo   calls/mo
--   general_basic   $2       12           8
--   general_plus    $5       24          16
--   pro_basic       $4       12           8
--   pro_plus        $7       24          16
--
-- Each plan is a (track, tier) pair: two content tracks, two sizes each. The
-- track stays what migration 022 introduced — general and professional are
-- mutually exclusive, so pro_basic is not "general_basic plus extras".
--
-- Access was previously "all of a track, or one free lesson". Now it is metered:
-- a monthly allowance of lessons and of peer calls, which is what separates
-- $2 from $5 within the same track.
--
-- 2. SYRIATEL CASH REPLACES SHAMCASH
-- ──────────────────────────────────
-- Syriatel sends the MERCHANT an SMS when a merchant account receives money:
--
--     تم استلام مبلغ 1 ل.س بنجاح. رقم العملية هو <N>
--
-- The payer's own SMS carries the same operation number, so both sides share a
-- unique key. That is what makes automatic verification possible: the student
-- submits the number, a companion app on the merchant phone forwards the SMS,
-- and the two are matched on that key — not guessed at from amount and timing,
-- which is what every other Syrian wallet integration is reduced to.
--
-- `sham_cash` is kept in the method enum, disabled rather than deleted:
-- existing payment_submissions rows carry it, and a payment record is a
-- financial audit trail. Rewriting it to claim a student paid by a method they
-- did not use would be worse than carrying a value nothing new will write.
-- =============================================================================

-- ─── Plans: quotas and SYP pricing ───────────────────────────────────────────

-- Lessons a subscriber may START per period. NULL = unlimited.
--
-- Replaces free_lesson_quota. The period itself is per-plan: see quota_period
-- below, which is what lets the free plan keep its "one lesson, ever" while
-- the paid plans reset monthly, using one quota column rather than two that
-- both answer "how many lessons".
ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS lessons_per_month integer;

-- Whether this plan's allowance resets, and how often.
--
--   'lifetime' — counted over the account's whole history. The free trial:
--                one lesson, ever, so the paywall still bites after it.
--   'monthly'  — counted from the subscription's own start date.
--
-- Carried per plan rather than inferred from price, so a paid plan with a
-- lifetime allowance, or a free tier that renews, stay expressible without
-- another column or a special case in the access check.
ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS quota_period text NOT NULL DEFAULT 'monthly';

COMMENT ON COLUMN subscription_plans.quota_period IS
  'lifetime = counted over the whole account history (the free trial: one lesson, ever); monthly = reset from the subscription start date.';

-- Peer calls a subscriber may START per monthly period. NULL = unlimited.
--
-- PRACTICE_DAILY_CALL_LIMIT stays as it is: that is abuse control, counted per
-- rolling 24h for everyone. This is the sold allowance. Both apply, and the
-- stricter one bites.
ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS calls_per_month integer;

-- Price in Syrian pounds, for the local wallet.
--
-- Priced, not converted. Syriatel Cash moves SYP and plans are quoted in USD,
-- so verification would otherwise need an exchange rate — and on 2026-11-02 the
-- official CBS bulletin said ~122 SYP/USD while the Damascus parallel market
-- said ~143, an 18% spread. Verifying against the wrong one either rejects
-- genuine payments or under-collects. An admin-set figure makes the check exact.
--
-- numeric(14,2), not real: money compared for equality.
ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS price_syp numeric(14,2);

COMMENT ON COLUMN subscription_plans.lessons_per_month IS
  'Lessons startable per monthly period; NULL = unlimited. The period runs from the subscription start date, not the calendar month.';
COMMENT ON COLUMN subscription_plans.calls_per_month IS
  'Peer calls startable per monthly period; NULL = unlimited. Separate from PRACTICE_DAILY_CALL_LIMIT, which is abuse control for everyone.';
COMMENT ON COLUMN subscription_plans.price_syp IS
  'Admin-set price in Syrian pounds. NULL means the local wallet cannot sell this plan. Deliberately not derived from price_usd: official and parallel rates differ by roughly 18%.';

-- The enum on subscription_plans.code is enforced in the Drizzle schema rather
-- than by a database constraint, so the new codes need no DDL here — but the
-- old rows do need renaming, and `free` has to keep working.
--
-- general_english → general_basic, professional_english → pro_basic: the $2 and
-- $4 plans are the ones that already existed, so a current subscriber keeps the
-- allowance they were sold rather than being silently upgraded or downgraded.
UPDATE subscription_plans SET code = 'general_basic'
 WHERE code = 'general_english';
UPDATE subscription_plans SET code = 'pro_basic'
 WHERE code = 'professional_english';

-- student_subscriptions.plan_code is plain text and is matched against
-- subscription_plans.code, so historical rows must move with them or those
-- subscriptions would stop resolving to a plan at all — and
-- services/entitlements.ts fails closed, which would lock out paying students.
UPDATE student_subscriptions SET plan_code = 'general_basic'
 WHERE plan_code = 'general_english';
UPDATE student_subscriptions SET plan_code = 'pro_basic'
 WHERE plan_code = 'professional_english';

-- Quotas for the plans that exist. The two new tiers are inserted by the seed,
-- which owns plan creation; this only backfills what is already here.
-- The free trial: one lesson for the lifetime of the account, and no calls.
-- 'lifetime' is what makes it a trial rather than a small recurring plan — a
-- monthly reset would hand every student a free lesson every month forever.
UPDATE subscription_plans
   SET lessons_per_month = 1, calls_per_month = 0, quota_period = 'lifetime'
 WHERE code = 'free';
UPDATE subscription_plans
   SET lessons_per_month = 12, calls_per_month = 8
 WHERE code IN ('general_basic', 'pro_basic');

-- free_lesson_quota is superseded by lessons_per_month. Dropped rather than
-- left in place: two columns that both answer "how many lessons" is how the old
-- lessons_access ended up meaning two different things at once.
ALTER TABLE subscription_plans
  DROP COLUMN IF EXISTS free_lesson_quota;

-- ─── Counting a monthly period ───────────────────────────────────────────────
--
-- The period runs from the subscription's start date: a student who subscribes
-- on the 14th resets on the 14th. That matches how they experience paying, and
-- expires_at already works this way, so one date drives both.
--
-- Stored rather than derived because `started_at` moves: activation sets it
-- when payment is confirmed, and a renewal will set it again. Without a fixed
-- anchor, a renewal mid-month would silently reset the allowance.
ALTER TABLE student_subscriptions
  ADD COLUMN IF NOT EXISTS period_started_at timestamptz;

UPDATE student_subscriptions
   SET period_started_at = started_at
 WHERE period_started_at IS NULL AND status = 'active';

COMMENT ON COLUMN student_subscriptions.period_started_at IS
  'Start of the current monthly quota period. Rolled forward a month at a time by the entitlement check, so a long-dormant subscription catches up rather than granting one allowance for the whole gap.';

-- Quota counting reads lesson_progress and practice sessions by user and date.
-- lesson_progress already has lesson_progress_user_id_idx; this covers the
-- started_at range scan the period check adds.
CREATE INDEX IF NOT EXISTS lesson_progress_user_started_idx
  ON lesson_progress (user_id, started_at)
  WHERE started_at IS NOT NULL;

-- ─── What the student submits for a wallet payment ───────────────────────────

-- The operation number from the payer's SMS. Text, not numeric: an identifier
-- that happens to be digits, where leading zeros matter and nothing is computed.
ALTER TABLE payment_submissions
  ADD COLUMN IF NOT EXISTS operation_number text;

-- What the student says they sent, and what they owed, both in SYP. Kept apart
-- so a mismatch is visible to an admin rather than silently overwritten.
ALTER TABLE payment_submissions
  ADD COLUMN IF NOT EXISTS amount_claimed_syp numeric(14,2);
ALTER TABLE payment_submissions
  ADD COLUMN IF NOT EXISTS amount_expected_syp numeric(14,2);

COMMENT ON COLUMN payment_submissions.operation_number IS
  'رقم العملية from the payer''s Syriatel SMS. A bearer secret: Syriatel sends it only to the payer and the merchant and it appears nowhere public, which is what makes an unverified claim believable.';

-- ONE OPERATION NUMBER BUYS ONE SUBSCRIPTION, EVER.
--
-- The same control as the crypto tx_hash index, for the same reason: without it
-- one payment could be claimed repeatedly, and every claim would verify because
-- the payment really did happen. Enforced by the database, not by a prior
-- SELECT, so two simultaneous submissions of one number cannot both win.
-- Created by 029, partial so a rejected claim does not burn the number.

-- ─── Wallet settings, generalised ────────────────────────────────────────────
--
-- The columns were named sham_cash_*. Renamed to wallet_* rather than adding a
-- parallel syriatel_cash_* set: there is one local wallet at a time, and which
-- one it is belongs in a value, not in a column name. A second simultaneous
-- wallet would be its own table, not more columns here.
-- Guarded, because these migrations must be safe to re-run and a bare RENAME
-- is not. migrate.mjs pushes the Drizzle schema BEFORE applying this file, so
-- on a fresh database the wallet_* columns already exist and there is nothing
-- to rename — the rename only has work to do on a database that predates this
-- migration. Renaming inside the guard also carries the old values across,
-- which is the whole point: an admin's uploaded QR and account code must
-- survive the change.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'payment_settings' AND column_name = 'sham_cash_qr_media_id'
  ) THEN
    ALTER TABLE payment_settings
      RENAME COLUMN sham_cash_qr_media_id TO wallet_qr_media_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'payment_settings' AND column_name = 'sham_cash_account_name'
  ) THEN
    ALTER TABLE payment_settings
      RENAME COLUMN sham_cash_account_name TO wallet_account_name;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'payment_settings' AND column_name = 'sham_cash_account_number'
  ) THEN
    ALTER TABLE payment_settings
      RENAME COLUMN sham_cash_account_number TO wallet_account_number;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'payment_settings' AND column_name = 'sham_cash_instructions_ar'
  ) THEN
    ALTER TABLE payment_settings
      RENAME COLUMN sham_cash_instructions_ar TO wallet_instructions_ar;
  END IF;
END $$;

-- Drop the originals only if BOTH names somehow exist — a database where the
-- Drizzle push created wallet_* while sham_cash_* was still present. Without
-- this the old columns linger holding the real values while the app reads the
-- empty new ones.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'payment_settings' AND column_name = 'sham_cash_qr_media_id'
  ) THEN
    -- Carry the values over before discarding them.
    UPDATE payment_settings SET
      wallet_qr_media_id     = COALESCE(wallet_qr_media_id, sham_cash_qr_media_id),
      wallet_account_name    = COALESCE(wallet_account_name, sham_cash_account_name),
      wallet_account_number  = COALESCE(wallet_account_number, sham_cash_account_number),
      wallet_instructions_ar = COALESCE(wallet_instructions_ar, sham_cash_instructions_ar);

    ALTER TABLE payment_settings DROP COLUMN sham_cash_qr_media_id;
    ALTER TABLE payment_settings DROP COLUMN sham_cash_account_name;
    ALTER TABLE payment_settings DROP COLUMN sham_cash_account_number;
    ALTER TABLE payment_settings DROP COLUMN sham_cash_instructions_ar;
  END IF;
END $$;

ALTER TABLE payment_settings
  ADD COLUMN IF NOT EXISTS wallet_provider text NOT NULL DEFAULT 'syriatel_cash';

-- The merchant handset that receives Syriatel's SMS. Recorded so an admin can
-- see where the companion app belongs; the server never sends to it.
ALTER TABLE payment_settings
  ADD COLUMN IF NOT EXISTS wallet_merchant_phone text;

-- Shared secret the companion app presents when forwarding an SMS. Null until
-- an admin generates one, and the ingest endpoint refuses everything while it
-- is null — an open ingest would let anyone mint a payment confirmation.
ALTER TABLE payment_settings
  ADD COLUMN IF NOT EXISTS sms_ingest_token text;

COMMENT ON COLUMN payment_settings.wallet_provider IS
  'Which local wallet the wallet_* details describe. One at a time.';
COMMENT ON COLUMN payment_settings.sms_ingest_token IS
  'Bearer token for the companion app. While NULL the ingest endpoint refuses every request: an unauthenticated ingest would let anyone fabricate a payment confirmation.';

-- ─── SMS ingest ──────────────────────────────────────────────────────────────
--
-- What the companion app forwards. Stored before matching is attempted, and
-- kept whether or not it matches: an unmatched message is the evidence an admin
-- needs when a student says they paid, a message arriving before the student
-- submits must still match afterwards, and a parser change can be replayed
-- against what was actually received rather than against a guess at it.
CREATE TABLE IF NOT EXISTS wallet_sms_messages (
  id serial PRIMARY KEY,

  -- Exactly as received. Never parsed in place; the parsed columns are derived
  -- and this stays the record of what Syriatel actually sent.
  raw_text text NOT NULL,
  sender text,
  -- When the handset received it, which is not when the server was told: a
  -- phone offline for an hour reports an older timestamp, and any validity
  -- window has to be measured from this.
  received_at timestamptz NOT NULL,

  -- Null when parsing failed — itself the signal that the message format
  -- changed and an admin should look, rather than a silent mismatch.
  parsed_operation_number text,
  parsed_amount_syp numeric(14,2),

  matched_submission_id integer
    REFERENCES payment_submissions (id) ON DELETE SET NULL,
  matched_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now()
);

-- No uniqueness on the SMS operation number. An earlier version of this file
-- created a unique index here; migration 026 drops it, because a redelivered
-- message must be storable — refusing it burned the operation number and made
-- a real payment unmatchable. Since every migration re-runs on each start,
-- creating the index here would recreate what 026 retired, and fail outright
-- once a duplicate message exists, blocking startup. The index 026 creates is
-- the one that applies. Uniqueness belongs on
-- payment_submissions.operation_number, created above.

CREATE INDEX IF NOT EXISTS wallet_sms_unmatched_idx
  ON wallet_sms_messages (received_at DESC)
  WHERE matched_submission_id IS NULL;

COMMENT ON TABLE wallet_sms_messages IS
  'Confirmation SMS forwarded by the companion app on the merchant phone. Raw text is kept so a reworded message can be re-parsed and an unmatched payment has evidence behind it.';

-- SYP prices are left NULL on purpose. A figure invented here would be a guess
-- at an exchange rate, and a wrong one either rejects genuine payments or
-- undercharges — so an admin sets it, and the payment page refuses the wallet
-- until they have. A missing price is a visible gap; a fabricated one is not.
