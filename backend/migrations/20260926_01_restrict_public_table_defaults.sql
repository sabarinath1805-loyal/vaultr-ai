-- Migration date: 2026-09-26
-- Supabase's Postgres image grants all privileges on future public tables to
-- anon and authenticated. Mike's application tables are accessed by the
-- backend through service_role, so remove those browser-role defaults for
-- tables created by the supported postgres migration owner.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;

-- Older Compose volumes skip schema.sql and may not have replayed the
-- historical workflow-restructure migration that established these revokes.
revoke all on public.default_workflow_installations, public.quick_actions
  from anon, authenticated;
