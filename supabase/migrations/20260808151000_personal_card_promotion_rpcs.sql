-- DANYEODAM Stage 0 personal-card upload and promotion pipeline.
--
-- Storage paths are generated and bound inside the database. The Node.js
-- service may only operate on the exact paths returned by these functions.
-- A promotion lease binds its token to one acquisition, path, and caption so
-- a captured or accidentally reused token cannot redirect a completed write.
-- Each processing token owns a distinct permanent object path. This prevents
-- an expired worker from deleting or overwriting the object created by the
-- worker that subsequently wins the same temporary-upload lease.

alter table private.personal_card_temp_uploads
  add column processing_token uuid,
  add column processing_started_at timestamptz,
  add column processing_expires_at timestamptz,
  add column processing_acquisition_id uuid,
  add column processing_permanent_path text,
  add column processing_caption text,
  add column cleanup_started_at timestamptz;

alter table private.personal_card_temp_uploads
  add constraint personal_card_temp_uploads_processing_state check (
    (
      processing_token is null
      and processing_started_at is null
      and processing_expires_at is null
      and processing_acquisition_id is null
      and processing_permanent_path is null
      and processing_caption is null
    )
    or (
      processing_token is not null
      and processing_started_at is not null
      and processing_expires_at is not null
      and processing_acquisition_id is not null
      and processing_permanent_path is not null
      and processing_caption is not null
      and processing_started_at >= issued_at
      and processing_started_at < promotion_expires_at
      and processing_expires_at > processing_started_at
      and processing_expires_at <= promotion_expires_at
      and processing_permanent_path =
        user_id::text || '/' || processing_token::text || '.webp'
      and char_length(processing_caption) <= 60
    )
  ),
  add constraint personal_card_temp_uploads_cleanup_claim_state check (
    cleanup_started_at is null
    or cleanup_started_at >= signed_url_expires_at
  ),
  add constraint personal_card_temp_uploads_cleanup_requires_claim check (
    cleanup_completed_at is null
    or cleanup_started_at is not null
  );

create unique index personal_card_temp_uploads_processing_token_idx
  on private.personal_card_temp_uploads(processing_token)
  where processing_token is not null;

create unique index personal_card_temp_uploads_processing_path_idx
  on private.personal_card_temp_uploads(processing_permanent_path)
  where processing_permanent_path is not null;

create index personal_card_temp_uploads_processing_expiry_idx
  on private.personal_card_temp_uploads(processing_expires_at)
  where processing_token is not null and promoted_at is null;

create index personal_card_temp_uploads_cleanup_claim_idx
  on private.personal_card_temp_uploads(
    signed_url_expires_at,
    cleanup_started_at
  )
  where cleanup_completed_at is null;

-- -------------------------------------------------------------------------
-- Issue a server-owned temporary object path
-- -------------------------------------------------------------------------

create or replace function api_private.issue_personal_card_temp_upload(
  p_auth_user_id uuid,
  p_public_gate_open boolean,
  p_declared_content_type text,
  p_declared_size_bytes bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_upload_id uuid := gen_random_uuid();
  v_extension text;
  v_temp_path text;
  v_now timestamptz := clock_timestamp();
begin
  if p_auth_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  -- Recovery claims take this same active identity row FOR UPDATE. Holding a
  -- share lock makes authorization and the protected write one serial unit.
  select identity_row.user_id
  into v_user_id
  from private.user_identities as identity_row
  join auth.users as auth_user on auth_user.id = identity_row.auth_user_id
  where identity_row.auth_user_id = p_auth_user_id
    and identity_row.revoked_at is null
    and auth_user.deleted_at is null
  for share of identity_row;

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
          or access_row.expires_at > v_now
        )
    )
  then
    return jsonb_build_object('status', 'gate_closed');
  end if;

  v_extension := case p_declared_content_type
    when 'image/jpeg' then '.jpg'
    when 'image/png' then '.png'
    when 'image/webp' then '.webp'
    else null
  end;

  if v_extension is null
    or p_declared_size_bytes is null
    or p_declared_size_bytes < 1
    or p_declared_size_bytes > 10485760
  then
    return jsonb_build_object('status', 'validation_failed');
  end if;

  v_temp_path := v_user_id::text || '/' || v_upload_id::text || v_extension;

  insert into private.personal_card_temp_uploads (
    id,
    user_id,
    temp_path,
    declared_content_type,
    declared_size_bytes,
    issued_at,
    promotion_expires_at,
    signed_url_expires_at
  )
  values (
    v_upload_id,
    v_user_id,
    v_temp_path,
    p_declared_content_type,
    p_declared_size_bytes,
    v_now,
    v_now + interval '10 minutes',
    v_now + interval '2 hours'
  );

  return jsonb_build_object(
    'status', 'issued',
    'upload_id', v_upload_id,
    'temp_path', v_temp_path
  );
