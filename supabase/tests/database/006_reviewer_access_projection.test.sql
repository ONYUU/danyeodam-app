begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

-- Schema and ACL boundary -------------------------------------------------

select has_table(
  'private',
  'reviewer_accounts',
  'reviewer membership uses a private table'
);

select ok(
  (
    select relation_row.relrowsecurity and relation_row.relforcerowsecurity
    from pg_class as relation_row
    join pg_namespace as schema_row
      on schema_row.oid = relation_row.relnamespace
    where schema_row.nspname = 'private'
      and relation_row.relname = 'reviewer_accounts'
  ),
  'reviewer membership enables and forces RLS'
);

select is(
  (
    select count(*)::bigint
    from information_schema.role_table_grants as grant_row
    where grant_row.table_schema = 'private'
      and grant_row.table_name = 'reviewer_accounts'
      and grant_row.grantee in ('anon', 'authenticated', 'service_role')
  ),
  0::bigint,
  'Data API roles have no direct reviewer table privileges'
);

select ok(
  (
    select
      function_row.prosecdef
      and function_row.provolatile = 's'
      and coalesce(function_row.proconfig, array[]::text[])
        @> array['search_path=""']::text[]
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname = 'get_access_projection'
  ),
  'access projection is a stable SECURITY DEFINER function with empty search_path'
);

select ok(
  has_function_privilege(
    'service_role',
    'api_private.get_access_projection(uuid)',
    'EXECUTE'
  ),
  'service_role can execute the access projection'
);

select is(
  (
    select count(*)::bigint
    from unnest(array['anon', 'authenticated']) as browser_role(role_name)
    where has_function_privilege(
      browser_role.role_name,
      'api_private.get_access_projection(uuid)',
      'EXECUTE'
    )
  ),
  0::bigint,
  'browser roles cannot execute the access projection directly'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    cross join lateral aclexplode(
      coalesce(function_row.proacl, acldefault('f', function_row.proowner))
    ) as acl_row
    where schema_row.nspname = 'api_private'
      and function_row.proname = 'get_access_projection'
      and acl_row.grantee = 0
      and acl_row.privilege_type = 'EXECUTE'
  ),
  0::bigint,
  'PUBLIC execute is explicitly absent from the access projection'
);

select ok(
  (
    select
      pg_get_functiondef(function_row.oid) like '%private.reviewer_accounts%'
      and pg_get_functiondef(function_row.oid) like '%private.participant_access%'
      and pg_get_functiondef(function_row.oid) like '%private.user_identities%'
      and pg_get_functiondef(function_row.oid) not like '%raw_user_meta_data%'
      and pg_get_functiondef(function_row.oid) not like '%raw_app_meta_data%'
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname = 'get_access_projection'
  ),
  'reviewer authorization reads fresh database membership, never JWT metadata'
);

