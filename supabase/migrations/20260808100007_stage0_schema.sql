-- DANYEODAM Stage 0 schema and authorization baseline.
-- User-submitted device coordinates and accuracy are deliberately absent.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
create schema if not exists analytics;

revoke all on schema private from public, anon, authenticated;
revoke all on schema analytics from public, anon, authenticated;

-- Authenticated users need schema usage only for the small RLS helper surface.
-- service_role needs it for server-only validation functions. Neither schema
-- is exposed by supabase/config.toml.
grant usage on schema private to authenticated, service_role;

create type public.spot_status as enum (
  'draft',
  'teaser',
  'open',
  'paused',
  'retired'
);

create type public.card_kind as enum (
  'region',
  'limited',
  'special'
);

create type public.acquisition_type as enum (
  'field',
  'retro',
  'gift'
);

create type public.verification_result as enum (
  'passed',
  'manual',
  'matched',
  'not_applicable'
);

create type public.physical_request_kind as enum (
  'request',
  'notify'
);

create type analytics.event_source as enum (
  'client',
  'server'
);

create type analytics.event_name as enum (
  'landing_view',
  'auth_start',
  'spot_view',
  'acquire_attempt',
  'acquire_success',
  'acquire_fail',
  'personal_card_created',
  'share_created',
  'revisit',
  'physical_interest'
);

