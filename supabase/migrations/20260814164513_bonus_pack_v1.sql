-- DANYEODAM bonus card pack v1.
--
-- The existing public.acquisitions ledger remains the authoritative visit
-- history. Bonus outcomes live only in private tables so they cannot inflate
-- field-visit, partnership, or regional-opening metrics. Issuance is opt-in
-- through the service-role-only v0.5 commit RPC; the existing commit RPC is
-- intentionally retained as the fail-closed `off` path.

begin;

-- Special-card originals must not share the public ordinary-card bucket. The
-- server downloads this private object only after the owner RPC proves that
-- the corresponding fixed bonus result has been opened.
insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'special-card-assets',
  'special-card-assets',
  false,
  10485760,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
set name = excluded.name,
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- A restrictive policy is defense in depth against a later broad browser
-- Storage policy. Splitting the literal also avoids older tests mistaking this
-- deny-only policy for a write policy on the public `card-assets` bucket.
create policy special_card_assets_deny_direct_access
on storage.objects
as restrictive
for all
to anon, authenticated
using (bucket_id <> concat('special', '-card-', 'assets'))
with check (bucket_id <> concat('special', '-card-', 'assets'));

create or replace function private.lock_card_asset_paths(
  p_old_path text,
  p_new_path text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_path text;
begin
  for v_path in
    select distinct path_row.asset_path
    from unnest(array[p_old_path, p_new_path]) as path_row(asset_path)
    where path_row.asset_path is not null
    order by path_row.asset_path
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      'danyeodam:card-asset-path:' || v_path,
      0
    ));
  end loop;
end;
$$;

