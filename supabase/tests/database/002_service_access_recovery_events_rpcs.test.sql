begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

-- Schema and ACL boundary -------------------------------------------------

select has_table(
  'private',
  'participant_invite_codes',
  'participant invitation digests use a private table'
);
select has_table(
  'private',
  'participant_redeem_limits',
  'participant redemption throttling uses a private table'
);

select is(
  (
    select count(*)::bigint
    from pg_class as relation_row
    join pg_namespace as schema_row
      on schema_row.oid = relation_row.relnamespace
    where schema_row.nspname = 'private'
      and relation_row.relname in (
        'participant_invite_codes',
        'participant_redeem_limits'
      )
      and relation_row.relrowsecurity
      and relation_row.relforcerowsecurity
  ),
  2::bigint,
  'new private tables enable and force RLS'
);

select is(
  (
    select count(*)::bigint
    from information_schema.role_table_grants as grant_row
    where grant_row.table_schema = 'private'
      and grant_row.table_name in (
        'participant_invite_codes',
        'participant_redeem_limits'
      )
      and grant_row.grantee in ('anon', 'authenticated')
  ),
  0::bigint,
  'browser roles have no grants on invitation or throttle tables'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname in (
        'issue_participant_invites',
        'redeem_participant_invite',
        'issue_recovery_code',
        'claim_recovery_code',
        'ingest_client_events',
        'create_physical_request',
        'has_active_identity'
      )
  ),
  7::bigint,
  'all seven Stage 0 server RPCs exist'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname in (
        'issue_participant_invites',
        'redeem_participant_invite',
        'issue_recovery_code',
        'claim_recovery_code',
        'ingest_client_events',
        'create_physical_request',
        'has_active_identity'
      )
      and function_row.prosecdef
      and coalesce(function_row.proconfig, array[]::text[])
        @> array['search_path=""']::text[]
  ),
  7::bigint,
  'all seven RPCs are SECURITY DEFINER with an empty search_path'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname in (
        'issue_participant_invites',
        'redeem_participant_invite',
        'issue_recovery_code',
        'claim_recovery_code',
        'ingest_client_events',
        'create_physical_request',
        'has_active_identity'
      )
      and has_function_privilege('service_role', function_row.oid, 'EXECUTE')
  ),
  7::bigint,
  'service_role can execute all seven RPCs'
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
        'issue_participant_invites',
        'redeem_participant_invite',
        'issue_recovery_code',
        'claim_recovery_code',
        'ingest_client_events',
        'create_physical_request',
        'has_active_identity'
      )
      and has_function_privilege(
        browser_role.role_name,
        function_row.oid,
        'EXECUTE'
      )
  ),
  0::bigint,
  'browser roles cannot execute any of the seven RPCs'
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
        'issue_participant_invites',
        'redeem_participant_invite',
        'issue_recovery_code',
        'claim_recovery_code',
        'ingest_client_events',
        'create_physical_request',
        'has_active_identity'
      )
      and acl_row.grantee = 0
      and acl_row.privilege_type = 'EXECUTE'
  ),
  0::bigint,
  'PUBLIC execute is explicitly absent from all seven RPCs'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname in (
        'acquire_commit_unrated',
        'record_acquire_failure_unrated',
        'issue_participant_invites_unrated',
        'redeem_participant_invite',
        'issue_recovery_code',
        'ingest_client_events_unrated',
        'create_physical_request_unrated'
      )
      and (
        upper(pg_get_functiondef(function_row.oid)) like '%FOR SHARE%'
        or pg_get_functiondef(function_row.oid) like '%lock_adult_location_access%'
        or pg_get_functiondef(function_row.oid)
          like '%ingest_client_events_before_location_compliance%'
      )
  ),
  7::bigint,
  'every protected write RPC shares-locks its fresh active identity row'
);

select ok(
  (
    select upper(pg_get_functiondef(function_row.oid)) like '%FOR UPDATE%'
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname =
        'claim_recovery_code_before_minimum_age_merge'
  ),
  'recovery claim exclusively locks identity rows before rebinding'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname in (
        'issue_recovery_code',
        'claim_recovery_code_before_minimum_age_merge'
      )
      and pg_get_functiondef(function_row.oid)
        like '%danyeodam:recovery:target:%'
  ),
  2::bigint,
  'recovery issue and claim share the same target-first advisory lock order'
);

