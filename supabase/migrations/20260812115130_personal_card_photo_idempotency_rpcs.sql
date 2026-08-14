-- Personal-card photo upload idempotency and durable single-card deletion.
--
-- CUTOVER: quiesce application and maintenance writers while the four-arg
-- upload issuer and erasure finisher are renamed. Resume only after the API
-- using the five-argument upload issuer is ready. Table locks close accidental
-- writer restart windows; they do not replace external writer quiescence.

begin;

lock table private.data_erasure_jobs in exclusive mode;
lock table public.app_users in share row exclusive mode;
lock table private.personal_card_temp_uploads in share row exclusive mode;
lock table private.data_erasure_manifest in share row exclusive mode;
lock table private.personal_card_field_object_ledger in share row exclusive mode;
lock table private.personal_card_permanent_object_ledger in share row exclusive mode;
lock table public.personal_cards in share row exclusive mode;

alter table private.data_erasure_jobs
  drop constraint data_erasure_jobs_scope_subject,
  add constraint data_erasure_jobs_scope_subject check (
    (
      scope = 'location_withdrawal'
      and correction_request_id is null
      and personal_card_id is null
    )
    or (
      scope = 'location_correction'
      and correction_request_id is not null
      and personal_card_id is null
    )
    or (
      scope = 'personal_card'
      and correction_request_id is null
      and personal_card_id is not null
    )
  );

create unique index data_erasure_jobs_one_open_personal_card_idx
  on private.data_erasure_jobs(user_id, personal_card_id)
  where scope = 'personal_card' and state <> 'completed';

create table private.personal_card_deletion_requests (
  user_id uuid not null
    references public.app_users(id) on delete cascade,
  client_request_id uuid not null,
  personal_card_id uuid not null,
  erasure_job_id uuid not null
    references private.data_erasure_jobs(id) on delete cascade,
  pending_storage_bytes bigint not null
    check (pending_storage_bytes between 0 and 5242880),
  requested_at timestamptz not null default clock_timestamp(),
  primary key (user_id, client_request_id)
);

create index personal_card_deletion_requests_job_idx
  on private.personal_card_deletion_requests(erasure_job_id);

alter table private.personal_card_deletion_requests enable row level security;
alter table private.personal_card_deletion_requests force row level security;
revoke all on table private.personal_card_deletion_requests
  from public, anon, authenticated, service_role;

comment on table private.personal_card_deletion_requests is
  'Thirty-day response-loss retry receipt, bounded by its data_erasure_jobs FK cascade.';

create index personal_card_deletion_requests_pending_bytes_idx
  on private.personal_card_deletion_requests(user_id)
  where pending_storage_bytes > 0;

-- Preserve the table-level quota invariant for every trusted insertion path,
-- not only the production promotion RPCs. A deleted card's physical object is
-- still charged until the generic erasure manifest completes both passes.
create or replace function private.prepare_personal_card_storage_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_size_context text;
  v_card_count bigint;
  v_total_bytes numeric;
  v_pending_bytes numeric;
begin
  v_size_context := current_setting(
    'danyeodam.personal_card_photo_size_bytes',
    true
  );
  if v_size_context ~ '^[1-9][0-9]{0,6}$'
    and v_size_context::bigint <= 5242880
  then
    new.photo_size_bytes := v_size_context::bigint;
  else
    new.photo_size_bytes := 5242880;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || new.user_id::text,
    0
  ));

  select
    count(*),
    coalesce(sum(card_row.photo_size_bytes), 0)
  into v_card_count, v_total_bytes
  from public.personal_cards as card_row
  where card_row.user_id = new.user_id;

  select coalesce(sum(pending_row.bytes), 0)
  into v_pending_bytes
  from (
    select ledger_row.reserved_bytes::numeric as bytes
    from private.personal_card_permanent_object_ledger as ledger_row
    where ledger_row.user_id = new.user_id
      and ledger_row.object_path <> new.photo_path
    union all
    select 5242880::numeric
    from private.personal_card_field_object_ledger as ledger_row
    where ledger_row.user_id = new.user_id
      and ledger_row.bucket = 'personal-cards'
      and ledger_row.object_path <> new.photo_path
    union all
    select request_row.pending_storage_bytes::numeric
    from private.personal_card_deletion_requests as request_row
    where request_row.user_id = new.user_id
      and request_row.pending_storage_bytes > 0
  ) as pending_row;

  if v_card_count >= 200 then
    raise exception 'personal-card count quota exceeded'
      using errcode = '23514';
  end if;
  if v_total_bytes + v_pending_bytes + new.photo_size_bytes > 524288000 then
    raise exception 'personal-card storage quota exceeded'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.prepare_personal_card_storage_quota()
  from public, anon, authenticated, service_role;

