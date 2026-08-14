begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

-- Schema, RLS, and ACL ---------------------------------------------------

select set_eq(
  $$ select unnest(enum_range(null::public.personal_card_share_state))::text $$,
  $$
    values
      ('private'::text),
      ('pending'::text),
      ('active'::text),
      ('rejected'::text),
      ('taken_down'::text)
  $$,
  'share moderation exposes exactly the canonical five states'
);

select is(
  (
    select count(*)::bigint
    from pg_class as relation_row
    join pg_namespace as schema_row on schema_row.oid = relation_row.relnamespace
    where schema_row.nspname = 'private'
      and relation_row.relname in (
        'policy_documents',
        'policy_document_locales',
        'policy_acceptances',
        'share_owner_suspensions',
        'user_blocks',
        'user_block_actions',
        'content_reports',
        'public_report_rate_limits',
        'moderation_actions'
      )
      and relation_row.relrowsecurity
      and relation_row.relforcerowsecurity
  ),
  9::bigint,
  'all policy and moderation tables enable and force RLS'
);

select is(
  (
    select count(*)::bigint
    from unnest(array[
      'private.policy_documents',
      'private.policy_document_locales',
      'private.policy_acceptances',
      'private.share_owner_suspensions',
      'private.user_blocks',
      'private.user_block_actions',
      'private.content_reports',
      'private.public_report_rate_limits',
      'private.moderation_actions'
    ]) as relation_name
    cross join unnest(array['anon', 'authenticated', 'service_role']) as role_name
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as privilege_name
    where has_table_privilege(role_name, relation_name, privilege_name)
  ),
  0::bigint,
  'browser and service roles cannot read or mutate moderation source tables directly'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname in (
        'get_current_policies',
        'set_current_policy_documents',
        'accept_current_policies',
        'create_personal_card_share',
        'get_personal_card_share_status',
        'revoke_personal_card_share',
        'get_public_share',
        'create_user_block',
        'list_user_blocks',
        'revoke_user_block',
        'create_content_report',
        'list_share_moderation_queue',
        'get_moderation_share_photo',
        'moderate_personal_card_share',
        'list_content_reports',
        'moderate_content_report'
        ,'list_share_owner_suspensions'
        ,'moderate_share_owner_suspension'
      )
      and function_row.prosecdef
      and coalesce(function_row.proconfig, array[]::text[])
        @> array['search_path=""']::text[]
      and has_function_privilege('service_role', function_row.oid, 'EXECUTE')
  ),
  18::bigint,
  'all policy and moderation RPCs are hardened and service-role executable'
);

select is(
  (
    select count(*)::bigint
    from unnest(array[
      'api_private.issue_personal_card_temp_upload(uuid,boolean,text,bigint,uuid)'::regprocedure,
      'api_private.begin_personal_card_promotion_after_location_compliance(uuid,boolean,uuid,text,text,uuid)'::regprocedure,
      'api_private.create_personal_card_share_after_location_compliance(uuid,boolean,boolean,uuid,text)'::regprocedure,
      'api_private.moderate_personal_card_share_after_location_compliance(uuid,uuid,uuid,text,text,text,boolean)'::regprocedure
    ]) as policy_rpc(function_oid)
    where pg_get_functiondef(policy_rpc.function_oid)
      like '%pg_advisory_xact_lock_shared(hashtextextended(%'
      and pg_get_functiondef(policy_rpc.function_oid)
        like '%danyeodam:policy-current-set%'
  ),
  4::bigint,
  'every policy-consuming upload, submission, and approval RPC joins the shared current-set lock protocol'
);

select is(
  (
    select count(*)::bigint
    from information_schema.columns as column_row
    where column_row.table_schema = 'private'
      and column_row.table_name in ('content_reports', 'public_report_rate_limits')
      and column_row.column_name in ('share_slug', 'ip_address', 'raw_ip')
  ),
  0::bigint,
  'report persistence has no raw share-secret or IP column'
);

select is(
  (
    select count(*)::bigint
    from information_schema.columns as column_row
    where column_row.table_schema = 'private'
      and column_row.table_name in ('user_blocks', 'user_block_actions')
      and column_row.column_name in ('share_slug', 'owner_user_id', 'raw_share_slug')
  ),
  0::bigint,
  'block persistence never stores a raw secret slug or owner-labelled identifier'
);

-- Fixtures ---------------------------------------------------------------

insert into auth.users (id, created_at, updated_at, is_anonymous, raw_user_meta_data)
values
  ('a7000000-0000-4000-8000-000000000001', now(), now(), false, '{}'),
  ('a7000000-0000-4000-8000-000000000002', now(), now(), true, '{}'),
  ('a7000000-0000-4000-8000-000000000003', now(), now(), true, '{}');

insert into private.admin_members (auth_user_id)
values ('a7000000-0000-4000-8000-000000000001');

create temp table ugc_test_users (
  fixture_name text primary key,
  user_id uuid not null
) on commit drop;

