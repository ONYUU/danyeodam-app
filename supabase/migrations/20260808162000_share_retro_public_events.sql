-- DANYEODAM share, public-view analytics, and administrator retro grants.
--
-- All functions are invoked only by trusted server code through service_role.
-- Browser roles cannot call this SECURITY DEFINER surface directly.

create unique index acquisitions_one_retro_per_user_spot_idx
  on public.acquisitions(user_id, spot_id)
  where acquisition_type = 'retro';

alter table public.personal_cards
  drop constraint personal_cards_share_slug_shape,
  add constraint personal_cards_share_slug_shape check (
    share_slug is null
    or share_slug ~ '^[A-Za-z0-9]{22,128}$'
  );

alter table analytics.events
  add constraint analytics_events_share_slug_base62 check (
    event_name <> 'share_view'
    or properties ->> 'share_slug' ~ '^[A-Za-z0-9]{22,128}$'
  );

create or replace function api_private.create_personal_card_share(
  p_auth_user_id uuid,
  p_public_gate_open boolean,
  p_personal_card_id uuid,
  p_share_slug text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_existing_slug text;
  v_occurred_at timestamptz := clock_timestamp();
begin
  if p_auth_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  select identity_row.user_id
  into v_user_id
  from private.user_identities as identity_row
  join auth.users as auth_user
    on auth_user.id = identity_row.auth_user_id
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
          or access_row.expires_at > clock_timestamp()
        )
    )
  then
    return jsonb_build_object('status', 'gate_closed');
  end if;

  if p_personal_card_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  select card_row.share_slug
  into v_existing_slug
  from public.personal_cards as card_row
  where card_row.id = p_personal_card_id
    and card_row.user_id = v_user_id
  for update of card_row;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- A second request for an already-shared card returns the original secret;
  -- it never rotates the slug or emits a duplicate server fact.
  if v_existing_slug is not null then
    return jsonb_build_object(
      'status', 'existing',
      'share_slug', v_existing_slug
    );
  end if;

  if p_share_slug is null
    or p_share_slug !~ '^[A-Za-z0-9]{22,128}$'
  then
    return jsonb_build_object('status', 'slug_conflict');
  end if;

  begin
    update public.personal_cards as card_row
    set share_slug = p_share_slug,
        shared_at = v_occurred_at
    where card_row.id = p_personal_card_id
      and card_row.user_id = v_user_id;
  exception
    when unique_violation then
      return jsonb_build_object('status', 'slug_conflict');
  end;

  insert into analytics.events (
    user_id,
    event_name,
    source,
    occurred_at,
    properties
  )
  values (
    v_user_id,
    'share_created',
    'server',
    v_occurred_at,
    '{}'::jsonb
  );

  return jsonb_build_object(
    'status', 'shared',
    'share_slug', p_share_slug
  );
end;
$$;