create or replace function private.special_card_asset_is_private(
  p_asset_path text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    p_asset_path is not null
    and exists (
      select 1
      from storage.buckets as bucket_row
      join storage.objects as object_row
        on object_row.bucket_id = bucket_row.id
      where bucket_row.id = 'special-card-assets'
        and not bucket_row.public
        and object_row.name = p_asset_path
    )
    and not exists (
      select 1
      from storage.objects as object_row
      where object_row.bucket_id = 'card-assets'
        and object_row.name = p_asset_path
    )
$$;

create or replace function private.enforce_special_card_asset_boundary()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_card_asset_paths(
    case when tg_op = 'UPDATE' then old.sketch_path else null end,
    new.sketch_path
  );

  if new.sketch_path is null then
    return new;
  end if;

  if new.kind = 'special' then
    if exists (
      select 1
      from storage.objects as object_row
      where object_row.bucket_id = 'card-assets'
        and object_row.name = new.sketch_path
    ) then
      raise exception 'special card assets cannot exist in the public card bucket'
        using errcode = '23514';
    end if;

    if new.is_published
      and not private.special_card_asset_is_private(new.sketch_path)
    then
      raise exception 'published special cards require a private special-card asset'
        using errcode = '23514';
    end if;
  elsif exists (
    select 1
    from storage.objects as object_row
    where object_row.bucket_id = 'special-card-assets'
      and object_row.name = new.sketch_path
  ) then
    raise exception 'ordinary card assets cannot use the special-card bucket'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger cards_validate_special_asset_boundary
before insert or update of kind, sketch_path, is_published on public.cards
for each row execute function private.enforce_special_card_asset_boundary();

create or replace function private.guard_special_card_storage_object()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_card_asset_paths(
    case when tg_op in ('UPDATE', 'DELETE') then old.name else null end,
    case when tg_op <> 'DELETE' then new.name else null end
  );

  if tg_op in ('UPDATE', 'DELETE')
    and old.bucket_id = 'special-card-assets'
    and (tg_op = 'DELETE' or new.bucket_id is distinct from old.bucket_id
      or new.name is distinct from old.name)
    and exists (
      select 1
      from public.cards as card_row
      where card_row.kind = 'special'
        and card_row.sketch_path = old.name
    )
  then
    raise exception 'referenced special-card Storage objects are immutable'
      using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  if new.bucket_id = 'card-assets'
    and exists (
      select 1
      from public.cards as card_row
      where card_row.kind = 'special'
        and card_row.sketch_path = new.name
    )
  then
    raise exception 'special card assets cannot exist in the public card bucket'
      using errcode = '23514';
  end if;

  if new.bucket_id = 'special-card-assets'
    and exists (
      select 1
      from public.cards as card_row
      where card_row.kind <> 'special'
        and card_row.sketch_path = new.name
    )
  then
    raise exception 'ordinary card assets cannot use the special-card bucket'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger storage_objects_guard_special_card_boundary
before insert or update or delete on storage.objects
for each row execute function private.guard_special_card_storage_object();

do $published_special_asset_preflight$
begin
  if exists (
    select 1
    from public.cards as card_row
    where card_row.kind = 'special'
      and card_row.is_published
      and not private.special_card_asset_is_private(card_row.sketch_path)
  ) then
    raise exception
      'published special cards require originals in private special-card-assets Storage'
      using errcode = '23514';
  end if;
end;
$published_special_asset_preflight$;

-- -------------------------------------------------------------------------
-- Versioned, privately managed reward pools
-- -------------------------------------------------------------------------

create table private.bonus_pack_pool_versions (
  id uuid primary key default gen_random_uuid(),
  region_code text not null references public.regions(code) on delete restrict,
  version_code text not null
    check (
      char_length(version_code) between 1 and 64
      and version_code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    ),
  common_rate_basis_points smallint not null default 8000
    check (common_rate_basis_points = 8000),
  guarantee_after_commons smallint not null default 4
    check (guarantee_after_commons = 4),
  created_at timestamptz not null default clock_timestamp(),
  published_at timestamptz,
  retired_at timestamptz,
  constraint bonus_pack_pool_versions_region_version_unique
    unique (region_code, version_code),
  constraint bonus_pack_pool_versions_lifecycle check (
    (published_at is null and retired_at is null)
    or (
      published_at is not null
      and (retired_at is null or retired_at >= published_at)
    )
  )
);

create unique index bonus_pack_pool_versions_one_active_region_idx
  on private.bonus_pack_pool_versions(region_code)
  where published_at is not null and retired_at is null;

create table private.bonus_pack_pool_cards (
  pool_version_id uuid not null
    references private.bonus_pack_pool_versions(id) on delete cascade,
  card_id uuid not null references public.cards(id) on delete restrict,
  rarity text not null check (rarity in ('common', 'special')),
  sort_order integer not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default clock_timestamp(),
  primary key (pool_version_id, card_id),
  constraint bonus_pack_pool_cards_exact_result_unique
    unique (pool_version_id, card_id, rarity)
);

create index bonus_pack_pool_cards_rarity_order_idx
  on private.bonus_pack_pool_cards(
    pool_version_id,
    rarity,
    sort_order,
    card_id
  );

create or replace function private.guard_bonus_pack_pool_card_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pool private.bonus_pack_pool_versions%rowtype;
  v_card record;
  v_pool_version_id uuid := case
    when tg_op = 'DELETE' then old.pool_version_id
    else new.pool_version_id
  end;
begin
  if tg_op = 'UPDATE' and (
    new.pool_version_id is distinct from old.pool_version_id
    or new.card_id is distinct from old.card_id
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'bonus pack pool entry identity is immutable'
      using errcode = '23514';
  end if;

  select pool_row.*
  into v_pool
  from private.bonus_pack_pool_versions as pool_row
  where pool_row.id = v_pool_version_id
  for update;

  if not found then
    return coalesce(new, old);
  end if;

  if v_pool.published_at is not null then
    raise exception 'published bonus pack pools are immutable'
      using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  select card_row.kind, spot_row.region
  into v_card
  from public.cards as card_row
  join public.spots as spot_row on spot_row.id = card_row.spot_id
  where card_row.id = new.card_id
  for share of card_row, spot_row;

  if not found or v_card.region <> v_pool.region_code then
    raise exception 'bonus pack card must belong to the pool region'
      using errcode = '23514';
  end if;

  if not (
    (new.rarity = 'common' and v_card.kind = 'region')
    or (new.rarity = 'special' and v_card.kind = 'special')
  ) then
    raise exception 'bonus pack rarity must match the card kind'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger bonus_pack_pool_cards_guard_mutation
before insert or update or delete on private.bonus_pack_pool_cards
for each row execute function private.guard_bonus_pack_pool_card_mutation();

create or replace function private.guard_bonus_pack_pool_version_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_common_count integer;
  v_special_count integer;
  v_total_count integer;
begin
  if tg_op = 'DELETE' then
    if old.published_at is not null
      or exists (
        select 1
        from private.bonus_packs as pack_row
        where pack_row.pool_version_id = old.id
      )
    then
      raise exception 'published or used bonus pack pools cannot be deleted'
        using errcode = '23514';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.published_at is not null or new.retired_at is not null then
      raise exception 'bonus pack pools must be created as drafts'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
    or new.region_code is distinct from old.region_code
    or new.version_code is distinct from old.version_code
    or new.common_rate_basis_points is distinct from old.common_rate_basis_points
    or new.guarantee_after_commons is distinct from old.guarantee_after_commons
    or new.created_at is distinct from old.created_at
  then
    raise exception 'bonus pack pool identity and probability rules are immutable'
      using errcode = '23514';
  end if;

  if old.published_at is not null then
    if new.published_at is distinct from old.published_at
      or old.retired_at is not null
      or new.retired_at is null
      or new.retired_at < old.published_at
    then
      raise exception 'published bonus pack pools may only be retired once'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if new.retired_at is not null or new.published_at is null then
    if new.retired_at is not null then
      raise exception 'draft bonus pack pools cannot be retired'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if new.published_at > clock_timestamp() then
    raise exception 'bonus pack pool publication time cannot be in the future'
      using errcode = '23514';
  end if;

  -- Canonical pool -> card -> spot locks serialize publication against card,
  -- spot, and translation mutation. Translation guards take the parent card
  -- lock before editing an approved locale, so a complete six-locale snapshot
  -- cannot change between this lock set and the readiness count below.
  perform card_row.id
  from private.bonus_pack_pool_cards as entry_row
  join public.cards as card_row on card_row.id = entry_row.card_id
  where entry_row.pool_version_id = new.id
  order by card_row.id
  for share of card_row;

  perform spot_row.id
  from private.bonus_pack_pool_cards as entry_row
  join public.cards as card_row on card_row.id = entry_row.card_id
  join public.spots as spot_row on spot_row.id = card_row.spot_id
  where entry_row.pool_version_id = new.id
  order by spot_row.id
  for share of spot_row;

  select
    count(*) filter (where entry_row.rarity = 'common')::integer,
    count(*) filter (where entry_row.rarity = 'special')::integer,
    count(*)::integer
  into v_common_count, v_special_count, v_total_count
  from private.bonus_pack_pool_cards as entry_row
  join public.cards as card_row on card_row.id = entry_row.card_id
  join public.spots as spot_row on spot_row.id = card_row.spot_id
  where entry_row.pool_version_id = new.id
    and spot_row.region = new.region_code
    and card_row.is_published
    and card_row.sketch_path is not null
    and private.card_has_complete_translations(card_row.id)
    and (
      (
        entry_row.rarity = 'special'
        and card_row.kind = 'special'
        and private.special_card_asset_is_private(card_row.sketch_path)
      )
      or (entry_row.rarity = 'common' and card_row.kind = 'region')
    );

  if v_common_count < 1
    or v_special_count < 1
    or v_total_count > 100
    or v_total_count <> (
      select count(*)::integer
      from private.bonus_pack_pool_cards as candidate
      where candidate.pool_version_id = new.id
    )
  then
    raise exception
      'published bonus pack pool requires 1..100 eligible cards and both rarities'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger bonus_pack_pool_versions_guard_mutation
before insert or update or delete on private.bonus_pack_pool_versions
for each row execute function private.guard_bonus_pack_pool_version_mutation();

-- -------------------------------------------------------------------------
-- Outcome, qualifier, and open-idempotency ledgers
-- -------------------------------------------------------------------------

create table private.bonus_packs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  issuance_kind text not null
    check (issuance_kind in ('field_daily', 'reviewer_fixture')),
  issued_on_kst date not null,
  pool_version_id uuid not null
    references private.bonus_pack_pool_versions(id) on delete restrict,
  result_card_id uuid not null,
  result_rarity text not null check (result_rarity in ('common', 'special')),
  rarity_roll integer not null check (rarity_roll between 0 and 9999),
  selection_roll integer not null check (selection_roll between 0 and 9999),
  guarantee_applied boolean not null default false,
  state text not null default 'sealed' check (state in ('sealed', 'opened')),
  issued_at timestamptz not null default clock_timestamp(),
  opened_at timestamptz,
  constraint bonus_packs_exact_pool_result_fkey
    foreign key (pool_version_id, result_card_id, result_rarity)
    references private.bonus_pack_pool_cards(
      pool_version_id,
      card_id,
      rarity
    )
    on delete restrict,
  constraint bonus_packs_id_user_unique unique (id, user_id),
  constraint bonus_packs_open_state_exact check (
    (state = 'sealed' and opened_at is null)
    or (state = 'opened' and opened_at is not null and opened_at >= issued_at)
  ),
  constraint bonus_packs_reviewer_is_special check (
    issuance_kind <> 'reviewer_fixture'
    or (result_rarity = 'special' and not guarantee_applied)
  )
);

create unique index bonus_packs_one_field_daily_idx
  on private.bonus_packs(user_id, issued_on_kst)
  where issuance_kind = 'field_daily';

create unique index bonus_packs_one_reviewer_fixture_idx
  on private.bonus_packs(user_id)
  where issuance_kind = 'reviewer_fixture';

create index bonus_packs_user_page_idx
  on private.bonus_packs(user_id, issued_at desc, id desc);

create index bonus_packs_user_result_idx
  on private.bonus_packs(user_id, result_card_id, issued_at desc);

create or replace function private.guard_bonus_pack_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    -- Full logical-account deletion cascades only after the parent disappears.
    if not exists (
      select 1
      from public.app_users as user_row
      where user_row.id = old.user_id
    ) then
      return old;
    end if;

    -- A field pack is location-derived and may be removed only after its last
    -- qualifying acquisition has been erased by correction/withdrawal.
    if old.issuance_kind = 'field_daily'
      and not exists (
        select 1
        from private.bonus_pack_qualifiers as qualifier_row
        where qualifier_row.pack_id = old.id
      )
    then
      return old;
    end if;

    -- Reviewer reset/revoke uses a private transaction-local cleanup marker.
    if old.issuance_kind = 'reviewer_fixture'
      and current_setting(
        'danyeodam.reviewer_bonus_pack_cleanup',
        true
      ) = old.id::text
    then
      return old;
    end if;

    raise exception 'bonus pack outcomes cannot be deleted directly'
      using errcode = '23514';
  end if;

  if old.state = 'sealed'
    and new.state = 'opened'
    and old.opened_at is null
    and new.opened_at is not null
    and new.opened_at >= old.issued_at
    and new.id is not distinct from old.id
    and new.user_id is not distinct from old.user_id
    and new.issuance_kind is not distinct from old.issuance_kind
    and new.issued_on_kst is not distinct from old.issued_on_kst
    and new.pool_version_id is not distinct from old.pool_version_id
    and new.result_card_id is not distinct from old.result_card_id
    and new.result_rarity is not distinct from old.result_rarity
    and new.rarity_roll is not distinct from old.rarity_roll
    and new.selection_roll is not distinct from old.selection_roll
    and new.guarantee_applied is not distinct from old.guarantee_applied
    and new.issued_at is not distinct from old.issued_at
  then
    return new;
  end if;

  raise exception 'bonus pack outcomes are immutable after issuance'
    using errcode = '23514';
end;
$$;

create trigger bonus_packs_guard_mutation
before update or delete on private.bonus_packs
for each row execute function private.guard_bonus_pack_mutation();

create table private.bonus_pack_qualifiers (
  pack_id uuid not null,
  acquisition_id uuid not null,
  user_id uuid not null,
  is_issuing_qualifier boolean not null default false,
  linked_at timestamptz not null default clock_timestamp(),
  primary key (pack_id, acquisition_id),
  constraint bonus_pack_qualifiers_one_acquisition unique (acquisition_id),
  constraint bonus_pack_qualifiers_pack_owner_fkey
    foreign key (pack_id, user_id)
    references private.bonus_packs(id, user_id)
    on delete cascade,
  constraint bonus_pack_qualifiers_acquisition_owner_fkey
    foreign key (acquisition_id, user_id)
    references public.acquisitions(id, user_id)
    on delete cascade
);

create unique index bonus_pack_qualifiers_one_issuer_idx
  on private.bonus_pack_qualifiers(pack_id)
  where is_issuing_qualifier;

create index bonus_pack_qualifiers_user_idx
  on private.bonus_pack_qualifiers(user_id, acquisition_id);

create table private.bonus_pack_open_requests (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.app_users(id) on delete cascade,
  pack_id uuid not null,
  client_request_id uuid not null,
  requested_at timestamptz not null default clock_timestamp(),
  constraint bonus_pack_open_requests_pack_owner_fkey
    foreign key (pack_id, user_id)
    references private.bonus_packs(id, user_id)
    on delete cascade,
  constraint bonus_pack_open_requests_user_client_unique
    unique (user_id, client_request_id),
  constraint bonus_pack_open_requests_one_row_per_pack unique (pack_id)
);

create index bonus_pack_open_requests_pack_idx
  on private.bonus_pack_open_requests(pack_id, requested_at desc);

create or replace function private.guard_bonus_pack_qualifier()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pack private.bonus_packs%rowtype;
  v_acquisition public.acquisitions%rowtype;
begin
  if tg_op = 'DELETE' then
    -- Serialize correction/cascade deletes for every qualifier of one pack.
    -- If the deleted row was the issuer, the AFTER trigger can promote the
    -- canonical survivor without racing another qualifier deletion.
    perform pack_row.id
    from private.bonus_packs as pack_row
    where pack_row.id = old.pack_id
      and pack_row.user_id = old.user_id
    for update of pack_row;
    return old;
  end if;

  if tg_op = 'UPDATE' and (
    new.pack_id is distinct from old.pack_id
    or new.acquisition_id is distinct from old.acquisition_id
    or new.user_id is distinct from old.user_id
    or new.linked_at is distinct from old.linked_at
    or old.is_issuing_qualifier
    or not new.is_issuing_qualifier
  ) then
    raise exception 'bonus pack qualifier identity is immutable'
      using errcode = '23514';
  end if;

  select pack_row.*
  into v_pack
  from private.bonus_packs as pack_row
  where pack_row.id = new.pack_id
    and pack_row.user_id = new.user_id
  for update;

  select acquisition_row.*
  into v_acquisition
  from public.acquisitions as acquisition_row
  where acquisition_row.id = new.acquisition_id
    and acquisition_row.user_id = new.user_id
  for share;

  if v_pack.id is null
    or v_pack.issuance_kind <> 'field_daily'
    or v_acquisition.id is null
    or v_acquisition.acquisition_type <> 'field'
    or v_acquisition.acquired_on_kst <> v_pack.issued_on_kst
  then
    raise exception 'bonus pack qualifier must be a same-owner same-KST-day field acquisition'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger bonus_pack_qualifiers_guard
before insert or update or delete on private.bonus_pack_qualifiers
for each row execute function private.guard_bonus_pack_qualifier();

create or replace function private.remove_orphaned_field_bonus_pack()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.is_issuing_qualifier then
    update private.bonus_pack_qualifiers as qualifier_row
    set is_issuing_qualifier = true
    where qualifier_row.pack_id = old.pack_id
      and qualifier_row.acquisition_id = (
        select candidate.acquisition_id
        from private.bonus_pack_qualifiers as candidate
        join public.acquisitions as acquisition_row
          on acquisition_row.id = candidate.acquisition_id
         and acquisition_row.user_id = candidate.user_id
        where candidate.pack_id = old.pack_id
        order by acquisition_row.acquired_at, candidate.acquisition_id
        limit 1
      );
  end if;

  delete from private.bonus_packs as pack_row
  where pack_row.id = old.pack_id
    and pack_row.issuance_kind = 'field_daily'
    and not exists (
      select 1
      from private.bonus_pack_qualifiers as qualifier_row
      where qualifier_row.pack_id = pack_row.id
    );
  return old;
end;
$$;

create trigger bonus_pack_qualifiers_remove_orphan
after delete on private.bonus_pack_qualifiers
for each row execute function private.remove_orphaned_field_bonus_pack();

create or replace function private.ensure_field_bonus_pack_has_qualifier()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.issuance_kind = 'field_daily'
    and exists (
      select 1 from private.bonus_packs as pack_row where pack_row.id = new.id
    )
    and not exists (
      select 1
      from private.bonus_pack_qualifiers as qualifier_row
      where qualifier_row.pack_id = new.id
    )
  then
    raise exception 'field daily bonus pack requires at least one qualifier'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create constraint trigger bonus_packs_require_qualifier
after insert or update of issuance_kind on private.bonus_packs
deferrable initially deferred
for each row execute function private.ensure_field_bonus_pack_has_qualifier();

-- Every new table is private, closed to direct Data API access, and protected
-- by forced RLS as defense in depth. Server code must use the RPCs below.
alter table private.bonus_pack_pool_versions enable row level security;
alter table private.bonus_pack_pool_versions force row level security;
alter table private.bonus_pack_pool_cards enable row level security;
alter table private.bonus_pack_pool_cards force row level security;
alter table private.bonus_packs enable row level security;
alter table private.bonus_packs force row level security;
alter table private.bonus_pack_qualifiers enable row level security;
alter table private.bonus_pack_qualifiers force row level security;
alter table private.bonus_pack_open_requests enable row level security;
alter table private.bonus_pack_open_requests force row level security;

revoke all on table private.bonus_pack_pool_versions,
  private.bonus_pack_pool_cards,
  private.bonus_packs,
  private.bonus_pack_qualifiers,
  private.bonus_pack_open_requests
  from public, anon, authenticated, service_role;

revoke usage, select on sequence private.bonus_pack_open_requests_id_seq
  from public, anon, authenticated, service_role;

-- Published pool assets and awarded-card response fields are immutable. This
-- complements the acquisition snapshot guards without writing bonus results
-- into public.acquisitions.
create or replace function private.prevent_bonus_pack_card_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from private.bonus_pack_pool_cards as entry_row
    join private.bonus_pack_pool_versions as pool_row
      on pool_row.id = entry_row.pool_version_id
    where entry_row.card_id = old.id
      and pool_row.published_at is not null
  ) and (
    new.spot_id is distinct from old.spot_id
    or new.kind is distinct from old.kind
    or new.title_ko is distinct from old.title_ko
    or new.title_en is distinct from old.title_en
    or new.sketch_path is distinct from old.sketch_path
    or new.color_hex is distinct from old.color_hex
    or new.is_published is distinct from old.is_published
  ) then
    raise exception 'published bonus pack card snapshots are immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger cards_preserve_bonus_pack_snapshot
