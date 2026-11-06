-- =============================================================================
-- Migration 026: a forwarded SMS is not a spent payment
--
-- Migration 025 put a unique index on wallet_sms_messages.parsed_operation_number
-- to make the companion app's retries idempotent. That conflated two different
-- facts:
--
--   "I have already stored this message"   — bookkeeping
--   "this payment has already been spent"  — the control that matters
--
-- The consequence, seen in testing: a message that arrived BEFORE its student
-- submitted matched nothing and was stored unmatched. Re-delivering it was then
-- refused as a duplicate, so the operation number was permanently burned and
-- the student's later submission could never be matched to it. The payment was
-- real, the SMS was real, and the system had made them unmatchable.
--
-- WHERE THE CONTROL BELONGS
-- ─────────────────────────
-- On payment_submissions.operation_number, which migration 025 also added and
-- which stays exactly as it is. That is the claim a student makes, and it is
-- what must be unique: one operation number buys one subscription, ever,
-- however many times the phone forwards the message announcing it.
--
-- Sequencing matters here. A payment is verified only when BOTH halves are
-- present, and either can arrive first:
--
--   student submits, then the SMS arrives  → matched on ingest
--   the SMS arrives, then the student submits → matched by the sweep
--
-- The second ordering is the common one — a student pays, then opens the app —
-- and it is the one the old index broke.
-- =============================================================================

DROP INDEX IF EXISTS wallet_sms_operation_number_key;

-- Not unique. Several rows may carry one operation number: the same message
-- re-delivered by a retrying app, or re-sent by hand during an investigation.
-- The sweep reads unmatched rows by this column, so it is still indexed.
CREATE INDEX IF NOT EXISTS wallet_sms_operation_number_idx
  ON wallet_sms_messages (parsed_operation_number)
  WHERE parsed_operation_number IS NOT NULL;

COMMENT ON INDEX wallet_sms_operation_number_idx IS
  'Deliberately NOT unique: a message may be forwarded more than once, and refusing a redelivery would strand a payment whose SMS arrived before the student submitted. Uniqueness lives on payment_submissions.operation_number, which is the claim being spent.';

-- Idempotency for the app's retries now comes from matching rather than from
-- rejecting: a message whose operation number already matched an APPROVED
-- submission activates nothing further, because activateSubscription is itself
-- idempotent on the submission's status. Storing the duplicate row costs one
-- row and keeps the evidence.
