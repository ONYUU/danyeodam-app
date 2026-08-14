begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'private'
      and function_row.proname in (
        'reviewer_auth_has_no_auxiliary_credentials',
        'reviewer_auth_credential_is_valid',
        'assert_reviewer_auth_credential_cutover',
        'guard_reviewer_auth_credential_mutation',
        'guard_reviewer_auth_identity_mutation',
        'guard_reviewer_auth_auxiliary_credential_mutation'
      )
      and function_row.prosecdef
      and coalesce(function_row.proconfig, array[]::text[])
        @> array['search_path=""']::text[]
  ),
  6::bigint,
  'all reviewer Auth invariant functions are SECURITY DEFINER with empty search_path'
);

select is(
  (
    select count(*)::bigint
    from pg_trigger as trigger_row
    where (
        trigger_row.tgrelid = 'auth.users'::regclass
        and trigger_row.tgname = 'auth_users_guard_reviewer_credentials'
      ) or (
        trigger_row.tgrelid = 'auth.identities'::regclass
        and trigger_row.tgname = 'auth_identities_guard_reviewer_credentials'
      )
      and not trigger_row.tgisinternal
  ),
  2::bigint,
  'auth.users and auth.identities both have reviewer mutation guards'
);

select ok(
  exists (
    select 1
    from pg_trigger as trigger_row
    where trigger_row.tgrelid = 'auth.mfa_factors'::regclass
      and trigger_row.tgname = 'auth_mfa_factors_guard_reviewer_credentials'
      and not trigger_row.tgisinternal
  ),
  'auth.mfa_factors has the reviewer auxiliary credential guard'
);

select ok(
  to_regclass('auth.webauthn_credentials') is null
  or exists (
    select 1
    from pg_trigger as trigger_row
    where trigger_row.tgrelid = to_regclass('auth.webauthn_credentials')
      and trigger_row.tgname = 'auth_webauthn_credentials_guard_reviewer'
      and not trigger_row.tgisinternal
  ),
  'installed standalone passkey credentials have the reviewer guard'
);

select ok(
  to_regclass('auth.webauthn_challenges') is null
  or exists (
    select 1
    from pg_trigger as trigger_row
    where trigger_row.tgrelid = to_regclass('auth.webauthn_challenges')
      and trigger_row.tgname = 'auth_webauthn_challenges_guard_reviewer'
      and not trigger_row.tgisinternal
  ),
  'installed standalone passkey challenges have the reviewer guard'
);

select is(
  (
    select count(*)::bigint
    from unnest(array['public', 'anon', 'authenticated', 'service_role'])
      as role_row(role_name)
    cross join unnest(array[
      'private.reviewer_auth_has_no_auxiliary_credentials(uuid)',
      'private.reviewer_auth_credential_is_valid(uuid)',
      'private.assert_reviewer_auth_credential_cutover()',
      'private.guard_reviewer_auth_credential_mutation()',
      'private.guard_reviewer_auth_identity_mutation()',
      'private.guard_reviewer_auth_auxiliary_credential_mutation()'
    ]) as function_row(signature)
    where has_function_privilege(
      role_row.role_name,
      function_row.signature,
      'EXECUTE'
    )
  ),
  0::bigint,
  'browser, Data API, service, and PUBLIC roles cannot invoke Auth guard internals'
);

select is(
  (
    select count(*)::bigint
    from information_schema.role_usage_grants as grant_row
    where grant_row.object_schema = 'private'
      and grant_row.object_name = 'reviewer_auth_guard_denials'
      and grant_row.grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')
  ),
  0::bigint,
  'the non-identifying denial counter is not exposed to application roles'
);