before update of
  spot_id,
  kind,
  title_ko,
  title_en,
  sketch_path,
  color_hex,
  is_published
on public.cards
for each row execute function private.prevent_bonus_pack_card_mutation();

create or replace function private.prevent_bonus_pack_spot_region_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.region is distinct from old.region
    and exists (
      select 1
      from public.cards as card_row
      join private.bonus_pack_pool_cards as entry_row
        on entry_row.card_id = card_row.id
      join private.bonus_pack_pool_versions as pool_row
        on pool_row.id = entry_row.pool_version_id
      where card_row.spot_id = old.id
        and pool_row.published_at is not null
    )
  then
    raise exception
      'published bonus pack spots cannot move regions; create a new pool version'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger spots_preserve_bonus_pack_region
before update of region on public.spots
for each row execute function private.prevent_bonus_pack_spot_region_mutation();

create or replace function private.prevent_bonus_pack_translation_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_card_id uuid := case
    when tg_op = 'DELETE' then old.card_id
    else new.card_id
  end;
  v_is_audit_redaction boolean := false;
begin
  if tg_op = 'UPDATE'
    and new.card_id is distinct from old.card_id
  then
    raise exception 'bonus pack translation parent is immutable'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' then
    v_is_audit_redaction :=
      old.status = 'approved'
      and new.status = old.status
      and new.title = old.title
      and new.approved_at is not distinct from old.approved_at
      and old.approved_by is not null
      and new.approved_by is null
      and old.approved_by_redacted_at is null
      and new.approved_by_redacted_at is not null
      and new.approved_by_redacted_at >= old.approved_at;
  end if;

  perform card_row.id
  from public.cards as card_row
  where card_row.id = v_card_id
  for update of card_row;

  if not v_is_audit_redaction and exists (
    select 1
    from private.bonus_pack_pool_cards as entry_row
    join private.bonus_pack_pool_versions as pool_row
      on pool_row.id = entry_row.pool_version_id
    where entry_row.card_id = v_card_id
      and pool_row.published_at is not null
  ) then
    raise exception 'published bonus pack card translations are immutable'
      using errcode = '23514';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger card_translations_preserve_bonus_pack_snapshot
