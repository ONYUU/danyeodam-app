begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

-- Schema, history, and ACL boundary --------------------------------------

select has_table(
  'private',
  'reviewer_user_history',
  'reviewer history has a non-reusable private tombstone'
);

select ok(
  (
    select relation_row.relrowsecurity and relation_row.relforcerowsecurity
    from pg_class as relation_row
    join pg_namespace as schema_row
      on schema_row.oid = relation_row.relnamespace
    where schema_row.nspname = 'private'
      and relation_row.relname = 'reviewer_user_history'
  ),
  'reviewer history enables and forces RLS'
);

select ok(
  exists (
    select 1
    from pg_constraint as constraint_row
    where constraint_row.conrelid = 'private.reviewer_user_history'::regclass
      and constraint_row.confrelid = 'public.app_users'::regclass
      and constraint_row.contype = 'f'
      and constraint_row.confdeltype = 'c'
  ),
  'reviewer history follows full logical-account deletion by cascade'
);

select is(
  (
    select count(*)::bigint
    from information_schema.role_table_grants as grant_row
    where grant_row.table_schema = 'private'
      and grant_row.table_name = 'reviewer_user_history'
      and grant_row.grantee in ('anon', 'authenticated', 'service_role')
  ),
  0::bigint,
  'Data API roles have no direct reviewer-history privileges'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where (
        (
          schema_row.nspname = 'private'
          and function_row.proname in (
            'user_has_reviewer_history',
            'lock_down_reviewer_recovery',
            'guard_reviewer_recovery_code'
          )
        )
        or (
          schema_row.nspname = 'api_private'
          and function_row.proname in (
            'issue_recovery_code',
            'get_email_link_eligibility',
            'revoke_reviewer_access_before_fixture_lifecycle',
            'revoke_reviewer_access'
          )
          and pg_get_function_identity_arguments(function_row.oid) in (
            'p_auth_user_id uuid, p_code_hash_hex text',
            'p_auth_user_id uuid',
            'p_user_id uuid',
            'p_admin_auth_user_id uuid, p_user_id uuid, p_client_action_id uuid'
          )
        )
      )
      and function_row.prosecdef
      and coalesce(function_row.proconfig, array[]::text[])
        @> array['search_path=""']::text[]
  ),
  7::bigint,
  'all reviewer security and audited lifecycle functions are SECURITY DEFINER with empty search_path'
);

select is(
  (
    select count(*)::bigint
    from pg_trigger as trigger_row
    where trigger_row.tgrelid in (
        'private.reviewer_accounts'::regclass,
        'private.recovery_codes'::regclass
      )
      and trigger_row.tgname in (
        'reviewer_accounts_lock_down_recovery',
        'recovery_codes_guard_reviewer_transfer'
      )
      and not trigger_row.tgisinternal
  ),
  2::bigint,
  'reviewer designation and recovery-code activation are both guarded'
);

select ok(
  has_function_privilege(
    'service_role',
    'api_private.get_email_link_eligibility(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'api_private.revoke_reviewer_access_before_fixture_lifecycle(uuid)',
    'EXECUTE'
  ),
  'service_role can check email eligibility but cannot bypass audited reviewer revocation'
);

select is(
  (
    select count(*)::bigint
    from unnest(array['anon', 'authenticated']) as browser_role(role_name)
    cross join unnest(array[
      'api_private.get_email_link_eligibility(uuid)',
      'api_private.revoke_reviewer_access_before_fixture_lifecycle(uuid)'
    ]) as protected_function(signature)
    where has_function_privilege(
      browser_role.role_name,
      protected_function.signature,
      'EXECUTE'
    )
  ),
  0::bigint,
  'browser roles cannot execute reviewer lifecycle decisions'
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
  ('e1000000-0000-4000-8000-000000000001', now(), now(), false, '{}'),
  ('e1000000-0000-4000-8000-000000000002', now(), now(), true, '{}'),
  ('e1000000-0000-4000-8000-000000000003', now(), now(), true, '{}'),
  ('e1000000-0000-4000-8000-000000000004', now(), now(), true, '{}');

update auth.users
set email = 'reviewer-lockdown@example.test',
    encrypted_password = 'reviewer-lockdown-hash',
    email_confirmed_at = now(),
    role = 'authenticated',
    aud = 'authenticated',
    is_super_admin = false,
    banned_until = null,
    raw_app_meta_data = '{"provider":"email","providers":["email"]}'::jsonb
where id = 'e1000000-0000-4000-8000-000000000001';

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
  'e1100000-0000-4000-8000-000000000001',
  'e1000000-0000-4000-8000-000000000001',
  'e1000000-0000-4000-8000-000000000001',
  '{"sub":"e1000000-0000-4000-8000-000000000001","email":"reviewer-lockdown@example.test","email_verified":true}'::jsonb,
  'email',
  now(),
  now(),
  now()
);