select ok(
  (
    select pg_get_constraintdef(constraint_row.oid)
      like '%store_reviewer%'
    from pg_constraint as constraint_row
    where constraint_row.conrelid = 'private.participant_access'::regclass
      and constraint_row.conname = 'participant_access_access_kind_check'
  ),
  'participant access supports the store_reviewer membership kind'
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
  (
    'd0000000-0000-4000-8000-000000000001',
    now(),
    now(),
    false,
    '{}'::jsonb
  ),
  ('d0000000-0000-4000-8000-000000000002', now(), now(), false, '{}'::jsonb),
  ('d0000000-0000-4000-8000-000000000003', now(), now(), false, '{"role":"store_reviewer"}'::jsonb),
  ('d0000000-0000-4000-8000-000000000004', now(), now(), false, '{}'::jsonb),
  ('d0000000-0000-4000-8000-000000000005', now(), now(), false, '{}'::jsonb),
  ('d0000000-0000-4000-8000-000000000006', now(), now(), false, '{}'::jsonb);

update auth.users
set email = 'reviewer-projection@example.test',
    encrypted_password = 'reviewer-projection-hash',
    email_confirmed_at = now(),
    role = 'authenticated',
    aud = 'authenticated',
    is_super_admin = false,
    banned_until = null,
    raw_app_meta_data = '{"provider":"email","providers":["email"]}'::jsonb
where id = 'd0000000-0000-4000-8000-000000000001';

insert into auth.identities (
  id,
  user_id,
  provider_id,
  identity_data,
  provider,
  last_sign_in_at,
  created_at,
  updated_at
)
values (
  'd0100000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000001',
  '{"sub":"d0000000-0000-4000-8000-000000000001","email":"reviewer-projection@example.test","email_verified":true}'::jsonb,
  'email',
  now(),
  now(),
  now()
);

create temp table test_reviewer_users (
  fixture_name text primary key,
  auth_user_id uuid not null,
  user_id uuid not null
) on commit drop;

insert into test_reviewer_users (fixture_name, auth_user_id, user_id)
select fixture.fixture_name, fixture.auth_user_id, identity_row.user_id
from (
  values
    ('reviewer', 'd0000000-0000-4000-8000-000000000001'::uuid),
    ('standard', 'd0000000-0000-4000-8000-000000000002'::uuid),
    ('no_access', 'd0000000-0000-4000-8000-000000000003'::uuid),
    ('expired', 'd0000000-0000-4000-8000-000000000004'::uuid),
    ('revoked_identity', 'd0000000-0000-4000-8000-000000000005'::uuid),
    ('inconsistent', 'd0000000-0000-4000-8000-000000000006'::uuid)
) as fixture(fixture_name, auth_user_id)
join private.user_identities as identity_row
  on identity_row.auth_user_id = fixture.auth_user_id
 and identity_row.revoked_at is null;

insert into private.participant_access (
  user_id,
  access_kind,
  granted_at,
  expires_at
)
select user_id, 'store_reviewer', now(), null::timestamptz
from test_reviewer_users
where fixture_name = 'reviewer'
union all
select user_id, 'internal_tester', now(), null::timestamptz
from test_reviewer_users
where fixture_name = 'standard'
union all
select
  user_id,
  'public_beta',
  now() - interval '1 day',
  now() - interval '1 minute'
from test_reviewer_users
where fixture_name = 'expired'
union all
select user_id, 'store_reviewer', now(), null::timestamptz
from test_reviewer_users
where fixture_name = 'inconsistent';

insert into private.reviewer_accounts (
  user_id,
  store_platform,
  fixture_version
)
select user_id, 'app_store', 'store-2026.08.1'
from test_reviewer_users
where fixture_name = 'reviewer';

insert into private.reviewer_accounts (
  user_id,
  store_platform,
  fixture_version,
  revoked_at
)
select user_id, 'play_store', 'store-revoked', now()
from test_reviewer_users
where fixture_name = 'inconsistent';

-- Projection behavior ----------------------------------------------------

select is(
  api_private.get_access_projection(null),
  '{"status":"unauthorized"}'::jsonb,
  'a missing Auth user id is unauthorized'
);

select is(
  api_private.get_access_projection(
    'd0000000-0000-4000-8000-000000000001'::uuid
  ),
  '{
    "status":"ready",
    "participant":true,
    "access_type":"store_reviewer",
    "field_acquisition_requires_location":true,
    "fixture_version":"store-2026.08.1"
  }'::jsonb,
  'both active DB memberships produce the store reviewer projection'
);

select is(
  api_private.get_access_projection(
    'd0000000-0000-4000-8000-000000000002'::uuid
  ),
  '{
    "status":"ready",
    "participant":true,
    "access_type":"standard",
    "field_acquisition_requires_location":true,
    "fixture_version":null
  }'::jsonb,
  'ordinary participant membership produces a standard projection'
);

select is(
  api_private.get_access_projection(
    'd0000000-0000-4000-8000-000000000003'::uuid
  ),
  '{
    "status":"ready",
    "participant":false,
    "access_type":"standard",
    "field_acquisition_requires_location":true,
    "fixture_version":null
  }'::jsonb,
  'an active identity without participant membership remains standard'
);

select is(
  api_private.get_access_projection(
    'd0000000-0000-4000-8000-000000000004'::uuid
  ),
  '{
    "status":"ready",
    "participant":false,
    "access_type":"standard",
    "field_acquisition_requires_location":true,
    "fixture_version":null
  }'::jsonb,
  'expired participant membership is not active'
);

select is(
  api_private.get_access_projection(
    'd0000000-0000-4000-8000-000000000006'::uuid
  ),
  '{
    "status":"ready",
    "participant":true,
    "access_type":"standard",
    "field_acquisition_requires_location":true,
    "fixture_version":null
  }'::jsonb,
  'revoked reviewer membership never produces store_reviewer access'
);

update private.user_identities
set revoked_at = now()
where auth_user_id = 'd0000000-0000-4000-8000-000000000005'::uuid
  and revoked_at is null;

select is(
  api_private.get_access_projection(
    'd0000000-0000-4000-8000-000000000005'::uuid
  ),
  '{"status":"unauthorized"}'::jsonb,
  'a revoked service binding is unauthorized even with a valid Auth user'
);

