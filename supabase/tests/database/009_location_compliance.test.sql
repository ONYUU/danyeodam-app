begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

-- Schema and privilege boundary -----------------------------------------

select set_eq(
  $$ select unnest(enum_range(null::private.location_consent_state))::text $$,
  $$ values ('active'::text), ('paused'::text), ('withdrawal_pending'::text) $$,
  'location consent exposes only the three canonical lifecycle states'
);

select set_eq(
  $$
    select column_name::text
    from information_schema.columns
    where table_schema = 'private'
      and table_name = 'minimum_age_attestations'
  $$,
  $$
    values
      ('user_id'::text),
      ('minimum_age_passed'::text),
      ('version'::text),
      ('attested_at'::text)
  $$,
  'minimum age persistence contains only the exact pass attestation and server timestamp'
);

select is(
  (
    select count(*)::bigint
    from information_schema.columns as column_row
    where column_row.table_schema = 'private'
      and column_row.table_name in (
        'minimum_age_attestations',
        'location_consents',
        'location_use_facts',
        'location_attempt_tombstones',
        'personal_card_field_object_ledger',
        'location_disclosure_accesses',
        'location_correction_requests',
        'data_erasure_jobs',
        'data_erasure_manifest'
      )
      and lower(column_row.column_name) in (
        'date_of_birth', 'dob', 'birth_date', 'birth_year', 'age', 'age_year',
        'age_hash', 'latitude', 'longitude', 'lat', 'lng', 'accuracy',
        'distance', 'ip', 'ip_address', 'raw_ip', 'request', 'request_body'
      )
  ),
  0::bigint,
  'compliance tables contain no DOB, derived age, raw coordinate, distance, IP, or request columns'
);

select is(
  (
    select count(*)::bigint
    from pg_class as relation_row
    join pg_namespace as schema_row on schema_row.oid = relation_row.relnamespace
    where schema_row.nspname = 'private'
      and relation_row.relname in (
        'minimum_age_attestations',
        'location_consents',
        'location_use_facts',
        'location_attempt_tombstones',
        'personal_card_field_object_ledger',
        'location_disclosure_accesses',
        'location_correction_requests',
        'data_erasure_jobs',
        'data_erasure_manifest'
      )
      and relation_row.relrowsecurity
      and relation_row.relforcerowsecurity
  ),
  9::bigint,
  'all compliance source tables enable and force RLS'
);

select is(
  (
    select count(*)::bigint
    from unnest(array[
      'private.minimum_age_attestations',
      'private.location_consents',
      'private.location_use_facts',
      'private.location_attempt_tombstones',
      'private.personal_card_field_object_ledger',
      'private.location_disclosure_accesses',
      'private.location_correction_requests',
      'private.data_erasure_jobs',
      'private.data_erasure_manifest'
    ]) as relation_name
    cross join unnest(array['anon', 'authenticated', 'service_role']) as role_name
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as privilege_name
    where has_table_privilege(role_name, relation_name, privilege_name)
  ),
  0::bigint,
  'browser and service roles have no direct compliance-table privileges'
);

select set_eq(
  $$
    select column_name::text
    from information_schema.columns
    where table_schema = 'private'
      and table_name = 'location_attempt_tombstones'
  $$,
  $$
    values
      ('owner_fingerprint'::text),
      ('attempt_key_fingerprint'::text),
      ('expires_at'::text)
  $$,
  'anti-replay tombstones contain only two one-way digests and bounded expiry'
);

select throws_ok(
  $sql$
    insert into private.location_attempt_tombstones (
      owner_fingerprint, attempt_key_fingerprint, expires_at
    ) values (
      decode(repeat('00', 31), 'hex'),
      decode(repeat('01', 32), 'hex'),
      clock_timestamp() + interval '1 day'
    )
  $sql$,
  '23514',
  null,
  'owner anti-replay fingerprints are exactly 32 bytes'
);

select throws_ok(
  $sql$
    insert into private.location_attempt_tombstones (
      owner_fingerprint, attempt_key_fingerprint, expires_at
    ) values (
      decode(repeat('00', 32), 'hex'),
      decode(repeat('01', 31), 'hex'),
      clock_timestamp() + interval '1 day'
    )
  $sql$,
  '23514',
  null,
  'attempt-key anti-replay fingerprints are exactly 32 bytes'
);

select ok(
  not has_function_privilege(
    'service_role',
    'private.location_attempt_owner_fingerprint(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'private.location_attempt_key_fingerprint(uuid)',
    'EXECUTE'
  ),
  'raw service callers cannot invoke the private tombstone digest helpers'
);

select ok(
  has_function_privilege(
    'service_role',
    'api_private.claim_personal_card_field_object_cleanup(uuid,integer)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'api_private.record_personal_card_field_object_cleanup_result(uuid,bigint,boolean)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'api_private.claim_personal_card_field_object_cleanup(uuid,integer)',
    'EXECUTE'
  ),
  'field object reconciliation is executable only by the service boundary'
);

select ok(
  has_function_privilege(
    'service_role',
    'api_private.claim_data_erasure_jobs(uuid,integer,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'api_private.claim_data_erasure_jobs(uuid,integer,integer)',
    'EXECUTE'
  ),
  'bounded erasure claims are executable only by the service boundary'
);

select ok(
  has_function_privilege(
    'service_role',
    'api_private.record_minimum_age_attestation(uuid,jsonb)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'api_private.record_minimum_age_attestation(uuid,jsonb)',
    'EXECUTE'
  ),
  'minimum-age attestation is reachable only through the server service boundary'
);