insert into ugc_test_users (fixture_name, user_id)
select fixture.fixture_name, identity_row.user_id
from (
  values
    ('admin', 'a7000000-0000-4000-8000-000000000001'::uuid),
    ('owner', 'a7000000-0000-4000-8000-000000000002'::uuid),
    ('other', 'a7000000-0000-4000-8000-000000000003'::uuid)
) as fixture(fixture_name, auth_user_id)
join private.user_identities as identity_row
  on identity_row.auth_user_id = fixture.auth_user_id
 and identity_row.revoked_at is null;

insert into private.participant_access (user_id, access_kind)
select user_id, 'internal_tester'
from ugc_test_users
where fixture_name = 'owner';

insert into public.regions (code, country_code, sort_order)
values ('ugc-test', 'KR', 1);

insert into public.region_translations (
  region_code, locale, name, status, approved_at, approved_by
)
select
  'ugc-test', locale_row.locale, 'UGC Test', 'approved', now(),
  'a7000000-0000-4000-8000-000000000001'
from unnest(enum_range(null::public.content_locale)) as locale_row(locale);

insert into public.spots (
  id, slug, region, name_ko, name_en, status, latitude, longitude
)
values (
  'b7000000-0000-4000-8000-000000000001',
  'ugc-test-spot', 'ugc-test', 'UGC 테스트', 'UGC Test', 'draft', 37.5, 127.0
);

insert into public.spot_translations (
  spot_id, locale, name, status, approved_at, approved_by
)
select
  'b7000000-0000-4000-8000-000000000001', locale_row.locale,
  case when locale_row.locale = 'ko' then 'UGC 테스트' else 'UGC Test' end,
  'approved', now(), 'a7000000-0000-4000-8000-000000000001'
from unnest(enum_range(null::public.content_locale)) as locale_row(locale);

insert into public.cards (
  id, spot_id, code, kind, title_ko, title_en, sketch_path, color_hex,
  is_published, published_at
)
values (
  'c7000000-0000-4000-8000-000000000001',
  'b7000000-0000-4000-8000-000000000001',
  'ugc-test-card', 'region', 'UGC 카드', 'UGC Card', 'cards/ugc.webp',
  '#123456', false, null
);

insert into public.card_translations (
  card_id, locale, title, status, approved_at, approved_by
)
select
  'c7000000-0000-4000-8000-000000000001', locale_row.locale,
  case when locale_row.locale = 'ko' then 'UGC 카드' else 'UGC Card' end,
  'approved', now(), 'a7000000-0000-4000-8000-000000000001'
from unnest(enum_range(null::public.content_locale)) as locale_row(locale);

update public.cards
set is_published = true, published_at = now()
where id = 'c7000000-0000-4000-8000-000000000001';

update public.spots
set status = 'open'
where id = 'b7000000-0000-4000-8000-000000000001';

insert into public.acquisitions (
  id, user_id, spot_id, card_id, acquisition_type, verification_result,
  idempotency_key, field_sequence, acquired_at
)
values (
  'd7000000-0000-4000-8000-000000000001',
  (select user_id from ugc_test_users where fixture_name = 'owner'),
  'b7000000-0000-4000-8000-000000000001',
  'c7000000-0000-4000-8000-000000000001',
  'gift', 'not_applicable', 'e7000000-0000-4000-8000-000000000001', null,
  '2026-08-11 01:00:00+00'
);

insert into public.personal_cards (
  id, user_id, acquisition_id, photo_path, caption
)
values (
  'f7000000-0000-4000-8000-000000000001',
  (select user_id from ugc_test_users where fixture_name = 'owner'),
  'd7000000-0000-4000-8000-000000000001',
  (select user_id::text from ugc_test_users where fixture_name = 'owner') ||
    '/f7000000-0000-4000-8000-000000000001.webp',
  '검수 대상'
);

-- Policy publication and acceptance ------------------------------------

select is(
  api_private.get_current_policies(),
  '{"status":"not_ready"}'::jsonb,
  'policy requirements fail closed before all current documents exist'
);

select throws_ok(
  $sql$
    insert into private.policy_documents (
      policy_type, version, effective_at, is_current
    ) values ('terms_of_use', 'incomplete', now(), true)
  $sql$,
  '23514',
  'current policy requires all six locale documents',
  'an incomplete policy cannot become current'
);

