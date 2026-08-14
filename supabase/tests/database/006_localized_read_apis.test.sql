begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

-- Schema, RLS, and ACL boundary ------------------------------------------

select results_eq(
  $$
    select migration_row.version::text
    from supabase_migrations.schema_migrations as migration_row
    where migration_row.version in (
      '20260811164317',
      '20260811164318',
      '20260811164320'
    )
    order by migration_row.version
  $$,
  $$
    values
      ('20260811164317'::text),
      ('20260811164318'::text),
      ('20260811164320'::text)
  $$,
  'share privacy cutover precedes localization and localized RPCs'
);

select set_eq(
  $$ select unnest(enum_range(null::public.content_locale))::text $$,
  $$
    values
      ('ko'::text),
      ('en'::text),
      ('ja'::text),
      ('zh-Hans'::text),
      ('zh-Hant'::text),
      ('vi'::text)
  $$,
  'content locale is exactly the six contracted values'
);

select set_eq(
  $$ select unnest(enum_range(null::public.translation_status))::text $$,
  $$ values ('draft'::text), ('approved'::text) $$,
  'translation status is draft or approved'
);

select set_eq(
  $$
    select table_name::text
    from information_schema.tables
    where table_schema = 'public'
      and table_name in (
        'regions',
        'region_translations',
        'spot_translations',
        'card_translations'
      )
  $$,
  $$
    values
      ('regions'::text),
      ('region_translations'::text),
      ('spot_translations'::text),
      ('card_translations'::text)
  $$,
  'all localized content tables exist'
);

select has_index(
  'public',
  'spots',
  'spots_region_idx_v03',
  'the regions foreign key has a full supporting child index'
);

select has_index(
  'public',
  'acquisitions',
  'acquisitions_user_page_idx',
  'collection pagination has a deterministic covering order index'
);

select hasnt_index(
  'public',
  'acquisitions',
  'acquisitions_user_acquired_idx',
  'the redundant acquisition pagination prefix index is removed'
);

select is(
  (
    select count(*)::bigint
    from pg_class as relation_row
    join pg_namespace as schema_row
      on schema_row.oid = relation_row.relnamespace
    where (
      (
        schema_row.nspname = 'public'
        and relation_row.relname in (
          'regions',
          'region_translations',
          'spot_translations',
          'card_translations'
        )
      ) or (
        schema_row.nspname = 'private'
        and relation_row.relname = 'content_versions'
      )
    )
      and relation_row.relrowsecurity
      and relation_row.relforcerowsecurity
  ),
  5::bigint,
  'localized and content-version tables enable and force RLS'
);

select is(
  (
    select count(*)::bigint
    from unnest(array['anon', 'authenticated']) as browser_role(role_name)
    cross join unnest(array[
      'public.regions',
      'public.region_translations',
      'public.spot_translations',
      'public.card_translations'
    ]) as relation_name
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
      as privilege_name
    where has_table_privilege(
      browser_role.role_name,
      relation_name,
      privilege_name
    )
  ),
  0::bigint,
  'browser roles have no direct localized-table privileges'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname in (
        'list_public_spots',
        'get_user_collection',
        'get_owned_personal_card_photo',
        'get_public_share'
      )
  ),
  4::bigint,
  'all localized read RPCs exist without stale overloads'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname in (
        'list_public_spots',
        'get_user_collection',
        'get_owned_personal_card_photo',
        'get_public_share'
      )
      and function_row.prosecdef
      and coalesce(function_row.proconfig, array[]::text[])
        @> array['search_path=""']::text[]
      and has_function_privilege('service_role', function_row.oid, 'EXECUTE')
  ),
  4::bigint,
  'localized read RPCs are hardened and service-role executable'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    cross join unnest(array['anon', 'authenticated'])
      as browser_role(role_name)
    where schema_row.nspname = 'api_private'
      and function_row.proname in (
        'list_public_spots',
        'get_user_collection',
        'get_owned_personal_card_photo',
        'get_public_share'
      )
      and has_function_privilege(
        browser_role.role_name,
        function_row.oid,
        'EXECUTE'
      )
  ),
  0::bigint,
  'browser roles cannot execute localized read RPCs'
);