-- Stable pseudonymous product identity. Authentication identities may change
-- after recovery without rewriting every product row.
create table public.app_users (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table private.user_identities (
  id bigint generated always as identity primary key,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  user_id uuid not null references public.app_users(id) on delete cascade,
  bound_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint user_identities_revoked_after_bound
    check (revoked_at is null or revoked_at >= bound_at)
);

create unique index user_identities_one_active_auth_idx
  on private.user_identities(auth_user_id)
  where revoked_at is null;

create unique index user_identities_one_active_user_idx
  on private.user_identities(user_id)
  where revoked_at is null;

create index user_identities_auth_user_all_idx
  on private.user_identities(auth_user_id);

create index user_identities_user_all_idx
  on private.user_identities(user_id);

create table private.admin_members (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  granted_at timestamptz not null default now(),
  granted_by_auth_user_id uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  constraint admin_members_revoked_after_granted
    check (revoked_at is null or revoked_at >= granted_at)
);

create index admin_members_granted_by_idx
  on private.admin_members(granted_by_auth_user_id)
  where granted_by_auth_user_id is not null;

create table private.participant_access (
  user_id uuid primary key references public.app_users(id) on delete cascade,
  access_kind text not null default 'internal_tester'
    check (access_kind in ('internal_tester', 'public_beta')),
  granted_at timestamptz not null default now(),
  granted_by_auth_user_id uuid references auth.users(id) on delete set null,
  expires_at timestamptz,
  revoked_at timestamptz,
  constraint participant_access_expiry_after_grant
    check (expires_at is null or expires_at > granted_at),
  constraint participant_access_revoked_after_grant
    check (revoked_at is null or revoked_at >= granted_at)
);

create index participant_access_granted_by_idx
  on private.participant_access(granted_by_auth_user_id)
  where granted_by_auth_user_id is not null;

-- Coordinates below are public POI reference coordinates, not user locations.
create table public.spots (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique
    check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  region text not null,
  name_ko text not null,
  name_en text not null,
  status public.spot_status not null default 'draft',
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  radius_m integer not null default 150 check (radius_m between 20 and 2000),
  accuracy_threshold_m integer not null default 200
    check (accuracy_threshold_m between 10 and 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index spots_status_region_idx on public.spots(status, region);

create table public.cards (
  id uuid primary key default gen_random_uuid(),
  spot_id uuid not null references public.spots(id) on delete restrict,
  code text not null unique
    check (code ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  kind public.card_kind not null default 'region',
  title_ko text not null,
  title_en text not null,
  sketch_path text,
  color_hex text not null check (color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  is_published boolean not null default false,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cards_published_at_required
    check (not is_published or published_at is not null),
  constraint cards_id_spot_unique unique (id, spot_id)
);

create index cards_spot_id_idx on public.cards(spot_id);

create unique index cards_one_published_region_per_spot_idx
  on public.cards(spot_id)
  where is_published and kind = 'region';

create table private.card_counters (
  card_id uuid primary key references public.cards(id) on delete cascade,
  last_sequence bigint not null default 0 check (last_sequence >= 0),
  updated_at timestamptz not null default now()
);

create table public.acquisitions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  spot_id uuid not null references public.spots(id) on delete restrict,
  card_id uuid not null,
  acquisition_type public.acquisition_type not null,
  verification_result public.verification_result not null,
  idempotency_key uuid not null,
  field_sequence bigint,
  implausible_transition boolean not null default false,
  acquired_at timestamptz not null default now(),
  acquired_on_kst date generated always as (
    (acquired_at at time zone 'Asia/Seoul')::date
  ) stored,
  constraint acquisitions_card_spot_fkey
    foreign key (card_id, spot_id)
    references public.cards(id, spot_id)
    on delete restrict,
  constraint acquisitions_id_user_unique unique (id, user_id),
  constraint acquisitions_field_sequence_positive
    check (field_sequence is null or field_sequence > 0),
  constraint acquisitions_type_invariants check (
    (
      acquisition_type = 'field'
      and field_sequence is not null
      and verification_result = 'passed'
    )
    or (
      acquisition_type = 'retro'
      and field_sequence is null
      and verification_result in ('manual', 'matched')
    )
    or (
      acquisition_type = 'gift'
      and field_sequence is null
      and verification_result = 'not_applicable'
    )
  )
);

create index acquisitions_user_acquired_idx
  on public.acquisitions(user_id, acquired_at desc);

create index acquisitions_spot_type_acquired_idx
  on public.acquisitions(spot_id, acquisition_type, acquired_at desc);

create index acquisitions_card_id_idx on public.acquisitions(card_id);

create index acquisitions_card_spot_idx
  on public.acquisitions(card_id, spot_id);

create unique index acquisitions_user_idempotency_idx
  on public.acquisitions(user_id, idempotency_key);

create unique index acquisitions_one_field_per_day_idx
  on public.acquisitions(user_id, spot_id, acquired_on_kst)
  where acquisition_type = 'field';

create unique index acquisitions_card_sequence_idx
  on public.acquisitions(card_id, field_sequence)
  where field_sequence is not null;

create table private.retro_grants (
  id uuid primary key default gen_random_uuid(),
  acquisition_id uuid not null unique
    references public.acquisitions(id) on delete cascade,
  admin_auth_user_id uuid not null references auth.users(id) on delete restrict,
  reason_code text not null,
  note text check (note is null or char_length(note) <= 500),
  created_at timestamptz not null default now()
);

create index retro_grants_admin_idx
  on private.retro_grants(admin_auth_user_id, created_at desc);

create or replace function private.enforce_retro_grant_target()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.acquisitions as acquisition_row
    where acquisition_row.id = new.acquisition_id
      and acquisition_row.acquisition_type = 'retro'
  ) then
    raise exception 'retro grant must reference a retro acquisition'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger retro_grants_target_is_retro
before insert or update of acquisition_id on private.retro_grants
for each row execute function private.enforce_retro_grant_target();

create or replace function private.ensure_retro_acquisition_has_grant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.acquisitions as acquisition_row
    where acquisition_row.id = new.id
      and acquisition_row.acquisition_type = 'retro'
  ) and not exists (
    select 1
    from private.retro_grants as grant_row
    where grant_row.acquisition_id = new.id
  ) then
    raise exception 'retro acquisition requires an audit grant'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.acquisitions as acquisition_row
    where acquisition_row.id = new.id
      and acquisition_row.acquisition_type <> 'retro'
  ) and exists (
    select 1
    from private.retro_grants as grant_row
    where grant_row.acquisition_id = new.id
  ) then
    raise exception 'retro audit grant requires a retro acquisition'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create constraint trigger retro_acquisition_requires_grant
after insert or update of acquisition_type on public.acquisitions
deferrable initially deferred
for each row execute function private.ensure_retro_acquisition_has_grant();

create or replace function private.ensure_retro_grant_removal_safe()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.acquisitions as acquisition_row
    where acquisition_row.id = old.acquisition_id
      and acquisition_row.acquisition_type = 'retro'
  ) and not exists (
    select 1
    from private.retro_grants as grant_row
    where grant_row.acquisition_id = old.acquisition_id
  ) then
    raise exception 'retro acquisition requires an audit grant'
      using errcode = '23514';
  end if;

  return coalesce(new, old);
