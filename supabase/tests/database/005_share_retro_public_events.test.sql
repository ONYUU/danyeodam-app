begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

-- Schema and server-only ACL boundary ------------------------------------

select ok(
  (
    select
      index_row.indisunique
      and pg_get_expr(index_row.indpred, index_row.indrelid)
        like '%acquisition_type = ''retro''%'
    from pg_index as index_row
    where index_row.indexrelid =
      'public.acquisitions_one_retro_per_user_spot_idx'::regclass
  ),
  'retro idempotency has a narrow partial unique index'
);

select ok(
  (
    select pg_get_constraintdef(constraint_row.oid)
      like '%[A-Za-z0-9]{22,128}%'
    from pg_constraint as constraint_row
    where constraint_row.conrelid = 'public.personal_cards'::regclass
      and constraint_row.conname = 'personal_cards_share_slug_shape'
  ),
  'stored share slugs use the same 22-to-128 character base62 boundary'
);

select ok(
  (
    select pg_get_constraintdef(constraint_row.oid)
      like '%personal_card_id IS NOT NULL%'
    from pg_constraint as constraint_row
    where constraint_row.conrelid = 'analytics.events'::regclass
      and constraint_row.conname = 'analytics_events_personal_card_boundary'
  ),
  'share-view facts require a resolved personal-card id'
);

select throws_ok(
  $sql$
    insert into analytics.events (
      user_id,
      event_name,
      source,
      occurred_at,
      properties
    ) values (
      null,
      'share_view',
      'server',
      clock_timestamp(),
      '{}'::jsonb
    )
  $sql$,
  '23514',
  null,
  'share-view storage rejects unresolved raw-secret facts'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname in (
        'create_personal_card_share',
        'revoke_personal_card_share',
        'get_public_share',
        'record_landing_view',
        'grant_retro_acquisition'
      )
  ),
  5::bigint,
  'all five share, public-event, and retro RPCs exist'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname in (
        'create_personal_card_share',
        'revoke_personal_card_share',
        'get_public_share',
        'record_landing_view',
        'grant_retro_acquisition'
      )
      and function_row.prosecdef
      and coalesce(function_row.proconfig, array[]::text[])
        @> array['search_path=""']::text[]
  ),
  5::bigint,
  'all five RPCs are SECURITY DEFINER with an empty search_path'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname in (
        'create_personal_card_share',
        'revoke_personal_card_share',
        'get_public_share',
        'record_landing_view',
        'grant_retro_acquisition'
      )
      and has_function_privilege('service_role', function_row.oid, 'EXECUTE')
  ),
  5::bigint,
  'service_role can execute all five RPCs'
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
        'create_personal_card_share',
        'revoke_personal_card_share',
        'get_public_share',
        'record_landing_view',
        'grant_retro_acquisition'
      )
      and has_function_privilege(
        browser_role.role_name,
        function_row.oid,
        'EXECUTE'
      )
  ),
  0::bigint,
  'browser roles cannot execute the server-only RPCs'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    cross join lateral aclexplode(
      coalesce(
        function_row.proacl,
        acldefault('f', function_row.proowner)
      )
    ) as acl_row
    where schema_row.nspname = 'api_private'
      and function_row.proname in (
        'create_personal_card_share',
        'revoke_personal_card_share',
        'get_public_share',
        'record_landing_view',
        'grant_retro_acquisition'
      )
      and acl_row.grantee = 0
      and acl_row.privilege_type = 'EXECUTE'
  ),
  0::bigint,
  'PUBLIC execute is explicitly absent from all five RPCs'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname in (
        'create_personal_card_share',
        'revoke_personal_card_share',
        'grant_retro_acquisition'
      )
      and (
        upper(pg_get_functiondef(function_row.oid)) like '%FOR SHARE%'
        or pg_get_functiondef(function_row.oid)
          like '%private.lock_%active_user_id_for_auth%'
        or pg_get_functiondef(function_row.oid)
          like '%private.lock_field_derivative_access%'
        or pg_get_functiondef(function_row.oid)
          like '%private.consume_authenticated_api_rate_limit%'
      )
  ),
  3::bigint,
  'every identity-protected write holds a shared active-identity lock'
);

