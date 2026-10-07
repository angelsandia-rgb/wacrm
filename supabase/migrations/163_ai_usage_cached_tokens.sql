-- Prompt tokens the provider served from its prompt cache (OpenAI
-- usage.prompt_tokens_details.cached_tokens). Billed far below normal input,
-- so this is what shows whether the static-prefix prompt ordering pays off.
-- NULL = not reported (older rows, providers that don't report it).
ALTER TABLE public.ai_usage_log
  ADD COLUMN IF NOT EXISTS cached_prompt_tokens integer;
