begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(66);

-- Required relations -------------------------------------------------------

-- 01
select has_table('public', 'app_users', 'app_users exists');
-- 02
select has_table('public', 'spots', 'spots exists');
-- 03
select has_table('public', 'cards', 'cards exists');
-- 04
select has_table('public', 'acquisitions', 'acquisitions exists');
-- 05
select has_table('public', 'personal_cards', 'personal_cards exists');
-- 06
select has_table('public', 'physical_requests', 'physical_requests exists');
-- 07
select has_table('private', 'user_identities', 'user identities are private');
-- 08
select has_table('private', 'admin_members', 'admin membership is private');
-- 09
select has_table('private', 'participant_access', 'participant access is private');
-- 10
select has_table('private', 'card_counters', 'card counters are private');
-- 11
select has_table('private', 'retro_grants', 'retro grants are private');
-- 12
select has_table('private', 'recovery_codes', 'recovery codes are private');
-- 13
select has_table('private', 'recovery_claim_limits', 'recovery limits are private');
-- 14
select has_table('analytics', 'events', 'analytics events are isolated');

-- Privacy and authorization metadata --------------------------------------

-- 15
select is(
  (
    select count(*)::bigint
    from information_schema.columns
    where table_schema in ('public', 'private', 'analytics')
      and not (table_schema = 'public' and table_name = 'spots')
      and lower(column_name) in (
        'lat', 'lng', 'latitude', 'longitude', 'accuracy', 'coordinates'
      )
  ),
  0::bigint,
  'user location and accuracy columns are absent'
);

-- 16
select ok(
  private.jsonb_has_forbidden_location_key(
    '{"location":{"lat":37.5,"lng":127.0}}'::jsonb
  ),
  'nested location keys are detected'
);

-- 17
select ok(
  private.jsonb_has_forbidden_location_key(
    '{"items":[{"Accuracy":25}]}'::jsonb
  ),
  'location keys are detected in arrays without case sensitivity'
);

-- 18
select ok(
  not private.jsonb_has_forbidden_location_key(
    '{"spot_id":"00000000-0000-4000-8000-000000000001","distance_band":"300m+"}'::jsonb
  ),
  'allow-listed non-location properties remain valid'
);

-- 19
select is(
  (
    select count(*)::bigint
    from pg_class as relation
    join pg_namespace as schema_row on schema_row.oid = relation.relnamespace
    where schema_row.nspname in ('public', 'private', 'analytics')
      and relation.relname in (
        'app_users',
        'spots',
        'cards',
        'acquisitions',
        'personal_cards',
        'physical_requests',
        'user_identities',
        'admin_members',
        'participant_access',
        'card_counters',
        'retro_grants',
        'recovery_codes',
        'recovery_claim_limits',
        'events'
      )
      and relation.relrowsecurity
      and relation.relforcerowsecurity
  ),
  14::bigint,
  'all application tables enable and force RLS'
);

-- 20
select is(
  (
    select count(*)::bigint
    from unnest(array[
      'public.app_users',
      'public.spots',
      'public.cards',
      'public.acquisitions',
      'public.personal_cards',
      'public.physical_requests'
    ]) as relation_name
    where has_table_privilege('anon', relation_name, 'SELECT')
  ),
  0::bigint,
  'anon has no direct base-table SELECT'
);

-- 21
select is(
  (
    select count(*)::bigint
    from unnest(array[
      'public.app_users',
      'public.spots',
      'public.cards',
      'public.acquisitions',
      'public.personal_cards',
      'public.physical_requests'
    ]) as relation_name
    where has_table_privilege('authenticated', relation_name, 'SELECT')
  ),
  0::bigint,
  'authenticated has no direct base-table SELECT'
);

-- 22
select is(
  (
    select count(*)::bigint
    from unnest(array['anon', 'authenticated']) as role_name
    cross join unnest(array[
      'public.app_users',
      'public.spots',
      'public.cards',
      'public.acquisitions',
      'public.personal_cards',
      'public.physical_requests'
    ]) as relation_name
    cross join unnest(array['INSERT', 'UPDATE', 'DELETE']) as privilege_name
    where has_table_privilege(role_name, relation_name, privilege_name)
  ),
  0::bigint,
  'browser roles have no application-table write privileges'
);

-- 23
select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'private'
      and function_row.prosecdef
      and not (
        coalesce(function_row.proconfig, array[]::text[])
        @> array['search_path=""']::text[]
      )
  ),
  0::bigint,
  'all private SECURITY DEFINER functions have an empty search_path'
);

