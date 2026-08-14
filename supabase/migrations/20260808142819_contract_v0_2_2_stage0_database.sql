-- DANYEODAM API-CONTRACT v0.2.2 database follow-up.
--
-- SECURITY BOUNDARY: device latitude, longitude, and accuracy are accepted by
-- neither these functions nor any table. Only public POI reference coordinates
-- are returned by the server-only acquire_context function.

-- -------------------------------------------------------------------------
-- Server-only Data API surface
-- -------------------------------------------------------------------------

create schema if not exists api_private;

revoke all on schema api_private from public, anon, authenticated, service_role;
grant usage on schema api_private to service_role;

-- PostgreSQL grants EXECUTE to PUBLIC on new functions by default. Remove that
-- default for future functions created by this migration owner as well.
alter default privileges in schema api_private
  revoke execute on functions from public;

-- -------------------------------------------------------------------------
-- Analytics event contract v0.2.2
-- -------------------------------------------------------------------------

-- Do not silently relabel historical auth_start facts. Stage 0 has no accepted
-- auth_start history; a non-empty legacy set requires an explicit operator
-- decision before this migration may proceed.
do $$
begin
  if exists (
    select 1
    from analytics.events as event_row
    where event_row.event_name = 'auth_start'
  ) then
    raise exception
      'analytics.events contains retired auth_start rows; archive or remove them explicitly before migrating'
      using errcode = '23514';
  end if;
end
$$;

alter table analytics.events
  drop constraint analytics_events_client_id_required,
  drop constraint analytics_events_server_facts;

alter type analytics.event_name rename to event_name_v0_1;

create type analytics.event_name as enum (
  -- Client-created, authenticated events.
  'spot_view',
  'acquire_attempt',
  'personal_card_started',
  'physical_interest_view',
  -- Server-created facts.
  'landing_view',
  'share_view',
  'acquire_success',
  'acquire_fail',
  'personal_card_created',
  'share_created',
  'share_revoked',
  'physical_interest',
  'retro_granted',
  'revisit'
);

alter table analytics.events
  alter column event_name type analytics.event_name
  using event_name::text::analytics.event_name,
  alter column user_id drop not null;

drop type analytics.event_name_v0_1;

alter table analytics.events
  add constraint analytics_events_identity_boundary check (
    (
      event_name in (
        'spot_view',
        'acquire_attempt',
        'personal_card_started',
        'physical_interest_view'
      )
      and source = 'client'
      and user_id is not null
      and client_event_id is not null
    )
    or (
      event_name in ('landing_view', 'share_view')
      and source = 'server'
      and user_id is null
      and client_event_id is null
    )
    or (
      event_name in (
        'acquire_success',
        'acquire_fail',
        'personal_card_created',
        'share_created',
        'share_revoked',
        'physical_interest',
        'retro_granted',
        'revisit'
      )
      and source = 'server'
      and user_id is not null
      and client_event_id is null
    )
  ),
  add constraint analytics_events_spot_boundary check (
    (
      event_name in (
        'spot_view',
        'acquire_attempt',
        'personal_card_started',
        'acquire_success'
      )
      and spot_id is not null
    )
    or event_name in ('acquire_fail', 'retro_granted')
    or (
      event_name not in (
        'spot_view',
        'acquire_attempt',
        'personal_card_started',
        'acquire_success',
        'acquire_fail',
        'retro_granted'
      )
      and spot_id is null
    )
  ),
  add constraint analytics_events_properties_allowlist check (
    case event_name
      when 'landing_view' then
        properties = jsonb_build_object('ref', properties -> 'ref')
        and jsonb_typeof(properties -> 'ref') = 'string'
        and properties ->> 'ref' in ('sns', 'share', 'direct')
      when 'share_view' then
        properties = jsonb_build_object('share_slug', properties -> 'share_slug')
        and jsonb_typeof(properties -> 'share_slug') = 'string'
        and char_length(properties ->> 'share_slug') >= 22
        and properties ->> 'share_slug' ~ '^[A-Za-z0-9_-]+$'
      when 'spot_view' then
        properties = jsonb_build_object('spot_id', properties -> 'spot_id')
        and jsonb_typeof(properties -> 'spot_id') = 'string'
        and properties ->> 'spot_id' = spot_id::text
      when 'acquire_attempt' then
        properties = jsonb_build_object('spot_id', properties -> 'spot_id')
        and jsonb_typeof(properties -> 'spot_id') = 'string'
        and properties ->> 'spot_id' = spot_id::text
      when 'personal_card_started' then
        properties = jsonb_build_object('spot_id', properties -> 'spot_id')
        and jsonb_typeof(properties -> 'spot_id') = 'string'
        and properties ->> 'spot_id' = spot_id::text
      when 'acquire_success' then
        properties = jsonb_build_object('spot_id', properties -> 'spot_id')
        and jsonb_typeof(properties -> 'spot_id') = 'string'
        and properties ->> 'spot_id' = spot_id::text
      when 'acquire_fail' then
        properties = jsonb_build_object('code', properties -> 'code')
        and jsonb_typeof(properties -> 'code') = 'string'
        and properties ->> 'code' in (
          'OUT_OF_RANGE',
          'LOW_ACCURACY',
          'ALREADY_ACQUIRED_TODAY',
          'SPOT_NOT_OPEN',
          'GATE_CLOSED'
        )
      when 'physical_interest_view' then properties = '{}'::jsonb
      when 'personal_card_created' then properties = '{}'::jsonb
      when 'share_created' then properties = '{}'::jsonb
      when 'share_revoked' then properties = '{}'::jsonb
      when 'physical_interest' then properties = '{}'::jsonb
      when 'retro_granted' then properties = '{}'::jsonb
      when 'revisit' then properties = '{}'::jsonb
      else false
    end
  );

