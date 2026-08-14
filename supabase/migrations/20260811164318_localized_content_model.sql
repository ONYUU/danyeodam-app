-- DANYEODAM API-CONTRACT v0.3 localized content model.
--
-- This is a forward-only migration. Legacy Korean/English columns remain as
-- compatibility fields, but all v0.3 read RPCs consume the audited six-locale
-- translation tables below.

-- This slice has no approved ja/zh-Hans/zh-Hant/vi data for legacy acquired
-- card snapshots. Once an acquisition exists, inventing translations or
-- opening a mutable backfill window would violate snapshot immutability.
-- Abort before any localized-content DDL so a nonempty environment remains
-- on the previous content schema until a separate staged, audited data
-- migration exists. The preceding share-privacy cutover remains applicable.
do $$
begin
  if exists (select 1 from public.acquisitions) then
    raise exception
      'v0.3 localization requires empty acquisitions; use a staged audited legacy-card translation migration'
      using errcode = 'P0001';
  end if;
end;
$$;

-- -------------------------------------------------------------------------
-- Localized content model
-- -------------------------------------------------------------------------

create type public.content_locale as enum (
  'ko',
  'en',
  'ja',
  'zh-Hans',
  'zh-Hant',
  'vi'
);

create type public.translation_status as enum (
  'draft',
  'approved'
);