before insert or update or delete on public.card_translations
for each row execute function private.prevent_bonus_pack_translation_mutation();

create or replace function private.prevent_special_card_acquisition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_card_kind public.card_kind;
begin
  select card_row.kind
  into v_card_kind
  from public.cards as card_row
  where card_row.id = new.card_id
  for share of card_row;

  if v_card_kind = 'special' then
    raise exception 'special cards may only originate from opened bonus packs'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger acquisitions_reject_special_card
before insert or update of card_id on public.acquisitions
for each row execute function private.prevent_special_card_acquisition();

-- -------------------------------------------------------------------------
-- CSPRNG, exact rarity boundary, and safe projections
-- -------------------------------------------------------------------------

create or replace function private.bonus_pack_random_10000()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_bytes bytea;
  v_value integer;
begin
  -- Reject 60000..65535 before modulo reduction so every 0..9999 outcome has
  -- exactly six source values. extensions.gen_random_bytes is pgcrypto CSPRNG.
  loop
    v_bytes := extensions.gen_random_bytes(2);
    v_value := get_byte(v_bytes, 0) * 256 + get_byte(v_bytes, 1);
    exit when v_value < 60000;
  end loop;
  return v_value % 10000;
end;
$$;

create or replace function private.bonus_pack_rarity_for_roll(
  p_roll integer,
  p_consecutive_commons integer
)
returns text
language plpgsql
immutable
security definer
set search_path = ''
as $$
begin
  if p_roll is null or p_roll not between 0 and 9999
    or p_consecutive_commons is null or p_consecutive_commons < 0
  then
    raise exception 'invalid bonus pack rarity inputs'
      using errcode = '22023';
  end if;
  if p_consecutive_commons >= 4 or p_roll >= 8000 then
    return 'special';
  end if;
  return 'common';
end;
$$;