-- 24
select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'private'
      and function_row.proname in (
        'handle_auth_user_created',
        'enforce_retro_grant_target',
        'ensure_retro_acquisition_has_grant'
      )
      and (
        has_function_privilege('anon', function_row.oid, 'EXECUTE')
        or has_function_privilege('authenticated', function_row.oid, 'EXECUTE')
      )
  ),
  0::bigint,
  'trigger-only SECURITY DEFINER functions are not browser-callable'
);

-- 25
select set_eq(
  $$
    select policyname::text
    from pg_policies
    where schemaname = 'public'
  $$,
  $$
    values
      ('app_users_select_own'::text),
      ('spots_select_public'::text),
      ('cards_select_public'::text),
      ('acquisitions_select_own'::text),
      ('personal_cards_select_own'::text),
      ('physical_requests_select_own'::text),
      ('regions_select_public'::text),
      ('region_translations_select_approved'::text),
      ('spot_translations_select_approved'::text),
      ('card_translations_select_approved'::text)
  $$,
  'public RLS policy set is explicit'
);

-- User identity fixtures ---------------------------------------------------

insert into auth.users (id, created_at, updated_at, is_anonymous)
values
  ('11111111-1111-4111-8111-111111111111', now(), now(), true),
  ('22222222-2222-4222-8222-222222222222', now(), now(), true),
  ('33333333-3333-4333-8333-333333333333', now(), now(), true);

-- 26
select is(
  (
    select count(*)::bigint
    from private.user_identities
    where auth_user_id in (
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333'
    )
      and revoked_at is null
  ),
  3::bigint,
  'auth user trigger creates one active logical identity per auth user'
);

set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';

-- 27
select is(
  private.current_user_id(),
  (
    select user_id
    from private.user_identities
    where auth_user_id = '11111111-1111-4111-8111-111111111111'
      and revoked_at is null
  ),
  'current_user_id resolves the stable logical owner'
);

update private.user_identities
set revoked_at = now()
where auth_user_id = '33333333-3333-4333-8333-333333333333';

-- 28
select throws_ok(
  $sql$
    insert into private.user_identities (auth_user_id, user_id)
    select
      '33333333-3333-4333-8333-333333333333'::uuid,
      user_id
    from private.user_identities
    where auth_user_id = '11111111-1111-4111-8111-111111111111'
      and revoked_at is null
  $sql$,
  '23505',
  null,
  'one logical owner cannot have two active auth principals'
);

set local "request.jwt.claim.sub" = '99999999-9999-4999-8999-999999999999';

-- 29
select is(
  private.current_user_id(),
  null::uuid,
  'an unmapped auth subject has no logical owner'
);

-- Spot, card and acquisition fixtures -------------------------------------

insert into public.regions (code, country_code, sort_order)
values ('seoul', 'KR', 1);

insert into public.region_translations (
  region_code, locale, name, status, approved_at, approved_by
)
select
  'seoul',
  locale_row.locale,
  'Seoul',
  'approved',
  now(),
  '11111111-1111-4111-8111-111111111111'
from unnest(enum_range(null::public.content_locale))
  as locale_row(locale);

insert into public.spots (
  id, slug, region, name_ko, name_en, status, latitude, longitude
)
values
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'open-spot',
    'seoul',
    '공개 스팟',
    'Open Spot',
    'draft',
    37.5700,
    126.9800
  ),
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    'teaser-spot',
    'seoul',
    '예고 스팟',
    'Teaser Spot',
    'draft',
    37.5800,
    126.9900
  );

insert into public.spot_translations (
  spot_id, locale, name, status, approved_at, approved_by
)
select
  spot_row.id,
  locale_row.locale,
  case
    when locale_row.locale = 'ko' then spot_row.name_ko
    else spot_row.name_en
  end,
  'approved',
  now(),
  '11111111-1111-4111-8111-111111111111'
from public.spots as spot_row
cross join unnest(enum_range(null::public.content_locale))
  as locale_row(locale)
where spot_row.id in (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
);

insert into public.cards (
  id, spot_id, code, title_ko, title_en, sketch_path, color_hex,
  is_published, published_at
)
values
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'open-card',
    '공개 카드',
    'Open Card',
    'cards/open-card.webp',
    '#112233',
    false,
    null
  ),
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    'teaser-card',
    '비공개 카드',
    'Hidden Card',
    'cards/teaser-card.webp',
    '#445566',
    false,
    null
  );

