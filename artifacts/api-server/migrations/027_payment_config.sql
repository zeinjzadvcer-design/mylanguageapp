-- =============================================================================
-- Migration 027: AI policies for the renamed plans, an automatic SYP rate,
-- and an admin-managed crypto wallet
-- =============================================================================

-- ─── 1. AI policies follow the plan rename ───────────────────────────────────
--
-- A REGRESSION FIX, and the most urgent thing in this file.
--
-- Migration 025 renamed general_english → general_basic and
-- professional_english → pro_basic, and moved student_subscriptions with them.
-- ai_plan_policies was not moved. It is keyed by plan code, and a missing row
-- FAILS CLOSED — getDailyLimit returns 0, deliberately, so a task added later is
-- never silently free. So from 025 onwards every paying subscriber was denied
-- every AI feature: open-answer grading, pronunciation, the conversation tutor
-- and peer-call analysis.
--
-- The basic tiers take their predecessors' policies exactly. The two plus tiers
-- start from the same figures: they cost more and an admin will likely want to
-- raise them, but starting them at zero would repeat the bug for the most
-- expensive plans. Existing rows are never overwritten, so an admin's edits
-- survive a re-run.
INSERT INTO ai_plan_policies (plan_code, task, daily_limit, monthly_limit, monthly_minutes)
SELECT new_code, p.task, p.daily_limit, p.monthly_limit, p.monthly_minutes
  FROM ai_plan_policies p
  JOIN (VALUES
         ('general_english',      'general_basic'),
         ('general_english',      'general_plus'),
         ('professional_english', 'pro_basic'),
         ('professional_english', 'pro_plus')
       ) AS m(old_code, new_code) ON m.old_code = p.plan_code
ON CONFLICT (plan_code, task) DO NOTHING;

-- The old rows are left in place rather than deleted: nothing reads them once
-- no subscription carries those codes, and keeping them means a mistaken
-- rename can be undone without having lost the figures.

-- ─── 2. Automatic Syrian pound pricing ───────────────────────────────────────
--
-- When the switch is on, each plan's SYP price is its USD price multiplied by a
-- rate fetched from SP Today (الليرة اليوم). When it is off, the admin's own
-- figure in subscription_plans.price_syp is used, exactly as before.
--
-- The fetched rate is STORED, not fetched per request. SP Today's free tier is
-- 100 requests a month; a fetch per page view would exhaust it in an afternoon.
-- A rate refreshed every twelve hours uses sixty.
ALTER TABLE payment_settings
  ADD COLUMN IF NOT EXISTS syp_rate_auto boolean NOT NULL DEFAULT false;

-- SYP per USD, in the unit below. Numeric because it multiplies money.
ALTER TABLE payment_settings
  ADD COLUMN IF NOT EXISTS syp_rate numeric(14,4);

-- When the rate was fetched, and the source's own timestamp for it. Both are
-- shown to the admin: a feed that has quietly stopped updating is the failure
-- that matters here, and only a visible date reveals it.
ALTER TABLE payment_settings
  ADD COLUMN IF NOT EXISTS syp_rate_fetched_at timestamptz;
ALTER TABLE payment_settings
  ADD COLUMN IF NOT EXISTS syp_rate_source_updated_at timestamptz;

-- The last fetch error, cleared on success, so the admin sees why a rate is
-- stale instead of guessing.
ALTER TABLE payment_settings
  ADD COLUMN IF NOT EXISTS syp_rate_error text;

-- Which pound the prices are in.
--
-- Syria redenominated at 100 old pounds to 1 new, and SP Today still reports
-- rates in the OLD unit. A price computed in the wrong unit is wrong by a factor
-- of a hundred, and the student is then asked to send either a hundredth of the
-- price or a hundred times it. The admin states which unit Syriatel Cash
-- charges in; the conversion follows from that.
ALTER TABLE payment_settings
  ADD COLUMN IF NOT EXISTS syp_unit text NOT NULL DEFAULT 'new';

COMMENT ON COLUMN payment_settings.syp_rate_auto IS
  'When true, plan SYP prices are price_usd × syp_rate; when false, subscription_plans.price_syp is used.';
COMMENT ON COLUMN payment_settings.syp_unit IS
  'new or old Syrian pound. 100 old = 1 new. SP Today reports in old; prices are converted to this unit.';

-- ─── A quote, held for the student who is paying ─────────────────────────────
--
-- With an automatic rate the price moves. A student who opens the payment step,
-- reads 290 ل.س, and pays it must not then be checked against a price that has
-- since become 295. The price is quoted when the subscription is opened and the
-- payment is checked against that quote, not against whatever the rate is when
-- the confirmation SMS arrives.
ALTER TABLE student_subscriptions
  ADD COLUMN IF NOT EXISTS quoted_price_syp numeric(14,2);
ALTER TABLE student_subscriptions
  ADD COLUMN IF NOT EXISTS quoted_at timestamptz;

-- ─── 3. The crypto wallet, managed by an admin ───────────────────────────────
--
-- Until now the receiving address was deploy configuration (env), on the
-- reasoning that nothing reviews a crypto payment: anyone able to change the
-- address could have every later payment confirmed into their own wallet. It
-- now moves here so an admin can set it, which trades that protection for
-- convenience. Three things narrow the exposure:
--
--   * every change records who made it and when, shown on the admin screen;
--   * the address is validated on save — a TRON address is refused outright;
--   * each submission snapshots the address it is checked against
--     (expected_wallet_address below), so changing the address cannot
--     redirect a payment that is already in flight.
--
-- Crypto is offered to students only when at least one of the address or the
-- QR is set. A QR without an address still works, but cannot be verified
-- automatically: the chain check needs an address to compare the recipient
-- against, so those payments go to an admin.
ALTER TABLE payment_settings
  ADD COLUMN IF NOT EXISTS crypto_wallet_address text;
ALTER TABLE payment_settings
  ADD COLUMN IF NOT EXISTS crypto_qr_media_id integer
    REFERENCES media_assets (id) ON DELETE SET NULL;
ALTER TABLE payment_settings
  ADD COLUMN IF NOT EXISTS crypto_updated_by integer
    REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE payment_settings
  ADD COLUMN IF NOT EXISTS crypto_updated_at timestamptz;

COMMENT ON COLUMN payment_settings.crypto_wallet_address IS
  'BEP-20 receiving address, lowercased. Admin-editable; every change is attributed. Null with a QR set means crypto payments are reviewed by hand.';

-- The address this submission was checked against, captured at submission.
-- Without it, changing the address in settings would re-point the verification
-- of every payment still being checked.
ALTER TABLE payment_submissions
  ADD COLUMN IF NOT EXISTS expected_wallet_address text;
