-- Migration date: 2026-10-01
-- WS6 durable queue admission limits and upload storage quotas.

alter table public.upload_sessions
  add column if not exists org_id uuid;

alter table public.upload_sessions
  drop constraint if exists upload_sessions_org_id_fkey;
alter table public.upload_sessions
  add constraint upload_sessions_org_id_fkey
  foreign key (org_id) references public.organizations(id) on delete set null;

alter table public.db_jobs add column if not exists capacity_class text;
alter table public.db_jobs add column if not exists capacity_user_id uuid;
alter table public.db_jobs add column if not exists capacity_org_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'db_jobs_capacity_class_check'
      and conrelid = 'public.db_jobs'::regclass
  ) then
    alter table public.db_jobs
      add constraint db_jobs_capacity_class_check
      check (capacity_class is null or capacity_class in ('document', 'export', 'tabular'));
  end if;
end;
$$;

update public.upload_sessions s
set org_id = coalesce(
  case when s.purpose in ('document_version_create', 'document_version_replace') then
    (select d.org_id from public.documents d where d.id = nullif(s.destination ->> 'document_id', '')::uuid)
  end,
  case when s.destination ->> 'scope' = 'project' then
    (select p.org_id from public.projects p where p.id = nullif(s.destination ->> 'project_id', '')::uuid)
  end,
  case when s.destination ->> 'scope' = 'workflow'
          or s.purpose in ('workflow_reference_create', 'workflow_reference_replace') then
    (select w.org_id from public.workflows w where w.id = nullif(s.destination ->> 'workflow_id', '')::uuid)
  end
)
where s.org_id is null;

update public.db_jobs j
set capacity_class = 'export',
    capacity_user_id = nullif(j.payload ->> 'userId', '')::uuid
where j.kind = 'export.build'
  and j.status in ('pending', 'running')
  and j.payload ->> 'userId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

update public.db_jobs j
set capacity_class = 'document',
    capacity_user_id = coalesce(
      nullif(j.payload ->> 'userId', '')::uuid,
      d.user_id
    ),
    capacity_org_id = d.org_id
from public.documents d
where j.kind = 'conversion.convert'
  and j.status in ('pending', 'running')
  and d.id = nullif(j.payload ->> 'documentId', '')::uuid;

update public.db_jobs j
set capacity_class = 'document',
    capacity_user_id = d.user_id,
    capacity_org_id = d.org_id
from public.document_versions v
join public.documents d on d.id = v.document_id
where j.kind = 'document.precompute_text'
  and j.status in ('pending', 'running')
  and v.id = nullif(j.payload ->> 'versionId', '')::uuid;

update public.db_jobs j
set capacity_class = 'tabular',
    capacity_user_id = nullif(j.payload ->> 'userId', '')::uuid,
    capacity_org_id = r.org_id
from public.tabular_reviews r
where j.kind = 'extraction.extract'
  and j.status in ('pending', 'running')
  and j.payload ->> 'userId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and r.id = nullif(j.payload ->> 'reviewId', '')::uuid;

create index if not exists db_jobs_capacity_scope_idx
  on public.db_jobs (capacity_class, capacity_user_id, status)
  where capacity_class is not null and status in ('pending', 'running');
create index if not exists db_jobs_capacity_org_idx
  on public.db_jobs (capacity_class, capacity_org_id, status)
  where capacity_class is not null and capacity_org_id is not null
    and status in ('pending', 'running');