end;
$$;

-- -------------------------------------------------------------------------
-- Claim a short promotion lease and bind every completion parameter
-- -------------------------------------------------------------------------

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
  v_user_id uuid;
  v_upload private.personal_card_temp_uploads%rowtype;
  v_personal_card_id uuid;
  v_permanent_path text;
  v_now timestamptz := clock_timestamp();
begin
  if p_auth_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  select identity_row.user_id
  into v_user_id
  from private.user_identities as identity_row
  join auth.users as auth_user on auth_user.id = identity_row.auth_user_id
  where identity_row.auth_user_id = p_auth_user_id
    and identity_row.revoked_at is null
    and auth_user.deleted_at is null
  for share of identity_row;

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
          or access_row.expires_at > v_now
        )
    )
  then
    return jsonb_build_object('status', 'gate_closed');
  end if;

  if p_acquisition_id is null
    or p_temp_path is null
    or char_length(p_temp_path) < 1
    or char_length(p_temp_path) > 256
    or p_caption is null
    or char_length(p_caption) > 60
    or p_processing_token is null
  then
    return jsonb_build_object('status', 'validation_failed');
  end if;

  if not exists (
    select 1
    from public.acquisitions as acquisition_row
    where acquisition_row.id = p_acquisition_id
      and acquisition_row.user_id = v_user_id
  ) then
    return jsonb_build_object('status', 'not_found');
  end if;

  select upload_row.*
  into v_upload
  from private.personal_card_temp_uploads as upload_row
  where upload_row.temp_path = p_temp_path
    and upload_row.user_id = v_user_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- A completed acquisition is an idempotent result, but only after both the
  -- acquisition and the submitted temporary path were proven to be owned by
  -- the active logical user. The path need not still contain an object.
  select card_row.id
  into v_personal_card_id
  from public.personal_cards as card_row
  where card_row.acquisition_id = p_acquisition_id
    and card_row.user_id = v_user_id;

  if v_personal_card_id is not null then
    return jsonb_build_object(
      'status', 'already_created',
      'personal_card_id', v_personal_card_id
    );
  end if;

  if v_upload.temp_deleted_at is not null then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_upload.promoted_at is not null then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_now >= v_upload.promotion_expires_at then
    return jsonb_build_object('status', 'expired');
  end if;

  v_permanent_path :=
    v_user_id::text || '/' || p_processing_token::text || '.webp';

  if v_upload.processing_token is not null
    and v_upload.processing_expires_at > v_now
  then
    if v_upload.processing_token = p_processing_token
      and v_upload.processing_acquisition_id = p_acquisition_id
      and v_upload.processing_permanent_path = v_permanent_path
      and v_upload.processing_caption = p_caption
    then
      return jsonb_build_object(
        'status', 'ready',
        'upload_id', v_upload.id,
        'user_id', v_user_id,
        'temp_path', v_upload.temp_path,
        'permanent_path', v_permanent_path,
        'declared_content_type', v_upload.declared_content_type,
        'declared_size_bytes', v_upload.declared_size_bytes
      );
    end if;

    return jsonb_build_object('status', 'processing');
  end if;

  update private.personal_card_temp_uploads
  set processing_token = p_processing_token,
      processing_started_at = v_now,
      processing_expires_at = least(
        v_now + interval '5 minutes',
        v_upload.promotion_expires_at
      ),
      processing_acquisition_id = p_acquisition_id,
      processing_permanent_path = v_permanent_path,
      processing_caption = p_caption
  where id = v_upload.id;

  return jsonb_build_object(
    'status', 'ready',
    'upload_id', v_upload.id,
    'user_id', v_user_id,
    'temp_path', v_upload.temp_path,
    'permanent_path', v_permanent_path,
    'declared_content_type', v_upload.declared_content_type,
    'declared_size_bytes', v_upload.declared_size_bytes
  );