insert into auth.users (
  id,
  created_at,
  updated_at,
  email,
  encrypted_password,
  email_confirmed_at,
  is_anonymous,
  is_sso_user,
  role,
  aud,
  is_super_admin,
  banned_until,
  raw_app_meta_data,
  raw_user_meta_data
)
values
  (
    'f1000000-0000-4000-8000-000000000001', now(), now(),
    'reviewer-current@example.test', 'reviewer-current-hash', now(), false, false,
    'authenticated', 'authenticated', false, null,
    '{"provider":"email","providers":["email"]}', '{}'
  ),
  (
    'f1000000-0000-4000-8000-000000000002', now(), now(),
    'standard@example.test', 'standard-hash', now(), false, false,
    'authenticated', 'authenticated', false, null,
    '{"provider":"email","providers":["email"]}', '{}'
  ),
  (
    'f1000000-0000-4000-8000-000000000003', now(), now(),
    null, '', null, true, false,
    'authenticated', 'authenticated', false, null, '{}', '{}'
  ),
  (
    'f1000000-0000-4000-8000-000000000004', now(), now(),
    'missing-binding@example.test', 'missing-binding-hash', now(), false, false,
    'authenticated', 'authenticated', false, null,
    '{"provider":"email","providers":["email"]}', '{}'
  ),
  (
    'f1000000-0000-4000-8000-000000000005', now(), now(),
    'deleted@example.test', 'deleted-hash', now(), false, false,
    'authenticated', 'authenticated', false, null,
    '{"provider":"email","providers":["email"]}', '{}'
  ),
  (
    'f1000000-0000-4000-8000-000000000006', now(), now(),
    'reviewer-historical@example.test', 'reviewer-historical-hash', now(), false, false,
    'authenticated', 'authenticated', false, null,
    '{"provider":"email","providers":["email"]}', '{}'
  ),
  (
    'f1000000-0000-4000-8000-000000000007', now(), now(),
    'magic-link-only@example.test', '', now(), false, false,
    'authenticated', 'authenticated', false, null,
    '{"provider":"email","providers":["email"]}', '{}'
  ),
  (
    'f1000000-0000-4000-8000-000000000009', now(), now(),
    'unconfirmed-email@example.test', 'unconfirmed-email-hash', null, false, false,
    'authenticated', 'authenticated', false, null,
    '{"provider":"email","providers":["email"]}', '{}'
  ),
  (
    'f1000000-0000-4000-8000-000000000010', now(), now(),
    'multiple-identities@example.test', 'multiple-identities-hash', now(), false, false,
    'authenticated', 'authenticated', false, null,
    '{"provider":"email","providers":["email","github"]}', '{}'
  ),
  (
    'f1000000-0000-4000-8000-000000000011', now(), now(),
    'sso@example.test', 'sso-hash', now(), false, true,
    'authenticated', 'authenticated', false, null,
    '{"provider":"email","providers":["email"]}', '{}'
  ),
  (
    'f1000000-0000-4000-8000-000000000012', now(), now(),
    'pending@example.test', 'pending-hash', now(), false, false,
    'authenticated', 'authenticated', false, null,
    '{"provider":"email","providers":["email"]}', '{}'
  );

insert into auth.users (
  id,
  created_at,
  updated_at,
  phone,
  phone_confirmed_at,
  encrypted_password,
  is_anonymous,
  is_sso_user,
  raw_app_meta_data,
  raw_user_meta_data
)
values (
  'f1000000-0000-4000-8000-000000000008', now(), now(),
  '+821011112222', now(), '', false, false,
  '{"provider":"phone","providers":["phone"]}', '{}'
);

update auth.users
set recovery_token = 'pending-recovery-token',
    recovery_sent_at = now(),
    reauthentication_token = 'pending-reauth-token',
    reauthentication_sent_at = now()
where id = 'f1000000-0000-4000-8000-000000000012';

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
select
  identity_fixture.identity_id,
  identity_fixture.auth_user_id,
  identity_fixture.provider_id,
  identity_fixture.identity_data,
  identity_fixture.provider,
  now(),
  now(),
  now()
