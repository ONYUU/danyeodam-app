begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

-- Schema and ACL boundary -------------------------------------------------

select is(
  (
    select count(*)::bigint
    from information_schema.columns as column_row
    where column_row.table_schema = 'private'
      and column_row.table_name = 'personal_card_temp_uploads'
      and column_row.column_name in (
        'processing_token',
        'processing_started_at',
        'processing_expires_at',
        'processing_acquisition_id',
        'processing_permanent_path',
        'processing_caption',
        'cleanup_started_at'
      )
  ),
  7::bigint,
  'temporary upload rows contain the complete promotion and cleanup lease state'
);

select is(
  (
    select count(*)::bigint
    from pg_constraint as constraint_row
    where constraint_row.conrelid =
      'private.personal_card_temp_uploads'::regclass
      and constraint_row.conname in (
        'personal_card_temp_uploads_processing_state',
        'personal_card_temp_uploads_cleanup_claim_state',
        'personal_card_temp_uploads_cleanup_requires_claim'
      )
  ),
  3::bigint,
  'lease timestamps, bindings, and cleanup completion are constrained'
);

select is(
  (
    select count(*)::bigint
    from pg_class as index_row
    join pg_namespace as schema_row
      on schema_row.oid = index_row.relnamespace
    where schema_row.nspname = 'private'
      and index_row.relname in (
        'personal_card_temp_uploads_processing_token_idx',
        'personal_card_temp_uploads_processing_path_idx',
        'personal_card_temp_uploads_processing_expiry_idx',
        'personal_card_temp_uploads_cleanup_claim_idx'
      )
      and index_row.relkind = 'i'
  ),
  4::bigint,
  'processing and cleanup work queues have bounded partial indexes'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname in (
        'issue_personal_card_temp_upload',
        'cancel_personal_card_temp_upload_issue',
        'begin_personal_card_promotion',
        'complete_personal_card_promotion_with_size',
        'release_personal_card_promotion',
        'confirm_personal_card_permanent_unreferenced',
        'mark_personal_card_temp_deleted',
        'list_personal_card_expiry_cleanup',
        'list_personal_card_temp_cleanup',
        'complete_personal_card_temp_cleanup'
      )
  ),
  11::bigint,
  'all ten personal-card runtime RPC names and both upload overloads exist'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname in (
        'issue_personal_card_temp_upload',
        'cancel_personal_card_temp_upload_issue',
        'begin_personal_card_promotion',
        'complete_personal_card_promotion_with_size',
        'release_personal_card_promotion',
        'confirm_personal_card_permanent_unreferenced',
        'mark_personal_card_temp_deleted',
        'list_personal_card_expiry_cleanup',
        'list_personal_card_temp_cleanup',
        'complete_personal_card_temp_cleanup'
      )
      and function_row.prosecdef
      and coalesce(function_row.proconfig, array[]::text[])
        @> array['search_path=""']::text[]
  ),
  11::bigint,
  'all runtime RPC overloads are SECURITY DEFINER with an empty search_path'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname in (
        'issue_personal_card_temp_upload',
        'cancel_personal_card_temp_upload_issue',
        'begin_personal_card_promotion',
        'complete_personal_card_promotion_with_size',
        'release_personal_card_promotion',
        'confirm_personal_card_permanent_unreferenced',
        'mark_personal_card_temp_deleted',
        'list_personal_card_expiry_cleanup',
        'list_personal_card_temp_cleanup',
        'complete_personal_card_temp_cleanup'
      )
      and has_function_privilege('service_role', function_row.oid, 'EXECUTE')
  ),
  8::bigint,
  'service_role can execute only the eight live runtime RPCs after unified cleanup cutover'
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
        'issue_personal_card_temp_upload',
        'cancel_personal_card_temp_upload_issue',
        'begin_personal_card_promotion',
        'complete_personal_card_promotion_with_size',
        'release_personal_card_promotion',
        'confirm_personal_card_permanent_unreferenced',
        'mark_personal_card_temp_deleted',
        'list_personal_card_expiry_cleanup',
        'list_personal_card_temp_cleanup',
        'complete_personal_card_temp_cleanup'
      )
      and has_function_privilege(
        browser_role.role_name,
        function_row.oid,
        'EXECUTE'
      )
  ),
  0::bigint,
  'browser roles cannot execute any personal-card server RPC'
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
        'issue_personal_card_temp_upload',
        'cancel_personal_card_temp_upload_issue',
        'begin_personal_card_promotion',
        'complete_personal_card_promotion_with_size',
        'release_personal_card_promotion',
        'confirm_personal_card_permanent_unreferenced',
        'mark_personal_card_temp_deleted',
        'list_personal_card_expiry_cleanup',
        'list_personal_card_temp_cleanup',
        'complete_personal_card_temp_cleanup'
      )
      and acl_row.grantee = 0
      and acl_row.privilege_type = 'EXECUTE'
  ),
  0::bigint,
  'PUBLIC execute is explicitly absent from all ten RPCs'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname in (
        'issue_personal_card_temp_upload',
        'begin_personal_card_promotion',
        'complete_personal_card_promotion_with_size'
      )
      and (
        upper(pg_get_functiondef(function_row.oid)) like '%FOR SHARE%'
        or pg_get_functiondef(function_row.oid)
          like '%private.lock_active_user_id_for_auth%'
        or pg_get_functiondef(function_row.oid)
          like '%private.lock_field_derivative_access%'
        or pg_get_functiondef(function_row.oid)
          like '%private.consume_authenticated_api_rate_limit%'
        or pg_get_functiondef(function_row.oid)
          like '%private.lock_expected_active_user_id_for_auth%'
        or pg_get_functiondef(function_row.oid)
          like '%complete_personal_card_promotion_before_storage_quota%'
      )
  ),
  3::bigint,
  'every protected personal-card write share-locks its active identity'
);