-- -------------------------------------------------------------------------
-- Storage metadata and content buckets
-- -------------------------------------------------------------------------

alter table public.cards
  add constraint cards_sketch_path_safe check (
    sketch_path is null
    or (
      char_length(sketch_path) between 1 and 512
      and sketch_path !~ '^/'
      and sketch_path !~ '(^|/)\.\.(/|$)'
      and sketch_path !~ '//'
      and sketch_path !~ '\\'
      and sketch_path !~ '[[:cntrl:]]'
    )
  ) not valid;

alter table public.cards validate constraint cards_sketch_path_safe;

create or replace function private.prevent_acquired_card_response_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.acquisitions as acquisition_row
    where acquisition_row.card_id = old.id
  )
    and (
      new.title_ko is distinct from old.title_ko
      or new.title_en is distinct from old.title_en
      or new.sketch_path is distinct from old.sketch_path
      or new.color_hex is distinct from old.color_hex
    )
  then
    raise exception
      'acquired card response metadata is immutable; create a new card version'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger cards_preserve_acquired_response
before update of title_ko, title_en, sketch_path, color_hex on public.cards
for each row execute function private.prevent_acquired_card_response_mutation();

create table private.personal_card_temp_uploads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  temp_path text not null unique,
  declared_content_type text not null check (
    declared_content_type in ('image/jpeg', 'image/png', 'image/webp')
  ),
  declared_size_bytes bigint not null check (
    declared_size_bytes between 1 and 10485760
  ),
  issued_at timestamptz not null default now(),
  promotion_expires_at timestamptz not null default (now() + interval '10 minutes'),
  signed_url_expires_at timestamptz not null default (now() + interval '2 hours'),
  promoted_at timestamptz,
  permanent_path text,
  temp_deleted_at timestamptz,
  cleanup_completed_at timestamptz,
  constraint personal_card_temp_uploads_exact_expiry check (
    promotion_expires_at = issued_at + interval '10 minutes'
  ),
  constraint personal_card_temp_uploads_exact_signed_url_expiry check (
    signed_url_expires_at = issued_at + interval '2 hours'
  ),
  constraint personal_card_temp_uploads_path_owned check (
    temp_path = user_id::text || '/' || id::text ||
      case declared_content_type
        when 'image/jpeg' then '.jpg'
        when 'image/png' then '.png'
        when 'image/webp' then '.webp'
      end
  ),
  constraint personal_card_temp_uploads_promotion_window check (
    promoted_at is null
    or (
      promoted_at >= issued_at
      and promoted_at <= promotion_expires_at
    )
  ),
  constraint personal_card_temp_uploads_permanent_path check (
    (
      promoted_at is null
      and permanent_path is null
    )
    or (
      promoted_at is not null
      and permanent_path like user_id::text || '/%'
      and permanent_path !~ '(^|/)\.\.(/|$)'
    )
  ),
  constraint personal_card_temp_uploads_temp_deleted_after_issue check (
    temp_deleted_at is null or temp_deleted_at >= issued_at
  ),
  constraint personal_card_temp_uploads_cleanup_after_signed_url_expiry check (
    cleanup_completed_at is null
    or (
      cleanup_completed_at >= signed_url_expires_at
      and temp_deleted_at is not null
    )
  )
);