select ok(
  (
    select index_row.indisunique
    from pg_index as index_row
    where index_row.indexrelid =
      'private.participant_invite_codes_code_hash_key'::regclass
  ),
  'invite digest uniqueness serializes concurrent consumers'
);

select is(
  (
    select data_type
    from information_schema.columns as column_row
    where column_row.table_schema = 'private'
      and column_row.table_name = 'participant_invite_codes'
      and column_row.column_name = 'code_hash'
  ),
  'bytea',
  'invite codes are stored only as binary digests'
);

select is(
  (
    select count(*)::bigint
    from information_schema.columns as column_row
    where column_row.table_schema = 'private'
      and column_row.table_name in (
        'participant_invite_codes',
        'recovery_codes'
      )
      and column_row.column_name in (
        'code',
        'plain_code',
        'invite_code',
        'recovery_code'
      )
  ),
  0::bigint,
  'neither invitation nor recovery tables have a plaintext-code column'
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
  ('a0000000-0000-4000-8000-000000000001', now(), now(), false, '{}'::jsonb),
  (
    'a0000000-0000-4000-8000-000000000002',
    now(),
    now(),
    false,
    '{"role":"admin","is_admin":true}'::jsonb
  ),
  ('a0000000-0000-4000-8000-000000000003', now(), now(), true, '{}'::jsonb),
  ('a0000000-0000-4000-8000-000000000004', now(), now(), true, '{}'::jsonb),
  ('a0000000-0000-4000-8000-000000000005', now(), now(), true, '{}'::jsonb),
  ('a0000000-0000-4000-8000-000000000006', now(), now(), true, '{}'::jsonb),
  ('a0000000-0000-4000-8000-000000000007', now(), now(), true, '{}'::jsonb),
  ('a0000000-0000-4000-8000-000000000008', now(), now(), false, '{}'::jsonb),
  ('a0000000-0000-4000-8000-000000000009', now(), now(), true, '{}'::jsonb),
  ('a0000000-0000-4000-8000-00000000000a', now(), now(), true, '{}'::jsonb),
  ('a0000000-0000-4000-8000-00000000000b', now(), now(), true, '{}'::jsonb),
  ('a0000000-0000-4000-8000-00000000000c', now(), now(), true, '{}'::jsonb);

create temp table test_user_ids (
  fixture_name text primary key,
  user_id uuid not null
) on commit drop;

insert into test_user_ids (fixture_name, user_id)
select fixture.fixture_name, identity_row.user_id
from (
  values
    ('admin', 'a0000000-0000-4000-8000-000000000001'::uuid),
    ('forged_admin', 'a0000000-0000-4000-8000-000000000002'::uuid),
    ('participant', 'a0000000-0000-4000-8000-000000000003'::uuid),
    ('invite_attacker', 'a0000000-0000-4000-8000-000000000004'::uuid),
    ('recovery_target', 'a0000000-0000-4000-8000-000000000005'::uuid),
    ('recovery_claimant', 'a0000000-0000-4000-8000-000000000006'::uuid),
    ('nonempty_claimant', 'a0000000-0000-4000-8000-000000000007'::uuid),
    ('nonanonymous_claimant', 'a0000000-0000-4000-8000-000000000008'::uuid),
    ('recovery_attacker', 'a0000000-0000-4000-8000-000000000009'::uuid),
    ('gate_closed', 'a0000000-0000-4000-8000-00000000000a'::uuid),
    ('second_redeemer', 'a0000000-0000-4000-8000-00000000000b'::uuid),
    ('unused', 'a0000000-0000-4000-8000-00000000000c'::uuid)
) as fixture(fixture_name, auth_user_id)
join private.user_identities as identity_row
  on identity_row.auth_user_id = fixture.auth_user_id
 and identity_row.revoked_at is null;

insert into private.admin_members (auth_user_id)
values ('a0000000-0000-4000-8000-000000000001');

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
  'a0000000-0000-4000-8000-000000000001'
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
  radius_m,
  accuracy_threshold_m
)
values (
  'b0000000-0000-4000-8000-000000000001',
  'test-spot-access',
  'test',
  '테스트 스팟',
  'Test Spot',
  'draft',
  37.5,
  127.0,
  300,
  300
);