select ok(
  (
    select upper(pg_get_functiondef(function_row.oid))
      like '%FOR UPDATE SKIP LOCKED%'
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname = 'list_personal_card_temp_cleanup'
  ),
  'cleanup workers skip rows already locked by another worker'
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
  ('a1000000-0000-4000-8000-000000000001', now(), now(), true, '{}'::jsonb),
  ('a1000000-0000-4000-8000-000000000002', now(), now(), true, '{}'::jsonb),
  ('a1000000-0000-4000-8000-000000000003', now(), now(), true, '{}'::jsonb),
  ('a1000000-0000-4000-8000-000000000004', now(), now(), true, '{}'::jsonb);

create temp table test_user_ids (
  fixture_name text primary key,
  user_id uuid not null
) on commit drop;

insert into test_user_ids (fixture_name, user_id)
select fixture.fixture_name, identity_row.user_id
from (
  values
    ('participant', 'a1000000-0000-4000-8000-000000000001'::uuid),
    ('gate_closed', 'a1000000-0000-4000-8000-000000000002'::uuid),
    ('other_owner', 'a1000000-0000-4000-8000-000000000003'::uuid),
    ('revoked', 'a1000000-0000-4000-8000-000000000004'::uuid)
) as fixture(fixture_name, auth_user_id)
join private.user_identities as identity_row
  on identity_row.auth_user_id = fixture.auth_user_id
 and identity_row.revoked_at is null;

insert into private.policy_documents (
  id, policy_type, version, effective_at, published_at, is_current
)
values
  (
    'a1100000-0000-4000-8000-000000000001',
    'terms_of_use', 'personal-card-test-1', now() - interval '1 day', now(), false
  ),
  (
    'a1100000-0000-4000-8000-000000000002',
    'privacy_policy', 'personal-card-test-1', now() - interval '1 day', now(), false
  ),
  (
    'a1100000-0000-4000-8000-000000000003',
    'community_guidelines', 'personal-card-test-1', now() - interval '1 day', now(), false
  ),
  (
    'a1100000-0000-4000-8000-000000000004',
    'location_terms', 'personal-card-test-1', now() - interval '1 day', now(), false
  );

insert into private.policy_document_locales (
  policy_document_id, locale, document_url, sha256
)
select
  policy_row.id,
  locale_row.locale,
  'https://policies.test/personal-card/' || policy_row.id::text || '/' || locale_row.locale::text,
  extensions.digest(policy_row.id::text || ':' || locale_row.locale::text, 'sha256')
from private.policy_documents as policy_row
cross join unnest(enum_range(null::public.content_locale)) as locale_row(locale)
where policy_row.version = 'personal-card-test-1';

select is(
  api_private.set_current_policy_documents((
    select array_agg(policy_row.id order by policy_row.id)
    from private.policy_documents as policy_row
    where policy_row.version = 'personal-card-test-1'
  )),
  '{"status":"switched"}'::jsonb,
  'personal-card policy fixtures use the serialized publication path'
);

insert into private.policy_acceptances (
  user_id, policy_document_id, accepted_locale, accepted_sha256
)
select
  user_row.user_id,
  policy_row.id,
  'ko'::public.content_locale,
  locale_row.sha256
from test_user_ids as user_row
cross join private.policy_documents as policy_row
join private.policy_document_locales as locale_row
  on locale_row.policy_document_id = policy_row.id
 and locale_row.locale = 'ko'
where policy_row.policy_type in ('terms_of_use', 'community_guidelines')
  and policy_row.is_current;

insert into private.minimum_age_attestations (
  user_id, minimum_age_passed, version
)
select user_id, true, '18plus-v1'
from test_user_ids;

do $fixture$
declare
  auth_id uuid;
begin
  for auth_id in
    select unnest(array[
      'a1000000-0000-4000-8000-000000000001'::uuid,
      'a1000000-0000-4000-8000-000000000002'::uuid,
      'a1000000-0000-4000-8000-000000000003'::uuid,
      'a1000000-0000-4000-8000-000000000004'::uuid
    ])
  loop
    perform api_private.accept_location_consent(
      auth_id,
      jsonb_build_object(
        'version', 'personal-card-test-1',
        'locale', 'ko'
      )
    );
  end loop;
end;
$fixture$;

insert into private.participant_access (user_id, access_kind)
select user_id, 'internal_tester'
from test_user_ids
where fixture_name in ('participant', 'other_owner', 'revoked');

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
  'a1000000-0000-4000-8000-000000000001'
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
  'b1000000-0000-4000-8000-000000000001',
  'personal-card-test',
  'test',
  '개인 카드 테스트',
  'Personal Card Test',
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
  'b1000000-0000-4000-8000-000000000001',
  locale_row.locale,
  case
    when locale_row.locale = 'ko' then '개인 카드 테스트'
    else 'Personal Card Test'
  end,
  'approved',
  now(),
  'a1000000-0000-4000-8000-000000000001'
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
  'c1000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001',
  'personal-card-test',
  'region',
  '개인 카드',
  'Personal Card',
  'cards/personal-card-test.webp',
  '#123456',
  false,
  null
);

