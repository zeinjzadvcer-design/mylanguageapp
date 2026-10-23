-- =============================================================================
-- Migration 023: ShamCash payment settings
--
-- What a student needs on screen to pay: the receive QR an admin uploads, the
-- account number to check it against, and whatever instructions the admin
-- wants to give in Arabic.
--
-- WHY A TABLE AND NOT ENVIRONMENT VARIABLES
-- ─────────────────────────────────────────
-- The opposite choice from the crypto wallet address, deliberately.
--
-- The wallet address is the crypto path's TRUST ANCHOR: payments to it are
-- verified automatically with no human in the loop, so an attacker who could
-- change it would have every subsequent payment confirmed into their own
-- wallet with nothing looking wrong. That value stays in env, where changing
-- it needs deploy access.
--
-- ShamCash has a human in the loop. An admin reads every receipt before any
-- subscription activates, and a swapped QR would show up as receipts naming an
-- unfamiliar account. The review step is the control, so the QR can live where
-- an admin can change it — which they need, because a QR image is reissued far
-- more often than a deploy happens.
--
-- WHY A SINGLETON
-- ───────────────
-- One ShamCash account. The `id = 1` check constraint makes that structural
-- rather than a convention someone can forget, so there is never a question of
-- which row the student's payment page should read.
-- =============================================================================

CREATE TABLE IF NOT EXISTS payment_settings (
  id integer PRIMARY KEY DEFAULT 1,

  -- The QR image students scan. Null until an admin uploads one, which is why
  -- the payment page must handle its absence rather than assuming a row means
  -- a usable QR.
  sham_cash_qr_media_id integer
    REFERENCES media_assets (id) ON DELETE SET NULL,

  -- Shown beside the QR so a student can confirm they are paying the right
  -- account, and so they have something to type if their app cannot scan.
  sham_cash_account_name text,
  sham_cash_account_number text,

  -- Free text, Arabic. Payment instructions change with the wallet's own UI
  -- far more often than this code does, so they are data rather than a string
  -- in a component.
  sham_cash_instructions_ar text,

  -- Who last changed any of the above, and when. These settings decide where
  -- students send money; a change to them needs to be attributable.
  updated_by integer REFERENCES users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payment_settings_singleton CHECK (id = 1)
);

COMMENT ON TABLE payment_settings IS
  'Singleton. The ShamCash receive details students see. Admin-editable because a human reviews every ShamCash receipt — unlike the crypto wallet address, which is verified without a human and therefore lives in env.';

COMMENT ON COLUMN payment_settings.sham_cash_qr_media_id IS
  'Admin-uploaded receive QR, purpose payment_qr. Owned by nobody so every student can see it.';

-- Seed the row so the settings endpoint always has something to read and an
-- admin never has to create it. Empty until configured.
INSERT INTO payment_settings (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;
