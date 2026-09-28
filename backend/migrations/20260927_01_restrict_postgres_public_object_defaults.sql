-- Migration date: 2026-09-27
-- Future Vaultr application objects are supported only when created as
-- postgres. This migration changes defaults only; existing object ACLs remain
-- unchanged.
begin;

do $$
begin
  if current_user <> 'postgres' then
    raise exception 'Vaultr migrations must execute as postgres (current_user is %)', current_user;
  end if;
end
$$;

-- PostgreSQL's built-in PUBLIC EXECUTE grant is global, so this creator-wide
-- revocation is required. It affects future postgres-created functions in
-- every schema; current routines and other creators are unchanged.
alter default privileges for role postgres
  revoke execute on functions from public;

-- Phase 3 already removes anon/authenticated table defaults. Keep future
-- service_role table access to the CRUD contract used by the backend.
alter default privileges for role postgres in schema public
  revoke all on tables from public, service_role;
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to service_role;

-- Browser roles do not need direct sequence access; server inserts need
-- USAGE, while SELECT is retained to match the current schema contract.
alter default privileges for role postgres in schema public
  revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant usage, select on sequences to service_role;

-- Server-side RPC calls use service_role. Browser-callable functions require
-- a future explicit GRANT and their own application authorization checks.
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant execute on functions to service_role;

commit;