from (
  values
    (
      'f1100000-0000-4000-8000-000000000001'::uuid,
      'f1000000-0000-4000-8000-000000000001'::uuid,
      'f1000000-0000-4000-8000-000000000001',
      '{"sub":"f1000000-0000-4000-8000-000000000001","email":"reviewer-current@example.test","email_verified":true}'::jsonb,
      'email'
    ),
    (
      'f1100000-0000-4000-8000-000000000002'::uuid,
      'f1000000-0000-4000-8000-000000000002'::uuid,
      'f1000000-0000-4000-8000-000000000002',
      '{"sub":"f1000000-0000-4000-8000-000000000002","email":"standard@example.test","email_verified":true}'::jsonb,
      'email'
    ),
    (
      'f1100000-0000-4000-8000-000000000004'::uuid,
      'f1000000-0000-4000-8000-000000000004'::uuid,
      'f1000000-0000-4000-8000-000000000004',
      '{"sub":"f1000000-0000-4000-8000-000000000004","email":"missing-binding@example.test","email_verified":true}'::jsonb,
      'email'
    ),
    (
      'f1100000-0000-4000-8000-000000000005'::uuid,
      'f1000000-0000-4000-8000-000000000005'::uuid,
      'f1000000-0000-4000-8000-000000000005',
      '{"sub":"f1000000-0000-4000-8000-000000000005","email":"deleted@example.test","email_verified":true}'::jsonb,
      'email'
    ),
    (
      'f1100000-0000-4000-8000-000000000006'::uuid,
      'f1000000-0000-4000-8000-000000000006'::uuid,
      'f1000000-0000-4000-8000-000000000006',
      '{"sub":"f1000000-0000-4000-8000-000000000006","email":"reviewer-historical@example.test","email_verified":true}'::jsonb,
      'email'
    ),
    (
      'f1100000-0000-4000-8000-000000000007'::uuid,
      'f1000000-0000-4000-8000-000000000007'::uuid,
      'f1000000-0000-4000-8000-000000000007',
      '{"sub":"f1000000-0000-4000-8000-000000000007","email":"magic-link-only@example.test","email_verified":true}'::jsonb,
      'email'
    ),
    (
      'f1100000-0000-4000-8000-000000000008'::uuid,
      'f1000000-0000-4000-8000-000000000008'::uuid,
      '+821011112222',
      '{"sub":"f1000000-0000-4000-8000-000000000008","phone":"+821011112222","phone_verified":true}'::jsonb,
      'phone'
    ),
    (
      'f1100000-0000-4000-8000-000000000009'::uuid,
      'f1000000-0000-4000-8000-000000000009'::uuid,
      'f1000000-0000-4000-8000-000000000009',
      '{"sub":"f1000000-0000-4000-8000-000000000009","email":"unconfirmed-email@example.test","email_verified":false}'::jsonb,
      'email'
    ),
    (
      'f1100000-0000-4000-8000-000000000010'::uuid,
      'f1000000-0000-4000-8000-000000000010'::uuid,
      'f1000000-0000-4000-8000-000000000010',
      '{"sub":"f1000000-0000-4000-8000-000000000010","email":"multiple-identities@example.test","email_verified":true}'::jsonb,
      'email'
    ),
    (
      'f1100000-0000-4000-8000-000000000011'::uuid,
      'f1000000-0000-4000-8000-000000000011'::uuid,
      'f1000000-0000-4000-8000-000000000011',
      '{"sub":"f1000000-0000-4000-8000-000000000011","email":"sso@example.test","email_verified":true}'::jsonb,
      'email'
    ),
    (
      'f1100000-0000-4000-8000-000000000012'::uuid,
      'f1000000-0000-4000-8000-000000000012'::uuid,
      'f1000000-0000-4000-8000-000000000012',
      '{"sub":"f1000000-0000-4000-8000-000000000012","email":"pending@example.test","email_verified":true}'::jsonb,
      'email'
    ),
    (
      'f1200000-0000-4000-8000-000000000010'::uuid,
      'f1000000-0000-4000-8000-000000000010'::uuid,
      'github-multiple-identity',
      '{"sub":"github-multiple-identity","email":"multiple-identities@example.test","email_verified":true}'::jsonb,
      'github'
    )
) as identity_fixture(
  identity_id,
  auth_user_id,
  provider_id,
  identity_data,
  provider
);

create temp table test_reviewer_auth_users (
  fixture_name text primary key,
  auth_user_id uuid not null,
  user_id uuid not null
) on commit drop;