create index personal_card_temp_uploads_cleanup_idx
  on private.personal_card_temp_uploads(signed_url_expires_at)
  where cleanup_completed_at is null;

create index personal_card_temp_uploads_user_id_idx
  on private.personal_card_temp_uploads(user_id);

alter table private.personal_card_temp_uploads enable row level security;
alter table private.personal_card_temp_uploads force row level security;

revoke all on table private.personal_card_temp_uploads
  from public, anon, authenticated;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values
  (
    'personal-card-temp',
    'personal-card-temp',
    false,
    10485760,
    array['image/png', 'image/jpeg', 'image/webp']
  ),
  (
    'card-assets',
    'card-assets',
    true,
    10485760,
    array['image/png', 'image/jpeg', 'image/webp']
  )
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- No storage.objects browser-write policy is created. Upload URL issuance,
-- validation, re-encoding, promotion, and cleanup are server-only operations.

-- -------------------------------------------------------------------------
-- Acquisition helpers
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
      'title_ko', card_row.title_ko,
      'title_en', card_row.title_en,
      'sketch_path', card_row.sketch_path,
      'color_hex', card_row.color_hex
    )
  )
  from public.acquisitions as acquisition_row
  join public.cards as card_row on card_row.id = acquisition_row.card_id
  where acquisition_row.id = p_acquisition_id
$$;

create or replace function private.is_implausible_poi_transition(
  p_user_id uuid,
  p_spot_id uuid,
  p_acquired_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with current_spot as (
    select spot_row.latitude, spot_row.longitude
    from public.spots as spot_row
    where spot_row.id = p_spot_id
  ),
  previous_field as (
    select
      acquisition_row.acquired_at,
      previous_spot.latitude,
      previous_spot.longitude
    from public.acquisitions as acquisition_row
    join public.spots as previous_spot
      on previous_spot.id = acquisition_row.spot_id
    where acquisition_row.user_id = p_user_id
      and acquisition_row.acquisition_type = 'field'
      and acquisition_row.acquired_at <= p_acquired_at
    order by acquisition_row.acquired_at desc
    limit 1
  ),
  transition as (
    select
      6371000.0 * 2.0 * asin(
        least(
          1.0,
          sqrt(
            power(
              sin(
                radians(current_spot.latitude - previous_field.latitude) /
                2.0
              ),
              2
            )
            + cos(radians(previous_field.latitude))
            * cos(radians(current_spot.latitude))
            * power(
              sin(
                radians(current_spot.longitude - previous_field.longitude) /
                2.0
              ),
              2
            )
          )
        )
      ) as distance_m,
      greatest(
        extract(epoch from (p_acquired_at - previous_field.acquired_at)),
        1.0
      ) as elapsed_seconds
    from previous_field
    cross join current_spot
  )
  -- Diagnostic only: never rejects an acquisition. The 2 km floor prevents
  -- nearby POIs from being flagged, and 180 km/h is intentionally permissive.
  select coalesce(
    (
      select transition.distance_m > 2000.0
        and (transition.distance_m / transition.elapsed_seconds) > 50.0
      from transition
    ),
    false
  )
$$;

-- -------------------------------------------------------------------------
-- Server-only acquisition RPCs
-- -------------------------------------------------------------------------

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
  where identity_row.auth_user_id = p_auth_user_id
    and identity_row.revoked_at is null;

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

  if v_spot.status <> 'open' then
    return jsonb_build_object('status', 'error', 'code', 'SPOT_NOT_OPEN');
  end if;

  select
    card_row.id,
    card_row.title_ko,
    card_row.title_en,
    card_row.sketch_path,
    card_row.color_hex
  into v_card
  from public.cards as card_row
  where card_row.spot_id = p_spot_id
    and card_row.kind = 'region'
    and card_row.is_published
    and card_row.sketch_path is not null
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
      'title_ko', v_card.title_ko,
      'title_en', v_card.title_en,
      'sketch_path', v_card.sketch_path,
      'color_hex', v_card.color_hex
    )
  );