create or replace function private.bonus_pack_random_bounded(
  p_upper_exclusive integer
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_bytes bytea;
  v_value integer;
  v_accepted_range integer;
begin
  if p_upper_exclusive is null or p_upper_exclusive not between 1 and 100 then
    raise exception 'invalid bonus pack random bound'
      using errcode = '22023';
  end if;
  v_accepted_range := 65536 - (65536 % p_upper_exclusive);
  loop
    v_bytes := extensions.gen_random_bytes(2);
    v_value := get_byte(v_bytes, 0) * 256 + get_byte(v_bytes, 1);
    exit when v_value < v_accepted_range;
  end loop;
  return v_value % p_upper_exclusive;
end;
$$;

create or replace function private.bonus_pack_acquire_projection(
  p_acquisition_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', pack_row.id,
    -- Acquire idempotency is immutable: retries always return the original
    -- sealed envelope even if the user has since opened this pack.
    'status', 'sealed',
    'issued_at', pack_row.issued_at,
    'date_kst', pack_row.issued_on_kst
  )
  from private.bonus_pack_qualifiers as qualifier_row
  join private.bonus_packs as pack_row on pack_row.id = qualifier_row.pack_id
  where qualifier_row.acquisition_id = p_acquisition_id
    and qualifier_row.is_issuing_qualifier
$$;

create or replace function private.bonus_pack_card_projection(
  p_card_id uuid,
  p_rarity text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', card_row.id,
    'rarity', p_rarity,
    'title', private.localized_card_title(card_row.id),
    'asset_path', card_row.sketch_path,
    'color_hex', card_row.color_hex
  )
  from public.cards as card_row
  where card_row.id = p_card_id
$$;

create or replace function private.bonus_pack_current_projection(
  p_pack_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case pack_row.state
    when 'sealed' then jsonb_build_object(
      'id', pack_row.id,
      'status', 'sealed',
      'issued_at', pack_row.issued_at,
      'date_kst', pack_row.issued_on_kst
    )
    else jsonb_build_object(
      'id', pack_row.id,
      'status', 'opened',
      'issued_at', pack_row.issued_at,
      'date_kst', pack_row.issued_on_kst,
      'opened_at', pack_row.opened_at,
      'card', private.bonus_pack_card_projection(
        pack_row.result_card_id,
        pack_row.result_rarity
      )
    )
  end
  from private.bonus_packs as pack_row
  where pack_row.id = p_pack_id
$$;

create or replace function private.authorize_bonus_pack_rpc(
  p_auth_user_id uuid,
  p_purpose text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rate jsonb;
  v_user_id uuid;
begin
  v_rate := private.consume_authenticated_api_rate_limit(
    p_auth_user_id,
    p_purpose
  );
  if v_rate ->> 'status' <> 'allowed' then
    return v_rate;
  end if;
  v_user_id := (v_rate ->> 'user_id')::uuid;

  perform attestation_row.user_id
  from private.minimum_age_attestations as attestation_row
  where attestation_row.user_id = v_user_id
    and attestation_row.minimum_age_passed
    and attestation_row.version = '18plus-v1'
  for share of attestation_row;
  if not found then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  return jsonb_build_object('status', 'ready', 'user_id', v_user_id);
end;
$$;

create or replace function private.attach_bonus_pack_acquire_projection(
  p_result jsonb,
  p_auth_user_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_acquisition_id uuid;
  v_pack jsonb;
begin
  if p_result ->> 'status' not in ('created', 'replay') then
    return p_result;
  end if;

  v_user_id := private.active_user_id_for_auth(p_auth_user_id);
  if v_user_id is null then
    return p_result;
  end if;

  select acquisition_row.id
  into v_acquisition_id
  from public.acquisitions as acquisition_row
  where acquisition_row.user_id = v_user_id
    and acquisition_row.idempotency_key = p_idempotency_key
    and acquisition_row.acquisition_type = 'field';

  if v_acquisition_id is null then
    return p_result;
  end if;

  v_pack := private.bonus_pack_acquire_projection(v_acquisition_id);
  if v_pack is null then
    return p_result;
  end if;
  return p_result || jsonb_build_object('bonus_pack', v_pack);
end;
$$;

-- -------------------------------------------------------------------------
-- Atomic daily issuance
-- -------------------------------------------------------------------------

create or replace function private.issue_field_daily_bonus_pack(
  p_user_id uuid,
  p_acquisition_id uuid,
  p_issuance_scope text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_acquisition public.acquisitions%rowtype;
  v_region_code text;
  v_existing_pack_id uuid;
  v_pool private.bonus_pack_pool_versions%rowtype;
  v_recent_total integer;
  v_recent_common integer;
  v_rarity_roll integer;
  v_selection_roll integer;
  v_rarity text;
  v_guarantee boolean;
  v_has_missing_special boolean := false;
  v_candidate_count integer;
  v_card_id uuid;
  v_pack_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  if p_user_id is null
    or p_acquisition_id is null
    or p_issuance_scope is null
    or p_issuance_scope not in ('off', 'participants', 'public')
  then
    raise exception 'invalid bonus pack issuance input'
      using errcode = '22023';
  end if;

  select acquisition_row.*
  into v_acquisition
  from public.acquisitions as acquisition_row
  where acquisition_row.id = p_acquisition_id
    and acquisition_row.user_id = p_user_id
  for share of acquisition_row;

  if not found or v_acquisition.acquisition_type <> 'field' then
    return null;
  end if;

  select spot_row.region
  into v_region_code
  from public.spots as spot_row
  where spot_row.id = v_acquisition.spot_id
  for share of spot_row;

  if v_region_code is null then
    return null;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    -- User-wide serialization keeps the pity history ordered even when two
    -- transactions cross the KST midnight boundary. The partial unique index
    -- independently enforces one pack per KST date.
    'danyeodam:bonus-pack:daily:' || p_user_id::text,
    0
  ));

  select pack_row.id
  into v_existing_pack_id
  from private.bonus_packs as pack_row
  where pack_row.user_id = p_user_id
    and pack_row.issuance_kind = 'field_daily'
    and pack_row.issued_on_kst = v_acquisition.acquired_on_kst
  for update;

  if v_existing_pack_id is not null then
    insert into private.bonus_pack_qualifiers (
      pack_id,
      acquisition_id,
      user_id,
      is_issuing_qualifier,
      linked_at
    ) values (
      v_existing_pack_id,
      p_acquisition_id,
      p_user_id,
      false,
      v_now
    ) on conflict (acquisition_id) do nothing;
    return v_existing_pack_id;
  end if;

  -- Only the canonical first valid field acquisition of the KST day may
  -- create a pack. If that first visit ran while issuance/access/content was
  -- closed, a later visit must not backfill a pack or switch its region.
  if exists (
    select 1
    from public.acquisitions as earlier_acquisition
    where earlier_acquisition.user_id = p_user_id
      and earlier_acquisition.acquisition_type = 'field'
      and earlier_acquisition.acquired_on_kst = v_acquisition.acquired_on_kst
      and (earlier_acquisition.acquired_at, earlier_acquisition.id)
        < (v_acquisition.acquired_at, v_acquisition.id)
  ) then
    return null;
  end if;

  if p_issuance_scope = 'off' then
    return null;
  end if;

  if p_issuance_scope = 'participants'
    and not exists (
      select 1
      from private.participant_access as access_row
      where access_row.user_id = p_user_id
        and access_row.revoked_at is null
        and (
          access_row.expires_at is null
          or access_row.expires_at > v_now
        )
    )
  then
    return null;
  end if;

  select pool_row.*
  into v_pool
  from private.bonus_pack_pool_versions as pool_row
  where pool_row.region_code = v_region_code
    and pool_row.published_at is not null
    and pool_row.published_at <= v_now
    and pool_row.retired_at is null
  for share;

  if not found then
    -- A field card must never be rolled back merely because reward content is
    -- not release-ready. The server flag can remain public while a region has
    -- no active pool; no pack is created and no later replay backfills one.
    return null;
  end if;

  select
    count(*)::integer,
    count(*) filter (where recent.result_rarity = 'common')::integer
  into v_recent_total, v_recent_common
  from (
    select pack_row.result_rarity
    from private.bonus_packs as pack_row
    where pack_row.user_id = p_user_id
      and pack_row.issuance_kind = 'field_daily'
    order by
      pack_row.issued_on_kst desc,
      pack_row.issued_at desc,
      pack_row.id desc
    limit 4
  ) as recent;

  v_rarity_roll := private.bonus_pack_random_10000();
  v_guarantee := v_recent_total = 4 and v_recent_common = 4;
  v_rarity := private.bonus_pack_rarity_for_roll(
    v_rarity_roll,
    case when v_guarantee then 4 else v_recent_common end
  );
  if v_rarity = 'special' then
    select exists (
      select 1
      from private.bonus_pack_pool_cards as entry_row
      where entry_row.pool_version_id = v_pool.id
        and entry_row.rarity = 'special'
        and not exists (
          select 1
          from private.bonus_packs as owned_pack
          where owned_pack.user_id = p_user_id
            and owned_pack.result_card_id = entry_row.card_id
        )
    ) into v_has_missing_special;
  end if;

  select count(*)::integer
  into v_candidate_count
  from private.bonus_pack_pool_cards as entry_row
  where entry_row.pool_version_id = v_pool.id
    and entry_row.rarity = v_rarity
    and (
      v_rarity <> 'special'
      or not v_has_missing_special
      or not exists (
        select 1
        from private.bonus_packs as owned_pack
        where owned_pack.user_id = p_user_id
          and owned_pack.result_card_id = entry_row.card_id
      )
    );

  if v_candidate_count < 1 then
    raise exception 'published bonus pack pool has no candidate for rolled rarity'
      using errcode = '23514';
  end if;

  v_selection_roll := private.bonus_pack_random_bounded(v_candidate_count);

  select candidate.card_id
  into v_card_id
  from (
    select entry_row.card_id
    from private.bonus_pack_pool_cards as entry_row
    where entry_row.pool_version_id = v_pool.id
      and entry_row.rarity = v_rarity
      and (
        v_rarity <> 'special'
        or not v_has_missing_special
        or not exists (
          select 1
          from private.bonus_packs as owned_pack
          where owned_pack.user_id = p_user_id
            and owned_pack.result_card_id = entry_row.card_id
        )
      )
    order by entry_row.sort_order, entry_row.card_id
    offset v_selection_roll
    limit 1
  ) as candidate;

  v_pack_id := gen_random_uuid();
  insert into private.bonus_packs (
    id,
    user_id,
    issuance_kind,
    issued_on_kst,
    pool_version_id,
    result_card_id,
    result_rarity,
    rarity_roll,
    selection_roll,
    guarantee_applied,
    state,
    issued_at
  ) values (
    v_pack_id,
    p_user_id,
    'field_daily',
    v_acquisition.acquired_on_kst,
    v_pool.id,
    v_card_id,
    v_rarity,
    v_rarity_roll,
    v_selection_roll,
    v_guarantee,
    'sealed',
    v_now
  );

  insert into private.bonus_pack_qualifiers (
    pack_id,
    acquisition_id,
    user_id,
    is_issuing_qualifier,
    linked_at
  ) values (
    v_pack_id,
    p_acquisition_id,
    p_user_id,
    true,
    v_now
  );

  return v_pack_id;
end;
$$;

create or replace function api_private.acquire_commit_v05(
  p_auth_user_id uuid,
  p_spot_id uuid,
  p_idempotency_key uuid,
  p_public_gate_open boolean,
  p_expected_spot_updated_at timestamptz,
  p_expected_user_id uuid,
  p_bonus_pack_issuance_scope text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_acquisition_id uuid;
  v_pack jsonb;
begin
  if p_bonus_pack_issuance_scope is null
    or p_bonus_pack_issuance_scope not in ('off', 'participants', 'public')
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  v_result := api_private.acquire_commit(
    p_auth_user_id,
    p_spot_id,
    p_idempotency_key,
    p_public_gate_open,
    p_expected_spot_updated_at,
    p_expected_user_id
  );

  if v_result ->> 'status' = 'created' then
    v_acquisition_id := (v_result #>> '{acquisition,id}')::uuid;
    perform private.issue_field_daily_bonus_pack(
      p_expected_user_id,
      v_acquisition_id,
      p_bonus_pack_issuance_scope
    );
  elsif v_result ->> 'status' = 'replay' then
    v_acquisition_id := (v_result #>> '{acquisition,id}')::uuid;
  else
    return v_result;
  end if;

  v_pack := private.bonus_pack_acquire_projection(v_acquisition_id);
  if v_pack is not null then
    v_result := v_result || jsonb_build_object('bonus_pack', v_pack);
  end if;
  return v_result;
end;
$$;

-- Context can terminate an idempotent acquire before commit. Preserve the
-- existing rate/identity functions as owner-only implementation details and
-- decorate only already-linked replay results. This never creates a pack.
alter function api_private.acquire_context(
  uuid, uuid, uuid, boolean
) rename to acquire_context_before_bonus_pack;

alter function api_private.acquire_context_continuation(
  uuid, uuid, uuid, boolean, uuid
) rename to acquire_context_continuation_before_bonus_pack;

alter function api_private.record_acquire_failure(
  uuid, uuid, uuid, text, jsonb, uuid
) rename to record_acquire_failure_before_bonus_pack;

revoke all on function api_private.acquire_context_before_bonus_pack(
  uuid, uuid, uuid, boolean
) from public, anon, authenticated, service_role;

revoke all on function api_private.acquire_context_continuation_before_bonus_pack(
  uuid, uuid, uuid, boolean, uuid
) from public, anon, authenticated, service_role;

revoke all on function api_private.record_acquire_failure_before_bonus_pack(
  uuid, uuid, uuid, text, jsonb, uuid
) from public, anon, authenticated, service_role;

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
  v_result jsonb;
begin
  -- The delegated implementation performs
  -- private.consume_authenticated_api_rate_limit(...) in this transaction.
  v_result := api_private.acquire_context_before_bonus_pack(
    p_auth_user_id,
    p_spot_id,
    p_idempotency_key,
    p_public_gate_open
  );
  return private.attach_bonus_pack_acquire_projection(
    v_result,
    p_auth_user_id,
    p_idempotency_key
  );
end;
$$;

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
  v_result := api_private.acquire_context_continuation_before_bonus_pack(
    p_auth_user_id,
    p_spot_id,
    p_idempotency_key,
    p_public_gate_open,
    p_expected_user_id
  );
  return private.attach_bonus_pack_acquire_projection(
    v_result,
    p_auth_user_id,
    p_idempotency_key
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
declare
  v_result jsonb;
begin
  v_result := api_private.record_acquire_failure_before_bonus_pack(
    p_auth_user_id,
    p_spot_id,
    p_idempotency_key,
    p_code,
    p_details,
    p_expected_user_id
  );
  return private.attach_bonus_pack_acquire_projection(
    v_result,
    p_auth_user_id,
    p_idempotency_key
  );
end;
$$;

-- -------------------------------------------------------------------------
-- User pack and inventory reads; open is reveal-only
-- -------------------------------------------------------------------------

create or replace function api_private.list_bonus_packs(
  p_auth_user_id uuid,
  p_limit integer,
  p_before_issued_at timestamptz,
  p_before_bonus_pack_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_access jsonb;
  v_user_id uuid;
  v_items jsonb;
  v_has_more boolean;
  v_sealed_count integer;
  v_next_issued_at timestamptz;
  v_next_id uuid;
begin
  if p_limit is null or p_limit not between 1 and 100
    or (p_before_issued_at is null) <> (p_before_bonus_pack_id is null)
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  v_access := private.authorize_bonus_pack_rpc(
    p_auth_user_id,
    'collection_read'
  );
  if v_access ->> 'status' <> 'ready' then
    return v_access;
  end if;
  v_user_id := (v_access ->> 'user_id')::uuid;

  select count(*)::integer
  into v_sealed_count
  from private.bonus_packs as pack_row
  where pack_row.user_id = v_user_id
    and pack_row.state = 'sealed';

  select coalesce(jsonb_agg(page.pack order by page.issued_at desc, page.id desc), '[]'::jsonb)
  into v_items
  from (
    select
      pack_row.id,
      pack_row.issued_at,
      private.bonus_pack_current_projection(pack_row.id) as pack
    from private.bonus_packs as pack_row
    where pack_row.user_id = v_user_id
      and (
        p_before_issued_at is null
        or (pack_row.issued_at, pack_row.id)
          < (p_before_issued_at, p_before_bonus_pack_id)
      )
    order by pack_row.issued_at desc, pack_row.id desc
    limit p_limit
  ) as page;

  select exists (
    select 1
    from private.bonus_packs as pack_row
    where pack_row.user_id = v_user_id
      and (
        p_before_issued_at is null
        or (pack_row.issued_at, pack_row.id)
          < (p_before_issued_at, p_before_bonus_pack_id)
      )
    order by pack_row.issued_at desc, pack_row.id desc
    offset p_limit
    limit 1
  ) into v_has_more;

  if v_has_more then
    select pack_row.issued_at, pack_row.id
    into v_next_issued_at, v_next_id
    from private.bonus_packs as pack_row
    where pack_row.user_id = v_user_id
      and (
        p_before_issued_at is null
        or (pack_row.issued_at, pack_row.id)
          < (p_before_issued_at, p_before_bonus_pack_id)
      )
    order by pack_row.issued_at desc, pack_row.id desc
    offset (p_limit - 1)
    limit 1;
  end if;

  return jsonb_build_object(
    'status', 'ready',
    'items', v_items,
    'sealed_count', v_sealed_count,
    'has_more', v_has_more,
    'next_anchor', case when v_has_more then jsonb_build_object(
      'issued_at', v_next_issued_at,
      'id', v_next_id
    ) else null end
  );
end;
$$;

create or replace function api_private.get_bonus_pack(
  p_auth_user_id uuid,
  p_bonus_pack_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_access jsonb;
  v_user_id uuid;
  v_pack jsonb;
begin
  if p_bonus_pack_id is null then
    return jsonb_build_object('status', 'invalid');
  end if;

  v_access := private.authorize_bonus_pack_rpc(
    p_auth_user_id,
    'collection_read'
  );
  if v_access ->> 'status' <> 'ready' then
    return v_access;
  end if;
  v_user_id := (v_access ->> 'user_id')::uuid;

  select private.bonus_pack_current_projection(pack_row.id)
  into v_pack
  from private.bonus_packs as pack_row
  where pack_row.id = p_bonus_pack_id
    and pack_row.user_id = v_user_id;

  if v_pack is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  return jsonb_build_object('status', 'ready', 'bonus_pack', v_pack);
end;
$$;

create or replace function api_private.open_bonus_pack(
  p_auth_user_id uuid,
  p_bonus_pack_id uuid,
  p_client_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_access jsonb;
  v_user_id uuid;
  v_existing_pack_id uuid;
  v_pack private.bonus_packs%rowtype;
begin
  if p_bonus_pack_id is null or p_client_request_id is null then
    return jsonb_build_object('status', 'invalid');
  end if;

  v_access := private.authorize_bonus_pack_rpc(
    p_auth_user_id,
    'participant_write'
  );
  if v_access ->> 'status' <> 'ready' then
    return v_access;
  end if;
  v_user_id := (v_access ->> 'user_id')::uuid;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:bonus-pack:open-request:' || v_user_id::text || ':'
      || p_client_request_id::text,
    0
  ));

  select request_row.pack_id
  into v_existing_pack_id
  from private.bonus_pack_open_requests as request_row
  where request_row.user_id = v_user_id
    and request_row.client_request_id = p_client_request_id;

  if v_existing_pack_id is not null and v_existing_pack_id <> p_bonus_pack_id then
    return jsonb_build_object('status', 'idempotency_conflict');
  end if;

  select pack_row.*
  into v_pack
  from private.bonus_packs as pack_row
  where pack_row.id = p_bonus_pack_id
    and pack_row.user_id = v_user_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_pack.state = 'sealed' and v_existing_pack_id is null then
    insert into private.bonus_pack_open_requests (
      user_id,
      pack_id,
      client_request_id
    ) values (
      v_user_id,
      p_bonus_pack_id,
      p_client_request_id
    );
  end if;

  if v_pack.state = 'sealed' then
    update private.bonus_packs
    set state = 'opened',
        opened_at = clock_timestamp()
    where id = v_pack.id;
  end if;

  return jsonb_build_object(
    'status', 'ready',
    'bonus_pack', private.bonus_pack_current_projection(v_pack.id)
  );
end;
$$;

create or replace function api_private.list_card_inventory(
  p_auth_user_id uuid,
  p_limit integer,
  p_before_last_acquired_at timestamptz,
  p_before_card_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_access jsonb;
  v_user_id uuid;
  v_items jsonb;
  v_has_more boolean;
  v_next_acquired_at timestamptz;
  v_next_card_id uuid;
begin
  if p_limit is null or p_limit not between 1 and 100
    or (p_before_last_acquired_at is null) <> (p_before_card_id is null)
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  v_access := private.authorize_bonus_pack_rpc(
    p_auth_user_id,
    'collection_read'
  );
  if v_access ->> 'status' <> 'ready' then
    return v_access;
  end if;
  v_user_id := (v_access ->> 'user_id')::uuid;

  with inventory_sources as (
    select
      acquisition_row.card_id,
      acquisition_row.acquired_at,
      case when card_row.kind = 'special' then 'special' else 'common' end as rarity
    from public.acquisitions as acquisition_row
    join public.cards as card_row on card_row.id = acquisition_row.card_id
    where acquisition_row.user_id = v_user_id
      and card_row.kind <> 'special'

    union all

    select
      pack_row.result_card_id,
      pack_row.opened_at,
      pack_row.result_rarity
    from private.bonus_packs as pack_row
    where pack_row.user_id = v_user_id
      and pack_row.state = 'opened'
  ), inventory as (
    select
      source_row.card_id,
      count(*)::integer as quantity,
      min(source_row.acquired_at) as first_acquired_at,
      max(source_row.acquired_at) as last_acquired_at,
      case when bool_or(source_row.rarity = 'special')
        then 'special' else 'common' end as rarity
    from inventory_sources as source_row
    group by source_row.card_id
  ), page as (
    select inventory_row.*
    from inventory as inventory_row
    where p_before_last_acquired_at is null
      or (inventory_row.last_acquired_at, inventory_row.card_id)
        < (p_before_last_acquired_at, p_before_card_id)
    order by inventory_row.last_acquired_at desc, inventory_row.card_id desc
    limit p_limit
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'card', private.bonus_pack_card_projection(
        page.card_id,
        page.rarity
      ),
      'quantity', page.quantity,
      'first_acquired_at', page.first_acquired_at,
      'last_acquired_at', page.last_acquired_at
    ) order by page.last_acquired_at desc, page.card_id desc
  ), '[]'::jsonb)
  into v_items
  from page;

  with inventory_sources as (
    select acquisition_row.card_id, acquisition_row.acquired_at
    from public.acquisitions as acquisition_row
    join public.cards as card_row on card_row.id = acquisition_row.card_id
    where acquisition_row.user_id = v_user_id
      and card_row.kind <> 'special'
    union all
    select pack_row.result_card_id, pack_row.opened_at
    from private.bonus_packs as pack_row
    where pack_row.user_id = v_user_id and pack_row.state = 'opened'
  ), inventory as (
    select
      source_row.card_id,
      max(source_row.acquired_at) as last_acquired_at
    from inventory_sources as source_row
    group by source_row.card_id
  ), remaining as (
    select inventory_row.*
    from inventory as inventory_row
    where p_before_last_acquired_at is null
      or (inventory_row.last_acquired_at, inventory_row.card_id)
        < (p_before_last_acquired_at, p_before_card_id)
    order by inventory_row.last_acquired_at desc, inventory_row.card_id desc
  )
  select
    count(*) > p_limit,
    (array_agg(last_acquired_at order by last_acquired_at desc, card_id desc))[p_limit],
    (array_agg(card_id order by last_acquired_at desc, card_id desc))[p_limit]
  into v_has_more, v_next_acquired_at, v_next_card_id
  from remaining;

  return jsonb_build_object(
    'status', 'ready',
    'items', v_items,
    'has_more', v_has_more,
    'next_anchor', case when v_has_more then jsonb_build_object(
      'last_acquired_at', v_next_acquired_at,
      'card_id', v_next_card_id
    ) else null end
  );
end;
$$;

-- Public card assets must never reveal an unopened special-card outcome.
-- Ordinary/open-spot and legacy acquired non-special behavior is preserved.
-- A common card already revealed from a bonus pack also stays fetchable if
-- its spot later pauses; sealed outcomes do not satisfy this boundary.
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
    and card_row.kind <> 'special'
    and card_row.sketch_path is not null
    and (
      (card_row.is_published and spot_row.status = 'open')
      or exists (
        select 1
        from public.acquisitions as acquisition_row
        where acquisition_row.card_id = card_row.id
      )
      or exists (
        select 1
        from private.bonus_packs as pack_row
        where pack_row.result_card_id = card_row.id
          and pack_row.result_rarity = 'common'
          and pack_row.state = 'opened'
      )
    )
  limit 1
$$;

create or replace function api_private.get_owned_special_card_asset(
  p_auth_user_id uuid,
  p_card_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_access jsonb;
  v_user_id uuid;
  v_asset_path text;
begin
  if p_card_id is null then
    return jsonb_build_object('status', 'invalid');
  end if;

  v_access := private.authorize_bonus_pack_rpc(
    p_auth_user_id,
    'collection_read'
  );
  if v_access ->> 'status' <> 'ready' then
    return v_access;
  end if;
  v_user_id := (v_access ->> 'user_id')::uuid;

  select card_row.sketch_path
  into v_asset_path
  from public.cards as card_row
  where card_row.id = p_card_id
    and card_row.kind = 'special'
    and card_row.is_published
    and card_row.sketch_path is not null
    and private.special_card_asset_is_private(card_row.sketch_path)
    and private.card_has_complete_translations(card_row.id)
    and exists (
      select 1
      from private.bonus_packs as pack_row
      where pack_row.user_id = v_user_id
        and pack_row.result_card_id = card_row.id
        and pack_row.result_rarity = 'special'
        and pack_row.state = 'opened'
    )
  limit 1;

  if v_asset_path is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  return jsonb_build_object(
    'status', 'found',
    'bucket', 'special-card-assets',
    'asset_path', v_asset_path
  );
end;
$$;

-- -------------------------------------------------------------------------
-- Deterministic reviewer-only sealed special pack
-- -------------------------------------------------------------------------

create or replace function private.ensure_reviewer_bonus_pack_fixture(
  p_user_id uuid,
  p_fixture_version text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pool_id uuid;
  v_card_id uuid;
  v_pack_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  if p_user_id is null or p_fixture_version is null then
    return null;
  end if;
  if not exists (
    select 1
    from private.reviewer_accounts as reviewer_row
    join private.participant_access as access_row
      on access_row.user_id = reviewer_row.user_id
    where reviewer_row.user_id = p_user_id
      and reviewer_row.revoked_at is null
      and access_row.access_kind = 'store_reviewer'
      and access_row.revoked_at is null
      and (
        access_row.expires_at is null
        or access_row.expires_at > v_now
      )
  ) then
    return null;
  end if;

  select pool_row.id, entry_row.card_id
  into v_pool_id, v_card_id
  from private.bonus_pack_pool_versions as pool_row
  join private.bonus_pack_pool_cards as entry_row
    on entry_row.pool_version_id = pool_row.id
   and entry_row.rarity = 'special'
  where pool_row.published_at is not null
    and pool_row.published_at <= v_now
    and pool_row.retired_at is null
  order by pool_row.region_code, entry_row.sort_order, entry_row.card_id
  limit 1;

  if v_pool_id is null then
    -- Reviewer provisioning remains usable while special-card rights/content
    -- are closed. A later reset after pool publication creates the fixture.
    return null;
  end if;

  select pack_row.id
  into v_pack_id
  from private.bonus_packs as pack_row
  where pack_row.user_id = p_user_id
    and pack_row.issuance_kind = 'reviewer_fixture';
  if v_pack_id is not null then
    return v_pack_id;
  end if;

  v_pack_id := private.reviewer_fixture_uuid(
    p_user_id,
    'bonus-pack:' || p_fixture_version || ':' || v_pool_id::text
  );
  insert into private.bonus_packs (
    id,
    user_id,
    issuance_kind,
    issued_on_kst,
    pool_version_id,
    result_card_id,
    result_rarity,
    rarity_roll,
    selection_roll,
    guarantee_applied,
    state,
    issued_at
  ) values (
    v_pack_id,
    p_user_id,
    'reviewer_fixture',
    (v_now at time zone 'Asia/Seoul')::date,
    v_pool_id,
    v_card_id,
    'special',
    9999,
    0,
    false,
    'sealed',
    v_now
  ) on conflict (user_id)
    where issuance_kind = 'reviewer_fixture'
    do nothing;

  select pack_row.id
  into v_pack_id
  from private.bonus_packs as pack_row
  where pack_row.user_id = p_user_id
    and pack_row.issuance_kind = 'reviewer_fixture';
  return v_pack_id;
end;
$$;

create or replace function private.cleanup_reviewer_bonus_pack_fixture(
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pack_id uuid;
begin
  select pack_row.id
  into v_pack_id
  from private.bonus_packs as pack_row
  where pack_row.user_id = p_user_id
    and pack_row.issuance_kind = 'reviewer_fixture'
  for update;
  if v_pack_id is null then
    return;
  end if;

  perform set_config(
    'danyeodam.reviewer_bonus_pack_cleanup',
    v_pack_id::text,
    true
  );
  delete from private.bonus_packs where id = v_pack_id;
end;
$$;

create or replace function private.sync_reviewer_bonus_pack_fixture()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT'
    and new.item_kind = 'retro_acquisition'
    and new.revoked_at is null
  then
    perform private.ensure_reviewer_bonus_pack_fixture(
      new.user_id,
      new.fixture_version
    );
  elsif tg_op = 'UPDATE'
    and old.item_kind = 'retro_acquisition'
    and old.revoked_at is null
    and new.revoked_at is not null
  then
    perform private.cleanup_reviewer_bonus_pack_fixture(old.user_id);
  elsif tg_op = 'UPDATE'
    and old.item_kind = 'personal_card'
    and old.revoked_at is null
    and new.revoked_at is not null
  then
    -- A completed reviewer reset rotates the personal-card inventory row but
    -- intentionally preserves retro rows. Reset the reveal ledger here so an
    -- opened reviewer pack becomes the same deterministic sealed fixture.
    -- During revoke the reviewer account is already closed, so ensure is a
    -- safe no-op after the cleanup trigger has run.
    perform private.cleanup_reviewer_bonus_pack_fixture(old.user_id);
    perform private.ensure_reviewer_bonus_pack_fixture(
      old.user_id,
      old.fixture_version
    );
  end if;
  return new;
end;
$$;

create trigger reviewer_fixture_items_sync_bonus_pack
after insert or update of revoked_at on private.reviewer_fixture_items
for each row execute function private.sync_reviewer_bonus_pack_fixture();

create or replace function private.cleanup_revoked_reviewer_bonus_pack()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.revoked_at is null and new.revoked_at is not null then
    perform private.cleanup_reviewer_bonus_pack_fixture(new.user_id);
  end if;
  return new;
end;
$$;

create trigger reviewer_accounts_cleanup_bonus_pack
after update of revoked_at on private.reviewer_accounts
for each row execute function private.cleanup_revoked_reviewer_bonus_pack();

-- Existing active reviewers predate this migration, so their already-active
-- retro inventory cannot fire the INSERT trigger above. Synchronize only the
-- reviewer fixture (never historical field acquisitions); no active pool is a
-- deliberate no-op and keeps the feature closed safely.
do $reviewer_bonus_pack_cutover$
declare
  reviewer_fixture record;
begin
  for reviewer_fixture in
    select distinct on (reviewer_row.user_id)
      reviewer_row.user_id,
      item_row.fixture_version
    from private.reviewer_accounts as reviewer_row
    join private.participant_access as access_row
      on access_row.user_id = reviewer_row.user_id
     and access_row.access_kind = 'store_reviewer'
     and access_row.revoked_at is null
     and (
       access_row.expires_at is null
       or access_row.expires_at > clock_timestamp()
     )
    join private.reviewer_fixture_items as item_row
      on item_row.user_id = reviewer_row.user_id
     and item_row.item_kind = 'retro_acquisition'
     and item_row.revoked_at is null
    where reviewer_row.revoked_at is null
    order by reviewer_row.user_id, item_row.created_at, item_row.id
  loop
    perform private.ensure_reviewer_bonus_pack_fixture(
      reviewer_fixture.user_id,
      reviewer_fixture.fixture_version
    );
  end loop;
end;
$reviewer_bonus_pack_cutover$;

-- -------------------------------------------------------------------------
-- Explicit function ACLs
-- -------------------------------------------------------------------------

revoke all on function private.guard_bonus_pack_pool_card_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.lock_card_asset_paths(text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.special_card_asset_is_private(text)
  from public, anon, authenticated, service_role;
revoke all on function private.enforce_special_card_asset_boundary()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_special_card_storage_object()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_bonus_pack_pool_version_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_bonus_pack_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_bonus_pack_qualifier()
  from public, anon, authenticated, service_role;
revoke all on function private.remove_orphaned_field_bonus_pack()
  from public, anon, authenticated, service_role;
revoke all on function private.ensure_field_bonus_pack_has_qualifier()
  from public, anon, authenticated, service_role;
revoke all on function private.prevent_bonus_pack_card_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.prevent_bonus_pack_spot_region_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.prevent_bonus_pack_translation_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.prevent_special_card_acquisition()
  from public, anon, authenticated, service_role;
revoke all on function private.bonus_pack_random_10000()
  from public, anon, authenticated, service_role;
revoke all on function private.bonus_pack_random_bounded(integer)
  from public, anon, authenticated, service_role;
revoke all on function private.bonus_pack_rarity_for_roll(integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function private.bonus_pack_acquire_projection(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.bonus_pack_card_projection(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function private.bonus_pack_current_projection(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.authorize_bonus_pack_rpc(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function private.attach_bonus_pack_acquire_projection(
  jsonb, uuid, uuid
) from public, anon, authenticated, service_role;
revoke all on function private.issue_field_daily_bonus_pack(
  uuid, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function private.ensure_reviewer_bonus_pack_fixture(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function private.cleanup_reviewer_bonus_pack_fixture(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.sync_reviewer_bonus_pack_fixture()
  from public, anon, authenticated, service_role;
revoke all on function private.cleanup_revoked_reviewer_bonus_pack()
  from public, anon, authenticated, service_role;

revoke all on function api_private.acquire_context(
  uuid, uuid, uuid, boolean
) from public, anon, authenticated, service_role;
revoke all on function api_private.acquire_context_continuation(
  uuid, uuid, uuid, boolean, uuid
) from public, anon, authenticated, service_role;
revoke all on function api_private.record_acquire_failure(
  uuid, uuid, uuid, text, jsonb, uuid
) from public, anon, authenticated, service_role;
revoke all on function api_private.acquire_commit_v05(
  uuid, uuid, uuid, boolean, timestamptz, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function api_private.list_bonus_packs(
  uuid, integer, timestamptz, uuid
) from public, anon, authenticated, service_role;
revoke all on function api_private.get_bonus_pack(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function api_private.open_bonus_pack(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function api_private.list_card_inventory(
  uuid, integer, timestamptz, uuid
) from public, anon, authenticated, service_role;
revoke all on function api_private.get_published_card_asset(uuid)
  from public, anon, authenticated, service_role;
revoke all on function api_private.get_owned_special_card_asset(uuid, uuid)
  from public, anon, authenticated, service_role;

grant execute on function api_private.acquire_context(
  uuid, uuid, uuid, boolean
) to service_role;
grant execute on function api_private.acquire_context_continuation(
  uuid, uuid, uuid, boolean, uuid
) to service_role;
grant execute on function api_private.record_acquire_failure(
  uuid, uuid, uuid, text, jsonb, uuid
) to service_role;
grant execute on function api_private.acquire_commit_v05(
  uuid, uuid, uuid, boolean, timestamptz, uuid, text
) to service_role;
grant execute on function api_private.list_bonus_packs(
  uuid, integer, timestamptz, uuid
) to service_role;
grant execute on function api_private.get_bonus_pack(uuid, uuid)
  to service_role;
grant execute on function api_private.open_bonus_pack(uuid, uuid, uuid)
  to service_role;
grant execute on function api_private.list_card_inventory(
  uuid, integer, timestamptz, uuid
) to service_role;
grant execute on function api_private.get_published_card_asset(uuid)
  to service_role;
grant execute on function api_private.get_owned_special_card_asset(uuid, uuid)
  to service_role;

commit;