insert into public.spot_translations (
  spot_id, locale, name, status, approved_at, approved_by
)
select
  'b0000000-0000-4000-8000-000000000001',
  locale_row.locale,
  case
    when locale_row.locale = 'ko' then '테스트 스팟'
    else 'Test Spot'
  end,
  'approved',
  now(),
  'a0000000-0000-4000-8000-000000000001'
from unnest(enum_range(null::public.content_locale))
  as locale_row(locale);

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
  'c0000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000001',
  'test-card-access',
  'region',
  '테스트 카드',
  'Test Card',
  'cards/test.webp',
  '#123456',
  false,
  null
);

insert into public.card_translations (
  card_id, locale, title, status, approved_at, approved_by
)
select
  'c0000000-0000-4000-8000-000000000001',
  locale_row.locale,
  case
    when locale_row.locale = 'ko' then '테스트 카드'
    else 'Test Card'
  end,
  'approved',
  now(),
  'a0000000-0000-4000-8000-000000000001'
from unnest(enum_range(null::public.content_locale))
  as locale_row(locale);

update public.cards
set is_published = true,
    published_at = now()
where id = 'c0000000-0000-4000-8000-000000000001';

update public.spots
set status = 'open'
where id = 'b0000000-0000-4000-8000-000000000001';

insert into private.location_use_facts (
  user_id, idempotency_key, spot_id, purpose
)
values
  (
    (select user_id from test_user_ids where fixture_name = 'recovery_target'),
    'e0000000-0000-4000-8000-000000000001',
    'b0000000-0000-4000-8000-000000000001',
    'field_acquisition'
  ),
  (
    (select user_id from test_user_ids where fixture_name = 'nonempty_claimant'),
    'e0000000-0000-4000-8000-000000000002',
    'b0000000-0000-4000-8000-000000000001',
    'field_acquisition'
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
    'd0000000-0000-4000-8000-000000000001',
    (select user_id from test_user_ids where fixture_name = 'recovery_target'),
    'b0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'field',
    'passed',
    'e0000000-0000-4000-8000-000000000001',
    1,
    now()
  ),
  (
    'd0000000-0000-4000-8000-000000000002',
    (select user_id from test_user_ids where fixture_name = 'nonempty_claimant'),
    'b0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    'field',
    'passed',
    'e0000000-0000-4000-8000-000000000002',
    2,
    now()
  );

-- An anonymous user may have redeemed the tester gate and sent telemetry
-- before recovering. API-CONTRACT section 6 still defines this user as empty
-- because it owns zero acquisitions.
insert into private.participant_access (user_id, access_kind)
values (
  (
    select user_id
    from test_user_ids
    where fixture_name = 'recovery_claimant'
  ),
  'internal_tester'
);

insert into analytics.events (
  client_event_id,
  user_id,
  event_name,
  source,
  occurred_at,
  properties
)
values (
  'f0000000-0000-4000-8000-000000000010',
  (
    select user_id
    from test_user_ids
    where fixture_name = 'recovery_claimant'
  ),
  'physical_interest_view',
  'client',
  now(),
  '{}'::jsonb
);

select is(
  api_private.has_active_identity(
    'a0000000-0000-4000-8000-000000000001'
  ),
  '{"status":"active"}'::jsonb,
  'active-identity RPC recognizes a fresh unrevoked binding'
);

select is(
  api_private.has_active_identity(
    'ffffffff-ffff-4fff-8fff-ffffffffffff'
  ),
  '{"status":"inactive"}'::jsonb,
  'active-identity RPC rejects a missing auth user'
);

select is(
  api_private.create_physical_request(
    'a0000000-0000-4000-8000-000000000006',
    false,
    'notify'
  ),
  '{"status":"created"}'::jsonb,
  'zero-acquisition claimant may already hold a physical demand signal'
);

-- Participant invitation behavior ---------------------------------------

select is(
  api_private.issue_participant_invites(
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    array[repeat('0', 64)],
    null
  ),
  '{"status":"unauthorized"}'::jsonb,
  'invitation issue requires a current active service binding'
);

select is(
  api_private.issue_participant_invites(
    'a0000000-0000-4000-8000-000000000002',
    array[repeat('0', 64)],
    null
  ),
  '{"status":"forbidden"}'::jsonb,
  'forged user metadata cannot create administrator authority'
);

