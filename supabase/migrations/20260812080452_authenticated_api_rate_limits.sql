-- API Contract v0.4 authenticated request-rate boundary.
--
-- Rate consumption and the protected domain mutation/read execute in one
-- PostgreSQL transaction. The server cannot consume against logical owner A,
-- wait while recovery rebinds the Auth UID to owner B, and then mutate B.
-- No bearer token, IP, user agent, request body, or mutation identifier is
-- persisted. This unapplied migration requires full writer quiescence while
-- the public RPC names are replaced by rate-aware wrappers.

create table private.rate_limit_windows (
  user_id uuid not null
    references public.app_users(id) on delete cascade,
  purpose text not null,
  attempted_at timestamptz[] not null default '{}'::timestamptz[],
  updated_at timestamptz not null default now(),
  primary key (user_id, purpose),
  constraint rate_limit_windows_purpose_valid check (
    purpose in (
      'collection_read',
      'acquire',
      'event_batch',
      'participant_write',
      'admin_mutation'
    )
  ),
  constraint rate_limit_windows_attempts_bounded check (
    (array_ndims(attempted_at) is null or array_ndims(attempted_at) = 1)
    and cardinality(attempted_at) <= 60
    and array_position(attempted_at, null) is null
  )
);

alter table private.rate_limit_windows enable row level security;
alter table private.rate_limit_windows force row level security;

revoke all on table private.rate_limit_windows
  from public, anon, authenticated, service_role;