insert into public.card_translations (
  card_id, locale, title, status, approved_at, approved_by
)
select
  'c1000000-0000-4000-8000-000000000001',
  locale_row.locale,
  case
    when locale_row.locale = 'ko' then '개인 카드'
    else 'Personal Card'
  end,
  'approved',
  now(),
  'a1000000-0000-4000-8000-000000000001'
from unnest(enum_range(null::public.content_locale))
  as locale_row(locale);

update public.cards
set is_published = true,
    published_at = now()
where id = 'c1000000-0000-4000-8000-000000000001';

update public.spots
set status = 'open'
where id = 'b1000000-0000-4000-8000-000000000001';

insert into private.location_use_facts (
  user_id, idempotency_key, spot_id, purpose
)
values
  (
    (select user_id from test_user_ids where fixture_name = 'participant'),
    'e1000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000001',
    'field_acquisition'
  ),
  (
    (select user_id from test_user_ids where fixture_name = 'participant'),
    'e1000000-0000-4000-8000-000000000002',
    'b1000000-0000-4000-8000-000000000001',
    'field_acquisition'
  ),
  (
    (select user_id from test_user_ids where fixture_name = 'other_owner'),
    'e1000000-0000-4000-8000-000000000003',
    'b1000000-0000-4000-8000-000000000001',
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
    'd1000000-0000-4000-8000-000000000001',
    (select user_id from test_user_ids where fixture_name = 'participant'),
    'b1000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000001',
    'field',
    'passed',
    'e1000000-0000-4000-8000-000000000001',
    1,
    now()
  ),
  (
    'd1000000-0000-4000-8000-000000000002',
    (select user_id from test_user_ids where fixture_name = 'participant'),
    'b1000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000001',
    'field',
    'passed',
    'e1000000-0000-4000-8000-000000000002',
    2,
    now() - interval '1 day'
  ),
  (
    'd1000000-0000-4000-8000-000000000003',
    (select user_id from test_user_ids where fixture_name = 'other_owner'),
    'b1000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000001',
    'field',
    'passed',
    'e1000000-0000-4000-8000-000000000003',
    3,
    now()
  );

create temp table test_uploads (
  fixture_name text primary key,
  upload_id uuid not null,
  temp_path text not null
) on commit drop;

-- Issue boundary ---------------------------------------------------------

select is(
  api_private.issue_personal_card_temp_upload(
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    true,
    'image/jpeg',
    123::bigint
  ),
  '{"status":"unauthorized"}'::jsonb,
  'a missing active identity cannot issue an upload path'
);

select is(
  api_private.issue_personal_card_temp_upload(
    'a1000000-0000-4000-8000-000000000002',
    false,
    'image/jpeg',
    123::bigint
  ),
  '{"status":"gate_closed"}'::jsonb,
  'closed recruitment requires active participant access'
);

select is(
  api_private.issue_personal_card_temp_upload(
    'a1000000-0000-4000-8000-000000000001',
    false,
    'image/gif',
    123::bigint
  ),
  '{"status":"validation_failed"}'::jsonb,
  'only the three declared image MIME types are accepted'
);

select is(
  api_private.issue_personal_card_temp_upload(
    'a1000000-0000-4000-8000-000000000001',
    false,
    'image/png',
    10485761::bigint
  ),
  '{"status":"validation_failed"}'::jsonb,
  'declared uploads larger than 10 MiB are rejected'
);

insert into test_uploads (fixture_name, upload_id, temp_path)
select
  'primary',
  (issued.result ->> 'upload_id')::uuid,
  issued.result ->> 'temp_path'