create or replace function public.assert_upload_storage_quota(
  target_user_id uuid,
  target_org_id uuid,
  target_session_id uuid,
  target_candidate_bytes bigint,
  target_user_quota_bytes bigint,
  target_org_quota_bytes bigint,
  target_replace_document_id uuid default null,
  target_replace_version_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  committed_bytes numeric;
  reserved_bytes numeric;
begin
  if target_user_quota_bytes < 0 or target_org_quota_bytes < 0
     or target_candidate_bytes < 0 then
    raise exception using errcode = '22023', message = 'invalid_upload_storage_quota';
  end if;
  if target_user_quota_bytes = 0 and target_org_quota_bytes = 0 then
    return;
  end if;

  -- Shared lock order: organization first, then user. Upload creation and
  -- completion use this same order across all backend replicas.
  if target_org_id is not null then
    perform pg_advisory_xact_lock(
      hashtextextended('upload-storage:org:' || target_org_id::text, 0)
    );
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('upload-storage:user:' || target_user_id::text, 0)
  );

  if target_user_quota_bytes > 0 then
    select coalesce(sum(v.size_bytes::numeric), 0)
      into committed_bytes
    from public.document_versions v
    join public.documents d on d.id = v.document_id
    where v.deleted_at is null
      and v.size_bytes > 0
      and d.user_id = target_user_id
      and not (
        target_replace_document_id is not null
        and target_replace_version_id is not null
        and target_replace_document_id = d.id
        and target_replace_version_id = v.id
        and d.user_id = target_user_id
      )
      and not exists (
        select 1
        from public.upload_sessions replacing
        where replacing.id is distinct from target_session_id
          and replacing.user_id = target_user_id
          and replacing.status in ('pending_upload', 'verifying', 'uploaded', 'processing')
          and replacing.purpose = 'document_version_replace'
          and replacing.destination ->> 'document_id' = d.id::text
          and replacing.destination ->> 'version_id' = v.id::text
      )
      and not exists (
        select 1
        from public.upload_session_files in_flight
        join public.upload_sessions in_flight_session
          on in_flight_session.id = in_flight.session_id
        where in_flight_session.status in ('pending_upload', 'verifying', 'uploaded', 'processing')
          and in_flight.status = 'processing'
          and (in_flight.resource_id = d.id or in_flight.resource_id = v.id)
      );

    select coalesce(sum(f.expected_size_bytes::numeric), 0)
      into reserved_bytes
    from public.upload_sessions s
    join public.upload_session_files f on f.session_id = s.id
    where s.id is distinct from target_session_id
      and s.user_id = target_user_id
      and s.status in ('pending_upload', 'verifying', 'uploaded', 'processing')
      and f.status in ('pending_upload', 'verifying', 'uploaded', 'processing');

    if committed_bytes + reserved_bytes + target_candidate_bytes::numeric
       > target_user_quota_bytes::numeric then
      raise exception using errcode = 'P0001', message = 'upload_storage_quota_exceeded';
    end if;
  end if;

  if target_org_id is not null and target_org_quota_bytes > 0 then
    select coalesce(sum(v.size_bytes::numeric), 0)
      into committed_bytes
    from public.document_versions v
    join public.documents d on d.id = v.document_id
    where v.deleted_at is null
      and v.size_bytes > 0
      and d.org_id = target_org_id
      and not (
        target_replace_document_id is not null
        and target_replace_version_id is not null
        and target_replace_document_id = d.id
        and target_replace_version_id = v.id
      )
      and not exists (
        select 1
        from public.upload_sessions replacing
        where replacing.id is distinct from target_session_id
          and replacing.org_id = target_org_id
          and replacing.status in ('pending_upload', 'verifying', 'uploaded', 'processing')
          and replacing.purpose = 'document_version_replace'
          and replacing.destination ->> 'document_id' = d.id::text
          and replacing.destination ->> 'version_id' = v.id::text
      )
      and not exists (
        select 1
        from public.upload_session_files in_flight
        join public.upload_sessions in_flight_session
          on in_flight_session.id = in_flight.session_id
        where in_flight_session.status in ('pending_upload', 'verifying', 'uploaded', 'processing')
          and in_flight.status = 'processing'
          and (in_flight.resource_id = d.id or in_flight.resource_id = v.id)
      );

    select coalesce(sum(f.expected_size_bytes::numeric), 0)
      into reserved_bytes
    from public.upload_sessions s
    join public.upload_session_files f on f.session_id = s.id
    where s.id is distinct from target_session_id
      and s.org_id = target_org_id
      and s.status in ('pending_upload', 'verifying', 'uploaded', 'processing')
      and f.status in ('pending_upload', 'verifying', 'uploaded', 'processing');

    if committed_bytes + reserved_bytes + target_candidate_bytes::numeric
       > target_org_quota_bytes::numeric then
      raise exception using errcode = 'P0001', message = 'upload_storage_quota_exceeded';
    end if;
  end if;