create or replace function api_private.revoke_personal_card_share(
  p_auth_user_id uuid,
  p_personal_card_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_existing_slug text;
  v_occurred_at timestamptz := clock_timestamp();
begin
  if p_auth_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  select identity_row.user_id
  into v_user_id
  from private.user_identities as identity_row
  join auth.users as auth_user
    on auth_user.id = identity_row.auth_user_id
  where identity_row.auth_user_id = p_auth_user_id
    and identity_row.revoked_at is null
    and auth_user.deleted_at is null
  for share of identity_row;

  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  if p_personal_card_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  select card_row.share_slug
  into v_existing_slug
  from public.personal_cards as card_row
  where card_row.id = p_personal_card_id
    and card_row.user_id = v_user_id
  for update of card_row;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_existing_slug is null then
    return jsonb_build_object('status', 'already_revoked');
  end if;

  update public.personal_cards as card_row
  set share_slug = null,
      shared_at = null
  where card_row.id = p_personal_card_id
    and card_row.user_id = v_user_id;

  insert into analytics.events (
    user_id,
    event_name,
    source,
    occurred_at,
    properties
  )
  values (
    v_user_id,
    'share_revoked',
    'server',
    v_occurred_at,
    '{}'::jsonb
  );

  return jsonb_build_object('status', 'revoked');
end;
$$;

create or replace function api_private.get_public_share(
  p_share_slug text,
  p_record_view boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_share record;
begin
  if p_share_slug is null
    or p_share_slug !~ '^[A-Za-z0-9]{22,128}$'
  then
    return jsonb_build_object('status', 'not_found');
  end if;

  select
    acquisition_row.acquired_on_kst,
    spot_row.name_ko,
    spot_row.name_en,
    personal_card_row.caption,
    personal_card_row.photo_path
  into v_share
  from public.personal_cards as personal_card_row
  join public.acquisitions as acquisition_row
    on acquisition_row.id = personal_card_row.acquisition_id
   and acquisition_row.user_id = personal_card_row.user_id
  join public.spots as spot_row
    on spot_row.id = acquisition_row.spot_id
  where personal_card_row.share_slug = p_share_slug
  for share of personal_card_row;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if coalesce(p_record_view, false) then
    insert into analytics.events (
      user_id,
      event_name,
      source,
      occurred_at,
      properties
    )
    values (
      null,
      'share_view',
      'server',
      clock_timestamp(),
      jsonb_build_object('share_slug', p_share_slug)
    );
  end if;

  return jsonb_build_object(
    'status', 'found',
    'date_kst', to_char(v_share.acquired_on_kst, 'YYYY-MM-DD'),
    'spot', jsonb_build_object(
      'name', jsonb_build_object(
        'ko', v_share.name_ko,
        'en', v_share.name_en
      )
    ),
    'caption', v_share.caption,
    'photo_path', v_share.photo_path
  );
end;
$$;

create or replace function api_private.record_landing_view(
  p_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_ref is null or p_ref not in ('sns', 'share', 'direct') then
    return jsonb_build_object('status', 'invalid');
  end if;

  insert into analytics.events (
    user_id,
    event_name,
    source,
    occurred_at,
    properties
  )
  values (
    null,
    'landing_view',
    'server',
    clock_timestamp(),
    jsonb_build_object('ref', p_ref)
  );

  return jsonb_build_object('status', 'recorded');
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
  v_admin_user_id uuid;
  v_card_id uuid;
  v_acquisition public.acquisitions%rowtype;
  v_occurred_at timestamptz := clock_timestamp();
begin
  if p_admin_auth_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  -- Fail unauthenticated and non-admin callers before taking locks on a
  -- caller-supplied target. Both facts are rechecked under locks below.
  select identity_row.user_id
  into v_admin_user_id
  from private.user_identities as identity_row
  join auth.users as auth_user
    on auth_user.id = identity_row.auth_user_id
  where identity_row.auth_user_id = p_admin_auth_user_id
    and identity_row.revoked_at is null
    and auth_user.deleted_at is null;

  if v_admin_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  if not exists (
    select 1
    from private.admin_members as admin_row
    where admin_row.auth_user_id = p_admin_auth_user_id
      and admin_row.revoked_at is null
  ) then
    return jsonb_build_object('status', 'forbidden');
  end if;

  if p_app_user_id is null or p_spot_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  if p_note is null or char_length(btrim(p_note)) < 1 then
    raise exception 'retro grant note is required'
      using errcode = '22023';
  end if;

  if char_length(p_note) > 500 then
    raise exception 'retro grant note exceeds 500 characters'
      using errcode = '22001';
  end if;

  -- Recovery claim locks every affected active identity FOR UPDATE in this
  -- same stable order. Taking the administrator and target rows together
  -- prevents a grant from racing past claim's final empty-user recheck.
  perform identity_row.id
  from private.user_identities as identity_row
  join auth.users as auth_user
    on auth_user.id = identity_row.auth_user_id
  where identity_row.revoked_at is null
    and auth_user.deleted_at is null
    and (
      identity_row.auth_user_id = p_admin_auth_user_id
      or identity_row.user_id = p_app_user_id
    )
  order by identity_row.user_id::text, identity_row.auth_user_id::text
  for share of identity_row;

  v_admin_user_id := null;
  select identity_row.user_id
  into v_admin_user_id
  from private.user_identities as identity_row
  join auth.users as auth_user
    on auth_user.id = identity_row.auth_user_id
  where identity_row.auth_user_id = p_admin_auth_user_id
    and identity_row.revoked_at is null
    and auth_user.deleted_at is null;

  if v_admin_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  perform 1
  from private.admin_members as admin_row
  where admin_row.auth_user_id = p_admin_auth_user_id
    and admin_row.revoked_at is null
  for share of admin_row;

  if not found then
    return jsonb_build_object('status', 'forbidden');
  end if;

  if not exists (
    select 1
    from private.user_identities as identity_row
    join auth.users as auth_user
      on auth_user.id = identity_row.auth_user_id
    where identity_row.user_id = p_app_user_id
      and identity_row.revoked_at is null
      and auth_user.deleted_at is null
  ) then
    return jsonb_build_object('status', 'not_found');
  end if;

  perform 1
  from public.app_users as app_user_row
  where app_user_row.id = p_app_user_id
  for share of app_user_row;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- This target-and-spot lock is taken only after the administrator identity
  -- and target user locks, establishing one consistent order for grant calls.
  perform pg_advisory_xact_lock(
    hashtextextended(
      'danyeodam:retro:' || p_app_user_id::text || ':' || p_spot_id::text,
      0
    )
  );

  select acquisition_row.*
  into v_acquisition
  from public.acquisitions as acquisition_row
  where acquisition_row.user_id = p_app_user_id
    and acquisition_row.spot_id = p_spot_id
    and acquisition_row.acquisition_type = 'retro';

  if found then
    return jsonb_build_object(
      'status', 'existing',
      'acquisition', jsonb_build_object(
        'id', v_acquisition.id,
        'spot_id', v_acquisition.spot_id,
        'card_id', v_acquisition.card_id,
        'type', v_acquisition.acquisition_type,
        'acquired_at', v_acquisition.acquired_at
      )
    );
  end if;

  select card_row.id
  into v_card_id
  from public.cards as card_row
  where card_row.spot_id = p_spot_id
    and card_row.kind = 'region'
    and card_row.is_published
    and card_row.sketch_path is not null
  order by card_row.published_at desc, card_row.id
  limit 1;

  if v_card_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  begin
    insert into public.acquisitions (
      user_id,
      spot_id,
      card_id,
      acquisition_type,
      verification_result,
      idempotency_key,
      field_sequence,
      acquired_at
    )
    values (
      p_app_user_id,
      p_spot_id,
      v_card_id,
      'retro',
      'manual',
      gen_random_uuid(),
      null,
      v_occurred_at
    )
    returning * into v_acquisition;

    insert into private.retro_grants (
      acquisition_id,
      admin_auth_user_id,
      reason_code,
      note,
      created_at
    )
    values (
      v_acquisition.id,
      p_admin_auth_user_id,
      'admin_manual',
      p_note,
      v_occurred_at
    );

    insert into analytics.events (
      user_id,
      event_name,
      source,
      occurred_at,
      spot_id,
      properties
    )
    values (
      p_app_user_id,
      'retro_granted',
      'server',
      v_occurred_at,
      p_spot_id,
      '{}'::jsonb
    );
  exception
    when unique_violation then
      select acquisition_row.*
      into v_acquisition
      from public.acquisitions as acquisition_row
      where acquisition_row.user_id = p_app_user_id
        and acquisition_row.spot_id = p_spot_id
        and acquisition_row.acquisition_type = 'retro';

      if found then
        return jsonb_build_object(
          'status', 'existing',
          'acquisition', jsonb_build_object(
            'id', v_acquisition.id,
            'spot_id', v_acquisition.spot_id,
            'card_id', v_acquisition.card_id,
            'type', v_acquisition.acquisition_type,
            'acquired_at', v_acquisition.acquired_at
          )
        );
      end if;

      raise;
  end;

  return jsonb_build_object(
    'status', 'created',
    'acquisition', jsonb_build_object(
      'id', v_acquisition.id,
      'spot_id', v_acquisition.spot_id,
      'card_id', v_acquisition.card_id,
      'type', v_acquisition.acquisition_type,
      'acquired_at', v_acquisition.acquired_at
    )
  );
end;
$$;

revoke all on function api_private.create_personal_card_share(
  uuid, boolean, uuid, text
) from public, anon, authenticated;
revoke all on function api_private.revoke_personal_card_share(
  uuid, uuid
) from public, anon, authenticated;
revoke all on function api_private.get_public_share(text, boolean)
  from public, anon, authenticated;
revoke all on function api_private.record_landing_view(text)
  from public, anon, authenticated;
revoke all on function api_private.grant_retro_acquisition(
  uuid, uuid, uuid, text
) from public, anon, authenticated;

grant execute on function api_private.create_personal_card_share(
  uuid, boolean, uuid, text
) to service_role;
grant execute on function api_private.revoke_personal_card_share(
  uuid, uuid
) to service_role;
grant execute on function api_private.get_public_share(text, boolean)
  to service_role;
grant execute on function api_private.record_landing_view(text)
  to service_role;
grant execute on function api_private.grant_retro_acquisition(
  uuid, uuid, uuid, text
) to service_role;