insert into public.card_translations (
  card_id, locale, title, status, approved_at, approved_by
)
select
  card_row.id,
  locale_row.locale,
  case
    when locale_row.locale = 'ko' then card_row.title_ko
    else card_row.title_en
  end,
  'approved',
  now(),
  '11111111-1111-4111-8111-111111111111'
from public.cards as card_row
cross join unnest(enum_range(null::public.content_locale))
  as locale_row(locale)
where card_row.id in (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
);

update public.cards
set is_published = true,
    published_at = now()
where id in (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
);

update public.spots
set status = case
  when id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
    then 'open'::public.spot_status
  else 'teaser'::public.spot_status
end
where id in (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
);

insert into private.location_use_facts (
  user_id, idempotency_key, spot_id, purpose, collected_at
)
select
  identity_row.user_id,
  fixture.idempotency_key,
  fixture.spot_id,
  'field_acquisition',
  fixture.acquired_at
from (
  values
    (
      '11111111-1111-4111-8111-111111111111'::uuid,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid,
      'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'::uuid,
      '2026-08-08 14:59:59+00'::timestamptz
    ),
    (
      '11111111-1111-4111-8111-111111111111'::uuid,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid,
      'dddddddd-dddd-4ddd-8ddd-ddddddddddd2'::uuid,
      '2026-08-08 15:00:00+00'::timestamptz
    ),
    (
      '22222222-2222-4222-8222-222222222222'::uuid,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid,
      'dddddddd-dddd-4ddd-8ddd-ddddddddddd3'::uuid,
      '2026-08-08 14:00:00+00'::timestamptz
    )
) as fixture(auth_user_id, spot_id, idempotency_key, acquired_at)
join private.user_identities as identity_row
  on identity_row.auth_user_id = fixture.auth_user_id
 and identity_row.revoked_at is null;

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
select
  acquisition_id,
  identity_row.user_id,
  spot_id,
  card_id,
  'field'::public.acquisition_type,
  'passed'::public.verification_result,
  idempotency_key,
  field_sequence,
  acquired_at
from (
  values
    (
      'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'::uuid,
      '11111111-1111-4111-8111-111111111111'::uuid,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid,
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'::uuid,
      'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'::uuid,
      1::bigint,
      '2026-08-08 14:59:59+00'::timestamptz
    ),
    (
      'cccccccc-cccc-4ccc-8ccc-ccccccccccc2'::uuid,
      '11111111-1111-4111-8111-111111111111'::uuid,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid,
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'::uuid,
      'dddddddd-dddd-4ddd-8ddd-ddddddddddd2'::uuid,
      2::bigint,
      '2026-08-08 15:00:00+00'::timestamptz
    ),
    (
      'cccccccc-cccc-4ccc-8ccc-ccccccccccc3'::uuid,
      '22222222-2222-4222-8222-222222222222'::uuid,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'::uuid,
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'::uuid,
      'dddddddd-dddd-4ddd-8ddd-ddddddddddd3'::uuid,
      3::bigint,
      '2026-08-08 14:00:00+00'::timestamptz
    )
) as fixture(
  acquisition_id,
  auth_user_id,
  spot_id,
  card_id,
  idempotency_key,
  field_sequence,
  acquired_at
)
join private.user_identities as identity_row
  on identity_row.auth_user_id = fixture.auth_user_id
 and identity_row.revoked_at is null;

-- 30
select results_eq(
  $$
    select acquired_on_kst::text
    from public.acquisitions
    where user_id = (
      select user_id
      from private.user_identities
      where auth_user_id = '11111111-1111-4111-8111-111111111111'
        and revoked_at is null
    )
    order by acquired_at
  $$,
  $$ values ('2026-08-08'::text), ('2026-08-09'::text) $$,
  'KST midnight produces separate acquisition days'
);

-- 31
select throws_ok(
  $sql$
    insert into public.acquisitions (
      user_id, spot_id, card_id, acquisition_type, verification_result,
      idempotency_key, field_sequence, acquired_at
    )
    select
      user_id,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
      'field',
      'passed',
      'dddddddd-dddd-4ddd-8ddd-ddddddddddd4',
      4,
      '2026-08-08 10:00:00+00'
    from private.user_identities
    where auth_user_id = '11111111-1111-4111-8111-111111111111'
      and revoked_at is null
  $sql$,
  '23505',
  null,
  'same user and spot cannot acquire twice on one KST day'
);