select ok(
  (
    select relation_row.relhastriggers
    from pg_class as relation_row
    where relation_row.oid = 'public.personal_cards'::regclass
  ) and exists (
    select 1
    from pg_trigger as trigger_row
    where trigger_row.tgrelid = 'public.personal_cards'::regclass
      and trigger_row.tgname =
        'personal_cards_enforce_share_moderation_state'
      and trigger_row.tgenabled = 'O'
  ),
  'share moderation state and audited-transition enforcement is enabled'
);

select ok(
  (
    select
      lower(pg_get_functiondef(function_row.oid))
        like '%for share of card_row%'
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'private'
      and function_row.proname = 'enforce_acquisition_card_snapshot'
  ),
  'first acquisition takes a lock that conflicts with non-key card updates'
);

select ok(
  (
    select
      lower(pg_get_functiondef(function_row.oid)) like '%public.regions%'
      and lower(pg_get_functiondef(function_row.oid))
        like '%for update of region_row%'
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'private'
      and function_row.proname = 'enforce_spot_public_completeness'
  ),
  'public spot transition serializes with region translation mutation'
);

select ok(
  (
    select
      strpos(
        pg_get_functiondef(function_row.oid),
        'for share of card_row'
      ) > 0
      and strpos(
        pg_get_functiondef(function_row.oid),
        'for share of card_row'
      ) < strpos(
        pg_get_functiondef(function_row.oid),
        'for share of spot_row'
      )
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname = 'acquire_commit_after_location_compliance'
  ),
  'acquire commit locks card before spot configuration'
);

-- Fixtures ---------------------------------------------------------------

insert into auth.users (
  id,
  created_at,
  updated_at,
  is_anonymous,
  raw_user_meta_data
)
values
  ('a3000000-0000-4000-8000-000000000001', now(), now(), false, '{}'),
  ('a3000000-0000-4000-8000-000000000002', now(), now(), true, '{}'),
  ('a3000000-0000-4000-8000-000000000003', now(), now(), true, '{}');

insert into private.admin_members (auth_user_id)
values ('a3000000-0000-4000-8000-000000000001');

create temp table test_users (
  fixture_name text primary key,
  user_id uuid not null
) on commit drop;

insert into test_users (fixture_name, user_id)
select fixture.fixture_name, identity_row.user_id
from (
  values
    ('approver', 'a3000000-0000-4000-8000-000000000001'::uuid),
    ('owner', 'a3000000-0000-4000-8000-000000000002'::uuid),
    ('other', 'a3000000-0000-4000-8000-000000000003'::uuid)
) as fixture(fixture_name, auth_user_id)
join private.user_identities as identity_row
  on identity_row.auth_user_id = fixture.auth_user_id
 and identity_row.revoked_at is null;

insert into private.participant_access (user_id, access_kind)
select user_id, 'internal_tester'
from test_users
where fixture_name = 'owner';

insert into private.policy_documents (
  id, policy_type, version, effective_at, published_at, is_current
)
values
  (
    'd3000000-0000-4000-8000-000000000001',
    'terms_of_use', 'test-1', now() - interval '1 day', now(), false
  ),
  (
    'd3000000-0000-4000-8000-000000000002',
    'privacy_policy', 'test-1', now() - interval '1 day', now(), false
  ),
  (
    'd3000000-0000-4000-8000-000000000003',
    'community_guidelines', 'test-1', now() - interval '1 day', now(), false
  ),
  (
    'd3000000-0000-4000-8000-000000000004',
    'location_terms', 'test-1', now() - interval '1 day', now(), false
  );