create table public.regions (
  code text primary key
    check (code ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  country_code text not null default 'KR'
    check (country_code ~ '^[A-Z]{2}$'),
  sort_order integer not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.region_translations (
  region_code text not null
    references public.regions(code) on delete cascade,
  locale public.content_locale not null,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  status public.translation_status not null default 'draft',
  approved_at timestamptz,
  approved_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (region_code, locale),
  constraint region_translations_approval_audit check (
    (
      status = 'draft'
      and approved_at is null
      and approved_by is null
    )
    or (
      status = 'approved'
      and approved_at is not null
      and approved_by is not null
    )
  )
);

alter table public.spots
  add column sort_order integer not null default 0
    check (sort_order >= 0);

-- Ensure every legacy region code has a parent before adding the foreign key.
insert into public.regions (code, country_code, sort_order)
select distinct spot_row.region, 'KR', 0
from public.spots as spot_row
on conflict (code) do nothing;

alter table public.spots
  add constraint spots_region_fkey
  foreign key (region)
  references public.regions(code)
  on update cascade
  on delete restrict;

create table public.spot_translations (
  spot_id uuid not null references public.spots(id) on delete cascade,
  locale public.content_locale not null,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  status public.translation_status not null default 'draft',
  approved_at timestamptz,
  approved_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (spot_id, locale),
  constraint spot_translations_approval_audit check (
    (
      status = 'draft'
      and approved_at is null
      and approved_by is null
    )
    or (
      status = 'approved'
      and approved_at is not null
      and approved_by is not null
    )
  )
);

create table public.card_translations (
  card_id uuid not null references public.cards(id) on delete cascade,
  locale public.content_locale not null,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  status public.translation_status not null default 'draft',
  approved_at timestamptz,
  approved_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (card_id, locale),
  constraint card_translations_approval_audit check (
    (
      status = 'draft'
      and approved_at is null
      and approved_by is null
    )
    or (
      status = 'approved'
      and approved_at is not null
      and approved_by is not null
    )
  )
);

create index regions_sort_code_idx
  on public.regions(sort_order, code);

create index spots_public_sort_idx
  on public.spots(region, sort_order, id)
  where status in ('teaser', 'open');

-- Full supporting index for spots_region_fkey. The public-sort index is
-- partial and cannot support parent-key update/delete checks for draft rows.
create index spots_region_idx_v03
  on public.spots(region);

create index acquisitions_user_page_idx
  on public.acquisitions(user_id, acquired_at desc, id desc);

-- The page index preserves the full (user_id, acquired_at desc) prefix used
-- by existing lookups and adds the deterministic id tie-breaker. Keeping the
-- old prefix index would duplicate every acquisition write without adding a
-- usable access path.
drop index public.acquisitions_user_acquired_idx;

create index region_translations_approved_by_idx
  on public.region_translations(approved_by);

create index spot_translations_approved_by_idx
  on public.spot_translations(approved_by);

create index card_translations_approved_by_idx
  on public.card_translations(approved_by);

-- Keep the v0.2.3 partial unique index that permits exactly one published
-- region card per spot. Card replacement is deliberately conservative:
-- in one transaction, lock the existing published card FOR UPDATE, lock the
-- unpublished replacement card FOR UPDATE, then lock/draft the spot, retire
-- the old card, publish the complete replacement, and reopen the spot. This
-- card -> spot order matches acquisition. Allowing two published cards and
-- deciding retirement in row triggers would admit a stale-snapshot race when
-- two card rows are retired concurrently.

-- Legacy rows are imported as drafts. They must go through an explicit TRUST
-- approval before a v0.3 public or acquisition RPC can use them.
insert into public.region_translations (
  region_code,
  locale,
  name,
  status
)
select region_row.code, locale_row.locale, region_row.code, 'draft'
from public.regions as region_row
cross join lateral (
  values
    ('ko'::public.content_locale),
    ('en'::public.content_locale)
) as locale_row(locale)
on conflict (region_code, locale) do nothing;

insert into public.spot_translations (spot_id, locale, name, status)
select spot_row.id, 'ko', spot_row.name_ko, 'draft'
from public.spots as spot_row
on conflict (spot_id, locale) do nothing;

insert into public.spot_translations (spot_id, locale, name, status)
select spot_row.id, 'en', spot_row.name_en, 'draft'
from public.spots as spot_row
on conflict (spot_id, locale) do nothing;

insert into public.card_translations (card_id, locale, title, status)
select card_row.id, 'ko', card_row.title_ko, 'draft'
from public.cards as card_row
on conflict (card_id, locale) do nothing;

insert into public.card_translations (card_id, locale, title, status)
select card_row.id, 'en', card_row.title_en, 'draft'
from public.cards as card_row
on conflict (card_id, locale) do nothing;

-- Existing public rows cannot satisfy the new audited six-locale invariant.
-- Fail closed during cutover; operators may re-approve and republish after all
-- six translations have completed TRUST review.
update public.cards
set is_published = false,
    published_at = null
where is_published;

update public.spots
set status = 'draft'
where status in ('teaser', 'open');

-- -------------------------------------------------------------------------
-- Public content version and completeness helpers
-- -------------------------------------------------------------------------

create table private.content_versions (
  scope text primary key check (scope = 'public_spots'),
  version timestamptz not null
);

insert into private.content_versions (scope, version)
values ('public_spots', clock_timestamp());

create or replace function private.bump_public_spots_content_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.content_versions as version_row
  set version = greatest(
    clock_timestamp(),
    version_row.version + interval '1 microsecond'
  )
  where version_row.scope = 'public_spots';

  return null;
end;
$$;

create or replace function private.region_has_complete_translations(
  p_region_code text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) = 6
  from public.region_translations as translation_row
  where translation_row.region_code = p_region_code
    and translation_row.status = 'approved'
$$;

create or replace function private.spot_has_complete_translations(
  p_spot_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) = 6
  from public.spot_translations as translation_row
  where translation_row.spot_id = p_spot_id
    and translation_row.status = 'approved'
$$;

create or replace function private.card_has_complete_translations(
  p_card_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) = 6
  from public.card_translations as translation_row
  where translation_row.card_id = p_card_id
    and translation_row.status = 'approved'
$$;

create or replace function private.localized_region_name(
  p_region_code text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when count(*) = 6 then
      jsonb_object_agg(
        translation_row.locale::text,
        translation_row.name
        order by translation_row.locale::text
      )
    else null
  end
  from public.region_translations as translation_row
  where translation_row.region_code = p_region_code
    and translation_row.status = 'approved'
$$;

create or replace function private.localized_spot_name(
  p_spot_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when count(*) = 6 then
      jsonb_object_agg(
        translation_row.locale::text,
        translation_row.name
        order by translation_row.locale::text
      )
    else null
  end
  from public.spot_translations as translation_row
  where translation_row.spot_id = p_spot_id
    and translation_row.status = 'approved'
$$;

create or replace function private.localized_card_title(
  p_card_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when count(*) = 6 then
      jsonb_object_agg(
        translation_row.locale::text,
        translation_row.title
        order by translation_row.locale::text
      )
    else null
  end
  from public.card_translations as translation_row
  where translation_row.card_id = p_card_id
    and translation_row.status = 'approved'
$$;

create or replace function private.enforce_spot_public_completeness()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('teaser', 'open') then
    -- Region translation mutations take this same parent lock before they may
    -- demote/delete an approved row. This prevents a concurrent public status
    -- transition from observing the old complete set and committing after a
    -- translation removal.
    perform 1
    from public.regions as region_row
    where region_row.code = new.region
    for update of region_row;

    if not private.region_has_complete_translations(new.region)
      or not private.spot_has_complete_translations(new.id)
    then
      raise exception
        'teaser/open spot requires six approved region and spot translations'
        using errcode = '23514';
    end if;

    if new.status = 'open' and not exists (
      select 1
      from public.cards as card_row
      where card_row.spot_id = new.id
        and card_row.kind = 'region'
        and card_row.is_published
        and card_row.sketch_path is not null
        and private.card_has_complete_translations(card_row.id)
    ) then
      raise exception
        'open spot requires a published region card with six approved translations'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

create or replace function private.enforce_card_public_completeness()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
begin
  -- A card mutation serializes behind a concurrent spot status change. A
  -- concurrent translation mutation also locks this card before it may remove
  -- an approved value, preventing write-skew around publication/acquisition.
  if new.is_published then
    perform 1
    from public.spots as spot_row
    where spot_row.id = new.spot_id
    for update of spot_row;

    if new.sketch_path is null
      or not private.card_has_complete_translations(new.id)
    then
      raise exception
        'published card requires an asset and six approved translations'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

create or replace function private.guard_region_translation_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_region_code text := case
    when tg_op = 'DELETE' then old.region_code
    else new.region_code
  end;
begin
  if tg_op = 'UPDATE' and (
    new.region_code is distinct from old.region_code
    or new.locale is distinct from old.locale
  ) then
    raise exception
      'translation parent and locale are immutable; delete and recreate draft rows'
      using errcode = '23514';
  end if;

  perform 1
  from public.regions as region_row
  where region_row.code = v_region_code
  for update of region_row;

  if exists (
    select 1
    from public.spots as spot_row
    where spot_row.region = v_region_code
      and spot_row.status in ('teaser', 'open')
  ) and (
    tg_op = 'DELETE'
    or old.status = 'approved' and new.status <> 'approved'
  ) then
    raise exception
      'public region translations cannot be removed or demoted'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE'
    and old.status = 'approved'
    and new.status = 'approved'
    and (
      new.name is distinct from old.name
      or new.approved_at is distinct from old.approved_at
      or new.approved_by is distinct from old.approved_by
    )
    and (
      new.approved_at is null
      or new.approved_at <= old.approved_at
      or new.approved_by is null
    )
  then
    raise exception
      'approved region translation edits require a fresh approval audit'
      using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

create or replace function private.guard_spot_translation_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_spot_id uuid := case
    when tg_op = 'DELETE' then old.spot_id
    else new.spot_id
  end;
  v_status public.spot_status;
begin
  if tg_op = 'UPDATE' and (
    new.spot_id is distinct from old.spot_id
    or new.locale is distinct from old.locale
  ) then
    raise exception
      'translation parent and locale are immutable; delete and recreate draft rows'
      using errcode = '23514';
  end if;

  select spot_row.status
  into v_status
  from public.spots as spot_row
  where spot_row.id = v_spot_id
  for update of spot_row;

  if v_status in ('teaser', 'open') and (
    tg_op = 'DELETE'
    or old.status = 'approved' and new.status <> 'approved'
  ) then
    raise exception
      'public spot translations cannot be removed or demoted'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE'
    and old.status = 'approved'
    and new.status = 'approved'
    and (
      new.name is distinct from old.name
      or new.approved_at is distinct from old.approved_at
      or new.approved_by is distinct from old.approved_by
    )
    and (
      new.approved_at is null
      or new.approved_at <= old.approved_at
      or new.approved_by is null
    )
  then
    raise exception
      'approved spot translation edits require a fresh approval audit'
      using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

create or replace function private.guard_card_translation_mutation()
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
  v_is_published boolean;
begin
  if tg_op = 'UPDATE' and (
    new.card_id is distinct from old.card_id
    or new.locale is distinct from old.locale
  ) then
    raise exception
      'translation parent and locale are immutable; delete and recreate draft rows'
      using errcode = '23514';
  end if;

  select card_row.is_published
  into v_is_published
  from public.cards as card_row
  where card_row.id = v_card_id
  for update of card_row;

  if exists (
    select 1
    from public.acquisitions as acquisition_row
    where acquisition_row.card_id = v_card_id
  ) and (
    tg_op in ('INSERT', 'DELETE')
    or new.title is distinct from old.title
    or new.status is distinct from old.status
    or new.locale is distinct from old.locale
    or new.approved_at is distinct from old.approved_at
    or new.approved_by is distinct from old.approved_by
  ) then
    raise exception
      'acquired card translations are immutable; create a new card version'
      using errcode = '23514';
  end if;

  if coalesce(v_is_published, false) and (
    tg_op = 'DELETE'
    or old.status = 'approved' and new.status <> 'approved'
  ) then
    raise exception
      'published card translations cannot be removed or demoted'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE'
    and old.status = 'approved'
    and new.status = 'approved'
    and (
      new.title is distinct from old.title
      or new.approved_at is distinct from old.approved_at
      or new.approved_by is distinct from old.approved_by
    )
    and (
      new.approved_at is null
      or new.approved_at <= old.approved_at
      or new.approved_by is null
    )
  then
    raise exception
      'approved card translation edits require a fresh approval audit'
      using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

create or replace function private.prevent_legacy_localized_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'spots' then
    if new.name_ko is distinct from old.name_ko
      or new.name_en is distinct from old.name_en
    then
      raise exception
        'legacy spot names are read-only; edit spot_translations'
        using errcode = '23514';
    end if;
  elsif tg_table_name = 'cards' then
    if new.title_ko is distinct from old.title_ko
      or new.title_en is distinct from old.title_en
    then
      raise exception
        'legacy card titles are read-only; edit card_translations'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

-- Extend the v0.2.2 immutable response trigger to all card identity/snapshot
-- fields. The acquisition snapshot trigger takes a SHARE lock during insert;
-- UPDATE takes the conflicting row lock before this trigger evaluates, so a
-- concurrent first acquisition cannot race past this check.
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
      new.spot_id is distinct from old.spot_id
      or new.kind is distinct from old.kind
      or new.title_ko is distinct from old.title_ko
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

create or replace function private.prevent_open_spot_card_removal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_spot_status public.spot_status;
begin
  select spot_row.status
  into v_spot_status
  from public.spots as spot_row
  where spot_row.id = old.spot_id
  for update of spot_row;

  if tg_op = 'UPDATE'
    and old.is_published
    and old.kind = 'region'
    and new.spot_id is distinct from old.spot_id
  then
    raise exception
      'published card cannot move spots; create a new card version'
      using errcode = '23514';
  end if;

  if old.is_published
    and old.kind = 'region'
    and v_spot_status = 'open'
    and (
      tg_op = 'DELETE'
      or not new.is_published
      or new.kind <> 'region'
    )
  then
    raise exception
      'open spot card replacement requires draft-first transition'
      using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

drop trigger cards_preserve_acquired_response on public.cards;

create trigger cards_preserve_acquired_response
before update of
  spot_id,
  kind,
  title_ko,
  title_en,
  sketch_path,
  color_hex
on public.cards
for each row execute function private.prevent_acquired_card_response_mutation();

create trigger cards_prevent_open_spot_card_removal
before delete on public.cards
for each row execute function private.prevent_open_spot_card_removal();

create trigger cards_prevent_open_spot_card_retirement
before update of is_published, kind, spot_id on public.cards
for each row execute function private.prevent_open_spot_card_removal();

create or replace function private.enforce_acquisition_card_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_card record;
begin
  select
    card_row.is_published,
    card_row.sketch_path
  into v_card
  from public.cards as card_row
  where card_row.id = new.card_id
    and card_row.spot_id = new.spot_id
  -- FOR SHARE conflicts with a non-key UPDATE's FOR NO KEY UPDATE lock. A
  -- weaker FOR KEY SHARE lock would allow image/color write-skew around the
  -- first acquisition.
  for share of card_row;

  -- Preserve the canonical FK error for a missing/mismatched card; the
  -- composite acquisitions FK runs after this BEFORE trigger.
  if not found then
    return new;
  end if;

  if not v_card.is_published
    or v_card.sketch_path is null
    or not private.card_has_complete_translations(new.card_id)
  then
    raise exception
      'acquisition requires a published immutable six-locale card snapshot'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger regions_set_updated_at
before update on public.regions
for each row execute function private.set_updated_at();

create trigger region_translations_set_updated_at
before update on public.region_translations
for each row execute function private.set_updated_at();

create trigger spot_translations_set_updated_at
before update on public.spot_translations
for each row execute function private.set_updated_at();

create trigger card_translations_set_updated_at
before update on public.card_translations
for each row execute function private.set_updated_at();

create trigger spots_require_complete_localization
before insert or update of status, region on public.spots
for each row execute function private.enforce_spot_public_completeness();

create trigger cards_require_complete_localization
before insert or update of is_published, sketch_path, kind, spot_id on public.cards
for each row execute function private.enforce_card_public_completeness();

create trigger region_translations_guard_public_content
before update or delete on public.region_translations
for each row execute function private.guard_region_translation_mutation();

create trigger spot_translations_guard_public_content
before update or delete on public.spot_translations
for each row execute function private.guard_spot_translation_mutation();

create trigger card_translations_guard_public_content
before insert or update or delete on public.card_translations
for each row execute function private.guard_card_translation_mutation();

create trigger spots_legacy_names_read_only
before update of name_ko, name_en on public.spots
for each row execute function private.prevent_legacy_localized_mutation();

create trigger cards_zz_legacy_titles_read_only
before update of title_ko, title_en on public.cards
for each row execute function private.prevent_legacy_localized_mutation();

create trigger acquisitions_require_complete_card_snapshot
before insert or update of card_id, spot_id on public.acquisitions
for each row execute function private.enforce_acquisition_card_snapshot();

create trigger regions_bump_public_content_version
after insert or update or delete on public.regions
for each statement execute function private.bump_public_spots_content_version();

create trigger region_translations_bump_public_content_version
after insert or update or delete on public.region_translations
for each statement execute function private.bump_public_spots_content_version();

create trigger spots_bump_public_content_version
after insert or update or delete on public.spots
for each statement execute function private.bump_public_spots_content_version();

create trigger spot_translations_bump_public_content_version
after insert or update or delete on public.spot_translations
for each statement execute function private.bump_public_spots_content_version();

create trigger cards_bump_public_content_version
after insert or update or delete on public.cards
for each statement execute function private.bump_public_spots_content_version();

create trigger card_translations_bump_public_content_version
after insert or update or delete on public.card_translations
for each statement execute function private.bump_public_spots_content_version();

-- -------------------------------------------------------------------------
-- RLS, direct-table ACLs, and helper ACLs
-- -------------------------------------------------------------------------

alter table public.regions enable row level security;
alter table public.regions force row level security;
alter table public.region_translations enable row level security;
alter table public.region_translations force row level security;
alter table public.spot_translations enable row level security;
alter table public.spot_translations force row level security;
alter table public.card_translations enable row level security;
alter table public.card_translations force row level security;
alter table private.content_versions enable row level security;
alter table private.content_versions force row level security;

create policy regions_select_public
on public.regions
for select
to anon, authenticated
using (true);

create policy region_translations_select_approved
on public.region_translations
for select
to anon, authenticated
using (status = 'approved');

create policy spot_translations_select_approved
on public.spot_translations
for select
to anon, authenticated
using (
  status = 'approved'
  and exists (
    select 1
    from public.spots as spot_row
    where spot_row.id = spot_translations.spot_id
      and spot_row.status in ('teaser', 'open')
  )
);

create policy card_translations_select_approved
on public.card_translations
for select
to anon, authenticated
using (
  status = 'approved'
  and exists (
    select 1
    from public.cards as card_row
    join public.spots as spot_row on spot_row.id = card_row.spot_id
    where card_row.id = card_translations.card_id
      and card_row.is_published
      and spot_row.status = 'open'
  )
);

revoke all on table public.regions from anon, authenticated;
revoke all on table public.region_translations from anon, authenticated;
revoke all on table public.spot_translations from anon, authenticated;
revoke all on table public.card_translations from anon, authenticated;

revoke all on function private.bump_public_spots_content_version()
  from public, anon, authenticated, service_role;
revoke all on function private.region_has_complete_translations(text)
  from public, anon, authenticated, service_role;
revoke all on function private.spot_has_complete_translations(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.card_has_complete_translations(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.localized_region_name(text)
  from public, anon, authenticated, service_role;
revoke all on function private.localized_spot_name(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.localized_card_title(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.enforce_spot_public_completeness()
  from public, anon, authenticated, service_role;
revoke all on function private.enforce_card_public_completeness()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_region_translation_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_spot_translation_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_card_translation_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.prevent_legacy_localized_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.prevent_open_spot_card_removal()
  from public, anon, authenticated, service_role;
revoke all on function private.enforce_acquisition_card_snapshot()
  from public, anon, authenticated, service_role;
