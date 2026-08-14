begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

-- ACL and private inventory boundary --------------------------------------

select has_table('private', 'reviewer_fixture_items', 'fixture inventory exists');
select has_table('private', 'reviewer_access_actions', 'lifecycle audit exists');
select ok(
  (
    select bool_and(relation_row.relrowsecurity and relation_row.relforcerowsecurity)
    from pg_class as relation_row
    join pg_namespace as schema_row on schema_row.oid = relation_row.relnamespace
    where schema_row.nspname = 'private'
      and relation_row.relname in (
        'reviewer_fixture_templates',
        'reviewer_fixture_items',
        'reviewer_access_actions'
      )
  ),
  'all reviewer fixture tables enable and force RLS'
);

select is(
  (
    select count(*)::bigint
    from information_schema.role_table_grants as grant_row
    where grant_row.table_schema = 'private'
      and grant_row.table_name in (
        'reviewer_fixture_templates',
        'reviewer_fixture_items',
        'reviewer_access_actions'
      )
      and grant_row.grantee in ('anon', 'authenticated', 'service_role')
  ),
  0::bigint,
  'Data API roles have no direct fixture-table privileges'
);

select ok(
  has_function_privilege(
    'service_role',
    'api_private.provision_reviewer_access(uuid,uuid,text,text,uuid,bigint,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'api_private.reset_reviewer_access(uuid,uuid,uuid,bigint,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'api_private.revoke_reviewer_access(uuid,uuid,uuid)',
    'EXECUTE'
  ),
  'service role alone receives the lifecycle entry points'
);

select is(
  (
    select count(*)::bigint
    from unnest(array['public', 'anon', 'authenticated', 'service_role'])
      as role_row(role_name)
    where has_function_privilege(
      role_row.role_name,
      'api_private.revoke_reviewer_access_before_fixture_lifecycle(uuid)',
      'EXECUTE'
    )
  ),
  0::bigint,
  'the historical one-argument revoke primitive is internal-only'
);

select is(
  (
    select count(*)::bigint
    from unnest(array['anon', 'authenticated']) as browser_role(role_name)
    cross join unnest(array[
      'api_private.provision_reviewer_access(uuid,uuid,text,text,uuid,bigint,text)',
      'api_private.reset_reviewer_access(uuid,uuid,uuid,bigint,text)',
      'api_private.complete_reviewer_access_fixture(uuid,uuid,uuid,uuid,bigint,text)',
      'api_private.revoke_reviewer_access(uuid,uuid,uuid)'
    ]) as protected_function(signature)
    where has_function_privilege(
      browser_role.role_name,
      protected_function.signature,
      'EXECUTE'
    )
  ),
  0::bigint,
  'browser roles cannot execute lifecycle RPCs'
);
select is(
  (
    select count(*)::bigint
    from unnest(array['public', 'anon', 'authenticated', 'service_role'])
      as role_row(role_name)
    where has_function_privilege(
      role_row.role_name,
      'api_private.redeem_participant_invite_before_reviewer_fixture(uuid,text)',
      'EXECUTE'
    )
  ),
  0::bigint,
  'the pre-reviewer invite primitive is not directly executable'
);

-- Dedicated admin and confirmed email/password reviewer -------------------

insert into auth.users (
  id, created_at, updated_at, email, encrypted_password, email_confirmed_at,
  is_anonymous, is_sso_user, role, aud, is_super_admin, banned_until,
  raw_app_meta_data, raw_user_meta_data
) values
  (
    'd1000000-0000-4000-8000-000000000001', now(), now(),
    'fixture-admin@example.test', 'admin-test-hash', now(), false, false,
    'authenticated', 'authenticated', false, null,
    '{"provider":"email","providers":["email"]}', '{}'
  ),
  (
    'd1000000-0000-4000-8000-000000000002', now(), now(),
    'fixture-reviewer@example.test', 'reviewer-test-hash', now(), false, false,
    'authenticated', 'authenticated', false, null,
    '{"provider":"email","providers":["email"]}', '{}'
  );

insert into auth.identities (
  id, user_id, provider_id, identity_data, provider,
  last_sign_in_at, created_at, updated_at
) values
  (
    'd1100000-0000-4000-8000-000000000001',
    'd1000000-0000-4000-8000-000000000001',
    'd1000000-0000-4000-8000-000000000001',
    '{"sub":"d1000000-0000-4000-8000-000000000001","email":"fixture-admin@example.test","email_verified":true}',
    'email', now(), now(), now()
  ),
  (
    'd1100000-0000-4000-8000-000000000002',
    'd1000000-0000-4000-8000-000000000002',
    'd1000000-0000-4000-8000-000000000002',
    '{"sub":"d1000000-0000-4000-8000-000000000002","email":"fixture-reviewer@example.test","email_verified":false}',
    'email', now(), now(), now()
  );

insert into private.admin_members (auth_user_id)
values ('d1000000-0000-4000-8000-000000000001');

create temp table reviewer_fixture_user on commit drop as
select identity_row.user_id
from private.user_identities as identity_row
where identity_row.auth_user_id = 'd1000000-0000-4000-8000-000000000002'
  and identity_row.revoked_at is null;

select ok(
  private.reviewer_auth_credential_is_valid((select user_id from reviewer_fixture_user)),
  'confirmed Auth user accepts the Admin API identity metadata representation'
);

update auth.users
set raw_app_meta_data = raw_app_meta_data || '{"role":"admin"}'::jsonb
where id = 'd1000000-0000-4000-8000-000000000002';
select ok(
  not private.reviewer_auth_credential_is_valid((select user_id from reviewer_fixture_user)),
  'reviewer Auth rejects non-email application metadata'
);
update auth.users
set raw_app_meta_data = '{"provider":"email","providers":["email"]}'::jsonb
where id = 'd1000000-0000-4000-8000-000000000002';

update auth.users
set raw_user_meta_data = '{"email_verified":true,"display_name":"not-allowed"}'::jsonb
where id = 'd1000000-0000-4000-8000-000000000002';
select ok(
  not private.reviewer_auth_credential_is_valid((select user_id from reviewer_fixture_user)),
  'reviewer Auth rejects custom user metadata before designation'
);
update auth.users
set raw_user_meta_data = '{}'
where id = 'd1000000-0000-4000-8000-000000000002';

update auth.users
set role = 'service_role'
where id = 'd1000000-0000-4000-8000-000000000002';
select ok(
  not private.reviewer_auth_credential_is_valid((select user_id from reviewer_fixture_user)),
  'reviewer Auth rejects a service-role JWT authorization claim'
);
update auth.users
set role = 'authenticated'
where id = 'd1000000-0000-4000-8000-000000000002';

update auth.users
set aud = 'service_role'
where id = 'd1000000-0000-4000-8000-000000000002';
select ok(
  not private.reviewer_auth_credential_is_valid((select user_id from reviewer_fixture_user)),
  'reviewer Auth rejects a non-user JWT audience'
);
update auth.users
set aud = 'authenticated', is_super_admin = true
where id = 'd1000000-0000-4000-8000-000000000002';
select ok(
  not private.reviewer_auth_credential_is_valid((select user_id from reviewer_fixture_user)),
  'reviewer Auth rejects a super-admin credential'
);
update auth.users
set is_super_admin = false, banned_until = now() + interval '1 day'
where id = 'd1000000-0000-4000-8000-000000000002';
select ok(
  not private.reviewer_auth_credential_is_valid((select user_id from reviewer_fixture_user)),
  'reviewer Auth rejects a banned credential'
);
update auth.users
set banned_until = null
where id = 'd1000000-0000-4000-8000-000000000002';

-- Six complete Seoul release candidates ----------------------------------

insert into public.regions (code, country_code, sort_order)
values ('seoul', 'KR', 1);

insert into public.region_translations (
  region_code, locale, name, status, approved_at, approved_by
)
select
  'seoul', locale_row.locale, 'Seoul', 'approved', now(),
  'd1000000-0000-4000-8000-000000000001'
from unnest(enum_range(null::public.content_locale)) as locale_row(locale);

insert into public.spots (
  id, slug, region, name_ko, name_en, status, latitude, longitude, sort_order
)
select
  fixture.spot_id,
  fixture.slug,
  'seoul',
  fixture.slug,
  fixture.slug,
  'draft',
  37.50 + fixture.position * 0.001,
  126.90 + fixture.position * 0.001,
  fixture.position
from (
  values
    (1, 'd2000000-0000-4000-8000-000000000001'::uuid, 'seoul-cheongjin-lol-park-nearby-exterior'),
    (2, 'd2000000-0000-4000-8000-000000000002'::uuid, 'seoul-gwanghwamun-square'),
    (3, 'd2000000-0000-4000-8000-000000000003'::uuid, 'seoul-ddp-history-park'),
    (4, 'd2000000-0000-4000-8000-000000000004'::uuid, 'seoul-hongdae-red-road-r1'),
    (5, 'd2000000-0000-4000-8000-000000000005'::uuid, 'seoul-seokchon-lake-park'),
    (6, 'd2000000-0000-4000-8000-000000000006'::uuid, 'seoul-olympic-park')
) as fixture(position, spot_id, slug);

insert into public.spot_translations (
  spot_id, locale, name, status, approved_at, approved_by
)
select
  spot_row.id, locale_row.locale, spot_row.slug, 'approved', now(),
  'd1000000-0000-4000-8000-000000000001'
from public.spots as spot_row
cross join unnest(enum_range(null::public.content_locale)) as locale_row(locale)
where spot_row.region = 'seoul';

insert into public.cards (
  id, spot_id, code, kind, title_ko, title_en, sketch_path,
  color_hex, is_published
)
select
  ('d3000000-0000-4000-8000-' || lpad(position::text, 12, '0'))::uuid,
  spot_id,
  'reviewer-card-' || position,
  'region',
  slug,
  slug,
  'reviewer-fixture/' || position || '.webp',
  '#355F55',
  false
from (
  select row_number() over (order by id)::integer as position, id as spot_id, slug
  from public.spots where region = 'seoul'
) as spot_fixture;

insert into public.card_translations (
  card_id, locale, title, status, approved_at, approved_by
)
select
  card_row.id, locale_row.locale, card_row.code, 'approved', now(),
  'd1000000-0000-4000-8000-000000000001'
from public.cards as card_row
cross join unnest(enum_range(null::public.content_locale)) as locale_row(locale)
where card_row.code like 'reviewer-card-%';

update public.cards
set is_published = true, published_at = now()
where code like 'reviewer-card-%';

update public.spots
set status = 'open'
where region = 'seoul';

-- Complete four-policy current set; fixture acceptances are system-labelled.
insert into private.policy_documents (
  id, policy_type, version, effective_at, published_at, is_current
) values
  ('d4000000-0000-4000-8000-000000000001', 'terms_of_use', 'fixture-v1', now() - interval '1 day', now(), false),
  ('d4000000-0000-4000-8000-000000000002', 'privacy_policy', 'fixture-v1', now() - interval '1 day', now(), false),
  ('d4000000-0000-4000-8000-000000000003', 'community_guidelines', 'fixture-v1', now() - interval '1 day', now(), false),
  ('d4000000-0000-4000-8000-000000000004', 'location_terms', 'fixture-v1', now() - interval '1 day', now(), false);

insert into private.policy_document_locales (
  policy_document_id, locale, document_url, sha256
)
select
  document_row.id,
  locale_row.locale,
  'https://example.test/policies/' || document_row.id::text || '/' || locale_row.locale::text,
  extensions.digest(document_row.id::text || ':' || locale_row.locale::text, 'sha256')
from private.policy_documents as document_row
cross join unnest(enum_range(null::public.content_locale)) as locale_row(locale)
where document_row.version = 'fixture-v1';

select is(
  api_private.set_current_policy_documents(array[
    'd4000000-0000-4000-8000-000000000001'::uuid,
    'd4000000-0000-4000-8000-000000000002'::uuid,
    'd4000000-0000-4000-8000-000000000003'::uuid,
    'd4000000-0000-4000-8000-000000000004'::uuid
  ]) ->> 'status',
  'switched',
  'complete policy set is current before fixture creation'
);

-- Provision is prepared without exposing a partially active reviewer. ------

insert into public.physical_requests (user_id, kind)
values ((select user_id from reviewer_fixture_user), 'request');
select is(
  api_private.provision_reviewer_access(
    'd1000000-0000-4000-8000-000000000001',
    (select user_id from reviewer_fixture_user),
    'app_store',
    'reviewer-fixture-v1',
    'd5000000-0000-4000-8000-000000000009',
    1234,
    repeat('a', 64)
  ) ->> 'status',
  'fixture_conflict',
  'provision rejects an existing real-user data history'
);
delete from public.physical_requests
where user_id = (select user_id from reviewer_fixture_user);

insert into public.app_users (id)
values ('d1200000-0000-4000-8000-000000000001');
insert into private.user_identities (
  auth_user_id,
  user_id,
  bound_at,
  revoked_at
) values (
  'd1000000-0000-4000-8000-000000000002',
  'd1200000-0000-4000-8000-000000000001',
  now() - interval '2 minutes',
  now() - interval '1 minute'
);
select is(
  api_private.provision_reviewer_access(
    'd1000000-0000-4000-8000-000000000001',
    (select user_id from reviewer_fixture_user),
    'app_store',
    'reviewer-fixture-v1',
    'd5000000-0000-4000-8000-000000000008',
    1234,
    repeat('a', 64)
  ) ->> 'status',
  'fixture_conflict',
  'provision rejects an Auth credential with any prior logical-user binding'
);
delete from private.user_identities
where user_id = 'd1200000-0000-4000-8000-000000000001';
delete from public.app_users
where id = 'd1200000-0000-4000-8000-000000000001';

update auth.users
set last_sign_in_at = now()
where id = 'd1000000-0000-4000-8000-000000000002';
select is(
  api_private.provision_reviewer_access(
    'd1000000-0000-4000-8000-000000000001',
    (select user_id from reviewer_fixture_user),
    'app_store',
    'reviewer-fixture-v1',
    'd5000000-0000-4000-8000-000000000007',
    1234,
    repeat('a', 64)
  ) ->> 'status',
  'fixture_conflict',
  'provision rejects an Auth credential with any prior sign-in'
);
update auth.users
set last_sign_in_at = null
where id = 'd1000000-0000-4000-8000-000000000002';

create temp table reviewer_admin_rate_checkpoint on commit drop as
select coalesce(cardinality(window_row.attempted_at), 0) as attempt_count
from private.user_identities as identity_row
left join private.rate_limit_windows as window_row
  on window_row.user_id = identity_row.user_id
 and window_row.purpose = 'admin_mutation'
where identity_row.auth_user_id = 'd1000000-0000-4000-8000-000000000001'
  and identity_row.revoked_at is null;

select is(
  api_private.provision_reviewer_access(
    'd1000000-0000-4000-8000-000000000001',
    (select user_id from reviewer_fixture_user),
    'app_store',
    'reviewer-fixture-v1',
    'd5000000-0000-4000-8000-000000000001',
    1234,
    repeat('a', 64)
  ) ->> 'status',
  'prepared',
  'provision prepare records an idempotent photo binding'
);

select is(
  (select count(*)::bigint from private.reviewer_accounts),
  1::bigint,
  'prepare reserves reviewer history and freezes the credential'
);
select is(
  (select count(*)::bigint from private.participant_access),
  0::bigint,
  'prepare does not grant participant access before fixture completion'
);
select is(
  api_private.get_access_projection('d1000000-0000-4000-8000-000000000002')
    ->> 'access_type',
  'standard',
  'prepared reviewer reservation is not projected as store_reviewer'
);

insert into private.participant_invite_codes (code_hash)
values (decode(repeat('f', 64), 'hex'));
select is(
  api_private.redeem_participant_invite(
    'd1000000-0000-4000-8000-000000000002',
    repeat('f', 64)
  ),
  '{"status":"not_found"}'::jsonb,
  'a prepared reviewer cannot redeem a generic participant invite'
);
select is(
  (select count(*)::bigint from private.participant_access),
  0::bigint,
  'blocked invite redemption cannot open prepared reviewer access'
);
select is(
  (
    select count(*)::bigint
    from private.participant_invite_codes
    where code_hash = decode(repeat('f', 64), 'hex')
      and redeemed_at is null
      and redeemed_by_user_id is null
  ),
  1::bigint,
  'blocked reviewer redemption does not consume the one-use invite'
);

select throws_ok(
  $sql$
    update auth.users
    set raw_user_meta_data = raw_user_meta_data || '{"display_name":"reviewer"}'::jsonb
    where id = 'd1000000-0000-4000-8000-000000000002'
  $sql$,
  '23514',
  'credential metadata mutation is forbidden',
  'prepared reviewer user metadata cannot drift from the Admin API shape'
);
select throws_ok(
  $sql$
    update auth.users
    set role = 'service_role'
    where id = 'd1000000-0000-4000-8000-000000000002'
  $sql$,
  '23514',
  'credential metadata mutation is forbidden',
  'prepared reviewer JWT role cannot drift to service_role'
);
select throws_ok(
  $sql$
    update auth.users
    set aud = 'service_role'
    where id = 'd1000000-0000-4000-8000-000000000002'
  $sql$,
  '23514',
  'credential metadata mutation is forbidden',
  'prepared reviewer JWT audience is immutable'
);
select throws_ok(
  $sql$
    update auth.users
    set is_super_admin = true
    where id = 'd1000000-0000-4000-8000-000000000002'
  $sql$,
  '23514',
  'credential metadata mutation is forbidden',
  'prepared reviewer cannot become a super admin'
);
select throws_ok(
  $sql$
    update auth.users
    set banned_until = now() + interval '1 day'
    where id = 'd1000000-0000-4000-8000-000000000002'
  $sql$,
  '23514',
  'credential metadata mutation is forbidden',
  'reviewer must be revoked before a ban mutation'
);

select is(
  api_private.record_minimum_age_attestation(
    'd1000000-0000-4000-8000-000000000002',
    '{"minimum_age_passed":true,"version":"18plus-v1"}'::jsonb
  ) ->> 'status',
  'attested',
  'a prepared credential can create real-user state before completion'
);
select is(
  api_private.complete_reviewer_access_fixture(
    'd1000000-0000-4000-8000-000000000001',
    (select user_id from reviewer_fixture_user),
    'd5000000-0000-4000-8000-000000000001',
    private.reviewer_fixture_uuid(
      (select user_id from reviewer_fixture_user),
      'photo:d5000000-0000-4000-8000-000000000001'
    ),
    1234,
    repeat('a', 64)
  ) ->> 'status',
  'fixture_conflict',
  'provision completion rechecks the reserved target pristine state'
);
select ok(
  not exists (
    select 1 from private.participant_access
    where user_id = (select user_id from reviewer_fixture_user)
  )
  and not exists (
    select 1 from private.reviewer_fixture_items
    where user_id = (select user_id from reviewer_fixture_user)
  )
  and not exists (
    select 1 from private.policy_acceptances
    where user_id = (select user_id from reviewer_fixture_user)
      and acceptance_source = 'reviewer_fixture'
  ),
  'pristine conflict installs no membership, inventory, or fixture policy rows'
);
select ok(
  exists (
    select 1 from private.reviewer_access_actions
    where client_action_id = 'd5000000-0000-4000-8000-000000000001'
      and completed_result_json is null
  ),
  'pristine conflict preserves the prepared action for cleanup or retry'
);
delete from private.minimum_age_attestations
where user_id = (select user_id from reviewer_fixture_user);

select is(
  api_private.complete_reviewer_access_fixture(
    'd1000000-0000-4000-8000-000000000001',
    (select user_id from reviewer_fixture_user),
    'd5000000-0000-4000-8000-000000000001',
    private.reviewer_fixture_uuid(
      (select user_id from reviewer_fixture_user),
      'photo:d5000000-0000-4000-8000-000000000001'
    ),
    1234,
    repeat('a', 64)
  ) ->> 'status',
  'applied',
  'completion atomically installs reviewer membership and fixture'
);

select is(
  (
    select cardinality(window_row.attempted_at) - checkpoint.attempt_count
    from private.rate_limit_windows as window_row
    join private.user_identities as identity_row
      on identity_row.user_id = window_row.user_id
    cross join reviewer_admin_rate_checkpoint as checkpoint
    where identity_row.auth_user_id = 'd1000000-0000-4000-8000-000000000001'
      and window_row.purpose = 'admin_mutation'
  ),
  1,
  'provision prepare plus all completion attempts consume one admin rate slot'
);
update reviewer_admin_rate_checkpoint as checkpoint
set attempt_count = (
  select cardinality(window_row.attempted_at)
  from private.rate_limit_windows as window_row
  join private.user_identities as identity_row
    on identity_row.user_id = window_row.user_id
  where identity_row.auth_user_id = 'd1000000-0000-4000-8000-000000000001'
    and window_row.purpose = 'admin_mutation'
);

select is(
  (select count(*)::bigint from public.acquisitions where acquisition_type = 'retro'),
  6::bigint,
  'exactly six retro acquisitions are installed'
);
select is(
  (select count(*)::bigint from public.acquisitions where field_sequence is not null),
  0::bigint,
  'reviewer fixture never creates a field sequence'
);
select is(
  (select count(*)::bigint from private.retro_grants),
  6::bigint,
  'every reviewer retro has one immutable admin grant'
);
select is(
  (select count(*)::bigint from private.reviewer_fixture_items where revoked_at is null),
  8::bigint,
  'inventory contains six retros, one personal card, and one public share'
);
select is(
  (select count(*)::bigint from public.personal_cards where share_state = 'active'),
  1::bigint,
  'the rights-safe sample personal card has one approved active share'
);
select is(
  (
    select count(*)::bigint
    from private.policy_acceptances
    where acceptance_source = 'reviewer_fixture'
  ),
  2::bigint,
  'fixture policy snapshots are not mislabelled as end-user acceptance'
);

create temp table initial_reviewer_fixture on commit drop as
select
  card_row.id as card_id,
  card_row.share_slug,
  action_row.completed_result_json ->> 'fixture_hash' as fixture_hash,
  action_row.completed_result_json ->> 'photo_object_id' as photo_object_id
from public.personal_cards as card_row
cross join private.reviewer_access_actions as action_row
where action_row.client_action_id = 'd5000000-0000-4000-8000-000000000001';

select ok(
  not exists (
    select 1
    from private.reviewer_access_actions as action_row
    where action_row.result_json::text ilike '%password%'
      or action_row.result_json::text ilike '%example.test%'
      or action_row.completed_result_json::text ilike '%password%'
      or action_row.completed_result_json::text ilike '%example.test%'
  ),
  'lifecycle audit contains no email or password material'
);

-- Reset rotates only the photo/share shell and preserves deterministic core.

select is(
  api_private.reset_reviewer_access(
    'd1000000-0000-4000-8000-000000000001',
    (select user_id from reviewer_fixture_user),
    'd5000000-0000-4000-8000-000000000002',
    1234,
    repeat('a', 64)
  ) ->> 'status',
  'prepared',
  'active reviewer reset is prepared'
);

-- A newly-current policy can already have a genuine user acceptance. Reset
-- must not reuse or relabel that row as deterministic fixture provenance.
insert into private.policy_documents (
  id, policy_type, version, effective_at, published_at, is_current
) values
  ('d4100000-0000-4000-8000-000000000001', 'terms_of_use', 'fixture-v2', now() - interval '1 day', now(), false),
  ('d4100000-0000-4000-8000-000000000002', 'privacy_policy', 'fixture-v2', now() - interval '1 day', now(), false),
  ('d4100000-0000-4000-8000-000000000003', 'community_guidelines', 'fixture-v2', now() - interval '1 day', now(), false),
  ('d4100000-0000-4000-8000-000000000004', 'location_terms', 'fixture-v2', now() - interval '1 day', now(), false);

insert into private.policy_document_locales (
  policy_document_id, locale, document_url, sha256
)
select
  document_row.id,
  locale_row.locale,
  'https://example.test/policies/' || document_row.id::text || '/' || locale_row.locale::text,
  extensions.digest(document_row.id::text || ':' || locale_row.locale::text, 'sha256')
from private.policy_documents as document_row
cross join unnest(enum_range(null::public.content_locale)) as locale_row(locale)
where document_row.version = 'fixture-v2';

select is(
  api_private.set_current_policy_documents(array[
    'd4100000-0000-4000-8000-000000000001'::uuid,
    'd4100000-0000-4000-8000-000000000002'::uuid,
    'd4100000-0000-4000-8000-000000000003'::uuid,
    'd4100000-0000-4000-8000-000000000004'::uuid
  ]) ->> 'status',
  'switched',
  'a second complete policy set becomes current for reset conflict coverage'
);

insert into private.policy_acceptances (
  id, user_id, policy_document_id, accepted_locale, accepted_sha256,
  accepted_at, acceptance_source
)
select
  'd4200000-0000-4000-8000-000000000001',
  fixture.user_id,
  locale_row.policy_document_id,
  locale_row.locale,
  locale_row.sha256,
  now(),
  'user'
from reviewer_fixture_user as fixture
join private.policy_document_locales as locale_row
  on locale_row.policy_document_id = 'd4100000-0000-4000-8000-000000000001'
 and locale_row.locale = 'ko';

select is(
  api_private.complete_reviewer_access_fixture(
    'd1000000-0000-4000-8000-000000000001',
    (select user_id from reviewer_fixture_user),
    'd5000000-0000-4000-8000-000000000002',
    private.reviewer_fixture_uuid(
      (select user_id from reviewer_fixture_user),
      'photo:d5000000-0000-4000-8000-000000000002'
    ),
    1234,
    repeat('a', 64)
  ) ->> 'status',
  'fixture_conflict',
  'reset rejects a user-source acceptance for a newly-current policy'
);
select is(
  (
    select count(*)::bigint
    from private.reviewer_access_actions
    where client_action_id = 'd5000000-0000-4000-8000-000000000002'
      and completed_result_json is not null
  ),
  0::bigint,
  'policy conflict leaves the prepared reset retryable'
);
select is(
  (select count(*)::bigint from private.participant_access where revoked_at is null),
  1::bigint,
  'policy conflict leaves the existing reviewer membership unchanged'
);
select is(
  (select count(*)::bigint from private.reviewer_fixture_items where revoked_at is null),
  8::bigint,
  'policy conflict rolls back every attempted fixture mutation'
);
select is(
  (
    select count(*)::bigint
    from private.policy_acceptances
    where policy_document_id in (
      'd4100000-0000-4000-8000-000000000001',
      'd4100000-0000-4000-8000-000000000003'
    )
      and acceptance_source = 'reviewer_fixture'
  ),
  0::bigint,
  'policy conflict cannot install partial fixture acceptances'
);
select is(
  (
    select card_row.photo_path
    from public.personal_cards as card_row
    cross join initial_reviewer_fixture as initial_row
    where card_row.id = initial_row.card_id
  ),
  (
    select fixture.user_id::text || '/' || initial_row.photo_object_id || '.webp'
    from reviewer_fixture_user as fixture
    cross join initial_reviewer_fixture as initial_row
  ),
  'policy conflict preserves the previous approved sample photo'
);

delete from private.policy_acceptances
where id = 'd4200000-0000-4000-8000-000000000001';
select is(
  api_private.set_current_policy_documents(array[
    'd4000000-0000-4000-8000-000000000001'::uuid,
    'd4000000-0000-4000-8000-000000000002'::uuid,
    'd4000000-0000-4000-8000-000000000003'::uuid,
    'd4000000-0000-4000-8000-000000000004'::uuid
  ]) ->> 'status',
  'switched',
  'the original policy set is restored before retrying the same reset'
);

select is(
  api_private.complete_reviewer_access_fixture(
    'd1000000-0000-4000-8000-000000000001',
    (select user_id from reviewer_fixture_user),
    'd5000000-0000-4000-8000-000000000002',
    private.reviewer_fixture_uuid(
      (select user_id from reviewer_fixture_user),
      'photo:d5000000-0000-4000-8000-000000000002'
    ),
    1234,
    repeat('a', 64)
  ) ->> 'status',
  'applied',
  'reset completion applies atomically'
);
select is(
  (
    select cardinality(window_row.attempted_at) - checkpoint.attempt_count
    from private.rate_limit_windows as window_row
    join private.user_identities as identity_row
      on identity_row.user_id = window_row.user_id
    cross join reviewer_admin_rate_checkpoint as checkpoint
    where identity_row.auth_user_id = 'd1000000-0000-4000-8000-000000000001'
      and window_row.purpose = 'admin_mutation'
  ),
  1,
  'reset prepare plus conflict and successful completion consume one admin rate slot'
);

select is(
  (select count(*)::bigint from public.acquisitions where acquisition_type = 'retro'),
  6::bigint,
  'reset does not duplicate retro acquisitions'
);
select is(
  (select count(*)::bigint from public.personal_cards),
  1::bigint,
  'reset keeps exactly one sample personal card'
);
select ok(
  (
    select card_row.share_slug <> initial_row.share_slug
    from public.personal_cards as card_row
    cross join initial_reviewer_fixture as initial_row
  ),
  'reset rotates the raw public share secret'
);
select is(
  (
    select action_row.completed_result_json ->> 'fixture_hash'
    from private.reviewer_access_actions as action_row
    where action_row.client_action_id = 'd5000000-0000-4000-8000-000000000002'
  ),
  (select fixture_hash from initial_reviewer_fixture),
  'reset reproduces the deterministic fixture content hash'
);
select is(
  (
    select count(*)::bigint
    from private.reviewer_fixture_items
    where revoked_at is null
  ),
  8::bigint,
  'reset leaves exactly eight active inventory rows'
);
select ok(
  exists (
    select 1
    from private.personal_card_storage_object_tombstones as tombstone_row
    cross join reviewer_fixture_user as fixture
    cross join initial_reviewer_fixture as initial_row
    where tombstone_row.object_hash = private.personal_card_storage_object_hash(
      'personal-cards',
      fixture.user_id::text || '/' || initial_row.photo_object_id || '.webp'
    )
  ),
  'reset permanently tombstones the replaced photo path'
);
select throws_ok(
  format(
    $sql$
      insert into storage.objects (bucket_id, name, owner, version)
      values ('personal-cards', %L, null, 'late-pre-reset-upload')
    $sql$,
    (select user_id::text from reviewer_fixture_user) || '/' ||
      (select photo_object_id from initial_reviewer_fixture) || '.webp'
  ),
  '23514',
  'cleaned personal-card Storage object is closed',
  'a late upload cannot recreate the photo replaced by reset'
);

select is(
  api_private.reset_reviewer_access(
    'd1000000-0000-4000-8000-000000000001',
    (select user_id from reviewer_fixture_user),
    'd5000000-0000-4000-8000-000000000002',
    1234,
    repeat('a', 64)
  ) ->> 'status',
  'applied',
  'exact reset retry returns the completed result without another mutation'
);

select is(
  api_private.reset_reviewer_access(
    'd1000000-0000-4000-8000-000000000001',
    (select user_id from reviewer_fixture_user),
    'd5000000-0000-4000-8000-000000000002',
    1235,
    repeat('a', 64)
  ) ->> 'status',
  'idempotency_conflict',
  'same client action with different photo binding is rejected'
);

-- Revoke closes membership, identity, share, and fixture inventory. --------

select is(
  api_private.reset_reviewer_access(
    'd1000000-0000-4000-8000-000000000001',
    (select user_id from reviewer_fixture_user),
    'd5000000-0000-4000-8000-000000000004',
    1234,
    repeat('a', 64)
  ) ->> 'status',
  'prepared',
  'a reset may be prepared immediately before revoke'
);

savepoint reviewer_deletion_capture;
insert into private.account_deletion_jobs (
  id,
  user_id,
  status_token_hash,
  storage_prefix,
  requested_at,
  complete_by,
  next_attempt_at,
  updated_at
) values (
  'd6000000-0000-4000-8000-000000000001',
  (select user_id from reviewer_fixture_user),
  extensions.digest('reviewer-deletion-status-token', 'sha256'),
  (select user_id from reviewer_fixture_user),
  now(),
  now() + interval '24 hours',
  now(),
  now()
);
select is(
  (
    select count(*)::bigint
    from private.account_deletion_storage_manifest as item_row
    where item_row.request_id = 'd6000000-0000-4000-8000-000000000001'
      and item_row.bucket = 'personal-cards'
  ),
  3::bigint,
  'account deletion captures completed and pending reviewer photo objects'
);
rollback to savepoint reviewer_deletion_capture;

update reviewer_admin_rate_checkpoint as checkpoint
set attempt_count = (
  select cardinality(window_row.attempted_at)
  from private.rate_limit_windows as window_row
  join private.user_identities as identity_row
    on identity_row.user_id = window_row.user_id
  where identity_row.auth_user_id = 'd1000000-0000-4000-8000-000000000001'
    and window_row.purpose = 'admin_mutation'
);

select is(
  api_private.revoke_reviewer_access(
    'd1000000-0000-4000-8000-000000000001',
    (select user_id from reviewer_fixture_user),
    'd5000000-0000-4000-8000-000000000003'
  ) ->> 'status',
  'revoked',
  'admin lifecycle revoke closes the reviewer'
);
select is(
  (
    select cardinality(window_row.attempted_at) - checkpoint.attempt_count
    from private.rate_limit_windows as window_row
    join private.user_identities as identity_row
      on identity_row.user_id = window_row.user_id
    cross join reviewer_admin_rate_checkpoint as checkpoint
    where identity_row.auth_user_id = 'd1000000-0000-4000-8000-000000000001'
      and window_row.purpose = 'admin_mutation'
  ),
  1,
  'revoke remains one counted admin mutation attempt'
);
select is(
  (
    select jsonb_array_length(action_row.result_json -> 'old_photo_object_ids')
    from private.reviewer_access_actions as action_row
    where action_row.client_action_id = 'd5000000-0000-4000-8000-000000000003'
  ),
  3,
  'revoke cleanup includes current, previous, and prepared photo objects'
);
select is(
  (
    select count(*)::bigint
    from private.personal_card_storage_object_tombstones as tombstone_row
    cross join reviewer_fixture_user as fixture
    where tombstone_row.object_hash in (
      select private.personal_card_storage_object_hash(
        'personal-cards',
        fixture.user_id::text || '/' || object_id.value || '.webp'
      )
      from jsonb_array_elements_text((
        select action_row.result_json -> 'old_photo_object_ids'
        from private.reviewer_access_actions as action_row
        where action_row.client_action_id = 'd5000000-0000-4000-8000-000000000003'
      )) as object_id(value)
    )
  ),
  3::bigint,
  'revoke permanently tombstones every completed and pending photo path'
);
select throws_ok(
  format(
    $sql$
      insert into storage.objects (bucket_id, name, owner, version)
      values ('personal-cards', %L, null, 'late-reviewer-upload')
    $sql$,
    (select user_id::text from reviewer_fixture_user) || '/' ||
      private.reviewer_fixture_uuid(
        (select user_id from reviewer_fixture_user),
        'photo:d5000000-0000-4000-8000-000000000004'
      )::text || '.webp'
  ),
  '23514',
  'cleaned personal-card Storage object is closed',
  'a late prepared upload cannot commit after reviewer revoke cleanup'
);
select is(
  api_private.reset_reviewer_access(
    'd1000000-0000-4000-8000-000000000001',
    (select user_id from reviewer_fixture_user),
    'd5000000-0000-4000-8000-000000000004',
    1234,
    repeat('a', 64)
  ) ->> 'status',
  'not_found',
  'a prepared reset cannot instruct a new upload after revoke'
);
select is(
  (select count(*)::bigint from private.reviewer_fixture_items where revoked_at is null),
  0::bigint,
  'revoke closes every active fixture inventory row'
);
select is(
  (select count(*)::bigint from public.personal_cards where share_state <> 'private'),
  0::bigint,
  'revoke makes the approved sample share private'
);
select is(
  api_private.get_access_projection('d1000000-0000-4000-8000-000000000002') ->> 'status',
  'unauthorized',
  'the former reviewer JWT projection is immediately unauthorized'
);
select is(
  api_private.revoke_reviewer_access(
    'd1000000-0000-4000-8000-000000000001',
    (select user_id from reviewer_fixture_user),
    'd5000000-0000-4000-8000-000000000003'
  ) ->> 'status',
  'revoked',
  'exact revoke retry returns the immutable first result'
);

select * from finish();
rollback;
