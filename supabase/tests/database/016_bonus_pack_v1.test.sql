begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

-- Schema, RLS, ACL, and privileged-code boundary -------------------------

select has_table('private', 'bonus_pack_pool_versions', 'bonus pool versions exist');
select has_table('private', 'bonus_pack_pool_cards', 'bonus pool entries exist');
select has_table('private', 'bonus_packs', 'bonus pack outcome ledger exists');
select has_table('private', 'bonus_pack_qualifiers', 'bonus qualifiers exist');
select has_table('private', 'bonus_pack_open_requests', 'open idempotency ledger exists');

select ok(
  (
    select not bucket_row.public
      and bucket_row.file_size_limit = 10485760
      and bucket_row.allowed_mime_types @>
        array['image/png', 'image/jpeg', 'image/webp']::text[]
    from storage.buckets as bucket_row
    where bucket_row.id = 'special-card-assets'
  ),
  'special-card-assets is a constrained private bucket'
);

select ok(
  exists (
    select 1
    from pg_policies as policy_row
    where policy_row.schemaname = 'storage'
      and policy_row.tablename = 'objects'
      and policy_row.policyname = 'special_card_assets_deny_direct_access'
      and policy_row.permissive = 'RESTRICTIVE'
      and policy_row.roles @> array['anon', 'authenticated']::name[]
  ),
  'a restrictive Storage policy denies direct browser access to special originals'
);

select ok(
  (
    select bool_and(relation_row.relrowsecurity and relation_row.relforcerowsecurity)
    from pg_class as relation_row
    join pg_namespace as schema_row on schema_row.oid = relation_row.relnamespace
    where schema_row.nspname = 'private'
      and relation_row.relname in (
        'bonus_pack_pool_versions',
        'bonus_pack_pool_cards',
        'bonus_packs',
        'bonus_pack_qualifiers',
        'bonus_pack_open_requests'
      )
  ),
  'all bonus pack tables enable and force RLS'
);

select is(
  (
    select count(*)::bigint
    from information_schema.role_table_grants as grant_row
    where grant_row.table_schema = 'private'
      and grant_row.table_name in (
        'bonus_pack_pool_versions',
        'bonus_pack_pool_cards',
        'bonus_packs',
        'bonus_pack_qualifiers',
        'bonus_pack_open_requests'
      )
      and grant_row.grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')
  ),
  0::bigint,
  'Data API roles have no direct bonus-table privileges'
);

