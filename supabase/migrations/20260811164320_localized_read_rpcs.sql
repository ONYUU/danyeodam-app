-- DANYEODAM API-CONTRACT v0.3 localized, server-only read surface.
-- Browser roles cannot call these SECURITY DEFINER functions directly.

-- -------------------------------------------------------------------------
-- Public spots
-- -------------------------------------------------------------------------

create or replace function api_private.list_public_spots()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with visible_spots as (
    select
      spot_row.id,
      spot_row.slug,
      private.localized_spot_name(spot_row.id) as spot_name,
      spot_row.region as region_code,
      private.localized_region_name(spot_row.region) as region_name,
      spot_row.status,
      spot_row.latitude,
      spot_row.longitude,
      region_row.sort_order as region_sort_order,
      spot_row.sort_order as spot_sort_order,
      card_row.id as card_id,
      card_row.title as card_title,
      card_row.sketch_path,
      card_row.color_hex
    from public.spots as spot_row
    join public.regions as region_row
      on region_row.code = spot_row.region
    left join lateral (
      select
        candidate.id,
        private.localized_card_title(candidate.id) as title,
        candidate.sketch_path,
        candidate.color_hex
      from public.cards as candidate
      where candidate.spot_id = spot_row.id
        and candidate.kind = 'region'
        and candidate.is_published
        and candidate.sketch_path is not null
        and private.localized_card_title(candidate.id) is not null
      order by candidate.published_at desc, candidate.id
      limit 1
    ) as card_row on spot_row.status = 'open'
    where spot_row.status in ('teaser', 'open')
      and private.localized_region_name(spot_row.region) is not null
      and private.localized_spot_name(spot_row.id) is not null
      and (
        spot_row.status = 'teaser'
        or card_row.id is not null
      )
  )
  select jsonb_build_object(
    'content_version', version_row.version,
    'spots', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', visible_row.id,
            'slug', visible_row.slug,
            'name', visible_row.spot_name,
            'region', jsonb_build_object(
              'code', visible_row.region_code,
              'name', visible_row.region_name
            ),
            'status', visible_row.status,
            'latitude', visible_row.latitude,
            'longitude', visible_row.longitude,
            'card', case
              when visible_row.status = 'teaser' then null
              else jsonb_build_object(
                'id', visible_row.card_id,
                'title', visible_row.card_title,
                'sketch_path', visible_row.sketch_path,
                'color_hex', visible_row.color_hex
              )
            end
          )
          order by
            visible_row.region_sort_order,
            visible_row.spot_sort_order,
            visible_row.id
        )
        from visible_spots as visible_row
      ),
      '[]'::jsonb
    )
  )
  from private.content_versions as version_row
  where version_row.scope = 'public_spots'
$$;

-- -------------------------------------------------------------------------
-- Protected collection and owned photo lookup
-- -------------------------------------------------------------------------

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
  v_user_id uuid;
  v_items jsonb;
  v_has_more boolean;
  v_next_anchor jsonb;
  v_stats jsonb;
  v_today_kst date := (
    clock_timestamp() at time zone 'Asia/Seoul'
  )::date;