-- 32
select throws_ok(
  $sql$
    insert into public.acquisitions (
      user_id, spot_id, card_id, acquisition_type, verification_result,
      idempotency_key, field_sequence, acquired_at
    )
    select
      user_id,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
      'field',
      'passed',
      'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
      1,
      '2026-08-10 10:00:00+00'
    from private.user_identities
    where auth_user_id = '11111111-1111-4111-8111-111111111111'
      and revoked_at is null
  $sql$,
  '23505',
  null,
  'an idempotency key cannot bind to another acquisition'
);

-- 33
select throws_ok(
  $sql$
    insert into public.acquisitions (
      user_id, spot_id, card_id, acquisition_type, verification_result,
      idempotency_key, field_sequence, acquired_at
    )
    select
      user_id,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
      'field',
      'passed',
      'dddddddd-dddd-4ddd-8ddd-ddddddddddd5',
      1,
      '2026-08-10 10:00:00+00'
    from private.user_identities
    where auth_user_id = '22222222-2222-4222-8222-222222222222'
      and revoked_at is null
  $sql$,
  '23505',
  null,
  'field sequence is unique within a card'
);

-- 34
select throws_ok(
  $sql$
    insert into public.acquisitions (
      user_id, spot_id, card_id, acquisition_type, verification_result,
      idempotency_key, field_sequence, acquired_at
    )
    select
      user_id,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
      'field',
      'passed',
      'dddddddd-dddd-4ddd-8ddd-ddddddddddd6',
      0,
      '2026-08-10 10:00:00+00'
    from private.user_identities
    where auth_user_id = '22222222-2222-4222-8222-222222222222'
      and revoked_at is null
  $sql$,
  '23514',
  null,
  'field sequence must be positive'
);

-- 35
select throws_ok(
  $sql$
    insert into public.acquisitions (
      user_id, spot_id, card_id, acquisition_type, verification_result,
      idempotency_key, field_sequence, acquired_at
    )
    select
      user_id,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
      'field',
      'passed',
      'dddddddd-dddd-4ddd-8ddd-ddddddddddd7',
      4,
      '2026-08-10 10:00:00+00'
    from private.user_identities
    where auth_user_id = '22222222-2222-4222-8222-222222222222'
      and revoked_at is null
  $sql$,
  '23503',
  null,
  'acquisition card must belong to its spot'
);

insert into public.acquisitions (
  id,
  user_id,
  spot_id,
  card_id,
  acquisition_type,
  verification_result,
  idempotency_key,
  acquired_at
)
select
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc4',
  user_id,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
  'retro',
  'manual',
  'dddddddd-dddd-4ddd-8ddd-ddddddddddd8',
  '2026-08-10 10:00:00+00'
from private.user_identities
where auth_user_id = '22222222-2222-4222-8222-222222222222'
  and revoked_at is null;

insert into private.retro_grants (
  acquisition_id, admin_auth_user_id, reason_code, note
)
values (
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc4',
  '11111111-1111-4111-8111-111111111111',
  'stage0_simulation',
  'pgTAP fixture'
);

set constraints retro_acquisition_requires_grant immediate;
set constraints retro_acquisition_requires_grant deferred;

insert into private.location_use_facts (
  user_id, idempotency_key, spot_id, purpose, collected_at
)
select
  user_id,
  'dddddddd-dddd-4ddd-8ddd-ddddddddddd9',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
  'field_acquisition',
  '2026-08-10 10:00:00+00'
from private.user_identities
where auth_user_id = '22222222-2222-4222-8222-222222222222'
  and revoked_at is null;

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
select
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc5',
  user_id,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
  'field',
  'passed',
  'dddddddd-dddd-4ddd-8ddd-ddddddddddd9',
  1,
  '2026-08-10 10:00:00+00'
from private.user_identities
where auth_user_id = '22222222-2222-4222-8222-222222222222'
  and revoked_at is null;

-- 36
select is(
  (
    select count(*)::bigint
    from public.acquisitions
    where user_id = (
      select user_id
      from private.user_identities
      where auth_user_id = '22222222-2222-4222-8222-222222222222'
        and revoked_at is null
    )
      and spot_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
      and acquired_on_kst = '2026-08-10'
  ),
  2::bigint,
  'retro acquisition does not consume the field daily limit'
);