insert into test_reviewer_auth_users (fixture_name, auth_user_id, user_id)
select fixture.fixture_name, fixture.auth_user_id, service_identity.user_id
from (
  values
    ('reviewer', 'f1000000-0000-4000-8000-000000000001'::uuid),
    ('standard', 'f1000000-0000-4000-8000-000000000002'::uuid),
    ('anonymous', 'f1000000-0000-4000-8000-000000000003'::uuid),
    ('missing_binding', 'f1000000-0000-4000-8000-000000000004'::uuid),
    ('deleted', 'f1000000-0000-4000-8000-000000000005'::uuid),
    ('historical', 'f1000000-0000-4000-8000-000000000006'::uuid),
    ('magic_link', 'f1000000-0000-4000-8000-000000000007'::uuid),
    ('phone_only', 'f1000000-0000-4000-8000-000000000008'::uuid),
    ('unconfirmed_email', 'f1000000-0000-4000-8000-000000000009'::uuid),
    ('multiple_identities', 'f1000000-0000-4000-8000-000000000010'::uuid),
    ('sso', 'f1000000-0000-4000-8000-000000000011'::uuid),
    ('pending', 'f1000000-0000-4000-8000-000000000012'::uuid)
) as fixture(fixture_name, auth_user_id)
join private.user_identities as service_identity
  on service_identity.auth_user_id = fixture.auth_user_id
 and service_identity.revoked_at is null;

select ok(
  private.reviewer_auth_credential_is_valid((
    select user_id from test_reviewer_auth_users where fixture_name = 'reviewer'
  )),
  'the reusable confirmed email/password fixture satisfies the exact invariant'
);

insert into private.reviewer_accounts (user_id, store_platform, fixture_version)
select user_id, 'app_store', 'auth-lockdown-current-v1'
from test_reviewer_auth_users
where fixture_name = 'reviewer';

insert into private.reviewer_accounts (
  user_id,
  store_platform,
  fixture_version,
  revoked_at
)
select user_id, 'play_store', 'auth-lockdown-history-v1', now()
from test_reviewer_auth_users
where fixture_name = 'historical';

delete from private.reviewer_accounts
where user_id = (
  select user_id from test_reviewer_auth_users where fixture_name = 'historical'
);

select throws_ok(
  $sql$
    update private.reviewer_accounts
    set user_id = (
      select user_id from test_reviewer_auth_users where fixture_name = 'standard'
    )
    where user_id = (
      select user_id from test_reviewer_auth_users where fixture_name = 'reviewer'
    )
  $sql$,
  '23514',
  'reviewer logical user cannot be changed',
  'reviewer_accounts.user_id is immutable'
);

select throws_ok(
  $sql$
    insert into private.reviewer_accounts (user_id, store_platform, fixture_version)
    select user_id, 'play_store', 'historical-reissue-must-fail'
    from test_reviewer_auth_users where fixture_name = 'historical'
  $sql$,
  '23514',
  null,
  'deleted reviewer membership cannot be reissued for the same logical user'
);

select throws_ok(
  $sql$
    insert into private.reviewer_accounts (user_id, store_platform, fixture_version)
    select user_id, 'app_store', 'anonymous-must-fail'
    from test_reviewer_auth_users where fixture_name = 'anonymous'
  $sql$,
  '23514',
  null,
  'an anonymous Auth credential cannot be designated as reviewer'
);

select throws_ok(
  $sql$
    insert into private.reviewer_accounts (user_id, store_platform, fixture_version)
    select user_id, 'app_store', 'magic-link-must-fail'
    from test_reviewer_auth_users where fixture_name = 'magic_link'
  $sql$,
  '23514',
  null,
  'a magic-link-only Auth user cannot be designated as reusable reviewer'
);

select throws_ok(
  $sql$
    insert into private.reviewer_accounts (user_id, store_platform, fixture_version)
    select user_id, 'play_store', 'phone-only-must-fail'
    from test_reviewer_auth_users where fixture_name = 'phone_only'
  $sql$,
  '23514',
  null,
  'a phone-only Auth user cannot be designated as reusable reviewer'
);

select throws_ok(
  $sql$
    insert into private.reviewer_accounts (user_id, store_platform, fixture_version)
    select user_id, 'app_store', 'unconfirmed-email-must-fail'
    from test_reviewer_auth_users where fixture_name = 'unconfirmed_email'
  $sql$,
  '23514',
  null,
  'an unconfirmed email identity cannot be designated as reviewer'
);