select ok(
  has_function_privilege(
    'service_role',
    'api_private.acquire_commit_v05(uuid,uuid,uuid,boolean,timestamptz,uuid,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'api_private.list_bonus_packs(uuid,integer,timestamptz,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'api_private.get_bonus_pack(uuid,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'api_private.open_bonus_pack(uuid,uuid,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'api_private.list_card_inventory(uuid,integer,timestamptz,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'api_private.get_owned_special_card_asset(uuid,uuid)',
    'EXECUTE'
  ),
  'service role receives the complete bonus RPC surface'
);

select is(
  (
    select count(*)::bigint
    from unnest(array['anon', 'authenticated']) as browser_role(role_name)
    cross join unnest(array[
      'api_private.acquire_commit_v05(uuid,uuid,uuid,boolean,timestamptz,uuid,text)',
      'api_private.list_bonus_packs(uuid,integer,timestamptz,uuid)',
      'api_private.get_bonus_pack(uuid,uuid)',
      'api_private.open_bonus_pack(uuid,uuid,uuid)',
      'api_private.list_card_inventory(uuid,integer,timestamptz,uuid)',
      'api_private.get_owned_special_card_asset(uuid,uuid)'
    ]) as protected_function(signature)
    where has_function_privilege(
      browser_role.role_name,
      protected_function.signature,
      'EXECUTE'
    )
  ),
  0::bigint,
  'browser roles cannot execute bonus RPCs directly'
);

select is(
  (
    select function_row.proargnames
    from pg_proc as function_row
    join pg_namespace as schema_row on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.oid =
        'api_private.list_bonus_packs(uuid,integer,timestamptz,uuid)'::regprocedure
  ),
  array[
    'p_auth_user_id',
    'p_limit',
    'p_before_issued_at',
    'p_before_bonus_pack_id'
  ]::text[],
  'pack list argument names match the PostgREST named RPC adapter'
);

select is(
  (
    select function_row.proargnames
    from pg_proc as function_row
    where function_row.oid =
      'api_private.open_bonus_pack(uuid,uuid,uuid)'::regprocedure
  ),
  array['p_auth_user_id', 'p_bonus_pack_id', 'p_client_request_id']::text[],
  'pack open argument names match the PostgREST named RPC adapter'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row on schema_row.oid = function_row.pronamespace
    where schema_row.nspname in ('private', 'api_private')
      and function_row.proname like '%bonus_pack%'
      and function_row.prosecdef
      and not (
        coalesce(function_row.proconfig, '{}'::text[])
        @> array['search_path=""']::text[]
      )
  ),
  0::bigint,
  'every bonus SECURITY DEFINER function has an empty search path'
);

select is(
  (
    select count(*)::bigint
    from generate_series(0, 9999) as roll(value)
    where private.bonus_pack_rarity_for_roll(roll.value, 0) = 'common'
  ),
  8000::bigint,
  'the complete 10,000-point boundary contains exactly 80 percent common'
);

select is(
  (
    select count(*)::bigint
    from generate_series(0, 9999) as roll(value)
    where private.bonus_pack_rarity_for_roll(roll.value, 0) = 'special'
  ),
  2000::bigint,
  'the complete 10,000-point boundary contains exactly 20 percent special'
);

select is(
  private.bonus_pack_rarity_for_roll(7999, 0),
  'common',
  'roll 7999 is common'
);
select is(
  private.bonus_pack_rarity_for_roll(8000, 0),
  'special',
  'roll 8000 is special'
);
select is(
  private.bonus_pack_rarity_for_roll(0, 4),
  'special',
  'four consecutive common packs force the next special'
);
select ok(
  not exists (
    select 1
    from generate_series(1, 500) as sample(value)
    where private.bonus_pack_random_10000() not between 0 and 9999
      or private.bonus_pack_random_bounded(7) not between 0 and 6
  ),
  'CSPRNG helpers stay inside their exact domains'
);

-- Auth identities and complete localized content -------------------------

insert into auth.users (
  id, created_at, updated_at, email, encrypted_password, email_confirmed_at,
  is_anonymous, is_sso_user, role, aud, is_super_admin, banned_until,
  raw_app_meta_data, raw_user_meta_data
) values
  (
    'e1000000-0000-4000-8000-000000000001', now(), now(),
    'bonus-admin@example.test', 'test-only-hash', now(), false, false,
    'authenticated', 'authenticated', false, null,
    '{"provider":"email","providers":["email"]}', '{}'
  ),
  (
    'e1000000-0000-4000-8000-000000000002', now(), now(),
    'bonus-owner@example.test', 'test-only-hash', now(), false, false,
    'authenticated', 'authenticated', false, null,
    '{"provider":"email","providers":["email"]}', '{}'
  ),
  (
    'e1000000-0000-4000-8000-000000000003', now(), now(),
    'bonus-other@example.test', 'test-only-hash', now(), false, false,
    'authenticated', 'authenticated', false, null,
    '{"provider":"email","providers":["email"]}', '{}'
  ),
  (
    'e1000000-0000-4000-8000-000000000004', now(), now(),
    'bonus-guarantee@example.test', 'test-only-hash', now(), false, false,
    'authenticated', 'authenticated', false, null,
    '{"provider":"email","providers":["email"]}', '{}'
  );

create temp table bonus_users on commit drop as
select
  (
    select identity_row.user_id
    from private.user_identities as identity_row
    where identity_row.auth_user_id = 'e1000000-0000-4000-8000-000000000002'
      and identity_row.revoked_at is null
  ) as owner_user_id,
  (
    select identity_row.user_id
    from private.user_identities as identity_row
    where identity_row.auth_user_id = 'e1000000-0000-4000-8000-000000000003'
      and identity_row.revoked_at is null
  ) as other_user_id,
  (
    select identity_row.user_id
    from private.user_identities as identity_row
    where identity_row.auth_user_id = 'e1000000-0000-4000-8000-000000000004'
      and identity_row.revoked_at is null
  ) as guarantee_user_id;

insert into private.minimum_age_attestations (
  user_id, minimum_age_passed, version
)
select owner_user_id, true, '18plus-v1' from bonus_users
union all
select other_user_id, true, '18plus-v1' from bonus_users
union all
select guarantee_user_id, true, '18plus-v1' from bonus_users;

insert into public.regions (code, country_code, sort_order)
values ('bonus-test-region', 'KR', 900);

insert into public.region_translations (
  region_code, locale, name, status, approved_at, approved_by
)
select
  'bonus-test-region',
  locale_row.locale,
  'Bonus Test Region',
  'approved',
  now(),
  'e1000000-0000-4000-8000-000000000001'
from unnest(enum_range(null::public.content_locale)) as locale_row(locale);

insert into public.spots (
  id, slug, region, name_ko, name_en, status,
  latitude, longitude, radius_m, accuracy_threshold_m, sort_order
) values
  (
    'e2000000-0000-4000-8000-000000000001',
    'bonus-test-one', 'bonus-test-region', '보너스 시험 1', 'Bonus Test One',
    'draft', 37.5001, 126.9001, 150, 200, 1
  ),
  (
    'e2000000-0000-4000-8000-000000000002',
    'bonus-test-two', 'bonus-test-region', '보너스 시험 2', 'Bonus Test Two',
    'draft', 37.5002, 126.9002, 150, 200, 2
  );

insert into public.spot_translations (
  spot_id, locale, name, status, approved_at, approved_by
)
select
  spot_row.id,
  locale_row.locale,
  spot_row.name_en,
  'approved',
  now(),
  'e1000000-0000-4000-8000-000000000001'
from public.spots as spot_row
cross join unnest(enum_range(null::public.content_locale)) as locale_row(locale)
where spot_row.id in (
  'e2000000-0000-4000-8000-000000000001',
  'e2000000-0000-4000-8000-000000000002'
);

insert into public.cards (
  id, spot_id, code, kind, title_ko, title_en,
  sketch_path, color_hex, is_published
) values
  (
    'e3000000-0000-4000-8000-000000000001',
    'e2000000-0000-4000-8000-000000000001',
    'bonus-common-one', 'region', '일반 카드 1', 'Common Card One',
    'tests/bonus-common-one.webp', '#B77A7A', false
  ),
  (
    'e3000000-0000-4000-8000-000000000002',
    'e2000000-0000-4000-8000-000000000002',
    'bonus-common-two', 'region', '일반 카드 2', 'Common Card Two',
    'tests/bonus-common-two.webp', '#B77A7B', false
  ),
  (
    'e3000000-0000-4000-8000-000000000003',
    'e2000000-0000-4000-8000-000000000001',
    'bonus-special-one', 'special', '특별 카드 1', 'Special Card One',
    'tests/bonus-special-one.webp', '#8F6DB1', false
  ),
  (
    'e3000000-0000-4000-8000-000000000004',
    'e2000000-0000-4000-8000-000000000002',
    'bonus-special-two', 'special', '특별 카드 2', 'Special Card Two',
    'tests/bonus-special-two.webp', '#8F6DB2', false
  ),
  (
    'e3000000-0000-4000-8000-000000000005',
    'e2000000-0000-4000-8000-000000000001',
    'bonus-limited-rejected', 'limited', '한정 카드', 'Limited Card',
    'tests/bonus-limited.webp', '#777777', false
  );

insert into public.card_translations (
  card_id, locale, title, status, approved_at, approved_by
)
select
  card_row.id,
  locale_row.locale,
  card_row.title_en,
  'approved',
  now(),
  'e1000000-0000-4000-8000-000000000001'
from public.cards as card_row
cross join unnest(enum_range(null::public.content_locale)) as locale_row(locale)
where card_row.id in (
  'e3000000-0000-4000-8000-000000000001',
  'e3000000-0000-4000-8000-000000000002',
  'e3000000-0000-4000-8000-000000000003',
  'e3000000-0000-4000-8000-000000000004',
  'e3000000-0000-4000-8000-000000000005'
);

select throws_ok(
  $$
    update public.cards
    set is_published = true, published_at = now()
    where id = 'e3000000-0000-4000-8000-000000000003'
  $$,
  '23514',
  'published special cards require a private special-card asset',
  'a special card cannot publish before its private original exists'
);

insert into storage.objects (bucket_id, name, owner, version)
values
  (
    'special-card-assets',
    'tests/bonus-special-one.webp',
    null,
    'bonus-special-one-v1'
  ),
  (
    'special-card-assets',
    'tests/bonus-special-two.webp',
    null,
    'bonus-special-two-v1'
  );

select throws_ok(
  $$
    insert into storage.objects (bucket_id, name, owner, version)
    values (
      'card-assets',
      'tests/bonus-special-one.webp',
      null,
      'public-special-copy'
    )
  $$,
  '23514',
  'special card assets cannot exist in the public card bucket',
  'a special-card path cannot be copied into public Storage'
);

update public.cards
set is_published = true, published_at = now()
where id in (
  'e3000000-0000-4000-8000-000000000001',
  'e3000000-0000-4000-8000-000000000002',
  'e3000000-0000-4000-8000-000000000003',
  'e3000000-0000-4000-8000-000000000004',
  'e3000000-0000-4000-8000-000000000005'
);

select throws_ok(
  $$
    delete from storage.objects
    where bucket_id = 'special-card-assets'
      and name = 'tests/bonus-special-one.webp'
  $$,
  '42501',
  'Direct deletion from storage tables is not allowed. Use the Storage API instead.',
  'direct SQL cannot remove a referenced private special original'
);

update public.spots
set status = 'open'
where id in (
  'e2000000-0000-4000-8000-000000000001',
  'e2000000-0000-4000-8000-000000000002'
);

insert into private.bonus_pack_pool_versions (
  id, region_code, version_code
) values
  (
    'e4000000-0000-4000-8000-000000000001',
    'bonus-test-region',
    'bonus-test-v1'
  ),
  (
    'e4000000-0000-4000-8000-000000000002',
    'bonus-test-region',
    'bonus-test-draft'
  );

select throws_ok(
  $$
    insert into private.bonus_pack_pool_cards (
      pool_version_id, card_id, rarity
    ) values (
      'e4000000-0000-4000-8000-000000000002',
      'e3000000-0000-4000-8000-000000000005',
      'common'
    )
  $$,
  '23514',
  'bonus pack rarity must match the card kind',
  'limited cards cannot enter the ordinary reward pool'
);

insert into private.bonus_pack_pool_cards (
  pool_version_id, card_id, rarity, sort_order
) values
  (
    'e4000000-0000-4000-8000-000000000001',
    'e3000000-0000-4000-8000-000000000001',
    'common', 1
  ),
  (
    'e4000000-0000-4000-8000-000000000001',
    'e3000000-0000-4000-8000-000000000002',
    'common', 2
  ),
  (
    'e4000000-0000-4000-8000-000000000001',
    'e3000000-0000-4000-8000-000000000003',
    'special', 1
  ),
  (
    'e4000000-0000-4000-8000-000000000001',
    'e3000000-0000-4000-8000-000000000004',
    'special', 2
  );

update private.bonus_pack_pool_versions
set published_at = clock_timestamp()
where id = 'e4000000-0000-4000-8000-000000000001';

insert into public.regions (code, country_code, sort_order)
values ('bonus-test-other-region', 'KR', 901);

select throws_ok(
  $$
    update public.spots
    set region = 'bonus-test-other-region'
    where id = 'e2000000-0000-4000-8000-000000000001'
  $$,
  '23514',
  'published bonus pack spots cannot move regions; create a new pool version',
  'a published pool cannot drift when its card spot changes region'
);

select throws_ok(
  $$
    update private.bonus_pack_pool_cards
    set pool_version_id = 'e4000000-0000-4000-8000-000000000002'
    where pool_version_id = 'e4000000-0000-4000-8000-000000000001'
      and card_id = 'e3000000-0000-4000-8000-000000000001'
  $$,
  '23514',
  'bonus pack pool entry identity is immutable',
  'published entries cannot be moved into a draft pool'
);

select throws_ok(
  $$
    delete from private.bonus_pack_pool_versions
    where id = 'e4000000-0000-4000-8000-000000000001'
  $$,
  '23514',
  'published or used bonus pack pools cannot be deleted',
  'published pools are append-only'
);

select throws_ok(
  $$
    update public.card_translations
    set title = 'Changed after pool publication', approved_at = clock_timestamp()
    where card_id = 'e3000000-0000-4000-8000-000000000003'
      and locale = 'en'
  $$,
  '23514',
  'published bonus pack card translations are immutable',
  'published special translations cannot drift'
);

-- Test-only field acquisition constructor. It uses the real post-cutover
-- pending location fact required by the acquisition trigger.
create function pg_temp.make_bonus_field_acquisition(
  p_user_id uuid,
  p_spot_id uuid,
  p_card_id uuid,
  p_date_kst date,
  p_sequence bigint
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
  v_key uuid := gen_random_uuid();
  v_at timestamptz := (
    p_date_kst::timestamp + interval '12 hours'
  ) at time zone 'Asia/Seoul'
    + (p_sequence * interval '1 microsecond');
begin
  insert into private.location_use_facts (
    user_id, idempotency_key, spot_id, purpose,
    collected_at, outcome, terminal_failure_details
  ) values (
    p_user_id, v_key, p_spot_id, 'field_acquisition',
    v_at - interval '1 minute', 'pending', '{}'::jsonb
  );

  insert into public.acquisitions (
    id, user_id, spot_id, card_id, acquisition_type,
    verification_result, idempotency_key, field_sequence, acquired_at
  ) values (
    v_id, p_user_id, p_spot_id, p_card_id, 'field',
    'passed', v_key, p_sequence, v_at
  );
  return v_id;
end;
$$;

-- Feature flag, one-per-day, and correction semantics --------------------

create temp table owner_acquisitions (
  label text primary key,
  acquisition_id uuid not null
) on commit drop;

insert into owner_acquisitions values (
  'off',
  pg_temp.make_bonus_field_acquisition(
    (select owner_user_id from bonus_users),
    'e2000000-0000-4000-8000-000000000001',
    'e3000000-0000-4000-8000-000000000001',
    '2026-09-01',
    1001
  )
);
select is(
  private.issue_field_daily_bonus_pack(
    (select owner_user_id from bonus_users),
    (select acquisition_id from owner_acquisitions where label = 'off'),
    'off'
  ),
  null::uuid,
  'issuance off creates no pack'
);

insert into owner_acquisitions values (
  'off-second-same-day',
  pg_temp.make_bonus_field_acquisition(
    (select owner_user_id from bonus_users),
    'e2000000-0000-4000-8000-000000000002',
    'e3000000-0000-4000-8000-000000000002',
    '2026-09-01',
    1011
  )
);
select is(
  private.issue_field_daily_bonus_pack(
    (select owner_user_id from bonus_users),
    (
      select acquisition_id from owner_acquisitions
      where label = 'off-second-same-day'
    ),
    'public'
  ),
  null::uuid,
  'a later same-day visit cannot backfill a pack after the first visit ran with issuance off'
);

insert into owner_acquisitions values (
  'participants-closed',
  pg_temp.make_bonus_field_acquisition(
    (select owner_user_id from bonus_users),
    'e2000000-0000-4000-8000-000000000001',
    'e3000000-0000-4000-8000-000000000001',
    '2026-09-02',
    1002
  )
);
select is(
  private.issue_field_daily_bonus_pack(
    (select owner_user_id from bonus_users),
    (select acquisition_id from owner_acquisitions where label = 'participants-closed'),
    'participants'
  ),
  null::uuid,
  'participant-scoped issuance remains closed without active access'
);

insert into owner_acquisitions values
  (
    'daily-issuer',
    pg_temp.make_bonus_field_acquisition(
      (select owner_user_id from bonus_users),
      'e2000000-0000-4000-8000-000000000001',
      'e3000000-0000-4000-8000-000000000001',
      '2026-09-03',
      1003
    )
  ),
  (
    'daily-second',
    pg_temp.make_bonus_field_acquisition(
      (select owner_user_id from bonus_users),
      'e2000000-0000-4000-8000-000000000002',
      'e3000000-0000-4000-8000-000000000002',
      '2026-09-03',
      1004
    )
  );

create temp table owner_daily_pack on commit drop as
select private.issue_field_daily_bonus_pack(
  (select owner_user_id from bonus_users),
  (select acquisition_id from owner_acquisitions where label = 'daily-issuer'),
  'public'
) as pack_id;

select is(
  private.issue_field_daily_bonus_pack(
    (select owner_user_id from bonus_users),
    (select acquisition_id from owner_acquisitions where label = 'daily-second'),
    'public'
  ),
  (select pack_id from owner_daily_pack),
  'a second same-day place links to the existing account-wide pack'
);

select is(
  (
    select count(*)::bigint
    from private.bonus_packs
    where user_id = (select owner_user_id from bonus_users)
  ),
  1::bigint,
  'off, participant-closed, and second same-day visits do not add packs'
);

select is(
  (
    select count(*)::bigint
    from private.bonus_pack_qualifiers
    where pack_id = (select pack_id from owner_daily_pack)
  ),
  2::bigint,
  'all same-day valid field visits qualify the same pack'
);

select is(
  (
    select count(*)::bigint
    from private.bonus_pack_qualifiers
    where pack_id = (select pack_id from owner_daily_pack)
      and is_issuing_qualifier
  ),
  1::bigint,
  'exactly one acquisition owns the immutable acquire envelope'
);

select is(
  (
    select array_agg(key_name order by key_name)
    from jsonb_object_keys(private.bonus_pack_acquire_projection(
      (select acquisition_id from owner_acquisitions where label = 'daily-issuer')
    )) as key_row(key_name)
  ),
  array['date_kst', 'id', 'issued_at', 'status']::text[],
  'acquire projection is sealed and contains no outcome or guarantee metadata'
);

delete from public.acquisitions
where id = (select acquisition_id from owner_acquisitions where label = 'daily-issuer');
select ok(
  exists (
    select 1 from private.bonus_packs
    where id = (select pack_id from owner_daily_pack)
  ),
  'correcting the issuer keeps the pack while another qualifier remains'
);
select is(
  (
    select count(*)::bigint
    from private.bonus_pack_qualifiers
    where pack_id = (select pack_id from owner_daily_pack)
      and is_issuing_qualifier
  ),
  1::bigint,
  'issuer correction promotes exactly one remaining qualifier'
);
select is(
  private.bonus_pack_acquire_projection(
    (select acquisition_id from owner_acquisitions where label = 'daily-second')
  ) ->> 'id',
  (select pack_id::text from owner_daily_pack),
  'promoted acquisition replay returns the same preserved pack'
);

delete from public.acquisitions
where id = (select acquisition_id from owner_acquisitions where label = 'daily-second');
select ok(
  not exists (
    select 1 from private.bonus_packs
    where id = (select pack_id from owner_daily_pack)
  ),
  'correcting the final qualifier removes the location-derived pack'
);

-- Four commons, guaranteed fifth, missing-special priority ---------------

create temp table guarantee_first_streak (
  day_no integer primary key,
  acquired_on date not null,
  acquisition_id uuid not null,
  pack_id uuid not null
) on commit drop;

insert into guarantee_first_streak (
  day_no, acquired_on, acquisition_id, pack_id
)
select
  day_row.day_no,
  ('2026-10-01'::date + ((day_row.day_no - 1) * 2))::date,
  pg_temp.make_bonus_field_acquisition(
    (select guarantee_user_id from bonus_users),
    'e2000000-0000-4000-8000-000000000001',
    'e3000000-0000-4000-8000-000000000001',
    ('2026-10-01'::date + ((day_row.day_no - 1) * 2))::date,
    2000 + day_row.day_no
  ),
  gen_random_uuid()
from generate_series(1, 4) as day_row(day_no);

insert into private.bonus_packs (
  id, user_id, issuance_kind, issued_on_kst, pool_version_id,
  result_card_id, result_rarity, rarity_roll, selection_roll,
  guarantee_applied, state, issued_at
)
select
  streak.pack_id,
  (select guarantee_user_id from bonus_users),
  'field_daily',
  streak.acquired_on,
  'e4000000-0000-4000-8000-000000000001',
  case when streak.day_no = 1
    then 'e3000000-0000-4000-8000-000000000002'::uuid
    else 'e3000000-0000-4000-8000-000000000001'::uuid
  end,
  'common',
  0,
  0,
  false,
  'sealed',
  clock_timestamp() - ((5 - streak.day_no) * interval '1 hour')
from guarantee_first_streak as streak;

insert into private.bonus_pack_qualifiers (
  pack_id, acquisition_id, user_id, is_issuing_qualifier
)
select
  streak.pack_id,
  streak.acquisition_id,
  (select guarantee_user_id from bonus_users),
  true
from guarantee_first_streak as streak;

create temp table first_guaranteed on commit drop as
select
  pg_temp.make_bonus_field_acquisition(
    (select guarantee_user_id from bonus_users),
    'e2000000-0000-4000-8000-000000000001',
    'e3000000-0000-4000-8000-000000000001',
    '2026-10-10',
    2005
  ) as acquisition_id;

alter table first_guaranteed add column pack_id uuid;
update first_guaranteed
set pack_id = private.issue_field_daily_bonus_pack(
  (select guarantee_user_id from bonus_users),
  acquisition_id,
  'public'
);

select ok(
  (
    select pack_row.guarantee_applied
      and pack_row.result_rarity = 'special'
    from private.bonus_packs as pack_row
    where pack_row.id = (select pack_id from first_guaranteed)
  ),
  'the fifth pack is special after four commons even when dates have gaps'
);

create temp table first_special_card on commit drop as
select result_card_id as card_id
from private.bonus_packs
where id = (select pack_id from first_guaranteed);

-- A fresh four-common streak after the first special guarantees another one.
create temp table guarantee_second_streak (
  day_no integer primary key,
  acquired_on date not null,
  acquisition_id uuid not null,
  pack_id uuid not null
) on commit drop;

insert into guarantee_second_streak (
  day_no, acquired_on, acquisition_id, pack_id
)
select
  day_row.day_no,
  ('2026-10-11'::date + day_row.day_no - 1)::date,
  pg_temp.make_bonus_field_acquisition(
    (select guarantee_user_id from bonus_users),
    'e2000000-0000-4000-8000-000000000001',
    'e3000000-0000-4000-8000-000000000001',
    ('2026-10-11'::date + day_row.day_no - 1)::date,
    2010 + day_row.day_no
  ),
  gen_random_uuid()
from generate_series(1, 4) as day_row(day_no);

insert into private.bonus_packs (
  id, user_id, issuance_kind, issued_on_kst, pool_version_id,
  result_card_id, result_rarity, rarity_roll, selection_roll,
  guarantee_applied, state, issued_at
)
select
  streak.pack_id,
  (select guarantee_user_id from bonus_users),
  'field_daily',
  streak.acquired_on,
  'e4000000-0000-4000-8000-000000000001',
  'e3000000-0000-4000-8000-000000000001',
  'common', 0, 0, false, 'sealed',
  (streak.acquired_on::timestamp + interval '12 hours') at time zone 'Asia/Seoul'
from guarantee_second_streak as streak;

insert into private.bonus_pack_qualifiers (
  pack_id, acquisition_id, user_id, is_issuing_qualifier
)
select
  streak.pack_id,
  streak.acquisition_id,
  (select guarantee_user_id from bonus_users),
  true
from guarantee_second_streak as streak;

create temp table second_guaranteed on commit drop as
select
  pg_temp.make_bonus_field_acquisition(
    (select guarantee_user_id from bonus_users),
    'e2000000-0000-4000-8000-000000000001',
    'e3000000-0000-4000-8000-000000000001',
    '2026-10-15',
    2015
  ) as acquisition_id;

alter table second_guaranteed add column pack_id uuid;
update second_guaranteed
set pack_id = private.issue_field_daily_bonus_pack(
  (select guarantee_user_id from bonus_users),
  acquisition_id,
  'public'
);

select ok(
  (
    select pack_row.guarantee_applied
      and pack_row.result_rarity = 'special'
      and pack_row.result_card_id <> (select card_id from first_special_card)
    from private.bonus_packs as pack_row
    where pack_row.id = (select pack_id from second_guaranteed)
  ),
  'guaranteed special prioritizes an unowned special before duplicates'
);

-- Sealed no-leak, reveal idempotency, inventory, and asset ownership -------

select throws_ok(
  $$
    insert into public.acquisitions (
      user_id, spot_id, card_id, acquisition_type, verification_result,
      idempotency_key, field_sequence, acquired_at
    ) values (
      (select other_user_id from bonus_users),
      'e2000000-0000-4000-8000-000000000001',
      'e3000000-0000-4000-8000-000000000003',
      'gift', 'not_applicable', gen_random_uuid(), null, now()
    )
  $$,
  '23514',
  'special cards may only originate from opened bonus packs',
  'new acquisitions cannot mint special cards'
);

insert into public.acquisitions (
  id, user_id, spot_id, card_id, acquisition_type, verification_result,
  idempotency_key, field_sequence, acquired_at
) values (
  'e7000000-0000-4000-8000-000000000003',
  (select other_user_id from bonus_users),
  'e2000000-0000-4000-8000-000000000001',
  'e3000000-0000-4000-8000-000000000005',
  'gift', 'not_applicable',
  'e7000000-0000-4000-8000-000000000004',
  null,
  now() - interval '1 minute'
);

insert into public.acquisitions (
  id, user_id, spot_id, card_id, acquisition_type, verification_result,
  idempotency_key, field_sequence, acquired_at
) values (
  'e7000000-0000-4000-8000-000000000005',
  (select other_user_id from bonus_users),
  'e2000000-0000-4000-8000-000000000001',
  'e3000000-0000-4000-8000-000000000001',
  'gift', 'not_applicable',
  'e7000000-0000-4000-8000-000000000006',
  null,
  now() - interval '2 minutes'
);

-- Simulate an impossible historical/corrupt special acquisition to prove
-- both read boundaries still fail closed rather than trusting provenance.
set local session_replication_role = replica;
insert into public.acquisitions (
  id, user_id, spot_id, card_id, acquisition_type, verification_result,
  idempotency_key, field_sequence, acquired_at
) values (
  'e7000000-0000-4000-8000-000000000001',
  (select other_user_id from bonus_users),
  'e2000000-0000-4000-8000-000000000001',
  'e3000000-0000-4000-8000-000000000003',
  'gift', 'not_applicable',
  'e7000000-0000-4000-8000-000000000002',
  null,
  now()
);
set local session_replication_role = origin;

select is(
  api_private.get_published_card_asset((select card_id from first_special_card)),
  null::text,
  'the unauthenticated public asset RPC never returns special art'
);

select is(
  api_private.get_owned_special_card_asset(
    'e1000000-0000-4000-8000-000000000004',
    (select card_id from first_special_card)
  ) ->> 'status',
  'not_found',
  'a sealed special result does not authorize its asset'
);

create temp table sealed_detail on commit drop as
select api_private.get_bonus_pack(
  'e1000000-0000-4000-8000-000000000004',
  (select pack_id from first_guaranteed)
) as result;

select is(
  (select result #>> '{bonus_pack,status}' from sealed_detail),
  'sealed',
  'detail reports an unopened pack as sealed'
);
select ok(
  not ((select result -> 'bonus_pack' from sealed_detail) ?| array[
    'card', 'opened_at', 'rarity', 'result', 'guarantee_applied'
  ]),
  'sealed detail contains no result, rarity, or guarantee fields'
);

create temp table first_open on commit drop as
select api_private.open_bonus_pack(
  'e1000000-0000-4000-8000-000000000004',
  (select pack_id from first_guaranteed),
  'e5000000-0000-4000-8000-000000000001'
) as result;

select ok(
  (select result ->> 'status' = 'ready' from first_open)
    and (select result #>> '{bonus_pack,status}' = 'opened' from first_open)
    and (select result #>> '{bonus_pack,card,rarity}' = 'special' from first_open),
  'opening reveals the already-fixed special result'
);
select ok(
  not ((select result -> 'bonus_pack' from first_open) ? 'guarantee_applied'),
  'opened public projection still hides pity internals'
);

create temp table open_replay on commit drop as
select api_private.open_bonus_pack(
  'e1000000-0000-4000-8000-000000000004',
  (select pack_id from first_guaranteed),
  'e5000000-0000-4000-8000-000000000001'
) as result;

select is(
  (select result -> 'bonus_pack' from open_replay),
  (select result -> 'bonus_pack' from first_open),
  'same open request replays the identical reveal'
);

select is(
  api_private.open_bonus_pack(
    'e1000000-0000-4000-8000-000000000004',
    (select pack_id from first_guaranteed),
    'e5000000-0000-4000-8000-000000000002'
  ) ->> 'status',
  'ready',
  'an already-opened pack returns its result for a new request UUID'
);
select is(
  (
    select count(*)::bigint
    from private.bonus_pack_open_requests
    where pack_id = (select pack_id from first_guaranteed)
  ),
  1::bigint,
  'already-opened retries do not grow the idempotency ledger'
);

select is(
  api_private.open_bonus_pack(
    'e1000000-0000-4000-8000-000000000004',
    (select pack_id from second_guaranteed),
    'e5000000-0000-4000-8000-000000000001'
  ) ->> 'status',
  'idempotency_conflict',
  'an open request UUID cannot be reused for another pack'
);

select is(
  api_private.get_owned_special_card_asset(
    'e1000000-0000-4000-8000-000000000004',
    (select card_id from first_special_card)
  ) ->> 'status',
  'found',
  'opened special owner receives the protected asset path'
);

select is(
  api_private.get_owned_special_card_asset(
    'e1000000-0000-4000-8000-000000000004',
    (select card_id from first_special_card)
  ) ->> 'bucket',
  'special-card-assets',
  'owned special assets identify only the private special bucket'
);

select is(
  api_private.get_owned_special_card_asset(
    'e1000000-0000-4000-8000-000000000003',
    (select card_id from first_special_card)
  ) ->> 'status',
  'not_found',
  'another active adult cannot fetch the opened owner special asset'
);

create temp table common_open on commit drop as
select api_private.open_bonus_pack(
  'e1000000-0000-4000-8000-000000000004',
  (select pack_id from guarantee_first_streak where day_no = 1),
  'e5000000-0000-4000-8000-000000000003'
) as result;

update public.spots
set status = 'paused'
where id = 'e2000000-0000-4000-8000-000000000002';

select is(
  api_private.get_published_card_asset(
    'e3000000-0000-4000-8000-000000000002'
  ),
  'tests/bonus-common-two.webp',
  'an opened common bonus result remains fetchable after its spot pauses'
);

update public.spots
set status = 'open'
where id = 'e2000000-0000-4000-8000-000000000002';

select is(
  jsonb_array_length(
    api_private.list_card_inventory(
      'e1000000-0000-4000-8000-000000000003',
      100,
      null,
      null
    ) -> 'items'
  ),
  2,
  'a corrupt direct special acquisition is excluded while legitimate non-special cards remain'
);

select ok(
  exists (
    select 1
    from jsonb_array_elements(
      api_private.list_card_inventory(
        'e1000000-0000-4000-8000-000000000003',
        100,
        null,
        null
      ) -> 'items'
    ) as item_row(item)
    where item_row.item #>> '{card,id}' =
      'e3000000-0000-4000-8000-000000000005'
      and item_row.item #>> '{card,rarity}' = 'common'
  ),
  'legitimate acquired limited cards remain visible as ordinary inventory'
);

create temp table limited_inventory_page on commit drop as
select api_private.list_card_inventory(
  'e1000000-0000-4000-8000-000000000003',
  1,
  null,
  null
) as result;

select ok(
  (select (result ->> 'has_more')::boolean from limited_inventory_page)
    and (
      select result #>> '{items,0,card,id}' =
        'e3000000-0000-4000-8000-000000000005'
      from limited_inventory_page
    )
    and (
      select result #>> '{next_anchor,card_id}' =
        'e3000000-0000-4000-8000-000000000005'
      from limited_inventory_page
    ),
  'limited acquisitions participate consistently in inventory pagination'
);

select is(
  (
    select api_private.list_card_inventory(
      'e1000000-0000-4000-8000-000000000003',
      1,
      (result #>> '{next_anchor,last_acquired_at}')::timestamptz,
      (result #>> '{next_anchor,card_id}')::uuid
    ) #>> '{items,0,card,id}'
    from limited_inventory_page
  ),
  'e3000000-0000-4000-8000-000000000001',
  'inventory cursor continues after a limited-card first page'
);

create temp table pack_list on commit drop as
select api_private.list_bonus_packs(
  'e1000000-0000-4000-8000-000000000004',
  100,
  null,
  null
) as result;

select is(
  (select (result ->> 'sealed_count')::integer from pack_list),
  (
    select count(*)::integer
    from private.bonus_packs
    where user_id = (select guarantee_user_id from bonus_users)
      and state = 'sealed'
  ),
  'list sealed_count is account-wide and independent of page size'
);
select is(
  api_private.list_bonus_packs(
    'e1000000-0000-4000-8000-000000000004', 101, null, null
  ) ->> 'status',
  'invalid',
  'pack list rejects a limit above 100'
);

create temp table inventory_result on commit drop as
select api_private.list_card_inventory(
  'e1000000-0000-4000-8000-000000000004',
  100,
  null,
  null
) as result;

select ok(
  exists (
    select 1
    from jsonb_array_elements(
      (select result -> 'items' from inventory_result)
    ) as item_row(item)
    where item_row.item #>> '{card,id}' = (select card_id::text from first_special_card)
      and item_row.item #>> '{card,rarity}' = 'special'
      and (item_row.item ->> 'quantity')::integer >= 1
  ),
  'opened bonus result appears in quantity-stacked inventory'
);

select throws_ok(
  format(
    'update private.bonus_packs set result_card_id = %L where id = %L',
    'e3000000-0000-4000-8000-000000000004',
    (select pack_id from first_guaranteed)
  ),
  '23514',
  'bonus pack outcomes are immutable after issuance',
  'an awarded result cannot be rerolled by update'
);

select throws_ok(
  format(
    'delete from private.bonus_packs where id = %L',
    (select pack_id from first_guaranteed)
  ),
  '23514',
  'bonus pack outcomes cannot be deleted directly',
  'an awarded pack cannot be removed outside correction, deletion, or reviewer cleanup'
);

-- Reviewer fixture cleanup uses a private marker and never touches field stats.
insert into private.bonus_packs (
  id, user_id, issuance_kind, issued_on_kst, pool_version_id,
  result_card_id, result_rarity, rarity_roll, selection_roll,
  guarantee_applied, state, issued_at
) values (
  'e6000000-0000-4000-8000-000000000001',
  (select other_user_id from bonus_users),
  'reviewer_fixture',
  '2026-11-01',
  'e4000000-0000-4000-8000-000000000001',
  'e3000000-0000-4000-8000-000000000003',
  'special', 9999, 0, false, 'sealed', now()
);

select lives_ok(
  format(
    'select private.cleanup_reviewer_bonus_pack_fixture(%L)',
    (select other_user_id from bonus_users)
  ),
  'reviewer reset/revoke cleanup can remove only its deterministic fixture pack'
);
select ok(
  not exists (
    select 1
    from private.bonus_packs
    where id = 'e6000000-0000-4000-8000-000000000001'
  ),
  'reviewer fixture cleanup leaves no reviewer bonus pack'
);

select * from finish();
rollback;