-- 37
select throws_ok(
  $sql$
    insert into private.retro_grants (
      acquisition_id, admin_auth_user_id, reason_code
    )
    values (
      'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
      '11111111-1111-4111-8111-111111111111',
      'invalid_target'
    )
  $sql$,
  '23514',
  null,
  'retro audit grant cannot reference a field acquisition'
);

-- 38
select is(
  (
    select count(*)::bigint
    from pg_trigger
    where tgname = 'retro_acquisition_requires_grant'
      and tgconstraint <> 0
  ),
  1::bigint,
  'retro acquisition audit requirement is a deferred constraint trigger'
);

-- 39
select throws_ok(
  $sql$
    do $test_body$
    begin
      insert into public.acquisitions (
        id, user_id, spot_id, card_id, acquisition_type,
        verification_result, idempotency_key, acquired_at
      )
      select
        'cccccccc-cccc-4ccc-8ccc-ccccccccccc6',
        user_id,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
        'retro',
        'manual',
        'dddddddd-dddd-4ddd-8ddd-dddddddddd10',
        '2026-08-11 10:00:00+00'
      from private.user_identities
      where auth_user_id = '11111111-1111-4111-8111-111111111111'
        and revoked_at is null;

      set constraints retro_acquisition_requires_grant immediate;
    end
    $test_body$
  $sql$,
  '23514',
  null,
  'retro acquisition cannot commit without its audit grant'
);

-- The field-personal-card invariant requires the current location policy,
-- an adult attestation, and active consent for the fixture owner.
insert into private.policy_documents (
  id, policy_type, version, effective_at, published_at, is_current
)
values
  ('ee000000-0000-4000-8000-000000000001', 'terms_of_use', 'schema-fixture-1', now() - interval '1 day', now(), false),
  ('ee000000-0000-4000-8000-000000000002', 'privacy_policy', 'schema-fixture-1', now() - interval '1 day', now(), false),
  ('ee000000-0000-4000-8000-000000000003', 'community_guidelines', 'schema-fixture-1', now() - interval '1 day', now(), false),
  ('ee000000-0000-4000-8000-000000000004', 'location_terms', 'schema-fixture-1', now() - interval '1 day', now(), false);

insert into private.policy_document_locales (
  policy_document_id, locale, document_url, sha256
)
select
  policy_row.id,
  locale_row.locale,
  'https://policies.test/schema/' || policy_row.id::text || '/' || locale_row.locale::text,
  extensions.digest(policy_row.id::text || ':' || locale_row.locale::text, 'sha256')
from private.policy_documents as policy_row
cross join unnest(enum_range(null::public.content_locale)) as locale_row(locale)
where policy_row.version = 'schema-fixture-1';

do $fixture$
begin
  perform api_private.set_current_policy_documents(array[
    'ee000000-0000-4000-8000-000000000001'::uuid,
    'ee000000-0000-4000-8000-000000000002'::uuid,
    'ee000000-0000-4000-8000-000000000003'::uuid,
    'ee000000-0000-4000-8000-000000000004'::uuid
  ]);
  perform api_private.record_minimum_age_attestation(
    '11111111-1111-4111-8111-111111111111',
    '{"minimum_age_passed":true,"version":"18plus-v1"}'::jsonb
  );
  perform api_private.accept_location_consent(
    '11111111-1111-4111-8111-111111111111',
    '{"version":"schema-fixture-1","locale":"ko"}'::jsonb
  );
end;
$fixture$;

-- Personal cards, physical interest and recovery --------------------------

-- 40
select throws_ok(
  $sql$
    insert into public.personal_cards (
      user_id, acquisition_id, photo_path, caption
    )
    select
      user_id,
      'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
      user_id::text || '/wrong-owner.webp',
      ''
    from private.user_identities
    where auth_user_id = '22222222-2222-4222-8222-222222222222'
      and revoked_at is null
  $sql$,
  '23503',
  null,
  'a personal card cannot reference another owner acquisition'
);

-- 41
select throws_ok(
  $sql$
    insert into public.personal_cards (
      user_id, acquisition_id, photo_path, caption
    )
    select
      user_id,
      'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
      '22222222-2222-4222-8222-222222222222/wrong-folder.webp',
      ''
    from private.user_identities
    where auth_user_id = '11111111-1111-4111-8111-111111111111'
      and revoked_at is null
  $sql$,
  '23514',
  null,
  'a personal card path must use its logical owner folder'
);