from (
  select api_private.issue_personal_card_temp_upload(
    'a1000000-0000-4000-8000-000000000001',
    false,
    'image/jpeg',
    123::bigint
  ) as result
) as issued;

insert into test_uploads (fixture_name, upload_id, temp_path)
select
  'public_gate',
  (issued.result ->> 'upload_id')::uuid,
  issued.result ->> 'temp_path'
from (
  select api_private.issue_personal_card_temp_upload(
    'a1000000-0000-4000-8000-000000000002',
    true,
    'image/png',
    456::bigint
  ) as result
) as issued;

select ok(
  (
    select
      upload_row.temp_path = upload_row.user_id::text || '/' ||
        upload_row.id::text || '.jpg'
      and upload_row.promotion_expires_at =
        upload_row.issued_at + interval '10 minutes'
      and upload_row.signed_url_expires_at =
        upload_row.issued_at + interval '2 hours'
      and upload_row.declared_size_bytes = 123
    from private.personal_card_temp_uploads as upload_row
    join test_uploads as fixture on fixture.upload_id = upload_row.id
    where fixture.fixture_name = 'primary'
  ),
  'the database generates an owned path with exact 10-minute and 2-hour clocks'
);

update private.user_identities
set revoked_at = clock_timestamp()
where auth_user_id = 'a1000000-0000-4000-8000-000000000004'
  and revoked_at is null;

select is(
  api_private.issue_personal_card_temp_upload(
    'a1000000-0000-4000-8000-000000000004',
    false,
    'image/jpeg',
    123::bigint
  ),
  '{"status":"unauthorized"}'::jsonb,
  'a revoked binding is rejected even while its JWT could still be valid'
);

-- Begin lease, ownership, and promotion timing ---------------------------

select is(
  api_private.begin_personal_card_promotion(
    'a1000000-0000-4000-8000-000000000003',
    false,
    'd1000000-0000-4000-8000-000000000003',
    (select temp_path from test_uploads where fixture_name = 'primary'),
    '타인 소유',
    'f1000000-0000-4000-8000-000000000001'
  ),
  '{"status":"not_found"}'::jsonb,
  'another owner cannot claim a temporary path even with a valid acquisition'
);

select is(
  api_private.begin_personal_card_promotion(
    'a1000000-0000-4000-8000-000000000002',
    false,
    'd1000000-0000-4000-8000-000000000001',
    (select temp_path from test_uploads where fixture_name = 'primary'),
    '',
    'f1000000-0000-4000-8000-000000000002'
  ),
  '{"status":"gate_closed"}'::jsonb,
  'promotion begin independently rechecks the participant gate'
);

select is(
  api_private.begin_personal_card_promotion(
    'a1000000-0000-4000-8000-000000000001',
    false,
    'd1000000-0000-4000-8000-000000000003',
    (select temp_path from test_uploads where fixture_name = 'primary'),
    '',
    'f1000000-0000-4000-8000-000000000003'
  ),
  '{"status":"not_found"}'::jsonb,
  'a caller cannot bind its upload to another user acquisition'
);

insert into private.personal_card_temp_uploads (
  id,
  user_id,
  temp_path,
  declared_content_type,
  declared_size_bytes,
  issued_at,
  promotion_expires_at,
  signed_url_expires_at
)
select
  'e1000000-0000-4000-8000-000000000010',
  user_id,
  user_id::text || '/e1000000-0000-4000-8000-000000000010.jpg',
  'image/jpeg',
  123,
  now() - interval '11 minutes',
  now() - interval '1 minute',
  now() + interval '1 hour 49 minutes'
from test_user_ids
where fixture_name = 'participant';

select is(
  api_private.begin_personal_card_promotion(
    'a1000000-0000-4000-8000-000000000001',
    false,
    'd1000000-0000-4000-8000-000000000001',
    (
      select temp_path
      from private.personal_card_temp_uploads
      where id = 'e1000000-0000-4000-8000-000000000010'
    ),
    '',
    'f1000000-0000-4000-8000-000000000010'
  ),
  '{"status":"expired"}'::jsonb,
  'promotion cannot start after the exact 10-minute window'
);

-- The synthetic expired row is isolated to the assertion above; otherwise it
-- consumes one of the later active-upload quota fixtures.
delete from private.personal_card_temp_uploads
where id = 'e1000000-0000-4000-8000-000000000010';

select is(
  api_private.begin_personal_card_promotion(
    'a1000000-0000-4000-8000-000000000001',
    false,
    'd1000000-0000-4000-8000-000000000001',
    (select temp_path from test_uploads where fixture_name = 'primary'),
    repeat('x', 61),
    'f1000000-0000-4000-8000-000000000011'
  ),
  '{"status":"validation_failed"}'::jsonb,
  'captions longer than 60 characters cannot enter a lease'
);