insert into private.policy_document_locales (
  policy_document_id, locale, document_url, sha256
)
select
  policy_row.id,
  locale_row.locale,
  'https://policies.test/' || policy_row.id::text || '/' || locale_row.locale::text,
  extensions.digest(policy_row.id::text || ':' || locale_row.locale::text, 'sha256')
from private.policy_documents as policy_row
cross join unnest(enum_range(null::public.content_locale)) as locale_row(locale)
where policy_row.version = 'test-1';

select is(
  api_private.set_current_policy_documents((
    select array_agg(policy_row.id order by policy_row.id)
    from private.policy_documents as policy_row
    where policy_row.version = 'test-1'
  )),
  '{"status":"switched"}'::jsonb,
  'localized-read fixtures use the serialized policy publication path'
);

insert into private.minimum_age_attestations (
  user_id, minimum_age_passed, version
)
select user_id, true, '18plus-v1'
from test_users;

select api_private.accept_location_consent(
  fixture.auth_user_id,
  jsonb_build_object('version', 'test-1', 'locale', 'ko')
)
from (
  values
    ('a3000000-0000-4000-8000-000000000001'::uuid),
    ('a3000000-0000-4000-8000-000000000002'::uuid),
    ('a3000000-0000-4000-8000-000000000003'::uuid)
) as fixture(auth_user_id);

select is(
  api_private.accept_current_policies(
    'a3000000-0000-4000-8000-000000000002',
    jsonb_build_array(
      jsonb_build_object('type', 'terms_of_use', 'version', 'test-1', 'locale', 'ko'),
      jsonb_build_object('type', 'community_guidelines', 'version', 'test-1', 'locale', 'ko')
    )
  ),
  '{"status":"accepted"}'::jsonb,
  'the share owner accepts current review policies'
);

insert into public.regions (code, country_code, sort_order)
values
  ('seoul', 'KR', 1),
  ('busan-draft', 'KR', 2);

insert into public.region_translations (
  region_code,
  locale,
  name,
  status,
  approved_at,
  approved_by
)
select
  'seoul',
  locale_row.locale,
  'Seoul ' || locale_row.locale::text,
  'approved',
  now(),
  'a3000000-0000-4000-8000-000000000001'
from unnest(enum_range(null::public.content_locale))
  as locale_row(locale);

insert into public.spots (
  id,
  slug,
  region,
  name_ko,
  name_en,
  status,
  latitude,
  longitude,
  sort_order
)
values
  (
    'b3000000-0000-4000-8000-000000000001',
    'localized-one',
    'seoul',
    '다국어 1',
    'Localized One',
    'draft',
    37.51,
    127.01,
    1
  ),
  (
    'b3000000-0000-4000-8000-000000000002',
    'localized-two',
    'seoul',
    '다국어 2',
    'Localized Two',
    'draft',
    37.52,
    127.02,
    2
  ),
  (
    'b3000000-0000-4000-8000-000000000003',
    'localized-three',
    'seoul',
    '다국어 3',
    'Localized Three',
    'draft',
    37.53,
    127.03,
    3
  ),
  (
    'b3000000-0000-4000-8000-000000000004',
    'localized-teaser',
    'seoul',
    '다국어 예고',
    'Localized Teaser',
    'draft',
    37.54,
    127.04,
    4
  ),
  (
    'b3000000-0000-4000-8000-000000000099',
    'localized-incomplete',
    'seoul',
    '미완료',
    'Incomplete',
    'draft',
    37.55,
    127.05,
    99
  );

select throws_ok(
  $sql$
    update public.spots
    set status = 'teaser'
    where id = 'b3000000-0000-4000-8000-000000000099'
  $sql$,
  '23514',
  null,
  'an incomplete spot cannot become public'
);

insert into public.spot_translations (
  spot_id,
  locale,
  name,
  status,
  approved_at,
  approved_by
)
select
  spot_row.id,
  locale_row.locale,
  spot_row.name_en || ' ' || locale_row.locale::text,
  'approved',
  now(),
  'a3000000-0000-4000-8000-000000000001'