end;
$$;

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
  where identity_row.auth_user_id = p_auth_user_id
    and identity_row.revoked_at is null;

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

  -- Lock order is fixed for all callers: idempotency, then daily acquisition,
  -- then the card counter row. Transaction-scoped locks release automatically.
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

  if v_spot.status <> 'open' then
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

  select
    card_row.id,
    card_row.title_ko,
    card_row.title_en,
    card_row.sketch_path,
    card_row.color_hex
  into v_card
  from public.cards as card_row
  where card_row.spot_id = p_spot_id
    and card_row.kind = 'region'
    and card_row.is_published
    and card_row.sketch_path is not null
  order by card_row.published_at desc, card_row.id
  limit 1;

  if not found then
    return jsonb_build_object('status', 'error', 'code', 'SPOT_NOT_OPEN');
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

  -- The block is a PostgreSQL subtransaction. If either the acquisition or
  -- its success event fails, the counter update rolls back with it, so a
  -- failed attempt cannot consume a visible sequence number.
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
      -- Defensive reconciliation for a race or legacy counter mismatch.
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

create or replace function api_private.record_acquire_failure(
  p_auth_user_id uuid,
  p_spot_id uuid,
  p_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_spot_id uuid;
begin
  if p_code is null or p_code not in (
    'OUT_OF_RANGE',
    'LOW_ACCURACY',
    'ALREADY_ACQUIRED_TODAY',
    'SPOT_NOT_OPEN',
    'GATE_CLOSED'
  ) then
    raise exception 'unsupported acquire failure code'
      using errcode = '22023';
  end if;

  select identity_row.user_id
  into v_user_id
  from private.user_identities as identity_row
  where identity_row.auth_user_id = p_auth_user_id
    and identity_row.revoked_at is null;

  if v_user_id is null then
    return false;
  end if;

  select spot_row.id
  into v_spot_id
  from public.spots as spot_row
  where spot_row.id = p_spot_id;

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
    'acquire_fail',
    'server',
    clock_timestamp(),
    v_spot_id,
    jsonb_build_object('code', p_code)
  );

  return true;
end;
$$;

create or replace function api_private.get_published_card_asset(
  p_card_id uuid
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select card_row.sketch_path
  from public.cards as card_row
  join public.spots as spot_row on spot_row.id = card_row.spot_id
  where card_row.id = p_card_id
    and card_row.sketch_path is not null
    and (
      (
        card_row.is_published
        and spot_row.status = 'open'
      )
      or exists (
        select 1
        from public.acquisitions as acquisition_row
        where acquisition_row.card_id = card_row.id
      )
    )
  limit 1
$$;

-- Existing databases may contain field acquisitions created before the RPC.
-- Bring counters forward to the highest committed sequence before new writes.
insert into private.card_counters (card_id, last_sequence, updated_at)
select
  acquisition_row.card_id,
  max(acquisition_row.field_sequence),
  now()
from public.acquisitions as acquisition_row
where acquisition_row.field_sequence is not null
group by acquisition_row.card_id
on conflict (card_id) do update
set last_sequence = greatest(
      private.card_counters.last_sequence,
      excluded.last_sequence
    ),
    updated_at = excluded.updated_at;

-- -------------------------------------------------------------------------
-- Function ACLs
-- -------------------------------------------------------------------------

revoke all on function private.acquire_result(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function private.prevent_acquired_card_response_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.is_implausible_poi_transition(
  uuid,
  uuid,
  timestamptz
) from public, anon, authenticated, service_role;

revoke all on function api_private.acquire_context(
  uuid,
  uuid,
  uuid,
  boolean
) from public, anon, authenticated, service_role;
revoke all on function api_private.acquire_commit(
  uuid,
  uuid,
  uuid,
  boolean,
  timestamptz
) from public, anon, authenticated, service_role;
revoke all on function api_private.record_acquire_failure(
  uuid,
  uuid,
  text
) from public, anon, authenticated, service_role;
revoke all on function api_private.get_published_card_asset(uuid)
  from public, anon, authenticated, service_role;

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
grant execute on function api_private.record_acquire_failure(
  uuid,
  uuid,
  text
) to service_role;
grant execute on function api_private.get_published_card_asset(uuid)
  to service_role;