select is(
  api_private.begin_personal_card_promotion(
    'a1000000-0000-4000-8000-000000000001',
    false,
    'd1000000-0000-4000-8000-000000000001',
    (select temp_path from test_uploads where fixture_name = 'primary'),
    '기억',
    'f1000000-0000-4000-8000-000000000001'
  ) ->> 'status',
  'ready',
  'an owned acquisition and upload receive one processing lease'
);

select ok(
  (
    select
      upload_row.processing_token =
        'f1000000-0000-4000-8000-000000000001'::uuid
      and upload_row.processing_acquisition_id =
        'd1000000-0000-4000-8000-000000000001'::uuid
      and upload_row.processing_caption = '기억'
      and upload_row.processing_permanent_path =
        upload_row.user_id::text || '/' ||
          upload_row.processing_token::text || '.webp'
      and upload_row.processing_expires_at <= upload_row.promotion_expires_at
    from private.personal_card_temp_uploads as upload_row
    join test_uploads as fixture on fixture.upload_id = upload_row.id
    where fixture.fixture_name = 'primary'
  ),
  'the lease binds token, acquisition, caption, and a token-unique output path'
);

select is(
  api_private.begin_personal_card_promotion(
    'a1000000-0000-4000-8000-000000000001',
    false,
    'd1000000-0000-4000-8000-000000000001',
    (select temp_path from test_uploads where fixture_name = 'primary'),
    '기억',
    'f1000000-0000-4000-8000-000000000001'
  ) ->> 'status',
  'ready',
  'the same logical begin retry replays the ready lease'
);

select is(
  api_private.begin_personal_card_promotion(
    'a1000000-0000-4000-8000-000000000001',
    false,
    'd1000000-0000-4000-8000-000000000001',
    (select temp_path from test_uploads where fixture_name = 'primary'),
    '바꾼 시도',
    'f1000000-0000-4000-8000-000000000001'
  ),
  '{"status":"processing"}'::jsonb,
  'the same token cannot alter a caption while its lease is active'
);

select is(
  api_private.begin_personal_card_promotion(
    'a1000000-0000-4000-8000-000000000001',
    false,
    'd1000000-0000-4000-8000-000000000001',
    (select temp_path from test_uploads where fixture_name = 'primary'),
    '기억',
    'f1000000-0000-4000-8000-000000000099'
  ),
  '{"status":"processing"}'::jsonb,
  'a second token cannot steal an active upload lease'
);

-- Completion parameter binding and atomic server fact -------------------

select is(
  api_private.complete_personal_card_promotion_with_size_unbound(
    'a1000000-0000-4000-8000-000000000001',
    (select upload_id from test_uploads where fixture_name = 'primary'),
    'f1000000-0000-4000-8000-000000000001',
    'd1000000-0000-4000-8000-000000000002',
    (
      select processing_permanent_path
      from private.personal_card_temp_uploads
      where id = (select upload_id from test_uploads where fixture_name = 'primary')
    ),
    '기억',
    1
  ),
  '{"status":"stale"}'::jsonb,
  'a valid processing token cannot switch acquisitions at completion'
);

select is(
  api_private.complete_personal_card_promotion_with_size_unbound(
    'a1000000-0000-4000-8000-000000000001',
    (select upload_id from test_uploads where fixture_name = 'primary'),
    'f1000000-0000-4000-8000-000000000001',
    'd1000000-0000-4000-8000-000000000001',
    (
      select user_id::text || '/redirected.webp'
      from test_user_ids
      where fixture_name = 'participant'
    ),
    '기억',
    1
  ),
  '{"status":"stale"}'::jsonb,
  'a valid processing token cannot redirect the permanent object path'
);

select is(
  api_private.complete_personal_card_promotion_with_size_unbound(
    'a1000000-0000-4000-8000-000000000001',
    (select upload_id from test_uploads where fixture_name = 'primary'),
    'f1000000-0000-4000-8000-000000000001',
    'd1000000-0000-4000-8000-000000000001',
    (
      select processing_permanent_path
      from private.personal_card_temp_uploads
      where id = (select upload_id from test_uploads where fixture_name = 'primary')
    ),
    '변조된 캡션',
    1
  ),
  '{"status":"stale"}'::jsonb,
  'a valid processing token cannot alter its caption at completion'
);

select is(
  api_private.complete_personal_card_promotion_with_size_unbound(
    'a1000000-0000-4000-8000-000000000001',
    (select upload_id from test_uploads where fixture_name = 'primary'),
    'f1000000-0000-4000-8000-000000000099',
    'd1000000-0000-4000-8000-000000000001',
    (
      select processing_permanent_path
      from private.personal_card_temp_uploads
      where id = (select upload_id from test_uploads where fixture_name = 'primary')
    ),
    '기억',
    1
  ),
  '{"status":"stale"}'::jsonb,
  'an unrelated processing token cannot complete the upload'
);