select throws_ok(
  $sql$
    insert into private.reviewer_accounts (
      user_id,
      store_platform,
      fixture_version
    )
    select user_id, 'other_store', 'store-2026.08.1'
    from test_reviewer_users
    where fixture_name = 'no_access'
  $sql$,
  '23514',
  null,
  'reviewer rows reject unknown stores'
);

select throws_ok(
  $sql$
    insert into private.reviewer_accounts (
      user_id,
      store_platform,
      fixture_version
    )
    select user_id, 'play_store', '../unsafe'
    from test_reviewer_users
    where fixture_name = 'no_access'
  $sql$,
  '23514',
  null,
  'reviewer rows reject unsafe fixture versions'
);

-- Generic invite and recovery flows must preserve stronger access ----------

insert into private.participant_invite_codes (code_hash)
values
  (decode(repeat('d', 64), 'hex')),
  (decode(repeat('e', 64), 'hex'));

update private.participant_access
set access_kind = 'public_beta'
where user_id = (
  select user_id from test_reviewer_users where fixture_name = 'standard'
);

select is(
  api_private.redeem_participant_invite(
    'd0000000-0000-4000-8000-000000000002'::uuid,
    repeat('d', 64)
  ),
  '{"status":"redeemed"}'::jsonb,
  'a public-beta participant can redeem a generic invite'
);

select is(
  (
    select access_kind
    from private.participant_access
    where user_id = (
      select user_id from test_reviewer_users where fixture_name = 'standard'
    )
  ),
  'public_beta',
  'generic invite redemption cannot lower an active public-beta entitlement'
);

select is(
  api_private.redeem_participant_invite(
    'd0000000-0000-4000-8000-000000000001'::uuid,
    repeat('e', 64)
  ),
  '{"status":"not_found"}'::jsonb,
  'an active reviewer cannot redeem a generic invite'
);

select is(
  (
    select access_kind
    from private.participant_access
    where user_id = (
      select user_id from test_reviewer_users where fixture_name = 'reviewer'
    )
  ),
  'store_reviewer',
  'blocked generic invite redemption leaves active reviewer access unchanged'
);

insert into auth.users (
  id,
  created_at,
  updated_at,
  is_anonymous,
  raw_user_meta_data
)
values (
  'd0000000-0000-4000-8000-000000000007',
  now(),
  now(),
  true,
  '{}'::jsonb
);

insert into private.participant_access (
  user_id,
  access_kind,
  granted_at
)
select identity_row.user_id, 'internal_tester', now()
from private.user_identities as identity_row
where identity_row.auth_user_id = 'd0000000-0000-4000-8000-000000000007'::uuid
  and identity_row.revoked_at is null;

select is(
  api_private.issue_recovery_code(
    'd0000000-0000-4000-8000-000000000001'::uuid,
    repeat('f', 64)
  ),
  '{"status":"reviewer_forbidden"}'::jsonb,
  'a reviewer logical user cannot issue a generic recovery code'
);

select throws_ok(
  $sql$
    insert into private.recovery_codes (
      user_id,
      code_hash,
      expires_at
    )
    select
      user_id,
      decode(repeat('f', 64), 'hex'),
      now() + interval '1 hour'
    from test_reviewer_users
    where fixture_name = 'reviewer'
  $sql$,
  '23514',
  null,
  'the database cannot activate a recovery code for reviewer history'
);

select is(
  api_private.claim_recovery_code(
    'd0000000-0000-4000-8000-000000000007'::uuid,
    repeat('f', 64)
  ),
  '{"status":"not_found"}'::jsonb,
  'a reviewer-looking digest is indistinguishable from an unknown code'
);

select is(
  api_private.get_access_projection(
    'd0000000-0000-4000-8000-000000000007'::uuid
  ),
  '{
    "status":"ready",
    "participant":true,
    "access_type":"standard",
    "field_acquisition_requires_location":true,
    "fixture_version":null
  }'::jsonb,
  'the failed claim leaves the anonymous participant on its own binding'
);

select is(
  api_private.get_access_projection(
    'd0000000-0000-4000-8000-000000000001'::uuid
  ),
  '{
    "status":"ready",
    "participant":true,
    "access_type":"store_reviewer",
    "field_acquisition_requires_location":true,
    "fixture_version":"store-2026.08.1"
  }'::jsonb,
  'the original reviewer binding remains the only reviewer session'
);

select * from finish();
rollback;