select is(
  api_private.issue_participant_invites(
    'a0000000-0000-4000-8000-000000000001',
    array[repeat('a', 64), repeat('b', 64)],
    'Stage 0 testers'
  ),
  '{"status":"created","count":2}'::jsonb,
  'fresh admin table membership can issue one-use invitation digests'
);

select is(
  (
    select count(*)::bigint
    from private.participant_invite_codes as invite_row
    where invite_row.code_hash in (
      decode(repeat('a', 64), 'hex'),
      decode(repeat('b', 64), 'hex')
    )
      and octet_length(invite_row.code_hash) = 32
      and invite_row.entropy_bits = 128
  ),
  2::bigint,
  'only 32-byte hashes for 128-bit invitation codes are persisted'
);

select is(
  api_private.redeem_participant_invite(
    'a0000000-0000-4000-8000-000000000003',
    repeat('a', 64)
  ),
  '{"status":"redeemed"}'::jsonb,
  'a valid invitation is redeemed atomically'
);

select is(
  api_private.redeem_participant_invite(
    'a0000000-0000-4000-8000-00000000000b',
    repeat('a', 64)
  ),
  '{"status":"not_found"}'::jsonb,
  'a second contender cannot consume an invitation already redeemed'
);

select is(
  (
    select count(*)::bigint
    from private.participant_invite_codes as invite_row
    where invite_row.code_hash = decode(repeat('a', 64), 'hex')
      and invite_row.redeemed_at is not null
      and invite_row.redeemed_by_user_id = (
        select user_id
        from test_user_ids
        where fixture_name = 'participant'
      )
  ),
  1::bigint,
  'one-time redemption records exactly one winner under contention'
);

select is(
  api_private.redeem_participant_invite(
    'a0000000-0000-4000-8000-000000000004',
    repeat('1', 64)
  ) ->> 'status',
  'not_found',
  'first invalid invite attempt is indistinguishable from a consumed code'
);
select is(
  api_private.redeem_participant_invite(
    'a0000000-0000-4000-8000-000000000004',
    repeat('2', 64)
  ) ->> 'status',
  'not_found',
  'second invalid invite attempt is counted'
);
select is(
  api_private.redeem_participant_invite(
    'a0000000-0000-4000-8000-000000000004',
    repeat('3', 64)
  ) ->> 'status',
  'not_found',
  'third invalid invite attempt is counted'
);
select is(
  api_private.redeem_participant_invite(
    'a0000000-0000-4000-8000-000000000004',
    repeat('4', 64)
  ) ->> 'status',
  'not_found',
  'fourth invalid invite attempt is counted'
);
select is(
  api_private.redeem_participant_invite(
    'a0000000-0000-4000-8000-000000000004',
    repeat('5', 64)
  ),
  '{"status":"rate_limited","locked_minutes":15}'::jsonb,
  'fifth invalid invite attempt starts a 15-minute lock'
);
select is(
  api_private.redeem_participant_invite(
    'a0000000-0000-4000-8000-000000000004',
    repeat('b', 64)
  ) ->> 'status',
  'rate_limited',
  'a valid invitation cannot bypass an active redemption lock'
);

-- Recovery behavior ------------------------------------------------------

select is(
  api_private.issue_recovery_code(
    'a0000000-0000-4000-8000-000000000006',
    repeat('6', 64)
  ),
  '{"status":"no_acquisition"}'::jsonb,
  'an empty user cannot issue a recovery code'
);

select is(
  api_private.issue_recovery_code(
    'a0000000-0000-4000-8000-000000000005',
    repeat('6', 64)
  ),
  '{"status":"issued"}'::jsonb,
  'a user with an acquisition can issue a recovery code'
);

select is(
  api_private.issue_recovery_code(
    'a0000000-0000-4000-8000-000000000005',
    repeat('7', 64)
  ),
  '{"status":"issued"}'::jsonb,
  'reissuing a recovery code succeeds'
);

select is(
  (
    select count(*)::bigint
    from private.recovery_codes as code_row
    where code_row.user_id = (
      select user_id
      from test_user_ids
      where fixture_name = 'recovery_target'
    )
      and code_row.revoked_at is null
      and code_row.claimed_at is null
      and code_row.code_hash = decode(repeat('7', 64), 'hex')
  ),
  1::bigint,
  'reissue leaves only the newest recovery digest active'
);