select is(
  (
    select count(*)::bigint
    from public.personal_cards
    where acquisition_id = 'd1000000-0000-4000-8000-000000000001'
  ),
  0::bigint,
  'no tampered completion creates a personal card'
);

select is(
  api_private.complete_personal_card_promotion_with_size_unbound(
    'a1000000-0000-4000-8000-000000000001',
    (select upload_id from test_uploads where fixture_name = 'primary'),
    'f1000000-0000-4000-8000-000000000001',
    'd1000000-0000-4000-8000-000000000001',
    (
      select processing_permanent_path
      from private.personal_card_temp_uploads
      where id = (select upload_id from test_uploads where fixture_name = 'primary')
    ),
    '기억',
    1
  ) ->> 'status',
  'created',
  'the exact lease parameters atomically create a personal card'
);

select ok(
  (
    select
      card_row.user_id = upload_row.user_id
      and card_row.photo_path =
        upload_row.user_id::text || '/' ||
          upload_row.processing_token::text || '.webp'
      and card_row.caption = '기억'
      and upload_row.promoted_at is not null
      and upload_row.permanent_path = card_row.photo_path
    from public.personal_cards as card_row
    join private.personal_card_temp_uploads as upload_row
      on upload_row.processing_acquisition_id = card_row.acquisition_id
    where card_row.acquisition_id =
      'd1000000-0000-4000-8000-000000000001'
  ),
  'the card and upload metadata retain the same DB-generated path and owner'
);

select is(
  (
    select count(*)::bigint
    from analytics.events as event_row
    where event_row.event_name = 'personal_card_created'
      and event_row.source = 'server'
      and event_row.user_id = (
        select user_id from test_user_ids where fixture_name = 'participant'
      )
      and event_row.properties = '{}'::jsonb
  ),
  1::bigint,
  'successful completion creates exactly one strict server fact event'
);

select is(
  api_private.complete_personal_card_promotion_with_size_unbound(
    'a1000000-0000-4000-8000-000000000001',
    (select upload_id from test_uploads where fixture_name = 'primary'),
    'f1000000-0000-4000-8000-000000000001',
    'd1000000-0000-4000-8000-000000000001',
    (
      select processing_permanent_path
      from private.personal_card_temp_uploads
      where id = (select upload_id from test_uploads where fixture_name = 'primary')
    ),
    '기억',
    1
  ) ->> 'personal_card_id',
  (
    select id::text
    from public.personal_cards
    where acquisition_id = 'd1000000-0000-4000-8000-000000000001'
  ),
  'an exact completion retry returns the already-created card identifier'
);

select is(
  (
    select count(*)::bigint
    from analytics.events
    where event_name = 'personal_card_created'
      and user_id = (
        select user_id from test_user_ids where fixture_name = 'participant'
      )
  ),
  1::bigint,
  'an idempotent completion retry does not duplicate the server fact'
);

select is(
  api_private.release_personal_card_promotion(
    (select upload_id from test_uploads where fixture_name = 'primary'),
    'f1000000-0000-4000-8000-000000000001'
  ),
  '{"status":"stale"}'::jsonb,
  'a completed promotion cannot be released back into the work queue'
);

select is(
  api_private.confirm_personal_card_permanent_unreferenced(
    (select upload_id from test_uploads where fixture_name = 'primary'),
    'f1000000-0000-4000-8000-000000000001',
    (
      select permanent_path
      from private.personal_card_temp_uploads
      where id = (select upload_id from test_uploads where fixture_name = 'primary')
    )
  ),
  '{"status":"referenced"}'::jsonb,
  'compensation never authorizes deletion of the committed winner object'
);

-- Release, deletion, and expired completion ------------------------------

insert into test_uploads (fixture_name, upload_id, temp_path)
select
  'release',
  (issued.result ->> 'upload_id')::uuid,
  issued.result ->> 'temp_path'
from (
  select api_private.issue_personal_card_temp_upload(
    'a1000000-0000-4000-8000-000000000001',
    false,
    'image/webp',
    789::bigint
  ) as result
) as issued;

select is(
  api_private.begin_personal_card_promotion(
    'a1000000-0000-4000-8000-000000000001',
    false,
    'd1000000-0000-4000-8000-000000000002',
    (select temp_path from test_uploads where fixture_name = 'release'),
    '',
    'f1000000-0000-4000-8000-000000000002'
  ) ->> 'status',
  'ready',
  'a second acquisition can enter a separate lease'
);

select is(
  api_private.release_personal_card_promotion(
    (select upload_id from test_uploads where fixture_name = 'release'),
    'f1000000-0000-4000-8000-000000000099'
  ),
  '{"status":"stale"}'::jsonb,
  'the wrong token cannot release another worker lease'
);