-- This helper is deliberately private and has no Data API execution grant.
-- Its identity/app-user/admin locks remain held until the calling wrapper's
-- transaction commits, including throughout the unrated domain function.
create or replace function private.consume_authenticated_api_rate_limit(
  p_auth_user_id uuid,
  p_purpose text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_limit integer;
  v_requires_admin boolean := false;
  v_attempted_at timestamptz[];
  v_attempt_count integer;
  v_oldest_attempt timestamptz;
  v_now timestamptz := clock_timestamp();
  v_retry_after integer;
begin
  if p_auth_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  case p_purpose
    when 'collection_read' then v_limit := 60;
    when 'acquire' then v_limit := 10;
    when 'event_batch' then v_limit := 12;
    when 'participant_write' then v_limit := 30;
    when 'admin_mutation' then
      v_limit := 30;
      v_requires_admin := true;
    else
      return jsonb_build_object('status', 'invalid');
  end case;

  -- Recovery takes the active identity row FOR UPDATE. Holding SHARE here
  -- makes the binding stable for the complete outer wrapper transaction.
  v_user_id := private.lock_active_user_id_for_auth(p_auth_user_id);
  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  -- One canonical logical-owner lock serializes every fixed purpose.
  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:authenticated-api-rate:' || v_user_id::text,
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

  if v_requires_admin then
    perform 1
    from private.admin_members as admin_row
    where admin_row.auth_user_id = p_auth_user_id
      and admin_row.revoked_at is null
    for share of admin_row;
    if not found then
      return jsonb_build_object('status', 'forbidden');
    end if;
  end if;

  select window_row.attempted_at
  into v_attempted_at
  from private.rate_limit_windows as window_row
  where window_row.user_id = v_user_id
    and window_row.purpose = p_purpose
  for update;

  if not found then
    v_attempted_at := '{}'::timestamptz[];
  end if;

  select
    coalesce(
      array_agg(
        attempt_row.attempted_at
        order by attempt_row.attempted_at
      ),
      '{}'::timestamptz[]
    ),
    count(*)::integer,
    min(attempt_row.attempted_at)
  into v_attempted_at, v_attempt_count, v_oldest_attempt
  from unnest(v_attempted_at) as attempt_row(attempted_at)
  where attempt_row.attempted_at > v_now - interval '60 seconds';

  if v_attempt_count >= v_limit then
    v_retry_after := least(
      60,
      greatest(
        1,
        ceil(extract(epoch from (
          v_oldest_attempt + interval '60 seconds' - v_now
        )))::integer
      )
    );
    return jsonb_build_object(
      'status', 'rate_limited',
      'retry_after_seconds', v_retry_after
    );
  end if;

  v_attempted_at := array_append(v_attempted_at, v_now);
  insert into private.rate_limit_windows (
    user_id,
    purpose,
    attempted_at,
    updated_at
  ) values (
    v_user_id,
    p_purpose,
    v_attempted_at,
    v_now
  )
  on conflict (user_id, purpose) do update
  set attempted_at = excluded.attempted_at,
      updated_at = excluded.updated_at;

  return jsonb_build_object(
    'status', 'allowed',
    'user_id', v_user_id
  );
end;
$$;

-- Multi-transaction server workflows may continue only for the exact logical
-- owner established by their first counted RPC. This is not a lease: every
-- continuation locks the current active identity and compares it in the same
-- transaction before invoking any domain function.
create or replace function private.lock_expected_active_user_id_for_auth(
  p_auth_user_id uuid,
  p_expected_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if p_expected_user_id is null then
    return false;
  end if;

  v_user_id := private.lock_active_user_id_for_auth(p_auth_user_id);
  if v_user_id is null or v_user_id <> p_expected_user_id then
    return false;
  end if;

  perform 1
  from public.app_users as user_row
  where user_row.id = v_user_id
    and user_row.deletion_requested_at is null
  for share of user_row;
  return found;
end;
$$;

revoke all on function private.consume_authenticated_api_rate_limit(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function private.lock_expected_active_user_id_for_auth(uuid, uuid)
  from public, anon, authenticated, service_role;

-- Preserve the exact old bodies as owner-callable implementation details.
-- Their inherited service-role grants must be removed before public wrappers
-- with the original signatures are recreated below.
alter function api_private.get_user_collection(
  uuid, integer, timestamptz, uuid
) rename to get_user_collection_unrated;
alter function api_private.acquire_context(
  uuid, uuid, uuid, boolean
) rename to acquire_context_unrated;
alter function api_private.acquire_commit(
  uuid, uuid, uuid, boolean, timestamptz
) rename to acquire_commit_unrated;
alter function api_private.record_acquire_failure(
  uuid, uuid, uuid, text, jsonb
) rename to record_acquire_failure_unrated;
alter function api_private.ingest_client_events(
  uuid, boolean, jsonb
) rename to ingest_client_events_unrated;
alter function api_private.begin_personal_card_promotion(
  uuid, boolean, uuid, text, text, uuid
) rename to begin_personal_card_promotion_unrated;
alter function api_private.create_personal_card_share(
  uuid, boolean, boolean, uuid, text
) rename to create_personal_card_share_unrated;
alter function api_private.create_physical_request(
  uuid, boolean, text
) rename to create_physical_request_unrated;
alter function api_private.issue_participant_invites(
  uuid, text[], text
) rename to issue_participant_invites_unrated;
alter function api_private.grant_retro_acquisition(
  uuid, uuid, uuid, text
) rename to grant_retro_acquisition_unrated;
alter function api_private.moderate_content_report(
  uuid, uuid, uuid, text, text, text
) rename to moderate_content_report_unrated;
alter function api_private.moderate_personal_card_share(
  uuid, uuid, uuid, text, text, text, boolean
) rename to moderate_personal_card_share_unrated;
alter function api_private.moderate_share_owner_suspension(
  uuid, uuid, uuid, text, text, text
) rename to moderate_share_owner_suspension_unrated;
alter function api_private.resolve_location_correction_admin(
  uuid, uuid, text
) rename to resolve_location_correction_admin_unrated;

revoke all on function api_private.get_user_collection_unrated(
  uuid, integer, timestamptz, uuid
) from public, anon, authenticated, service_role;
revoke all on function api_private.acquire_context_unrated(
  uuid, uuid, uuid, boolean
) from public, anon, authenticated, service_role;
revoke all on function api_private.acquire_commit_unrated(
  uuid, uuid, uuid, boolean, timestamptz
) from public, anon, authenticated, service_role;
revoke all on function api_private.record_acquire_failure_unrated(
  uuid, uuid, uuid, text, jsonb
) from public, anon, authenticated, service_role;
revoke all on function api_private.ingest_client_events_unrated(
  uuid, boolean, jsonb
) from public, anon, authenticated, service_role;
revoke all on function api_private.begin_personal_card_promotion_unrated(
  uuid, boolean, uuid, text, text, uuid
) from public, anon, authenticated, service_role;
revoke all on function api_private.create_personal_card_share_unrated(
  uuid, boolean, boolean, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function api_private.create_physical_request_unrated(
  uuid, boolean, text
) from public, anon, authenticated, service_role;
revoke all on function api_private.issue_participant_invites_unrated(
  uuid, text[], text
) from public, anon, authenticated, service_role;
revoke all on function api_private.grant_retro_acquisition_unrated(
  uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function api_private.moderate_content_report_unrated(
  uuid, uuid, uuid, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function api_private.moderate_personal_card_share_unrated(
  uuid, uuid, uuid, text, text, text, boolean
) from public, anon, authenticated, service_role;
revoke all on function api_private.moderate_share_owner_suspension_unrated(
  uuid, uuid, uuid, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function api_private.resolve_location_correction_admin_unrated(
  uuid, uuid, text
) from public, anon, authenticated, service_role;

-- Protected collection: one counted read and the collection projection are
-- atomic with respect to identity recovery.
create or replace function api_private.get_user_collection(
  p_auth_user_id uuid,
  p_limit integer,
  p_before_acquired_at timestamptz default null,
  p_before_acquisition_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rate jsonb;
begin
  v_rate := private.consume_authenticated_api_rate_limit(
    p_auth_user_id,
    'collection_read'
  );
  if v_rate ->> 'status' <> 'allowed' then
    return v_rate;
  end if;
  return api_private.get_user_collection_unrated(
    p_auth_user_id,
    p_limit,
    p_before_acquired_at,
    p_before_acquisition_id
  );
end;
$$;

-- Initial acquire context consumes exactly once. A server-only expected owner
-- is attached only where Node must call a later failure transition.
create or replace function api_private.acquire_context(
  p_auth_user_id uuid,
  p_spot_id uuid,
  p_idempotency_key uuid,
  p_public_gate_open boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rate jsonb;
  v_result jsonb;
  v_user_id uuid;
begin
  -- Match private.lock_adult_location_access: policy set, identity, owner.
  perform pg_advisory_xact_lock_shared(hashtextextended(
    'danyeodam:policy-current-set',
    0
  ));
  v_rate := private.consume_authenticated_api_rate_limit(
    p_auth_user_id,
    'acquire'
  );
  if v_rate ->> 'status' <> 'allowed' then
    if v_rate ->> 'status' = 'rate_limited' then
      return v_rate;
    end if;
    return jsonb_build_object(
      'status', 'error',
      'code', 'UNAUTHORIZED'
    );
  end if;
  v_user_id := (v_rate ->> 'user_id')::uuid;
  v_result := api_private.acquire_context_unrated(
    p_auth_user_id,
    p_spot_id,
    p_idempotency_key,
    p_public_gate_open
  );
  if v_result ->> 'status' = 'error'
    and v_result ->> 'code' in (
      'GATE_CLOSED',
      'SPOT_NOT_OPEN',
      'ALREADY_ACQUIRED_TODAY',
      'OUT_OF_RANGE',
      'LOW_ACCURACY'
    )
  then
    v_result := v_result || jsonb_build_object(
      'expected_user_id', v_user_id
    );
  end if;
  return v_result;
end;
$$;

-- A configuration retry is part of the same HTTP attempt, so it does not
-- consume again. It may proceed only for the owner returned by the first RPC.
create or replace function api_private.acquire_context_continuation(
  p_auth_user_id uuid,
  p_spot_id uuid,
  p_idempotency_key uuid,
  p_public_gate_open boolean,
  p_expected_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform pg_advisory_xact_lock_shared(hashtextextended(
    'danyeodam:policy-current-set',
    0
  ));
  if not private.lock_expected_active_user_id_for_auth(
    p_auth_user_id,
    p_expected_user_id
  ) then
    return jsonb_build_object(
      'status', 'error',
      'code', 'UNAUTHORIZED'
    );
  end if;
  v_result := api_private.acquire_context_unrated(
    p_auth_user_id,
    p_spot_id,
    p_idempotency_key,
    p_public_gate_open
  );
  if v_result ->> 'status' = 'error'
    and v_result ->> 'code' in (
      'GATE_CLOSED',
      'SPOT_NOT_OPEN',
      'ALREADY_ACQUIRED_TODAY',
      'OUT_OF_RANGE',
      'LOW_ACCURACY'
    )
  then
    v_result := v_result || jsonb_build_object(
      'expected_user_id', p_expected_user_id
    );
  end if;
  return v_result;
end;
$$;

create or replace function api_private.acquire_commit(
  p_auth_user_id uuid,
  p_spot_id uuid,
  p_idempotency_key uuid,
  p_public_gate_open boolean,
  p_expected_spot_updated_at timestamptz,
  p_expected_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock_shared(hashtextextended(
    'danyeodam:policy-current-set',
    0
  ));
  if not private.lock_expected_active_user_id_for_auth(
    p_auth_user_id,
    p_expected_user_id
  ) then
    return jsonb_build_object(
      'status', 'error',
      'code', 'UNAUTHORIZED'
    );
  end if;
  return api_private.acquire_commit_unrated(
    p_auth_user_id,
    p_spot_id,
    p_idempotency_key,
    p_public_gate_open,
    p_expected_spot_updated_at
  );
end;
$$;

create or replace function api_private.record_acquire_failure(
  p_auth_user_id uuid,
  p_spot_id uuid,
  p_idempotency_key uuid,
  p_code text,
  p_details jsonb,
  p_expected_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock_shared(hashtextextended(
    'danyeodam:policy-current-set',
    0
  ));
  if not private.lock_expected_active_user_id_for_auth(
    p_auth_user_id,
    p_expected_user_id
  ) then
    return jsonb_build_object(
      'status', 'error',
      'code', 'UNAUTHORIZED'
    );
  end if;
  return api_private.record_acquire_failure_unrated(
    p_auth_user_id,
    p_spot_id,
    p_idempotency_key,
    p_code,
    p_details
  );
end;
$$;

create or replace function api_private.ingest_client_events(
  p_auth_user_id uuid,
  p_public_gate_open boolean,
  p_events jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rate jsonb;
begin
  v_rate := private.consume_authenticated_api_rate_limit(
    p_auth_user_id,
    'event_batch'
  );
  if v_rate ->> 'status' <> 'allowed' then
    return v_rate;
  end if;
  return api_private.ingest_client_events_unrated(
    p_auth_user_id,
    p_public_gate_open,
    p_events
  );
end;
$$;

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
begin
  v_rate := private.consume_authenticated_api_rate_limit(
    p_auth_user_id,
    'participant_write'
  );
  if v_rate ->> 'status' <> 'allowed' then
    return v_rate;
  end if;
  return api_private.begin_personal_card_promotion_unrated(
    p_auth_user_id,
    p_public_gate_open,
    p_acquisition_id,
    p_temp_path,
    p_caption,
    p_processing_token
  );
end;
$$;

-- Promotion completion follows external Storage I/O. The old seven-argument
-- owner-unbound function remains owner-callable for historical pgTAP coverage
-- but loses service-role EXECUTE; production must supply the owner returned by
-- begin_personal_card_promotion.
alter function api_private.complete_personal_card_promotion_with_size(
  uuid, uuid, uuid, uuid, text, text, bigint
) rename to complete_personal_card_promotion_with_size_unbound;

revoke all on function api_private.complete_personal_card_promotion_with_size_unbound(
  uuid, uuid, uuid, uuid, text, text, bigint
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
begin
  if not private.lock_expected_active_user_id_for_auth(
    p_auth_user_id,
    p_expected_user_id
  ) then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  return api_private.complete_personal_card_promotion_with_size_unbound(
    p_auth_user_id,
    p_upload_id,
    p_processing_token,
    p_acquisition_id,
    p_permanent_path,
    p_caption,
    p_photo_size_bytes
  );
end;
$$;

-- Share slug collisions retry inside one HTTP attempt. The first wrapper
-- consumes once and returns a server-only expected owner on collision; the
-- overload validates that owner and does not consume again.
create or replace function api_private.create_personal_card_share(
  p_auth_user_id uuid,
  p_public_gate_open boolean,
  p_public_share_creation_open boolean,
  p_personal_card_id uuid,
  p_share_slug text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rate jsonb;
  v_result jsonb;
begin
  v_rate := private.consume_authenticated_api_rate_limit(
    p_auth_user_id,
    'participant_write'
  );
  if v_rate ->> 'status' <> 'allowed' then
    return v_rate;
  end if;
  v_result := api_private.create_personal_card_share_unrated(
    p_auth_user_id,
    p_public_gate_open,
    p_public_share_creation_open,
    p_personal_card_id,
    p_share_slug
  );
  if v_result ->> 'status' = 'slug_conflict' then
    v_result := v_result || jsonb_build_object(
      'expected_user_id', (v_rate ->> 'user_id')::uuid
    );
  end if;
  return v_result;
end;
$$;

create or replace function api_private.create_personal_card_share_continuation(
  p_auth_user_id uuid,
  p_public_gate_open boolean,
  p_public_share_creation_open boolean,
  p_personal_card_id uuid,
  p_share_slug text,
  p_expected_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not private.lock_expected_active_user_id_for_auth(
    p_auth_user_id,
    p_expected_user_id
  ) then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  v_result := api_private.create_personal_card_share_unrated(
    p_auth_user_id,
    p_public_gate_open,
    p_public_share_creation_open,
    p_personal_card_id,
    p_share_slug
  );
  if v_result ->> 'status' = 'slug_conflict' then
    v_result := v_result || jsonb_build_object(
      'expected_user_id', p_expected_user_id
    );
  end if;
  return v_result;
end;
$$;

create or replace function api_private.create_physical_request(
  p_auth_user_id uuid,
  p_public_gate_open boolean,
  p_kind text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rate jsonb;
begin
  v_rate := private.consume_authenticated_api_rate_limit(
    p_auth_user_id,
    'participant_write'
  );
  if v_rate ->> 'status' <> 'allowed' then
    return v_rate;
  end if;
  return api_private.create_physical_request_unrated(
    p_auth_user_id,
    p_public_gate_open,
    p_kind
  );
end;
$$;

create or replace function api_private.issue_participant_invites(
  p_auth_user_id uuid,
  p_code_hash_hexes text[],
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rate jsonb;
begin
  v_rate := private.consume_authenticated_api_rate_limit(
    p_auth_user_id,
    'admin_mutation'
  );
  if v_rate ->> 'status' <> 'allowed' then
    return v_rate;
  end if;
  return api_private.issue_participant_invites_unrated(
    p_auth_user_id,
    p_code_hash_hexes,
    p_note
  );
end;
$$;

create or replace function api_private.grant_retro_acquisition(
  p_admin_auth_user_id uuid,
  p_app_user_id uuid,
  p_spot_id uuid,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rate jsonb;
begin
  v_rate := private.consume_authenticated_api_rate_limit(
    p_admin_auth_user_id,
    'admin_mutation'
  );
  if v_rate ->> 'status' <> 'allowed' then
    return v_rate;
  end if;
  return api_private.grant_retro_acquisition_unrated(
    p_admin_auth_user_id,
    p_app_user_id,
    p_spot_id,
    p_note
  );
end;
$$;

create or replace function api_private.moderate_content_report(
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
begin
  v_rate := private.consume_authenticated_api_rate_limit(
    p_admin_auth_user_id,
    'admin_mutation'
  );
  if v_rate ->> 'status' <> 'allowed' then
    return v_rate;
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

create or replace function api_private.moderate_personal_card_share(
  p_admin_auth_user_id uuid,
  p_personal_card_id uuid,
  p_client_action_id uuid,
  p_action text,
  p_reason_code text,
  p_note text,
  p_public_share_publication_open boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rate jsonb;
begin
  v_rate := private.consume_authenticated_api_rate_limit(
    p_admin_auth_user_id,
    'admin_mutation'
  );
  if v_rate ->> 'status' <> 'allowed' then
    return v_rate;
  end if;
  return api_private.moderate_personal_card_share_unrated(
    p_admin_auth_user_id,
    p_personal_card_id,
    p_client_action_id,
    p_action,
    p_reason_code,
    p_note,
    p_public_share_publication_open
  );
end;
$$;

create or replace function api_private.moderate_share_owner_suspension(
  p_admin_auth_user_id uuid,
  p_suspension_id uuid,
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
begin
  v_rate := private.consume_authenticated_api_rate_limit(
    p_admin_auth_user_id,
    'admin_mutation'
  );
  if v_rate ->> 'status' <> 'allowed' then
    return v_rate;
  end if;
  return api_private.moderate_share_owner_suspension_unrated(
    p_admin_auth_user_id,
    p_suspension_id,
    p_client_action_id,
    p_action,
    p_reason_code,
    p_note
  );
end;
$$;

create or replace function api_private.resolve_location_correction_admin(
  p_admin_auth_user_id uuid,
  p_correction_request_id uuid,
  p_resolution text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rate jsonb;
begin
  v_rate := private.consume_authenticated_api_rate_limit(
    p_admin_auth_user_id,
    'admin_mutation'
  );
  if v_rate ->> 'status' <> 'allowed' then
    return v_rate;
  end if;
  return api_private.resolve_location_correction_admin_unrated(
    p_admin_auth_user_id,
    p_correction_request_id,
    p_resolution
  );
end;
$$;

-- Every public wrapper is a service-role-only SECURITY DEFINER function.
revoke all on function api_private.get_user_collection(
  uuid, integer, timestamptz, uuid
) from public, anon, authenticated, service_role;
revoke all on function api_private.acquire_context(
  uuid, uuid, uuid, boolean
) from public, anon, authenticated, service_role;
revoke all on function api_private.acquire_context_continuation(
  uuid, uuid, uuid, boolean, uuid
) from public, anon, authenticated, service_role;
revoke all on function api_private.acquire_commit(
  uuid, uuid, uuid, boolean, timestamptz, uuid
) from public, anon, authenticated, service_role;
revoke all on function api_private.record_acquire_failure(
  uuid, uuid, uuid, text, jsonb, uuid
) from public, anon, authenticated, service_role;
revoke all on function api_private.ingest_client_events(
  uuid, boolean, jsonb
) from public, anon, authenticated, service_role;
revoke all on function api_private.begin_personal_card_promotion(
  uuid, boolean, uuid, text, text, uuid
) from public, anon, authenticated, service_role;
revoke all on function api_private.complete_personal_card_promotion_with_size(
  uuid, uuid, uuid, uuid, text, text, bigint, uuid
) from public, anon, authenticated, service_role;
revoke all on function api_private.create_personal_card_share(
  uuid, boolean, boolean, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function api_private.create_personal_card_share_continuation(
  uuid, boolean, boolean, uuid, text, uuid
) from public, anon, authenticated, service_role;
revoke all on function api_private.create_physical_request(
  uuid, boolean, text
) from public, anon, authenticated, service_role;
revoke all on function api_private.issue_participant_invites(
  uuid, text[], text
) from public, anon, authenticated, service_role;
revoke all on function api_private.grant_retro_acquisition(
  uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function api_private.moderate_content_report(
  uuid, uuid, uuid, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function api_private.moderate_personal_card_share(
  uuid, uuid, uuid, text, text, text, boolean
) from public, anon, authenticated, service_role;
revoke all on function api_private.moderate_share_owner_suspension(
  uuid, uuid, uuid, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function api_private.resolve_location_correction_admin(
  uuid, uuid, text
) from public, anon, authenticated, service_role;

grant execute on function api_private.get_user_collection(
  uuid, integer, timestamptz, uuid
) to service_role;
grant execute on function api_private.acquire_context(
  uuid, uuid, uuid, boolean
) to service_role;
grant execute on function api_private.acquire_context_continuation(
  uuid, uuid, uuid, boolean, uuid
) to service_role;
grant execute on function api_private.acquire_commit(
  uuid, uuid, uuid, boolean, timestamptz, uuid
) to service_role;
grant execute on function api_private.record_acquire_failure(
  uuid, uuid, uuid, text, jsonb, uuid
) to service_role;
grant execute on function api_private.ingest_client_events(
  uuid, boolean, jsonb
) to service_role;
grant execute on function api_private.begin_personal_card_promotion(
  uuid, boolean, uuid, text, text, uuid
) to service_role;
grant execute on function api_private.complete_personal_card_promotion_with_size(
  uuid, uuid, uuid, uuid, text, text, bigint, uuid
) to service_role;
grant execute on function api_private.create_personal_card_share(
  uuid, boolean, boolean, uuid, text
) to service_role;
grant execute on function api_private.create_personal_card_share_continuation(
  uuid, boolean, boolean, uuid, text, uuid
) to service_role;
grant execute on function api_private.create_physical_request(
  uuid, boolean, text
) to service_role;
grant execute on function api_private.issue_participant_invites(
  uuid, text[], text
) to service_role;
grant execute on function api_private.grant_retro_acquisition(
  uuid, uuid, uuid, text
) to service_role;
grant execute on function api_private.moderate_content_report(
  uuid, uuid, uuid, text, text, text
) to service_role;
grant execute on function api_private.moderate_personal_card_share(
  uuid, uuid, uuid, text, text, text, boolean
) to service_role;
grant execute on function api_private.moderate_share_owner_suspension(
  uuid, uuid, uuid, text, text, text
) to service_role;
grant execute on function api_private.resolve_location_correction_admin(
  uuid, uuid, text
) to service_role;