end;
$$;

create constraint trigger retro_grant_removal_keeps_audit
after delete or update of acquisition_id on private.retro_grants
deferrable initially deferred
for each row execute function private.ensure_retro_grant_removal_safe();

create table public.personal_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  acquisition_id uuid not null unique,
  photo_path text not null,
  caption text not null default '' check (char_length(caption) <= 60),
  share_slug text unique,
  shared_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint personal_cards_acquisition_owner_fkey
    foreign key (acquisition_id, user_id)
    references public.acquisitions(id, user_id)
    on delete cascade,
  constraint personal_cards_photo_path_owned check (
    photo_path like user_id::text || '/%'
    and photo_path !~ '(^|/)\.\.(/|$)'
  ),
  constraint personal_cards_share_slug_shape check (
    share_slug is null
    or (
      char_length(share_slug) >= 22
      and share_slug ~ '^[A-Za-z0-9_-]+$'
    )
  ),
  constraint personal_cards_shared_at_consistent check (
    (share_slug is null and shared_at is null)
    or (share_slug is not null and shared_at is not null)
  )
);

create index personal_cards_user_created_idx
  on public.personal_cards(user_id, created_at desc);

create table public.physical_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  kind public.physical_request_kind not null,
  created_at timestamptz not null default now(),
  constraint physical_requests_user_kind_unique unique (user_id, kind)
);

-- Recovery codes are high-entropy secrets. Only a 32-byte digest is stored.
create table private.recovery_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  code_hash bytea not null unique check (octet_length(code_hash) = 32),
  failed_attempts smallint not null default 0
    check (failed_attempts between 0 and 5),
  issued_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  claimed_at timestamptz,
  claimed_by_auth_user_id uuid references auth.users(id) on delete set null,
  claimant_redacted_at timestamptz,
  constraint recovery_codes_expiry_after_issue
    check (expires_at is null or expires_at > issued_at),
  constraint recovery_codes_revoked_after_issue
    check (revoked_at is null or revoked_at >= issued_at),
  constraint recovery_codes_claimed_after_issue
    check (claimed_at is null or claimed_at >= issued_at),
  constraint recovery_codes_claim_identity_consistent check (
    (
      claimed_at is null
      and claimed_by_auth_user_id is null
      and claimant_redacted_at is null
    )
    or (
      claimed_at is not null
      and (
        (
          claimed_by_auth_user_id is not null
          and claimant_redacted_at is null
        )
        or (
          claimed_by_auth_user_id is null
          and claimant_redacted_at is not null
          and claimant_redacted_at >= claimed_at
        )
      )
    )
  ),
  constraint recovery_codes_terminal_state check (
    not (revoked_at is not null and claimed_at is not null)
  )
);

create unique index recovery_codes_one_active_per_user_idx
  on private.recovery_codes(user_id)
  where revoked_at is null and claimed_at is null;

create index recovery_codes_user_issued_idx
  on private.recovery_codes(user_id, issued_at desc);

create index recovery_codes_claimed_by_idx
  on private.recovery_codes(claimed_by_auth_user_id)
  where claimed_by_auth_user_id is not null;

create or replace function private.redact_recovery_claimant_before_auth_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.recovery_codes
  set claimed_by_auth_user_id = null,
      claimant_redacted_at = greatest(now(), claimed_at)
  where claimed_by_auth_user_id = old.id;

  return old;
end;
$$;

create trigger before_auth_user_delete_redact_recovery_claimant
before delete on auth.users
for each row execute function private.redact_recovery_claimant_before_auth_delete();