end;
$$;

create or replace function public.create_upload_session_with_capacity(
  target_session_id uuid,
  target_user_id uuid,
  target_purpose text,
  target_destination jsonb,
  target_expires_at timestamptz,
  target_files jsonb,
  target_hourly_session_limit integer,
  target_user_storage_quota_bytes bigint,
  target_org_storage_quota_bytes bigint
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_org_id uuid;
  candidate_bytes bigint;
begin
  if jsonb_typeof(target_files) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_upload_manifest';
  end if;
  select coalesce(sum(file_row.expected_size_bytes), 0)::bigint
    into candidate_bytes
  from jsonb_to_recordset(target_files) as file_row(expected_size_bytes bigint);

  -- Tenant identity is derived from the destination after the HTTP service
  -- authorization decision; clients cannot choose a separate org scope.
  if target_purpose in ('document_version_create', 'document_version_replace') then
    select d.org_id into target_org_id
    from public.documents d
    where d.id = nullif(target_destination ->> 'document_id', '')::uuid;
  elsif target_destination ->> 'scope' = 'project' then
    select p.org_id into target_org_id
    from public.projects p
    where p.id = nullif(target_destination ->> 'project_id', '')::uuid;
  elsif target_destination ->> 'scope' = 'workflow'
     or target_purpose in ('workflow_reference_create', 'workflow_reference_replace') then
    select w.org_id into target_org_id
    from public.workflows w
    where w.id = nullif(target_destination ->> 'workflow_id', '')::uuid;
  end if;

  perform public.assert_upload_storage_quota(
    target_user_id,
    target_org_id,
    target_session_id,
    candidate_bytes,
    target_user_storage_quota_bytes,
    target_org_storage_quota_bytes,
    case when target_purpose = 'document_version_replace'
      then nullif(target_destination ->> 'document_id', '')::uuid else null end,
    case when target_purpose = 'document_version_replace'
      then nullif(target_destination ->> 'version_id', '')::uuid else null end
  );

  perform public.create_upload_session(
    target_session_id,
    target_user_id,
    target_purpose,
    target_destination,
    target_expires_at,
    target_files,
    target_hourly_session_limit
  );
  update public.upload_sessions
  set org_id = target_org_id
  where id = target_session_id and user_id = target_user_id;
end;
$$;

create or replace function public.queue_upload_session_file_processing_with_capacity(
  target_session_id uuid,
  target_user_id uuid,
  target_file_id uuid,
  target_global_queue_limit integer,
  target_user_queue_limit integer,
  target_org_queue_limit integer,
  target_user_storage_quota_bytes bigint,
  target_org_storage_quota_bytes bigint
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  session_row public.upload_sessions%rowtype;
  existing_job_id uuid;
  result_job_id uuid;
  active_global_count integer;
  active_user_count integer;
  active_org_count integer;
  candidate_storage_bytes bigint;
begin
  select * into session_row
  from public.upload_sessions
  where id = target_session_id and user_id = target_user_id;
  if session_row.id is null then
    raise exception using errcode = 'P0002', message = 'upload_session_not_found';
  end if;
  if session_row.status in ('cancelled', 'expired') then
    raise exception using errcode = 'P0001', message = 'upload_session_not_active';
  end if;
  if target_global_queue_limit not between 1 and 100000
     or target_user_queue_limit not between 1 and 10000
     or target_org_queue_limit not between 1 and 50000 then
    raise exception using errcode = '22023', message = 'invalid_upload_queue_limit';
  end if;

  select id into existing_job_id
  from public.upload_processing_jobs
  where file_id = target_file_id;
  if not found then
    perform pg_advisory_xact_lock(hashtextextended('job-capacity:document', 0));

    select count(*)::integer,
           count(*) filter (where q.user_id = target_user_id)::integer,
           count(*) filter (where q.org_id = session_row.org_id)::integer
      into active_global_count, active_user_count, active_org_count
    from (
      select j.id, j.capacity_user_id as user_id, j.capacity_org_id as org_id
      from public.db_jobs j
      where j.capacity_class = 'document'
        and j.status in ('pending', 'running')
      union all
      select up.id, up.user_id, us.org_id
      from public.upload_processing_jobs up
      join public.upload_sessions us on us.id = up.session_id
      where up.status in ('queued', 'running')
    ) q;

    if active_global_count >= target_global_queue_limit
       or active_user_count >= target_user_queue_limit
       or (session_row.org_id is not null
           and active_org_count >= target_org_queue_limit) then
      raise exception using errcode = 'P0001', message = 'upload_processing_queue_full';
    end if;

    select coalesce(sum(
      coalesce(file_row.observed_size_bytes, file_row.expected_size_bytes)::numeric
    ), 0)::bigint
      into candidate_storage_bytes
    from public.upload_session_files file_row
    where file_row.session_id = target_session_id
      and file_row.status in ('pending_upload', 'verifying', 'uploaded', 'processing');

    perform public.assert_upload_storage_quota(
      target_user_id,
      session_row.org_id,
      target_session_id,
      candidate_storage_bytes,
      target_user_storage_quota_bytes,
      target_org_storage_quota_bytes,
      case when session_row.purpose = 'document_version_replace'
        then nullif(session_row.destination ->> 'document_id', '')::uuid else null end,
      case when session_row.purpose = 'document_version_replace'
        then nullif(session_row.destination ->> 'version_id', '')::uuid else null end
    );
  end if;

  select public.queue_upload_session_file_processing(
    target_session_id,
    target_user_id,
    target_file_id
  ) into result_job_id;
  return result_job_id;
end;
$$;

create or replace function public.enqueue_capped_db_job(
  target_kind text,
  target_payload jsonb,
  target_dedupe_key text,
  target_max_attempts integer,
  target_run_at timestamptz,
  target_global_limit integer,
  target_user_limit integer,
  target_org_limit integer
)
returns table(job_id uuid, deduped boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_class text;
  v_user_id uuid;
  v_org_id uuid;
  v_job_id uuid;
  v_global_count integer;
  v_user_count integer;
  v_org_count integer;
begin
  if jsonb_typeof(target_payload) <> 'object'
     or target_max_attempts not between 1 and 1000
     or target_global_limit not between 1 and 100000
     or target_user_limit not between 1 and 10000
     or target_org_limit not between 1 and 50000 then
    raise exception using errcode = '22023', message = 'invalid_job_capacity_request';
  end if;

  if target_kind in ('conversion.convert', 'document.precompute_text') then
    v_class := 'document';
  elsif target_kind = 'export.build' then
    v_class := 'export';
  elsif target_kind = 'extraction.extract' then
    v_class := 'tabular';
  else
    raise exception using errcode = '22023', message = 'invalid_job_capacity_kind';
  end if;

  -- Dedupe remains a success even when the queue is otherwise full.
  if target_dedupe_key is not null then
    select j.id into v_job_id
    from public.db_jobs j
    where j.dedupe_key = target_dedupe_key
      and j.status in ('pending', 'running')
    limit 1;
    if found then
      return query select v_job_id, true;
      return;
    end if;
  end if;

  if target_kind = 'export.build' then
    v_user_id := nullif(target_payload ->> 'userId', '')::uuid;
  elsif target_kind = 'conversion.convert' then
    v_user_id := nullif(target_payload ->> 'userId', '')::uuid;
    select d.org_id into v_org_id
    from public.documents d
    where d.id = nullif(target_payload ->> 'documentId', '')::uuid;
  elsif target_kind = 'extraction.extract' then
    v_user_id := nullif(target_payload ->> 'userId', '')::uuid;
    select r.org_id into v_org_id
    from public.tabular_reviews r
    where r.id = nullif(target_payload ->> 'reviewId', '')::uuid;
  else
    select d.user_id, d.org_id
      into v_user_id, v_org_id
    from public.document_versions v
    join public.documents d on d.id = v.document_id
    where v.id = nullif(target_payload ->> 'versionId', '')::uuid;
  end if;

  -- One short transaction lock per workload class makes count + insert
  -- atomic across all application replicas and both queue transport modes.
  perform pg_advisory_xact_lock(
    hashtextextended('job-capacity:' || v_class, 0)
  );

  if target_dedupe_key is not null then
    select j.id into v_job_id
    from public.db_jobs j
    where j.dedupe_key = target_dedupe_key
      and j.status in ('pending', 'running')
    limit 1;
    if found then
      return query select v_job_id, true;
      return;
    end if;
  end if;

  select count(*)::integer,
         count(*) filter (where q.user_id = v_user_id)::integer,
         count(*) filter (where q.org_id = v_org_id)::integer
    into v_global_count, v_user_count, v_org_count
  from (
    select j.id, j.capacity_user_id as user_id,
           j.capacity_org_id as org_id
    from public.db_jobs j
    where j.capacity_class = v_class
      and j.status in ('pending', 'running')
    union all
    select up.id, up.user_id, us.org_id
    from public.upload_processing_jobs up
    join public.upload_sessions us on us.id = up.session_id
    where v_class = 'document'
      and up.status in ('queued', 'running')
  ) q;

  if v_global_count >= target_global_limit
     or (v_user_id is not null and v_user_count >= target_user_limit)
     or (v_org_id is not null and v_org_count >= target_org_limit) then
    raise exception using errcode = 'P0001', message = 'job_capacity_exceeded';
  end if;

  insert into public.db_jobs (
    kind, payload, dedupe_key, max_attempts, run_at,
    capacity_class, capacity_user_id, capacity_org_id
  ) values (
    target_kind, target_payload, target_dedupe_key, target_max_attempts,
    coalesce(target_run_at, now()), v_class, v_user_id, v_org_id
  ) returning id into v_job_id;

  return query select v_job_id, false;
end;
$$;

create or replace function public.acquire_db_job_execution_capacity(
  target_job_id uuid,
  target_attempts integer,
  target_claimed_at timestamptz,
  target_max_concurrent integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
  v_active_count integer;
begin
  if target_max_concurrent not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid_job_execution_limit';
  end if;

  select j.capacity_user_id into v_user_id
  from public.db_jobs j
  where j.id = target_job_id
    and j.status = 'running'
    and j.attempts = target_attempts
    and j.claimed_at is not distinct from target_claimed_at
    and j.capacity_class is not null
  for update;
  if not found then return false; end if;
  if v_user_id is null then return true; end if;

  perform pg_advisory_xact_lock(
    hashtextextended('job-execution:user:' || v_user_id::text, 0)
  );
  select count(*)::integer into v_active_count
  from public.db_jobs j
  where j.capacity_class is not null
    and j.capacity_user_id = v_user_id
    and j.status = 'running';

  if v_active_count > target_max_concurrent then
    update public.db_jobs
    set status = 'pending',
        run_at = now() + interval '5 seconds',
        claimed_at = null,
        attempts = greatest(attempts - 1, 0)
    where id = target_job_id
      and status = 'running'
      and attempts = target_attempts
      and claimed_at is not distinct from target_claimed_at;
    return false;
  end if;
  return true;
end;
$$;
revoke all on function public.assert_upload_storage_quota(uuid, uuid, uuid, bigint, bigint, bigint, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.assert_upload_storage_quota(uuid, uuid, uuid, bigint, bigint, bigint, uuid, uuid)
  to service_role;
revoke all on function public.create_upload_session_with_capacity(uuid, uuid, text, jsonb, timestamptz, jsonb, integer, bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.create_upload_session_with_capacity(uuid, uuid, text, jsonb, timestamptz, jsonb, integer, bigint, bigint)
  to service_role;
revoke all on function public.queue_upload_session_file_processing_with_capacity(uuid, uuid, uuid, integer, integer, integer, bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.queue_upload_session_file_processing_with_capacity(uuid, uuid, uuid, integer, integer, integer, bigint, bigint)
  to service_role;
revoke all on function public.enqueue_capped_db_job(text, jsonb, text, integer, timestamptz, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.enqueue_capped_db_job(text, jsonb, text, integer, timestamptz, integer, integer, integer)
  to service_role;
revoke all on function public.acquire_db_job_execution_capacity(uuid, integer, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.acquire_db_job_execution_capacity(uuid, integer, timestamptz, integer)
  to service_role;

notify pgrst, 'reload schema';