select ok(
  (
    select code_row.revoked_at is not null
    from private.recovery_codes as code_row
    where code_row.code_hash = decode(repeat('6', 64), 'hex')
  ),
  'reissue revokes the previous recovery digest'
);

select is(
  api_private.claim_recovery_code(
    'a0000000-0000-4000-8000-000000000006',
    repeat('7', 64)
  ),
  '{"status":"restored"}'::jsonb,
  'an empty anonymous user can claim an active recovery code'
);

select is(
  (
    select identity_row.user_id
    from private.user_identities as identity_row
    where identity_row.auth_user_id =
      'a0000000-0000-4000-8000-000000000006'
      and identity_row.revoked_at is null
  ),
  (
    select user_id
    from test_user_ids
    where fixture_name = 'recovery_target'
  ),
  'claim binds the current UID to the recovered logical user'
);

select is(
  (
    select count(*)::bigint
    from private.user_identities as identity_row
    where identity_row.auth_user_id =
      'a0000000-0000-4000-8000-000000000005'
      and identity_row.revoked_at is null
  ),
  0::bigint,
  'claim immediately revokes the old active service binding'
);

select is(
  api_private.has_active_identity(
    'a0000000-0000-4000-8000-000000000005'
  ),
  '{"status":"inactive"}'::jsonb,
  'active-identity RPC blocks an old UID immediately after claim'
);

select is(
  api_private.has_active_identity(
    'a0000000-0000-4000-8000-000000000006'
  ),
  '{"status":"active"}'::jsonb,
  'active-identity RPC accepts the newly rebound UID'
);

select is(
  api_private.issue_recovery_code(
    'a0000000-0000-4000-8000-000000000005',
    repeat('8', 64)
  ),
  '{"status":"unauthorized"}'::jsonb,
  'a still-valid old JWT cannot pass the fresh binding check after claim'
);

select is(
  api_private.acquire_commit_unrated(
    'a0000000-0000-4000-8000-000000000005',
    'b0000000-0000-4000-8000-000000000001',
    'e0000000-0000-4000-8000-000000000009',
    true,
    (
      select spot_row.updated_at
      from public.spots as spot_row
      where spot_row.id = 'b0000000-0000-4000-8000-000000000001'
    )
  ),
  '{"status":"error","code":"UNAUTHORIZED"}'::jsonb,
  'acquire commit also rejects the revoked old UID after claim'
);

select is(
  (
    select count(*)::bigint
    from public.app_users as app_user
    where app_user.id = (
      select user_id
      from test_user_ids
      where fixture_name = 'recovery_claimant'
    )
  ),
  0::bigint,
  'the now-orphaned empty logical user is removed safely'
);

select ok(
  exists (
    select 1
    from private.participant_access as access_row
    where access_row.user_id = (
      select user_id
      from test_user_ids
      where fixture_name = 'recovery_target'
    )
      and access_row.revoked_at is null
      and (
        access_row.expires_at is null
        or access_row.expires_at > now()
      )
  ),
  'claim transfers active tester access to the recovered logical user'
);

select is(
  (
    select count(*)::bigint
    from analytics.events as event_row
    where event_row.user_id = (
      select user_id
      from test_user_ids
      where fixture_name = 'recovery_target'
    )
      and event_row.client_event_id =
        'f0000000-0000-4000-8000-000000000010'
  ),
  1::bigint,
  'claim preserves a pre-claim client event while merging the empty user'
);

select is(
  (
    select count(*)::bigint
    from public.physical_requests as request_row
    where request_row.user_id = (
      select user_id
      from test_user_ids
      where fixture_name = 'recovery_target'
    )
      and request_row.kind = 'notify'
  ),
  1::bigint,
  'claim merges a pre-claim physical request into the recovered user'
);

select ok(
  (
    select
      code_row.claimed_at is not null
      and code_row.claimed_by_auth_user_id =
        'a0000000-0000-4000-8000-000000000006'
    from private.recovery_codes as code_row
    where code_row.code_hash = decode(repeat('7', 64), 'hex')
  ),
  'recovery claim consumes the digest in the same transaction'
);

select is(
  api_private.issue_recovery_code(
    'a0000000-0000-4000-8000-000000000006',
    repeat('8', 64)
  ),
  '{"status":"issued"}'::jsonb,
  'the newly bound UID can issue a new code for the recovered account'
);

