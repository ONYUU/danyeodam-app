begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

-- Schema and least-privilege boundary ------------------------------------

select ok(
  (
    select relation_row.relrowsecurity and relation_row.relforcerowsecurity
    from pg_class as relation_row
    join pg_namespace as schema_row
      on schema_row.oid = relation_row.relnamespace
    where schema_row.nspname = 'private'
      and relation_row.relname = 'personal_card_upload_rate_states'
  ),
  'upload rate state enables and forces RLS'
);

select is(
  (
    select count(*)::bigint
    from information_schema.role_table_grants as grant_row
    where grant_row.table_schema = 'private'
      and grant_row.table_name = 'personal_card_upload_rate_states'
      and grant_row.grantee in ('anon', 'authenticated', 'service_role')
  ),
  0::bigint,
  'Data API roles have no direct upload-rate-state privileges'
);

select ok(
  exists (
    select 1
    from information_schema.columns as column_row
    where column_row.table_schema = 'public'
      and column_row.table_name = 'personal_cards'
      and column_row.column_name = 'photo_size_bytes'
      and column_row.is_nullable = 'NO'
      and column_row.column_default like '%5242880%'
  ),
  'personal cards persist non-null derived-image byte accounting'
);

select ok(
  has_function_privilege(
    'service_role',
    'api_private.complete_personal_card_promotion_with_size(uuid,uuid,uuid,uuid,text,text,bigint,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'api_private.complete_personal_card_promotion_with_size(uuid,uuid,uuid,uuid,text,text,bigint,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'api_private.complete_personal_card_promotion_with_size(uuid,uuid,uuid,uuid,text,text,bigint,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'api_private.complete_personal_card_promotion_with_size_unbound(uuid,uuid,uuid,uuid,text,text,bigint)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'api_private.complete_personal_card_promotion_before_storage_quota(uuid,uuid,uuid,uuid,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'api_private.complete_personal_card_promotion(uuid,uuid,uuid,uuid,text,text)',
    'EXECUTE'
  ),
  'only the exact-size quota-aware completion boundary is service-role executable'
);

select is(
  api_private.complete_personal_card_promotion(
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000004',
    '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000003.webp',
    ''
  ),
  '{"status":"validation_failed","reason":"exact_derived_size_required"}'::jsonb,
  'the historical completion signature fails closed without an exact byte length'
);

select ok(
  has_function_privilege(
    'service_role',
    'api_private.cancel_personal_card_temp_upload_issue(uuid,timestamptz)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'api_private.cancel_personal_card_temp_upload_issue(uuid,timestamptz)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'api_private.cancel_personal_card_temp_upload_issue(uuid,timestamptz)',
    'EXECUTE'
  ),
  'only the service role can compensate a failed signed-URL issuance'
);

select ok(
  pg_get_functiondef(
    'api_private.issue_personal_card_temp_upload(uuid,boolean,text,bigint,uuid)'::regprocedure
  ) like '%danyeodam:suspend-owner:%'
  and pg_get_functiondef(
    'api_private.complete_personal_card_promotion_with_size_unbound(uuid,uuid,uuid,uuid,text,text,bigint)'::regprocedure
  ) like '%danyeodam:suspend-owner:%'
  and pg_get_functiondef(
    'api_private.complete_personal_card_promotion_with_size(uuid,uuid,uuid,uuid,text,text,bigint,uuid)'::regprocedure
  ) like '%lock_expected_active_user_id_for_auth%',
  'issuance and completion serialize on the account-deletion owner lock'
);

select ok(
  exists (
    select 1
    from pg_constraint as constraint_row
    where constraint_row.conrelid =
      'private.personal_card_upload_rate_states'::regclass
      and constraint_row.conname =
        'personal_card_upload_rate_states_bounded'
      and pg_get_constraintdef(constraint_row.oid)
        like '%cardinality(issued_at) <= 20%'
  ),
  'rolling upload state is physically bounded to twenty timestamps'
);

select ok(
  exists (
    select 1
    from pg_constraint as constraint_row
    where constraint_row.conrelid = 'public.personal_cards'::regclass
      and constraint_row.conname = 'personal_cards_photo_size_bytes_valid'
      and pg_get_constraintdef(constraint_row.oid) like '%5242880%'
  ),
  'each permanent derived image is capped at five MiB'
);

-- Fixtures ---------------------------------------------------------------

insert into auth.users (id, created_at, updated_at, is_anonymous, raw_user_meta_data)
values
  ('a1100000-0000-4000-8000-000000000001', now(), now(), true, '{}'),
  ('a1100000-0000-4000-8000-000000000002', now(), now(), true, '{}'),
  ('a1100000-0000-4000-8000-000000000003', now(), now(), true, '{}'),
  ('a1100000-0000-4000-8000-000000000004', now(), now(), true, '{}'),
  ('a1100000-0000-4000-8000-000000000005', now(), now(), true, '{}');

create temp table upload_quota_users (
  fixture_name text primary key,
  auth_user_id uuid not null,
  user_id uuid not null
) on commit drop;

insert into upload_quota_users (fixture_name, auth_user_id, user_id)
select fixture.fixture_name, fixture.auth_user_id, identity_row.user_id
from (
  values
    ('rate', 'a1100000-0000-4000-8000-000000000001'::uuid),
    ('complete', 'a1100000-0000-4000-8000-000000000002'::uuid),
    ('count', 'a1100000-0000-4000-8000-000000000003'::uuid),
    ('bytes', 'a1100000-0000-4000-8000-000000000004'::uuid),
    ('backlog', 'a1100000-0000-4000-8000-000000000005'::uuid)
) as fixture(fixture_name, auth_user_id)
join private.user_identities as identity_row
  on identity_row.auth_user_id = fixture.auth_user_id
 and identity_row.revoked_at is null;

insert into private.policy_documents (
  id, policy_type, version, effective_at, published_at, is_current
)
values
  (
    'b1100000-0000-4000-8000-000000000001',
    'terms_of_use', 'quota-v1', now() - interval '1 minute', now(), false
  ),
  (
    'b1100000-0000-4000-8000-000000000002',
    'privacy_policy', 'quota-v1', now() - interval '1 minute', now(), false
  ),
  (
    'b1100000-0000-4000-8000-000000000003',
    'community_guidelines', 'quota-v1', now() - interval '1 minute', now(), false
  ),
  (
    'b1100000-0000-4000-8000-000000000004',
    'location_terms', 'quota-v1', now() - interval '1 minute', now(), false
  );

insert into private.policy_document_locales (
  policy_document_id, locale, document_url, sha256
)
select
  policy_row.id,
  locale_row.locale,
  'https://policies.test/quota/' || policy_row.id::text ||
    '/' || locale_row.locale::text,
  extensions.digest(
    'quota:' || policy_row.id::text || ':' || locale_row.locale::text,
    'sha256'
  )
from private.policy_documents as policy_row
cross join unnest(enum_range(null::public.content_locale)) as locale_row(locale)
where policy_row.version = 'quota-v1';

select is(
  api_private.set_current_policy_documents(array[
    'b1100000-0000-4000-8000-000000000001'::uuid,
    'b1100000-0000-4000-8000-000000000002'::uuid,
    'b1100000-0000-4000-8000-000000000003'::uuid,
    'b1100000-0000-4000-8000-000000000004'::uuid
  ]),
  '{"status":"switched"}'::jsonb,
  'quota fixtures publish one complete policy set'
);

insert into private.policy_acceptances (
  user_id, policy_document_id, accepted_locale, accepted_sha256
)
select
  user_row.user_id,
  policy_row.id,
  'ko'::public.content_locale,
  locale_row.sha256
from upload_quota_users as user_row
cross join private.policy_documents as policy_row
join private.policy_document_locales as locale_row
  on locale_row.policy_document_id = policy_row.id
 and locale_row.locale = 'ko'
where user_row.fixture_name in ('rate', 'complete', 'backlog')
  and policy_row.policy_type in ('terms_of_use', 'community_guidelines');

insert into public.regions (code, country_code, sort_order)
values ('upload-quota-test', 'KR', 1);

insert into public.region_translations (
  region_code, locale, name, status, approved_at, approved_by
)
select
  'upload-quota-test', locale_row.locale, 'Upload Quota', 'approved', now(),
  'a1100000-0000-4000-8000-000000000001'
from unnest(enum_range(null::public.content_locale)) as locale_row(locale);

insert into public.spots (
  id, slug, region, name_ko, name_en, status, latitude, longitude
)
values (
  'b1110000-0000-4000-8000-000000000001',
  'upload-quota-test', 'upload-quota-test', '업로드 한도', 'Upload Quota',
  'draft', 37.5, 127.0
);

insert into public.spot_translations (
  spot_id, locale, name, status, approved_at, approved_by
)
select
  'b1110000-0000-4000-8000-000000000001', locale_row.locale,
  'Upload Quota', 'approved', now(),
  'a1100000-0000-4000-8000-000000000001'
from unnest(enum_range(null::public.content_locale)) as locale_row(locale);

insert into public.cards (
  id, spot_id, code, kind, title_ko, title_en, sketch_path, color_hex,
  is_published, published_at
)
values (
  'c1100000-0000-4000-8000-000000000001',
  'b1110000-0000-4000-8000-000000000001',
  'upload-quota-card', 'region', '업로드 한도', 'Upload Quota',
  'cards/upload-quota.webp', '#123456', false, null
);

insert into public.card_translations (
  card_id, locale, title, status, approved_at, approved_by
)
select
  'c1100000-0000-4000-8000-000000000001', locale_row.locale,
  'Upload Quota', 'approved', now(),
  'a1100000-0000-4000-8000-000000000001'
from unnest(enum_range(null::public.content_locale)) as locale_row(locale);

update public.cards
set is_published = true, published_at = now()
where id = 'c1100000-0000-4000-8000-000000000001';

update public.spots
set status = 'open'
where id = 'b1110000-0000-4000-8000-000000000001';

-- Upload URL issuance: active objects and two rolling windows -------------

create temp table upload_quota_issue_results (
  sequence_number integer primary key,
  result jsonb not null
) on commit drop;

insert into upload_quota_issue_results (sequence_number, result)
select
  issue_number,
  api_private.issue_personal_card_temp_upload(
    'a1100000-0000-4000-8000-000000000001',
    true,
    'image/jpeg',
    123
  )
from generate_series(1, 3) as issue_number;

select is(
  (
    select count(*)::bigint
    from upload_quota_issue_results as result_row
    where result_row.result ->> 'status' = 'issued'
  ),
  3::bigint,
  'the first three active temporary uploads are issued'
);

select is(
  api_private.cancel_personal_card_temp_upload_issue(
    (select (result ->> 'upload_id')::uuid
     from upload_quota_issue_results where sequence_number = 3),
    (select (result ->> 'quota_issued_at')::timestamptz
     from upload_quota_issue_results where sequence_number = 3)
  ) ->> 'status',
  'cancelled',
  'a failed signed-URL call cancels its exact untouched upload reservation'
);

select ok(
  (
    select count(*) = 2
    from private.personal_card_temp_uploads as upload_row
    where upload_row.user_id = (
      select user_id from upload_quota_users where fixture_name = 'rate'
    )
      and upload_row.cleanup_completed_at is null
  )
  and (
    select cardinality(state_row.issued_at) = 2
    from private.personal_card_upload_rate_states as state_row
    where state_row.user_id = (
      select user_id from upload_quota_users where fixture_name = 'rate'
    )
  ),
  'cancellation removes one row and refunds exactly one rolling timestamp'
);

select is(
  api_private.issue_personal_card_temp_upload(
    'a1100000-0000-4000-8000-000000000001',
    true,
    'image/jpeg',
    123
  ) ->> 'status',
  'issued',
  'a compensated reservation immediately restores one active upload slot'
);

select is(
  api_private.issue_personal_card_temp_upload(
    'a1100000-0000-4000-8000-000000000001',
    true,
    'image/jpeg',
    123
  ),
  '{"status":"quota_exceeded","reason":"active_temp_uploads"}'::jsonb,
  'a fourth uncleaned temporary upload is rejected by the DB RPC'
);

select is(
  (
    select count(*)::bigint
    from private.personal_card_temp_uploads as upload_row
    where upload_row.user_id = (
      select user_id from upload_quota_users where fixture_name = 'rate'
    )
      and upload_row.cleanup_completed_at is null
  ),
  3::bigint,
  'quota rejection leaves no fourth temporary path behind'
);

delete from private.personal_card_temp_uploads
where user_id = (
  select user_id from upload_quota_users where fixture_name = 'rate'
);

do $quota_loop$
declare
  v_result jsonb;
  v_index integer;
begin
  for v_index in 4..10 loop
    v_result := api_private.issue_personal_card_temp_upload(
      'a1100000-0000-4000-8000-000000000001',
      true,
      'image/jpeg',
      123
    );
    insert into upload_quota_issue_results (sequence_number, result)
    values (v_index, v_result);
    delete from private.personal_card_temp_uploads
    where id = (v_result ->> 'upload_id')::uuid;
  end loop;
end;
$quota_loop$;

select is(
  (
    select count(*)::bigint
    from upload_quota_issue_results as result_row
    where result_row.result ->> 'status' = 'issued'
  ),
  10::bigint,
  'ten successful URL issuances fit inside the rolling hour'
);

create temp table upload_quota_denial (result jsonb not null) on commit drop;
insert into upload_quota_denial
values (
  api_private.issue_personal_card_temp_upload(
    'a1100000-0000-4000-8000-000000000001',
    true,
    'image/jpeg',
    123
  )
);

select ok(
  (
    select result ->> 'status' = 'rate_limited'
      and (result ->> 'retry_after_seconds')::integer between 1 and 3600
    from upload_quota_denial
  ),
  'the eleventh rolling-hour issuance returns a bounded retry interval'
);

select is(
  (
    select cardinality(state_row.issued_at)::integer
    from private.personal_card_upload_rate_states as state_row
    where state_row.user_id = (
      select user_id from upload_quota_users where fixture_name = 'rate'
    )
  ),
  10,
  'a denied hourly attempt is not recorded as an issuance'
);

update private.personal_card_upload_rate_states
set issued_at = array(
      select clock_timestamp() - interval '2 hours' -
        (issue_number * interval '1 minute')
      from generate_series(1, 20) as issue_number
    ),
    updated_at = clock_timestamp()
where user_id = (
  select user_id from upload_quota_users where fixture_name = 'rate'
);

truncate upload_quota_denial;
insert into upload_quota_denial
values (
  api_private.issue_personal_card_temp_upload(
    'a1100000-0000-4000-8000-000000000001',
    true,
    'image/jpeg',
    123
  )
);

select ok(
  (
    select result ->> 'status' = 'rate_limited'
      and (result ->> 'retry_after_seconds')::integer between 1 and 86400
    from upload_quota_denial
  ),
  'the twenty-first rolling-24-hour issuance is rate limited'
);

select is(
  (
    select count(*)::bigint
    from private.personal_card_temp_uploads as upload_row
    where upload_row.user_id = (
      select user_id from upload_quota_users where fixture_name = 'rate'
    )
  ),
  0::bigint,
  'rate-limit rejection rolls back its provisional temporary path'
);

-- Size-aware completion --------------------------------------------------

insert into public.acquisitions (
  id, user_id, spot_id, card_id, acquisition_type, verification_result,
  idempotency_key, field_sequence, acquired_at
)
values (
  'd1100000-0000-4000-8000-000000000001',
  (select user_id from upload_quota_users where fixture_name = 'complete'),
  'b1110000-0000-4000-8000-000000000001',
  'c1100000-0000-4000-8000-000000000001',
  'gift', 'not_applicable',
  'e1100000-0000-4000-8000-000000000001', null, now()
);

create temp table upload_quota_completion (
  issue_result jsonb,
  begin_result jsonb,
  complete_result jsonb
) on commit drop;

insert into upload_quota_completion (issue_result)
values (
  api_private.issue_personal_card_temp_upload(
    'a1100000-0000-4000-8000-000000000002',
    true,
    'image/jpeg',
    123
  )
);

update upload_quota_completion
set begin_result = api_private.begin_personal_card_promotion(
  'a1100000-0000-4000-8000-000000000002',
  true,
  'd1100000-0000-4000-8000-000000000001',
  issue_result ->> 'temp_path',
  'quota exact size',
  'f1100000-0000-4000-8000-000000000001'
);

select is(
  (
    select ledger_row.reserved_bytes
    from private.personal_card_permanent_object_ledger as ledger_row
    where ledger_row.processing_token =
      'f1100000-0000-4000-8000-000000000001'
  ),
  5242880::bigint,
  'non-field begin reserves five MiB before permanent Storage I/O'
);

update upload_quota_completion
set complete_result = api_private.complete_personal_card_promotion_with_size(
  'a1100000-0000-4000-8000-000000000002',
  (issue_result ->> 'upload_id')::uuid,
  'f1100000-0000-4000-8000-000000000001',
  'd1100000-0000-4000-8000-000000000001',
  begin_result ->> 'permanent_path',
  'quota exact size',
  1234,
  (begin_result ->> 'user_id')::uuid
);

select is(
  (select complete_result ->> 'status' from upload_quota_completion),
  'created',
  'the size-aware completion RPC creates the card'
);

select is(
  (
    select card_row.photo_size_bytes
    from public.personal_cards as card_row
    where card_row.id = (
      select (complete_result ->> 'personal_card_id')::uuid
      from upload_quota_completion
    )
  ),
  1234::bigint,
  'completion stores the exact server-derived WebP byte length'
);

select is(
  (
    select count(*)::bigint
    from private.personal_card_permanent_object_ledger as ledger_row
    where ledger_row.processing_token =
      'f1100000-0000-4000-8000-000000000001'
  ),
  0::bigint,
  'exact successful completion atomically replaces and removes its reservation'
);

select is(
  api_private.complete_personal_card_promotion_with_size(
    'a1100000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003',
    'invalid/path.webp',
    '',
    5242881,
    (select user_id from upload_quota_users where fixture_name = 'complete')
  ),
  '{"status":"quota_exceeded","reason":"derived_file_size"}'::jsonb,
  'a derived object larger than five MiB fails before DB completion'
);

select throws_ok(
  format(
    'update public.personal_cards set photo_size_bytes = 1 where id = %L',
    (
      select complete_result ->> 'personal_card_id'
      from upload_quota_completion
    )
  ),
  '23514',
  'personal-card owner and byte accounting are immutable',
  'persisted byte accounting cannot be reduced after creation'
);

-- Repeated begin/release hard bound -------------------------------------

insert into public.acquisitions (
  id, user_id, spot_id, card_id, acquisition_type, verification_result,
  idempotency_key, field_sequence, acquired_at
)
values (
  'd1130000-0000-4000-8000-000000000001',
  (select user_id from upload_quota_users where fixture_name = 'backlog'),
  'b1110000-0000-4000-8000-000000000001',
  'c1100000-0000-4000-8000-000000000001',
  'gift', 'not_applicable',
  'e1130000-0000-4000-8000-000000000001', null, now()
);

create temp table upload_quota_backlog_issue (
  result jsonb not null
) on commit drop;

insert into upload_quota_backlog_issue (result)
values (api_private.issue_personal_card_temp_upload(
  'a1100000-0000-4000-8000-000000000005',
  true,
  'image/jpeg',
  123
));

do $permanent_backlog_loop$
declare
  v_index integer;
  v_token uuid;
  v_result jsonb;
  v_upload_id uuid := (
    select (result ->> 'upload_id')::uuid from upload_quota_backlog_issue
  );
  v_temp_path text := (
    select result ->> 'temp_path' from upload_quota_backlog_issue
  );
begin
  for v_index in 1..20 loop
    v_token := (
      'f1130000-0000-4000-8000-' || lpad(v_index::text, 12, '0')
    )::uuid;
    v_result := api_private.begin_personal_card_promotion(
      'a1100000-0000-4000-8000-000000000005',
      true,
      'd1130000-0000-4000-8000-000000000001',
      v_temp_path,
      'bounded ambiguous retry',
      v_token
    );
    if v_result ->> 'status' <> 'ready' then
      raise exception 'unexpected begin result at %: %', v_index, v_result;
    end if;
    v_result := api_private.release_personal_card_promotion(
      v_upload_id,
      v_token
    );
    if v_result ->> 'status' <> 'updated' then
      raise exception 'unexpected release result at %: %', v_index, v_result;
    end if;
  end loop;
end;
$permanent_backlog_loop$;

select is(
  (
    select count(*)::bigint
    from private.personal_card_permanent_object_ledger as ledger_row
    where ledger_row.user_id = (
      select user_id from upload_quota_users where fixture_name = 'backlog'
    )
  ),
  20::bigint,
  'release preserves exactly twenty distinct ambiguous permanent reservations'
);

select is(
  api_private.begin_personal_card_promotion(
    'a1100000-0000-4000-8000-000000000005',
    true,
    'd1130000-0000-4000-8000-000000000001',
    (select result ->> 'temp_path' from upload_quota_backlog_issue),
    'idempotent same path',
    'f1130000-0000-4000-8000-000000000020'
  ) ->> 'status',
  'ready',
  'retrying the same permanent path at the cap does not consume another slot'
);

select is(
  api_private.release_personal_card_promotion(
    (select (result ->> 'upload_id')::uuid from upload_quota_backlog_issue),
    'f1130000-0000-4000-8000-000000000020'
  ) ->> 'status',
  'updated',
  'the idempotent at-cap retry can release without dropping its reservation'
);

select is(
  api_private.begin_personal_card_promotion(
    'a1100000-0000-4000-8000-000000000005',
    true,
    'd1130000-0000-4000-8000-000000000001',
    (select result ->> 'temp_path' from upload_quota_backlog_issue),
    'twenty first distinct path',
    'f1130000-0000-4000-8000-000000000021'
  ),
  '{"status":"quota_exceeded","reason":"permanent_object_backlog"}'::jsonb,
  'a twenty-first distinct begin is rejected under the owner lock'
);

select is(
  (
    select count(*)::bigint
    from private.personal_card_permanent_object_ledger as ledger_row
    where ledger_row.user_id = (
      select user_id from upload_quota_users where fixture_name = 'backlog'
    )
  ),
  20::bigint,
  'the rejected begin leaves no additional permanent reservation'
);

-- Direct privileged writes remain fail closed ---------------------------

do $count_quota$
declare
  v_user_id uuid := (
    select user_id from upload_quota_users where fixture_name = 'count'
  );
  v_index integer;
  v_acquisition_id uuid;
  v_personal_card_id uuid;
begin
  perform set_config('danyeodam.personal_card_photo_size_bytes', '1', true);
  for v_index in 1..200 loop
    v_acquisition_id := (
      'd1110000-0000-4000-8000-' || lpad(to_hex(v_index), 12, '0')
    )::uuid;
    v_personal_card_id := (
      'f1110000-0000-4000-8000-' || lpad(to_hex(v_index), 12, '0')
    )::uuid;
    insert into public.acquisitions (
      id, user_id, spot_id, card_id, acquisition_type, verification_result,
      idempotency_key, field_sequence, acquired_at
    ) values (
      v_acquisition_id,
      v_user_id,
      'b1110000-0000-4000-8000-000000000001',
      'c1100000-0000-4000-8000-000000000001',
      'gift', 'not_applicable',
      (
        'e1110000-0000-4000-8000-' || lpad(to_hex(v_index), 12, '0')
      )::uuid,
      null,
      now()
    );
    insert into public.personal_cards (
      id, user_id, acquisition_id, photo_path, caption
    ) values (
      v_personal_card_id,
      v_user_id,
      v_acquisition_id,
      v_user_id::text || '/' || v_personal_card_id::text || '.webp',
      ''
    );
  end loop;
  perform set_config('danyeodam.personal_card_photo_size_bytes', '', true);
end;
$count_quota$;

select is(
  (
    select count(*)::bigint
    from public.personal_cards as card_row
    where card_row.user_id = (
      select user_id from upload_quota_users where fixture_name = 'count'
    )
      and card_row.photo_size_bytes = 1
  ),
  200::bigint,
  'two hundred small personal cards fit the count quota'
);

insert into public.acquisitions (
  id, user_id, spot_id, card_id, acquisition_type, verification_result,
  idempotency_key, field_sequence, acquired_at
)
values (
  'd1110000-0000-4000-8000-000000000201',
  (select user_id from upload_quota_users where fixture_name = 'count'),
  'b1110000-0000-4000-8000-000000000001',
  'c1100000-0000-4000-8000-000000000001',
  'gift', 'not_applicable',
  'e1110000-0000-4000-8000-000000000201', null, now()
);

select throws_ok(
  format(
    $sql$
      insert into public.personal_cards (
        id, user_id, acquisition_id, photo_path, caption
      ) values (
        'f1110000-0000-4000-8000-000000000201',
        %L,
        'd1110000-0000-4000-8000-000000000201',
        %L,
        ''
      )
    $sql$,
    (select user_id from upload_quota_users where fixture_name = 'count'),
    (select user_id::text from upload_quota_users where fixture_name = 'count') ||
      '/f1110000-0000-4000-8000-000000000201.webp'
  ),
  '23514',
  'personal-card count quota exceeded',
  'the database rejects a 201st personal card'
);

do $byte_quota$
declare
  v_user_id uuid := (
    select user_id from upload_quota_users where fixture_name = 'bytes'
  );
  v_index integer;
  v_acquisition_id uuid;
  v_personal_card_id uuid;
begin
  perform set_config(
    'danyeodam.personal_card_photo_size_bytes',
    '5242880',
    true
  );
  for v_index in 1..100 loop
    v_acquisition_id := (
      'd1120000-0000-4000-8000-' || lpad(to_hex(v_index), 12, '0')
    )::uuid;
    v_personal_card_id := (
      'f1120000-0000-4000-8000-' || lpad(to_hex(v_index), 12, '0')
    )::uuid;
    insert into public.acquisitions (
      id, user_id, spot_id, card_id, acquisition_type, verification_result,
      idempotency_key, field_sequence, acquired_at
    ) values (
      v_acquisition_id,
      v_user_id,
      'b1110000-0000-4000-8000-000000000001',
      'c1100000-0000-4000-8000-000000000001',
      'gift', 'not_applicable',
      (
        'e1120000-0000-4000-8000-' || lpad(to_hex(v_index), 12, '0')
      )::uuid,
      null,
      now()
    );
    insert into public.personal_cards (
      id, user_id, acquisition_id, photo_path, caption
    ) values (
      v_personal_card_id,
      v_user_id,
      v_acquisition_id,
      v_user_id::text || '/' || v_personal_card_id::text || '.webp',
      ''
    );
  end loop;
  perform set_config('danyeodam.personal_card_photo_size_bytes', '', true);
end;
$byte_quota$;

select is(
  (
    select sum(card_row.photo_size_bytes)
    from public.personal_cards as card_row
    where card_row.user_id = (
      select user_id from upload_quota_users where fixture_name = 'bytes'
    )
  ),
  524288000::numeric,
  'one hundred maximum-size images exactly fill the 500 MiB quota'
);

insert into public.acquisitions (
  id, user_id, spot_id, card_id, acquisition_type, verification_result,
  idempotency_key, field_sequence, acquired_at
)
values (
  'd1120000-0000-4000-8000-000000000101',
  (select user_id from upload_quota_users where fixture_name = 'bytes'),
  'b1110000-0000-4000-8000-000000000001',
  'c1100000-0000-4000-8000-000000000001',
  'gift', 'not_applicable',
  'e1120000-0000-4000-8000-000000000101', null, now()
);

select throws_ok(
  format(
    $sql$
      insert into public.personal_cards (
        id, user_id, acquisition_id, photo_path, caption
      ) values (
        'f1120000-0000-4000-8000-000000000101',
        %L,
        'd1120000-0000-4000-8000-000000000101',
        %L,
        ''
      )
    $sql$,
    (select user_id from upload_quota_users where fixture_name = 'bytes'),
    (select user_id::text from upload_quota_users where fixture_name = 'bytes') ||
      '/f1120000-0000-4000-8000-000000000101.webp'
  ),
  '23514',
  'personal-card storage quota exceeded',
  'the database rejects a byte beyond the 500 MiB owner quota'
);

select * from finish();
rollback;
