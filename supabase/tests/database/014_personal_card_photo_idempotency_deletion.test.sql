begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

-- Schema, RLS, and callable surface -------------------------------------

select ok(
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'private'
      and table_name = 'personal_card_temp_uploads'
      and column_name = 'client_request_id'
      and is_nullable = 'NO'
  )
  and exists (
    select 1
    from pg_indexes
    where schemaname = 'private'
      and indexname = 'personal_card_temp_uploads_owner_request_idx'
      and indexdef like '%UNIQUE%'
  ),
  'upload reservations persist one strict owner-scoped request key'
);

select ok(
  (
    select relrowsecurity and relforcerowsecurity
    from pg_class
    where oid = 'private.personal_card_deletion_requests'::regclass
  ),
  'personal-card deletion receipts enable and force RLS'
);

select is(
  (
    select count(*)::bigint
    from pg_class as relation_row
    cross join lateral aclexplode(
      coalesce(relation_row.relacl, acldefault('r', relation_row.relowner))
    ) as acl_row
    where relation_row.oid = 'private.personal_card_deletion_requests'::regclass
      and (
        acl_row.grantee = 0
        or acl_row.grantee in (
          'anon'::regrole,
          'authenticated'::regrole,
          'service_role'::regrole
        )
      )
  ),
  0::bigint,
  'PUBLIC and Data API roles have no direct deletion-receipt access'
);