from public.spots as spot_row
cross join unnest(enum_range(null::public.content_locale))
  as locale_row(locale)
where spot_row.id between
  'b3000000-0000-4000-8000-000000000001'::uuid and
  'b3000000-0000-4000-8000-000000000004'::uuid;

insert into public.cards (
  id,
  spot_id,
  code,
  kind,
  title_ko,
  title_en,
  sketch_path,
  color_hex,
  is_published,
  published_at
)
values
  (
    'c3000000-0000-4000-8000-000000000001',
    'b3000000-0000-4000-8000-000000000001',
    'localized-card-one',
    'region',
    '다국어 카드 1',
    'Localized Card One',
    'cards/localized-one.webp',
    '#112233',
    false,
    null
  ),
  (
    'c3000000-0000-4000-8000-000000000002',
    'b3000000-0000-4000-8000-000000000002',
    'localized-card-two',
    'region',
    '다국어 카드 2',
    'Localized Card Two',
    'cards/localized-two.webp',
    '#223344',
    false,
    null
  ),
  (
    'c3000000-0000-4000-8000-000000000003',
    'b3000000-0000-4000-8000-000000000003',
    'localized-card-three',
    'region',
    '다국어 카드 3',
    'Localized Card Three',
    'cards/localized-three.webp',
    '#334455',
    false,
    null
  );

insert into public.card_translations (
  card_id,
  locale,
  title,
  status,
  approved_at,
  approved_by
)
select
  card_row.id,
  locale_row.locale,
  card_row.title_en || ' ' || locale_row.locale::text,
  'approved',
  now(),
  'a3000000-0000-4000-8000-000000000001'
from public.cards as card_row
cross join unnest(enum_range(null::public.content_locale))
  as locale_row(locale)
where not (
  card_row.id = 'c3000000-0000-4000-8000-000000000003'
  and locale_row.locale = 'vi'
);

select throws_ok(
  $sql$
    update public.cards
    set is_published = true,
        published_at = now()
    where id = 'c3000000-0000-4000-8000-000000000003'
  $sql$,
  '23514',
  null,
  'a card missing one approved locale cannot be published'
);

insert into public.card_translations (
  card_id,
  locale,
  title,
  status,
  approved_at,
  approved_by
)
values (
  'c3000000-0000-4000-8000-000000000003',
  'vi',
  'Localized Card Three vi',
  'approved',
  now(),
  'a3000000-0000-4000-8000-000000000001'
);

update public.cards
set is_published = true,
    published_at = now();

update public.spots
set status = case
  when id = 'b3000000-0000-4000-8000-000000000004'
    then 'teaser'::public.spot_status
  else 'open'::public.spot_status
end
where id between
  'b3000000-0000-4000-8000-000000000001'::uuid and
  'b3000000-0000-4000-8000-000000000004'::uuid;

-- Public spots and content version ---------------------------------------

create temp table spots_response_before (payload jsonb) on commit drop;
insert into spots_response_before values (api_private.list_public_spots());

select is(
  jsonb_array_length(
    (select payload -> 'spots' from spots_response_before)
  ),
  4,
  'public spots returns complete open and teaser rows only'
);

select is(
  (
    select payload #> '{spots,3,card}'
    from spots_response_before
  ),
  'null'::jsonb,
  'teaser spot never exposes a card'
);

select is(
  (
    select count(*)::bigint
    from jsonb_object_keys(
      (
        select payload #> '{spots,0,name}'
        from spots_response_before
      )
    )
  ),
  6::bigint,
  'spot names always contain all six locales'
);