begin
  if p_auth_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 100
    or (
      (p_before_acquired_at is null) <>
      (p_before_acquisition_id is null)
    )
  then
    return jsonb_build_object('status', 'invalid');
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

  -- A revisit is a server fact beginning on the KST day after the user's
  -- first acquisition. The partial unique index makes repeated reads and
  -- concurrent requests idempotent.
  if exists (
    select 1
    from public.acquisitions as acquisition_row
    where acquisition_row.user_id = v_user_id
      and acquisition_row.acquired_on_kst < v_today_kst
  ) then
    insert into analytics.events (
      user_id,
      event_name,
      source,
      occurred_at,
      properties
    )
    values (
      v_user_id,
      'revisit',
      'server',
      clock_timestamp(),
      '{}'::jsonb
    )
    on conflict (user_id, revisit_on_kst)
      where event_name = 'revisit'
    do nothing;
  end if;

  with candidate_rows as materialized (
    select
      acquisition_row.id,
      acquisition_row.spot_id,
      acquisition_row.card_id,
      acquisition_row.acquisition_type,
      acquisition_row.acquired_at,
      acquisition_row.acquired_on_kst,
      spot_row.slug as spot_slug,
      private.localized_spot_name(spot_row.id) as spot_name,
      private.localized_card_title(card_row.id) as card_title,
      card_row.sketch_path,
      card_row.color_hex,
      personal_card_row.id as personal_card_id,
      personal_card_row.caption,
      personal_card_row.photo_path,
      personal_card_row.created_at as personal_card_created_at,
      personal_card_row.share_state,
      personal_card_row.share_slug,
      personal_card_row.share_reason_code
    from public.acquisitions as acquisition_row
    join public.spots as spot_row
      on spot_row.id = acquisition_row.spot_id
    join public.cards as card_row
      on card_row.id = acquisition_row.card_id
    left join public.personal_cards as personal_card_row
      on personal_card_row.acquisition_id = acquisition_row.id
     and personal_card_row.user_id = acquisition_row.user_id
    where acquisition_row.user_id = v_user_id
      and (
        p_before_acquired_at is null
        or (
          acquisition_row.acquired_at,
          acquisition_row.id
        ) < (
          p_before_acquired_at,
          p_before_acquisition_id
        )
      )
    order by acquisition_row.acquired_at desc, acquisition_row.id desc
    limit p_limit + 1
  ),
  page_rows as materialized (
    select *
    from candidate_rows
    order by acquired_at desc, id desc
    limit p_limit
  )
  select
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'acquisition', jsonb_build_object(
              'id', page_row.id,
              'spot_id', page_row.spot_id,
              'card_id', page_row.card_id,
              'type', page_row.acquisition_type,
              'acquired_at', page_row.acquired_at,
              'date_kst', page_row.acquired_on_kst
            ),
            'spot', jsonb_build_object(
              'slug', page_row.spot_slug,
              'name', page_row.spot_name
            ),
            'card', jsonb_build_object(
              'title', page_row.card_title,
              'sketch_path', page_row.sketch_path,
              'color_hex', page_row.color_hex
            ),
            'personal_card', case
              when page_row.personal_card_id is null then null
              else jsonb_build_object(
                'id', page_row.personal_card_id,
                'caption', page_row.caption,
                'photo_path', page_row.photo_path,
                'created_at', page_row.personal_card_created_at,
                'share_status', page_row.share_state,
                'share_slug', page_row.share_slug,
                'reason_code', page_row.share_reason_code
              )
            end
          )
          order by page_row.acquired_at desc, page_row.id desc
        )
        from page_rows as page_row
      ),
      '[]'::jsonb
    ),
    (select count(*) > p_limit from candidate_rows),
    case
      when (select count(*) > p_limit from candidate_rows) then (
        select jsonb_build_object(
          'acquired_at', last_row.acquired_at,
          'id', last_row.id
        )
        from page_rows as last_row
        order by last_row.acquired_at, last_row.id
        limit 1
      )
      else null
    end
  into v_items, v_has_more, v_next_anchor;

  select jsonb_build_object(
    'total_acquisitions', count(*),
    'spots_visited', count(distinct acquisition_row.spot_id)
      filter (
        where acquisition_row.acquisition_type in ('field', 'retro')
      ),
    'personal_cards', (
      select count(*)
      from public.personal_cards as personal_card_row
      where personal_card_row.user_id = v_user_id
    )
  )
  into v_stats
  from public.acquisitions as acquisition_row
  where acquisition_row.user_id = v_user_id;

  return jsonb_build_object(
    'status', 'ready',
    'items', v_items,
    'has_more', v_has_more,
    'next_anchor', v_next_anchor,
    'stats', v_stats
  );
end;
$$;