select is(
  api_private.release_personal_card_promotion(
    (select upload_id from test_uploads where fixture_name = 'release'),
    'f1000000-0000-4000-8000-000000000002'
  ),
  '{"status":"updated"}'::jsonb,
  'the matching worker can release an uncompleted lease'
);

select ok(
  (
    select
      processing_token is null
      and processing_started_at is null
      and processing_expires_at is null
      and processing_acquisition_id is null
      and processing_permanent_path is null
      and processing_caption is null
    from private.personal_card_temp_uploads
    where id = (select upload_id from test_uploads where fixture_name = 'release')
  ),
  'release clears every bound lease value together'
);

insert into test_uploads (fixture_name, upload_id, temp_path)
select
  'takeover',
  (issued.result ->> 'upload_id')::uuid,
  issued.result ->> 'temp_path'
from (
  select api_private.issue_personal_card_temp_upload(
    'a1000000-0000-4000-8000-000000000001',
    false,
    'image/jpeg',
    321::bigint
  ) as result
) as issued;

select is(
  api_private.begin_personal_card_promotion(
    'a1000000-0000-4000-8000-000000000001',
    false,
    'd1000000-0000-4000-8000-000000000002',
    (select temp_path from test_uploads where fixture_name = 'takeover'),
    '첫 처리자',
    'f1000000-0000-4000-8000-000000000020'
  ) ->> 'permanent_path',
  (
    select user_id::text || '/f1000000-0000-4000-8000-000000000020.webp'
    from test_user_ids
    where fixture_name = 'participant'
  ),
  'the first worker receives its own processing-token path'
);

update private.personal_card_temp_uploads
set processing_expires_at = processing_started_at + interval '1 microsecond'
where id = (select upload_id from test_uploads where fixture_name = 'takeover');

select is(
  api_private.begin_personal_card_promotion(
    'a1000000-0000-4000-8000-000000000001',
    false,
    'd1000000-0000-4000-8000-000000000002',
    (select temp_path from test_uploads where fixture_name = 'takeover'),
    '승리 처리자',
    'f1000000-0000-4000-8000-000000000021'
  ) ->> 'permanent_path',
  (
    select user_id::text || '/f1000000-0000-4000-8000-000000000021.webp'
    from test_user_ids
    where fixture_name = 'participant'
  ),
  'a takeover receives a different processing-token path'
);

select is(
  api_private.confirm_personal_card_permanent_unreferenced(
    (select upload_id from test_uploads where fixture_name = 'takeover'),
    'f1000000-0000-4000-8000-000000000020',
    (
      select user_id::text || '/f1000000-0000-4000-8000-000000000020.webp'
      from test_user_ids
      where fixture_name = 'participant'
    )
  ),
  '{"status":"unreferenced"}'::jsonb,
  'the stale worker path is deletable only after the DB confirms no reference'
);

select ok(
  (
    select
      processing_token = 'f1000000-0000-4000-8000-000000000021'::uuid
      and processing_permanent_path =
        user_id::text || '/f1000000-0000-4000-8000-000000000021.webp'
      and processing_caption = '승리 처리자'
    from private.personal_card_temp_uploads
    where id = (select upload_id from test_uploads where fixture_name = 'takeover')
  ),
  'stale-worker compensation cannot clear or redirect the winner lease'
);

select is(
  api_private.release_personal_card_promotion(
    (select upload_id from test_uploads where fixture_name = 'takeover'),
    'f1000000-0000-4000-8000-000000000021'
  ),
  '{"status":"updated"}'::jsonb,
  'the winner lease remains independently releasable after stale cleanup'
);

select is(
  api_private.mark_personal_card_temp_deleted(
    (select upload_id from test_uploads where fixture_name = 'release')
  ),
  '{"status":"updated"}'::jsonb,
  'a confirmed Storage deletion records its temporary-object marker'
);

select is(
  api_private.begin_personal_card_promotion(
    'a1000000-0000-4000-8000-000000000001',
    false,
    'd1000000-0000-4000-8000-000000000002',
    (select temp_path from test_uploads where fixture_name = 'release'),
    '',
    'f1000000-0000-4000-8000-000000000003'
  ),
  '{"status":"not_found"}'::jsonb,
  'a deleted temporary object cannot be promoted using a still-valid URL'
);

insert into private.personal_card_temp_uploads (
  id,
  user_id,
  temp_path,
  declared_content_type,
  declared_size_bytes,
  issued_at,
  promotion_expires_at,
  signed_url_expires_at
)
select
  'e1000000-0000-4000-8000-000000000011',
  user_id,
  user_id::text || '/e1000000-0000-4000-8000-000000000011.png',
  'image/png',
  123,
  now() - interval '9 minutes',
  now() + interval '1 minute',
  now() + interval '1 hour 51 minutes'
from test_user_ids
where fixture_name = 'participant';

