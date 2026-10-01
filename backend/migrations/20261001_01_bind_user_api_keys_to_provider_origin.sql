-- Migration date: 2026-10-01
-- Bind existing encrypted provider keys to their canonical provider origin.
-- Runtime base-URL overrides intentionally require users to re-enter a key.
alter table public.user_api_keys
  add column if not exists endpoint_origin text;

update public.user_api_keys
set endpoint_origin = case provider
  when 'claude' then 'https://api.anthropic.com'
  when 'gemini' then 'https://generativelanguage.googleapis.com'
  when 'openai' then 'https://api.openai.com'
  when 'openrouter' then 'https://openrouter.ai'
  when 'vercel' then 'https://ai-gateway.vercel.sh'
  when 'opencode-go' then 'https://opencode.ai'
  when 'courtlistener' then 'https://www.courtlistener.com'
  else null
end
where endpoint_origin is null or btrim(endpoint_origin) = '';

alter table public.user_api_keys
  alter column endpoint_origin set not null;
