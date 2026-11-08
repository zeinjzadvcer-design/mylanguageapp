-- =============================================================================
-- Migration 028: Editable instructions per AI task
--
-- Lets an administrator replace the instructions a task sends to the model —
-- the peer-call evaluation prompt first — from /admin/ai, without a deploy.
--
-- Null means "use the default in code" (services/ai-prompts.ts), and that is
-- what every existing row starts as, so nothing changes until someone edits a
-- prompt. Only the instructions are stored: the reply format the grader parses
-- is appended in code on every call and cannot be edited away.
-- =============================================================================

ALTER TABLE ai_task_settings
  ADD COLUMN IF NOT EXISTS system_prompt text;

COMMENT ON COLUMN ai_task_settings.system_prompt IS
  'Administrator-edited instructions for this task. Null means the default in services/ai-prompts.ts. The reply format is appended in code and is not part of this value.';