-- -------------------------------------------------------------------------
-- Upload reservation idempotency
-- -------------------------------------------------------------------------

alter function api_private.issue_personal_card_temp_upload(
  uuid, boolean, text, bigint
) rename to issue_personal_card_temp_upload_before_idempotency;

revoke all on function api_private.issue_personal_card_temp_upload_before_idempotency(
  uuid, boolean, text, bigint
) from public, anon, authenticated, service_role;

create or replace function api_private.issue_personal_card_temp_upload(
  p_auth_user_id uuid,
  p_public_gate_open boolean,
  p_declared_content_type text,
  p_declared_size_bytes bigint,
  p_client_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_existing private.personal_card_temp_uploads%rowtype;
  v_result jsonb;
  v_now timestamptz := clock_timestamp();
  v_retry_after integer;
begin
  if p_auth_user_id is null or p_client_request_id is null then
    return jsonb_build_object('status', 'validation_failed');
  end if;

  v_user_id := private.lock_active_user_id_for_auth(p_auth_user_id);
  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  if not coalesce(p_public_gate_open, false)
    and not exists (
      select 1
      from private.participant_access as access_row
      where access_row.user_id = v_user_id
        and access_row.revoked_at is null
        and (
          access_row.expires_at is null
          or access_row.expires_at > statement_timestamp()
        )
    )
  then
    return jsonb_build_object('status', 'gate_closed');
  end if;

  -- Match publication -> owner ordering used by every personal-card write.
  perform pg_advisory_xact_lock_shared(hashtextextended(
    'danyeodam:policy-current-set',
    0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_user_id::text,
    0
  ));

  perform 1
  from public.app_users as user_row
  where user_row.id = v_user_id
    and user_row.deletion_requested_at is null
  for share of user_row;
  if not found then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  if private.user_current_policy_acceptance_id(
      v_user_id,
      'terms_of_use'::private.policy_type
    ) is null
    or private.user_current_policy_acceptance_id(
      v_user_id,
      'community_guidelines'::private.policy_type
    ) is null
  then
    return jsonb_build_object(
      'status', 'policy_required',
      'required', private.current_policy_requirements()
    );
  end if;

  select upload_row.*
  into v_existing
  from private.personal_card_temp_uploads as upload_row
  where upload_row.user_id = v_user_id
    and upload_row.client_request_id = p_client_request_id
  for update;

  if found then
    if v_existing.declared_content_type is distinct from p_declared_content_type
      or v_existing.declared_size_bytes is distinct from p_declared_size_bytes
    then
      return jsonb_build_object('status', 'idempotency_conflict');
    end if;

    -- A retry can only reissue a token while the original promotion attempt
    -- remains usable. It never revives cleaned, promoted, or leased work.
    if v_existing.promotion_expires_at <= v_now
      or v_existing.promoted_at is not null
      or v_existing.processing_token is not null
      or v_existing.temp_deleted_at is not null
      or v_existing.cleanup_completed_at is not null
      or v_existing.maintenance_cleanup_token is not null
    then
      return jsonb_build_object('status', 'idempotency_conflict');
    end if;

    if v_existing.signed_url_reissue_count >= 20 then
      v_retry_after := greatest(
        1,
        ceil(extract(epoch from (
          v_existing.promotion_expires_at - v_now
        )))::integer
      );
      return jsonb_build_object(
        'status', 'rate_limited',
        'retry_after_seconds', v_retry_after
      );
    end if;

    update private.personal_card_temp_uploads
    set signed_url_last_issued_at = v_now,
        signed_url_expires_at = v_now + interval '2 hours',
        signed_url_reissue_count = signed_url_reissue_count + 1
    where id = v_existing.id
      and user_id = v_user_id;

    return jsonb_build_object(
      'status', 'issued',
      'upload_id', v_existing.id,
      'temp_path', v_existing.temp_path,
      'quota_issued_at', v_existing.quota_issued_at,
      'replayed', true
    );
  end if;

  v_result := api_private.issue_personal_card_temp_upload_before_idempotency(
    p_auth_user_id,
    p_public_gate_open,
    p_declared_content_type,
    p_declared_size_bytes
  );

  if v_result ->> 'status' <> 'issued' then
    return v_result;
  end if;

  update private.personal_card_temp_uploads
  set client_request_id = p_client_request_id
  where id = (v_result ->> 'upload_id')::uuid
    and user_id = v_user_id;
  if not found then
    raise exception 'issued upload reservation disappeared'
      using errcode = '40001';
  end if;

  return v_result || jsonb_build_object('replayed', false);
end;
$$;

revoke all on function api_private.issue_personal_card_temp_upload(
  uuid, boolean, text, bigint, uuid
) from public, anon, authenticated;
grant execute on function api_private.issue_personal_card_temp_upload(
  uuid, boolean, text, bigint, uuid
) to service_role;

-- Keep the historical signature only for database test/upgrade compatibility.
-- It is intentionally not service-role executable, so production callers must
-- supply a logical request key.
create or replace function api_private.issue_personal_card_temp_upload(
  p_auth_user_id uuid,
  p_public_gate_open boolean,
  p_declared_content_type text,
  p_declared_size_bytes bigint
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select api_private.issue_personal_card_temp_upload_before_idempotency(
    p_auth_user_id,
    p_public_gate_open,
    p_declared_content_type,
    p_declared_size_bytes
  )
$$;

revoke all on function api_private.issue_personal_card_temp_upload(
  uuid, boolean, text, bigint
) from public, anon, authenticated, service_role;

-- Remove completed upload/idempotency rows only after the signed token safety
-- window and a thirty-day retry horizon. Restrictive promotion ledgers win.
create or replace function api_private.purge_completed_personal_card_uploads(
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if p_limit is null or p_limit not between 1 and 1000 then
    return jsonb_build_object('status', 'invalid');
  end if;

  with candidates as (
    select upload_row.id
    from private.personal_card_temp_uploads as upload_row
    where upload_row.cleanup_completed_at <
        clock_timestamp() - interval '30 days'
      and not exists (
        select 1
        from private.personal_card_field_object_ledger as ledger_row
        where ledger_row.upload_id = upload_row.id
      )
      and not exists (
        select 1
        from private.personal_card_permanent_object_ledger as ledger_row
        where ledger_row.upload_id = upload_row.id
      )
    order by upload_row.cleanup_completed_at, upload_row.id
    for update skip locked
    limit p_limit
  ), deleted as (
    delete from private.personal_card_temp_uploads as upload_row
    using candidates
    where upload_row.id = candidates.id
    returning upload_row.id
  )
  select count(*)::integer into v_deleted from deleted;

  return jsonb_build_object('status', 'purged', 'deleted', v_deleted);
end;
$$;

revoke all on function api_private.purge_completed_personal_card_uploads(integer)
  from public, anon, authenticated;
grant execute on function api_private.purge_completed_personal_card_uploads(integer)
  to service_role;

-- Card deletion holds the canonical owner advisory before it locks the card;
-- its existing audit trigger then redacts matching reports. The historical
-- moderation function locked the report first, which could deadlock with that
-- owner -> card -> report path. Preserve the common admin rate -> owner order,
-- resolve the immutable report owner without a row lock, and only then enter
-- the historical report/card state machine. A concurrent deletion either
-- completes first and moderation observes redacted content, or moderation
-- completes first and the deletion observes its committed audit state.
alter function api_private.moderate_content_report(
  uuid, uuid, uuid, text, text, text
) rename to moderate_content_report_pre_card_delete;

revoke all on function api_private.moderate_content_report_pre_card_delete(
  uuid, uuid, uuid, text, text, text
) from public, anon, authenticated, service_role;

create function api_private.moderate_content_report(
  p_admin_auth_user_id uuid,
  p_report_id uuid,
  p_client_action_id uuid,
  p_action text,
  p_reason_code text,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rate jsonb;
  v_owner_user_id uuid;
begin
  v_rate := private.consume_authenticated_api_rate_limit(
    p_admin_auth_user_id,
    'admin_mutation'
  );
  if v_rate ->> 'status' <> 'allowed' then
    return v_rate;
  end if;

  select report_row.owner_user_id
  into v_owner_user_id
  from private.content_reports as report_row
  where report_row.id = p_report_id;

  if v_owner_user_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(
      'danyeodam:suspend-owner:' || v_owner_user_id::text,
      0
    ));
  end if;

  return api_private.moderate_content_report_unrated(
    p_admin_auth_user_id,
    p_report_id,
    p_client_action_id,
    p_action,
    p_reason_code,
    p_note
  );
end;
$$;

drop function api_private.moderate_content_report_pre_card_delete(
  uuid, uuid, uuid, text, text, text
);

revoke all on function api_private.moderate_content_report(
  uuid, uuid, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function api_private.moderate_content_report(
  uuid, uuid, uuid, text, text, text
) to service_role;

-- -------------------------------------------------------------------------
-- Single personal-card deletion request
-- -------------------------------------------------------------------------

create or replace function api_private.request_personal_card_deletion(
  p_auth_user_id uuid,
  p_personal_card_id uuid,
  p_client_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_request private.personal_card_deletion_requests%rowtype;
  v_card public.personal_cards%rowtype;
  v_job_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  if p_auth_user_id is null
    or p_personal_card_id is null
    or p_client_request_id is null
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  v_user_id := private.lock_active_user_id_for_auth(p_auth_user_id);
  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_user_id::text,
    0
  ));

  perform 1
  from public.app_users as user_row
  where user_row.id = v_user_id
    and user_row.deletion_requested_at is null
  for share of user_row;
  if not found then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  select request_row.*
  into v_request
  from private.personal_card_deletion_requests as request_row
  where request_row.user_id = v_user_id
    and request_row.client_request_id = p_client_request_id
  for update;

  if found then
    if v_request.personal_card_id is distinct from p_personal_card_id then
      return jsonb_build_object('status', 'idempotency_conflict');
    end if;
    return jsonb_build_object('status', 'accepted');
  end if;

  select card_row.*
  into v_card
  from public.personal_cards as card_row
  where card_row.id = p_personal_card_id
    and card_row.user_id = v_user_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select job_row.id
  into v_job_id
  from private.data_erasure_jobs as job_row
  where job_row.user_id = v_user_id
    and job_row.scope = 'personal_card'
    and job_row.personal_card_id = v_card.id
    and job_row.state <> 'completed'
  for update;

  if not found then
    insert into private.data_erasure_jobs (
      user_id,
      scope,
      personal_card_id,
      requested_at,
      next_attempt_at
    ) values (
      v_user_id,
      'personal_card',
      v_card.id,
      v_now,
      v_now
    ) returning id into v_job_id;

    insert into private.data_erasure_manifest (
      job_id,
      bucket,
      object_path,
      final_delete_after
    )
    select
      v_job_id,
      'personal-cards',
      v_card.photo_path,
      greatest(
        v_now + interval '10 minutes',
        coalesce(max(boundary_row.final_boundary), v_now + interval '10 minutes')
      )
    from (
      select greatest(
        ledger_row.final_delete_not_before,
        coalesce(ledger_row.final_delete_after, v_now + interval '10 minutes')
      ) as final_boundary
      from private.personal_card_field_object_ledger as ledger_row
      where ledger_row.user_id = v_user_id
        and ledger_row.bucket = 'personal-cards'
        and ledger_row.object_path = v_card.photo_path

      union all

      select greatest(
        ledger_row.final_delete_not_before,
        coalesce(ledger_row.final_delete_after, v_now + interval '10 minutes')
      )
      from private.personal_card_permanent_object_ledger as ledger_row
      where ledger_row.user_id = v_user_id
        and ledger_row.object_path = v_card.photo_path
    ) as boundary_row;

    -- Prevent any accepted-before-delete writer from recreating this exact
    -- permanent path. A replacement card receives a fresh random path.
    insert into private.personal_card_storage_object_tombstones (object_hash)
    values (private.personal_card_storage_object_hash(
      'personal-cards',
      v_card.photo_path
    )) on conflict (object_hash) do nothing;

    -- The generic erasure manifest is now the sole owner of the permanent
    -- path. Remove restrictive promotion ledgers only after their maximum
    -- final-pass boundary has been copied above.
    delete from private.personal_card_field_object_ledger
    where user_id = v_user_id
      and bucket = 'personal-cards'
      and object_path = v_card.photo_path;

    delete from private.personal_card_permanent_object_ledger
    where user_id = v_user_id
      and object_path = v_card.photo_path;
  end if;

  -- Revoke the share and execute the existing audit-redaction DELETE trigger
  -- in this request transaction. The acquisition unique key is released at
  -- commit, so a replacement personal card can be created immediately with a
  -- fresh permanent path while this old path completes two Storage passes.
  update public.personal_cards
  set share_state = 'private',
      share_slug = null,
      shared_at = null,
      share_submitted_at = null,
      share_terms_acceptance_id = null,
      share_community_acceptance_id = null,
      share_resubmission_required = false,
      share_reason_code = null,
      share_reviewed_at = null,
      share_reviewed_by = null,
      share_reviewed_by_redacted_at = null,
      updated_at = v_now
  where id = v_card.id
    and user_id = v_user_id;

  delete from public.personal_cards
  where id = v_card.id
    and user_id = v_user_id;
  if not found then
    raise exception 'personal card disappeared during deletion request'
      using errcode = '40001';
  end if;

  insert into private.personal_card_deletion_requests (
    user_id,
    client_request_id,
    personal_card_id,
    erasure_job_id,
    pending_storage_bytes,
    requested_at
  ) values (
    v_user_id,
    p_client_request_id,
    v_card.id,
    v_job_id,
    v_card.photo_size_bytes,
    v_now
  );

  return jsonb_build_object('status', 'accepted');
end;
$$;

revoke all on function api_private.request_personal_card_deletion(
  uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function api_private.request_personal_card_deletion(
  uuid, uuid, uuid
) to service_role;

-- The current upload issuer checks the physical-account ceiling before it
-- creates a reservation. Include bytes whose card row was already deleted but
-- whose Storage object still awaits its second erasure pass.
alter function api_private.issue_personal_card_temp_upload(
  uuid, boolean, text, bigint, uuid
) rename to issue_personal_card_temp_upload_before_deletion_charge;
revoke all on function api_private.issue_personal_card_temp_upload_before_deletion_charge(
  uuid, boolean, text, bigint, uuid
) from public, anon, authenticated, service_role;

create or replace function api_private.issue_personal_card_temp_upload(
  p_auth_user_id uuid,
  p_public_gate_open boolean,
  p_declared_content_type text,
  p_declared_size_bytes bigint,
  p_client_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_physical_bytes numeric;
begin
  v_user_id := private.lock_active_user_id_for_auth(p_auth_user_id);
  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  if p_client_request_id is null then
    return jsonb_build_object('status', 'validation_failed');
  end if;
  perform pg_advisory_xact_lock_shared(hashtextextended(
    'danyeodam:policy-current-set', 0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_user_id::text, 0
  ));

  -- A valid replay is safe at the ceiling because it neither adds a path nor
  -- consumes quota. Let the inner idempotency wrapper decide it first.
  if exists (
    select 1
    from private.personal_card_temp_uploads as upload_row
    where upload_row.user_id = v_user_id
      and upload_row.client_request_id = p_client_request_id
  ) then
    return api_private.issue_personal_card_temp_upload_before_deletion_charge(
      p_auth_user_id,
      p_public_gate_open,
      p_declared_content_type,
      p_declared_size_bytes,
      p_client_request_id
    );
  end if;

  select coalesce(sum(usage_row.bytes), 0)
  into v_physical_bytes
  from (
    select card_row.photo_size_bytes::numeric as bytes
    from public.personal_cards as card_row
    where card_row.user_id = v_user_id
    union all
    select ledger_row.reserved_bytes::numeric
    from private.personal_card_permanent_object_ledger as ledger_row
    where ledger_row.user_id = v_user_id
    union all
    select 5242880::numeric
    from private.personal_card_field_object_ledger as ledger_row
    where ledger_row.user_id = v_user_id
      and ledger_row.bucket = 'personal-cards'
    union all
    select request_row.pending_storage_bytes::numeric
    from private.personal_card_deletion_requests as request_row
    where request_row.user_id = v_user_id
      and request_row.pending_storage_bytes > 0
  ) as usage_row;

  if v_physical_bytes >= 524288000 then
    return jsonb_build_object(
      'status', 'quota_exceeded',
      'reason', 'storage_bytes'
    );
  end if;

  return api_private.issue_personal_card_temp_upload_before_deletion_charge(
    p_auth_user_id,
    p_public_gate_open,
    p_declared_content_type,
    p_declared_size_bytes,
    p_client_request_id
  );
end;
$$;

revoke all on function api_private.issue_personal_card_temp_upload(
  uuid, boolean, text, bigint, uuid
) from public, anon, authenticated;
grant execute on function api_private.issue_personal_card_temp_upload(
  uuid, boolean, text, bigint, uuid
) to service_role;

-- Begin and completion already account for live cards and promotion ledgers.
-- Their wrappers add only deleting-card bytes, excluding the current
-- promotion reservation exactly as the existing inner quota code does.
alter function api_private.begin_personal_card_promotion(
  uuid, boolean, uuid, text, text, uuid
) rename to begin_personal_card_promotion_before_deletion_charge;
revoke all on function api_private.begin_personal_card_promotion_before_deletion_charge(
  uuid, boolean, uuid, text, text, uuid
) from public, anon, authenticated, service_role;

-- The function just renamed is the authenticated-rate wrapper introduced at
-- v0.3.13. Calling it after the owner advisory would invert the canonical
-- rate -> owner order used by every other participant write. This dedicated
-- inner bypasses only that outer rate call; all location, policy, owner,
-- backlog, and pre-existing storage-quota checks remain in the unrated chain.
alter function api_private.begin_personal_card_promotion_unrated(
  uuid, boolean, uuid, text, text, uuid
) rename to begin_personal_card_promotion_unrated_before_deletion_charge;
revoke all on function api_private.begin_personal_card_promotion_unrated_before_deletion_charge(
  uuid, boolean, uuid, text, text, uuid
) from public, anon, authenticated, service_role;

create or replace function api_private.begin_personal_card_promotion(
  p_auth_user_id uuid,
  p_public_gate_open boolean,
  p_acquisition_id uuid,
  p_temp_path text,
  p_caption text,
  p_processing_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rate jsonb;
  v_user_id uuid;
  v_physical_bytes numeric;
  v_permanent_path text;
begin
  v_rate := private.consume_authenticated_api_rate_limit(
    p_auth_user_id,
    'participant_write'
  );
  if v_rate ->> 'status' <> 'allowed' then
    return v_rate;
  end if;

  v_user_id := private.lock_active_user_id_for_auth(p_auth_user_id);
  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  if p_processing_token is null then
    return jsonb_build_object('status', 'validation_failed');
  end if;
  perform pg_advisory_xact_lock_shared(hashtextextended(
    'danyeodam:policy-current-set', 0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_user_id::text, 0
  ));

  -- Response-loss retries must remain idempotent at the physical-byte ceiling.
  -- Under the same owner lock used by quota writes, a completed acquisition
  -- cannot disappear or be recreated until this transaction ends. Delegate to
  -- the exact inner ownership/path checks before adding a new five-MiB charge.
  if exists (
    select 1
    from public.personal_cards as card_row
    where card_row.user_id = v_user_id
      and card_row.acquisition_id = p_acquisition_id
  ) then
    return api_private.begin_personal_card_promotion_before_generic_ledger(
      p_auth_user_id, p_public_gate_open, p_acquisition_id,
      p_temp_path, p_caption, p_processing_token
    );
  end if;

  v_permanent_path := v_user_id::text || '/' || p_processing_token::text || '.webp';

  if not exists (
    select 1 from private.personal_card_field_object_ledger
    where object_path = v_permanent_path
  ) and not exists (
    select 1 from private.personal_card_permanent_object_ledger
    where object_path = v_permanent_path
  ) then
    select coalesce(sum(usage_row.bytes), 0)
    into v_physical_bytes
    from (
      select card_row.photo_size_bytes::numeric as bytes
      from public.personal_cards as card_row
      where card_row.user_id = v_user_id
      union all
      select ledger_row.reserved_bytes::numeric
      from private.personal_card_permanent_object_ledger as ledger_row
      where ledger_row.user_id = v_user_id
        and ledger_row.object_path <> v_permanent_path
      union all
      select 5242880::numeric
      from private.personal_card_field_object_ledger as ledger_row
      where ledger_row.user_id = v_user_id
        and ledger_row.bucket = 'personal-cards'
        and ledger_row.object_path <> v_permanent_path
      union all
      select request_row.pending_storage_bytes::numeric
      from private.personal_card_deletion_requests as request_row
      where request_row.user_id = v_user_id
        and request_row.pending_storage_bytes > 0
    ) as usage_row;
    if v_physical_bytes + 5242880 > 524288000 then
      return jsonb_build_object(
        'status', 'quota_exceeded',
        'reason', 'storage_bytes'
      );
    end if;
  end if;

  return api_private.begin_personal_card_promotion_unrated_before_deletion_charge(
    p_auth_user_id, p_public_gate_open, p_acquisition_id,
    p_temp_path, p_caption, p_processing_token
  );
end;
$$;

revoke all on function api_private.begin_personal_card_promotion(
  uuid, boolean, uuid, text, text, uuid
) from public, anon, authenticated;
grant execute on function api_private.begin_personal_card_promotion(
  uuid, boolean, uuid, text, text, uuid
) to service_role;

-- The replaced rated wrapper would now point at the renamed unrated symbol.
-- It has no caller or grant, so remove the dead routine instead of retaining a
-- callable-by-owner function body that can only fail at runtime.
drop function api_private.begin_personal_card_promotion_before_deletion_charge(
  uuid, boolean, uuid, text, text, uuid
);

alter function api_private.complete_personal_card_promotion_with_size(
  uuid, uuid, uuid, uuid, text, text, bigint, uuid
) rename to complete_personal_card_promotion_with_size_before_deletion_charge;
revoke all on function api_private.complete_personal_card_promotion_with_size_before_deletion_charge(
  uuid, uuid, uuid, uuid, text, text, bigint, uuid
) from public, anon, authenticated, service_role;

create or replace function api_private.complete_personal_card_promotion_with_size(
  p_auth_user_id uuid,
  p_upload_id uuid,
  p_processing_token uuid,
  p_acquisition_id uuid,
  p_permanent_path text,
  p_caption text,
  p_photo_size_bytes bigint,
  p_expected_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_physical_bytes numeric;
begin
  if p_photo_size_bytes is null
    or p_photo_size_bytes < 1
    or p_photo_size_bytes > 5242880
  then
    return jsonb_build_object(
      'status', 'quota_exceeded',
      'reason', 'derived_file_size'
    );
  end if;

  if not private.lock_expected_active_user_id_for_auth(
    p_auth_user_id,
    p_expected_user_id
  ) then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  v_user_id := p_expected_user_id;
  perform pg_advisory_xact_lock_shared(hashtextextended(
    'danyeodam:policy-current-set', 0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_user_id::text, 0
  ));

  -- An exact completed card retry remains available at the ceiling.
  if not exists (
    select 1 from public.personal_cards as card_row
    where card_row.user_id = v_user_id
      and card_row.acquisition_id = p_acquisition_id
  ) then
    select coalesce(sum(usage_row.bytes), 0)
    into v_physical_bytes
    from (
      select card_row.photo_size_bytes::numeric as bytes
      from public.personal_cards as card_row
      where card_row.user_id = v_user_id
      union all
      select ledger_row.reserved_bytes::numeric
      from private.personal_card_permanent_object_ledger as ledger_row
      where ledger_row.user_id = v_user_id
        and ledger_row.object_path <> p_permanent_path
      union all
      select 5242880::numeric
      from private.personal_card_field_object_ledger as ledger_row
      where ledger_row.user_id = v_user_id
        and ledger_row.bucket = 'personal-cards'
        and ledger_row.object_path <> p_permanent_path
      union all
      select request_row.pending_storage_bytes::numeric
      from private.personal_card_deletion_requests as request_row
      where request_row.user_id = v_user_id
        and request_row.pending_storage_bytes > 0
    ) as usage_row;
    if v_physical_bytes + p_photo_size_bytes > 524288000 then
      return jsonb_build_object(
        'status', 'quota_exceeded',
        'reason', 'storage_bytes'
      );
    end if;
  end if;

  return api_private.complete_personal_card_promotion_with_size_before_deletion_charge(
    p_auth_user_id, p_upload_id, p_processing_token, p_acquisition_id,
    p_permanent_path, p_caption, p_photo_size_bytes, p_expected_user_id
  );
end;
$$;

revoke all on function api_private.complete_personal_card_promotion_with_size(
  uuid, uuid, uuid, uuid, text, text, bigint, uuid
) from public, anon, authenticated;
grant execute on function api_private.complete_personal_card_promotion_with_size(
  uuid, uuid, uuid, uuid, text, text, bigint, uuid
) to service_role;

-- -------------------------------------------------------------------------
-- Generic two-pass erasure completion extension
-- -------------------------------------------------------------------------

alter function api_private.finish_data_erasure_job(uuid, uuid)
  rename to finish_data_erasure_job_before_personal_card;
revoke all on function api_private.finish_data_erasure_job_before_personal_card(
  uuid, uuid
) from public, anon, authenticated, service_role;

create or replace function api_private.finish_data_erasure_job(
  p_worker_token uuid,
  p_job_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scope private.data_erasure_scope;
  v_user_id uuid;
  v_job private.data_erasure_jobs%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  select job_row.scope
  into v_scope
  from private.data_erasure_jobs as job_row
  where job_row.id = p_job_id;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_scope <> 'personal_card' then
    return api_private.finish_data_erasure_job_before_personal_card(
      p_worker_token,
      p_job_id
    );
  end if;

  select job_row.user_id
  into v_user_id
  from private.data_erasure_jobs as job_row
  where job_row.id = p_job_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_user_id::text,
    0
  ));

  select job_row.*
  into v_job
  from private.data_erasure_jobs as job_row
  where job_row.id = p_job_id
    and job_row.scope = 'personal_card'
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_job.state = 'completed' then
    return jsonb_build_object('status', 'completed');
  end if;
  if v_job.lease_token is distinct from p_worker_token
    or v_job.lease_expires_at <= v_now
  then
    return jsonb_build_object('status', 'forbidden');
  end if;

  if exists (
    select 1
    from private.data_erasure_manifest as item_row
    where item_row.job_id = v_job.id
      and item_row.deleted_at is null
  ) then
    update private.data_erasure_jobs
    set state = 'storage_pending',
        next_attempt_at = coalesce((
          select min(case
            when item_row.first_deleted_at is null then v_now + interval '5 minutes'
            when item_row.final_delete_after <= v_now then v_now + interval '5 minutes'
            else item_row.final_delete_after
          end)
          from private.data_erasure_manifest as item_row
          where item_row.job_id = v_job.id
            and item_row.deleted_at is null
        ), v_now + interval '5 minutes'),
        lease_token = null,
        lease_expires_at = null
    where id = v_job.id;
    return jsonb_build_object('status', 'retry');
  end if;

  -- Raw paths are execution data, not retained receipts.
  delete from private.data_erasure_manifest
  where job_id = v_job.id;

  -- Physical bytes are no longer reserved once both Storage passes have
  -- completed. Keep only the zero-byte thirty-day idempotency receipt.
  update private.personal_card_deletion_requests
  set pending_storage_bytes = 0
  where erasure_job_id = v_job.id;

  update private.data_erasure_jobs
  set state = 'completed',
      completed_at = v_now,
      lease_token = null,
      lease_expires_at = null,
      next_attempt_at = v_now
  where id = v_job.id;

  return jsonb_build_object('status', 'completed');
end;
$$;

revoke all on function api_private.finish_data_erasure_job(uuid, uuid)
  from public, anon, authenticated;
grant execute on function api_private.finish_data_erasure_job(uuid, uuid)
  to service_role;

commit;