select throws_ok(
  $sql$
    insert into private.reviewer_accounts (user_id, store_platform, fixture_version)
    select user_id, 'play_store', 'multiple-identities-must-fail'
    from test_reviewer_auth_users where fixture_name = 'multiple_identities'
  $sql$,
  '23514',
  null,
  'an Auth user with a second provider identity cannot be designated'
);

select throws_ok(
  $sql$
    insert into private.reviewer_accounts (user_id, store_platform, fixture_version)
    select user_id, 'app_store', 'sso-must-fail'
    from test_reviewer_auth_users where fixture_name = 'sso'
  $sql$,
  '23514',
  null,
  'an SSO Auth user cannot be designated as reviewer'
);

select throws_ok(
  $sql$
    insert into private.reviewer_accounts (user_id, store_platform, fixture_version)
    select user_id, 'play_store', 'pending-state-must-fail'
    from test_reviewer_auth_users where fixture_name = 'pending'
  $sql$,
  '23514',
  null,
  'pending recovery or reauthentication state prevents designation'
);

update private.user_identities
set revoked_at = clock_timestamp()
where auth_user_id = 'f1000000-0000-4000-8000-000000000004'
  and revoked_at is null;

select throws_ok(
  $sql$
    insert into private.reviewer_accounts (user_id, store_platform, fixture_version)
    select user_id, 'play_store', 'missing-binding-must-fail'
    from test_reviewer_auth_users where fixture_name = 'missing_binding'
  $sql$,
  '23514',
  null,
  'a logical user without an active service identity cannot be designated'
);

update auth.users
set deleted_at = clock_timestamp()
where id = 'f1000000-0000-4000-8000-000000000005';

select throws_ok(
  $sql$
    insert into private.reviewer_accounts (user_id, store_platform, fixture_version)
    select user_id, 'app_store', 'deleted-auth-must-fail'
    from test_reviewer_auth_users where fixture_name = 'deleted'
  $sql$,
  '23514',
  null,
  'a deleted Auth credential cannot be designated as reviewer'
);

select lives_ok(
  'select private.assert_reviewer_auth_credential_cutover()',
  'a valid active reviewer passes cutover validation'
);

alter table private.reviewer_accounts
  disable trigger reviewer_accounts_lock_down_recovery;

insert into private.reviewer_accounts (user_id, store_platform, fixture_version)
select user_id, 'play_store', 'invalid-cutover-fixture'
from test_reviewer_auth_users
where fixture_name = 'anonymous';

alter table private.reviewer_accounts
  enable trigger reviewer_accounts_lock_down_recovery;

select throws_ok(
  'select private.assert_reviewer_auth_credential_cutover()',
  '23514',
  'active reviewer credential cutover validation failed',
  'cutover rejects invalid legacy rows without an identifier-bearing message'
);

delete from private.reviewer_accounts
where user_id = (
  select user_id from test_reviewer_auth_users where fixture_name = 'anonymous'
);

select lives_ok(
  'select private.assert_reviewer_auth_credential_cutover()',
  'cutover succeeds after invalid legacy membership is removed'
);

insert into auth.mfa_factors (
  id,
  user_id,
  friendly_name,
  factor_type,
  status,
  created_at,
  updated_at,
  secret
)
values (
  'f1400000-0000-4000-8000-000000000001',
  'f1000000-0000-4000-8000-000000000002',
  'invalid reviewer factor',
  'totp',
  'unverified',
  now(),
  now(),
  'invalid-reviewer-factor-secret'
);

alter table private.reviewer_accounts
  disable trigger reviewer_accounts_lock_down_recovery;

insert into private.reviewer_accounts (user_id, store_platform, fixture_version)
select user_id, 'play_store', 'invalid-factor-cutover-fixture'
from test_reviewer_auth_users
where fixture_name = 'standard';

alter table private.reviewer_accounts
  enable trigger reviewer_accounts_lock_down_recovery;

select throws_ok(
  'select private.assert_reviewer_auth_credential_cutover()',
  '23514',
  'active reviewer credential cutover validation failed',
  'cutover rejects an active reviewer with an auxiliary MFA factor'
);

delete from private.reviewer_accounts
where user_id = (
  select user_id from test_reviewer_auth_users where fixture_name = 'standard'
);

delete from auth.mfa_factors
where id = 'f1400000-0000-4000-8000-000000000001';