select is(
  api_private.claim_recovery_code(
    'a0000000-0000-4000-8000-000000000007',
    repeat('8', 64)
  ),
  '{"status":"not_empty"}'::jsonb,
  'a nonempty logical user cannot overwrite itself by recovery claim'
);

select is(
  api_private.claim_recovery_code(
    'a0000000-0000-4000-8000-000000000008',
    repeat('8', 64)
  ),
  '{"status":"not_anonymous"}'::jsonb,
  'a nonanonymous auth user cannot claim a recovery code'
);

select is(
  api_private.claim_recovery_code(
    'a0000000-0000-4000-8000-000000000009',
    repeat('1', 64)
  ) ->> 'status',
  'not_found',
  'first invalid recovery attempt is counted'
);
select is(
  api_private.claim_recovery_code(
    'a0000000-0000-4000-8000-000000000009',
    repeat('2', 64)
  ) ->> 'status',
  'not_found',
  'second invalid recovery attempt is counted'
);
select is(
  api_private.claim_recovery_code(
    'a0000000-0000-4000-8000-000000000009',
    repeat('3', 64)
  ) ->> 'status',
  'not_found',
  'third invalid recovery attempt is counted'
);
select is(
  api_private.claim_recovery_code(
    'a0000000-0000-4000-8000-000000000009',
    repeat('4', 64)
  ) ->> 'status',
  'not_found',
  'fourth invalid recovery attempt is counted'
);
select is(
  api_private.claim_recovery_code(
    'a0000000-0000-4000-8000-000000000009',
    repeat('5', 64)
  ),
  '{"status":"rate_limited","locked_minutes":15}'::jsonb,
  'fifth invalid recovery attempt starts a 15-minute lock'
);
select is(
  api_private.claim_recovery_code(
    'a0000000-0000-4000-8000-000000000009',
    repeat('8', 64)
  ) ->> 'status',
  'rate_limited',
  'an active recovery lock hides and protects a valid code'
);

-- Strict client event ingestion -----------------------------------------

select is(
  api_private.ingest_client_events(
    'a0000000-0000-4000-8000-000000000003',
    false,
    jsonb_build_array(
      jsonb_build_object(
        'client_event_id', 'f0000000-0000-4000-8000-000000000001',
        'event_name', 'spot_view',
        'occurred_at', now()::text,
        'spot_id', 'b0000000-0000-4000-8000-000000000001',
        'properties', jsonb_build_object(
          'spot_id', 'b0000000-0000-4000-8000-000000000001'
        )
      ),
      jsonb_build_object(
        'client_event_id', 'f0000000-0000-4000-8000-000000000002',
        'event_name', 'physical_interest_view',
        'occurred_at', now()::text,
        'spot_id', null,
        'properties', '{}'::jsonb
      )
    )
  ),
  '{"status":"accepted","accepted":2,"duplicates":0}'::jsonb,
  'qualified participant can ingest a strict client event batch'
);

select is(
  api_private.ingest_client_events(
    'a0000000-0000-4000-8000-000000000003',
    false,
    jsonb_build_array(
      jsonb_build_object(
        'client_event_id', 'f0000000-0000-4000-8000-000000000001',
        'event_name', 'spot_view',
        'occurred_at', now()::text,
        'spot_id', 'b0000000-0000-4000-8000-000000000001',
        'properties', jsonb_build_object(
          'spot_id', 'b0000000-0000-4000-8000-000000000001'
        )
      ),
      jsonb_build_object(
        'client_event_id', 'f0000000-0000-4000-8000-000000000002',
        'event_name', 'physical_interest_view',
        'occurred_at', now()::text,
        'spot_id', null,
        'properties', '{}'::jsonb
      )
    )
  ),
  '{"status":"accepted","accepted":0,"duplicates":2}'::jsonb,
  'client event IDs deduplicate across retries without partial duplicates'
);

select is(
  api_private.ingest_client_events(
    'a0000000-0000-4000-8000-00000000000a',
    false,
    jsonb_build_array(
      jsonb_build_object(
        'client_event_id', 'f0000000-0000-4000-8000-000000000003',
        'event_name', 'physical_interest_view',
        'occurred_at', now()::text,
        'spot_id', null,
        'properties', '{}'::jsonb
      )
    )
  ),
  '{"status":"gate_closed"}'::jsonb,
  'event ingestion enforces the closed participant gate'
);

