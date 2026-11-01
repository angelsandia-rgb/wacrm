-- ============================================================
-- 171: configurable AI skills (respond.io parity).
-- ai_configs.skills = { "<skill>": { "enabled": bool, "when": text } }.
-- Empty (the default) keeps today's behaviour exactly: every action the
-- bot already had stays on, with no extra rules. Read through a separate,
-- fault-tolerant query (src/lib/ai/config.ts), so the bot keeps working
-- if this column is ever missing. Idempotent.
-- ============================================================
ALTER TABLE public.ai_configs
  ADD COLUMN IF NOT EXISTS skills jsonb NOT NULL DEFAULT '{}'::jsonb;