select lives_ok(
  'select private.assert_reviewer_auth_credential_cutover()',
  'cutover succeeds after the invalid auxiliary factor is removed'
);

select throws_ok(
  $sql$
    update auth.users
    set encrypted_password = 'rewrap-shaped-reviewer-hash'
    where id = 'f1000000-0000-4000-8000-000000000001'
  $sql$,
  '23514',
  'credential mutation is forbidden',
  'encrypted-password-only rewrap-shaped changes deliberately fail closed'
);

select throws_ok(
  $sql$
    update auth.users
    set raw_app_meta_data = '{"provider":"github","providers":["email","github"]}'::jsonb
    where id = 'f1000000-0000-4000-8000-000000000001'
  $sql$,
  '23514',
  'credential mutation is forbidden',
  'reviewer Auth provider metadata changes are blocked'
);

select throws_ok(
  $sql$
    update auth.users
    set email_change = 'mutated-reviewer@example.test',
        email_change_token_new = 'mutated-new-token',
        email_change_token_current = 'mutated-current-token',
        email_change_sent_at = clock_timestamp()
    where id = 'f1000000-0000-4000-8000-000000000001'
  $sql$,
  '23514',
  'credential mutation is forbidden',
  'current reviewer pending email state mutation is blocked'
);

select throws_ok(
  $sql$
    update auth.users
    set email = 'historical-mutated@example.test'
    where id = 'f1000000-0000-4000-8000-000000000006'
  $sql$,
  '23514',
  'credential mutation is forbidden',
  'historical reviewer credential mutation remains blocked after membership deletion'
);

select lives_ok(
  $sql$
    update auth.users
    set last_sign_in_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where id = 'f1000000-0000-4000-8000-000000000001'
  $sql$,
  'reviewer sign-in and refresh volatile fields remain writable'
);

select lives_ok(
  $sql$
    update auth.users
    set raw_user_meta_data = '{"locale":"ko"}'::jsonb
    where id = 'f1000000-0000-4000-8000-000000000002'
  $sql$,
  'ordinary user metadata remains writable'
);

select lives_ok(
  $sql$
    update auth.identities
    set last_sign_in_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where id = 'f1100000-0000-4000-8000-000000000001'
  $sql$,
  'reviewer email identity volatile sign-in fields remain writable'
);

select throws_ok(
  $sql$
    insert into auth.identities (
      id, user_id, provider_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    ) values (
      'f1300000-0000-4000-8000-000000000001',
      'f1000000-0000-4000-8000-000000000001',
      'github-reviewer',
      '{"sub":"github-reviewer"}'::jsonb,
      'github', now(), now(), now()
    )
  $sql$,
  '23514',
  'credential identity mutation is forbidden',
  'automatic-provider identity insertion is blocked for a reviewer'
);

select throws_ok(
  $sql$
    update auth.identities
    set provider_id = 'changed-provider-binding'
    where id = 'f1100000-0000-4000-8000-000000000001'
  $sql$,
  '23514',
  'credential identity mutation is forbidden',
  'reviewer Auth identity binding changes are blocked'
);

select throws_ok(
  $sql$
    delete from auth.identities
    where id = 'f1100000-0000-4000-8000-000000000001'
  $sql$,
  '23514',
  'credential identity mutation is forbidden',
  'reviewer Auth identity deletion is blocked while the Auth user is live'
);

select throws_ok(
  $sql$
    insert into auth.identities (
      id, user_id, provider_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    ) values (
      'f1300000-0000-4000-8000-000000000006',
      'f1000000-0000-4000-8000-000000000006',
      'github-historical-reviewer',
      '{"sub":"github-historical-reviewer"}'::jsonb,
      'github', now(), now(), now()
    )
  $sql$,
  '23514',
  'credential identity mutation is forbidden',
  'historical reviewer Auth identity insertion stays blocked'
);

select throws_ok(
  $sql$
    insert into auth.mfa_factors (
      id, user_id, friendly_name, factor_type, status,
      created_at, updated_at, secret
    ) values (
      'f1400000-0000-4000-8000-000000000006',
      'f1000000-0000-4000-8000-000000000006',
      'historical reviewer factor', 'totp', 'unverified',
      now(), now(), 'historical-reviewer-factor-secret'
    )
  $sql$,
  '23514',
  'auxiliary credential mutation is forbidden',
  'historical reviewer MFA factor insertion stays blocked'
);