create or replace function api_private.get_owned_personal_card_photo(
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
  v_photo_path text;
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

  select personal_card_row.photo_path
  into v_photo_path
  from public.personal_cards as personal_card_row
  where personal_card_row.id = p_personal_card_id
    and personal_card_row.user_id = v_user_id
  for share of personal_card_row;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  return jsonb_build_object(
    'status', 'found',
    'photo_path', v_photo_path
  );
end;
$$;

-- -------------------------------------------------------------------------
-- Localized acquisition responses
-- -------------------------------------------------------------------------

create or replace function private.acquire_result(
  p_acquisition_id uuid,
  p_status text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'status', p_status,
    'acquisition', jsonb_build_object(
      'id', acquisition_row.id,
      'spot_id', acquisition_row.spot_id,
      'card_id', acquisition_row.card_id,
      'acquisition_type', acquisition_row.acquisition_type,
      'acquired_at', acquisition_row.acquired_at,
      'acquired_on_kst', acquisition_row.acquired_on_kst
    ),
    'card', jsonb_build_object(
      'id', card_row.id,
      'title', private.localized_card_title(card_row.id),
      'sketch_path', card_row.sketch_path,
      'color_hex', card_row.color_hex
    )
  )
  from public.acquisitions as acquisition_row
  join public.cards as card_row on card_row.id = acquisition_row.card_id
  where acquisition_row.id = p_acquisition_id
$$;

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
  v_user_id uuid;
  v_existing record;
  v_spot record;
  v_card record;
begin
  if p_auth_user_id is null then
    return jsonb_build_object('status', 'error', 'code', 'UNAUTHORIZED');
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
    return jsonb_build_object('status', 'error', 'code', 'UNAUTHORIZED');
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
    return jsonb_build_object('status', 'error', 'code', 'GATE_CLOSED');
  end if;

  if p_spot_id is null or p_idempotency_key is null then
    return jsonb_build_object('status', 'error', 'code', 'NOT_FOUND');
  end if;

  select
    acquisition_row.id,
    acquisition_row.spot_id,
    acquisition_row.acquisition_type
  into v_existing
  from public.acquisitions as acquisition_row
  where acquisition_row.user_id = v_user_id
    and acquisition_row.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.spot_id = p_spot_id
      and v_existing.acquisition_type = 'field'
    then
      return private.acquire_result(v_existing.id, 'replay');
    end if;

    return jsonb_build_object(
      'status', 'error',
      'code', 'IDEMPOTENCY_CONFLICT'
    );
  end if;

  select
    spot_row.id,
    spot_row.status,
    spot_row.latitude,
    spot_row.longitude,
    spot_row.radius_m,
    spot_row.accuracy_threshold_m,
    spot_row.updated_at
  into v_spot
  from public.spots as spot_row
  where spot_row.id = p_spot_id;

  if not found then
    return jsonb_build_object('status', 'error', 'code', 'NOT_FOUND');
  end if;

  if v_spot.status <> 'open'
    or private.localized_spot_name(v_spot.id) is null
  then
    return jsonb_build_object('status', 'error', 'code', 'SPOT_NOT_OPEN');
  end if;

  select
    card_row.id,
    private.localized_card_title(card_row.id) as title,
    card_row.sketch_path,
    card_row.color_hex
  into v_card
  from public.cards as card_row
  where card_row.spot_id = p_spot_id
    and card_row.kind = 'region'
    and card_row.is_published
    and card_row.sketch_path is not null
    and private.localized_card_title(card_row.id) is not null
  order by card_row.published_at desc, card_row.id
  limit 1;

  if not found then
    return jsonb_build_object('status', 'error', 'code', 'SPOT_NOT_OPEN');
  end if;

  return jsonb_build_object(
    'status', 'ready',
    'user_id', v_user_id,
    'spot', jsonb_build_object(
      'id', v_spot.id,
      'latitude', v_spot.latitude,
      'longitude', v_spot.longitude,
      'radius_m', v_spot.radius_m,
      'accuracy_threshold_m', v_spot.accuracy_threshold_m,
      'updated_at', v_spot.updated_at
    ),
    'card', jsonb_build_object(
      'id', v_card.id,
      'title', v_card.title,
      'sketch_path', v_card.sketch_path,
      'color_hex', v_card.color_hex
    )
  );
end;
$$;

-- Re-lock the immutable card snapshot before the spot configuration. Card
-- publication/asset mutations use the same card -> spot order. Holding SHARE
-- locks through acquisition insert prevents a config close or snapshot edit
-- from committing between server-side location verification and persistence.
create or replace function api_private.acquire_commit(
  p_auth_user_id uuid,
  p_spot_id uuid,
  p_idempotency_key uuid,
  p_public_gate_open boolean,
  p_expected_spot_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_existing record;
  v_spot record;
  v_card record;
  v_acquisition_id uuid;
  v_sequence bigint;
  v_acquired_at timestamptz := clock_timestamp();
  v_acquired_on_kst date;
  v_implausible boolean;
begin
  if p_auth_user_id is null then
    return jsonb_build_object('status', 'error', 'code', 'UNAUTHORIZED');
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
    return jsonb_build_object('status', 'error', 'code', 'UNAUTHORIZED');
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
    return jsonb_build_object('status', 'error', 'code', 'GATE_CLOSED');
  end if;

  if p_spot_id is null or p_idempotency_key is null then
    return jsonb_build_object('status', 'error', 'code', 'NOT_FOUND');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'danyeodam:acquire:idempotency:' || v_user_id::text || ':' ||
      p_idempotency_key::text,
      0
    )
  );

  select
    acquisition_row.id,
    acquisition_row.spot_id,
    acquisition_row.acquisition_type
  into v_existing
  from public.acquisitions as acquisition_row
  where acquisition_row.user_id = v_user_id
    and acquisition_row.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.spot_id = p_spot_id
      and v_existing.acquisition_type = 'field'
    then
      return private.acquire_result(v_existing.id, 'replay');
    end if;

    return jsonb_build_object(
      'status', 'error',
      'code', 'IDEMPOTENCY_CONFLICT'
    );
  end if;

  select
    card_row.id,
    card_row.sketch_path,
    card_row.color_hex
  into v_card
  from public.cards as card_row
  where card_row.spot_id = p_spot_id
    and card_row.kind = 'region'
    and card_row.is_published
    and card_row.sketch_path is not null
    and private.localized_card_title(card_row.id) is not null
  order by card_row.published_at desc, card_row.id
  limit 1
  for share of card_row;

  if not found then
    -- Lock the spot only to distinguish a missing spot from a closed or
    -- incomplete configuration. No card lock exists in this branch.
    select
      spot_row.id,
      spot_row.status,
      spot_row.updated_at
    into v_spot
    from public.spots as spot_row
    where spot_row.id = p_spot_id
    for share of spot_row;

    if not found then
      return jsonb_build_object('status', 'error', 'code', 'NOT_FOUND');
    end if;

    return jsonb_build_object('status', 'error', 'code', 'SPOT_NOT_OPEN');
  end if;

  select
    spot_row.id,
    spot_row.status,
    spot_row.latitude,
    spot_row.longitude,
    spot_row.radius_m,
    spot_row.accuracy_threshold_m,
    spot_row.updated_at
  into v_spot
  from public.spots as spot_row
  where spot_row.id = p_spot_id
  for share of spot_row;

  if not found then
    return jsonb_build_object('status', 'error', 'code', 'NOT_FOUND');
  end if;

  if v_spot.status <> 'open'
    or private.localized_spot_name(v_spot.id) is null
  then
    return jsonb_build_object('status', 'error', 'code', 'SPOT_NOT_OPEN');
  end if;

  if p_expected_spot_updated_at is null
    or v_spot.updated_at <> p_expected_spot_updated_at
  then
    return jsonb_build_object(
      'status', 'error',
      'code', 'SPOT_CONFIG_CHANGED'
    );
  end if;

  v_acquired_on_kst := (v_acquired_at at time zone 'Asia/Seoul')::date;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'danyeodam:acquire:daily:' || v_user_id::text || ':' ||
      p_spot_id::text || ':' || v_acquired_on_kst::text,
      0
    )
  );

  if exists (
    select 1
    from public.acquisitions as acquisition_row
    where acquisition_row.user_id = v_user_id
      and acquisition_row.spot_id = p_spot_id
      and acquisition_row.acquisition_type = 'field'
      and acquisition_row.acquired_on_kst = v_acquired_on_kst
  ) then
    return jsonb_build_object(
      'status', 'error',
      'code', 'ALREADY_ACQUIRED_TODAY'
    );
  end if;

  v_implausible := private.is_implausible_poi_transition(
    v_user_id,
    p_spot_id,
    v_acquired_at
  );

  begin
    insert into private.card_counters (card_id, last_sequence, updated_at)
    values (v_card.id, 1, v_acquired_at)
    on conflict (card_id) do update
    set last_sequence = private.card_counters.last_sequence + 1,
        updated_at = excluded.updated_at
    returning last_sequence into v_sequence;

    insert into public.acquisitions (
      user_id,
      spot_id,
      card_id,
      acquisition_type,
      verification_result,
      idempotency_key,
      field_sequence,
      implausible_transition,
      acquired_at
    )
    values (
      v_user_id,
      p_spot_id,
      v_card.id,
      'field',
      'passed',
      p_idempotency_key,
      v_sequence,
      v_implausible,
      v_acquired_at
    )
    returning id into v_acquisition_id;

    insert into analytics.events (
      user_id,
      event_name,
      source,
      occurred_at,
      spot_id,
      properties
    )
    values (
      v_user_id,
      'acquire_success',
      'server',
      v_acquired_at,
      p_spot_id,
      jsonb_build_object('spot_id', p_spot_id)
    );
  exception
    when unique_violation then
      select
        acquisition_row.id,
        acquisition_row.spot_id,
        acquisition_row.acquisition_type
      into v_existing
      from public.acquisitions as acquisition_row
      where acquisition_row.user_id = v_user_id
        and acquisition_row.idempotency_key = p_idempotency_key;

      if found then
        if v_existing.spot_id = p_spot_id
          and v_existing.acquisition_type = 'field'
        then
          return private.acquire_result(v_existing.id, 'replay');
        end if;

        return jsonb_build_object(
          'status', 'error',
          'code', 'IDEMPOTENCY_CONFLICT'
        );
      end if;

      if exists (
        select 1
        from public.acquisitions as acquisition_row
        where acquisition_row.user_id = v_user_id
          and acquisition_row.spot_id = p_spot_id
          and acquisition_row.acquisition_type = 'field'
          and acquisition_row.acquired_on_kst = v_acquired_on_kst
      ) then
        return jsonb_build_object(
          'status', 'error',
          'code', 'ALREADY_ACQUIRED_TODAY'
        );
      end if;

      raise;
  end;

  return private.acquire_result(v_acquisition_id, 'created');