select ok(
  not (
    (select payload #> '{spots,0}' from spots_response_before) ? 'radius_m'
  )
  and not (
    (select payload #> '{spots,0}' from spots_response_before)
      ? 'accuracy_threshold_m'
  ),
  'public spots omits acquisition decision thresholds'
);

update public.regions
set sort_order = 2
where code = 'seoul';

select isnt(
  api_private.list_public_spots() ->> 'content_version',
  (select payload ->> 'content_version' from spots_response_before),
  'a public projection change advances content_version'
);

-- Acquisitions, immutable snapshots, and collection ----------------------

insert into private.location_use_facts (
  user_id, idempotency_key, spot_id, purpose, collected_at
)
values (
  (select user_id from test_users where fixture_name = 'owner'),
  'e3000000-0000-4000-8000-000000000001',
  'b3000000-0000-4000-8000-000000000001',
  'field_acquisition',
  '2026-08-08 03:00:00+00'
);

insert into public.acquisitions (
  id,
  user_id,
  spot_id,
  card_id,
  acquisition_type,
  verification_result,
  idempotency_key,
  field_sequence,
  acquired_at
)
values
  (
    'd3000000-0000-4000-8000-000000000001',
    (select user_id from test_users where fixture_name = 'owner'),
    'b3000000-0000-4000-8000-000000000001',
    'c3000000-0000-4000-8000-000000000001',
    'field',
    'passed',
    'e3000000-0000-4000-8000-000000000001',
    1,
    '2026-08-08 03:00:00+00'
  ),
  (
    'd3000000-0000-4000-8000-000000000002',
    (select user_id from test_users where fixture_name = 'owner'),
    'b3000000-0000-4000-8000-000000000002',
    'c3000000-0000-4000-8000-000000000002',
    'retro',
    'manual',
    'e3000000-0000-4000-8000-000000000002',
    null,
    '2026-08-09 03:00:00+00'
  ),
  (
    'd3000000-0000-4000-8000-000000000003',
    (select user_id from test_users where fixture_name = 'owner'),
    'b3000000-0000-4000-8000-000000000003',
    'c3000000-0000-4000-8000-000000000003',
    'gift',
    'not_applicable',
    'e3000000-0000-4000-8000-000000000003',
    null,
    '2026-08-10 03:00:00+00'
  );

insert into private.retro_grants (
  acquisition_id,
  admin_auth_user_id,
  reason_code,
  note
)
values (
  'd3000000-0000-4000-8000-000000000002',
  'a3000000-0000-4000-8000-000000000001',
  'admin_manual',
  'localized read fixture'
);

insert into public.personal_cards (
  id,
  user_id,
  acquisition_id,
  photo_path,
  caption
)
values (
  'f3000000-0000-4000-8000-000000000001',
  (select user_id from test_users where fixture_name = 'owner'),
  'd3000000-0000-4000-8000-000000000001',
  (
    select user_id::text || '/localized-owner.webp'
    from test_users
    where fixture_name = 'owner'
  ),
  '서울 기억'
);

select throws_ok(
  $sql$
    update public.cards
    set color_hex = '#FFFFFF'
    where id = 'c3000000-0000-4000-8000-000000000001'
  $sql$,
  '23514',
  'acquired card response metadata is immutable; create a new card version',
  'acquired card color is immutable'
);

select throws_ok(
  $sql$
    update public.cards
    set kind = 'special'
    where id = 'c3000000-0000-4000-8000-000000000001'
  $sql$,
  '23514',
  'acquired card response metadata is immutable; create a new card version',
  'acquired card identity is immutable'
);

select throws_ok(
  $sql$
    delete from public.cards
    where id = 'c3000000-0000-4000-8000-000000000002'
  $sql$,
  '23514',
  'open spot card replacement requires draft-first transition',
  'an open spot cannot lose its published region card'
);

insert into public.cards (
  id,
  spot_id,
  code,
  kind,
  title_ko,
  title_en,
  sketch_path,
  color_hex,
  is_published,
  published_at
)
values (
  'c3000000-0000-4000-8000-000000000010',
  'b3000000-0000-4000-8000-000000000001',
  'localized-card-one-v2',
  'region',
  '다국어 카드 1 v2',
  'Localized Card One v2',
  'cards/localized-one-v2.webp',
  '#445566',
  false,
  null
);

insert into public.card_translations (
  card_id, locale, title, status, approved_at, approved_by
)
select
  'c3000000-0000-4000-8000-000000000010',
  locale_row.locale,
  'Localized Card One v2 ' || locale_row.locale::text,
  'approved',
  now(),
  'a3000000-0000-4000-8000-000000000001'
from unnest(enum_range(null::public.content_locale))
  as locale_row(locale);

select throws_ok(
  $sql$
    update public.cards
    set is_published = true,
        published_at = now()
    where id = 'c3000000-0000-4000-8000-000000000010'
  $sql$,
  '23505',
  null,
  'a second published region card is rejected even while complete'
);

select lives_ok(
  $sql$
    do $replace_card$
    begin
      perform 1
      from public.cards
      where id = 'c3000000-0000-4000-8000-000000000001'
      for update;

      perform 1
      from public.cards
      where id = 'c3000000-0000-4000-8000-000000000010'
      for update;

      update public.spots
      set status = 'draft'
      where id = 'b3000000-0000-4000-8000-000000000001';

      update public.cards
      set is_published = false,
          published_at = null
      where id = 'c3000000-0000-4000-8000-000000000001';

      update public.cards
      set is_published = true,
          published_at = now()
      where id = 'c3000000-0000-4000-8000-000000000010';

      update public.spots
      set status = 'open'
      where id = 'b3000000-0000-4000-8000-000000000001';
    end
    $replace_card$
  $sql$,
  'draft-first replacement can retire old, publish new, and reopen atomically'
);

select throws_ok(
  $sql$
    update public.cards
    set is_published = false,
        published_at = null
    where id = 'c3000000-0000-4000-8000-000000000010'
  $sql$,
  '23514',
  'open spot card replacement requires draft-first transition',
  'the replacement cannot be retired while its spot is open'
);

select throws_ok(
  $sql$
    update public.card_translations
    set title = 'Changed after acquisition',
        approved_at = approved_at + interval '1 second'
    where card_id = 'c3000000-0000-4000-8000-000000000001'
      and locale = 'en'
  $sql$,
  '23514',
  'acquired card translations are immutable; create a new card version',
  'acquired card translations are immutable'
);

select throws_ok(
  $sql$
    update public.region_translations
    set region_code = 'busan-draft'
    where region_code = 'seoul'
      and locale = 'vi'
  $sql$,
  '23514',
  'translation parent and locale are immutable; delete and recreate draft rows',
  'an approved public region translation cannot move to another parent'
);

select throws_ok(
  $sql$
    update public.card_translations
    set card_id = 'c3000000-0000-4000-8000-000000000010'
    where card_id = 'c3000000-0000-4000-8000-000000000001'
      and locale = 'ja'
  $sql$,
  '23514',
  'translation parent and locale are immutable; delete and recreate draft rows',
  'an acquired card translation cannot move to another parent'
);

select throws_ok(
  $sql$
    update public.region_translations
    set approved_at = approved_at - interval '1 second'
    where region_code = 'seoul'
      and locale = 'ja'
  $sql$,
  '23514',
  'approved region translation edits require a fresh approval audit',
  'an approved audit timestamp cannot be backdated'
);

select throws_ok(
  $sql$
    update public.spot_translations
    set approved_by = 'a3000000-0000-4000-8000-000000000002'
    where spot_id = 'b3000000-0000-4000-8000-000000000001'
      and locale = 'ja'
  $sql$,
  '23514',
  'approved spot translation edits require a fresh approval audit',
  'an approved audit actor cannot change without a newer approval timestamp'
);

select throws_ok(
  $sql$
    update public.spot_translations
    set name = 'Edited without audit'
    where spot_id = 'b3000000-0000-4000-8000-000000000001'
      and locale = 'en'
  $sql$,
  '23514',
  'approved spot translation edits require a fresh approval audit',
  'approved text cannot change with a stale audit timestamp'
);

select lives_ok(
  $sql$
    update public.spot_translations
    set name = 'Edited with fresh audit',
        approved_at = approved_at + interval '1 second',
        approved_by = 'a3000000-0000-4000-8000-000000000001'
    where spot_id = 'b3000000-0000-4000-8000-000000000001'
      and locale = 'en'
  $sql$,
  'approved text can change only with a fresh approval audit'
);

select throws_ok(
  $sql$
    update public.spot_translations
    set status = 'draft',
        approved_at = null,
        approved_by = null
    where spot_id = 'b3000000-0000-4000-8000-000000000001'
      and locale = 'vi'
  $sql$,
  '23514',
  'public spot translations cannot be removed or demoted',
  'a public spot cannot lose an approved locale'
);

select throws_ok(
  $sql$
    update public.spots
    set name_en = 'Legacy mutation'
    where id = 'b3000000-0000-4000-8000-000000000001'
  $sql$,
  '23514',
  'legacy spot names are read-only; edit spot_translations',
  'legacy localized columns are read-only'
);

select is(
  api_private.acquire_context_unrated(
    'a3000000-0000-4000-8000-000000000002',
    'b3000000-0000-4000-8000-000000000001',
    'e3000000-0000-4000-8000-000000000099',
    false
  ) #>> '{card,title,en}',
  'Localized Card One v2 en',
  'acquire context returns the six-locale title object'
);

select is(
  api_private.get_user_collection(
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    50,
    null,
    null
  ),
  '{"status":"unauthorized"}'::jsonb,
  'collection requires an active service identity'
);

select is(
  api_private.get_user_collection(
    'a3000000-0000-4000-8000-000000000002',
    101,
    null,
    null
  ),
  '{"status":"invalid"}'::jsonb,
  'collection defensively rejects an invalid limit'
);

create temp table first_collection_page (payload jsonb) on commit drop;
insert into first_collection_page
values (
  api_private.get_user_collection(
    'a3000000-0000-4000-8000-000000000002',
    2,
    null,
    null
  )
);

select is(
  (select payload ->> 'status' from first_collection_page),
  'ready',
  'collection read succeeds'
);

select is(
  jsonb_array_length(
    (select payload -> 'items' from first_collection_page)
  ),
  2,
  'collection returns at most the requested limit'
);

select ok(
  (select (payload ->> 'has_more')::boolean from first_collection_page)
  and (select payload -> 'next_anchor' from first_collection_page) is not null,
  'collection returns an internal anchor only when another page exists'
);

select is(
  (select (payload #>> '{stats,total_acquisitions}')::bigint
   from first_collection_page),
  3::bigint,
  'collection stats count all acquisition types'
);

select is(
  (select (payload #>> '{stats,spots_visited}')::bigint
   from first_collection_page),
  2::bigint,
  'spots_visited counts field and retro while excluding gift-only spots'
);

select is(
  jsonb_array_length(
    api_private.get_user_collection(
      'a3000000-0000-4000-8000-000000000002',
      2,
      (
        select (payload #>> '{next_anchor,acquired_at}')::timestamptz
        from first_collection_page
      ),
      (
        select (payload #>> '{next_anchor,id}')::uuid
        from first_collection_page
      )
    ) -> 'items'
  ),
  1,
  'collection anchor yields the remaining page without overlap'
);

select is(
  api_private.get_user_collection(
    'a3000000-0000-4000-8000-000000000002',
    50,
    null,
    null
  ) ->> 'status',
  'ready',
  'a repeated collection read remains successful'
);

select is(
  (
    select count(*)::bigint
    from analytics.events as event_row
    where event_row.user_id = (
      select user_id from test_users where fixture_name = 'owner'
    )
      and event_row.event_name = 'revisit'
  ),
  1::bigint,
  'revisit is emitted once per user and KST day across repeated reads'
);

-- Owned photo and safe share state ---------------------------------------

select is(
  api_private.get_owned_personal_card_photo(
    'a3000000-0000-4000-8000-000000000002',
    'f3000000-0000-4000-8000-000000000001'
  ) ->> 'status',
  'found',
  'owner photo lookup succeeds'
);

select is(
  api_private.get_owned_personal_card_photo(
    'a3000000-0000-4000-8000-000000000003',
    'f3000000-0000-4000-8000-000000000001'
  ),
  '{"status":"not_found"}'::jsonb,
  'owner photo lookup hides non-ownership as not-found'
);

select is(
  api_private.create_personal_card_share(
    'a3000000-0000-4000-8000-000000000002',
    false,
    false,
    'f3000000-0000-4000-8000-000000000001',
    'LocalizedReadShareSlug01'
  ),
  '{"status":"share_creation_gate_closed"}'::jsonb,
  'share creation gate is distinct from participant access'
);

select is(
  api_private.create_personal_card_share(
    'a3000000-0000-4000-8000-000000000002',
    false,
    true,
    'f3000000-0000-4000-8000-000000000001',
    'LocalizedReadShareSlug01'
  ) ->> 'share_state',
  'pending',
  'share creation can only create pending review state'
);

select is(
  api_private.get_public_share(
    'LocalizedReadShareSlug01',
    null,
    true,
    true
  ),
  '{"status":"not_found"}'::jsonb,
  'pending review shares are not public and emit no view'
);

select throws_ok(
  $sql$
    update public.personal_cards
    set share_state = 'active',
        share_resubmission_required = false,
        share_terms_acceptance_id =
          'aa300000-0000-4000-8000-000000000001',
        share_community_acceptance_id =
          'aa300000-0000-4000-8000-000000000002',
        share_reviewed_at = now(),
        share_reviewed_by =
          'a3000000-0000-4000-8000-000000000001'
    where id = 'f3000000-0000-4000-8000-000000000001'
  $sql$,
  '23514',
  'moderated share transitions require the moderation RPC',
  'direct data mutation cannot bypass the moderation audit RPC'
);

select is(
  api_private.moderate_personal_card_share(
    'a3000000-0000-4000-8000-000000000001',
    'f3000000-0000-4000-8000-000000000001',
    'e3000000-0000-4000-8000-000000000001',
    'approve',
    'POLICY_OK',
    'localized share approval',
    true
  ),
  '{"status":"applied","share_state":"active","affected":1}'::jsonb,
  'an active administrator approves the pending localized share'
);

select is(
  api_private.get_public_share(
    'LocalizedReadShareSlug01',
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    false,
    true
  ),
  '{"status":"unauthorized"}'::jsonb,
  'a supplied invalid viewer JWT identity is unauthorized'
);

select is(
  api_private.get_public_share(
    'LocalizedReadShareSlug01',
    null,
    true,
    true
  ) ->> 'status',
  'found',
  'an active test fixture exercises the public localized read path'
);

select ok(
  (
    select
      event_row.personal_card_id =
        'f3000000-0000-4000-8000-000000000001'
      and event_row.properties = '{}'::jsonb
    from analytics.events as event_row
    where event_row.event_name = 'share_view'
  ),
  'share views store the resolved card id and no raw slug'
);

select is(
  (
    select count(*)::bigint
    from analytics.events as event_row
    where event_row.properties::text like '%LocalizedReadShareSlug01%'
  ),
  0::bigint,
  'analytics contains no raw share slug'
);

select is(
  api_private.revoke_personal_card_share(
    'a3000000-0000-4000-8000-000000000002',
    'f3000000-0000-4000-8000-000000000001'
  ),
  '{"status":"revoked"}'::jsonb,
  'owner revocation returns the share to private state'
);

select is(
  api_private.get_public_share(
    'LocalizedReadShareSlug01',
    null,
    false,
    true
  ),
  '{"status":"not_found"}'::jsonb,
  'revocation immediately removes the public read path'
);

select * from finish();
rollback;