select throws_ok(
  $sql$
    insert into auth.mfa_factors (
      id, user_id, friendly_name, factor_type, status,
      created_at, updated_at, secret
    ) values (
      'f1400000-0000-4000-8000-000000000002',
      'f1000000-0000-4000-8000-000000000001',
      'current reviewer factor', 'totp', 'unverified',
      now(), now(), 'current-reviewer-factor-secret'
    )
  $sql$,
  '23514',
  'auxiliary credential mutation is forbidden',
  'current reviewer MFA factor enrollment is blocked'
);

select lives_ok(
  $sql$
    insert into auth.identities (
      id, user_id, provider_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    ) values (
      'f1300000-0000-4000-8000-000000000002',
      'f1000000-0000-4000-8000-000000000002',
      'github-standard',
      '{"sub":"github-standard"}'::jsonb,
      'github', now(), now(), now()
    )
  $sql$,
  'ordinary users may add identity providers'
);

select lives_ok(
  $sql$
    delete from auth.identities
    where id = 'f1300000-0000-4000-8000-000000000002'
  $sql$,
  'ordinary users may remove identity providers'
);

select lives_ok(
  $sql$
    insert into auth.mfa_factors (
      id, user_id, friendly_name, factor_type, status,
      created_at, updated_at, secret
    ) values (
      'f1400000-0000-4000-8000-000000000003',
      'f1000000-0000-4000-8000-000000000002',
      'standard factor', 'totp', 'unverified',
      now(), now(), 'standard-factor-secret'
    )
  $sql$,
  'ordinary users may enroll an MFA factor'
);

select lives_ok(
  $sql$
    delete from auth.mfa_factors
    where id = 'f1400000-0000-4000-8000-000000000003'
  $sql$,
  'ordinary users may remove an MFA factor'
);

select lives_ok(
  $sql$
    update auth.users
    set email = 'standard-mutated@example.test',
        encrypted_password = 'standard-mutated-hash',
        phone = '+821055555555'
    where id = 'f1000000-0000-4000-8000-000000000002'
  $sql$,
  'ordinary user credential mutation remains available'
);

update private.reviewer_accounts
set revoked_at = clock_timestamp()
where user_id = (
  select user_id from test_reviewer_auth_users where fixture_name = 'reviewer'
);

select throws_ok(
  $sql$
    update private.reviewer_accounts
    set revoked_at = null,
        fixture_version = 'auth-lockdown-reactivated-v2'
    where user_id = (
      select user_id from test_reviewer_auth_users where fixture_name = 'reviewer'
    )
  $sql$,
  '23514',
  null,
  'revoked reviewer membership cannot be reactivated in place'
);

select lives_ok(
  $sql$
    update auth.users
    set deleted_at = clock_timestamp(),
        email = 'deleted-reviewer@example.test',
        encrypted_password = '',
        raw_app_meta_data = '{}'::jsonb
    where id = 'f1000000-0000-4000-8000-000000000001';
  $sql$,
  'reviewer Auth soft deletion may redact user credentials'
);

select lives_ok(
  $sql$
    update auth.identities
    set provider_id = 'soft-deleted-reviewer',
        identity_data = '{}'::jsonb
    where id = 'f1100000-0000-4000-8000-000000000001'
  $sql$,
  'reviewer soft deletion may obfuscate identity binding fields'
);

select lives_ok(
  $sql$
    delete from auth.identities
    where id = 'f1100000-0000-4000-8000-000000000001'
  $sql$,
  'reviewer soft deletion may remove the obfuscated identity'
);

select lives_ok(
  $sql$
    delete from auth.users
    where id = 'f1000000-0000-4000-8000-000000000001'
  $sql$,
  'hard deletion remains available after reviewer soft deletion'
);

select lives_ok(
  $sql$
    delete from auth.users
    where id = 'f1000000-0000-4000-8000-000000000006'
  $sql$,
  'direct hard deletion also remains available for a historical reviewer Auth user'
);

select * from finish();
rollback;