-- Counts failed claims even when the supplied code does not match a row.
-- The Route Handler must additionally enforce an IP-level limit without
-- persisting raw IP addresses in product tables.
create table private.recovery_claim_limits (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null default now(),
  failed_attempts smallint not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

create or replace function private.jsonb_has_forbidden_location_key(payload jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  with recursive values_to_check(value) as (
    select payload
    union all
    select child.value
    from values_to_check as parent
    cross join lateral (
      select object_child.value
      from jsonb_each(
        case
          when jsonb_typeof(parent.value) = 'object' then parent.value
          else '{}'::jsonb
        end
      ) as object_child
      union all
      select array_child.value
      from jsonb_array_elements(
        case
          when jsonb_typeof(parent.value) = 'array' then parent.value
          else '[]'::jsonb
        end
      ) as array_child
    ) as child
  )
  select exists (
    select 1
    from values_to_check as candidate
    cross join lateral jsonb_object_keys(
      case
        when jsonb_typeof(candidate.value) = 'object' then candidate.value
        else '{}'::jsonb
      end
    ) as object_key
    where lower(object_key) in (
      'lat',
      'lng',
      'lon',
      'long',
      'latitude',
      'longitude',
      'accuracy',
      'precision',
      'coordinate',
      'coordinates',
      'position',
      'location',
      'geolocation'
    )
  )
$$;

create table analytics.events (
  id bigint generated always as identity primary key,
  client_event_id uuid,
  user_id uuid not null references public.app_users(id) on delete cascade,
  event_name analytics.event_name not null,
  source analytics.event_source not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  spot_id uuid references public.spots(id) on delete set null,
  properties jsonb not null default '{}'::jsonb,
  constraint analytics_events_properties_object
    check (jsonb_typeof(properties) = 'object'),
  constraint analytics_events_properties_size
    check (octet_length(properties::text) <= 2048),
  constraint analytics_events_client_id_required check (
    source = 'server' or client_event_id is not null
  ),
  constraint analytics_events_server_facts check (
    event_name not in (
      'acquire_success',
      'personal_card_created',
      'share_created'
    )
    or source = 'server'
  ),
  constraint analytics_events_no_location_keys
    check (not private.jsonb_has_forbidden_location_key(properties))
);

create unique index analytics_events_client_idempotency_idx
  on analytics.events(user_id, client_event_id)
  where client_event_id is not null;

create index analytics_events_name_received_idx
  on analytics.events(event_name, received_at desc);

create index analytics_events_user_received_idx
  on analytics.events(user_id, received_at desc);

create index analytics_events_spot_received_idx
  on analytics.events(spot_id, received_at desc)
  where spot_id is not null;

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger app_users_set_updated_at
before update on public.app_users
for each row execute function private.set_updated_at();

create trigger spots_set_updated_at
before update on public.spots
for each row execute function private.set_updated_at();

create trigger cards_set_updated_at
before update on public.cards
for each row execute function private.set_updated_at();

create trigger personal_cards_set_updated_at
before update on public.personal_cards
for each row execute function private.set_updated_at();

create trigger recovery_claim_limits_set_updated_at
before update on private.recovery_claim_limits
for each row execute function private.set_updated_at();

create or replace function private.handle_auth_user_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_app_user_id uuid;
begin
  insert into public.app_users default values
  returning id into new_app_user_id;

  insert into private.user_identities (auth_user_id, user_id)
  values (new.id, new_app_user_id);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_danyeodam on auth.users;
create trigger on_auth_user_created_danyeodam
after insert on auth.users
for each row execute function private.handle_auth_user_created();

create or replace function private.current_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select identity_row.user_id
  from private.user_identities as identity_row
  where identity_row.auth_user_id = (select auth.uid())
    and identity_row.revoked_at is null
  limit 1
$$;

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from private.admin_members as admin_row
      where admin_row.auth_user_id = (select auth.uid())
        and admin_row.revoked_at is null
    )
$$;

create or replace function private.has_participant_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.participant_access as access_row
    where access_row.user_id = (select private.current_user_id())
      and access_row.revoked_at is null
      and (access_row.expires_at is null or access_row.expires_at > now())
  )