insert into public.personal_cards (
  user_id, acquisition_id, photo_path, caption
)
select
  user_id,
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
  user_id::text || '/personal.webp',
  '기록'
from private.user_identities
where auth_user_id = '11111111-1111-4111-8111-111111111111'
  and revoked_at is null;

insert into public.physical_requests (user_id, kind)
select user_id, 'request'
from private.user_identities
where auth_user_id = '11111111-1111-4111-8111-111111111111'
  and revoked_at is null;

-- 42
select throws_ok(
  $sql$
    insert into public.physical_requests (user_id, kind)
    select user_id, 'request'
    from private.user_identities
    where auth_user_id = '11111111-1111-4111-8111-111111111111'
      and revoked_at is null
  $sql$,
  '23505',
  null,
  'physical demand is counted once per user and kind'
);

-- 43
select throws_ok(
  $sql$
    insert into private.recovery_codes (
      user_id, code_hash, claimed_at
    )
    select user_id, extensions.digest('claim-without-user', 'sha256'), now()
    from private.user_identities
    where auth_user_id = '11111111-1111-4111-8111-111111111111'
      and revoked_at is null
  $sql$,
  '23514',
  null,
  'recovery claim time and claimant identity must be present together'
);

-- 44
select throws_ok(
  $sql$
    insert into private.recovery_codes (
      user_id, code_hash, issued_at, revoked_at
    )
    select
      user_id,
      extensions.digest('invalid-timestamp', 'sha256'),
      '2026-08-08 00:00:00+00',
      '2026-08-07 00:00:00+00'
    from private.user_identities
    where auth_user_id = '11111111-1111-4111-8111-111111111111'
      and revoked_at is null
  $sql$,
  '23514',
  null,
  'recovery revoke time cannot precede issue time'
);

insert into private.recovery_codes (user_id, code_hash)
select user_id, extensions.digest('active-code-one', 'sha256')
from private.user_identities
where auth_user_id = '11111111-1111-4111-8111-111111111111'
  and revoked_at is null;

-- 45
select throws_ok(
  $sql$
    insert into private.recovery_codes (user_id, code_hash)
    select user_id, extensions.digest('active-code-two', 'sha256')
    from private.user_identities
    where auth_user_id = '11111111-1111-4111-8111-111111111111'
      and revoked_at is null
  $sql$,
  '23505',
  null,
  'one logical owner has only one active recovery code'
);

-- Analytics constraints ---------------------------------------------------

-- 46
select throws_ok(
  $sql$
    insert into analytics.events (
      user_id, event_name, source, occurred_at, spot_id, properties
    )
    select
      user_id,
      'spot_view',
      'server',
      now(),
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      '{"context":{"location":[{"latitude":37.5}]}}'
    from private.user_identities
    where auth_user_id = '11111111-1111-4111-8111-111111111111'
      and revoked_at is null
  $sql$,
  '23514',
  null,
  'nested location data cannot enter analytics events'
);

-- 47
select throws_ok(
  $sql$
    insert into analytics.events (
      client_event_id, user_id, event_name, source, occurred_at, properties
    )
    select
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
      user_id,
      'acquire_success',
      'client',
      now(),
      '{}'
    from private.user_identities
    where auth_user_id = '11111111-1111-4111-8111-111111111111'
      and revoked_at is null
  $sql$,
  '23514',
  null,
  'client cannot create a server fact event'
);

insert into analytics.events (
  user_id, event_name, source, occurred_at, spot_id, properties
)
select
  acquisition_row.user_id,
  'acquire_success',
  'server',
  acquisition_row.acquired_at,
  acquisition_row.spot_id,
  jsonb_build_object('spot_id', acquisition_row.spot_id::text)
from public.acquisitions as acquisition_row
where acquisition_row.id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';

-- 48
select is(
  (select count(*)::bigint from analytics.events),
  1::bigint,
  'a safe server fact event is stored'
);

-- RLS behavior under temporary test-only grants ---------------------------

grant select on table
  public.spots,
  public.cards,
  public.app_users,
  public.acquisitions,
  public.personal_cards,
  public.physical_requests
to anon, authenticated;

set local role anon;

-- 49
select is(
  (select count(*)::bigint from public.spots),
  2::bigint,
  'anon RLS sees open and teaser spot shells'
);

-- 50
select is(
  (select count(*)::bigint from public.cards),
  1::bigint,
  'anon RLS does not reveal a teaser card'
);

reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-4111-8111-111111111111';

-- 51
select is(
  (select count(*)::bigint from public.app_users),
  1::bigint,
  'user A RLS sees only its logical owner row'
);

-- 52
select is(
  (select count(*)::bigint from public.acquisitions),
  2::bigint,
  'user A RLS sees only its acquisitions'
);

-- 53
select is(
  (select count(*)::bigint from public.personal_cards),
  1::bigint,
  'user A RLS sees its personal card'
);

-- 54
select is(
  (select count(*)::bigint from public.physical_requests),
  1::bigint,
  'user A RLS sees its physical request'
);

set local "request.jwt.claim.sub" = '22222222-2222-4222-8222-222222222222';

-- 55
select is(
  (select count(*)::bigint from public.acquisitions),
  3::bigint,
  'user B RLS sees only its field and retro acquisitions'
);

-- 56
select is(
  (select count(*)::bigint from public.personal_cards),
  0::bigint,
  'user B RLS cannot see user A personal card'
);

-- 57
select is(
  (select count(*)::bigint from public.physical_requests),
  0::bigint,
  'user B RLS cannot see user A physical request'
);

reset role;

-- Storage and key indexes -------------------------------------------------

-- 58
select ok(
  (
    select
      not public
      and file_size_limit = 10485760
      and allowed_mime_types @> array['image/png', 'image/jpeg', 'image/webp']::text[]
    from storage.buckets
    where id = 'personal-cards'
  ),
  'personal card bucket is private and constrained'
);

-- 59
select is(
  (
    select count(*)::bigint
    from information_schema.columns
    where table_schema = 'private'
      and table_name = 'recovery_codes'
      and column_name = 'code'
  ),
  0::bigint,
  'recovery code plaintext has no storage column'
);

-- 60
select has_index(
  'public',
  'acquisitions',
  'acquisitions_one_field_per_day_idx',
  'KST daily field uniqueness index exists'
);

-- 61
select has_index(
  'public',
  'acquisitions',
  'acquisitions_user_idempotency_idx',
  'idempotency uniqueness index exists'
);

-- 62
select ok(
  (
    select index_row.indisunique
      and pg_get_expr(index_row.indpred, index_row.indrelid) is not null
    from pg_index as index_row
    join pg_class as index_relation on index_relation.oid = index_row.indexrelid
    join pg_namespace as schema_row on schema_row.oid = index_relation.relnamespace
    where schema_row.nspname = 'private'
      and index_relation.relname = 'user_identities_one_active_user_idx'
  ),
  'logical owner active-auth index is unique and partial'
);

-- 63
select ok(
  has_function_privilege(
    'service_role',
    'private.jsonb_has_forbidden_location_key(jsonb)',
    'EXECUTE'
  ),
  'server role can execute the analytics privacy validator'
);

-- 64
select throws_ok(
  $sql$
    do $test_body$
    begin
      update public.acquisitions
      set acquisition_type = 'gift',
          verification_result = 'not_applicable'
      where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4';

      set constraints retro_acquisition_requires_grant immediate;
    end
    $test_body$
  $sql$,
  '23514',
  null,
  'an audited retro acquisition cannot be retyped'
);

-- 65
select throws_ok(
  $sql$
    do $test_body$
    begin
      delete from private.retro_grants
      where acquisition_id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4';

      set constraints private.retro_grant_removal_keeps_audit immediate;
    end
    $test_body$
  $sql$,
  '23514',
  null,
  'a retro audit grant cannot be removed from a live retro acquisition'
);

insert into private.recovery_codes (
  user_id,
  code_hash,
  claimed_at,
  claimed_by_auth_user_id
)
select
  user_id,
  extensions.digest('claimed-code-for-redaction', 'sha256'),
  now(),
  '33333333-3333-4333-8333-333333333333'
from private.user_identities
where auth_user_id = '11111111-1111-4111-8111-111111111111'
  and revoked_at is null;

delete from auth.users
where id = '33333333-3333-4333-8333-333333333333';

-- 66
select ok(
  (
    select
      claimed_at is not null
      and claimed_by_auth_user_id is null
      and claimant_redacted_at >= claimed_at
    from private.recovery_codes
    where code_hash = extensions.digest('claimed-code-for-redaction', 'sha256')
  ),
  'deleting an auth user redacts the recovery claimant without losing claim history'
);

select * from finish();
rollback;