select ok(
  has_function_privilege(
    'service_role',
    'api_private.issue_personal_card_temp_upload(uuid,boolean,text,bigint,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'api_private.issue_personal_card_temp_upload(uuid,boolean,text,bigint)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'api_private.request_personal_card_deletion(uuid,uuid,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'api_private.request_personal_card_deletion(uuid,uuid,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'api_private.request_personal_card_deletion(uuid,uuid,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'api_private.moderate_content_report(uuid,uuid,uuid,text,text,text)',
    'EXECUTE'
  )
  and to_regprocedure(
    'api_private.moderate_content_report_pre_card_delete(uuid,uuid,uuid,text,text,text)'
  ) is null
  and not has_function_privilege(
    'service_role',
    'api_private.moderate_content_report_unrated(uuid,uuid,uuid,text,text,text)',
    'EXECUTE'
  )
  and to_regprocedure(
    'api_private.begin_personal_card_promotion_before_deletion_charge(uuid,boolean,uuid,text,text,uuid)'
  ) is null
  and not has_function_privilege(
    'service_role',
    'api_private.begin_personal_card_promotion_unrated_before_deletion_charge(uuid,boolean,uuid,text,text,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'api_private.purge_completed_personal_card_uploads(integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'api_private.purge_completed_personal_card_uploads(integer)',
    'EXECUTE'
  ),
  'only server RPCs expose the new upload and deletion boundaries'
);

select ok(
  pg_get_functiondef(
    'api_private.issue_personal_card_temp_upload(uuid,boolean,text,bigint,uuid)'::regprocedure
  ) like '%danyeodam:policy-current-set%'
  and pg_get_functiondef(
    'api_private.issue_personal_card_temp_upload(uuid,boolean,text,bigint,uuid)'::regprocedure
  ) like '%danyeodam:suspend-owner:%'
  and pg_get_functiondef(
    'api_private.request_personal_card_deletion(uuid,uuid,uuid)'::regprocedure
  ) like '%danyeodam:suspend-owner:%'
  and pg_get_functiondef(
    'api_private.moderate_content_report(uuid,uuid,uuid,text,text,text)'::regprocedure
  ) like '%consume_authenticated_api_rate_limit%danyeodam:suspend-owner:%moderate_content_report_unrated%'
  and pg_get_functiondef(
    'api_private.begin_personal_card_promotion(uuid,boolean,uuid,text,text,uuid)'::regprocedure
  ) like '%consume_authenticated_api_rate_limit%danyeodam:policy-current-set%danyeodam:suspend-owner:%'
  and pg_get_functiondef(
    'api_private.complete_personal_card_promotion_with_size(uuid,uuid,uuid,uuid,text,text,bigint,uuid)'::regprocedure
  ) like '%danyeodam:policy-current-set%danyeodam:suspend-owner:%',
  'upload and deletion use the canonical policy-owner lock ordering'
);

select ok(
  pg_get_functiondef(
    'api_private.issue_personal_card_temp_upload(uuid,boolean,text,bigint,uuid)'::regprocedure
  ) like '%personal_card_deletion_requests%'
  and pg_get_functiondef(
    'api_private.begin_personal_card_promotion(uuid,boolean,uuid,text,text,uuid)'::regprocedure
  ) like '%personal_card_deletion_requests%'
  and pg_get_functiondef(
    'api_private.complete_personal_card_promotion_with_size(uuid,uuid,uuid,uuid,text,text,bigint,uuid)'::regprocedure
  ) like '%personal_card_deletion_requests%'
  and pg_get_functiondef(
    'private.prepare_personal_card_storage_quota()'::regprocedure
  ) like '%personal_card_deletion_requests%',
  'issue, begin, completion, and the insert trigger all charge pending erasure bytes'
);

-- Fixtures ---------------------------------------------------------------

insert into auth.users (id, created_at, updated_at, is_anonymous, raw_user_meta_data)
values
  ('a1400000-0000-4000-8000-000000000001', now(), now(), true, '{}'),
  ('a1400000-0000-4000-8000-000000000002', now(), now(), true, '{}'),
  ('a1400000-0000-4000-8000-000000000003', now(), now(), true, '{}');

create temp table photo_boundary_users (
  fixture_name text primary key,
  auth_user_id uuid not null,
  user_id uuid not null
) on commit drop;

insert into photo_boundary_users (fixture_name, auth_user_id, user_id)
select fixture.fixture_name, fixture.auth_user_id, identity_row.user_id
from (
  values
    ('upload', 'a1400000-0000-4000-8000-000000000001'::uuid),
    ('delete', 'a1400000-0000-4000-8000-000000000002'::uuid),
    ('account_transfer', 'a1400000-0000-4000-8000-000000000003'::uuid)
) as fixture(fixture_name, auth_user_id)
join private.user_identities as identity_row
  on identity_row.auth_user_id = fixture.auth_user_id
 and identity_row.revoked_at is null;

-- This test is independently runnable after a clean reset. Install a complete
-- four-document current set before recording the UGC acceptance snapshots;
-- prior pgTAP files roll back and cannot provide shared policy fixtures.
insert into private.policy_documents (
  id, policy_type, version, effective_at, published_at, is_current
)
values
  (
    'b1420000-0000-4000-8000-000000000001',
    'terms_of_use', 'photo-boundary-1', now() - interval '1 minute', now(), false
  ),
  (
    'b1420000-0000-4000-8000-000000000002',
    'privacy_policy', 'photo-boundary-1', now() - interval '1 minute', now(), false
  ),
  (
    'b1420000-0000-4000-8000-000000000003',
    'community_guidelines', 'photo-boundary-1', now() - interval '1 minute', now(), false
  ),
  (
    'b1420000-0000-4000-8000-000000000004',
    'location_terms', 'photo-boundary-1', now() - interval '1 minute', now(), false
  );

insert into private.policy_document_locales (
  policy_document_id, locale, document_url, sha256
)
select
  document_row.id,
  locale_row.locale,
  'https://policies.test/photo-boundary/' || document_row.id::text ||
    '/' || locale_row.locale::text,
  extensions.digest(
    'photo-boundary:' || document_row.id::text || ':' || locale_row.locale::text,
    'sha256'
  )
from private.policy_documents as document_row
cross join unnest(enum_range(null::public.content_locale)) as locale_row(locale)
where document_row.version = 'photo-boundary-1';

select is(
  api_private.set_current_policy_documents(array[
    'b1420000-0000-4000-8000-000000000001'::uuid,
    'b1420000-0000-4000-8000-000000000002'::uuid,
    'b1420000-0000-4000-8000-000000000003'::uuid,
    'b1420000-0000-4000-8000-000000000004'::uuid
  ]),
  '{"status":"switched"}'::jsonb,
  'photo-boundary fixtures install their own complete current policy set'
);

insert into private.policy_acceptances (
  user_id, policy_document_id, accepted_locale, accepted_sha256
)
select
  user_row.user_id,
  document_row.id,
  'ko'::public.content_locale,
  locale_row.sha256
from photo_boundary_users as user_row
cross join private.policy_documents as document_row
join private.policy_document_locales as locale_row
  on locale_row.policy_document_id = document_row.id
 and locale_row.locale = 'ko'
where document_row.is_current
  and document_row.policy_type in ('terms_of_use', 'community_guidelines');

insert into public.regions (code, country_code, sort_order)
values ('photo-boundary-test', 'KR', 1);

insert into public.spots (
  id, slug, region, name_ko, name_en, status, latitude, longitude
)
values (
  'b1410000-0000-4000-8000-000000000001',
  'photo-boundary-test', 'photo-boundary-test',
  '사진 경계 테스트', 'Photo boundary test', 'draft', 37.5, 127.0
);

insert into public.cards (
  id, spot_id, code, kind, title_ko, title_en, sketch_path, color_hex,
  is_published, published_at
)
values (
  'c1410000-0000-4000-8000-000000000001',
  'b1410000-0000-4000-8000-000000000001',
  'photo-boundary-card', 'region', '사진 경계', 'Photo boundary',
  'cards/photo-boundary.webp', '#123456', false, null
);

insert into public.card_translations (
  card_id, locale, title, status, approved_at, approved_by
)
select
  'c1410000-0000-4000-8000-000000000001',
  locale_row.locale,
  case when locale_row.locale = 'ko' then '사진 경계' else 'Photo boundary' end,
  'approved',
  clock_timestamp(),
  'a1400000-0000-4000-8000-000000000001'
from unnest(enum_range(null::public.content_locale)) as locale_row(locale);

update public.cards
set is_published = true,
    published_at = clock_timestamp()
where id = 'c1410000-0000-4000-8000-000000000001';

-- Atomic upload idempotency ---------------------------------------------

create temp table photo_upload_results (
  fixture_name text primary key,
  result jsonb not null
) on commit drop;

insert into photo_upload_results values (
  'first',
  api_private.issue_personal_card_temp_upload(
    'a1400000-0000-4000-8000-000000000001',
    true,
    'image/jpeg',
    1234,
    'b1400000-0000-4000-8000-000000000001'
  )
);

insert into photo_upload_results values (
  'replay',
  api_private.issue_personal_card_temp_upload(
    'a1400000-0000-4000-8000-000000000001',
    true,
    'image/jpeg',
    1234,
    'b1400000-0000-4000-8000-000000000001'
  )
);

select ok(
  (select result ->> 'status' = 'issued' and result ->> 'replayed' = 'false'
   from photo_upload_results where fixture_name = 'first')
  and
  (select result ->> 'status' = 'issued' and result ->> 'replayed' = 'true'
   from photo_upload_results where fixture_name = 'replay')
  and
  (select result ->> 'upload_id' from photo_upload_results where fixture_name = 'first') =
  (select result ->> 'upload_id' from photo_upload_results where fixture_name = 'replay')
  and
  (select result ->> 'temp_path' from photo_upload_results where fixture_name = 'first') =
  (select result ->> 'temp_path' from photo_upload_results where fixture_name = 'replay'),
  'same owner-key-payload returns the exact original reservation and path'
);

select is(
  (
    select cardinality(state_row.issued_at)::integer
    from private.personal_card_upload_rate_states as state_row
    where state_row.user_id = (
      select user_id from photo_boundary_users where fixture_name = 'upload'
    )
  ),
  1,
  'signed-token replay consumes neither a new rolling issue nor a new active slot'
);

select ok(
  (
    select upload_row.signed_url_expires_at =
      upload_row.signed_url_last_issued_at + interval '2 hours'
    from private.personal_card_temp_uploads as upload_row
    where upload_row.client_request_id =
      'b1400000-0000-4000-8000-000000000001'
  ),
  'a fresh five-argument issue derives an exact signed-window timestamp'
);

select is(
  api_private.issue_personal_card_temp_upload(
    'a1400000-0000-4000-8000-000000000001',
    true,
    'image/webp',
    1234,
    'b1400000-0000-4000-8000-000000000001'
  ),
  '{"status":"idempotency_conflict"}'::jsonb,
  'same upload key with a conflicting MIME returns a fixed 409 result'
);

select is(
  api_private.issue_personal_card_temp_upload(
    'a1400000-0000-4000-8000-000000000001',
    true,
    'image/jpeg',
    1235,
    'b1400000-0000-4000-8000-000000000001'
  ),
  '{"status":"idempotency_conflict"}'::jsonb,
  'same upload key with a conflicting byte size returns a fixed 409 result'
);

select is(
  api_private.issue_personal_card_temp_upload(
    'a1400000-0000-4000-8000-000000000002',
    true,
    'image/jpeg',
    1234,
    'b1400000-0000-4000-8000-000000000001'
  ) ->> 'status',
  'issued',
  'the same request UUID remains independent for another logical owner'
);

select throws_ok(
  $$
    update private.personal_card_temp_uploads
    set signed_url_reissue_count = 21
    where client_request_id = 'b1400000-0000-4000-8000-000000000001'
  $$,
  '23514',
  null,
  'the database physically bounds signed-token retries'
);

-- Three completed reservations exercise all retention branches: younger than
-- thirty days, older with a restrictive durable ledger, and older with no
-- remaining ledger ownership.
insert into public.acquisitions (
  id, user_id, spot_id, card_id, acquisition_type, verification_result,
  idempotency_key, acquired_at
)
select
  'c1400000-0000-4000-8000-000000000004',
  user_id,
  'b1410000-0000-4000-8000-000000000001',
  'c1410000-0000-4000-8000-000000000001',
  'gift',
  'not_applicable',
  'd1400000-0000-4000-8000-000000000004',
  clock_timestamp()
from photo_boundary_users
where fixture_name = 'upload';

insert into private.personal_card_temp_uploads (
  id, user_id, client_request_id, temp_path,
  declared_content_type, declared_size_bytes,
  issued_at, promotion_expires_at, signed_url_expires_at, quota_issued_at,
  temp_deleted_at, cleanup_started_at, cleanup_completed_at
)
select
  'e1400000-0000-4000-8000-000000000021',
  user_row.user_id,
  'b1400000-0000-4000-8000-000000000021',
  user_row.user_id::text || '/e1400000-0000-4000-8000-000000000021.jpg',
  'image/jpeg',
  128,
  fixture_time.issued_at,
  fixture_time.issued_at + interval '10 minutes',
  fixture_time.issued_at + interval '2 hours',
  fixture_time.issued_at,
  fixture_time.issued_at + interval '2 hours 1 minute',
  fixture_time.issued_at + interval '2 hours 1 minute',
  clock_timestamp() - interval '29 days'
from photo_boundary_users as user_row
cross join lateral (
  select clock_timestamp() - interval '31 days' as issued_at
) as fixture_time
where user_row.fixture_name = 'upload';

insert into private.personal_card_temp_uploads (
  id, user_id, client_request_id, temp_path,
  declared_content_type, declared_size_bytes,
  issued_at, promotion_expires_at, signed_url_expires_at, quota_issued_at,
  processing_token, processing_started_at, processing_expires_at,
  processing_acquisition_id, processing_permanent_path, processing_caption,
  temp_deleted_at, cleanup_started_at, cleanup_completed_at
)
select
  'e1400000-0000-4000-8000-000000000022',
  user_row.user_id,
  'b1400000-0000-4000-8000-000000000022',
  user_row.user_id::text || '/e1400000-0000-4000-8000-000000000022.jpg',
  'image/jpeg',
  256,
  fixture_time.issued_at,
  fixture_time.issued_at + interval '10 minutes',
  fixture_time.issued_at + interval '2 hours',
  fixture_time.issued_at,
  'f1400000-0000-4000-8000-000000000022',
  fixture_time.issued_at + interval '1 minute',
  fixture_time.issued_at + interval '6 minutes',
  'c1400000-0000-4000-8000-000000000004',
  user_row.user_id::text || '/f1400000-0000-4000-8000-000000000022.webp',
  'retention ledger',
  fixture_time.issued_at + interval '2 hours 1 minute',
  fixture_time.issued_at + interval '2 hours 1 minute',
  fixture_time.issued_at + interval '1 day'
from photo_boundary_users as user_row
cross join lateral (
  select clock_timestamp() - interval '40 days' as issued_at
) as fixture_time
where user_row.fixture_name = 'upload';

insert into private.personal_card_permanent_object_ledger (
  user_id, upload_id, processing_token, object_path, origin, reserved_bytes,
  final_delete_not_before, next_attempt_at
)
select
  upload_row.user_id,
  upload_row.id,
  upload_row.processing_token,
  upload_row.processing_permanent_path,
  'promotion',
  256,
  upload_row.processing_expires_at + interval '10 minutes',
  clock_timestamp()
from private.personal_card_temp_uploads as upload_row
where upload_row.id = 'e1400000-0000-4000-8000-000000000022';

update private.personal_card_temp_uploads
set issued_at = fixture_time.anchor_at - interval '40 days',
    promotion_expires_at =
      fixture_time.anchor_at - interval '40 days' + interval '10 minutes',
    signed_url_last_issued_at =
      fixture_time.anchor_at - interval '40 days' + interval '1 minute',
    signed_url_expires_at =
      fixture_time.anchor_at - interval '40 days' + interval '2 hours 1 minute',
    quota_issued_at = fixture_time.anchor_at - interval '40 days',
    temp_deleted_at = fixture_time.anchor_at - interval '39 days',
    cleanup_started_at = fixture_time.anchor_at - interval '39 days',
    cleanup_completed_at = fixture_time.anchor_at - interval '39 days'
from (select clock_timestamp() as anchor_at) as fixture_time
where client_request_id = 'b1400000-0000-4000-8000-000000000001'
  and user_id = (
    select user_id from photo_boundary_users where fixture_name = 'upload'
  );

select is(
  api_private.purge_completed_personal_card_uploads(100),
  '{"status":"purged","deleted":1}'::jsonb,
  'completed upload idempotency rows are purged in a bounded batch after thirty days'
);

select ok(
  exists (
    select 1
    from private.personal_card_temp_uploads
    where id = 'e1400000-0000-4000-8000-000000000021'
  )
  and exists (
    select 1
    from private.personal_card_temp_uploads
    where id = 'e1400000-0000-4000-8000-000000000022'
  )
  and not exists (
    select 1
    from private.personal_card_temp_uploads
    where client_request_id = 'b1400000-0000-4000-8000-000000000001'
      and user_id = (
        select user_id from photo_boundary_users where fixture_name = 'upload'
      )
  ),
  'retention preserves sub-thirty-day and ledger-owned rows but removes an eligible old receipt'
);

-- Immediate DB delete plus durable two-pass Storage job ------------------

insert into public.acquisitions (
  id, user_id, spot_id, card_id, acquisition_type, verification_result,
  idempotency_key, acquired_at
)
select
  'c1400000-0000-4000-8000-000000000001',
  user_id,
  'b1410000-0000-4000-8000-000000000001',
  'c1410000-0000-4000-8000-000000000001',
  'gift',
  'not_applicable',
  'd1400000-0000-4000-8000-000000000001',
  now()
from photo_boundary_users
where fixture_name = 'delete';

insert into public.personal_cards (
  id, user_id, acquisition_id, photo_path, photo_size_bytes, caption,
  share_state, share_slug, shared_at, share_submitted_at,
  share_terms_acceptance_id, share_community_acceptance_id,
  share_resubmission_required
)
select
  'e1400000-0000-4000-8000-000000000001',
  user_row.user_id,
  'c1400000-0000-4000-8000-000000000001',
  user_row.user_id::text || '/f1400000-0000-4000-8000-000000000001.webp',
  5242880,
  'delete me',
  'pending',
  repeat('A', 22),
  now(),
  now(),
  private.user_current_policy_acceptance_id(
    user_row.user_id, 'terms_of_use'::private.policy_type
  ),
  private.user_current_policy_acceptance_id(
    user_row.user_id, 'community_guidelines'::private.policy_type
  ),
  false
from photo_boundary_users as user_row
where fixture_name = 'delete';

insert into private.content_reports (
  id, client_report_id, personal_card_id, owner_user_id, share_secret_hash,
  target, reason
)
select
  'e1410000-0000-4000-8000-000000000001',
  'e1410000-0000-4000-8000-000000000002',
  'e1400000-0000-4000-8000-000000000001',
  user_id,
  decode(repeat('a5', 32), 'hex'),
  'content',
  'spam'
from photo_boundary_users
where fixture_name = 'delete';

insert into private.moderation_actions (
  admin_auth_user_id, client_action_id, personal_card_id, owner_user_id,
  action, previous_state, resulting_state, reason_code, note
)
select
  'a1400000-0000-4000-8000-000000000001',
  'e1410000-0000-4000-8000-000000000003',
  'e1400000-0000-4000-8000-000000000001',
  user_id,
  'take_down',
  'pending',
  'taken_down',
  'PERSONAL_DELETE_TEST',
  'individual deletion audit fixture'
from photo_boundary_users
where fixture_name = 'delete';

create temp table photo_delete_results (
  fixture_name text primary key,
  result jsonb not null
) on commit drop;

insert into photo_delete_results values (
  'first',
  api_private.request_personal_card_deletion(
    'a1400000-0000-4000-8000-000000000002',
    'e1400000-0000-4000-8000-000000000001',
    'f1400000-0000-4000-8000-000000000002'
  )
);

select is(
  (select result from photo_delete_results where fixture_name = 'first'),
  '{"status":"accepted"}'::jsonb,
  'a card deletion request is accepted'
);

select is(
  (
    select count(*)::bigint
    from public.personal_cards
    where id = 'e1400000-0000-4000-8000-000000000001'
  ),
  0::bigint,
  'the personal-card DB row and acquisition uniqueness are released immediately'
);

select ok(
  (
    select report_row.personal_card_id is null
      and report_row.personal_card_redacted_at is not null
      and report_row.share_secret_hash is null
      and report_row.share_secret_redacted_at is not null
    from private.content_reports as report_row
    where report_row.id = 'e1410000-0000-4000-8000-000000000001'
  )
  and (
    select action_row.personal_card_id is null
      and action_row.personal_card_redacted_at is not null
    from private.moderation_actions as action_row
    where action_row.client_action_id =
      'e1410000-0000-4000-8000-000000000003'
  ),
  'individual deletion executes the retained-audit redaction trigger'
);

select ok(
  exists (
    select 1
    from private.data_erasure_jobs as job_row
    join private.data_erasure_manifest as item_row on item_row.job_id = job_row.id
    where job_row.scope = 'personal_card'
      and job_row.personal_card_id = 'e1400000-0000-4000-8000-000000000001'
      and job_row.state = 'pending'
      and item_row.bucket = 'personal-cards'
      and item_row.object_path like '%/f1400000-0000-4000-8000-000000000001.webp'
      and item_row.deleted_at is null
  ),
  'the deleted row leaves one durable generic two-pass Storage manifest'
);

select is(
  api_private.request_personal_card_deletion(
    'a1400000-0000-4000-8000-000000000002',
    'e1400000-0000-4000-8000-000000000001',
    'f1400000-0000-4000-8000-000000000002'
  ),
  '{"status":"accepted"}'::jsonb,
  'response-loss retry succeeds after the card row has already been deleted'
);

select is(
  api_private.request_personal_card_deletion(
    'a1400000-0000-4000-8000-000000000002',
    'e1400000-0000-4000-8000-000000000099',
    'f1400000-0000-4000-8000-000000000002'
  ),
  '{"status":"idempotency_conflict"}'::jsonb,
  'same delete key cannot be reused for another card id'
);

select is(
  api_private.request_personal_card_deletion(
    'a1400000-0000-4000-8000-000000000001',
    'e1400000-0000-4000-8000-000000000001',
    'f1400000-0000-4000-8000-000000000003'
  ),
  '{"status":"not_found"}'::jsonb,
  'missing and non-owned cards use one non-enumerating result'
);

-- Account deletion takes sole ownership of an already-pending card erasure.
insert into public.acquisitions (
  id, user_id, spot_id, card_id, acquisition_type, verification_result,
  idempotency_key, acquired_at
)
select
  'c1400000-0000-4000-8000-000000000003',
  user_id,
  'b1410000-0000-4000-8000-000000000001',
  'c1410000-0000-4000-8000-000000000001',
  'gift',
  'not_applicable',
  'd1400000-0000-4000-8000-000000000003',
  clock_timestamp()
from photo_boundary_users
where fixture_name = 'account_transfer';

insert into public.personal_cards (
  id, user_id, acquisition_id, photo_path, photo_size_bytes, caption
)
select
  'e1400000-0000-4000-8000-000000000003',
  user_id,
  'c1400000-0000-4000-8000-000000000003',
  user_id::text || '/f1400000-0000-4000-8000-000000000020.webp',
  5242880,
  'account transfer'
from photo_boundary_users
where fixture_name = 'account_transfer';

select is(
  api_private.request_personal_card_deletion(
    'a1400000-0000-4000-8000-000000000003',
    'e1400000-0000-4000-8000-000000000003',
    'f1400000-0000-4000-8000-000000000020'
  ),
  '{"status":"accepted"}'::jsonb,
  'account-transfer fixture first creates an individual erasure job'
);

select is(
  api_private.request_account_deletion(
    'a1400000-0000-4000-8000-000000000003',
    'd1410000-0000-4000-8000-000000000003',
    repeat('ab', 32)
  ) ->> 'status',
  'accepted',
  'account deletion accepts ownership after individual card deletion'
);

select ok(
  exists (
    select 1
    from private.account_deletion_storage_manifest as item_row
    where item_row.request_id = 'd1410000-0000-4000-8000-000000000003'
      and item_row.bucket = 'personal-cards'
      and item_row.object_path like '%/f1400000-0000-4000-8000-000000000020.webp'
  )
  and not exists (
    select 1
    from private.data_erasure_jobs as job_row
    where job_row.personal_card_id = 'e1400000-0000-4000-8000-000000000003'
  )
  and not exists (
    select 1
    from private.personal_card_deletion_requests as request_row
    where request_row.client_request_id =
      'f1400000-0000-4000-8000-000000000020'
  ),
  'account deletion transfers the path then cascades the superseded job and receipt'
);

-- Recreate from the same acquisition while the old Storage job is pending.
insert into public.personal_cards (
  id, user_id, acquisition_id, photo_path, photo_size_bytes, caption
)
select
  'e1400000-0000-4000-8000-000000000002',
  user_id,
  'c1400000-0000-4000-8000-000000000001',
  user_id::text || '/f1400000-0000-4000-8000-000000000004.webp',
  5242880,
  'replacement'
from photo_boundary_users
where fixture_name = 'delete';

select ok(
  exists (
    select 1 from public.personal_cards
    where id = 'e1400000-0000-4000-8000-000000000002'
  ),
  'the same acquisition accepts a fresh replacement card immediately'
);

-- Build 495 MiB of live cards (the replacement plus 98 fixtures) while the
-- deleted 5 MiB object remains pending. Direct trusted inserts are charged at
-- the conservative 5 MiB default by the quota trigger.
with inserted_acquisitions as (
  insert into public.acquisitions (
    id, user_id, spot_id, card_id, acquisition_type, verification_result,
    idempotency_key, acquired_at
  )
  select
    gen_random_uuid(),
    user_row.user_id,
    'b1410000-0000-4000-8000-000000000001',
    'c1410000-0000-4000-8000-000000000001',
    'gift',
    'not_applicable',
    gen_random_uuid(),
    clock_timestamp() + sequence_row.value * interval '1 millisecond'
  from photo_boundary_users as user_row
  cross join generate_series(1, 98) as sequence_row(value)
  where user_row.fixture_name = 'delete'
  returning id, user_id
)
insert into public.personal_cards (
  id, user_id, acquisition_id, photo_path, photo_size_bytes, caption
)
select
  gen_random_uuid(),
  acquisition_row.user_id,
  acquisition_row.id,
  acquisition_row.user_id::text || '/' || acquisition_row.id::text || '.webp',
  5242880,
  'quota fixture'
from inserted_acquisitions as acquisition_row;

select ok(
  (
    select coalesce(sum(card_row.photo_size_bytes), 0) = 519045120
    from public.personal_cards as card_row
    where card_row.user_id = (
      select user_id from photo_boundary_users where fixture_name = 'delete'
    )
  )
  and (
    select pending_storage_bytes = 5242880
    from private.personal_card_deletion_requests
    where client_request_id = 'f1400000-0000-4000-8000-000000000002'
  ),
  '495 MiB live plus the deleting 5 MiB object is charged at the physical ceiling'
);

select is(
  api_private.issue_personal_card_temp_upload(
    'a1400000-0000-4000-8000-000000000002',
    true,
    'image/jpeg',
    1024,
    'b1400000-0000-4000-8000-000000000099'
  ),
  '{"status":"quota_exceeded","reason":"storage_bytes"}'::jsonb,
  'upload reservation issuance also charges the pending deleted object'
);

insert into public.acquisitions (
  id, user_id, spot_id, card_id, acquisition_type, verification_result,
  idempotency_key, acquired_at
)
select
  'c1400000-0000-4000-8000-000000000002',
  user_id,
  'b1410000-0000-4000-8000-000000000001',
  'c1410000-0000-4000-8000-000000000001',
  'gift',
  'not_applicable',
  'd1400000-0000-4000-8000-000000000002',
  clock_timestamp()
from photo_boundary_users
where fixture_name = 'delete';

insert into private.personal_card_temp_uploads (
  id, user_id, temp_path, declared_content_type, declared_size_bytes,
  issued_at, promotion_expires_at, signed_url_expires_at, quota_issued_at
)
select
  'e1400000-0000-4000-8000-000000000010',
  user_row.user_id,
  user_row.user_id::text || '/e1400000-0000-4000-8000-000000000010.jpg',
  'image/jpeg',
  1024,
  fixture_time.issued_at,
  fixture_time.issued_at + interval '10 minutes',
  fixture_time.issued_at + interval '2 hours',
  fixture_time.issued_at
from photo_boundary_users as user_row
cross join lateral (select clock_timestamp() as issued_at) as fixture_time
where user_row.fixture_name = 'delete';

select is(
  api_private.begin_personal_card_promotion(
    'a1400000-0000-4000-8000-000000000002',
    true,
    'c1400000-0000-4000-8000-000000000001',
    (select temp_path from private.personal_card_temp_uploads
     where id = 'e1400000-0000-4000-8000-000000000010'),
    'response-loss retry',
    'f1400000-0000-4000-8000-000000000011'
  ) ->> 'status',
  'already_created',
  'an existing completed acquisition remains idempotent at the physical ceiling'
);

select is(
  api_private.begin_personal_card_promotion(
    'a1400000-0000-4000-8000-000000000002',
    true,
    'c1400000-0000-4000-8000-000000000002',
    (select temp_path from private.personal_card_temp_uploads
     where id = 'e1400000-0000-4000-8000-000000000010'),
    'quota boundary',
    'f1400000-0000-4000-8000-000000000010'
  ),
  '{"status":"quota_exceeded","reason":"storage_bytes"}'::jsonb,
  'a new 5 MiB promotion is rejected while a deleted 5 MiB object is pending'
);

-- Existing generic claim is scope-independent and ordered by request time.
update private.data_erasure_jobs
set requested_at = now() - interval '2 hours'
where scope = 'personal_card';

create temp table photo_erasure_claims (
  stage text primary key,
  result jsonb not null
) on commit drop;

insert into photo_erasure_claims values (
  'first',
  api_private.claim_data_erasure_jobs(
    'f1400000-0000-4000-8000-000000000005', 1, 4
  )
);

select is(
  (select result -> 'jobs' -> 0 ->> 'scope'
   from photo_erasure_claims where stage = 'first'),
  'personal_card',
  'the common oldest-first claimant fairly offers personal-card work'
);

select is(
  api_private.record_data_erasure_item_result(
    'f1400000-0000-4000-8000-000000000005',
    (select (result -> 'jobs' -> 0 ->> 'id')::uuid
     from photo_erasure_claims where stage = 'first'),
    (select (result -> 'jobs' -> 0 -> 'items' -> 0 ->> 'id')::bigint
     from photo_erasure_claims where stage = 'first'),
    true
  ),
  '{"status":"recorded"}'::jsonb,
  'the common worker records the first Storage deletion pass'
);

select is(
  api_private.finish_data_erasure_job(
    'f1400000-0000-4000-8000-000000000005',
    (select (result -> 'jobs' -> 0 ->> 'id')::uuid
     from photo_erasure_claims where stage = 'first')
  ),
  '{"status":"retry"}'::jsonb,
  'one Storage deletion pass cannot complete the personal-card job'
);

-- Advance the second-pass boundary without sleeping.
update private.data_erasure_manifest
set first_deleted_at = clock_timestamp() - interval '11 minutes',
    final_delete_after = clock_timestamp() - interval '1 minute'
where job_id = (
  select erasure_job_id
  from private.personal_card_deletion_requests
  where client_request_id = 'f1400000-0000-4000-8000-000000000002'
);
update private.data_erasure_jobs
set next_attempt_at = clock_timestamp()
where id = (
  select erasure_job_id
  from private.personal_card_deletion_requests
  where client_request_id = 'f1400000-0000-4000-8000-000000000002'
);

insert into photo_erasure_claims values (
  'final',
  api_private.claim_data_erasure_jobs(
    'f1400000-0000-4000-8000-000000000006', 1, 4
  )
);

select is(
  (select result -> 'jobs' -> 0 -> 'items' -> 0 ->> 'phase'
   from photo_erasure_claims where stage = 'final'),
  'final',
  'the generic claimant offers a distinct final Storage deletion pass'
);

select is(
  api_private.record_data_erasure_item_result(
    'f1400000-0000-4000-8000-000000000006',
    (select (result -> 'jobs' -> 0 ->> 'id')::uuid
     from photo_erasure_claims where stage = 'final'),
    (select (result -> 'jobs' -> 0 -> 'items' -> 0 ->> 'id')::bigint
     from photo_erasure_claims where stage = 'final'),
    true
  ),
  '{"status":"recorded"}'::jsonb,
  'the common worker records the final Storage deletion pass'
);

select is(
  api_private.finish_data_erasure_job(
    'f1400000-0000-4000-8000-000000000006',
    (select (result -> 'jobs' -> 0 ->> 'id')::uuid
     from photo_erasure_claims where stage = 'final')
  ),
  '{"status":"completed"}'::jsonb,
  'the personal-card job completes only after both Storage passes'
);

select is(
  (
    select pending_storage_bytes
    from private.personal_card_deletion_requests
    where client_request_id = 'f1400000-0000-4000-8000-000000000002'
  ),
  0::bigint,
  'physical deletion charge is released only after final-pass completion'
);

-- Fill the released five MiB with a real live card. This is intentionally a
-- distinct oracle from the 495 MiB live + 5 MiB deletion-pending case above:
-- the legacy storage/backlog wrappers also see this exact 500 MiB live state.
with inserted_acquisition as (
  insert into public.acquisitions (
    id, user_id, spot_id, card_id, acquisition_type, verification_result,
    idempotency_key, acquired_at
  )
  select
    'c1400000-0000-4000-8000-000000000005',
    user_id,
    'b1410000-0000-4000-8000-000000000001',
    'c1410000-0000-4000-8000-000000000001',
    'gift',
    'not_applicable',
    'd1400000-0000-4000-8000-000000000005',
    clock_timestamp()
  from photo_boundary_users
  where fixture_name = 'delete'
  returning id, user_id
)
insert into public.personal_cards (
  id, user_id, acquisition_id, photo_path, photo_size_bytes, caption
)
select
  'e1400000-0000-4000-8000-000000000005',
  acquisition_row.user_id,
  acquisition_row.id,
  acquisition_row.user_id::text || '/e1400000-0000-4000-8000-000000000005.webp',
  5242880,
  'true live ceiling'
from inserted_acquisition as acquisition_row;

select is(
  (
    select coalesce(sum(card_row.photo_size_bytes), 0)::bigint
    from public.personal_cards as card_row
    where card_row.user_id = (
      select user_id from photo_boundary_users where fixture_name = 'delete'
    )
  ),
  524288000::bigint,
  'the retry oracle reaches the exact five-hundred-MiB live-card ceiling'
);

select is(
  api_private.begin_personal_card_promotion(
    'a1400000-0000-4000-8000-000000000002',
    true,
    'c1400000-0000-4000-8000-000000000001',
    (select temp_path from private.personal_card_temp_uploads
     where id = 'e1400000-0000-4000-8000-000000000010'),
    'response-loss retry at live ceiling',
    'f1400000-0000-4000-8000-000000000012'
  ) ->> 'status',
  'already_created',
  'a completed acquisition remains idempotent at the true live-card ceiling'
);

select is(
  api_private.begin_personal_card_promotion(
    'a1400000-0000-4000-8000-000000000002',
    true,
    'c1400000-0000-4000-8000-000000000002',
    (select temp_path from private.personal_card_temp_uploads
     where id = 'e1400000-0000-4000-8000-000000000010'),
    'new promotion at live ceiling',
    'f1400000-0000-4000-8000-000000000010'
  ),
  '{"status":"quota_exceeded","reason":"storage_bytes"}'::jsonb,
  'a genuinely new promotion remains blocked at the true live-card ceiling'
);

-- Completed job receipts are bounded by the existing thirty-day purge.
update private.data_erasure_jobs
set completed_at = now() - interval '31 days'
where scope = 'personal_card'
  and state = 'completed';

select is(
  api_private.purge_expired_location_compliance_records(250) ->>
    'completed_erasure_receipts_deleted',
  '1',
  'the existing retention worker removes a completed card job after thirty days'
);

select is(
  (
    select count(*)::bigint
    from private.personal_card_deletion_requests
    where client_request_id = 'f1400000-0000-4000-8000-000000000002'
  ),
  0::bigint,
  'job purge cascades the owner-scoped response-loss receipt'
);

select * from finish();
rollback;