-- Enter the processing state through the same UPDATE boundary used by begin,
-- so the compatibility trigger durably registers both object paths.
update private.personal_card_temp_uploads
set processing_token = 'f1000000-0000-4000-8000-000000000011',
    processing_started_at = now() - interval '8 minutes',
    processing_expires_at = now() - interval '3 minutes',
    processing_acquisition_id = 'd1000000-0000-4000-8000-000000000002',
    processing_permanent_path =
      user_id::text || '/f1000000-0000-4000-8000-000000000011.webp',
    processing_caption = ''
where id = 'e1000000-0000-4000-8000-000000000011';

select is(
  api_private.complete_personal_card_promotion_with_size_unbound(
    'a1000000-0000-4000-8000-000000000001',
    'e1000000-0000-4000-8000-000000000011',
    'f1000000-0000-4000-8000-000000000011',
    'd1000000-0000-4000-8000-000000000002',
    (
      select processing_permanent_path
      from private.personal_card_temp_uploads
      where id = 'e1000000-0000-4000-8000-000000000011'
    ),
    '',
    1
  ),
  '{"status":"expired"}'::jsonb,
  'completion rejects a worker whose bounded processing lease expired'
);

-- Cleanup claim and completion ------------------------------------------

insert into private.personal_card_temp_uploads (
  id,
  user_id,
  temp_path,
  declared_content_type,
  declared_size_bytes,
  issued_at,
  promotion_expires_at,
  signed_url_expires_at,
  cleanup_started_at
)
select
  fixture.upload_id,
  user_row.user_id,
  user_row.user_id::text || '/' || fixture.upload_id::text || '.jpg',
  'image/jpeg',
  123,
  fixture.issued_at,
  fixture.issued_at + interval '10 minutes',
  fixture.issued_at + interval '2 hours',
  fixture.cleanup_started_at
from test_user_ids as user_row
cross join (
  values
    (
      'e1000000-0000-4000-8000-000000000020'::uuid,
      now() - interval '3 hours',
      null::timestamptz
    ),
    (
      'e1000000-0000-4000-8000-000000000021'::uuid,
      now(),
      null::timestamptz
    ),
    (
      'e1000000-0000-4000-8000-000000000022'::uuid,
      now() - interval '3 hours',
      now()
    ),
    (
      'e1000000-0000-4000-8000-000000000023'::uuid,
      now() - interval '4 hours',
      now() - interval '20 minutes'
    )
) as fixture(upload_id, issued_at, cleanup_started_at)
where user_row.fixture_name = 'participant';

select is(
  api_private.complete_personal_card_temp_cleanup(
    'e1000000-0000-4000-8000-000000000021'
  ),
  '{"status":"stale"}'::jsonb,
  'cleanup cannot complete before the two-hour signed URL expires'
);

create temp table test_cleanup_result (
  result jsonb not null
) on commit drop;

insert into test_cleanup_result (result)
values (api_private.list_personal_card_temp_cleanup(100));

select is(
  (select jsonb_array_length(result) from test_cleanup_result),
  2,
  'cleanup claims only expired, unclaimed or stale-claimed rows'
);

select ok(
  (
    select result @> jsonb_build_array(
      jsonb_build_object(
        'upload_id', 'e1000000-0000-4000-8000-000000000020',
        'temp_path', (
          select temp_path
          from private.personal_card_temp_uploads
          where id = 'e1000000-0000-4000-8000-000000000020'
        )
      ),
      jsonb_build_object(
        'upload_id', 'e1000000-0000-4000-8000-000000000023',
        'temp_path', (
          select temp_path
          from private.personal_card_temp_uploads
          where id = 'e1000000-0000-4000-8000-000000000023'
        )
      )
    )
    from test_cleanup_result
  ),
  'cleanup returns only DB-owned identifiers and exact temporary paths'
);

select is(
  api_private.complete_personal_card_temp_cleanup(
    'e1000000-0000-4000-8000-000000000020'
  ),
  '{"status":"updated"}'::jsonb,
  'a claimed expired object can finish cleanup'
);

select ok(
  (
    select
      temp_deleted_at is not null
      and cleanup_completed_at is not null
      and temp_deleted_at = cleanup_completed_at
    from private.personal_card_temp_uploads
    where id = 'e1000000-0000-4000-8000-000000000020'
  ),
  'cleanup writes deletion and completion markers in the same atomic update'
);

select is(
  api_private.complete_personal_card_temp_cleanup(
    'e1000000-0000-4000-8000-000000000020'
  ),
  '{"status":"updated"}'::jsonb,
  'cleanup completion is idempotent after success'
);

select is(
  api_private.list_personal_card_temp_cleanup(100),
  '[]'::jsonb,
  'a completed row and recently claimed rows are not immediately reissued'
);

select is(
  api_private.complete_personal_card_temp_cleanup(
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  ),
  '{"status":"not_found"}'::jsonb,
  'cleanup completion does not fabricate a missing upload row'
);

select * from finish();
rollback;