insert into private.policy_documents (
  id, policy_type, version, effective_at, published_at, is_current
)
values
  (
    'b7100000-0000-4000-8000-000000000001',
    'terms_of_use', '1.0', now() - interval '1 minute', now(), false
  ),
  (
    'b7100000-0000-4000-8000-000000000002',
    'privacy_policy', '1.0', now() - interval '1 minute', now(), false
  ),
  (
    'b7100000-0000-4000-8000-000000000003',
    'community_guidelines', '1.0', now() - interval '1 minute', now(), false
  ),
  (
    'b7100000-0000-4000-8000-000000000004',
    'location_terms', '1.0', now() - interval '1 minute', now(), false
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
where policy_row.version = '1.0';

select is(
  api_private.set_current_policy_documents(array[
    'b7100000-0000-4000-8000-000000000001'::uuid,
    'b7100000-0000-4000-8000-000000000002'::uuid,
    'b7100000-0000-4000-8000-000000000003'::uuid,
    'b7100000-0000-4000-8000-000000000004'::uuid
  ]),
  '{"status":"switched"}'::jsonb,
  'the server-only publication RPC installs one complete current policy set'
);

select throws_ok(
  $sql$
    update private.policy_documents
    set is_current = false
    where id = 'b7100000-0000-4000-8000-000000000001'
  $sql$,
  '23514',
  'current policy changes require the policy publication RPC',
  'operators cannot bypass the serialized current-policy switch path'
);

select is(api_private.get_current_policies() ->> 'status', 'ready', 'current policies are ready');

select ok(
  (
    api_private.get_current_policies()
      #>> '{policies,0,documents,ko,url}'
  ) like 'https://policies.test/%'
  and (
    api_private.get_current_policies()
      #>> '{policies,0,documents,ko,sha256}'
  ) ~ '^[0-9a-f]{64}$',
  'each policy locale returns its HTTPS URL and content SHA-256'
);

select throws_ok(
  $sql$
    update private.policy_documents
    set version = 'mutated'
    where id = 'b7100000-0000-4000-8000-000000000001'
  $sql$,
  '23514',
  'published policy content is immutable; publish a new version',
  'published policy document content cannot be edited in place'
);

select throws_ok(
  $sql$
    update private.policy_document_locales
    set document_url = 'https://policies.test/tampered'
    where policy_document_id = 'b7100000-0000-4000-8000-000000000001'
      and locale = 'ko'
  $sql$,
  '23514',
  'published policy locale documents are immutable; publish a new version',
  'published locale URLs and hashes cannot be edited in place'
);

select throws_ok(
  $sql$
    delete from private.policy_document_locales
    where policy_document_id = 'b7100000-0000-4000-8000-000000000001'
      and locale = 'ko'
  $sql$,
  '23514',
  'published policy locale documents cannot be deleted; publish a new version',
  'published locale documents cannot be deleted'
);

select throws_ok(
  $sql$
    delete from private.policy_documents
    where id = 'b7100000-0000-4000-8000-000000000001'
  $sql$,
  '23514',
  'published policy documents cannot be deleted; publish a new version',
  'published policy versions remain immutable records'
);

select is(
  api_private.issue_personal_card_temp_upload(
    'a7000000-0000-4000-8000-000000000002', false, 'image/jpeg', 123
  ) ->> 'status',
  'policy_required',
  'photo upload URL issuance requires both current UGC policy acceptances'
);

select is(
  api_private.begin_personal_card_promotion(
    'a7000000-0000-4000-8000-000000000002', false,
    'd7000000-0000-4000-8000-000000000001', 'missing/temp.jpg', '',
    'b7999999-0000-4000-8000-000000000001'
  ) ->> 'status',
  'policy_required',
  'photo-card promotion independently rechecks current policy acceptance'
);

select is(
  api_private.accept_current_policies(
    'a7000000-0000-4000-8000-000000000002',
    jsonb_build_array(
      jsonb_build_object('type', 'terms_of_use', 'version', '1.0', 'locale', 'ko')
    )
  ),
  '{"status":"invalid"}'::jsonb,
  'acceptance requires both consent policies in one bounded request'
);

select is(
  api_private.accept_current_policies(
    'a7000000-0000-4000-8000-000000000002',
    jsonb_build_array(
      jsonb_build_object('type', 'terms_of_use', 'version', '0.9', 'locale', 'ko'),
      jsonb_build_object('type', 'community_guidelines', 'version', '0.9', 'locale', 'ko')
    )
  ) ->> 'status',
  'policy_required',
  'stale or unknown policy versions are not accepted'
);

select is(
  api_private.accept_current_policies(
    'a7000000-0000-4000-8000-000000000002',
    jsonb_build_array(
      jsonb_build_object('type', 'terms_of_use', 'version', '1.0', 'locale', 'ko'),
      jsonb_build_object('type', 'community_guidelines', 'version', '1.0', 'locale', 'en')
    )
  ),
  '{"status":"accepted"}'::jsonb,
  'the owner records immutable locale and hash acceptance snapshots'
);

update private.policy_acceptances
set accepted_sha256 = decode(repeat('00', 32), 'hex')
where user_id = (select user_id from ugc_test_users where fixture_name = 'owner')
  and policy_document_id = 'b7100000-0000-4000-8000-000000000001';

select is(
  api_private.issue_personal_card_temp_upload(
    'a7000000-0000-4000-8000-000000000002', false, 'image/jpeg', 123
  ) ->> 'status',
  'policy_required',
  'a stale acceptance hash does not satisfy the selected current locale row'
);

update private.policy_acceptances as acceptance_row
set accepted_sha256 = locale_row.sha256
from private.policy_document_locales as locale_row
where acceptance_row.user_id = (
    select user_id from ugc_test_users where fixture_name = 'owner'
  )
  and acceptance_row.policy_document_id = 'b7100000-0000-4000-8000-000000000001'
  and locale_row.policy_document_id = acceptance_row.policy_document_id
  and locale_row.locale = acceptance_row.accepted_locale;

-- Submission, approval, public read, and reports -----------------------

update public.personal_cards
set share_resubmission_required = true,
    share_reason_code = 'LEGACY_SLUG_ROTATION_REQUIRED'
where id = 'f7000000-0000-4000-8000-000000000001';

select ok(
  (
    select personal_card_row.share_slug is null
      and personal_card_row.share_state = 'private'
      and personal_card_row.share_resubmission_required
      and personal_card_row.share_reason_code = 'LEGACY_SLUG_ROTATION_REQUIRED'
    from public.personal_cards as personal_card_row
    where personal_card_row.id = 'f7000000-0000-4000-8000-000000000001'
  ),
  'a rotated legacy secret remains private and explicitly requires resubmission'
);

select is(
  api_private.create_personal_card_share(
    'a7000000-0000-4000-8000-000000000002',
    false,
    false,
    'f7000000-0000-4000-8000-000000000001',
    'UgcReviewShareSlug000001'
  ),
  '{"status":"share_creation_gate_closed"}'::jsonb,
  'legacy secret rotation cannot bypass the independent submission gate'
);

select is(
  api_private.create_personal_card_share(
    'a7000000-0000-4000-8000-000000000002',
    false,
    true,
    'f7000000-0000-4000-8000-000000000001',
    'UgcReviewShareSlug000001'
  ),
  '{"status":"pending","share_slug":"UgcReviewShareSlug000001","share_state":"pending"}'::jsonb,
  'a policy-complete owner rotates the legacy secret into pending review'
);

select is(
  api_private.get_public_share('UgcReviewShareSlug000001', null, false, true),
  '{"status":"not_found"}'::jsonb,
  'pending content is indistinguishable from a missing secret link'
);

select is(
  api_private.moderate_personal_card_share(
    'a7000000-0000-4000-8000-000000000003',
    'f7000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000001',
    'approve', 'POLICY_OK', 'unauthorized approval', true
  ),
  '{"status":"forbidden"}'::jsonb,
  'a non-admin identity cannot approve content'
);

select throws_ok(
  $sql$
    update public.personal_cards
    set share_state = 'active',
        share_reviewed_at = now(),
        share_reviewed_by = 'a7000000-0000-4000-8000-000000000001'
    where id = 'f7000000-0000-4000-8000-000000000001'
  $sql$,
  '23514',
  'moderated share transitions require the moderation RPC',
  'even direct database mutation cannot bypass the audit RPC'
);

insert into private.policy_documents (
  id, policy_type, version, effective_at, published_at, is_current
)
values
  (
    'b7200000-0000-4000-8000-000000000001',
    'terms_of_use', '1.1', now() - interval '1 minute', now(), false
  ),
  (
    'b7200000-0000-4000-8000-000000000002',
    'privacy_policy', '1.1', now() - interval '1 minute', now(), false
  ),
  (
    'b7200000-0000-4000-8000-000000000003',
    'community_guidelines', '1.1', now() - interval '1 minute', now(), false
  ),
  (
    'b7200000-0000-4000-8000-000000000004',
    'location_terms', '1.1', now() - interval '1 minute', now(), false
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
where policy_row.version = '1.1';

select is(
  api_private.set_current_policy_documents(array[
    'b7200000-0000-4000-8000-000000000001'::uuid,
    'b7200000-0000-4000-8000-000000000002'::uuid,
    'b7200000-0000-4000-8000-000000000003'::uuid,
    'b7200000-0000-4000-8000-000000000004'::uuid
  ]),
  '{"status":"switched"}'::jsonb,
  'a replacement current set is switched atomically through the publication RPC'
);

select is(
  api_private.moderate_personal_card_share(
    'a7000000-0000-4000-8000-000000000001',
    'f7000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000009',
    'approve', 'POLICY_OK', 'stale policy approval', true
  ) ->> 'reason',
  'policy_resubmission_required',
  'approval refuses a snapshot that became stale while review was pending'
);

select is(
  api_private.create_personal_card_share(
    'a7000000-0000-4000-8000-000000000002',
    false,
    true,
    'f7000000-0000-4000-8000-000000000001',
    null
  ) ->> 'status',
  'policy_required',
  'an open submission gate still requires acceptance of new current policies'
);

select is(
  api_private.accept_current_policies(
    'a7000000-0000-4000-8000-000000000002',
    jsonb_build_array(
      jsonb_build_object('type', 'terms_of_use', 'version', '1.1', 'locale', 'ko'),
      jsonb_build_object('type', 'community_guidelines', 'version', '1.1', 'locale', 'en')
    )
  ),
  '{"status":"accepted"}'::jsonb,
  'the owner accepts the replacement policy versions'
);

select is(
  api_private.create_personal_card_share(
    'a7000000-0000-4000-8000-000000000002',
    false,
    false,
    'f7000000-0000-4000-8000-000000000001',
    null
  ),
  '{"status":"share_creation_gate_closed"}'::jsonb,
  'a stale pending share cannot refresh while the submission gate is closed'
);

select is(
  api_private.create_personal_card_share(
    'a7000000-0000-4000-8000-000000000002',
    false,
    true,
    'f7000000-0000-4000-8000-000000000001',
    null
  ),
  '{"status":"pending","share_slug":"UgcReviewShareSlug000001","share_state":"pending"}'::jsonb,
  'an open submission gate refreshes the accepted policy snapshots'
);

select is(
  api_private.moderate_personal_card_share(
    'a7000000-0000-4000-8000-000000000001',
    'f7000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000008',
    'approve', 'POLICY_OK', 'publication remains closed', false
  ),
  '{"status":"publication_gate_closed"}'::jsonb,
  'the publication kill switch rejects approval before active transition'
);

select is(
  api_private.moderate_personal_card_share(
    'a7000000-0000-4000-8000-000000000001',
    'f7000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000002',
    'approve', 'POLICY_OK', 'manual review passed', true
  ),
  '{"status":"applied","share_state":"active","affected":1}'::jsonb,
  'an active administrator approves the pending share atomically'
);

select is(
  api_private.moderate_personal_card_share(
    'a7000000-0000-4000-8000-000000000001',
    'f7000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000002',
    'approve', 'POLICY_OK', 'manual review passed', true
  ),
  '{"status":"duplicate","share_state":"active","affected":1}'::jsonb,
  'the same moderation action retry reproduces its result'
);

select is(
  api_private.moderate_personal_card_share(
    'a7000000-0000-4000-8000-000000000001',
    'f7000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000002',
    'approve', 'POLICY_OK', 'manual review passed', false
  ),
  '{"status":"publication_gate_closed"}'::jsonb,
  'the closed publication switch also rejects an idempotent approval retry'
);

select is(
  api_private.get_public_share('UgcReviewShareSlug000001', null, false, false),
  '{"status":"not_found"}'::jsonb,
  'an existing active share is hidden when publication is disabled'
);

select is(
  api_private.get_public_share('UgcReviewShareSlug000001', null, false, true) ->> 'status',
  'found',
  'only approved active content resolves through the public RPC'
);

select is(
  api_private.get_public_share(
    'UgcReviewShareSlug000001',
    'a7000000-0000-4000-8000-000000000003',
    false,
    true
  ) ->> 'status',
  'found',
  'an authenticated viewer can resolve an active owner before blocking'
);

insert into private.share_owner_suspensions (
  id, user_id, suspended_by_auth_user_id, reason_code, note
)
values (
  '75000000-0000-4000-8000-000000000099',
  (select user_id from ugc_test_users where fixture_name = 'owner'),
  'a7000000-0000-4000-8000-000000000001',
  'TEST_SUSPENSION',
  'verify report fail closed'
);

select is(
  api_private.create_content_report(
    'UgcReviewShareSlug000001',
    '71000000-0000-4000-8000-000000000099',
    'content', 'spam', 'suspended owner', repeat('c', 64), true
  ),
  '{"status":"not_found"}'::jsonb,
  'an active-looking secret cannot create a report while its owner is suspended'
);

select is(
  (
    select count(*)::bigint
    from private.content_reports
    where client_report_id = '71000000-0000-4000-8000-000000000099'
  ),
  0::bigint,
  'a suspended-owner report attempt leaves no moderation record'
);

delete from private.share_owner_suspensions
where id = '75000000-0000-4000-8000-000000000099';

select is(
  api_private.create_user_block(
    'a7000000-0000-4000-8000-000000000003',
    'UgcReviewShareSlug000001',
    '73000000-0000-4000-8000-000000000009',
    false
  ),
  '{"status":"not_found"}'::jsonb,
  'blocking an active owner fails closed while publication is disabled'
);

select is(
  api_private.create_user_block(
    'a7000000-0000-4000-8000-000000000003',
    'UgcReviewShareSlug000001',
    '73000000-0000-4000-8000-000000000001',
    true
  ),
  '{"status":"blocked","duplicate":false}'::jsonb,
  'an authenticated service user blocks the owner through an active share'
);

select is(
  api_private.create_user_block(
    'a7000000-0000-4000-8000-000000000003',
    'UgcReviewShareSlug000001',
    '73000000-0000-4000-8000-000000000001',
    true
  ),
  '{"status":"blocked","duplicate":true}'::jsonb,
  'an identical block retry is idempotent before rate accounting'
);

select is(
  api_private.create_user_block(
    'a7000000-0000-4000-8000-000000000003',
    'DifferentValidShareSlug01',
    '73000000-0000-4000-8000-000000000001',
    true
  ),
  '{"status":"idempotency_conflict"}'::jsonb,
  'reusing a block action id with a changed secret payload conflicts'
);

select is(
  api_private.get_public_share(
    'UgcReviewShareSlug000001',
    'a7000000-0000-4000-8000-000000000003',
    false,
    true
  ),
  '{"status":"not_found"}'::jsonb,
  'authenticated JSON and photo resolution fail closed for a blocked owner'
);

select is(
  api_private.get_public_share('UgcReviewShareSlug000001', null, false, true) ->> 'status',
  'found',
  'unauthenticated web resolution remains available for client-local hiding'
);

select ok(
  position('UgcReviewShareSlug000001' in api_private.list_user_blocks(
    'a7000000-0000-4000-8000-000000000003', 50, null, null
  )::text) = 0
  and position(
    (select user_id::text from ugc_test_users where fixture_name = 'owner')
    in api_private.list_user_blocks(
      'a7000000-0000-4000-8000-000000000003', 50, null, null
    )::text
  ) = 0,
  'the user block list exposes neither the owner logical id nor share slug'
);

insert into private.user_blocks (
  id, blocker_user_id, blocked_user_id, created_at
)
values (
  '74000000-0000-4000-8000-000000000001',
  (select user_id from ugc_test_users where fixture_name = 'other'),
  (select user_id from ugc_test_users where fixture_name = 'admin'),
  now() - interval '1 day'
);

select is(
  api_private.list_user_blocks(
    'a7000000-0000-4000-8000-000000000003', 1, null, null
  ) ->> 'has_more',
  'true',
  'the block list reports a next page instead of silently truncating'
);

select is(
  api_private.list_user_blocks(
    'a7000000-0000-4000-8000-000000000003',
    1,
    (
      api_private.list_user_blocks(
        'a7000000-0000-4000-8000-000000000003', 1, null, null
      ) #>> '{next_anchor,created_at}'
    )::timestamptz,
    (
      api_private.list_user_blocks(
        'a7000000-0000-4000-8000-000000000003', 1, null, null
      ) #>> '{next_anchor,id}'
    )::uuid
  ) #>> '{items,0,id}',
  '74000000-0000-4000-8000-000000000001',
  'the next block page resumes after the opaque keyset anchor'
);

select is(
  api_private.revoke_user_block(
    'a7000000-0000-4000-8000-000000000003',
    (
      api_private.list_user_blocks(
        'a7000000-0000-4000-8000-000000000003', 50, null, null
      )
        #>> '{items,0,id}'
    )::uuid,
    '73000000-0000-4000-8000-000000000002'
  ),
  '{"status":"revoked","duplicate":false}'::jsonb,
  'a user unblocks through the opaque block id'
);

select is(
  api_private.revoke_user_block(
    'a7000000-0000-4000-8000-000000000003',
    (
      select block_row.id
      from private.user_blocks as block_row
      where block_row.blocker_user_id = (
        select user_id from ugc_test_users where fixture_name = 'other'
      )
      order by block_row.created_at desc
      limit 1
    ),
    '73000000-0000-4000-8000-000000000002'
  ),
  '{"status":"revoked","duplicate":true}'::jsonb,
  'an identical unblock retry remains idempotent'
);

select is(
  api_private.get_public_share(
    'UgcReviewShareSlug000001',
    'a7000000-0000-4000-8000-000000000003',
    false,
    true
  ) ->> 'status',
  'found',
  'unblocking restores active-share resolution for that viewer'
);

select is(
  api_private.create_user_block(
    'a7000000-0000-4000-8000-000000000003',
    'UgcReviewShareSlug000001',
    ('73000000-0000-4000-8000-' || lpad(series_row::text, 12, '0'))::uuid,
    true
  ) ->> 'status',
  'blocked',
  'the first twenty unique block attempts in one hour are accepted'
)
from generate_series(3, 21) as series_row;

select is(
  api_private.create_user_block(
    'a7000000-0000-4000-8000-000000000003',
    'UgcReviewShareSlug000001',
    '73000000-0000-4000-8000-000000000022',
    true
  ) ->> 'status',
  'rate_limited',
  'the twenty-first unique block attempt in one hour is throttled'
);

select is(
  api_private.revoke_user_block(
    'a7000000-0000-4000-8000-000000000003',
    (
      api_private.list_user_blocks(
        'a7000000-0000-4000-8000-000000000003', 50, null, null
      )
        #>> '{items,0,id}'
    )::uuid,
    '73000000-0000-4000-8000-000000000023'
  ) ->> 'status',
  'revoked',
  'rate limiting block creation does not prevent owner unblocking'
);

select throws_ok(
  $sql$
    update public.personal_cards
    set share_reviewed_by = null,
        share_reviewed_by_redacted_at = null
    where id = 'f7000000-0000-4000-8000-000000000001'
  $sql$,
  '23514',
  'moderated share state requires review audit',
  'a moderated state cannot lose both reviewer identity and its redaction marker'
);

select throws_ok(
  $sql$
    update public.personal_cards
    set share_reviewed_by_redacted_at = now()
    where id = 'f7000000-0000-4000-8000-000000000001'
  $sql$,
  '23514',
  'moderated share state requires review audit',
  'a moderated state cannot retain both reviewer identity and redaction marker'
);

select lives_ok(
  $sql$
    update public.personal_cards
    set share_reviewed_by = null,
        share_reviewed_by_redacted_at = now()
    where id = 'f7000000-0000-4000-8000-000000000001'
  $sql$,
  'a redacted reviewer marker preserves a valid moderated audit state'
);

select ok(
  position(
    'UgcReviewShareSlug000001' in api_private.list_share_moderation_queue(
      'a7000000-0000-4000-8000-000000000001', 'active', 50
    )::text
  ) = 0,
  'the moderation queue never returns the raw secret-link slug'
);

select is(
  api_private.create_content_report(
    'UgcReviewShareSlug000001',
    '71000000-0000-4000-8000-000000000009',
    'content', 'privacy', 'publication closed', repeat('b', 64), false
  ),
  '{"status":"not_found"}'::jsonb,
  'reporting an active secret link fails closed while publication is disabled'
);

select is(
  api_private.create_content_report(
    'UgcReviewShareSlug000001',
    '71000000-0000-4000-8000-000000000001',
    'content', 'privacy', 'face visible', repeat('a', 64), true
  ) ->> 'status',
  'received',
  'an active secret link accepts a bounded public report'
);

select is(
  api_private.create_content_report(
    'UgcReviewShareSlug000001',
    '71000000-0000-4000-8000-000000000001',
    'content', 'privacy', 'face visible', repeat('a', 64), true
  ) ->> 'duplicate',
  'true',
  'an identical report retry is idempotent before consuming rate capacity'
);

select is(
  api_private.create_content_report(
    'UgcReviewShareSlug000001',
    '71000000-0000-4000-8000-000000000001',
    'content', 'spam', null, repeat('a', 64), true
  ),
  '{"status":"idempotency_conflict"}'::jsonb,
  'a reused report id with a changed payload conflicts'
);

select is(
  api_private.create_content_report(
    'UgcReviewShareSlug000001',
    ('71000000-0000-4000-8000-' || lpad(series_row::text, 12, '0'))::uuid,
    'content', 'spam', null, repeat('a', 64), true
  ) ->> 'status',
  'received',
  'the first five unique reports in an hour remain available'
)
from generate_series(2, 5) as series_row;

select is(
  api_private.create_content_report(
    'UgcReviewShareSlug000001',
    '71000000-0000-4000-8000-000000000006',
    'content', 'spam', null, repeat('a', 64), true
  ) ->> 'status',
  'rate_limited',
  'the sixth unique report in the one-hour window is throttled'
);

select ok(
  position(
    'UgcReviewShareSlug000001' in api_private.list_content_reports(
      'a7000000-0000-4000-8000-000000000001', 'open', 50
    )::text
  ) = 0,
  'the report queue never returns the raw secret link or its hash'
);

select is(
  api_private.moderate_content_report(
    'a7000000-0000-4000-8000-000000000001',
    (
      select id from private.content_reports
      where client_report_id = '71000000-0000-4000-8000-000000000001'
    ),
    '72000000-0000-4000-8000-000000000003',
    'take_down', 'PRIVACY', 'privacy violation confirmed'
  ),
  '{"status":"applied"}'::jsonb,
  'an administrator resolves a report and takes down its share atomically'
);

select is(
  api_private.get_public_share('UgcReviewShareSlug000001', null, false, true),
  '{"status":"not_found"}'::jsonb,
  'taken-down JSON fails closed immediately'
);

select is(
  api_private.moderate_personal_card_share(
    'a7000000-0000-4000-8000-000000000001',
    'f7000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000007',
    'reinstate', 'APPEAL_ACCEPTED', 'publication remains closed', false
  ),
  '{"status":"publication_gate_closed"}'::jsonb,
  'the publication kill switch rejects reinstate before returning to review'
);

select ok(
  (
    select personal_card_row.share_reviewed_by =
        'a7000000-0000-4000-8000-000000000001'
      and personal_card_row.share_reviewed_by_redacted_at is null
    from public.personal_cards as personal_card_row
    where personal_card_row.id = 'f7000000-0000-4000-8000-000000000001'
  ),
  'every fresh moderation action records the acting reviewer and clears a redaction marker'
);

update public.personal_cards
set share_reviewed_by = null,
    share_reviewed_by_redacted_at = now()
where id = 'f7000000-0000-4000-8000-000000000001';

select is(
  api_private.moderate_content_report(
    'a7000000-0000-4000-8000-000000000001',
    (
      select id from private.content_reports
      where client_report_id = '71000000-0000-4000-8000-000000000003'
    ),
    '72000000-0000-4000-8000-000000000005',
    'take_down', 'SPAM', 'fresh audit on already hidden content'
  ),
  '{"status":"applied"}'::jsonb,
  'a fresh action on already taken-down content still refreshes its reviewer audit'
);

select ok(
  (
    select personal_card_row.share_reviewed_by =
        'a7000000-0000-4000-8000-000000000001'
      and personal_card_row.share_reviewed_by_redacted_at is null
    from public.personal_cards as personal_card_row
    where personal_card_row.id = 'f7000000-0000-4000-8000-000000000001'
  ),
  'a fresh no-visibility-change moderation action also clears the redaction marker'
);

select is(
  api_private.get_personal_card_share_status(
    'a7000000-0000-4000-8000-000000000002',
    'f7000000-0000-4000-8000-000000000001'
  ) ->> 'share_state',
  'taken_down',
  'the owner can read the non-public moderation status'
);

select is(
  api_private.revoke_personal_card_share(
    'a7000000-0000-4000-8000-000000000002',
    'f7000000-0000-4000-8000-000000000001'
  ),
  '{"status":"revoked"}'::jsonb,
  'the owner can immediately revoke even after a takedown'
);

select is(
  api_private.moderate_content_report(
    'a7000000-0000-4000-8000-000000000001',
    (
      select id from private.content_reports
      where client_report_id = '71000000-0000-4000-8000-000000000002'
    ),
    '72000000-0000-4000-8000-000000000004',
    'suspend_owner', 'REPEAT_ABUSE', 'sharing suspended'
  ),
  '{"status":"applied"}'::jsonb,
  'an administrator can suspend future shares from an open report after owner revocation'
);

select is(
  (
    select resulting_state
    from private.moderation_actions
    where client_action_id = '72000000-0000-4000-8000-000000000004'
  ),
  'private',
  'the immutable report audit records the card state that actually remained after revocation'
);

select is(
  api_private.create_personal_card_share(
    'a7000000-0000-4000-8000-000000000002',
    false,
    true,
    'f7000000-0000-4000-8000-000000000001',
    'UgcReviewShareSlug000002'
  ),
  '{"status":"account_suspended"}'::jsonb,
  'a suspended owner cannot submit a new share'
);

select ok(
  position(
    (select user_id::text from ugc_test_users where fixture_name = 'owner')
    in api_private.list_share_owner_suspensions(
      'a7000000-0000-4000-8000-000000000001', 'active', 50
    )::text
  ) = 0
  and (
    api_private.list_share_owner_suspensions(
      'a7000000-0000-4000-8000-000000000001', 'active', 50
    ) #>> '{items,0,id}'
  ) is not null,
  'the suspension queue uses an opaque id and never exposes the logical user id'
);

delete from public.personal_cards
where id = 'f7000000-0000-4000-8000-000000000001';

select is(
  api_private.moderate_share_owner_suspension(
    'a7000000-0000-4000-8000-000000000001',
    (
      api_private.list_share_owner_suspensions(
        'a7000000-0000-4000-8000-000000000001', 'active', 50
      ) #>> '{items,0,id}'
    )::uuid,
    '74000000-0000-4000-8000-000000000001',
    'unsuspend_owner', 'APPEAL_ACCEPTED', 'manual appeal accepted'
  ),
  '{"status":"applied"}'::jsonb,
  'an administrator lifts a suspension after its source card is deleted'
);

select is(
  api_private.moderate_share_owner_suspension(
    'a7000000-0000-4000-8000-000000000001',
    (
      select suspension_row.id
      from private.share_owner_suspensions as suspension_row
      where suspension_row.user_id = (
        select user_id from ugc_test_users where fixture_name = 'owner'
      )
      order by suspension_row.suspended_at desc
      limit 1
    ),
    '74000000-0000-4000-8000-000000000001',
    'unsuspend_owner', 'APPEAL_ACCEPTED', 'manual appeal accepted'
  ),
  '{"status":"duplicate"}'::jsonb,
  'a repeated suspension action is idempotent without a card dependency'
);

select is(
  api_private.list_share_owner_suspensions(
    'a7000000-0000-4000-8000-000000000001', 'active', 50
  ) #>> '{items}',
  '[]',
  'the lifted suspension leaves the active queue immediately'
);

select throws_ok(
  $sql$
    update private.moderation_actions
    set note = 'tampered'
    where client_action_id = '72000000-0000-4000-8000-000000000002'
  $sql$,
  '23514',
  'moderation actions are append-only',
  'moderation audit entries cannot be changed after insertion'
);

select * from finish();
rollback;