select ok(
  (
    select
      pg_get_functiondef(function_row.oid) like '%private.admin_members%'
      and pg_get_functiondef(function_row.oid) not like '%raw_user_meta_data%'
      and pg_get_functiondef(function_row.oid) not like '%raw_app_meta_data%'
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname = 'grant_retro_acquisition_unrated'
  ),
  'retro authorization reads fresh admin membership rather than JWT metadata'
);

select ok(
  (
    select
      lower(pg_get_functiondef(function_row.oid))
        like '%identity_row.user_id = p_app_user_id%'
      and lower(pg_get_functiondef(function_row.oid))
        like '%order by identity_row.user_id::text, identity_row.auth_user_id::text%'
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname = 'grant_retro_acquisition_unrated'
  ),
  'retro grant locks the target identity in recovery-compatible order'
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
  ('a2000000-0000-4000-8000-000000000001', now(), now(), true, '{}'::jsonb),
  ('a2000000-0000-4000-8000-000000000002', now(), now(), true, '{}'::jsonb),
  ('a2000000-0000-4000-8000-000000000003', now(), now(), true, '{}'::jsonb),
  ('a2000000-0000-4000-8000-000000000004', now(), now(), false, '{}'::jsonb),
  (
    'a2000000-0000-4000-8000-000000000005',
    now(),
    now(),
    false,
    '{"role":"admin","is_admin":true}'::jsonb
  ),
  ('a2000000-0000-4000-8000-000000000006', now(), now(), true, '{}'::jsonb);

create temp table test_user_ids (
  fixture_name text primary key,
  user_id uuid not null
) on commit drop;

insert into test_user_ids (fixture_name, user_id)
select fixture.fixture_name, identity_row.user_id
from (
  values
    ('owner', 'a2000000-0000-4000-8000-000000000001'::uuid),
    ('other_owner', 'a2000000-0000-4000-8000-000000000002'::uuid),
    ('gate_closed', 'a2000000-0000-4000-8000-000000000003'::uuid),
    ('admin', 'a2000000-0000-4000-8000-000000000004'::uuid),
    ('forged_admin', 'a2000000-0000-4000-8000-000000000005'::uuid),
    ('retro_target', 'a2000000-0000-4000-8000-000000000006'::uuid)
) as fixture(fixture_name, auth_user_id)
join private.user_identities as identity_row
  on identity_row.auth_user_id = fixture.auth_user_id
 and identity_row.revoked_at is null;

insert into public.app_users (id)
values ('a2000000-0000-4000-8000-000000000007');

insert into test_user_ids (fixture_name, user_id)
values ('orphan_target', 'a2000000-0000-4000-8000-000000000007');

insert into private.admin_members (auth_user_id)
values ('a2000000-0000-4000-8000-000000000004');

insert into public.regions (code, country_code, sort_order)
values ('test', 'KR', 1);

insert into public.region_translations (
  region_code, locale, name, status, approved_at, approved_by
)
select
  'test',
  locale_row.locale,
  'Test',
  'approved',
  now(),
  'a2000000-0000-4000-8000-000000000004'
from unnest(enum_range(null::public.content_locale))
  as locale_row(locale);

insert into private.participant_access (user_id, access_kind)
select user_id, 'internal_tester'
from test_user_ids
where fixture_name in ('owner', 'other_owner');

insert into private.policy_documents (
  id, policy_type, version, effective_at, published_at, is_current
)
values
  (
    'd2000000-0000-4000-8000-000000000001',
    'terms_of_use', 'test-1', now() - interval '1 day', now(), false
  ),
  (
    'd2000000-0000-4000-8000-000000000002',
    'privacy_policy', 'test-1', now() - interval '1 day', now(), false
  ),
  (
    'd2000000-0000-4000-8000-000000000003',
    'community_guidelines', 'test-1', now() - interval '1 day', now(), false
  ),
  (
    'd2000000-0000-4000-8000-000000000004',
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
  'share fixtures use the serialized policy publication path'
);

select is(
  api_private.accept_current_policies(
    fixture.auth_user_id,
    jsonb_build_array(
      jsonb_build_object('type', 'terms_of_use', 'version', 'test-1', 'locale', 'ko'),
      jsonb_build_object('type', 'community_guidelines', 'version', 'test-1', 'locale', 'ko')
    )
  ),
  '{"status":"accepted"}'::jsonb,
  'share owners accept the current review policies'
)
from (
  values
    ('a2000000-0000-4000-8000-000000000001'::uuid),
    ('a2000000-0000-4000-8000-000000000002'::uuid)
) as fixture(auth_user_id);

insert into private.minimum_age_attestations (
  user_id, minimum_age_passed, version
)
select user_id, true, '18plus-v1'
from test_user_ids
where fixture_name in ('owner', 'other_owner');

do $fixture$
declare
  auth_id uuid;
begin
  for auth_id in
    select unnest(array[
      'a2000000-0000-4000-8000-000000000001'::uuid,
      'a2000000-0000-4000-8000-000000000002'::uuid
    ])
  loop
    perform api_private.accept_location_consent(
      auth_id,
      jsonb_build_object('version', 'test-1', 'locale', 'ko')
    );
  end loop;
end;
$fixture$;

insert into public.spots (
  id,
  slug,
  region,
  name_ko,
  name_en,
  status,
  latitude,
  longitude,
  radius_m,
  accuracy_threshold_m
)
values
  (
    'b2000000-0000-4000-8000-000000000001',
    'share-retro-spot',
    'test',
    '공개 스팟',
    'Public Spot',
    'draft',
    37.5,
    127.0,
    300,
    300
  ),
  (
    'b2000000-0000-4000-8000-000000000002',
    'unpublished-retro-spot',
    'test',
    '미발행 스팟',
    'Unpublished Spot',
    'draft',
    37.6,
    127.1,
    300,
    300
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
  'a2000000-0000-4000-8000-000000000004'
from public.spots as spot_row
cross join unnest(enum_range(null::public.content_locale))
  as locale_row(locale)
where spot_row.id in (
  'b2000000-0000-4000-8000-000000000001',
  'b2000000-0000-4000-8000-000000000002'
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
values
  (
    'c2000000-0000-4000-8000-000000000001',
    'b2000000-0000-4000-8000-000000000001',
    'share-retro-card',
    'region',
    '공개 카드',
    'Public Card',
    'cards/share-retro.webp',
    '#123456',
    false,
    null
  ),
  (
    'c2000000-0000-4000-8000-000000000002',
    'b2000000-0000-4000-8000-000000000002',
    'unpublished-retro-card',
    'region',
    '미발행 카드',
    'Unpublished Card',
    'cards/unpublished-retro.webp',
    '#654321',
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
  'a2000000-0000-4000-8000-000000000004'
from public.cards as card_row
cross join unnest(enum_range(null::public.content_locale))
  as locale_row(locale)
where card_row.id in (
  'c2000000-0000-4000-8000-000000000001',
  'c2000000-0000-4000-8000-000000000002'
);

update public.cards
set is_published = true,
    published_at = now()
where id = 'c2000000-0000-4000-8000-000000000001';

update public.spots
set status = 'open'
where id = 'b2000000-0000-4000-8000-000000000001';

insert into private.location_use_facts (
  user_id, idempotency_key, spot_id, purpose, collected_at
)
values
  (
    (select user_id from test_user_ids where fixture_name = 'owner'),
    'e2000000-0000-4000-8000-000000000001',
    'b2000000-0000-4000-8000-000000000001',
    'field_acquisition',
    '2026-08-08 15:30:00+00'
  ),
  (
    (select user_id from test_user_ids where fixture_name = 'other_owner'),
    'e2000000-0000-4000-8000-000000000002',
    'b2000000-0000-4000-8000-000000000001',
    'field_acquisition',
    '2026-08-08 16:30:00+00'
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
    'd2000000-0000-4000-8000-000000000001',
    (select user_id from test_user_ids where fixture_name = 'owner'),
    'b2000000-0000-4000-8000-000000000001',
    'c2000000-0000-4000-8000-000000000001',
    'field',
    'passed',
    'e2000000-0000-4000-8000-000000000001',
    2001,
    '2026-08-08 15:30:00+00'
  ),
  (
    'd2000000-0000-4000-8000-000000000002',
    (select user_id from test_user_ids where fixture_name = 'other_owner'),
    'b2000000-0000-4000-8000-000000000001',
    'c2000000-0000-4000-8000-000000000001',
    'field',
    'passed',
    'e2000000-0000-4000-8000-000000000002',
    2002,
    '2026-08-08 16:30:00+00'
  );

insert into public.personal_cards (
  id,
  user_id,
  acquisition_id,
  photo_path,
  caption
)
values
  (
    'f2000000-0000-4000-8000-000000000001',
    (select user_id from test_user_ids where fixture_name = 'owner'),
    'd2000000-0000-4000-8000-000000000001',
    (
      select user_id::text || '/owner.webp'
      from test_user_ids
      where fixture_name = 'owner'
    ),
    '주말 기억'
  ),
  (
    'f2000000-0000-4000-8000-000000000002',
    (select user_id from test_user_ids where fixture_name = 'other_owner'),
    'd2000000-0000-4000-8000-000000000002',
    (
      select user_id::text || '/other.webp'
      from test_user_ids
      where fixture_name = 'other_owner'
    ),
    '다른 기억'
  );

-- Share creation, gate, ownership, and event idempotency ------------------

select is(
  api_private.create_personal_card_share(
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    false,
    false,
    'f2000000-0000-4000-8000-000000000001',
    'MissingIdentitySlug0001'
  ),
  '{"status":"unauthorized"}'::jsonb,
  'share creation requires an active service identity'
);

select is(
  api_private.create_personal_card_share(
    'a2000000-0000-4000-8000-000000000003',
    false,
    false,
    'f2000000-0000-4000-8000-000000000001',
    'ClosedGateShareSlug001'
  ),
  '{"status":"participant_gate_closed"}'::jsonb,
  'share creation enforces the participant gate'
);

select is(
  api_private.create_personal_card_share(
    'a2000000-0000-4000-8000-000000000001',
    false,
    false,
    'f2000000-0000-4000-8000-000000000002',
    'OwnershipAttackSlug001'
  ),
  '{"status":"not_found"}'::jsonb,
  'share creation hides another user personal card'
);

select is(
  api_private.create_personal_card_share(
    'a2000000-0000-4000-8000-000000000001',
    false,
    false,
    'f2000000-0000-4000-8000-000000000001',
    'ShareCreationClosed001'
  ),
  '{"status":"share_creation_gate_closed"}'::jsonb,
  'share creation has a distinct closed feature gate result'
);

select is(
  api_private.create_personal_card_share(
    'a2000000-0000-4000-8000-000000000002',
    false,
    true,
    'f2000000-0000-4000-8000-000000000002',
    'CollisionShareSlug0001'
  ),
  '{"status":"pending","share_slug":"CollisionShareSlug0001","share_state":"pending"}'::jsonb,
  'a participant can submit a high-entropy slug for review'
);

select is(
  api_private.create_personal_card_share(
    'a2000000-0000-4000-8000-000000000001',
    false,
    true,
    'f2000000-0000-4000-8000-000000000001',
    'too-short'
  ),
  jsonb_build_object(
    'status', 'slug_conflict',
    'expected_user_id', (select user_id from test_user_ids where fixture_name = 'owner')
  ),
  'malformed share secrets are rejected with the server-only retry owner and without mutating the card'
);

select is(
  api_private.create_personal_card_share(
    'a2000000-0000-4000-8000-000000000001',
    false,
    true,
    'f2000000-0000-4000-8000-000000000001',
    'MalformedShareSlug0000_'
  ),
  jsonb_build_object(
    'status', 'slug_conflict',
    'expected_user_id', (select user_id from test_user_ids where fixture_name = 'owner')
  ),
  'non-base62 share secrets are rejected with the server-only retry owner at the RPC boundary'
);

select is(
  api_private.create_personal_card_share(
    'a2000000-0000-4000-8000-000000000001',
    false,
    true,
    'f2000000-0000-4000-8000-000000000001',
    'CollisionShareSlug0001'
  ),
  jsonb_build_object(
    'status', 'slug_conflict',
    'expected_user_id', (select user_id from test_user_ids where fixture_name = 'owner')
  ),
  'a secret already bound to another card reports a slug conflict with the server-only retry owner'
);

select is(
  api_private.create_personal_card_share(
    'a2000000-0000-4000-8000-000000000001',
    false,
    true,
    'f2000000-0000-4000-8000-000000000001',
    'OwnerShareSlug00000001'
  ),
  '{"status":"pending","share_slug":"OwnerShareSlug00000001","share_state":"pending"}'::jsonb,
  'an owner can submit their personal card for review'
);

select is(
  api_private.create_personal_card_share(
    'a2000000-0000-4000-8000-000000000001',
    false,
    false,
    'f2000000-0000-4000-8000-000000000001',
    'IgnoredRetrySlug000001'
  ),
  '{"status":"existing","share_slug":"OwnerShareSlug00000001","share_state":"pending"}'::jsonb,
  'a repeat share request returns the original secret without rotating it'
);

select is(
  (
    select count(*)::bigint
    from analytics.events as event_row
    where event_row.event_name = 'share_created'
  ),
  2::bigint,
  'only the two first successful share transitions emit share-created facts'
);

-- Public share privacy and unauthenticated view analytics ----------------

select throws_ok(
  $sql$
    update public.personal_cards
    set share_state = 'active',
        share_resubmission_required = false,
        share_terms_acceptance_id =
          'aa000000-0000-4000-8000-000000000001',
        share_community_acceptance_id =
          'aa000000-0000-4000-8000-000000000002',
        share_reviewed_at = now(),
        share_reviewed_by =
          'a2000000-0000-4000-8000-000000000004'
    where id = 'f2000000-0000-4000-8000-000000000002'
  $sql$,
  '23514',
  'moderated share transitions require the moderation RPC',
  'direct data mutation cannot bypass the moderation audit RPC'
);

select is(
  api_private.moderate_personal_card_share(
    'a2000000-0000-4000-8000-000000000004',
    'f2000000-0000-4000-8000-000000000002',
    'e2000000-0000-4000-8000-000000000001',
    'approve',
    'POLICY_OK',
    'test approval',
    true
  ),
  '{"status":"applied","share_state":"active","affected":1}'::jsonb,
  'an active administrator can approve a policy-complete pending share'
);

select is(
  api_private.get_public_share('CollisionShareSlug0001', null, false, true),
  jsonb_build_object(
    'status', 'found',
    'personal_card_id', 'f2000000-0000-4000-8000-000000000002'::uuid,
    'date_kst', '2026-08-09',
    'spot', jsonb_build_object(
      'name', jsonb_build_object(
        'ko', '공개 스팟',
        'en', 'Public Spot',
        'ja', 'Public Spot',
        'zh-Hans', 'Public Spot',
        'zh-Hant', 'Public Spot',
        'vi', 'Public Spot'
      )
    ),
    'caption', '다른 기억',
    'photo_path', (
      select user_id::text || '/other.webp'
      from test_user_ids
      where fixture_name = 'other_owner'
    )
  ),
  'public share exposes only KST date, spot names, caption, and photo path'
);

select is(
  (
    select count(*)::bigint
    from analytics.events as event_row
    where event_row.event_name = 'share_view'
  ),
  0::bigint,
  'a non-recording public lookup does not inflate share-view metrics'
);

select is(
  api_private.get_public_share(
    'CollisionShareSlug0001',
    null,
    true,
    true
  ) ->> 'status',
  'found',
  'a recording public lookup still returns the share'
);

select ok(
  (
    select
      event_row.user_id is null
      and event_row.source = 'server'
      and event_row.spot_id is null
      and event_row.personal_card_id =
        'f2000000-0000-4000-8000-000000000002'
      and event_row.properties = '{}'::jsonb
    from analytics.events as event_row
    where event_row.event_name = 'share_view'
  ),
  'share-view is an unauthenticated server fact with allowlisted properties'
);

select is(
  api_private.get_public_share(
    'NoSuchPublicShareSlug001',
    null,
    true,
    true
  ),
  '{"status":"not_found"}'::jsonb,
  'an unknown share secret returns no public data'
);

select is(
  (
    select count(*)::bigint
    from analytics.events as event_row
    where event_row.event_name = 'share_view'
  ),
  1::bigint,
  'a missing share does not emit a share-view fact'
);

-- Share revocation -------------------------------------------------------

select is(
  api_private.revoke_personal_card_share(
    'a2000000-0000-4000-8000-000000000003',
    'f2000000-0000-4000-8000-000000000001'
  ),
  '{"status":"not_found"}'::jsonb,
  'a non-participant reaches ownership checks without a gate-dependent result'
);

select is(
  api_private.revoke_personal_card_share(
    'a2000000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000002'
  ),
  '{"status":"not_found"}'::jsonb,
  'an owner cannot revoke another user share'
);

delete from private.participant_access as access_row
where access_row.user_id = (
  select user_id from test_user_ids where fixture_name = 'owner'
);

select is(
  (
    select count(*)::bigint
    from private.participant_access as access_row
    where access_row.user_id = (
      select user_id from test_user_ids where fixture_name = 'owner'
    )
      and access_row.revoked_at is null
      and (
        access_row.expires_at is null
        or access_row.expires_at > clock_timestamp()
      )
  ),
  0::bigint,
  'the revoking owner has no active participant access'
);

select is(
  api_private.revoke_personal_card_share(
    'a2000000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000001'
  ),
  '{"status":"revoked"}'::jsonb,
  'a non-participant owner can revoke an active share'
);

select is(
  api_private.get_public_share(
    'OwnerShareSlug00000001',
    null,
    true,
    true
  ),
  '{"status":"not_found"}'::jsonb,
  'a revoked slug becomes unavailable immediately'
);

select is(
  api_private.revoke_personal_card_share(
    'a2000000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000001'
  ),
  '{"status":"already_revoked"}'::jsonb,
  'repeat revocation is idempotent'
);

select is(
  (
    select count(*)::bigint
    from analytics.events as event_row
    where event_row.event_name = 'share_revoked'
      and event_row.user_id = (
        select user_id from test_user_ids where fixture_name = 'owner'
      )
  ),
  1::bigint,
  'only the first revocation transition emits a share-revoked fact'
);

-- Landing server facts ---------------------------------------------------

select is(
  api_private.record_landing_view('email'),
  '{"status":"invalid"}'::jsonb,
  'landing ref rejects values outside the fixed allowlist'
);

select is(
  (
    select count(*)::bigint
    from analytics.events as event_row
    where event_row.event_name = 'landing_view'
  ),
  0::bigint,
  'an invalid landing ref is not recorded'
);

select is(
  api_private.record_landing_view('sns'),
  '{"status":"recorded"}'::jsonb,
  'an allowlisted landing ref is recorded'
);

select ok(
  (
    select
      event_row.user_id is null
      and event_row.source = 'server'
      and event_row.spot_id is null
      and event_row.properties = '{"ref":"sns"}'::jsonb
    from analytics.events as event_row
    where event_row.event_name = 'landing_view'
  ),
  'landing-view is an unauthenticated server fact with only its ref property'
);

-- Administrator retro grants, audit, and idempotency --------------------

select is(
  api_private.grant_retro_acquisition(
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    (select user_id from test_user_ids where fixture_name = 'retro_target'),
    'b2000000-0000-4000-8000-000000000001',
    null
  ),
  '{"status":"unauthorized"}'::jsonb,
  'retro grant requires an active administrator service identity'
);

select is(
  api_private.grant_retro_acquisition(
    'a2000000-0000-4000-8000-000000000005',
    (select user_id from test_user_ids where fixture_name = 'retro_target'),
    'b2000000-0000-4000-8000-000000000001',
    null
  ),
  '{"status":"forbidden"}'::jsonb,
  'forged user metadata cannot grant retro acquisitions'
);

select is(
  api_private.grant_retro_acquisition(
    'a2000000-0000-4000-8000-000000000004',
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    'b2000000-0000-4000-8000-000000000001',
    'missing user check'
  ),
  '{"status":"not_found"}'::jsonb,
  'retro grant rejects a missing logical user'
);

select is(
  api_private.grant_retro_acquisition(
    'a2000000-0000-4000-8000-000000000004',
    (select user_id from test_user_ids where fixture_name = 'orphan_target'),
    'b2000000-0000-4000-8000-000000000001',
    'orphan user check'
  ),
  '{"status":"not_found"}'::jsonb,
  'retro grant rejects a logical user without an active identity'
);

select is(
  api_private.grant_retro_acquisition(
    'a2000000-0000-4000-8000-000000000004',
    (select user_id from test_user_ids where fixture_name = 'retro_target'),
    'b2000000-0000-4000-8000-000000000002',
    'unpublished card check'
  ),
  '{"status":"not_found"}'::jsonb,
  'retro grant requires a published regional card for the spot'
);

create temp table test_retro_result (
  result jsonb not null
) on commit drop;

insert into test_retro_result (result)
values (
  api_private.grant_retro_acquisition(
    'a2000000-0000-4000-8000-000000000004',
    (select user_id from test_user_ids where fixture_name = 'retro_target'),
    'b2000000-0000-4000-8000-000000000001',
    '요청 확인 후 수동 지급'
  )
);

select is(
  (select result ->> 'status' from test_retro_result),
  'created',
  'an active database administrator can grant a retro acquisition'
);

select set_eq(
  $$
    select jsonb_object_keys(result -> 'acquisition')
    from test_retro_result
  $$,
  $$
    values
      ('id'::text),
      ('spot_id'::text),
      ('card_id'::text),
      ('type'::text),
      ('acquired_at'::text)
  $$,
  'retro response contains only the safe acquisition fields'
);

select ok(
  (
    select
      result #>> '{acquisition,type}' = 'retro'
      and result #>> '{acquisition,spot_id}' =
        'b2000000-0000-4000-8000-000000000001'
      and result::text !~
        '(field_sequence|latitude|longitude|accuracy|radius|threshold)'
    from test_retro_result
  ),
  'retro response omits sequence, location, and threshold internals'
);

select ok(
  (
    select
      acquisition_row.acquisition_type = 'retro'
      and acquisition_row.verification_result = 'manual'
      and acquisition_row.field_sequence is null
      and acquisition_row.card_id =
        'c2000000-0000-4000-8000-000000000001'
    from public.acquisitions as acquisition_row
    where acquisition_row.id = (
      select (result #>> '{acquisition,id}')::uuid
      from test_retro_result
    )
  ),
  'retro persistence uses the published card and no field sequence'
);

select ok(
  (
    select
      grant_row.admin_auth_user_id =
        'a2000000-0000-4000-8000-000000000004'
      and grant_row.reason_code = 'admin_manual'
      and grant_row.note = '요청 확인 후 수동 지급'
    from private.retro_grants as grant_row
    where grant_row.acquisition_id = (
      select (result #>> '{acquisition,id}')::uuid
      from test_retro_result
    )
  ),
  'retro creation writes its one-to-one administrator audit row atomically'
);

select ok(
  (
    select
      event_row.user_id = (
        select user_id
        from test_user_ids
        where fixture_name = 'retro_target'
      )
      and event_row.source = 'server'
      and event_row.spot_id =
        'b2000000-0000-4000-8000-000000000001'
      and event_row.properties = '{}'::jsonb
    from analytics.events as event_row
    where event_row.event_name = 'retro_granted'
  ),
  'retro grant emits one attributable server fact without free-form props'
);

create temp table test_retro_replay (
  result jsonb not null
) on commit drop;

insert into test_retro_replay (result)
values (
  api_private.grant_retro_acquisition(
    'a2000000-0000-4000-8000-000000000004',
    (select user_id from test_user_ids where fixture_name = 'retro_target'),
    'b2000000-0000-4000-8000-000000000001',
    '재시도는 무시'
  )
);

select is(
  (select result ->> 'status' from test_retro_replay),
  'existing',
  'repeat administrator grant is idempotent'
);

select is(
  (select result -> 'acquisition' from test_retro_replay),
  (select result -> 'acquisition' from test_retro_result),
  'retro replay returns the original safe acquisition payload'
);

select is(
  (
    select count(*)::bigint
    from private.retro_grants as grant_row
    join public.acquisitions as acquisition_row
      on acquisition_row.id = grant_row.acquisition_id
    where acquisition_row.user_id = (
      select user_id from test_user_ids where fixture_name = 'retro_target'
    )
      and acquisition_row.spot_id =
        'b2000000-0000-4000-8000-000000000001'
  ),
  1::bigint,
  'retro replay does not duplicate the audit ledger'
);

select is(
  (
    select count(*)::bigint
    from analytics.events as event_row
    where event_row.event_name = 'retro_granted'
      and event_row.user_id = (
        select user_id from test_user_ids where fixture_name = 'retro_target'
      )
  ),
  1::bigint,
  'retro replay does not duplicate the server event'
);

select throws_ok(
  $sql$
    insert into public.acquisitions (
      user_id,
      spot_id,
      card_id,
      acquisition_type,
      verification_result,
      idempotency_key,
      acquired_at
    )
    select
      user_id,
      'b2000000-0000-4000-8000-000000000001',
      'c2000000-0000-4000-8000-000000000001',
      'retro',
      'manual',
      'e2000000-0000-4000-8000-000000000099',
      now()
    from test_user_ids
    where fixture_name = 'retro_target'
  $sql$,
  '23505',
  null,
  'the database prevents a second retro acquisition for one user and spot'
);

select throws_ok(
  $sql$
    select api_private.grant_retro_acquisition(
      'a2000000-0000-4000-8000-000000000004',
      (select user_id from test_user_ids where fixture_name = 'retro_target'),
      'b2000000-0000-4000-8000-000000000001',
      '   '
    )
  $sql$,
  '22023',
  null,
  'retro grants require a non-empty administrator audit note'
);

select throws_ok(
  $sql$
    select api_private.grant_retro_acquisition(
      'a2000000-0000-4000-8000-000000000004',
      (select user_id from test_user_ids where fixture_name = 'retro_target'),
      'b2000000-0000-4000-8000-000000000001',
      repeat('x', 501)
    )
  $sql$,
  '22001',
  null,
  'retro notes cannot exceed the existing 500-character audit limit'
);

set constraints public.retro_acquisition_requires_grant immediate;
set constraints public.retro_acquisition_requires_grant deferred;

update private.admin_members
set revoked_at = clock_timestamp()
where auth_user_id = 'a2000000-0000-4000-8000-000000000004';

select is(
  api_private.grant_retro_acquisition(
    'a2000000-0000-4000-8000-000000000004',
    (select user_id from test_user_ids where fixture_name = 'retro_target'),
    'b2000000-0000-4000-8000-000000000001',
    null
  ),
  '{"status":"forbidden"}'::jsonb,
  'a revoked admin membership takes effect on the next request'
);

select * from finish();
rollback;