select is(
  api_private.ingest_client_events(
    'a0000000-0000-4000-8000-000000000003',
    false,
    jsonb_build_array(
      jsonb_build_object(
        'client_event_id', 'f0000000-0000-4000-8000-000000000004',
        'event_name', 'acquire_success',
        'occurred_at', now()::text,
        'spot_id', 'b0000000-0000-4000-8000-000000000001',
        'properties', jsonb_build_object(
          'spot_id', 'b0000000-0000-4000-8000-000000000001'
        )
      )
    )
  ),
  '{"status":"invalid"}'::jsonb,
  'server-generated event names are rejected from client ingestion'
);

select is(
  api_private.ingest_client_events(
    'a0000000-0000-4000-8000-000000000003',
    false,
    jsonb_build_array(
      jsonb_build_object(
        'client_event_id', 'f0000000-0000-4000-8000-000000000005',
        'event_name', 'spot_view',
        'occurred_at', now()::text,
        'spot_id', 'b0000000-0000-4000-8000-000000000001',
        'properties', jsonb_build_object(
          'spot_id', 'b0000000-0000-4000-8000-000000000001',
          'extra', 'not-allowed'
        )
      )
    )
  ),
  '{"status":"invalid"}'::jsonb,
  'event-specific props reject every non-allowlisted key'
);

select is(
  api_private.ingest_client_events(
    'a0000000-0000-4000-8000-000000000003',
    false,
    jsonb_build_array(
      jsonb_build_object(
        'client_event_id', 'f0000000-0000-4000-8000-000000000006',
        'event_name', 'spot_view',
        'occurred_at', now()::text,
        'spot_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'properties', jsonb_build_object(
          'spot_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        )
      )
    )
  ),
  '{"status":"invalid"}'::jsonb,
  'events cannot reference a nonexistent spot'
);

select is(
  api_private.ingest_client_events(
    'a0000000-0000-4000-8000-000000000003',
    false,
    jsonb_build_array(
      jsonb_build_object(
        'client_event_id', 'f0000000-0000-4000-8000-000000000007',
        'event_name', 'physical_interest_view',
        'occurred_at', (now() - interval '24 hours 1 second')::text,
        'spot_id', null,
        'properties', '{}'::jsonb
      )
    )
  ),
  '{"status":"invalid"}'::jsonb,
  'client events older than 24 hours are rejected'
);

select is(
  (
    select count(*)::bigint
    from analytics.events as event_row
    where event_row.user_id = (
      select user_id
      from test_user_ids
      where fixture_name = 'participant'
    )
      and event_row.client_event_id in (
        'f0000000-0000-4000-8000-000000000001',
        'f0000000-0000-4000-8000-000000000002'
      )
      and event_row.source = 'client'
  ),
  2::bigint,
  'accepted event rows are forced to the client source and current user'
);

-- Physical request idempotency ------------------------------------------

select is(
  api_private.create_physical_request(
    'a0000000-0000-4000-8000-000000000003',
    false,
    'request'
  ),
  '{"status":"created"}'::jsonb,
  'qualified participant creates one physical request signal'
);

select is(
  api_private.create_physical_request(
    'a0000000-0000-4000-8000-000000000003',
    false,
    'request'
  ),
  '{"status":"duplicate"}'::jsonb,
  'duplicate physical request is idempotent'
);

select is(
  (
    select count(*)::bigint
    from analytics.events as event_row
    where event_row.user_id = (
      select user_id
      from test_user_ids
      where fixture_name = 'participant'
    )
      and event_row.event_name = 'physical_interest'
      and event_row.source = 'server'
  ),
  1::bigint,
  'physical_interest server fact is emitted only for the first insert'
);

select is(
  api_private.create_physical_request(
    'a0000000-0000-4000-8000-00000000000a',
    false,
    'request'
  ),
  '{"status":"gate_closed"}'::jsonb,
  'physical request enforces the closed participant gate'
);

select is(
  api_private.create_physical_request(
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    true,
    'request'
  ),
  '{"status":"unauthorized"}'::jsonb,
  'physical request requires a current active service binding'
);

select * from finish();
rollback;
