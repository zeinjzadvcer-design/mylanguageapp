-- =============================================================================
-- Migration 023: Payment submissions and the activation pipeline
--
-- WHAT WAS MISSING
-- ────────────────
-- POST /subscription wrote a row at status 'pending_payment' and stopped.
-- Nothing — no endpoint, no screen, no job — ever moved one to 'active'. Every
-- subscription ever created was stranded, and the student had no way to tell
-- anyone they had paid.
--
-- This adds the record of a claimed payment, which is the thing an admin
-- reviews (ShamCash) or a verifier checks on-chain (USDT BEP-20). Both methods
-- land in the same table and the same review queue: the crypto path only skips
-- the human when its automatic check is conclusive.
-- =============================================================================

CREATE TABLE IF NOT EXISTS payment_submissions (
  id serial PRIMARY KEY,

  subscription_id integer NOT NULL
    REFERENCES student_subscriptions (id) ON DELETE CASCADE,
  user_id integer NOT NULL
    REFERENCES users (id) ON DELETE CASCADE,

  method text NOT NULL,            -- 'sham_cash' | 'crypto_usdt_bep20'
  status text NOT NULL DEFAULT 'pending',
                                   -- 'pending' | 'verifying' | 'approved' | 'rejected'

  -- What the plan cost WHEN THE STUDENT PAID, not what it costs now. A price
  -- change between submission and review must not invalidate a payment that
  -- was correct when it was made, and without the snapshot there is no record
  -- of what was actually owed.
  amount_expected numeric(12,2) NOT NULL,

  -- ── ShamCash: a receipt image and whatever the student wants to say ────────
  receipt_media_id integer REFERENCES media_assets (id) ON DELETE SET NULL,
  student_note text,

  -- ── Crypto: the transaction the student says they sent ────────────────────
  tx_hash text,
  -- numeric(38,18) because BEP-20 USDT carries 18 decimals. Storing an
  -- on-chain amount in a float would lose the low digits of every transfer.
  amount_observed numeric(38,18),
  -- Kept although matching deliberately ignores it: sanctions screening needs
  -- to know who paid, even when access control does not.
  sender_address text,
  confirmed_at timestamptz,

  -- ── Review ────────────────────────────────────────────────────────────────
  reviewed_by integer REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_note text,
  -- Why the automatic check passed or failed, so an admin looking at a crypto
  -- submission in the queue can see what the verifier saw rather than guessing.
  verification_log jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- THE MOST IMPORTANT CONSTRAINT IN THE PAYMENT SYSTEM.
--
-- A transaction hash may be claimed exactly once. Without this, one student
-- pays once and shares the hash with ten friends, or replays their own hash
-- every month — and the on-chain check would confirm it every time, because
-- the transaction really is real, really did arrive, and really is for the
-- right amount.
--
-- Enforced by the database rather than by a SELECT in application code: two
-- concurrent submissions of the same hash would both find nothing and both
-- insert.
--
-- lower() because hex hashes arrive in mixed case and 0xAB… is 0xab…. Partial
-- so the ShamCash rows, which have no hash, do not all collide on NULL.
--
-- The index itself is created by 029, as a partial index that leaves rejected
-- claims out. Creating the old form here would fail on any re-run once a
-- rejected hash had been legitimately resubmitted.

-- The admin review queue reads pending rows oldest-first; a student's own page
-- reads their submissions newest-first.
CREATE INDEX IF NOT EXISTS payment_submissions_status_idx
  ON payment_submissions (status, created_at);

CREATE INDEX IF NOT EXISTS payment_submissions_user_idx
  ON payment_submissions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS payment_submissions_subscription_idx
  ON payment_submissions (subscription_id);

COMMENT ON TABLE payment_submissions IS
  'A claimed payment awaiting verification. ShamCash rows are reviewed by an admin; crypto rows are verified on-chain and fall back to the same queue when inconclusive.';

COMMENT ON COLUMN payment_submissions.amount_expected IS
  'Plan price snapshotted at submission, so a later price change cannot invalidate a payment that was correct when made.';

COMMENT ON COLUMN payment_submissions.tx_hash IS
  'On-chain transaction hash. Unique across all submissions (case-insensitive): a hash buys exactly one subscription, ever.';

-- =============================================================================
-- An upgrade records what it replaced rather than destroying it.
--
-- POST /subscription cancelled the current active subscription BEFORE the new
-- one was paid for, so a student who started an upgrade and never completed it
-- downgraded themselves to free. Superseding now happens inside the activation
-- transaction, and this column keeps the chain readable afterwards — which
-- subscription replaced which, and when.
-- =============================================================================

ALTER TABLE student_subscriptions
  ADD COLUMN IF NOT EXISTS supersedes_id integer
    REFERENCES student_subscriptions (id) ON DELETE SET NULL;

COMMENT ON COLUMN student_subscriptions.supersedes_id IS
  'The subscription this one replaced on activation. Null for a first subscription.';

-- Activation looks up a user's current active row on every approval, and the
-- expiry sweeper scans for active rows whose expiry has passed.
CREATE INDEX IF NOT EXISTS student_subscriptions_user_status_idx
  ON student_subscriptions (user_id, status);

CREATE INDEX IF NOT EXISTS student_subscriptions_expiry_idx
  ON student_subscriptions (expires_at)
  WHERE status = 'active';