create temp table test_reviewer_lockdown_users (
  fixture_name text primary key,
  auth_user_id uuid not null,
  user_id uuid not null
) on commit drop;

insert into test_reviewer_lockdown_users (
  fixture_name,
  auth_user_id,
  user_id
)
select fixture.fixture_name, fixture.auth_user_id, identity_row.user_id
from (
  values
    ('reviewer', 'e1000000-0000-4000-8000-000000000001'::uuid),
    ('historical', 'e1000000-0000-4000-8000-000000000002'::uuid),
    ('claimant', 'e1000000-0000-4000-8000-000000000003'::uuid),
    ('standard', 'e1000000-0000-4000-8000-000000000004'::uuid)
) as fixture(fixture_name, auth_user_id)
join private.user_identities as identity_row
  on identity_row.auth_user_id = fixture.auth_user_id
 and identity_row.revoked_at is null;

insert into public.regions (code, country_code, sort_order)
values ('test', 'KR', 999);

insert into public.region_translations (
  region_code,
  locale,
  name,
  status,
  approved_at,
  approved_by
)
select
  'test',
  locale_row.locale,
  'Reviewer test region',
  'approved',
  now(),
  'e1000000-0000-4000-8000-000000000001'
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
  longitude
)
values (
  'e2000000-0000-4000-8000-000000000001',
  'reviewer-security-test',
  'test',
  '심사 보안 스팟',
  'Reviewer security spot',
  'draft',
  37.5,
  127.0
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
  'e2000000-0000-4000-8000-000000000001',
  locale_row.locale,
  'Reviewer security spot',
  'approved',
  now(),
  'e1000000-0000-4000-8000-000000000001'
from unnest(enum_range(null::public.content_locale))
  as locale_row(locale);

insert into public.cards (
  id,
  spot_id,
  code,
  title_ko,
  title_en,
  sketch_path,
  color_hex
)
values (
  'e3000000-0000-4000-8000-000000000001',
  'e2000000-0000-4000-8000-000000000001',
  'reviewer-security-card',
  '심사 보안 카드',
  'Reviewer security card',
  'cards/reviewer-security.webp',
  '#123456'
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
  'e3000000-0000-4000-8000-000000000001',
  locale_row.locale,
  'Reviewer security card',
  'approved',
  now(),
  'e1000000-0000-4000-8000-000000000001'
from unnest(enum_range(null::public.content_locale))
  as locale_row(locale);

update public.cards
set is_published = true,
    published_at = now()
where id = 'e3000000-0000-4000-8000-000000000001';

update public.spots
set status = 'open'
where id = 'e2000000-0000-4000-8000-000000000001';

insert into public.acquisitions (
  id,
  user_id,
  spot_id,
  card_id,
  acquisition_type,
  verification_result,
  idempotency_key,
  field_sequence
)
select
  fixture.acquisition_id,
  user_row.user_id,
  'e2000000-0000-4000-8000-000000000001',
  'e3000000-0000-4000-8000-000000000001',
  'gift',
  'not_applicable',
  fixture.idempotency_key,
  null
from (
  values
    (
      'reviewer'::text,
      'e4000000-0000-4000-8000-000000000001'::uuid,
      'e6000000-0000-4000-8000-000000000001'::uuid
    ),
    (
      'standard'::text,
      'e4000000-0000-4000-8000-000000000002'::uuid,
      'e6000000-0000-4000-8000-000000000002'::uuid
    )
) as fixture(fixture_name, acquisition_id, idempotency_key)
join test_reviewer_lockdown_users as user_row
  on user_row.fixture_name = fixture.fixture_name;

insert into public.personal_cards (
  id,
  user_id,
  acquisition_id,
  photo_path,
  caption
)
select
  'e5000000-0000-4000-8000-000000000001',
  user_row.user_id,
  'e4000000-0000-4000-8000-000000000001',
  user_row.user_id::text || '/reviewer-fixture.webp',
  '심사 샘플'
from test_reviewer_lockdown_users as user_row
where user_row.fixture_name = 'reviewer';

-- The reviewer migration can land before or after the separate UGC branch,
-- whose canonical pending enum label is `pending` instead of the privacy
-- cutover's `pending_review`. Both models accept a non-public resubmission row.
do $$
declare
  v_pending_state text;
begin
  select case
    when exists (
      select 1
      from pg_enum as enum_row
      join pg_type as type_row on type_row.oid = enum_row.enumtypid
      join pg_namespace as schema_row on schema_row.oid = type_row.typnamespace
      where schema_row.nspname = 'public'
        and type_row.typname = 'personal_card_share_state'
        and enum_row.enumlabel = 'pending'
    ) then 'pending'
    else 'pending_review'
  end
  into v_pending_state;

  execute format(
    'update public.personal_cards
     set share_slug = $1,
         shared_at = now(),
         share_state = %L,
         share_submitted_at = now(),
         share_resubmission_required = true,
         share_reason_code = $2
     where id = $3',
    v_pending_state
  )
  using
    'ReviewerFixtureShare001',
    'REVIEW_FIXTURE',
    'e5000000-0000-4000-8000-000000000001'::uuid;
end;
$$;

insert into private.participant_access (user_id, access_kind)
select user_id, 'store_reviewer'
from test_reviewer_lockdown_users
where fixture_name = 'reviewer';

-- This is a legacy code created immediately before reviewer designation.
insert into private.recovery_codes (user_id, code_hash, expires_at)
select user_id, decode(repeat('a', 64), 'hex'), now() + interval '1 hour'
from test_reviewer_lockdown_users
where fixture_name = 'reviewer';

insert into private.reviewer_accounts (
  user_id,
  store_platform,
  fixture_version
)
select user_id, 'app_store', 'reviewer-lockdown-v1'
from test_reviewer_lockdown_users
where fixture_name = 'reviewer';

insert into private.reviewer_accounts (
  user_id,
  store_platform,
  fixture_version,
  revoked_at
)
select user_id, 'play_store', 'historical-reviewer-v1', now()
from test_reviewer_lockdown_users
where fixture_name = 'historical';

-- Deleting the membership must not make the logical user reusable.
delete from private.reviewer_accounts
where user_id = (
  select user_id
  from test_reviewer_lockdown_users
  where fixture_name = 'historical'
);

-- Recovery and email-link lockdown --------------------------------------

select ok(
  (
    select code_row.revoked_at is not null
    from private.recovery_codes as code_row
    where code_row.code_hash = decode(repeat('a', 64), 'hex')
  ),
  'reviewer designation revokes a legacy unused recovery code'
);

select is(
  api_private.issue_recovery_code(
    'e1000000-0000-4000-8000-000000000001',
    repeat('b', 64)
  ),
  '{"status":"reviewer_forbidden"}'::jsonb,
  'a current reviewer cannot issue a recovery code'
);

select is(
  api_private.issue_recovery_code(
    'e1000000-0000-4000-8000-000000000002',
    repeat('c', 64)
  ),
  '{"status":"reviewer_forbidden"}'::jsonb,
  'reviewer history survives membership deletion and still forbids issue'
);

select is(
  api_private.issue_recovery_code(
    'e1000000-0000-4000-8000-000000000004',
    repeat('d', 64)
  ),
  '{"status":"issued"}'::jsonb,
  'ordinary recovery issue remains available to an eligible user'
);

update private.recovery_codes
set claimed_at = clock_timestamp(),
    claimed_by_auth_user_id = 'e1000000-0000-4000-8000-000000000003'
where code_hash = decode(repeat('d', 64), 'hex');

select throws_ok(
  $sql$
    insert into private.reviewer_accounts (
      user_id,
      store_platform,
      fixture_version
    )
    select user_id, 'play_store', 'must-use-fresh-user'
    from test_reviewer_lockdown_users
    where fixture_name = 'standard'
  $sql$,
  '23514',
  null,
  'a logical user transferred by recovery cannot become a reviewer credential'
);

select is(
  api_private.issue_recovery_code(
    'e1000000-0000-4000-8000-000000000004',
    repeat('1', 64)
  ),
  '{"status":"issued"}'::jsonb,
  'an ordinary target can issue another code for the claimant-direction test'
);

select throws_ok(
  $sql$
    select api_private.claim_recovery_code(
      'e1000000-0000-4000-8000-000000000002',
      repeat('1', 64)
    )
  $sql$,
  'P0002',
  null,
  'a historical reviewer identity cannot claim an ordinary user code'
);

select ok(
  exists (
    select 1
    from private.user_identities as identity_row
    join test_reviewer_lockdown_users as user_row
      on user_row.user_id = identity_row.user_id
    where identity_row.auth_user_id =
        'e1000000-0000-4000-8000-000000000002'
      and identity_row.revoked_at is null
      and user_row.fixture_name = 'historical'
  )
  and exists (
    select 1
    from private.recovery_codes as code_row
    where code_row.code_hash = decode(repeat('1', 64), 'hex')
      and code_row.revoked_at is null
      and code_row.claimed_at is null
  ),
  'blocked reviewer claim rolls back both binding and code mutations'
);

select throws_ok(
  $sql$
    insert into private.recovery_codes (user_id, code_hash)
    select user_id, decode(repeat('e', 64), 'hex')
    from test_reviewer_lockdown_users
    where fixture_name = 'historical'
  $sql$,
  '23514',
  null,
  'reviewer history rejects direct active recovery-code insertion'
);

select throws_ok(
  $sql$
    update private.recovery_codes
    set revoked_at = null
    where code_hash = decode(repeat('a', 64), 'hex')
  $sql$,
  '23514',
  null,
  'a revoked reviewer recovery code cannot be reactivated'
);

select is(
  api_private.claim_recovery_code(
    'e1000000-0000-4000-8000-000000000003',
    repeat('a', 64)
  ),
  '{"status":"not_found"}'::jsonb,
  'claim exposes the same not-found response as an unknown code'
);

select is(
  api_private.get_email_link_eligibility(
    'e1000000-0000-4000-8000-000000000001'
  ),
  '{"status":"reviewer_forbidden"}'::jsonb,
  'a current reviewer cannot enter email linking'
);

select is(
  api_private.get_email_link_eligibility(
    'e1000000-0000-4000-8000-000000000002'
  ),
  '{"status":"reviewer_forbidden"}'::jsonb,
  'a historical reviewer cannot enter email linking'
);

select is(
  api_private.get_email_link_eligibility(
    'e1000000-0000-4000-8000-000000000004'
  ),
  '{"status":"eligible"}'::jsonb,
  'an ordinary active binding remains eligible for email linking'
);

select is(
  api_private.get_email_link_eligibility(
    'efffffff-ffff-4fff-8fff-ffffffffffff'
  ),
  '{"status":"unauthorized"}'::jsonb,
  'an unknown binding is unauthorized for email linking'
);

-- Reviewer revoke primitive ---------------------------------------------

-- Simulate a pre-cutover active code to prove the revoke primitive repairs
-- legacy residue independently of the steady-state activation guard.
alter table private.recovery_codes
  disable trigger recovery_codes_guard_reviewer_transfer;

update private.recovery_codes
set revoked_at = null
where code_hash = decode(repeat('a', 64), 'hex');

alter table private.recovery_codes
  enable trigger recovery_codes_guard_reviewer_transfer;

select throws_ok(
  $sql$
    select api_private.claim_recovery_code(
      'e1000000-0000-4000-8000-000000000003',
      repeat('a', 64)
    )
  $sql$,
  'P0002',
  null,
  'the database rolls back a reviewer claim even with inconsistent legacy residue'
);

select is(
  api_private.revoke_reviewer_access_before_fixture_lifecycle(
    (
      select user_id
      from test_reviewer_lockdown_users
      where fixture_name = 'reviewer'
    )
  ),
  '{
    "status":"revoked",
    "participant_rows":1,
    "identity_rows":1,
    "recovery_code_rows":1,
    "share_rows":1
  }'::jsonb,
  'revoke atomically closes reviewer product access and public artifacts'
);

select ok(
  (
    select reviewer_row.revoked_at is not null
    from private.reviewer_accounts as reviewer_row
    where reviewer_row.user_id = (
      select user_id
      from test_reviewer_lockdown_users
      where fixture_name = 'reviewer'
    )
  ),
  'revoke preserves a revoked reviewer membership row'
);

select ok(
  not exists (
    select 1
    from private.participant_access as access_row
    where access_row.user_id = (
        select user_id
        from test_reviewer_lockdown_users
        where fixture_name = 'reviewer'
      )
      and access_row.revoked_at is null
  ),
  'revoke closes participant access'
);

select ok(
  not exists (
    select 1
    from private.user_identities as identity_row
    where identity_row.user_id = (
        select user_id
        from test_reviewer_lockdown_users
        where fixture_name = 'reviewer'
      )
      and identity_row.revoked_at is null
  ),
  'revoke closes every active service identity'
);

select ok(
  not exists (
    select 1
    from private.recovery_codes as code_row
    where code_row.user_id = (
        select user_id
        from test_reviewer_lockdown_users
        where fixture_name = 'reviewer'
      )
      and code_row.revoked_at is null
      and code_row.claimed_at is null
  ),
  'revoke leaves no active unused recovery code'
);

select ok(
  (
    select
      card_row.share_state = 'private'
      and card_row.share_slug is null
      and card_row.shared_at is null
      and card_row.share_submitted_at is null
      and card_row.share_terms_acceptance_id is null
      and card_row.share_community_acceptance_id is null
      and not card_row.share_resubmission_required
      and card_row.share_reason_code is null
      and card_row.share_reviewed_at is null
      and card_row.share_reviewed_by is null
    from public.personal_cards as card_row
    where card_row.id = 'e5000000-0000-4000-8000-000000000001'
  ),
  'revoke makes reviewer shares private and clears public review metadata'
);

select is(
  api_private.get_access_projection(
    'e1000000-0000-4000-8000-000000000001'
  ),
  '{"status":"unauthorized"}'::jsonb,
  'protected API projection rejects the old reviewer JWT binding immediately'
);

select is(
  api_private.revoke_reviewer_access_before_fixture_lifecycle(
    (
      select user_id
      from test_reviewer_lockdown_users
      where fixture_name = 'reviewer'
    )
  ),
  '{
    "status":"revoked",
    "participant_rows":0,
    "identity_rows":0,
    "recovery_code_rows":0,
    "share_rows":0
  }'::jsonb,
  'repeated reviewer revoke is idempotent'
);

select is(
  api_private.revoke_reviewer_access_before_fixture_lifecycle(
    (
      select user_id
      from test_reviewer_lockdown_users
      where fixture_name = 'historical'
    )
  ),
  '{
    "status":"revoked",
    "participant_rows":0,
    "identity_rows":1,
    "recovery_code_rows":0,
    "share_rows":0
  }'::jsonb,
  'revoke closes residue even after a historical membership row was deleted'
);

select is(
  api_private.get_access_projection(
    'e1000000-0000-4000-8000-000000000002'
  ),
  '{"status":"unauthorized"}'::jsonb,
  'historical reviewer revoke closes its surviving active binding'
);

select is(
  api_private.revoke_reviewer_access_before_fixture_lifecycle(
    'efffffff-ffff-4fff-8fff-ffffffffffff'
  ),
  '{"status":"not_found"}'::jsonb,
  'revoke does not enumerate an unknown reviewer'
);

select * from finish();
rollback;
