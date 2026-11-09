-- =============================================================================
-- Migration 031: Room for an administrator's uncapped conversations
--
-- Administrators have no practical limit on a conversation, which the service
-- records as 10,000 turns and 24 hours. Students are still held to 100 turns and
-- 120 minutes by services/conversation.ts, so this changes nothing for them.
-- =============================================================================

ALTER TABLE conversation_sessions
  DROP CONSTRAINT IF EXISTS conversation_sessions_caps_check;

ALTER TABLE conversation_sessions
  ADD CONSTRAINT conversation_sessions_caps_check
  CHECK (max_turns > 0 AND max_turns <= 10000 AND max_minutes > 0 AND max_minutes <= 1440);