select ok(
  has_function_privilege(
    'service_role',
    'api_private.list_location_correction_subjects(uuid,integer,date,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'api_private.list_location_correction_subjects(uuid,integer,date,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'api_private.list_location_correction_subjects(uuid,integer,date,uuid)',
    'EXECUTE'
  ),
  'correction-subject disclosure is executable only by the service boundary'
);

-- Fixtures ---------------------------------------------------------------

insert into auth.users (id, created_at, updated_at, is_anonymous, raw_user_meta_data)
values
  ('a8000000-0000-4000-8000-000000000001', now(), now(), false, '{}'),
  ('a8000000-0000-4000-8000-000000000002', now(), now(), true, '{}'),
  ('a8000000-0000-4000-8000-000000000003', now(), now(), true, '{}'),
  ('a8000000-0000-4000-8000-000000000004', now(), now(), true, '{}'),
  ('a8000000-0000-4000-8000-000000000005', now(), now(), true, '{}'),
  ('a8000000-0000-4000-8000-000000000006', now(), now(), true, '{}'),
  ('a8000000-0000-4000-8000-000000000007', now(), now(), true, '{}'),
  ('a8000000-0000-4000-8000-000000000008', now(), now(), true, '{}'),
  ('a8000000-0000-4000-8000-000000000009', now(), now(), true, '{}'),
  ('a8000000-0000-4000-8000-000000000010', now(), now(), true, '{}'),
  ('a8000000-0000-4000-8000-000000000011', now(), now(), true, '{}'),
  ('a8000000-0000-4000-8000-000000000012', now(), now(), true, '{}'),
  ('a8000000-0000-4000-8000-000000000013', now(), now(), true, '{}'),
  ('a8000000-0000-4000-8000-000000000014', now(), now(), true, '{}'),
  ('a8000000-0000-4000-8000-000000000015', now(), now(), true, '{}'),
  ('a8000000-0000-4000-8000-000000000016', now(), now(), true, '{}'),
  ('a8000000-0000-4000-8000-000000000017', now(), now(), true, '{}'),
  ('a8000000-0000-4000-8000-000000000018', now(), now(), true, '{}');

insert into private.admin_members (auth_user_id)
values ('a8000000-0000-4000-8000-000000000001');

create temp table location_test_users (
  fixture_name text primary key,
  auth_user_id uuid not null,
  user_id uuid not null
) on commit drop;

insert into location_test_users (fixture_name, auth_user_id, user_id)
select fixture.fixture_name, fixture.auth_user_id, identity_row.user_id
from (
  values
    ('admin', 'a8000000-0000-4000-8000-000000000001'::uuid),
    ('owner', 'a8000000-0000-4000-8000-000000000002'::uuid),
    ('legacy', 'a8000000-0000-4000-8000-000000000003'::uuid),
    ('other', 'a8000000-0000-4000-8000-000000000004'::uuid),
    ('correction', 'a8000000-0000-4000-8000-000000000005'::uuid),
    ('claimant_one', 'a8000000-0000-4000-8000-000000000006'::uuid),
    ('target_one', 'a8000000-0000-4000-8000-000000000007'::uuid),
    ('claimant_two', 'a8000000-0000-4000-8000-000000000008'::uuid),
    ('target_two', 'a8000000-0000-4000-8000-000000000009'::uuid),
    ('delayed_withdrawal', 'a8000000-0000-4000-8000-000000000010'::uuid),
    ('recovery_failed', 'a8000000-0000-4000-8000-000000000011'::uuid),
    ('recovery_pending', 'a8000000-0000-4000-8000-000000000012'::uuid),
    ('recovery_consent', 'a8000000-0000-4000-8000-000000000013'::uuid),
    ('recovery_failed_target', 'a8000000-0000-4000-8000-000000000014'::uuid),
    ('recovery_pending_target', 'a8000000-0000-4000-8000-000000000015'::uuid),
    ('recovery_consent_target', 'a8000000-0000-4000-8000-000000000016'::uuid),
    ('recovery_corrected', 'a8000000-0000-4000-8000-000000000017'::uuid),
    ('recovery_corrected_target', 'a8000000-0000-4000-8000-000000000018'::uuid)
) as fixture(fixture_name, auth_user_id)
join private.user_identities as identity_row
  on identity_row.auth_user_id = fixture.auth_user_id
 and identity_row.revoked_at is null;

insert into private.participant_access (user_id, access_kind)
select user_id, 'internal_tester'
from location_test_users
where fixture_name in ('owner', 'correction');

insert into public.regions (code, country_code, sort_order)
values ('location-test', 'KR', 1);

insert into public.region_translations (
  region_code, locale, name, status, approved_at, approved_by
)
select
  'location-test', locale_row.locale, 'Location Test', 'approved', now(),
  'a8000000-0000-4000-8000-000000000001'
from unnest(enum_range(null::public.content_locale)) as locale_row(locale);

insert into public.spots (
  id, slug, region, name_ko, name_en, status, latitude, longitude
)
values (
  'b8000000-0000-4000-8000-000000000001',
  'location-test-spot', 'location-test', '위치 테스트', 'Location Test',
  'draft', 37.5, 127.0
);

insert into public.spot_translations (
  spot_id, locale, name, status, approved_at, approved_by
)
select
  'b8000000-0000-4000-8000-000000000001', locale_row.locale,
  'Location Test', 'approved', now(),
  'a8000000-0000-4000-8000-000000000001'
from unnest(enum_range(null::public.content_locale)) as locale_row(locale);

insert into public.cards (
  id, spot_id, code, kind, title_ko, title_en, sketch_path, color_hex,
  is_published, published_at
)
values (
  'c8000000-0000-4000-8000-000000000001',
  'b8000000-0000-4000-8000-000000000001',
  'location-test-card', 'region', '위치 카드', 'Location Card',
  'cards/location.webp', '#345678', false, null
);

insert into public.card_translations (
  card_id, locale, title, status, approved_at, approved_by
)
select
  'c8000000-0000-4000-8000-000000000001', locale_row.locale,
  'Location Card', 'approved', now(),
  'a8000000-0000-4000-8000-000000000001'
from unnest(enum_range(null::public.content_locale)) as locale_row(locale);

update public.cards
set is_published = true, published_at = now()
where id = 'c8000000-0000-4000-8000-000000000001';

update public.spots
set status = 'open'
where id = 'b8000000-0000-4000-8000-000000000001';

insert into storage.objects (bucket_id, name, owner, version)
values (
  'special-card-assets',
  'location-withdrawal/bonus-special.webp',
  null,
  'location-withdrawal-bonus-special-v1'
);

insert into public.cards (
  id, spot_id, code, kind, title_ko, title_en, sketch_path, color_hex,
  is_published, published_at
) values (
  'c8100000-0000-4000-8000-000000000001',
  'b8000000-0000-4000-8000-000000000001',
  'location-withdrawal-bonus-special',
  'special',
  '위치 철회 특별',
  'Location Withdrawal Special',
  'location-withdrawal/bonus-special.webp',
  '#8866AA',
  false,
  null
);

insert into public.card_translations (
  card_id, locale, title, status, approved_at, approved_by
)
select
  'c8100000-0000-4000-8000-000000000001',
  locale_row.locale,
  'Location Withdrawal Special',
  'approved',
  now(),
  'a8000000-0000-4000-8000-000000000001'
from unnest(enum_range(null::public.content_locale)) as locale_row(locale);

update public.cards
set is_published = true, published_at = now()
where id = 'c8100000-0000-4000-8000-000000000001';

insert into private.bonus_pack_pool_versions (
  id, region_code, version_code
) values (
  'c8200000-0000-4000-8000-000000000001',
  'location-test',
  'location-withdrawal-v1'
);

insert into private.bonus_pack_pool_cards (
  pool_version_id, card_id, rarity, sort_order
) values
  (
    'c8200000-0000-4000-8000-000000000001',
    'c8000000-0000-4000-8000-000000000001',
    'common',
    1
  ),
  (
    'c8200000-0000-4000-8000-000000000001',
    'c8100000-0000-4000-8000-000000000001',
    'special',
    1
  );

update private.bonus_pack_pool_versions
set published_at = clock_timestamp()
where id = 'c8200000-0000-4000-8000-000000000001';

-- Four current policies must each have all six locale documents. --------

insert into private.policy_documents (
  id, policy_type, version, effective_at, published_at, is_current
)
values
  ('d8100000-0000-4000-8000-000000000001', 'terms_of_use', 'location-v1', now() - interval '1 minute', now(), false),
  ('d8100000-0000-4000-8000-000000000002', 'privacy_policy', 'location-v1', now() - interval '1 minute', now(), false),
  ('d8100000-0000-4000-8000-000000000003', 'community_guidelines', 'location-v1', now() - interval '1 minute', now(), false),
  ('d8100000-0000-4000-8000-000000000004', 'location_terms', 'location-v1', now() - interval '1 minute', now(), false);

insert into private.policy_document_locales (
  policy_document_id, locale, document_url, sha256
)
select
  policy_row.id,
  locale_row.locale,
  'https://policies.test/location-v1/' || policy_row.id::text || '/' || locale_row.locale::text,
  extensions.digest(policy_row.id::text || ':' || locale_row.locale::text, 'sha256')
from private.policy_documents as policy_row
cross join unnest(enum_range(null::public.content_locale)) as locale_row(locale)
where policy_row.version = 'location-v1';

select is(
  api_private.set_current_policy_documents(array[
    'd8100000-0000-4000-8000-000000000001'::uuid,
    'd8100000-0000-4000-8000-000000000002'::uuid,
    'd8100000-0000-4000-8000-000000000003'::uuid,
    'd8100000-0000-4000-8000-000000000004'::uuid
  ]),
  '{"status":"switched"}'::jsonb,
  'one complete four-policy set is installed atomically'
);

select is(
  (
    select count(*)::bigint
    from private.policy_documents as document_row
    join private.policy_document_locales as locale_row
      on locale_row.policy_document_id = document_row.id
    where document_row.is_current
  ),
  24::bigint,
  'the current policy set contains four documents times six locales'
);

select is(
  api_private.get_current_policies() ->> 'status',
  'ready',
  'public policy discovery is ready only for the complete 4x6 set'
);

-- Exact minimum-age attestation -----------------------------------------

select is(
  api_private.record_minimum_age_attestation(
    'a8000000-0000-4000-8000-000000000002',
    '{}'::jsonb
  ),
  '{"status":"invalid"}'::jsonb,
  'an empty minimum-age payload is rejected at the service-role RPC boundary'
);

select is(
  api_private.record_minimum_age_attestation(
    'a8000000-0000-4000-8000-000000000002',
    '{"minimum_age_passed":true}'::jsonb
  ),
  '{"status":"invalid"}'::jsonb,
  'minimum-age version is required independently of the Node parser'
);

select is(
  api_private.record_minimum_age_attestation(
    'a8000000-0000-4000-8000-000000000002',
    '{"version":"18plus-v1"}'::jsonb
  ),
  '{"status":"invalid"}'::jsonb,
  'minimum-age pass boolean is required independently of the Node parser'
);

select is(
  api_private.record_minimum_age_attestation(
    'a8000000-0000-4000-8000-000000000002',
    '{"minimum_age_passed":true,"version":null}'::jsonb
  ),
  '{"status":"invalid"}'::jsonb,
  'a JSON-null minimum-age version cannot pass SQL three-valued logic'
);

select is(
  api_private.record_minimum_age_attestation(
    'a8000000-0000-4000-8000-000000000002',
    '{"minimum_age_passed":false,"version":"18plus-v1"}'::jsonb
  ),
  '{"status":"invalid"}'::jsonb,
  'false minimum-age claims are rejected'
);

select is(
  api_private.record_minimum_age_attestation(
    'a8000000-0000-4000-8000-000000000002',
    '{"minimum_age_passed":true,"version":"18plus-v0"}'::jsonb
  ),
  '{"status":"invalid"}'::jsonb,
  'stale minimum-age versions are rejected'
);

select is(
  api_private.record_minimum_age_attestation(
    'a8000000-0000-4000-8000-000000000002',
    '{"minimum_age_passed":true,"version":"18plus-v1","age":18}'::jsonb
  ),
  '{"status":"invalid"}'::jsonb,
  'extra age material is rejected rather than persisted'
);

select is(
  api_private.record_minimum_age_attestation(
    'a8000000-0000-4000-8000-000000000002',
    '{"minimum_age_passed":true,"version":"18plus-v1"}'::jsonb
  ),
  '{"status":"attested"}'::jsonb,
  'the exact true 18plus-v1 payload is accepted'
);

create temp table owner_attestation_time as
select attested_at
from private.minimum_age_attestations
where user_id = (select user_id from location_test_users where fixture_name = 'owner');

select is(
  api_private.record_minimum_age_attestation(
    'a8000000-0000-4000-8000-000000000002',
    '{"minimum_age_passed":true,"version":"18plus-v1"}'::jsonb
  ),
  '{"status":"attested"}'::jsonb,
  'minimum-age attestation retry is idempotent'
);

select is(
  (
    select attestation_row.attested_at
    from private.minimum_age_attestations as attestation_row
    where attestation_row.user_id = (
      select user_id from location_test_users where fixture_name = 'owner'
    )
  ),
  (select attested_at from owner_attestation_time),
  'idempotent minimum-age retry preserves the original server timestamp'
);

select throws_ok(
  $sql$
    insert into private.minimum_age_attestations (
      user_id, minimum_age_passed, version
    ) values (
      (select user_id from location_test_users where fixture_name = 'other'),
      false,
      '18plus-v1'
    )
  $sql$,
  '23514',
  null,
  'the table constraint independently rejects a false attestation'
);

-- Consent lifecycle and privacy-rights split ----------------------------

select is(
  api_private.accept_location_consent(
    'a8000000-0000-4000-8000-000000000004',
    '{"version":"location-v1","locale":"ko"}'::jsonb
  ) ->> 'status',
  'minimum_age_attestation_required',
  'new location collection consent requires the adult attestation'
);

select is(
  api_private.accept_location_consent(
    'a8000000-0000-4000-8000-000000000002',
    '{"version":"location-v1","locale":"ko"}'::jsonb
  ),
  '{"status":"active"}'::jsonb,
  'an adult can accept the exact current location policy snapshot'
);

select is(
  api_private.change_location_consent_state(
    'a8000000-0000-4000-8000-000000000002', 'paused'
  ),
  '{"status":"paused"}'::jsonb,
  'the owner can pause collection without erasing prior records'
);

insert into private.policy_documents (
  id, policy_type, version, effective_at, published_at, is_current
)
values
  ('d8200000-0000-4000-8000-000000000001', 'terms_of_use', 'location-v2', now() - interval '1 minute', now(), false),
  ('d8200000-0000-4000-8000-000000000002', 'privacy_policy', 'location-v2', now() - interval '1 minute', now(), false),
  ('d8200000-0000-4000-8000-000000000003', 'community_guidelines', 'location-v2', now() - interval '1 minute', now(), false),
  ('d8200000-0000-4000-8000-000000000004', 'location_terms', 'location-v2', now() - interval '1 minute', now(), false);

insert into private.policy_document_locales (
  policy_document_id, locale, document_url, sha256
)
select
  policy_row.id,
  locale_row.locale,
  'https://policies.test/location-v2/' || policy_row.id::text || '/' || locale_row.locale::text,
  extensions.digest(policy_row.id::text || ':' || locale_row.locale::text, 'sha256')
from private.policy_documents as policy_row
cross join unnest(enum_range(null::public.content_locale)) as locale_row(locale)
where policy_row.version = 'location-v2';

select is(
  api_private.set_current_policy_documents(array[
    'd8200000-0000-4000-8000-000000000001'::uuid,
    'd8200000-0000-4000-8000-000000000002'::uuid,
    'd8200000-0000-4000-8000-000000000003'::uuid,
    'd8200000-0000-4000-8000-000000000004'::uuid
  ]),
  '{"status":"switched"}'::jsonb,
  'the next complete policy set rotates atomically'
);

select is(
  api_private.accept_location_consent(
    'a8000000-0000-4000-8000-000000000002',
    '{"version":"location-v2","locale":"en"}'::jsonb
  ),
  '{"status":"paused"}'::jsonb,
  'accepting a rotated policy does not silently resume a paused user'
);

select is(
  (
    select consent_row.state::text
    from private.location_consents as consent_row
    where consent_row.user_id = (
      select user_id from location_test_users where fixture_name = 'owner'
    )
  ),
  'paused',
  'policy rotation preserves the explicit pause in storage'
);

select is(
  api_private.change_location_consent_state(
    'a8000000-0000-4000-8000-000000000002', 'active'
  ),
  '{"status":"active"}'::jsonb,
  'only the explicit resume mutation lifts the pause'
);

-- A legacy/no-age subject can exercise access, correction, and withdrawal.
insert into private.location_use_facts (
  user_id, idempotency_key, spot_id, purpose, collected_at, decided_at, outcome,
  terminal_failure_code, terminal_failure_details
)
values (
  (select user_id from location_test_users where fixture_name = 'legacy'),
  'e8000000-0000-4000-8000-000000000001',
  'b8000000-0000-4000-8000-000000000001',
  'field_acquisition', now() - interval '1 day', now() - interval '1 day', 'failed',
  'GATE_CLOSED', '{}'::jsonb
);

select throws_ok(
  $sql$
    insert into private.location_use_facts (
      user_id, idempotency_key, spot_id, purpose,
      collected_at, decided_at, outcome
    ) values (
      (select user_id from location_test_users where fixture_name = 'legacy'),
      'e8000000-0000-4000-8000-000000000011',
      'b8000000-0000-4000-8000-000000000001',
      'field_acquisition', now(), now(), 'failed'
    )
  $sql$,
  '23514',
  null,
  'a failed location fact cannot omit its bounded terminal failure code'
);

select throws_ok(
  $sql$
    insert into private.location_use_facts (
      user_id, idempotency_key, spot_id, purpose,
      collected_at, decided_at, outcome,
      terminal_failure_code, terminal_failure_details
    ) values (
      (select user_id from location_test_users where fixture_name = 'legacy'),
      'e8000000-0000-4000-8000-000000000012',
      'b8000000-0000-4000-8000-000000000001',
      'field_acquisition', now(), now(), 'failed',
      'OUT_OF_RANGE', '{}'::jsonb
    )
  $sql$,
  '23514',
  null,
  'OUT_OF_RANGE requires one allowlisted coarse distance band'
);

select throws_ok(
  $sql$
    insert into private.location_use_facts (
      user_id, idempotency_key, spot_id, purpose,
      collected_at, decided_at, outcome,
      terminal_failure_code, terminal_failure_details
    ) values (
      (select user_id from location_test_users where fixture_name = 'legacy'),
      'e8000000-0000-4000-8000-000000000013',
      'b8000000-0000-4000-8000-000000000001',
      'field_acquisition', now(), now(), 'failed',
      'LOW_ACCURACY', '{"retry":false}'::jsonb
    )
  $sql$,
  '23514',
  null,
  'LOW_ACCURACY accepts only the fixed retry true detail'
);

select is(
  api_private.list_location_use_facts(
    'a8000000-0000-4000-8000-000000000003', 50, null, null
  ) ->> 'status',
  'ready',
  'privacy disclosure requires only an active service identity, not age'
);

select is(
  (
    select count(*)::bigint
    from private.location_disclosure_accesses
    where user_id = (select user_id from location_test_users where fixture_name = 'legacy')
  ),
  1::bigint,
  'each disclosure records only a bounded access audit row'
);

select is(
  api_private.list_location_use_facts(
    'a8000000-0000-4000-8000-000000000003', 50, null, null
  ) #> '{items,0,failure}',
  '{"code":"GATE_CLOSED","details":{}}'::jsonb,
  'failed disclosure includes the exact bounded terminal reason retained by the ledger'
);

insert into private.location_use_facts (
  user_id, idempotency_key, spot_id, purpose, collected_at, outcome
)
values (
  (select user_id from location_test_users where fixture_name = 'correction'),
  'e8000000-0000-4000-8000-000000000014',
  'b8000000-0000-4000-8000-000000000001',
  'field_acquisition', now() - interval '2 hours', 'pending'
);

insert into private.location_use_facts (
  user_id, idempotency_key, spot_id, purpose,
  collected_at, decided_at, outcome
)
values (
  (select user_id from location_test_users where fixture_name = 'correction'),
  'e8000000-0000-4000-8000-000000000015',
  'b8000000-0000-4000-8000-000000000001',
  'field_acquisition', now() - interval '3 hours', now() - interval '3 hours', 'passed'
);

select ok(
  (
    select bool_and(item_row.item -> 'failure' = 'null'::jsonb)
    from jsonb_array_elements(
      api_private.list_location_use_facts(
        'a8000000-0000-4000-8000-000000000005', 50, null, null
      ) -> 'items'
    ) as item_row(item)
  ),
  'pending and passed disclosures expose an explicit null failure payload'
);

delete from private.location_use_facts
where user_id = (select user_id from location_test_users where fixture_name = 'correction')
  and idempotency_key in (
    'e8000000-0000-4000-8000-000000000014',
    'e8000000-0000-4000-8000-000000000015'
  );

delete from private.location_disclosure_accesses
where user_id = (select user_id from location_test_users where fixture_name = 'correction');

select is(
  api_private.create_location_correction_request(
    'a8000000-0000-4000-8000-000000000003',
    (
      select id from private.location_use_facts
      where user_id = (select user_id from location_test_users where fixture_name = 'legacy')
    ),
    null,
    'e8000000-0000-4000-8000-000000000002',
    'not_my_visit'
  ) ->> 'status',
  'created',
  'a no-age legacy subject can request correction'
);

select is(
  api_private.create_location_correction_request(
    'a8000000-0000-4000-8000-000000000003',
    (
      select id from private.location_use_facts
      where user_id = (select user_id from location_test_users where fixture_name = 'legacy')
    ),
    null,
    'e8000000-0000-4000-8000-000000000003',
    'wrong_spot'
  ) ->> 'status',
  'duplicate',
  'one open or pending correction per fact bounds correction abuse'
);

select is(
  api_private.request_location_withdrawal(
    'a8000000-0000-4000-8000-000000000003'
  ) ->> 'status',
  'location_withdrawal_pending',
  'legacy data withdrawal is not conditioned on a new policy consent or age gate'
);

-- A no-storage legacy withdrawal can complete immediately.
select is(
  (
    api_private.claim_data_erasure_jobs(
      'f8000000-0000-4000-8000-000000000001', 2, 4
    ) #>> '{jobs,0,scope}'
  ),
  'location_withdrawal',
  'the legacy withdrawal is claimed by the erasure worker'
);

select is(
  api_private.finish_data_erasure_job(
    'f8000000-0000-4000-8000-000000000001',
    (
      select id from private.data_erasure_jobs
      where user_id = (select user_id from location_test_users where fixture_name = 'legacy')
        and scope = 'location_withdrawal'
    )
  ),
  '{"status":"completed"}'::jsonb,
  'legacy no-storage withdrawal completes database erasure'
);

select is(
  (
    select count(*)::bigint
    from private.location_use_facts
    where user_id = (select user_id from location_test_users where fixture_name = 'legacy')
  ) + (
    select count(*)::bigint
    from private.location_disclosure_accesses
    where user_id = (select user_id from location_test_users where fixture_name = 'legacy')
  ) + (
    select count(*)::bigint
    from private.location_correction_requests
    where user_id = (select user_id from location_test_users where fixture_name = 'legacy')
  ),
  0::bigint,
  'withdrawal leaves no subject-linked fact, disclosure, or correction record'
);

-- Targeted correction is an actual two-phase erasure --------------------

select is(
  api_private.record_minimum_age_attestation(
    'a8000000-0000-4000-8000-000000000005',
    '{"minimum_age_passed":true,"version":"18plus-v1"}'::jsonb
  ),
  '{"status":"attested"}'::jsonb,
  'the correction fixture records an adult attestation'
);

select is(
  api_private.accept_location_consent(
    'a8000000-0000-4000-8000-000000000005',
    '{"version":"location-v2","locale":"vi"}'::jsonb
  ),
  '{"status":"active"}'::jsonb,
  'the correction fixture records current active location consent'
);

select is(
  api_private.acquire_context_unrated(
    'a8000000-0000-4000-8000-000000000005',
    'b8000000-0000-4000-8000-000000000001',
    'e8500000-0000-4000-8000-000000000001',
    true
  ) ->> 'status',
  'ready',
  'acquire context creates one bounded pending location fact'
);

select is(
  api_private.acquire_commit_unrated(
    'a8000000-0000-4000-8000-000000000005',
    'b8000000-0000-4000-8000-000000000001',
    'e8500000-0000-4000-8000-000000000001',
    true,
    (
      select updated_at from public.spots
      where id = 'b8000000-0000-4000-8000-000000000001'
    )
  ) ->> 'status',
  'created',
  'acquire commit records a field acquisition and passes the same fact'
);

select is(
  (
    select fact_row.outcome::text
    from private.location_use_facts as fact_row
    where fact_row.user_id = (
      select user_id from location_test_users where fixture_name = 'correction'
    )
      and fact_row.idempotency_key = 'e8500000-0000-4000-8000-000000000001'
  ),
  'passed',
  'the committed fact has a server-decided passed outcome'
);

select is(
  (
    select count(*)::bigint
    from analytics.events as event_row
    join private.location_use_facts as fact_row
      on fact_row.id = event_row.location_use_fact_id
    join public.acquisitions as acquisition_row
      on acquisition_row.user_id = fact_row.user_id
     and acquisition_row.idempotency_key = fact_row.idempotency_key
     and acquisition_row.spot_id = fact_row.spot_id
     and acquisition_row.acquired_at = event_row.occurred_at
    where fact_row.idempotency_key = 'e8500000-0000-4000-8000-000000000001'
      and event_row.event_name = 'acquire_success'
      and event_row.source = 'server'
  ),
  1::bigint,
  'acquire commit leaves exactly one terminal event correlated to its exact acquisition fact'
);

update analytics.events as event_row
set location_use_fact_id = null
where event_row.location_use_fact_id = (
  select fact_row.id
  from private.location_use_facts as fact_row
  where fact_row.idempotency_key = 'e8500000-0000-4000-8000-000000000001'
);

select ok(
  (
    select event_row.location_use_fact_id is not null
    from analytics.events as event_row
    join private.location_use_facts as fact_row
      on fact_row.id = event_row.location_use_fact_id
    where fact_row.idempotency_key = 'e8500000-0000-4000-8000-000000000001'
  ),
  'server acquire_success UPDATE cannot clear its exact fact correlation'
);

select throws_ok(
  $sql$
    insert into public.acquisitions (
      user_id, spot_id, card_id, acquisition_type, verification_result,
      idempotency_key, field_sequence, acquired_at
    ) values (
      (select user_id from location_test_users where fixture_name = 'target_one'),
      'b8000000-0000-4000-8000-000000000001',
      'c8000000-0000-4000-8000-000000000001',
      'field', 'passed', 'e8500000-0000-4000-8000-000000000099', 999999,
      now() + interval '2 days'
    )
  $sql$,
  '23514',
  'field acquisition requires one exact pending location fact',
  'post-cutover field acquisition without a context fact fails closed'
);

select throws_ok(
  $sql$
    insert into analytics.events (
      user_id, event_name, source, occurred_at, spot_id, properties
    ) values (
      (select user_id from location_test_users where fixture_name = 'target_one'),
      'acquire_success', 'server', now() + interval '20 years',
      'b8000000-0000-4000-8000-000000000001',
      '{"spot_id":"b8000000-0000-4000-8000-000000000001"}'::jsonb
    )
  $sql$,
  '23514',
  'server acquire success requires one exact location fact',
  'server acquire_success without an exact acquisition fact is rejected'
);

-- Unrelated gift/card/event data must survive the targeted correction.
insert into public.acquisitions (
  id, user_id, spot_id, card_id, acquisition_type, verification_result,
  idempotency_key, field_sequence, acquired_at
)
values (
  'e8500000-0000-4000-8000-000000000010',
  (select user_id from location_test_users where fixture_name = 'correction'),
  'b8000000-0000-4000-8000-000000000001',
  'c8000000-0000-4000-8000-000000000001',
  'gift', 'not_applicable',
  'e8500000-0000-4000-8000-000000000011', null,
  now() - interval '2 days'
);

insert into public.personal_cards (
  id, user_id, acquisition_id, photo_path, caption
)
values (
  'f8500000-0000-4000-8000-000000000010',
  (select user_id from location_test_users where fixture_name = 'correction'),
  'e8500000-0000-4000-8000-000000000010',
  (select user_id::text from location_test_users where fixture_name = 'correction') ||
    '/gift-preserved.webp',
  'gift preserved'
);

insert into analytics.events (
  user_id, event_name, source, occurred_at, properties, personal_card_id
)
values (
  (select user_id from location_test_users where fixture_name = 'correction'),
  'personal_card_created', 'server', now() - interval '2 days', '{}',
  'f8500000-0000-4000-8000-000000000010'
);

select is(
  api_private.accept_current_policies(
    'a8000000-0000-4000-8000-000000000005',
    jsonb_build_array(
      jsonb_build_object(
        'type', 'terms_of_use', 'version', 'location-v2', 'locale', 'ko'
      ),
      jsonb_build_object(
        'type', 'community_guidelines', 'version', 'location-v2', 'locale', 'ko'
      )
    )
  ),
  '{"status":"accepted"}'::jsonb,
  'the field-object fixture accepts the current UGC policy pair'
);

-- A field promotion registers both Storage paths before any external I/O.
-- Releasing an uncommitted/ambiguous attempt must not erase either binding,
-- and the same temp upload remains retryable until its ten-minute promotion
-- window ends.
with fixture_time as (
  select clock_timestamp() as issued_at
)
insert into private.personal_card_temp_uploads (
  id, user_id, temp_path, declared_content_type, declared_size_bytes,
  issued_at, promotion_expires_at, signed_url_expires_at
)
select
  'e8500000-0000-4000-8000-000000000060',
  (select user_id from location_test_users where fixture_name = 'correction'),
  (select user_id::text from location_test_users where fixture_name = 'correction') ||
    '/e8500000-0000-4000-8000-000000000060.jpg',
  'image/jpeg', 1234,
  fixture_time.issued_at,
  fixture_time.issued_at + interval '10 minutes',
  fixture_time.issued_at + interval '2 hours'
from fixture_time;

select is(
  api_private.begin_personal_card_promotion(
    'a8000000-0000-4000-8000-000000000005', true,
    (
      select id from public.acquisitions
      where user_id = (select user_id from location_test_users where fixture_name = 'correction')
        and idempotency_key = 'e8500000-0000-4000-8000-000000000001'
    ),
    (select user_id::text from location_test_users where fixture_name = 'correction') ||
      '/e8500000-0000-4000-8000-000000000060.jpg',
    'ambiguous upload',
    'e8500000-0000-4000-8000-000000000061'
  ) ->> 'status',
  'ready',
  'field begin durably registers both paths before Storage upload'
);

select is(
  (
    select count(*)::bigint
    from private.personal_card_field_object_ledger
    where processing_token = 'e8500000-0000-4000-8000-000000000061'
  ),
  2::bigint,
  'one field begin records the temp and permanent object paths'
);

select throws_ok(
  $sql$
    update private.personal_card_field_object_ledger
    set final_delete_not_before = clock_timestamp()
    where processing_token = 'e8500000-0000-4000-8000-000000000061'
      and bucket = 'personal-cards'
  $sql$,
  '23514',
  null,
  'permanent ledger rejects a final boundary before processing expiry plus ten minutes'
);

select is(
  api_private.release_personal_card_promotion(
    'e8500000-0000-4000-8000-000000000060',
    'e8500000-0000-4000-8000-000000000061'
  ) ->> 'status',
  'updated',
  'ambiguous uncommitted completion may release its transient processing lease'
);

select is(
  api_private.claim_personal_card_field_object_cleanup(
    'f8500000-0000-4000-8000-000000000060', 4
  ) #>> '{items,0,bucket}',
  'personal-cards',
  'reconciliation may claim the abandoned permanent path immediately'
);

select is(
  (
    select count(*)::bigint
    from jsonb_array_elements(
      api_private.claim_personal_card_field_object_cleanup(
        'f8500000-0000-4000-8000-000000000061', 4
      ) -> 'items'
    ) as item_row(item)
    where item_row.item ->> 'bucket' = 'personal-card-temp'
  ),
  0::bigint,
  'reconciliation cannot claim a temp path before the promotion retry window expires'
);

select is(
  api_private.begin_personal_card_promotion(
    'a8000000-0000-4000-8000-000000000005', true,
    (
      select id from public.acquisitions
      where user_id = (select user_id from location_test_users where fixture_name = 'correction')
        and idempotency_key = 'e8500000-0000-4000-8000-000000000001'
    ),
    (select user_id::text from location_test_users where fixture_name = 'correction') ||
      '/e8500000-0000-4000-8000-000000000060.jpg',
    'ambiguous upload',
    'e8500000-0000-4000-8000-000000000062'
  ) ->> 'status',
  'ready',
  'a new token can retry the same temp path before promotion expiry'
);

select is(
  api_private.release_personal_card_promotion(
    'e8500000-0000-4000-8000-000000000060',
    'e8500000-0000-4000-8000-000000000062'
  ) ->> 'status',
  'updated',
  'the retried ambiguous attempt also preserves its durable object bindings'
);

select is(
  api_private.record_personal_card_field_object_cleanup_result(
    'f8500000-0000-4000-8000-000000000060',
    (
      select id
      from private.personal_card_field_object_ledger
      where processing_token = 'e8500000-0000-4000-8000-000000000061'
        and bucket = 'personal-cards'
    ),
    true
  ) ->> 'status',
  'recorded',
  'the first permanent-object deletion schedules a separate final pass'
);

select ok(
  (
    select ledger_row.final_delete_after >= ledger_row.final_delete_not_before
      and ledger_row.final_delete_after >=
        ledger_row.first_deleted_at + interval '10 minutes'
    from private.personal_card_field_object_ledger as ledger_row
    where ledger_row.processing_token = 'e8500000-0000-4000-8000-000000000061'
      and ledger_row.bucket = 'personal-cards'
  ),
  'permanent first deletion schedules a separate ten-minute final boundary'
);

select is(
  (api_private.get_location_compliance_backlog()
    ->> 'overdue_object_reconciliations')::integer,
  0,
  'a first-deleted object waiting for its future final boundary is not overdue'
);

-- Keep the retried token-62 bindings available for the targeted correction.
-- A separate already-expired upload exercises the overdue/final-pass path;
-- cleanup_pending paths are never rebound as active processing sources.
update private.personal_card_field_object_ledger
set next_attempt_at = clock_timestamp() + interval '1 hour'
where processing_token = 'e8500000-0000-4000-8000-000000000062';

with fixture_time as (
  select clock_timestamp() - interval '5 hours' as issued_at
)
insert into private.personal_card_temp_uploads (
  id, user_id, temp_path, declared_content_type, declared_size_bytes,
  issued_at, promotion_expires_at, signed_url_expires_at
)
select
  'e8500000-0000-4000-8000-000000000070',
  (select user_id from location_test_users where fixture_name = 'correction'),
  (select user_id::text from location_test_users where fixture_name = 'correction') ||
    '/e8500000-0000-4000-8000-000000000070.jpg',
  'image/jpeg', 4321,
  fixture_time.issued_at,
  fixture_time.issued_at + interval '10 minutes',
  fixture_time.issued_at + interval '2 hours'
from fixture_time;

update private.personal_card_temp_uploads as upload_row
set processing_token = 'e8500000-0000-4000-8000-000000000071',
    processing_started_at = upload_row.issued_at + interval '1 minute',
    processing_expires_at = upload_row.issued_at + interval '5 minutes',
    processing_acquisition_id = (
      select id from public.acquisitions
      where user_id = (select user_id from location_test_users where fixture_name = 'correction')
        and idempotency_key = 'e8500000-0000-4000-8000-000000000001'
    ),
    processing_permanent_path =
      upload_row.user_id::text || '/e8500000-0000-4000-8000-000000000071.webp',
    processing_caption = 'expired standalone cleanup'
where upload_row.id = 'e8500000-0000-4000-8000-000000000070';

select is(
  api_private.release_personal_card_promotion(
    'e8500000-0000-4000-8000-000000000070',
    'e8500000-0000-4000-8000-000000000071'
  ) ->> 'status',
  'updated',
  'the dedicated expired fixture releases its processing source before cleanup'
);

select is(
  jsonb_array_length(
    api_private.claim_personal_card_field_object_cleanup(
      'f8500000-0000-4000-8000-000000000070', 4
    ) -> 'items'
  ),
  2,
  'the dedicated expired fixture claims both object paths for a first pass'
);

do $standalone_first_pass$
declare
  ledger_row record;
  v_result jsonb;
begin
  for ledger_row in
    select id
    from private.personal_card_field_object_ledger
    where processing_token = 'e8500000-0000-4000-8000-000000000071'
    order by id
  loop
    v_result := api_private.record_personal_card_field_object_cleanup_result(
      'f8500000-0000-4000-8000-000000000070',
      ledger_row.id,
      true
    );
    if v_result <> '{"status":"recorded"}'::jsonb then
      raise exception 'unexpected standalone first-pass result: %', v_result;
    end if;
  end loop;
end
$standalone_first_pass$;

update private.personal_card_field_object_ledger
set first_deleted_at = clock_timestamp() - interval '2 hours 30 minutes',
    final_delete_after = clock_timestamp() - interval '2 hours',
    next_attempt_at = clock_timestamp() - interval '2 hours'
where processing_token = 'e8500000-0000-4000-8000-000000000071'
  and bucket = 'personal-cards';

select is(
  (api_private.get_location_compliance_backlog()
    ->> 'overdue_object_reconciliations')::integer,
  1,
  'an unleased standalone object more than one hour past its effective due time is overdue'
);

select is(
  api_private.claim_personal_card_field_object_cleanup(
    'f8500000-0000-4000-8000-000000000071', 4
  ) #>> '{items,0,phase}',
  'final',
  'the permanent orphan is offered for final deletion only in a later cycle'
);

select is(
  api_private.record_personal_card_field_object_cleanup_result(
    'f8500000-0000-4000-8000-000000000071',
    (
      select id
      from private.personal_card_field_object_ledger
      where processing_token = 'e8500000-0000-4000-8000-000000000071'
        and bucket = 'personal-cards'
    ),
    true
  ) ->> 'status',
  'completed',
  'the permanent orphan ledger clears only after final Storage deletion succeeds'
);

update private.personal_card_field_object_ledger
set first_deleted_at = clock_timestamp() - interval '2 hours 30 minutes',
    final_delete_after = clock_timestamp() - interval '2 hours',
    next_attempt_at = clock_timestamp() - interval '2 hours'
where processing_token = 'e8500000-0000-4000-8000-000000000071'
  and bucket = 'personal-card-temp';

select is(
  api_private.claim_personal_card_field_object_cleanup(
    'f8500000-0000-4000-8000-000000000072', 4
  ) #>> '{items,0,phase}',
  'final',
  'the dedicated temp orphan also reaches its later final pass'
);

select is(
  api_private.record_personal_card_field_object_cleanup_result(
    'f8500000-0000-4000-8000-000000000072',
    (
      select id
      from private.personal_card_field_object_ledger
      where processing_token = 'e8500000-0000-4000-8000-000000000071'
        and bucket = 'personal-card-temp'
    ),
    true
  ) ->> 'status',
  'completed',
  'the dedicated expired fixture leaves no temp Storage ledger orphan'
);

select is(
  (
    select count(*)::bigint
    from private.personal_card_field_object_ledger
    where processing_token = 'e8500000-0000-4000-8000-000000000071'
  ),
  0::bigint,
  'the dedicated overdue fixture is fully reconciled before correction starts'
);

-- The ambiguous upload path must be exercised before an existing card turns
-- begin into an idempotent already_created response. Add the disputed card
-- only after standalone reconciliation, so targeted correction still proves
-- exact card/photo erasure together with the released token-62 bindings.
insert into public.personal_cards (
  id, user_id, acquisition_id, photo_path, caption
)
select
  'f8500000-0000-4000-8000-000000000001',
  acquisition_row.user_id,
  acquisition_row.id,
  acquisition_row.user_id::text || '/correction-field.webp',
  'field correction'
from public.acquisitions as acquisition_row
where acquisition_row.user_id = (
    select user_id from location_test_users where fixture_name = 'correction'
  )
  and acquisition_row.idempotency_key = 'e8500000-0000-4000-8000-000000000001';

select is(
  api_private.create_location_correction_request(
    'a8000000-0000-4000-8000-000000000005',
    (
      select id from private.location_use_facts
      where user_id = (select user_id from location_test_users where fixture_name = 'correction')
        and idempotency_key = 'e8500000-0000-4000-8000-000000000001'
    ),
    null,
    'e8500000-0000-4000-8000-000000000002',
    'wrong_spot'
  ) ->> 'status',
  'created',
  'the subject opens a bounded correction request for the exact fact'
);

create temp table correction_request_fixture as
select id
from private.location_correction_requests
where user_id = (select user_id from location_test_users where fixture_name = 'correction')
  and client_request_id = 'e8500000-0000-4000-8000-000000000002';

create temp table correction_attempt_fixture as
select
  fact_row.id as fact_id,
  acquisition_row.id as acquisition_id,
  acquisition_row.acquired_at
from private.location_use_facts as fact_row
join public.acquisitions as acquisition_row
  on acquisition_row.user_id = fact_row.user_id
 and acquisition_row.idempotency_key = fact_row.idempotency_key
 and acquisition_row.spot_id = fact_row.spot_id
where fact_row.user_id = (
    select user_id from location_test_users where fixture_name = 'correction'
  )
  and fact_row.idempotency_key = 'e8500000-0000-4000-8000-000000000001';

select is(
  api_private.resolve_location_correction_admin(
    'a8000000-0000-4000-8000-000000000001',
    (select id from correction_request_fixture),
    'accepted'
  ) ->> 'status',
  'correction_pending',
  'admin acceptance schedules real erasure instead of falsely marking corrected'
);

select is(
  (
    select status::text
    from private.location_correction_requests
    where id = (select id from correction_request_fixture)
  ),
  'approved_pending_correction',
  'the request remains pending until the erasure worker finishes'
);

select is(
  api_private.begin_personal_card_promotion(
    'a8000000-0000-4000-8000-000000000005', true,
    (
      select id from public.acquisitions
      where user_id = (select user_id from location_test_users where fixture_name = 'correction')
        and idempotency_key = 'e8500000-0000-4000-8000-000000000001'
    ),
    'missing/temp.jpg', '', 'e8500000-0000-4000-8000-000000000003'
  ) ->> 'status',
  'location_correction_pending',
  'pending correction blocks new promotion derivatives before any upload lookup'
);

select is(
  api_private.acquire_context_unrated(
    'a8000000-0000-4000-8000-000000000005',
    'b8000000-0000-4000-8000-000000000001',
    'e8500000-0000-4000-8000-000000000001',
    true
  ) ->> 'code',
  'LOCATION_CORRECTION_PENDING',
  'approved correction blocks same-key context replay without changing outcome'
);

select is(
  (
    select outcome::text
    from private.location_use_facts
    where user_id = (select user_id from location_test_users where fixture_name = 'correction')
      and idempotency_key = 'e8500000-0000-4000-8000-000000000001'
  ),
  'passed',
  'blocked replay preserves the disputed fact outcome'
);

create temp table correction_job_fixture as
select id
from private.data_erasure_jobs
where correction_request_id = (select id from correction_request_fixture);

select is(
  (
    select count(*)::bigint
    from private.data_erasure_manifest as item_row
    where item_row.job_id = (select id from correction_job_fixture)
      and item_row.object_path in (
        select ledger_row.object_path
        from private.personal_card_field_object_ledger as ledger_row
        where ledger_row.processing_token = 'e8500000-0000-4000-8000-000000000062'
      )
  ),
  2::bigint,
  'targeted correction snapshots both durable temp and permanent bindings after release'
);

update private.personal_card_field_object_ledger
set next_attempt_at = clock_timestamp() - interval '2 hours'
where processing_token = 'e8500000-0000-4000-8000-000000000062';

select is(
  (api_private.get_location_compliance_backlog()
    ->> 'overdue_object_reconciliations')::integer,
  0,
  'object paths owned by an unfinished erasure manifest use the erasure-job SLA instead'
);

select ok(
  exists (
    select 1
    from private.data_erasure_manifest as item_row
    join private.personal_card_temp_uploads as upload_row
      on upload_row.temp_path = item_row.object_path
    where item_row.job_id = (select id from correction_job_fixture)
      and item_row.bucket = 'personal-card-temp'
      and item_row.final_delete_after >=
        upload_row.signed_url_expires_at + interval '10 minutes'
  ),
  'released temp binding remains scheduled through signed URL expiry plus ten minutes'
);

select is(
  api_private.claim_data_erasure_jobs(
    'f8500000-0000-4000-8000-000000000001', 2, 4
  ) #>> '{jobs,0,items,0,phase}',
  'first',
  'targeted correction first claims the initial Storage deletion phase'
);

do $worker$
declare
  item_row record;
  v_result jsonb;
begin
  for item_row in
    select id
    from private.data_erasure_manifest
    where job_id = (select id from correction_job_fixture)
      and deleted_at is null
    order by id
  loop
    v_result := api_private.record_data_erasure_item_result(
      'f8500000-0000-4000-8000-000000000001',
      (select id from correction_job_fixture),
      item_row.id,
      true
    );
    if v_result <> '{"status":"recorded"}'::jsonb then
      raise exception 'unexpected targeted first-phase result: %', v_result;
    end if;
  end loop;
end
$worker$;

select ok(
  not exists (
    select 1 from private.data_erasure_manifest
    where job_id = (select id from correction_job_fixture)
      and first_deleted_at is null
  ),
  'every targeted object records its first Storage deletion result'
);

select is(
  api_private.finish_data_erasure_job(
    'f8500000-0000-4000-8000-000000000001',
    (select id from correction_job_fixture)
  ),
  '{"status":"retry"}'::jsonb,
  'database correction waits for a later final Storage deletion cycle'
);

select ok(
  (
    select item_row.deleted_at is null
      and item_row.final_delete_after >= item_row.first_deleted_at + interval '10 minutes'
    from private.data_erasure_manifest as item_row
    where item_row.job_id = (select id from correction_job_fixture)
    order by item_row.id limit 1
  ),
  'first deletion pushes the final-delete boundary at least ten minutes forward'
);

update private.data_erasure_manifest
set first_deleted_at = clock_timestamp() - interval '11 minutes',
    final_delete_after = clock_timestamp() - interval '1 second'
where job_id = (select id from correction_job_fixture);
update private.data_erasure_jobs
set next_attempt_at = clock_timestamp() - interval '1 second'
where id = (select id from correction_job_fixture);

select is(
  api_private.claim_data_erasure_jobs(
    'f8500000-0000-4000-8000-000000000002', 2, 4
  ) #>> '{jobs,0,items,0,phase}',
  'final',
  'the final Storage deletion is offered only in a later worker cycle'
);

do $worker$
declare
  item_row record;
  v_result jsonb;
begin
  for item_row in
    select id
    from private.data_erasure_manifest
    where job_id = (select id from correction_job_fixture)
      and deleted_at is null
    order by id
  loop
    v_result := api_private.record_data_erasure_item_result(
      'f8500000-0000-4000-8000-000000000002',
      (select id from correction_job_fixture),
      item_row.id,
      true
    );
    if v_result <> '{"status":"recorded"}'::jsonb then
      raise exception 'unexpected targeted final-phase result: %', v_result;
    end if;
  end loop;
end
$worker$;

select ok(
  not exists (
    select 1 from private.data_erasure_manifest
    where job_id = (select id from correction_job_fixture)
      and deleted_at is null
  ),
  'every targeted object records its final Storage deletion result'
);

select is(
  (api_private.get_location_compliance_backlog()
    ->> 'overdue_object_reconciliations')::integer,
  0,
  'an unfinished erasure job owns its paths through database finalization'
);

-- Simulate a Storage outage longer than the original retention window. The
-- expired marker may purge while the correction is still protected by its
-- locked subject; completion must recreate a fresh six-month anti-replay TTL.
update private.location_attempt_tombstones
set expires_at = clock_timestamp() - interval '1 second'
where owner_fingerprint = private.location_attempt_owner_fingerprint(
    (select user_id from location_test_users where fixture_name = 'correction')
  )
  and attempt_key_fingerprint = private.location_attempt_key_fingerprint(
    'e8500000-0000-4000-8000-000000000001'
  );

select is(
  api_private.purge_expired_location_compliance_records(5000)
    ->> 'attempt_tombstones_deleted',
  '1',
  'maintenance purges an expired anonymous anti-replay marker'
);

select is(
  api_private.finish_data_erasure_job(
    'f8500000-0000-4000-8000-000000000002',
    (select id from correction_job_fixture)
  ),
  '{"status":"completed"}'::jsonb,
  'targeted correction completes only after actual data erasure'
);

select is(
  (
    select count(*)::bigint
    from private.personal_card_field_object_ledger
    where user_id = (select user_id from location_test_users where fixture_name = 'correction')
  ),
  0::bigint,
  'targeted completion removes every identifying object binding after both deletion passes'
);

select ok(
  exists (
    select 1
    from private.location_attempt_tombstones as tombstone_row
    where tombstone_row.owner_fingerprint = private.location_attempt_owner_fingerprint(
        (select user_id from location_test_users where fixture_name = 'correction')
      )
      and tombstone_row.attempt_key_fingerprint =
        private.location_attempt_key_fingerprint(
          'e8500000-0000-4000-8000-000000000001'
        )
      and tombstone_row.expires_at > clock_timestamp() + interval '5 months'
  ),
  'actual correction completion rebases anti-replay retention by six months'
);

select is(
  api_private.acquire_context_unrated(
    'a8000000-0000-4000-8000-000000000005',
    'b8000000-0000-4000-8000-000000000001',
    'e8500000-0000-4000-8000-000000000001',
    true
  ) ->> 'code',
  'IDEMPOTENCY_CONFLICT',
  'corrected same-key context cannot recreate the erased fact'
);

select is(
  api_private.acquire_commit_unrated(
    'a8000000-0000-4000-8000-000000000005',
    'b8000000-0000-4000-8000-000000000001',
    'e8500000-0000-4000-8000-000000000001',
    true,
    (select updated_at from public.spots where id = 'b8000000-0000-4000-8000-000000000001')
  ) ->> 'code',
  'IDEMPOTENCY_CONFLICT',
  'corrected same-key commit cannot recreate the erased acquisition'
);

select is(
  api_private.record_acquire_failure_unrated(
    'a8000000-0000-4000-8000-000000000005',
    'b8000000-0000-4000-8000-000000000001',
    'e8500000-0000-4000-8000-000000000001',
    'OUT_OF_RANGE',
    '{"distance_band":"near"}'::jsonb
  ) ->> 'code',
  'IDEMPOTENCY_CONFLICT',
  'corrected same-key failure cannot recreate terminal telemetry'
);

select is(
  (
    select status::text
    from private.location_correction_requests
    where id = (select id from correction_request_fixture)
  ),
  'corrected',
  'the correction becomes corrected only after worker completion'
);

select is(
  (
    select count(*)::bigint
    from private.data_erasure_manifest
    where job_id = (select id from correction_job_fixture)
  ),
  0::bigint,
  'completed correction receipt retains no identifying Storage path'
);

select is(
  (
    select count(*)::bigint
    from public.acquisitions
    where user_id = (select user_id from location_test_users where fixture_name = 'correction')
      and acquisition_type = 'field'
  ) + (
    select count(*)::bigint
    from private.location_use_facts
    where user_id = (select user_id from location_test_users where fixture_name = 'correction')
      and idempotency_key = 'e8500000-0000-4000-8000-000000000001'
  ) + (
    select count(*)::bigint
    from public.personal_cards
    where id = 'f8500000-0000-4000-8000-000000000001'
  ) + (
    select count(*)::bigint
    from private.personal_card_temp_uploads
    where id = 'e8500000-0000-4000-8000-000000000060'
  ) + (
    select count(*)::bigint
    from analytics.events
    where location_use_fact_id = (select fact_id from correction_attempt_fixture)
  ),
  0::bigint,
  'targeted correction removes the disputed field acquisition, fact, card, and released temp source'
);

select ok(
  exists (
    select 1 from public.acquisitions
    where id = 'e8500000-0000-4000-8000-000000000010'
      and acquisition_type = 'gift'
  )
  and exists (
    select 1 from public.personal_cards
    where id = 'f8500000-0000-4000-8000-000000000010'
  )
  and exists (
    select 1 from analytics.events
    where personal_card_id = 'f8500000-0000-4000-8000-000000000010'
      and event_name = 'personal_card_created'
  ),
  'targeted correction preserves unrelated gift acquisition, card, and event'
);

-- A failed-only attempt has no acquisition from which a long-running full
-- withdrawal can reconstruct its anti-replay marker. Keep the fact while the
-- withdrawal is pending, then rebase the marker at actual completion.
insert into private.location_use_facts (
  user_id, idempotency_key, spot_id, purpose,
  collected_at, decided_at, outcome,
  terminal_failure_code, terminal_failure_details
)
values (
  (select user_id from location_test_users where fixture_name = 'delayed_withdrawal'),
  'e8100000-0000-4000-8000-000000000001',
  'b8000000-0000-4000-8000-000000000001',
  'field_acquisition', now() - interval '7 months', now() - interval '7 months',
  'failed', 'OUT_OF_RANGE', '{"distance_band":"far"}'::jsonb
);

select is(
  api_private.request_location_withdrawal(
    'a8000000-0000-4000-8000-000000000010'
  ) ->> 'status',
  'location_withdrawal_pending',
  'failed-only legacy data can enter full withdrawal without age or consent'
);

create temp table delayed_withdrawal_job as
select id
from private.data_erasure_jobs
where user_id = (
    select user_id from location_test_users where fixture_name = 'delayed_withdrawal'
  )
  and scope = 'location_withdrawal'
  and state <> 'completed';

update private.data_erasure_jobs
set requested_at = now() - interval '7 months'
where id = (select id from delayed_withdrawal_job);

update private.location_attempt_tombstones
set expires_at = clock_timestamp() - interval '1 second'
where owner_fingerprint = private.location_attempt_owner_fingerprint(
    (select user_id from location_test_users where fixture_name = 'delayed_withdrawal')
  )
  and attempt_key_fingerprint = private.location_attempt_key_fingerprint(
    'e8100000-0000-4000-8000-000000000001'
  );

select api_private.purge_expired_location_compliance_records(5000);

select ok(
  exists (
    select 1
    from private.location_use_facts
    where user_id = (
        select user_id from location_test_users where fixture_name = 'delayed_withdrawal'
      )
      and idempotency_key = 'e8100000-0000-4000-8000-000000000001'
  )
  and not private.location_attempt_is_tombstoned(
    (select user_id from location_test_users where fixture_name = 'delayed_withdrawal'),
    'e8100000-0000-4000-8000-000000000001'
  ),
  'retention keeps a failed-only fact while an old withdrawal remains pending'
);

select is(
  api_private.claim_data_erasure_jobs(
    'f8100000-0000-4000-8000-000000000001', 2, 4
  ) #>> '{jobs,0,scope}',
  'location_withdrawal',
  'the delayed failed-only withdrawal is claimed for database completion'
);

select is(
  api_private.finish_data_erasure_job(
    'f8100000-0000-4000-8000-000000000001',
    (select id from delayed_withdrawal_job)
  ),
  '{"status":"completed"}'::jsonb,
  'the delayed failed-only withdrawal completes without a Storage manifest'
);

select ok(
  not exists (
    select 1
    from private.location_use_facts
    where user_id = (
        select user_id from location_test_users where fixture_name = 'delayed_withdrawal'
      )
      and idempotency_key = 'e8100000-0000-4000-8000-000000000001'
  )
  and exists (
    select 1
    from private.location_attempt_tombstones as tombstone_row
    where tombstone_row.owner_fingerprint = private.location_attempt_owner_fingerprint(
        (select user_id from location_test_users where fixture_name = 'delayed_withdrawal')
      )
      and tombstone_row.attempt_key_fingerprint =
        private.location_attempt_key_fingerprint(
          'e8100000-0000-4000-8000-000000000001'
        )
      and tombstone_row.expires_at > clock_timestamp() + interval '5 months'
  ),
  'completion deletes the failed fact and recreates a six-month anti-replay marker'
);

-- Full withdrawal snapshots derivatives and preserves non-location history -

select is(
  api_private.acquire_context_unrated(
    'a8000000-0000-4000-8000-000000000002',
    'b8000000-0000-4000-8000-000000000001',
    'e8200000-0000-4000-8000-000000000001',
    true
  ) ->> 'status',
  'ready',
  'owner field acquisition creates a bounded location fact'
);

select is(
  api_private.acquire_commit_unrated(
    'a8000000-0000-4000-8000-000000000002',
    'b8000000-0000-4000-8000-000000000001',
    'e8200000-0000-4000-8000-000000000001',
    true,
    (
      select updated_at from public.spots
      where id = 'b8000000-0000-4000-8000-000000000001'
    )
  ) ->> 'status',
  'created',
  'owner field acquisition commits before the withdrawal fixture'
);

create temp table owner_field_acquisition as
select id, acquired_at
from public.acquisitions
where user_id = (select user_id from location_test_users where fixture_name = 'owner')
  and idempotency_key = 'e8200000-0000-4000-8000-000000000001';

insert into private.bonus_packs (
  id, user_id, issuance_kind, issued_on_kst, pool_version_id,
  result_card_id, result_rarity, rarity_roll, selection_roll,
  guarantee_applied, state, issued_at
)
select
  'e8250000-0000-4000-8000-000000000001',
  fixture.user_id,
  'field_daily',
  acquisition_row.acquired_on_kst,
  'c8200000-0000-4000-8000-000000000001',
  'c8000000-0000-4000-8000-000000000001',
  'common',
  1,
  0,
  false,
  'sealed',
  clock_timestamp()
from location_test_users as fixture
join public.acquisitions as acquisition_row
  on acquisition_row.id = (select id from owner_field_acquisition)
where fixture.fixture_name = 'owner';

insert into private.bonus_pack_qualifiers (
  pack_id, acquisition_id, user_id, is_issuing_qualifier
)
select
  'e8250000-0000-4000-8000-000000000001',
  (select id from owner_field_acquisition),
  fixture.user_id,
  true
from location_test_users as fixture
where fixture.fixture_name = 'owner';

select is(
  api_private.open_bonus_pack(
    'a8000000-0000-4000-8000-000000000002',
    'e8250000-0000-4000-8000-000000000001',
    'e8250000-0000-4000-8000-000000000002'
  ) #>> '{bonus_pack,status}',
  'opened',
  'the withdrawal fixture owns an opened field bonus pack through the real RPC'
);

insert into public.personal_cards (
  id, user_id, acquisition_id, photo_path, caption
)
values (
  'f8200000-0000-4000-8000-000000000001',
  (select user_id from location_test_users where fixture_name = 'owner'),
  (select id from owner_field_acquisition),
  (select user_id::text from location_test_users where fixture_name = 'owner') ||
    '/field-withdrawal.webp',
  'field withdrawal'
);

insert into public.acquisitions (
  id, user_id, spot_id, card_id, acquisition_type, verification_result,
  idempotency_key, field_sequence, acquired_at
)
values (
  'e8200000-0000-4000-8000-000000000010',
  (select user_id from location_test_users where fixture_name = 'owner'),
  'b8000000-0000-4000-8000-000000000001',
  'c8000000-0000-4000-8000-000000000001',
  'gift', 'not_applicable',
  'e8200000-0000-4000-8000-000000000011', null,
  now() - interval '3 days'
);

insert into public.personal_cards (
  id, user_id, acquisition_id, photo_path, caption
)
values (
  'f8200000-0000-4000-8000-000000000010',
  (select user_id from location_test_users where fixture_name = 'owner'),
  'e8200000-0000-4000-8000-000000000010',
  (select user_id::text from location_test_users where fixture_name = 'owner') ||
    '/gift-withdrawal-preserved.webp',
  'gift must remain'
);

select is(
  api_private.accept_current_policies(
    'a8000000-0000-4000-8000-000000000002',
    jsonb_build_array(
      jsonb_build_object('type', 'terms_of_use', 'version', 'location-v2', 'locale', 'ko'),
      jsonb_build_object('type', 'community_guidelines', 'version', 'location-v2', 'locale', 'ko')
    )
  ),
  '{"status":"accepted"}'::jsonb,
  'owner accepts the current UGC policies for share-state safety tests'
);

select is(
  api_private.create_personal_card_share(
    'a8000000-0000-4000-8000-000000000002',
    true, true,
    'f8200000-0000-4000-8000-000000000001',
    'LocationWithdrawalSlug001'
  ) ->> 'status',
  'pending',
  'field share enters pending while location access is active'
);

select is(
  api_private.change_location_consent_state(
    'a8000000-0000-4000-8000-000000000002', 'paused'
  ),
  '{"status":"paused"}'::jsonb,
  'owner pauses before a safety-decreasing moderation action'
);

select is(
  api_private.moderate_personal_card_share(
    'a8000000-0000-4000-8000-000000000001',
    'f8200000-0000-4000-8000-000000000001',
    'e8200000-0000-4000-8000-000000000020',
    'reject', 'PRIVACY', 'safe rejection while paused', true
  ) ->> 'share_state',
  'rejected',
  'paused location use still permits a safe admin rejection'
);

select is(
  api_private.change_location_consent_state(
    'a8000000-0000-4000-8000-000000000002', 'active'
  ),
  '{"status":"active"}'::jsonb,
  'owner explicitly resumes before resubmission'
);

select is(
  api_private.moderate_personal_card_share(
    'a8000000-0000-4000-8000-000000000001',
    'f8200000-0000-4000-8000-000000000001',
    'e8200000-0000-4000-8000-000000000022',
    'reinstate', 'APPEAL_ACCEPTED', 'return to pending review', true
  ) ->> 'share_state',
  'pending',
  'rejected field share may reenter review only after active consent returns'
);

select is(
  api_private.create_personal_card_share(
    'a8000000-0000-4000-8000-000000000002',
    true, true,
    'f8200000-0000-4000-8000-000000000001',
    null
  ) ->> 'status',
  'pending',
  'owner refreshes policy snapshots after reinstatement'
);

select is(
  api_private.moderate_personal_card_share(
    'a8000000-0000-4000-8000-000000000001',
    'f8200000-0000-4000-8000-000000000001',
    'e8200000-0000-4000-8000-000000000021',
    'approve', 'POLICY_OK', 'approve active location fixture', true
  ) ->> 'share_state',
  'active',
  'admin approval succeeds while adult location access is active'
);

select is(
  api_private.change_location_consent_state(
    'a8000000-0000-4000-8000-000000000002', 'paused'
  ),
  '{"status":"paused"}'::jsonb,
  'owner pauses again before revocation'
);

select is(
  api_private.revoke_personal_card_share(
    'a8000000-0000-4000-8000-000000000002',
    'f8200000-0000-4000-8000-000000000001'
  ) ->> 'status',
  'revoked',
  'paused location use always permits owner revocation to private'
);

select is(
  api_private.change_location_consent_state(
    'a8000000-0000-4000-8000-000000000002', 'active'
  ),
  '{"status":"active"}'::jsonb,
  'owner returns active before requesting full withdrawal'
);

-- An unbound temp upload is not a field-acquisition derivative. Location
-- withdrawal must preserve it while erasing the exact manifest-owned source.
with fixture_time as (
  select clock_timestamp() - interval '5 minutes' as issued_at
)
insert into private.personal_card_temp_uploads (
  id, user_id, temp_path, declared_content_type, declared_size_bytes,
  issued_at, promotion_expires_at, signed_url_expires_at
)
select
  'e8200000-0000-4000-8000-000000000032',
  (select user_id from location_test_users where fixture_name = 'owner'),
  (select user_id::text from location_test_users where fixture_name = 'owner') ||
    '/e8200000-0000-4000-8000-000000000032.jpg',
  'image/jpeg', 1234,
  fixture_time.issued_at,
  fixture_time.issued_at + interval '10 minutes',
  fixture_time.issued_at + interval '2 hours'
from fixture_time;

-- Temp source has already received the best-effort first delete, but its
-- signed URL has not expired and cleanup is incomplete. It must be snapped.
with fixture_time as (
  select clock_timestamp() - interval '5 minutes' as issued_at
)
insert into private.personal_card_temp_uploads (
  id, user_id, temp_path, declared_content_type, declared_size_bytes,
  issued_at, promotion_expires_at, signed_url_expires_at,
  temp_deleted_at, cleanup_completed_at,
  processing_token, processing_started_at, processing_expires_at,
  processing_acquisition_id, processing_permanent_path, processing_caption
)
select
  'e8200000-0000-4000-8000-000000000030',
  (select user_id from location_test_users where fixture_name = 'owner'),
  (select user_id::text from location_test_users where fixture_name = 'owner') ||
    '/e8200000-0000-4000-8000-000000000030.jpg',
  'image/jpeg', 1234,
  fixture_time.issued_at,
  fixture_time.issued_at + interval '10 minutes',
  fixture_time.issued_at + interval '2 hours',
  fixture_time.issued_at + interval '1 minute', null,
  'e8200000-0000-4000-8000-000000000031',
  fixture_time.issued_at + interval '1 minute',
  fixture_time.issued_at + interval '6 minutes',
  (select id from owner_field_acquisition),
  (select user_id::text from location_test_users where fixture_name = 'owner') ||
    '/e8200000-0000-4000-8000-000000000031.webp',
  'processing'
from fixture_time;

insert into private.personal_card_field_object_ledger (
  user_id, field_acquisition_id, upload_id, processing_token,
  bucket, object_path, final_delete_not_before, next_attempt_at
)
select
  upload_row.user_id,
  upload_row.processing_acquisition_id,
  upload_row.id,
  upload_row.processing_token,
  path_row.bucket,
  path_row.object_path,
  path_row.final_delete_not_before,
  path_row.initial_next_attempt_at
from private.personal_card_temp_uploads as upload_row
cross join lateral (
  values
    (
      'personal-card-temp'::text,
      upload_row.temp_path,
      upload_row.signed_url_expires_at + interval '10 minutes',
      upload_row.promotion_expires_at
    ),
    (
      'personal-cards'::text,
      upload_row.processing_permanent_path,
      upload_row.processing_expires_at + interval '10 minutes',
      clock_timestamp()
    )
) as path_row(
  bucket, object_path, final_delete_not_before, initial_next_attempt_at
)
where upload_row.id = 'e8200000-0000-4000-8000-000000000030';

select is(
  api_private.release_personal_card_promotion(
    'e8200000-0000-4000-8000-000000000030',
    'e8200000-0000-4000-8000-000000000031'
  ) ->> 'status',
  'updated',
  'full-withdrawal fixture drops transient processing fields but keeps durable bindings'
);

insert into analytics.events (
  client_event_id, user_id, event_name, source, occurred_at, spot_id, properties
)
values (
  'e8200000-0000-4000-8000-000000000040',
  (select user_id from location_test_users where fixture_name = 'owner'),
  'spot_view', 'client', now() - interval '1 hour',
  'b8000000-0000-4000-8000-000000000001',
  '{"spot_id":"b8000000-0000-4000-8000-000000000001"}'
);

select throws_ok(
  $sql$
    insert into analytics.events (
      client_event_id, user_id, event_name, source, occurred_at, spot_id, properties
    ) values (
      'e8200000-0000-4000-8000-000000000041',
      (select user_id from location_test_users where fixture_name = 'owner'),
      'acquire_attempt', 'client', now() - interval '30 minutes',
      'b8000000-0000-4000-8000-000000000001',
      '{"spot_id":"b8000000-0000-4000-8000-000000000001"}'
    )
  $sql$,
  '23514',
  null,
  'retired uncorrelated client location events are blocked at the table boundary'
);

select throws_ok(
  $sql$
    insert into analytics.events (
      user_id, event_name, source, occurred_at, spot_id, properties
    ) values (
      (select user_id from location_test_users where fixture_name = 'owner'),
      'acquire_fail', 'server', now() - interval '20 minutes',
      'b8000000-0000-4000-8000-000000000001',
      '{"code":"GATE_CLOSED"}'::jsonb
    )
  $sql$,
  '23514',
  null,
  'every future server acquire failure requires exact location-fact correlation'
);

insert into analytics.events (
  user_id, event_name, source, occurred_at, properties, personal_card_id
)
values
  (
    (select user_id from location_test_users where fixture_name = 'owner'),
    'revisit', 'server', now() - interval '20 minutes', '{}', null
  ),
  (
    (select user_id from location_test_users where fixture_name = 'owner'),
    'personal_card_created', 'server', now() - interval '3 days', '{}',
    'f8200000-0000-4000-8000-000000000010'
  ),
  (
    (select user_id from location_test_users where fixture_name = 'owner'),
    'personal_card_created', 'server', now() - interval '4 days', '{}', null
  );

select is(
  api_private.list_location_use_facts(
    'a8000000-0000-4000-8000-000000000002', 50, null, null
  ) ->> 'status',
  'ready',
  'owner creates a disclosure audit before withdrawal'
);

select is(
  api_private.create_location_correction_request(
    'a8000000-0000-4000-8000-000000000002',
    (
      select id from private.location_use_facts
      where user_id = (select user_id from location_test_users where fixture_name = 'owner')
        and idempotency_key = 'e8200000-0000-4000-8000-000000000001'
    ),
    null,
    'e8200000-0000-4000-8000-000000000050',
    'incorrect_outcome'
  ) ->> 'status',
  'created',
  'owner has an open correction that full withdrawal must erase'
);

insert into private.location_use_facts (
  user_id, idempotency_key, spot_id, purpose, collected_at, decided_at, outcome,
  terminal_failure_code, terminal_failure_details
)
values (
  (select user_id from location_test_users where fixture_name = 'owner'),
  'e8200000-0000-4000-8000-000000000051',
  'b8000000-0000-4000-8000-000000000001',
  'field_acquisition', now() - interval '10 days', now() - interval '10 days', 'failed',
  'OUT_OF_RANGE', '{"distance_band":"near"}'::jsonb
);

insert into private.location_correction_requests (
  id, user_id, location_use_fact_id, client_request_id, request_fingerprint, reason, status,
  requested_at, resolved_at, resolved_by_auth_user_id
)
values (
  'e8200000-0000-4000-8000-000000000052',
  (select user_id from location_test_users where fixture_name = 'owner'),
  (
    select id from private.location_use_facts
    where user_id = (select user_id from location_test_users where fixture_name = 'owner')
      and idempotency_key = 'e8200000-0000-4000-8000-000000000051'
  ),
  'e8200000-0000-4000-8000-000000000053',
  decode(repeat('11', 32), 'hex'),
  'other', 'corrected',
  now() - interval '9 days', now() - interval '8 days',
  'a8000000-0000-4000-8000-000000000001'
);

insert into private.data_erasure_jobs (
  id, user_id, scope, correction_request_id, state,
  requested_at, attempt_count, next_attempt_at, completed_at
)
values (
  'e8200000-0000-4000-8000-000000000054',
  (select user_id from location_test_users where fixture_name = 'owner'),
  'location_correction',
  'e8200000-0000-4000-8000-000000000052',
  'completed', now() - interval '9 days', 2, now() - interval '8 days',
  now() - interval '8 days'
);

select is(
  api_private.request_location_withdrawal(
    'a8000000-0000-4000-8000-000000000002'
  ) ->> 'status',
  'location_withdrawal_pending',
  'full location withdrawal becomes pending before asynchronous object deletion'
);

create temp table owner_withdrawal_job as
select id
from private.data_erasure_jobs
where user_id = (select user_id from location_test_users where fixture_name = 'owner')
  and scope = 'location_withdrawal'
  and state <> 'completed';

select is(
  (
    select count(*)::bigint
    from private.data_erasure_jobs
    where user_id = (select user_id from location_test_users where fixture_name = 'owner')
      and scope = 'location_correction'
  ),
  0::bigint,
  'withdrawal deletes completed correction receipts before their RESTRICT-linked requests'
);

select ok(
  exists (
    select 1
    from private.data_erasure_manifest as item_row
    join private.personal_card_temp_uploads as upload_row
      on upload_row.temp_path = item_row.object_path
    where item_row.job_id = (select id from owner_withdrawal_job)
      and item_row.bucket = 'personal-card-temp'
      and upload_row.temp_deleted_at is not null
      and upload_row.cleanup_completed_at is null
      and item_row.final_delete_after >= upload_row.signed_url_expires_at + interval '10 minutes'
  ),
  'withdrawal snapshots cleanup-incomplete temp paths through signed URL expiry plus ten minutes'
);

select ok(
  exists (
    select 1
    from private.data_erasure_manifest as item_row
    join private.personal_card_field_object_ledger as ledger_row
      on ledger_row.bucket = item_row.bucket
     and ledger_row.object_path = item_row.object_path
    where item_row.job_id = (select id from owner_withdrawal_job)
      and item_row.bucket = 'personal-cards'
      and item_row.object_path =
        (select user_id::text from location_test_users where fixture_name = 'owner') ||
        '/e8200000-0000-4000-8000-000000000031.webp'
      and item_row.final_delete_after >= ledger_row.final_delete_not_before
      and ledger_row.upload_id = 'e8200000-0000-4000-8000-000000000030'
  ),
  'withdrawal snapshots the released permanent binding through its upload-lease grace'
);

select is(
  api_private.accept_location_consent(
    'a8000000-0000-4000-8000-000000000002',
    '{"version":"location-v2","locale":"ko"}'::jsonb
  ) ->> 'status',
  'location_withdrawal_pending',
  're-consent is blocked until withdrawal fully completes'
);

select is(
  api_private.record_acquire_failure_unrated(
    'a8000000-0000-4000-8000-000000000002',
    'b8000000-0000-4000-8000-000000000001',
    'e8200000-0000-4000-8000-000000000001',
    'OUT_OF_RANGE',
    '{"distance_band":"far"}'::jsonb
  ) ->> 'code',
  'LOCATION_WITHDRAWAL_PENDING',
  'late acquire failure cannot recreate telemetry after withdrawal starts'
);

select is(
  api_private.claim_data_erasure_jobs(
    'f8200000-0000-4000-8000-000000000001', 2, 4
  ) #>> '{jobs,0,scope}',
  'location_withdrawal',
  'withdrawal worker claims the full-erasure job'
);

select ok(
  not exists (
    select 1
    from jsonb_array_elements(
      api_private.claim_data_erasure_jobs(
        'f8200000-0000-4000-8000-000000000099', 2, 4
      ) -> 'jobs'
    )
  ),
  'an active lease prevents a second worker from claiming the same withdrawal'
);

do $worker$
declare
  item_row record;
  v_result jsonb;
begin
  for item_row in
    select id
    from private.data_erasure_manifest
    where job_id = (select id from owner_withdrawal_job)
      and deleted_at is null
    order by id
  loop
    v_result := api_private.record_data_erasure_item_result(
      'f8200000-0000-4000-8000-000000000001',
      (select id from owner_withdrawal_job),
      item_row.id,
      true
    );
    if v_result <> '{"status":"recorded"}'::jsonb then
      raise exception 'unexpected first-phase result: %', v_result;
    end if;
  end loop;
end
$worker$;

select is(
  api_private.finish_data_erasure_job(
    'f8200000-0000-4000-8000-000000000001',
    (select id from owner_withdrawal_job)
  ),
  '{"status":"retry"}'::jsonb,
  'full withdrawal waits after first Storage deletion pass'
);

update private.data_erasure_manifest
set first_deleted_at = clock_timestamp() - interval '2 hours 20 minutes',
    final_delete_after = clock_timestamp() - interval '1 second'
where job_id = (select id from owner_withdrawal_job);
update private.data_erasure_jobs
set next_attempt_at = clock_timestamp() - interval '1 second'
where id = (select id from owner_withdrawal_job);

select is(
  api_private.claim_data_erasure_jobs(
    'f8200000-0000-4000-8000-000000000002', 2, 4
  ) #>> '{jobs,0,items,0,phase}',
  'final',
  'full withdrawal exposes final deletion only in the later worker cycle'
);

do $worker$
declare
  item_row record;
  v_result jsonb;
begin
  for item_row in
    select id
    from private.data_erasure_manifest
    where job_id = (select id from owner_withdrawal_job)
      and deleted_at is null
    order by id
  loop
    v_result := api_private.record_data_erasure_item_result(
      'f8200000-0000-4000-8000-000000000002',
      (select id from owner_withdrawal_job),
      item_row.id,
      true
    );
    if v_result <> '{"status":"recorded"}'::jsonb then
      raise exception 'unexpected final-phase result: %', v_result;
    end if;
  end loop;
end
$worker$;

select is(
  api_private.finish_data_erasure_job(
    'f8200000-0000-4000-8000-000000000002',
    (select id from owner_withdrawal_job)
  ),
  '{"status":"completed"}'::jsonb,
  'full withdrawal completes after final Storage deletion'
);

select is(
  (
    select count(*)::bigint
    from private.data_erasure_manifest
    where job_id = (select id from owner_withdrawal_job)
  ),
  0::bigint,
  'completed withdrawal receipt retains no identifying Storage path'
);

select is(
  (
    select count(*)::bigint
    from private.personal_card_field_object_ledger
    where user_id = (select user_id from location_test_users where fixture_name = 'owner')
  ),
  0::bigint,
  'completed withdrawal removes every durable field-object binding'
);

select is(
  (
    select count(*)::bigint
    from public.acquisitions
    where user_id = (select user_id from location_test_users where fixture_name = 'owner')
      and acquisition_type = 'field'
  ) + (
    select count(*)::bigint
    from private.personal_card_temp_uploads
    where id = 'e8200000-0000-4000-8000-000000000030'
  ) + (
    select count(*)::bigint
    from private.location_use_facts
    where user_id = (select user_id from location_test_users where fixture_name = 'owner')
  ) + (
    select count(*)::bigint
    from private.location_disclosure_accesses
    where user_id = (select user_id from location_test_users where fixture_name = 'owner')
  ) + (
    select count(*)::bigint
    from private.location_correction_requests
    where user_id = (select user_id from location_test_users where fixture_name = 'owner')
  ) + (
    select count(*)::bigint
    from private.location_consents
    where user_id = (select user_id from location_test_users where fixture_name = 'owner')
  ),
  0::bigint,
  'withdrawal removes all field, temp, fact, disclosure, correction, and consent rows'
);

select is(
  (
    select count(*)::bigint
    from private.bonus_packs
    where id = 'e8250000-0000-4000-8000-000000000001'
  ) + (
    select count(*)::bigint
    from private.bonus_pack_qualifiers
    where pack_id = 'e8250000-0000-4000-8000-000000000001'
  ) + (
    select count(*)::bigint
    from private.bonus_pack_open_requests
    where pack_id = 'e8250000-0000-4000-8000-000000000001'
  ),
  0::bigint,
  'actual location withdrawal removes the field pack, qualifier, and reveal ledgers'
);

select ok(
  exists (
    select 1
    from private.personal_card_temp_uploads
    where id = 'e8200000-0000-4000-8000-000000000032'
      and user_id = (select user_id from location_test_users where fixture_name = 'owner')
      and processing_acquisition_id is null
  ),
  'location withdrawal preserves a temp upload unrelated to any field acquisition'
);

select ok(
  exists (
    select 1 from public.acquisitions
    where id = 'e8200000-0000-4000-8000-000000000010'
      and acquisition_type = 'gift'
  )
  and exists (
    select 1 from public.personal_cards
    where id = 'f8200000-0000-4000-8000-000000000010'
  )
  and exists (
    select 1 from analytics.events
    where personal_card_id = 'f8200000-0000-4000-8000-000000000010'
      and event_name = 'personal_card_created'
  ),
  'full location withdrawal preserves gift acquisition, card, and linked event'
);

select ok(
  exists (
    select 1 from analytics.events
    where user_id = (select user_id from location_test_users where fixture_name = 'owner')
      and event_name = 'spot_view'
  )
  and exists (
    select 1 from analytics.events
    where user_id = (select user_id from location_test_users where fixture_name = 'owner')
      and event_name = 'revisit'
  )
  and exists (
    select 1 from analytics.events
    where user_id = (select user_id from location_test_users where fixture_name = 'owner')
      and event_name = 'personal_card_created'
      and personal_card_id is null
  ),
  'discovery, revisit, and ambiguous legacy-null card events are not over-deleted'
);

select ok(
  not exists (
    select 1 from analytics.events
    where user_id = (select user_id from location_test_users where fixture_name = 'owner')
      and event_name = 'acquire_success'
      and spot_id = 'b8000000-0000-4000-8000-000000000001'
      and occurred_at = (select acquired_at from owner_field_acquisition)
  ),
  'withdrawal removes exact field-success telemetry'
);

select is(
  (
    select count(*)::bigint
    from private.policy_acceptances as acceptance_row
    join private.policy_documents as document_row
      on document_row.id = acceptance_row.policy_document_id
    where acceptance_row.user_id = (
      select user_id from location_test_users where fixture_name = 'owner'
    )
      and document_row.policy_type = 'location_terms'
  ),
  0::bigint,
  'full withdrawal removes only the location-policy acceptance snapshots'
);

select is(
  api_private.request_location_withdrawal(
    'a8000000-0000-4000-8000-000000000002'
  ),
  '{"status":"withdrawn"}'::jsonb,
  'a completed no-location-data withdrawal retry is idempotent'
);

select is(
  api_private.accept_location_consent(
    'a8000000-0000-4000-8000-000000000002',
    '{"version":"location-v2","locale":"ko"}'::jsonb
  ),
  '{"status":"active"}'::jsonb,
  'a completed withdrawal may explicitly consent again for a new visit'
);

select is(
  api_private.acquire_context_unrated(
    'a8000000-0000-4000-8000-000000000002',
    'b8000000-0000-4000-8000-000000000001',
    'e8200000-0000-4000-8000-000000000001',
    true
  ) ->> 'code',
  'IDEMPOTENCY_CONFLICT',
  're-consent does not let a stale pre-withdrawal logical attempt recreate data'
);

update private.location_attempt_tombstones
set expires_at = clock_timestamp() - interval '1 second'
where owner_fingerprint = private.location_attempt_owner_fingerprint(
    (select user_id from location_test_users where fixture_name = 'owner')
  )
  and attempt_key_fingerprint = private.location_attempt_key_fingerprint(
    'e8200000-0000-4000-8000-000000000001'
  );

select ok(
  (api_private.purge_expired_location_compliance_records(5000)
    ->> 'attempt_tombstones_deleted')::integer >= 1
  and not private.location_attempt_is_tombstoned(
    (select user_id from location_test_users where fixture_name = 'owner'),
    'e8200000-0000-4000-8000-000000000001'
  ),
  'expired anti-replay digests are removed by bounded retention maintenance'
);

-- Recovery minimizes zero-acquisition source location state ---------------

select is(
  api_private.record_minimum_age_attestation(
    'a8000000-0000-4000-8000-000000000011',
    '{"minimum_age_passed":true,"version":"18plus-v1"}'::jsonb
  ),
  '{"status":"attested"}'::jsonb,
  'failed-location recovery source records the minimum-age marker'
);

select is(
  api_private.accept_location_consent(
    'a8000000-0000-4000-8000-000000000011',
    jsonb_build_object(
      'version', (
        select document_row.version
        from private.policy_documents as document_row
        where document_row.policy_type = 'location_terms'
          and document_row.is_current
      ),
      'locale', 'ko'
    )
  ) ->> 'status',
  'active',
  'failed-location recovery source records current location consent'
);

select is(
  api_private.acquire_context_unrated(
    'a8000000-0000-4000-8000-000000000011',
    'b8000000-0000-4000-8000-000000000001',
    'e8300000-0000-4000-8000-000000000101',
    true
  ) ->> 'status',
  'ready',
  'failed-location recovery source creates one pending fact'
);

select is(
  api_private.record_acquire_failure_unrated(
    'a8000000-0000-4000-8000-000000000011',
    'b8000000-0000-4000-8000-000000000001',
    'e8300000-0000-4000-8000-000000000101',
    'SPOT_NOT_OPEN',
    '{}'::jsonb
  ) ->> 'status',
  'failed',
  'failed-location recovery source records an exact correlated terminal event'
);

-- Model a marker whose original fact/acquisition was already erased by a
-- completed correction or withdrawal. The raw key is absent from the marker,
-- so recovery must move it by owner/key digests rather than by live facts.
insert into private.location_attempt_tombstones (
  owner_fingerprint,
  attempt_key_fingerprint,
  expires_at
)
values
  (
    private.location_attempt_owner_fingerprint(
      (select user_id from location_test_users where fixture_name = 'recovery_failed')
    ),
    private.location_attempt_key_fingerprint(
      'e8300000-0000-4000-8000-000000000109'
    ),
    clock_timestamp() + interval '4 months'
  ),
  (
    private.location_attempt_owner_fingerprint(
      (select user_id from location_test_users where fixture_name = 'recovery_failed_target')
    ),
    private.location_attempt_key_fingerprint(
      'e8300000-0000-4000-8000-000000000109'
    ),
    clock_timestamp() + interval '5 months'
  );

insert into private.recovery_codes (user_id, code_hash, issued_at)
values (
  (select user_id from location_test_users where fixture_name = 'recovery_failed_target'),
  decode(repeat('d1', 32), 'hex'),
  clock_timestamp()
);

select is(
  api_private.claim_recovery_code(
    'a8000000-0000-4000-8000-000000000011', repeat('d1', 32)
  ),
  '{"status":"restored"}'::jsonb,
  'recovery succeeds with a zero-acquisition failed fact and correlated event'
);

select ok(
  not exists (
    select 1 from private.location_use_facts
    where user_id = (select user_id from location_test_users where fixture_name = 'recovery_failed')
  )
  and not exists (
    select 1 from analytics.events
    where user_id = (select user_id from location_test_users where fixture_name = 'recovery_failed')
      and event_name = 'acquire_fail'
  )
  and not exists (
    select 1 from private.location_consents
    where user_id = (select user_id from location_test_users where fixture_name = 'recovery_failed')
  )
  and not exists (
    select 1 from private.location_use_facts
    where user_id = (select user_id from location_test_users where fixture_name = 'recovery_failed_target')
  )
  and not exists (
    select 1 from analytics.events
    where user_id = (select user_id from location_test_users where fixture_name = 'recovery_failed_target')
      and event_name = 'acquire_fail'
  )
  and private.location_attempt_is_tombstoned(
    (select user_id from location_test_users where fixture_name = 'recovery_failed_target'),
    'e8300000-0000-4000-8000-000000000101'
  )
  and private.location_attempt_is_tombstoned(
    (select user_id from location_test_users where fixture_name = 'recovery_failed_target'),
    'e8300000-0000-4000-8000-000000000109'
  )
  and not exists (
    select 1
    from private.location_attempt_tombstones as tombstone_row
    where tombstone_row.owner_fingerprint = private.location_attempt_owner_fingerprint(
      (select user_id from location_test_users where fixture_name = 'recovery_failed')
    )
  ),
  'recovery minimizes source state and atomically re-owns live and already-minimized markers'
);

select is(
  api_private.accept_location_consent(
    'a8000000-0000-4000-8000-000000000011',
    jsonb_build_object(
      'version', (
        select document_row.version
        from private.policy_documents as document_row
        where document_row.policy_type = 'location_terms'
          and document_row.is_current
      ),
      'locale', 'ko'
    )
  ) ->> 'status',
  'active',
  'recovered target may explicitly accept location terms for future attempts'
);

select is(
  api_private.acquire_context_unrated(
    'a8000000-0000-4000-8000-000000000011',
    'b8000000-0000-4000-8000-000000000001',
    'e8300000-0000-4000-8000-000000000101',
    true
  ) ->> 'code',
  'IDEMPOTENCY_CONFLICT',
  'recovery target blocks a stale same-key context request'
);

select is(
  api_private.acquire_commit_unrated(
    'a8000000-0000-4000-8000-000000000011',
    'b8000000-0000-4000-8000-000000000001',
    'e8300000-0000-4000-8000-000000000101',
    true,
    (select updated_at from public.spots where id = 'b8000000-0000-4000-8000-000000000001')
  ) ->> 'code',
  'IDEMPOTENCY_CONFLICT',
  'recovery target blocks a stale same-key commit request'
);

select is(
  api_private.record_acquire_failure_unrated(
    'a8000000-0000-4000-8000-000000000011',
    'b8000000-0000-4000-8000-000000000001',
    'e8300000-0000-4000-8000-000000000101',
    'SPOT_NOT_OPEN',
    '{}'::jsonb
  ) ->> 'code',
  'IDEMPOTENCY_CONFLICT',
  'recovery target blocks a stale same-key failure request'
);

select is(
  api_private.acquire_context_unrated(
    'a8000000-0000-4000-8000-000000000011',
    'b8000000-0000-4000-8000-000000000001',
    'e8300000-0000-4000-8000-000000000109',
    true
  ) ->> 'code',
  'IDEMPOTENCY_CONFLICT',
  'recovery target blocks context replay for an already-minimized source marker'
);

select is(
  api_private.acquire_commit_unrated(
    'a8000000-0000-4000-8000-000000000011',
    'b8000000-0000-4000-8000-000000000001',
    'e8300000-0000-4000-8000-000000000109',
    true,
    (select updated_at from public.spots where id = 'b8000000-0000-4000-8000-000000000001')
  ) ->> 'code',
  'IDEMPOTENCY_CONFLICT',
  'recovery target blocks commit replay for an already-minimized source marker'
);

select is(
  api_private.record_acquire_failure_unrated(
    'a8000000-0000-4000-8000-000000000011',
    'b8000000-0000-4000-8000-000000000001',
    'e8300000-0000-4000-8000-000000000109',
    'SPOT_NOT_OPEN',
    '{}'::jsonb
  ) ->> 'code',
  'IDEMPOTENCY_CONFLICT',
  'recovery target blocks failure replay for an already-minimized source marker'
);

select is(
  api_private.record_minimum_age_attestation(
    'a8000000-0000-4000-8000-000000000017',
    '{"minimum_age_passed":true,"version":"18plus-v1"}'::jsonb
  ),
  '{"status":"attested"}'::jsonb,
  'completed-correction recovery source records the minimum-age marker'
);

select is(
  api_private.accept_location_consent(
    'a8000000-0000-4000-8000-000000000017',
    jsonb_build_object(
      'version', (
        select document_row.version
        from private.policy_documents as document_row
        where document_row.policy_type = 'location_terms'
          and document_row.is_current
      ),
      'locale', 'ko'
    )
  ) ->> 'status',
  'active',
  'completed-correction recovery source records current location consent'
);

select is(
  api_private.acquire_context_unrated(
    'a8000000-0000-4000-8000-000000000017',
    'b8000000-0000-4000-8000-000000000001',
    'e8300000-0000-4000-8000-000000000110',
    true
  ) ->> 'status',
  'ready',
  'completed-correction recovery source creates a pending fact'
);

select is(
  api_private.record_acquire_failure_unrated(
    'a8000000-0000-4000-8000-000000000017',
    'b8000000-0000-4000-8000-000000000001',
    'e8300000-0000-4000-8000-000000000110',
    'SPOT_NOT_OPEN',
    '{}'::jsonb
  ) ->> 'status',
  'failed',
  'completed-correction recovery source records a terminal failed fact'
);

select is(
  api_private.create_location_correction_request(
    'a8000000-0000-4000-8000-000000000017',
    (
      select fact_row.id
      from private.location_use_facts as fact_row
      where fact_row.user_id = (
        select user_id from location_test_users where fixture_name = 'recovery_corrected'
      )
        and fact_row.idempotency_key = 'e8300000-0000-4000-8000-000000000110'
    ),
    null,
    'e8300000-0000-4000-8000-000000000111',
    'incorrect_outcome'
  ) ->> 'status',
  'created',
  'completed-correction recovery source opens an exact correction request'
);

create temp table recovery_corrected_request_fixture as
select request_row.id
from private.location_correction_requests as request_row
where request_row.user_id = (
    select user_id from location_test_users where fixture_name = 'recovery_corrected'
  )
  and request_row.client_request_id = 'e8300000-0000-4000-8000-000000000111';

select is(
  api_private.resolve_location_correction_admin(
    'a8000000-0000-4000-8000-000000000001',
    (select id from recovery_corrected_request_fixture),
    'accepted'
  ) ->> 'status',
  'correction_pending',
  'admin approval schedules completed-source correction erasure'
);

create temp table recovery_corrected_job_fixture as
select job_row.id
from private.data_erasure_jobs as job_row
where job_row.correction_request_id = (
  select id from recovery_corrected_request_fixture
);

update private.data_erasure_jobs
set requested_at = clock_timestamp() - interval '100 years',
    next_attempt_at = clock_timestamp() - interval '1 second'
where id = (select id from recovery_corrected_job_fixture);

select ok(
  exists (
    select 1
    from jsonb_array_elements(
      api_private.claim_data_erasure_jobs(
        'f8300000-0000-4000-8000-000000000110', 2, 4
      ) -> 'jobs'
    ) as job_row(job)
    where job_row.job ->> 'id' = (select id::text from recovery_corrected_job_fixture)
  ),
  'worker claims the completed-source correction job'
);

select is(
  api_private.finish_data_erasure_job(
    'f8300000-0000-4000-8000-000000000110',
    (select id from recovery_corrected_job_fixture)
  ),
  '{"status":"completed"}'::jsonb,
  'completed correction deletes the source fact before later recovery'
);

select ok(
  not exists (
    select 1 from private.location_use_facts
    where user_id = (
      select user_id from location_test_users where fixture_name = 'recovery_corrected'
    )
  )
  and private.location_attempt_is_tombstoned(
    (select user_id from location_test_users where fixture_name = 'recovery_corrected'),
    'e8300000-0000-4000-8000-000000000110'
  ),
  'completed correction leaves only its bounded source anti-replay marker'
);

insert into private.recovery_codes (user_id, code_hash, issued_at)
values (
  (select user_id from location_test_users where fixture_name = 'recovery_corrected_target'),
  decode(repeat('d5', 32), 'hex'),
  clock_timestamp()
);

select is(
  api_private.claim_recovery_code(
    'a8000000-0000-4000-8000-000000000017', repeat('d5', 32)
  ),
  '{"status":"restored"}'::jsonb,
  'recovery succeeds after the source correction has removed its fact'
);

select ok(
  not private.location_attempt_is_tombstoned(
    (select user_id from location_test_users where fixture_name = 'recovery_corrected'),
    'e8300000-0000-4000-8000-000000000110'
  )
  and private.location_attempt_is_tombstoned(
    (select user_id from location_test_users where fixture_name = 'recovery_corrected_target'),
    'e8300000-0000-4000-8000-000000000110'
  ),
  'recovery re-owns the digest-only completed-correction marker'
);

select is(
  api_private.accept_location_consent(
    'a8000000-0000-4000-8000-000000000017',
    jsonb_build_object(
      'version', (
        select document_row.version
        from private.policy_documents as document_row
        where document_row.policy_type = 'location_terms'
          and document_row.is_current
      ),
      'locale', 'ko'
    )
  ) ->> 'status',
  'active',
  'completed-correction recovery target may explicitly re-consent'
);

select is(
  api_private.acquire_context_unrated(
    'a8000000-0000-4000-8000-000000000017',
    'b8000000-0000-4000-8000-000000000001',
    'e8300000-0000-4000-8000-000000000110',
    true
  ) ->> 'code',
  'IDEMPOTENCY_CONFLICT',
  'completed-correction recovery blocks stale context replay'
);

select is(
  api_private.acquire_commit_unrated(
    'a8000000-0000-4000-8000-000000000017',
    'b8000000-0000-4000-8000-000000000001',
    'e8300000-0000-4000-8000-000000000110',
    true,
    (select updated_at from public.spots where id = 'b8000000-0000-4000-8000-000000000001')
  ) ->> 'code',
  'IDEMPOTENCY_CONFLICT',
  'completed-correction recovery blocks stale commit replay'
);

select is(
  api_private.record_acquire_failure_unrated(
    'a8000000-0000-4000-8000-000000000017',
    'b8000000-0000-4000-8000-000000000001',
    'e8300000-0000-4000-8000-000000000110',
    'SPOT_NOT_OPEN',
    '{}'::jsonb
  ) ->> 'code',
  'IDEMPOTENCY_CONFLICT',
  'completed-correction recovery blocks stale failure replay'
);

select is(
  api_private.record_minimum_age_attestation(
    'a8000000-0000-4000-8000-000000000012',
    '{"minimum_age_passed":true,"version":"18plus-v1"}'::jsonb
  ),
  '{"status":"attested"}'::jsonb,
  'pending-location recovery source records the minimum-age marker'
);

select is(
  api_private.accept_location_consent(
    'a8000000-0000-4000-8000-000000000012',
    jsonb_build_object(
      'version', (
        select document_row.version
        from private.policy_documents as document_row
        where document_row.policy_type = 'location_terms'
          and document_row.is_current
      ),
      'locale', 'ko'
    )
  ) ->> 'status',
  'active',
  'pending-location recovery source records current location consent'
);

select is(
  api_private.acquire_context_unrated(
    'a8000000-0000-4000-8000-000000000012',
    'b8000000-0000-4000-8000-000000000001',
    'e8300000-0000-4000-8000-000000000102',
    true
  ) ->> 'status',
  'ready',
  'pending-location recovery source creates one pending fact'
);

select is(
  api_private.create_location_correction_request(
    'a8000000-0000-4000-8000-000000000012',
    (
      select fact_row.id
      from private.location_use_facts as fact_row
      where fact_row.user_id = (
        select user_id from location_test_users where fixture_name = 'recovery_pending'
      )
        and fact_row.idempotency_key = 'e8300000-0000-4000-8000-000000000102'
    ),
    null,
    'e8300000-0000-4000-8000-000000000103',
    'incorrect_outcome'
  ) ->> 'status',
  'created',
  'pending-location recovery source opens a correction request'
);

insert into private.location_disclosure_accesses (user_id, disclosed_count)
values (
  (select user_id from location_test_users where fixture_name = 'recovery_pending'),
  1
);

insert into private.recovery_codes (user_id, code_hash, issued_at)
values (
  (select user_id from location_test_users where fixture_name = 'recovery_pending_target'),
  decode(repeat('d2', 32), 'hex'),
  clock_timestamp()
);

select is(
  api_private.claim_recovery_code(
    'a8000000-0000-4000-8000-000000000012', repeat('d2', 32)
  ),
  '{"status":"restored"}'::jsonb,
  'recovery succeeds with a pending fact, correction, and disclosure'
);

select is(
  (
    select count(*)::bigint from private.location_use_facts
    where user_id = (select user_id from location_test_users where fixture_name = 'recovery_pending')
  ) + (
    select count(*)::bigint from private.location_correction_requests
    where user_id = (select user_id from location_test_users where fixture_name = 'recovery_pending')
  ) + (
    select count(*)::bigint from private.location_disclosure_accesses
    where user_id = (select user_id from location_test_users where fixture_name = 'recovery_pending')
  ) + (
    select count(*)::bigint from private.location_use_facts
    where user_id = (select user_id from location_test_users where fixture_name = 'recovery_pending_target')
  ) + (
    select count(*)::bigint from private.location_correction_requests
    where user_id = (select user_id from location_test_users where fixture_name = 'recovery_pending_target')
  ) + (
    select count(*)::bigint from private.location_disclosure_accesses
    where user_id = (select user_id from location_test_users where fixture_name = 'recovery_pending_target')
  ),
  0::bigint,
  'pending source rights rows are removed and never merged into the target'
);

select is(
  api_private.record_minimum_age_attestation(
    'a8000000-0000-4000-8000-000000000013',
    '{"minimum_age_passed":true,"version":"18plus-v1"}'::jsonb
  ),
  '{"status":"attested"}'::jsonb,
  'consent-only recovery source records the minimum-age marker'
);

select is(
  api_private.accept_location_consent(
    'a8000000-0000-4000-8000-000000000013',
    jsonb_build_object(
      'version', (
        select document_row.version
        from private.policy_documents as document_row
        where document_row.policy_type = 'location_terms'
          and document_row.is_current
      ),
      'locale', 'vi'
    )
  ) ->> 'status',
  'active',
  'consent-only recovery source records current location consent'
);

insert into private.recovery_codes (user_id, code_hash, issued_at)
values (
  (select user_id from location_test_users where fixture_name = 'recovery_consent_target'),
  decode(repeat('d3', 32), 'hex'),
  clock_timestamp()
);

select is(
  api_private.claim_recovery_code(
    'a8000000-0000-4000-8000-000000000013', repeat('d3', 32)
  ),
  '{"status":"restored"}'::jsonb,
  'recovery succeeds with consent-only source state'
);

select ok(
  not exists (
    select 1 from private.location_consents
    where user_id in (
      (select user_id from location_test_users where fixture_name = 'recovery_consent'),
      (select user_id from location_test_users where fixture_name = 'recovery_consent_target')
    )
  )
  and not exists (
    select 1
    from private.policy_acceptances as acceptance_row
    join private.policy_documents as document_row
      on document_row.id = acceptance_row.policy_document_id
    where acceptance_row.user_id in (
      (select user_id from location_test_users where fixture_name = 'recovery_consent'),
      (select user_id from location_test_users where fixture_name = 'recovery_consent_target')
    )
      and document_row.policy_type = 'location_terms'
  )
  and private.user_has_current_minimum_age_attestation(
    (select user_id from location_test_users where fixture_name = 'recovery_consent_target')
  ),
  'consent is not merged while the exact minimum-age pass marker still follows recovery'
);

-- A still-valid code can point at the claimant's current logical user after
-- its last acquisition was erased. This is a safe idempotent consume, not a
-- self-merge that may delete unrelated product or privacy state.
create temp table recovery_self_identity_fixture as
select identity_row.id
from private.user_identities as identity_row
where identity_row.auth_user_id = 'a8000000-0000-4000-8000-000000000013'
  and identity_row.user_id = (
    select user_id from location_test_users where fixture_name = 'recovery_consent_target'
  )
  and identity_row.revoked_at is null;

insert into private.participant_access (user_id, access_kind)
values (
  (select user_id from location_test_users where fixture_name = 'recovery_consent_target'),
  'internal_tester'
);

insert into public.physical_requests (user_id, kind)
values (
  (select user_id from location_test_users where fixture_name = 'recovery_consent_target'),
  'request'
);

insert into analytics.events (
  client_event_id, user_id, event_name, source, occurred_at, spot_id, properties
)
values (
  'e8300000-0000-4000-8000-000000000130',
  (select user_id from location_test_users where fixture_name = 'recovery_consent_target'),
  'spot_view', 'client', clock_timestamp(),
  'b8000000-0000-4000-8000-000000000001',
  '{"spot_id":"b8000000-0000-4000-8000-000000000001"}'::jsonb
);

insert into private.location_attempt_tombstones (
  owner_fingerprint, attempt_key_fingerprint, expires_at
)
values (
  private.location_attempt_owner_fingerprint(
    (select user_id from location_test_users where fixture_name = 'recovery_consent_target')
  ),
  private.location_attempt_key_fingerprint(
    'e8300000-0000-4000-8000-000000000131'
  ),
  clock_timestamp() + interval '6 months'
);

insert into private.recovery_codes (user_id, code_hash, issued_at)
values (
  (select user_id from location_test_users where fixture_name = 'recovery_consent_target'),
  decode(repeat('d4', 32), 'hex'),
  clock_timestamp()
);

select is(
  api_private.claim_recovery_code(
    'a8000000-0000-4000-8000-000000000013', repeat('d4', 32)
  ),
  '{"status":"restored"}'::jsonb,
  'same-target recovery consumes the code as a safe restored no-op'
);

select ok(
  exists (
    select 1
    from private.user_identities as identity_row
    where identity_row.id = (select id from recovery_self_identity_fixture)
      and identity_row.revoked_at is null
  )
  and exists (
    select 1 from private.recovery_codes
    where code_hash = decode(repeat('d4', 32), 'hex')
      and claimed_by_auth_user_id = 'a8000000-0000-4000-8000-000000000013'
      and claimed_at is not null
  )
  and exists (
    select 1 from private.participant_access
    where user_id = (
      select user_id from location_test_users where fixture_name = 'recovery_consent_target'
    ) and revoked_at is null
  )
  and exists (
    select 1 from public.physical_requests
    where user_id = (
      select user_id from location_test_users where fixture_name = 'recovery_consent_target'
    )
  )
  and exists (
    select 1 from analytics.events
    where client_event_id = 'e8300000-0000-4000-8000-000000000130'
      and user_id = (
        select user_id from location_test_users where fixture_name = 'recovery_consent_target'
      )
  )
  and private.user_has_current_minimum_age_attestation(
    (select user_id from location_test_users where fixture_name = 'recovery_consent_target')
  )
  and private.location_attempt_is_tombstoned(
    (select user_id from location_test_users where fixture_name = 'recovery_consent_target'),
    'e8300000-0000-4000-8000-000000000131'
  )
  and not exists (
    select 1 from private.recovery_claim_limits
    where auth_user_id = 'a8000000-0000-4000-8000-000000000013'
  ),
  'same-target recovery preserves identity, product state, age, analytics, and tombstones'
);

-- Recovery claim atomically preserves only the minimum-age pass marker ----

select is(
  api_private.record_minimum_age_attestation(
    'a8000000-0000-4000-8000-000000000006',
    '{"minimum_age_passed":true,"version":"18plus-v1"}'::jsonb
  ),
  '{"status":"attested"}'::jsonb,
  'first disposable claimant is attested before recovery'
);

insert into private.recovery_codes (user_id, code_hash, issued_at)
values (
  (select user_id from location_test_users where fixture_name = 'target_one'),
  decode(repeat('ab', 32), 'hex'),
  clock_timestamp()
);

select is(
  api_private.claim_recovery_code(
    'a8000000-0000-4000-8000-000000000006', repeat('ab', 32)
  ),
  '{"status":"restored"}'::jsonb,
  'successful recovery rebinds the disposable auth identity'
);

select ok(
  exists (
    select 1
    from private.minimum_age_attestations as attestation_row
    where attestation_row.user_id = (
      select user_id from location_test_users where fixture_name = 'target_one'
    )
      and attestation_row.minimum_age_passed
      and attestation_row.version = '18plus-v1'
  )
  and private.active_user_id_for_auth(
    'a8000000-0000-4000-8000-000000000006'
  ) = (select user_id from location_test_users where fixture_name = 'target_one'),
  'target without prior attestation receives only the exact pass marker in the claim transaction'
);

select is(
  api_private.record_minimum_age_attestation(
    'a8000000-0000-4000-8000-000000000009',
    '{"minimum_age_passed":true,"version":"18plus-v1"}'::jsonb
  ),
  '{"status":"attested"}'::jsonb,
  'second recovery target already has a valid attestation'
);

create temp table target_two_attestation_time as
select attested_at
from private.minimum_age_attestations
where user_id = (select user_id from location_test_users where fixture_name = 'target_two');

select is(
  api_private.record_minimum_age_attestation(
    'a8000000-0000-4000-8000-000000000008',
    '{"minimum_age_passed":true,"version":"18plus-v1"}'::jsonb
  ),
  '{"status":"attested"}'::jsonb,
  'second disposable claimant is also attested'
);

insert into private.recovery_codes (user_id, code_hash, issued_at)
values (
  (select user_id from location_test_users where fixture_name = 'target_two'),
  decode(repeat('cd', 32), 'hex'),
  clock_timestamp()
);

select is(
  api_private.claim_recovery_code(
    'a8000000-0000-4000-8000-000000000008', repeat('cd', 32)
  ),
  '{"status":"restored"}'::jsonb,
  'recovery also succeeds when the target was already attested'
);

select is(
  (
    select attested_at
    from private.minimum_age_attestations
    where user_id = (select user_id from location_test_users where fixture_name = 'target_two')
  ),
  (select attested_at from target_two_attestation_time),
  'target-side attestation timestamp wins an idempotent recovery merge'
);

select is(
  api_private.record_minimum_age_attestation(
    'a8000000-0000-4000-8000-000000000004',
    '{"minimum_age_passed":true,"version":"18plus-v1"}'::jsonb
  ),
  '{"status":"attested"}'::jsonb,
  'failed-claim fixture starts with a valid attestation'
);

select is(
  api_private.claim_recovery_code(
    'a8000000-0000-4000-8000-000000000004', repeat('ef', 32)
  ),
  '{"status":"not_found"}'::jsonb,
  'an invalid recovery digest fails without rebinding'
);

select ok(
  private.active_user_id_for_auth('a8000000-0000-4000-8000-000000000004') =
    (select user_id from location_test_users where fixture_name = 'other')
  and exists (
    select 1 from private.minimum_age_attestations
    where user_id = (select user_id from location_test_users where fixture_name = 'other')
  ),
  'failed recovery leaves both identity and source attestation unchanged'
);

-- Retention, open-correction hold, and unbounded retry counters ----------

insert into private.location_use_facts (
  user_id, idempotency_key, spot_id, purpose, collected_at, decided_at, outcome,
  terminal_failure_code, terminal_failure_details
)
values (
  (select user_id from location_test_users where fixture_name = 'target_one'),
  'e8700000-0000-4000-8000-000000000001',
  'b8000000-0000-4000-8000-000000000001',
  'field_acquisition', now() - interval '8 months', now() - interval '8 months', 'failed',
  'SPOT_NOT_OPEN', '{}'::jsonb
);

insert into private.location_correction_requests (
  id, user_id, location_use_fact_id, client_request_id, request_fingerprint,
  reason, status, requested_at
)
values (
  'e8700000-0000-4000-8000-000000000002',
  (select user_id from location_test_users where fixture_name = 'target_one'),
  (
    select id from private.location_use_facts
    where user_id = (select user_id from location_test_users where fixture_name = 'target_one')
      and idempotency_key = 'e8700000-0000-4000-8000-000000000001'
  ),
  'e8700000-0000-4000-8000-000000000003',
  decode(repeat('22', 32), 'hex'),
  'not_my_visit', 'open', now() - interval '7 months'
);

insert into private.location_disclosure_accesses (
  user_id, disclosed_count, accessed_at
)
values (
  (select user_id from location_test_users where fixture_name = 'target_one'),
  1, now() - interval '7 months'
);

insert into private.data_erasure_jobs (
  id, user_id, scope, state, requested_at, attempt_count,
  next_attempt_at, completed_at
)
values (
  'e8700000-0000-4000-8000-000000000004',
  (select user_id from location_test_users where fixture_name = 'target_one'),
  'location_withdrawal', 'completed', now() - interval '40 days', 2,
  now() - interval '39 days', now() - interval '39 days'
);

select is(
  api_private.purge_expired_location_compliance_records(5000) ->> 'status',
  'purged',
  'retention maintenance runs with an open correction hold'
);

select ok(
  exists (
    select 1 from private.location_use_facts
    where user_id = (select user_id from location_test_users where fixture_name = 'target_one')
      and idempotency_key = 'e8700000-0000-4000-8000-000000000001'
  )
  and not exists (
    select 1 from private.location_disclosure_accesses
    where user_id = (select user_id from location_test_users where fixture_name = 'target_one')
      and accessed_at < now() - interval '6 months'
  )
  and not exists (
    select 1 from private.data_erasure_jobs
    where id = 'e8700000-0000-4000-8000-000000000004'
  ),
  'open correction preserves its old fact while old disclosures and 30-day receipts purge'
);

update private.location_correction_requests
set status = 'rejected',
    resolved_at = now() - interval '7 months',
    resolved_by_auth_user_id = 'a8000000-0000-4000-8000-000000000001'
where id = 'e8700000-0000-4000-8000-000000000002';

select is(
  api_private.purge_expired_location_compliance_records(5000) ->> 'status',
  'purged',
  'resolved correction releases the old fact for normal retention purge'
);

select is(
  (
    select count(*)::bigint from private.location_use_facts
    where user_id = (select user_id from location_test_users where fixture_name = 'target_one')
      and idempotency_key = 'e8700000-0000-4000-8000-000000000001'
  ) + (
    select count(*)::bigint from private.location_correction_requests
    where id = 'e8700000-0000-4000-8000-000000000002'
  ),
  0::bigint,
  'resolved request and its fact purge after their explicit six-month periods'
);

insert into private.data_erasure_jobs (
  id, user_id, scope, state, requested_at, next_attempt_at
)
values (
  'e8700000-0000-4000-8000-000000000030',
  (select user_id from location_test_users where fixture_name = 'target_one'),
  'location_withdrawal', 'pending', now() - interval '3 days',
  now() - interval '1 minute'
);

insert into private.data_erasure_manifest (
  job_id, bucket, object_path, final_delete_after
)
select
  'e8700000-0000-4000-8000-000000000030',
  'personal-cards',
  (select user_id::text from location_test_users where fixture_name = 'target_one') ||
    '/bounded-' || item_number::text || '.webp',
  now() + interval '10 minutes'
from generate_series(1, 7) as item_number;

insert into private.data_erasure_jobs (
  id, user_id, scope, state, requested_at, next_attempt_at
)
values (
  'e8700000-0000-4000-8000-000000000031',
  (select user_id from location_test_users where fixture_name = 'target_two'),
  'location_withdrawal', 'pending', now() - interval '3 days',
  now() - interval '1 minute'
);

insert into private.data_erasure_manifest (
  job_id, bucket, object_path, final_delete_after
)
select
  'e8700000-0000-4000-8000-000000000031',
  'personal-cards',
  (select user_id::text from location_test_users where fixture_name = 'target_two') ||
    '/round-robin-' || item_number::text || '.webp',
  now() + interval '10 minutes'
from generate_series(1, 2) as item_number;

create temporary table bounded_erasure_claim as
select api_private.claim_data_erasure_jobs(
  'f8700000-0000-4000-8000-000000000030', 2, 4
) as result;

select is(
  (
    select sum(jsonb_array_length(job_row.job -> 'items'))::integer
    from bounded_erasure_claim as claim_row
    cross join lateral jsonb_array_elements(claim_row.result -> 'jobs') as job_row(job)
  ),
  4,
  'one worker claim hard-bounds the full invocation to four Storage items'
);

select is(
  (
    select count(*)::bigint
    from bounded_erasure_claim as claim_row
    cross join lateral jsonb_array_elements(claim_row.result -> 'jobs') as job_row(job)
    where jsonb_array_length(job_row.job -> 'items') = 2
  ),
  2::bigint,
  'the four-item cap offers both old jobs two items in round-robin order'
);

select is(
  api_private.claim_data_erasure_jobs(
    'f8700000-0000-4000-8000-000000000032', 3, 4
  ) ->> 'status',
  'invalid',
  'the database rejects job batches above the two-job runtime bound'
);

select is(
  api_private.claim_data_erasure_jobs(
    'f8700000-0000-4000-8000-000000000033', 2, 5
  ) ->> 'status',
  'invalid',
  'the database rejects manifest batches above four Storage items'
);

select is(
  api_private.finish_data_erasure_job(
    'f8700000-0000-4000-8000-000000000030',
    'e8700000-0000-4000-8000-000000000030'
  ),
  '{"status":"retry"}'::jsonb,
  'a partially offered manifest releases its lease for the next bounded cycle'
);

select is(
  api_private.finish_data_erasure_job(
    'f8700000-0000-4000-8000-000000000030',
    'e8700000-0000-4000-8000-000000000031'
  ),
  '{"status":"retry"}'::jsonb,
  'the second round-robin job also releases its lease after the partial batch'
);

insert into private.data_erasure_jobs (
  id, user_id, scope, state, requested_at, attempt_count, next_attempt_at
)
values (
  'e8700000-0000-4000-8000-000000000010',
  (select user_id from location_test_users where fixture_name = 'other'),
  'location_withdrawal', 'pending', now() - interval '2 days', 101,
  now() - interval '1 minute'
);

insert into private.data_erasure_manifest (
  job_id, bucket, object_path, attempt_count, last_attempt_at, final_delete_after
)
values (
  'e8700000-0000-4000-8000-000000000010',
  'personal-cards',
  (select user_id::text from location_test_users where fixture_name = 'other') ||
    '/retry-without-hard-limit.webp',
  25, now() - interval '1 minute', now() + interval '10 minutes'
);

select is(
  api_private.claim_data_erasure_jobs(
    'f8700000-0000-4000-8000-000000000001', 2, 4
  ) #>> '{jobs,0,items,0,phase}',
  'first',
  'a job beyond the former 100-attempt ceiling remains claimable'
);

select is(
  api_private.record_data_erasure_item_result(
    'f8700000-0000-4000-8000-000000000001',
    'e8700000-0000-4000-8000-000000000010',
    (
      select id from private.data_erasure_manifest
      where job_id = 'e8700000-0000-4000-8000-000000000010'
    ),
    false
  ),
  '{"status":"recorded"}'::jsonb,
  'a manifest beyond the former 20-attempt ceiling remains retryable'
);

insert into private.location_use_facts (
  user_id, idempotency_key, spot_id, purpose
)
values (
  (select user_id from location_test_users where fixture_name = 'target_one'),
  'e8700000-0000-4000-8000-000000000020',
  'b8000000-0000-4000-8000-000000000001',
  'field_acquisition'
);

insert into private.location_correction_requests (
  user_id, location_use_fact_id, client_request_id, request_fingerprint,
  reason, status, requested_at
)
select
  fact_row.user_id,
  fact_row.id,
  'e8700000-0000-4000-8000-000000000021',
  decode(repeat('33', 32), 'hex'),
  'other',
  'open',
  now() - interval '2 days'
from private.location_use_facts as fact_row
where fact_row.idempotency_key = 'e8700000-0000-4000-8000-000000000020';

select ok(
  (api_private.get_location_compliance_backlog() ->> 'high_attempt_jobs')::integer >= 1
  and (api_private.get_location_compliance_backlog() ->> 'max_attempt_count')::integer >= 102
  and (api_private.get_location_compliance_backlog() ->> 'overdue_jobs')::integer >= 1
  and (api_private.get_location_compliance_backlog() ->> 'open_corrections')::integer >= 1
  and (api_private.get_location_compliance_backlog() ->> 'overdue_open_corrections')::integer >= 1,
  'backlog exposes only aggregate erasure and overdue-correction alert counts'
);

-- Database trigger independently enforces age and re-consent cutover state.
delete from private.minimum_age_attestations
where user_id = (select user_id from location_test_users where fixture_name = 'correction');

insert into private.location_use_facts (
  user_id, idempotency_key, spot_id, purpose
)
values (
  (select user_id from location_test_users where fixture_name = 'correction'),
  'e8900000-0000-4000-8000-000000000002',
  'b8000000-0000-4000-8000-000000000001',
  'field_acquisition'
);

insert into public.acquisitions (
  id, user_id, spot_id, card_id, acquisition_type, verification_result,
  idempotency_key, field_sequence, acquired_at
)
values (
  'e8900000-0000-4000-8000-000000000001',
  (select user_id from location_test_users where fixture_name = 'correction'),
  'b8000000-0000-4000-8000-000000000001',
  'c8000000-0000-4000-8000-000000000001',
  'field', 'passed', 'e8900000-0000-4000-8000-000000000002', 999,
  now()
);

delete from private.location_use_facts
where user_id = (select user_id from location_test_users where fixture_name = 'correction')
  and idempotency_key = 'e8900000-0000-4000-8000-000000000002'
  and purpose = 'field_acquisition';

select throws_ok(
  $sql$
    insert into public.personal_cards (
      id, user_id, acquisition_id, photo_path, caption,
      share_resubmission_required, share_reason_code
    ) values (
      'f8900000-0000-4000-8000-000000000001',
      (select user_id from location_test_users where fixture_name = 'correction'),
      'e8900000-0000-4000-8000-000000000001',
      (select user_id::text from location_test_users where fixture_name = 'correction') ||
        '/location-reconsent.webp',
      'reconsent', true, 'LOCATION_RECONSENT_REQUIRED'
    )
  $sql$,
  '23514',
  'field personal-card derivatives require adult active current location consent',
  'field card INSERT is blocked by the DB trigger when age attestation is absent'
);

select is(
  api_private.record_minimum_age_attestation(
    'a8000000-0000-4000-8000-000000000005',
    '{"minimum_age_passed":true,"version":"18plus-v1"}'::jsonb
  ),
  '{"status":"attested"}'::jsonb,
  'the field-card fixture restores the exact adult attestation'
);

insert into public.personal_cards (
  id, user_id, acquisition_id, photo_path, caption,
  share_resubmission_required, share_reason_code
)
values (
  'f8900000-0000-4000-8000-000000000001',
  (select user_id from location_test_users where fixture_name = 'correction'),
  'e8900000-0000-4000-8000-000000000001',
  (select user_id::text from location_test_users where fixture_name = 'correction') ||
    '/location-reconsent.webp',
  'reconsent', true, 'LOCATION_RECONSENT_REQUIRED'
);

select is(
  api_private.acquire_context_unrated(
    'a8000000-0000-4000-8000-000000000005',
    'b8000000-0000-4000-8000-000000000001',
    'e8900000-0000-4000-8000-000000000002',
    true
  ) ->> 'status',
  'replay',
  'a retention-aged acquisition replays without a new location decision'
);

select is(
  (
    select count(*)::bigint
    from private.location_use_facts
    where user_id = (select user_id from location_test_users where fixture_name = 'correction')
      and idempotency_key = 'e8900000-0000-4000-8000-000000000002'
  ),
  0::bigint,
  'retention-aged replay does not recreate or re-date a location-use fact'
);

insert into private.location_use_facts (
  user_id, idempotency_key, spot_id, purpose
)
values (
  (select user_id from location_test_users where fixture_name = 'correction'),
  'e8910000-0000-4000-8000-000000000001',
  'b8000000-0000-4000-8000-000000000001',
  'field_acquisition'
);

select is(
  api_private.record_acquire_failure_unrated(
    'a8000000-0000-4000-8000-000000000005',
    'b8000000-0000-4000-8000-000000000001',
    'e8910000-0000-4000-8000-000000000001',
    'OUT_OF_RANGE',
    '{"distance_band":"near"}'::jsonb
  ),
  '{"code":"OUT_OF_RANGE","details":{"distance_band":"near"},"status":"failed"}'::jsonb,
  'first terminal failure atomically stores the bounded result and exact event'
);

select is(
  api_private.record_acquire_failure_unrated(
    'a8000000-0000-4000-8000-000000000005',
    'b8000000-0000-4000-8000-000000000001',
    'e8910000-0000-4000-8000-000000000001',
    'OUT_OF_RANGE',
    '{"distance_band":"far"}'::jsonb
  ),
  '{"code":"OUT_OF_RANGE","details":{"distance_band":"near"},"status":"failed"}'::jsonb,
  'duplicate failure replays the winning terminal details instead of overwriting them'
);

select is(
  api_private.acquire_context_unrated(
    'a8000000-0000-4000-8000-000000000005',
    'b8000000-0000-4000-8000-000000000001',
    'e8910000-0000-4000-8000-000000000001',
    true
  ),
  '{"code":"OUT_OF_RANGE","details":{"distance_band":"near"},"status":"error"}'::jsonb,
  'context transport retry deterministically replays the stored failure payload'
);

select is(
  (
    select count(*)::bigint
    from analytics.events as event_row
    join private.location_use_facts as fact_row
      on fact_row.id = event_row.location_use_fact_id
    where fact_row.idempotency_key = 'e8910000-0000-4000-8000-000000000001'
      and event_row.event_name = 'acquire_fail'
  ),
  1::bigint,
  'one logical failure has exactly one correlated terminal event'
);

select is(
  api_private.create_location_correction_request(
    'a8000000-0000-4000-8000-000000000005',
    (
      select id from private.location_use_facts
      where user_id = (select user_id from location_test_users where fixture_name = 'correction')
        and idempotency_key = 'e8910000-0000-4000-8000-000000000001'
    ),
    null,
    'e8910000-0000-4000-8000-000000000002',
    'incorrect_outcome'
  ) ->> 'status',
  'created',
  'a failed terminal fact can enter the correction workflow'
);

select is(
  api_private.resolve_location_correction_admin(
    'a8000000-0000-4000-8000-000000000001',
    (
      select id from private.location_correction_requests
      where client_request_id = 'e8910000-0000-4000-8000-000000000002'
    ),
    'accepted'
  ) ->> 'status',
  'correction_pending',
  'admin approval schedules failed-fact correction without claiming completion'
);

select is(
  api_private.acquire_context_unrated(
    'a8000000-0000-4000-8000-000000000005',
    'b8000000-0000-4000-8000-000000000001',
    'e8910000-0000-4000-8000-000000000001',
    true
  ) ->> 'code',
  'LOCATION_CORRECTION_PENDING',
  'failed-fact context reports pending correction before its tombstone'
);

select is(
  api_private.acquire_commit_unrated(
    'a8000000-0000-4000-8000-000000000005',
    'b8000000-0000-4000-8000-000000000001',
    'e8910000-0000-4000-8000-000000000001',
    true,
    (select updated_at from public.spots where id = 'b8000000-0000-4000-8000-000000000001')
  ) ->> 'code',
  'LOCATION_CORRECTION_PENDING',
  'failed-fact commit reports pending correction before its tombstone'
);

select is(
  api_private.record_acquire_failure_unrated(
    'a8000000-0000-4000-8000-000000000005',
    'b8000000-0000-4000-8000-000000000001',
    'e8910000-0000-4000-8000-000000000001',
    'OUT_OF_RANGE',
    '{"distance_band":"near"}'::jsonb
  ) ->> 'code',
  'LOCATION_CORRECTION_PENDING',
  'failed-fact failure reports pending correction before its tombstone'
);

select ok(
  (
    select share_state = 'private'
      and share_slug is null
      and share_resubmission_required
      and share_reason_code = 'LOCATION_RECONSENT_REQUIRED'
    from public.personal_cards
    where id = 'f8900000-0000-4000-8000-000000000001'
  ),
  'location cutover state contains no old secret and explicitly requires resubmission'
);

select is(
  api_private.accept_current_policies(
    'a8000000-0000-4000-8000-000000000005',
    jsonb_build_array(
      jsonb_build_object('type', 'terms_of_use', 'version', 'location-v2', 'locale', 'ja'),
      jsonb_build_object('type', 'community_guidelines', 'version', 'location-v2', 'locale', 'ja')
    )
  ),
  '{"status":"accepted"}'::jsonb,
  'field owner accepts current UGC policies before a fresh resubmission'
);

select is(
  api_private.create_personal_card_share(
    'a8000000-0000-4000-8000-000000000005', true, true,
    'f8900000-0000-4000-8000-000000000001',
    'LocationReconsentSlug01'
  ) ->> 'status',
  'pending',
  'fresh secret is created only after age, location, and UGC policy gates pass'
);

select is(
  api_private.revoke_personal_card_share(
    'a8000000-0000-4000-8000-000000000005',
    'f8900000-0000-4000-8000-000000000001'
  ) ->> 'status',
  'revoked',
  'resubmission fixture returns private through the owner revocation path'
);

select is(
  api_private.list_location_correction_subjects(
    'a8000000-0000-4000-8000-000000000005', 50, null, null
  ) #>> '{items,0,field_acquisition_id}',
  'e8900000-0000-4000-8000-000000000001',
  'active-identity privacy rights expose the surviving field acquisition subject'
);

select is(
  api_private.ingest_client_events(
    'a8000000-0000-4000-8000-000000000005',
    true,
    '[{"event_name":"acquire_attempt"}]'::jsonb
  ),
  '{"status":"invalid"}'::jsonb,
  'uncorrelated client acquire attempts are retired from ingestion'
);

select is(
  api_private.create_location_correction_request(
    'a8000000-0000-4000-8000-000000000005',
    null,
    'e8900000-0000-4000-8000-000000000001',
    'e8900000-0000-4000-8000-000000000010',
    'not_my_visit'
  ) ->> 'status',
  'created',
  'a retention-aged collection item accepts an owner-bound acquisition correction'
);

create temp table aged_correction_resolution_fixture as
select request_row.id as correction_request_id,
  api_private.resolve_location_correction_admin(
    'a8000000-0000-4000-8000-000000000001',
    request_row.id,
    'accepted'
  ) as result
from private.location_correction_requests as request_row
where request_row.client_request_id = 'e8900000-0000-4000-8000-000000000010';

select is(
  (select result ->> 'status' from aged_correction_resolution_fixture),
  'correction_pending',
  'admin approval marks the aged acquisition correction pending before worker completion'
);

create temp table aged_correction_job_fixture as
select job_row.id, resolution_row.correction_request_id
from aged_correction_resolution_fixture as resolution_row
join private.data_erasure_jobs as job_row
  on job_row.id = (resolution_row.result ->> 'erasure_job_id')::uuid;

select is(
  (select count(*)::bigint from aged_correction_job_fixture),
  1::bigint,
  'admin approval creates one targeted erasure job for the aged acquisition'
);

update private.data_erasure_manifest
set first_deleted_at = now() - interval '20 minutes',
    final_delete_after = now() - interval '10 minutes',
    deleted_at = now() - interval '5 minutes'
where job_id = (select id from aged_correction_job_fixture);

select is(
  api_private.claim_data_erasure_jobs(
    'f8900000-0000-4000-8000-000000000099', 2, 4
  ) #>> '{jobs,0,scope}',
  'location_correction',
  'aged acquisition correction becomes claimable after both Storage phases'
);

select is(
  api_private.finish_data_erasure_job(
    'f8900000-0000-4000-8000-000000000099',
    (select id from aged_correction_job_fixture)
  ),
  '{"status":"completed"}'::jsonb,
  'aged acquisition correction atomically erases the collection derivative'
);

select is(
  api_private.create_location_correction_request(
    'a8000000-0000-4000-8000-000000000005',
    null,
    'e8900000-0000-4000-8000-000000000001',
    'e8900000-0000-4000-8000-000000000010',
    'not_my_visit'
  ) ->> 'status',
  'duplicate',
  'immutable fingerprint replays the same correction after its FK subject is erased'
);

select is(
  api_private.create_location_correction_request(
    'a8000000-0000-4000-8000-000000000005',
    null,
    'e8900000-0000-4000-8000-000000000001',
    'e8900000-0000-4000-8000-000000000010',
    'wrong_spot'
  ) ->> 'status',
  'idempotency_conflict',
  'the same client key rejects a changed correction fingerprint after erasure'
);

select is(
  (
    select count(*)::bigint
    from public.acquisitions
    where id = 'e8900000-0000-4000-8000-000000000001'
  ) + (
    select count(*)::bigint
    from public.personal_cards
    where id = 'f8900000-0000-4000-8000-000000000001'
  ) + (
    select count(*)::bigint
    from private.data_erasure_manifest
    where job_id = (select id from aged_correction_job_fixture)
  ),
  0::bigint,
  'aged correction leaves no acquisition, card, or identifying manifest path'
);

select is(
  (
    select count(*)::bigint
    from public.personal_cards as card_row
    join public.acquisitions as acquisition_row
      on acquisition_row.id = card_row.acquisition_id
     and acquisition_row.user_id = card_row.user_id
    where acquisition_row.acquisition_type = 'field'
      and card_row.share_state in ('pending', 'active')
  ),
  0::bigint,
  'no field share remains pending or active after the privacy-cutover regression'
);

select * from finish();
rollback;