$$;

revoke all on function private.set_updated_at() from public, anon, authenticated, service_role;
revoke all on function private.handle_auth_user_created() from public, anon, authenticated, service_role;
revoke all on function private.enforce_retro_grant_target()
  from public, anon, authenticated, service_role;
revoke all on function private.ensure_retro_acquisition_has_grant()
  from public, anon, authenticated, service_role;
revoke all on function private.ensure_retro_grant_removal_safe()
  from public, anon, authenticated, service_role;
revoke all on function private.redact_recovery_claimant_before_auth_delete()
  from public, anon, authenticated, service_role;
revoke all on function private.jsonb_has_forbidden_location_key(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.current_user_id() from public, anon, authenticated, service_role;
revoke all on function private.is_admin() from public, anon, authenticated, service_role;
revoke all on function private.has_participant_access() from public, anon, authenticated, service_role;

grant execute on function private.current_user_id() to authenticated;
grant execute on function private.is_admin() to authenticated;
grant execute on function private.has_participant_access() to authenticated;
grant execute on function private.jsonb_has_forbidden_location_key(jsonb) to service_role;

-- Defense in depth on every application table, including non-exposed schemas.
alter table public.app_users enable row level security;
alter table public.app_users force row level security;
alter table public.spots enable row level security;
alter table public.spots force row level security;
alter table public.cards enable row level security;
alter table public.cards force row level security;
alter table public.acquisitions enable row level security;
alter table public.acquisitions force row level security;
alter table public.personal_cards enable row level security;
alter table public.personal_cards force row level security;
alter table public.physical_requests enable row level security;
alter table public.physical_requests force row level security;
alter table private.user_identities enable row level security;
alter table private.user_identities force row level security;
alter table private.admin_members enable row level security;
alter table private.admin_members force row level security;
alter table private.participant_access enable row level security;
alter table private.participant_access force row level security;
alter table private.card_counters enable row level security;
alter table private.card_counters force row level security;
alter table private.retro_grants enable row level security;
alter table private.retro_grants force row level security;
alter table private.recovery_codes enable row level security;
alter table private.recovery_codes force row level security;
alter table private.recovery_claim_limits enable row level security;
alter table private.recovery_claim_limits force row level security;
alter table analytics.events enable row level security;
alter table analytics.events force row level security;

create policy app_users_select_own
on public.app_users
for select
to authenticated
using (id = (select private.current_user_id()));

create policy spots_select_public
on public.spots
for select
to anon, authenticated
using (status in ('teaser', 'open'));

create policy cards_select_public
on public.cards
for select
to anon, authenticated
using (
  is_published
  and exists (
    select 1
    from public.spots as spot_row
    where spot_row.id = cards.spot_id
      and spot_row.status = 'open'
  )
);

create policy acquisitions_select_own
on public.acquisitions
for select
to authenticated
using (user_id = (select private.current_user_id()));

create policy personal_cards_select_own
on public.personal_cards
for select
to authenticated
using (user_id = (select private.current_user_id()));

create policy physical_requests_select_own
on public.physical_requests
for select
to authenticated
using (user_id = (select private.current_user_id()));

-- New Supabase projects no longer auto-expose tables. Keep all grants explicit.
-- Stage 0 reads and writes use the documented /api surface so internal columns
-- such as field_sequence and exact decision parameters cannot leak via Data API.
revoke all on table public.app_users from anon, authenticated;
revoke all on table public.spots from anon, authenticated;
revoke all on table public.cards from anon, authenticated;
revoke all on table public.acquisitions from anon, authenticated;
revoke all on table public.personal_cards from anon, authenticated;
revoke all on table public.physical_requests from anon, authenticated;

-- No direct browser writes are granted. Next.js Route Handlers are the only
-- Stage 0 mutation surface. The acquire mutation function is intentionally
-- deferred to Task 2 so the location-verification boundary can be approved.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'personal-cards',
  'personal-cards',
  false,
  10485760,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