end;
$$;

-- -------------------------------------------------------------------------
-- Safe pending-only share submission, revocation, and public read
-- -------------------------------------------------------------------------

drop function api_private.create_personal_card_share(
  uuid,
  boolean,
  uuid,
  text
);

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
  v_user_id uuid;
  v_card record;
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
    return jsonb_build_object('status', 'participant_gate_closed');
  end if;

  if p_personal_card_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  select
    personal_card_row.share_slug,
    personal_card_row.share_state
  into v_card
  from public.personal_cards as personal_card_row
  where personal_card_row.id = p_personal_card_id
    and personal_card_row.user_id = v_user_id
  for update of personal_card_row;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_card.share_slug is not null then
    return jsonb_build_object(
      'status', 'existing',
      'share_slug', v_card.share_slug,
      'share_state', v_card.share_state
    );
  end if;

  if not coalesce(p_public_share_creation_open, false) then
    return jsonb_build_object('status', 'share_creation_gate_closed');
  end if;

  if p_share_slug is null
    or p_share_slug !~ '^[A-Za-z0-9]{22,128}$'
  then
    return jsonb_build_object('status', 'slug_conflict');
  end if;

  begin
    update public.personal_cards as personal_card_row
    set share_slug = p_share_slug,
        shared_at = v_occurred_at,
        share_state = 'pending_review',
        share_submitted_at = v_occurred_at,
        share_terms_acceptance_id = null,
        share_community_acceptance_id = null,
        share_resubmission_required = true,
        share_reason_code = null,
        share_reviewed_at = null,
        share_reviewed_by = null
    where personal_card_row.id = p_personal_card_id
      and personal_card_row.user_id = v_user_id;
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
    'status', 'pending',
    'share_slug', p_share_slug,
    'share_state', 'pending_review'
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
  v_existing record;
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

  select
    personal_card_row.share_slug,
    personal_card_row.share_state
  into v_existing
  from public.personal_cards as personal_card_row
  where personal_card_row.id = p_personal_card_id
    and personal_card_row.user_id = v_user_id
  for update of personal_card_row;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_existing.share_slug is null
    and v_existing.share_state = 'private'
  then
    return jsonb_build_object('status', 'already_revoked');
  end if;

  update public.personal_cards as personal_card_row
  set share_slug = null,
      shared_at = null,
      share_state = 'private',
      share_submitted_at = null,
      share_terms_acceptance_id = null,
      share_community_acceptance_id = null,
      share_resubmission_required = false,
      share_reason_code = null,
      share_reviewed_at = null,
      share_reviewed_by = null
  where personal_card_row.id = p_personal_card_id
    and personal_card_row.user_id = v_user_id;

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

