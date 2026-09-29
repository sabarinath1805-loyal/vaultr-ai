-- Migration date: 2026-09-28

alter table public.upload_sessions
  add column if not exists staging_reconciled_at timestamptz;

create index if not exists upload_sessions_staging_reconcile_idx
  on public.upload_sessions(expires_at)
  where cleaned_at is not null
    and staging_reconciled_at is null
    and status in ('completed', 'expired', 'cancelled', 'error');
