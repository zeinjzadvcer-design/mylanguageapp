-- =============================================================================
-- Migration 029: payment identifiers survive a rejection; USDT amounts carry a
-- per-student tag
--
-- A REJECTED CLAIM MUST NOT BURN THE PAYMENT
-- ──────────────────────────────────────────
-- The unique indexes on tx_hash and operation_number counted rejected rows, so
-- one rejection (a hash not found while the network lagged, say) spent that
-- identifier for good: the student was told to retry and every retry answered
-- "already used". The rule the indexes exist for is "one payment buys one
-- subscription", and a rejected claim bought nothing.
--
-- New index names rather than altering the old ones. 023 and 025 no longer
-- create the old indexes (these files re-run on every start, and a re-created
-- non-partial index would fail as soon as a rejected identifier was re-used).
-- The Drizzle push also creates the new names on a fresh database, hence
-- IF NOT EXISTS.
-- =============================================================================

DROP INDEX IF EXISTS payment_submissions_tx_hash_key;
DROP INDEX IF EXISTS payment_submissions_operation_number_key;

CREATE UNIQUE INDEX IF NOT EXISTS payment_submissions_tx_hash_open_key
  ON payment_submissions (lower(tx_hash))
  WHERE tx_hash IS NOT NULL AND status <> 'rejected';

CREATE UNIQUE INDEX IF NOT EXISTS payment_submissions_operation_number_open_key
  ON payment_submissions (operation_number)
  WHERE operation_number IS NOT NULL AND status <> 'rejected';

-- ─── Four decimals on the expected amount ────────────────────────────────────
--
-- A USDT price is now the plan price plus a small tag (2.0037), because a public
-- blockchain cannot otherwise say WHO a transfer came from. See
-- usdtAmountWithTag in crypto-verify-policy.ts.
--
ALTER TABLE student_subscriptions
  ADD COLUMN IF NOT EXISTS usdt_amount numeric(12,4);
ALTER TABLE student_subscriptions
  ADD COLUMN IF NOT EXISTS usdt_amount_at timestamptz;

-- Guarded: changing a column's type rewrites the table, and this runs on every
-- start.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'payment_submissions'
       AND column_name = 'amount_expected'
       AND numeric_scale <> 4
  ) THEN
    ALTER TABLE payment_submissions
      ALTER COLUMN amount_expected TYPE numeric(12,4);
  END IF;
END $$;