drop function api_private.get_public_share(text, boolean);

create or replace function api_private.get_public_share(
  p_share_slug text,
  p_viewer_auth_user_id uuid,
  p_record_view boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_viewer_user_id uuid;
  v_share record;
begin
  if p_viewer_auth_user_id is not null then
    select identity_row.user_id
    into v_viewer_user_id
    from private.user_identities as identity_row
    join auth.users as auth_user
      on auth_user.id = identity_row.auth_user_id
    where identity_row.auth_user_id = p_viewer_auth_user_id
      and identity_row.revoked_at is null
      and auth_user.deleted_at is null
    for share of identity_row;

    if v_viewer_user_id is null then
      return jsonb_build_object('status', 'unauthorized');
    end if;
  end if;

  if p_share_slug is null
    or p_share_slug !~ '^[A-Za-z0-9]{22,128}$'
  then
    return jsonb_build_object('status', 'not_found');
  end if;

  select
    personal_card_row.id as personal_card_id,
    acquisition_row.acquired_on_kst,
    private.localized_spot_name(spot_row.id) as spot_name,
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
    and personal_card_row.share_state = 'active'
  for share of personal_card_row;

  if not found or v_share.spot_name is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  if coalesce(p_record_view, false) then
    insert into analytics.events (
      user_id,
      event_name,
      source,
      occurred_at,
      personal_card_id,
      properties
    )
    values (
      null,
      'share_view',
      'server',
      clock_timestamp(),
      v_share.personal_card_id,
      '{}'::jsonb
    );
  end if;

  return jsonb_build_object(
    'status', 'found',
    'personal_card_id', v_share.personal_card_id,
    'date_kst', to_char(v_share.acquired_on_kst, 'YYYY-MM-DD'),
    'spot', jsonb_build_object('name', v_share.spot_name),
    'caption', v_share.caption,
    'photo_path', v_share.photo_path
  );
end;
$$;

-- -------------------------------------------------------------------------
-- Function ACLs
-- -------------------------------------------------------------------------

revoke all on function api_private.list_public_spots()
  from public, anon, authenticated;
revoke all on function api_private.get_user_collection(
  uuid,
  integer,
  timestamptz,
  uuid
) from public, anon, authenticated;
revoke all on function api_private.get_owned_personal_card_photo(uuid, uuid)
  from public, anon, authenticated;
revoke all on function api_private.create_personal_card_share(
  uuid,
  boolean,
  boolean,
  uuid,
  text
) from public, anon, authenticated;
revoke all on function api_private.revoke_personal_card_share(uuid, uuid)
  from public, anon, authenticated;
revoke all on function api_private.get_public_share(text, uuid, boolean)
  from public, anon, authenticated;
revoke all on function api_private.acquire_context(
  uuid,
  uuid,
  uuid,
  boolean
) from public, anon, authenticated;
revoke all on function api_private.acquire_commit(
  uuid,
  uuid,
  uuid,
  boolean,
  timestamptz
) from public, anon, authenticated;
revoke all on function private.acquire_result(uuid, text)
  from public, anon, authenticated, service_role;

grant execute on function api_private.list_public_spots()
  to service_role;
grant execute on function api_private.get_user_collection(
  uuid,
  integer,
  timestamptz,
  uuid
) to service_role;
grant execute on function api_private.get_owned_personal_card_photo(uuid, uuid)
  to service_role;
grant execute on function api_private.create_personal_card_share(
  uuid,
  boolean,
  boolean,
  uuid,
  text
) to service_role;
grant execute on function api_private.revoke_personal_card_share(uuid, uuid)
  to service_role;
grant execute on function api_private.get_public_share(text, uuid, boolean)
  to service_role;
grant execute on function api_private.acquire_context(
  uuid,
  uuid,
  uuid,
  boolean
) to service_role;
grant execute on function api_private.acquire_commit(
  uuid,
  uuid,
  uuid,
  boolean,
  timestamptz
) to service_role;