end;
$$;

-- -------------------------------------------------------------------------
-- Atomically persist a derived card and its server fact
-- -------------------------------------------------------------------------

create or replace function api_private.complete_personal_card_promotion(
  p_auth_user_id uuid,
  p_upload_id uuid,
  p_processing_token uuid,
  p_acquisition_id uuid,
  p_permanent_path text,
  p_caption text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_upload private.personal_card_temp_uploads%rowtype;
  v_personal_card public.personal_cards%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_auth_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  select identity_row.user_id
  into v_user_id
  from private.user_identities as identity_row
  join auth.users as auth_user on auth_user.id = identity_row.auth_user_id
  where identity_row.auth_user_id = p_auth_user_id
    and identity_row.revoked_at is null
    and auth_user.deleted_at is null
  for share of identity_row;

  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  if p_upload_id is null
    or p_processing_token is null
    or p_acquisition_id is null
    or p_permanent_path is null
    or p_caption is null
  then
    return jsonb_build_object('status', 'stale');
  end if;

  select upload_row.*
  into v_upload
  from private.personal_card_temp_uploads as upload_row
  where upload_row.id = p_upload_id
    and upload_row.user_id = v_user_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Completion parameters must exactly match the lease established by begin.
  if v_upload.processing_token is distinct from p_processing_token
    or v_upload.processing_acquisition_id is distinct from p_acquisition_id
    or v_upload.processing_permanent_path is distinct from p_permanent_path
    or v_upload.processing_caption is distinct from p_caption
    or p_permanent_path <>
      v_user_id::text || '/' || p_processing_token::text || '.webp'
  then
    return jsonb_build_object('status', 'stale');
  end if;

  -- Serialize two distinct temporary uploads racing to the same acquisition.
  perform acquisition_row.id
  from public.acquisitions as acquisition_row
  where acquisition_row.id = p_acquisition_id
    and acquisition_row.user_id = v_user_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select card_row.*
  into v_personal_card
  from public.personal_cards as card_row
  where card_row.acquisition_id = p_acquisition_id;

  if found then
    if v_personal_card.user_id = v_user_id
      and v_personal_card.photo_path = p_permanent_path
      and v_personal_card.caption = p_caption
      and v_upload.promoted_at is not null
      and v_upload.permanent_path = p_permanent_path
    then
      return jsonb_build_object(
        'status', 'already_created',
        'personal_card_id', v_personal_card.id
      );
    end if;

    return jsonb_build_object('status', 'stale');
  end if;

  if v_upload.promoted_at is not null then
    return jsonb_build_object('status', 'stale');
  end if;

  if v_upload.temp_deleted_at is not null
    or v_now > v_upload.promotion_expires_at
    or v_upload.processing_expires_at < v_now
  then
    return jsonb_build_object('status', 'expired');
  end if;

  insert into public.personal_cards (
    user_id,
    acquisition_id,
    photo_path,
    caption
  )
  values (
    v_user_id,
    p_acquisition_id,
    p_permanent_path,
    p_caption
  )
  returning * into v_personal_card;

  update private.personal_card_temp_uploads
  set promoted_at = v_now,
      permanent_path = p_permanent_path
  where id = p_upload_id;

  insert into analytics.events (
    user_id,
    event_name,
    source,
    occurred_at,
    properties
  )
  values (
    v_user_id,
    'personal_card_created',
    'server',
    v_now,
    '{}'::jsonb
  );

  return jsonb_build_object(
    'status', 'created',
    'personal_card_id', v_personal_card.id
  );
end;
$$;

-- -------------------------------------------------------------------------
-- Promotion compensation and temporary-object lifecycle
-- -------------------------------------------------------------------------

create or replace function api_private.release_personal_card_promotion(
  p_upload_id uuid,
  p_processing_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_upload private.personal_card_temp_uploads%rowtype;
begin
  select upload_row.*
  into v_upload
  from private.personal_card_temp_uploads as upload_row
  where upload_row.id = p_upload_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if p_processing_token is null
    or v_upload.processing_token is distinct from p_processing_token
    or v_upload.promoted_at is not null
  then
    return jsonb_build_object('status', 'stale');
  end if;

  update private.personal_card_temp_uploads
  set processing_token = null,
      processing_started_at = null,
      processing_expires_at = null,
      processing_acquisition_id = null,
      processing_permanent_path = null,
      processing_caption = null
  where id = p_upload_id;

  return jsonb_build_object('status', 'updated');
end;
$$;

-- Confirm that a failed worker's derived object is not referenced by the
-- database before the application attempts a compensating Storage deletion.
-- The row lock serializes this decision with completion and lease takeover.
-- A matching live/expired lease is cleared in the same transaction so it
-- cannot later complete using the path that is about to be deleted.
create or replace function api_private.confirm_personal_card_permanent_unreferenced(
  p_upload_id uuid,
  p_processing_token uuid,
  p_permanent_path text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_upload private.personal_card_temp_uploads%rowtype;
begin
  if p_upload_id is null
    or p_processing_token is null
    or p_permanent_path is null
  then
    return jsonb_build_object('status', 'unknown');
  end if;

  select upload_row.*
  into v_upload
  from private.personal_card_temp_uploads as upload_row
  where upload_row.id = p_upload_id
  for update;

  if not found
    or p_permanent_path <>
      v_upload.user_id::text || '/' || p_processing_token::text || '.webp'
  then
    return jsonb_build_object('status', 'unknown');
  end if;

  if exists (
    select 1
    from public.personal_cards as card_row
    where card_row.photo_path = p_permanent_path
  ) or exists (
    select 1
    from private.personal_card_temp_uploads as upload_row
    where upload_row.permanent_path = p_permanent_path
  ) then
    return jsonb_build_object('status', 'referenced');
  end if;

  -- No other active lease may own the path. The processing-token and path
  -- indexes make this a defensive invariant rather than a probabilistic UUID
  -- assumption.
  if exists (
    select 1
    from private.personal_card_temp_uploads as upload_row
    where upload_row.processing_permanent_path = p_permanent_path
      and (
        upload_row.id <> p_upload_id
        or upload_row.processing_token is distinct from p_processing_token
      )
  ) then
    return jsonb_build_object('status', 'unknown');
  end if;

  if v_upload.processing_token = p_processing_token then
    if v_upload.promoted_at is not null
      or v_upload.processing_permanent_path is distinct from p_permanent_path
    then
      return jsonb_build_object('status', 'unknown');
    end if;

    update private.personal_card_temp_uploads
    set processing_token = null,
        processing_started_at = null,
        processing_expires_at = null,
        processing_acquisition_id = null,
        processing_permanent_path = null,
        processing_caption = null
    where id = p_upload_id;
  end if;

  return jsonb_build_object('status', 'unreferenced');
end;
$$;

create or replace function api_private.mark_personal_card_temp_deleted(
  p_upload_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.personal_card_temp_uploads
  set temp_deleted_at = coalesce(temp_deleted_at, clock_timestamp())
  where id = p_upload_id;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  return jsonb_build_object('status', 'updated');
end;
$$;

create or replace function api_private.list_personal_card_temp_cleanup(
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 100);
  v_now timestamptz := clock_timestamp();
  v_results jsonb;
begin
  with candidates as (
    select upload_row.id
    from private.personal_card_temp_uploads as upload_row
    where upload_row.signed_url_expires_at <= v_now
      and upload_row.cleanup_completed_at is null
      and (
        upload_row.cleanup_started_at is null
        or upload_row.cleanup_started_at <= v_now - interval '15 minutes'
      )
    order by upload_row.signed_url_expires_at, upload_row.id
    for update skip locked
    limit v_limit
  ), claimed as (
    update private.personal_card_temp_uploads as upload_row
    set cleanup_started_at = v_now
    from candidates
    where upload_row.id = candidates.id
    returning upload_row.id, upload_row.temp_path
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'upload_id', claimed.id,
        'temp_path', claimed.temp_path
      )
      order by claimed.id
    ),
    '[]'::jsonb
  )
  into v_results
  from claimed;

  return v_results;
end;
$$;

create or replace function api_private.complete_personal_card_temp_cleanup(
  p_upload_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_upload private.personal_card_temp_uploads%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  select upload_row.*
  into v_upload
  from private.personal_card_temp_uploads as upload_row
  where upload_row.id = p_upload_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_upload.cleanup_completed_at is not null then
    return jsonb_build_object('status', 'updated');
  end if;

  if v_upload.signed_url_expires_at > v_now
    or v_upload.cleanup_started_at is null
  then
    return jsonb_build_object('status', 'stale');
  end if;

  -- Both markers are written in the same transaction. This remains true even
  -- when an earlier best-effort delete set temp_deleted_at before URL expiry.
  update private.personal_card_temp_uploads
  set temp_deleted_at = v_now,
      cleanup_completed_at = v_now
  where id = p_upload_id;

  return jsonb_build_object('status', 'updated');
end;
$$;

-- -------------------------------------------------------------------------
-- Function ACLs: the browser roles cannot invoke SECURITY DEFINER routines.
-- -------------------------------------------------------------------------

revoke all on function api_private.issue_personal_card_temp_upload(
  uuid, boolean, text, bigint
) from public, anon, authenticated, service_role;
revoke all on function api_private.begin_personal_card_promotion(
  uuid, boolean, uuid, text, text, uuid
) from public, anon, authenticated, service_role;
revoke all on function api_private.complete_personal_card_promotion(
  uuid, uuid, uuid, uuid, text, text
) from public, anon, authenticated, service_role;
revoke all on function api_private.release_personal_card_promotion(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function api_private.confirm_personal_card_permanent_unreferenced(
  uuid, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function api_private.mark_personal_card_temp_deleted(uuid)
  from public, anon, authenticated, service_role;
revoke all on function api_private.list_personal_card_temp_cleanup(integer)
  from public, anon, authenticated, service_role;
revoke all on function api_private.complete_personal_card_temp_cleanup(uuid)
  from public, anon, authenticated, service_role;

grant execute on function api_private.issue_personal_card_temp_upload(
  uuid, boolean, text, bigint
) to service_role;
grant execute on function api_private.begin_personal_card_promotion(
  uuid, boolean, uuid, text, text, uuid
) to service_role;
grant execute on function api_private.complete_personal_card_promotion(
  uuid, uuid, uuid, uuid, text, text
) to service_role;
grant execute on function api_private.release_personal_card_promotion(uuid, uuid)
  to service_role;
grant execute on function api_private.confirm_personal_card_permanent_unreferenced(
  uuid, uuid, text
) to service_role;
grant execute on function api_private.mark_personal_card_temp_deleted(uuid)
  to service_role;
grant execute on function api_private.list_personal_card_temp_cleanup(integer)
  to service_role;
grant execute on function api_private.complete_personal_card_temp_cleanup(uuid)
  to service_role;
