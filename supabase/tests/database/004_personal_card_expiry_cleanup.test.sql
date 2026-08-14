begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

-- Schema, index, and privileged function boundary -----------------------

select has_column(
  'private',
  'personal_card_temp_uploads',
  'expiry_cleanup_started_at',
  'the ten-minute cleanup phase has an independent retry lease'
);

select ok(
  exists (
    select 1
    from pg_constraint as constraint_row
    where constraint_row.conrelid =
      'private.personal_card_temp_uploads'::regclass
      and constraint_row.conname =
        'personal_card_temp_uploads_expiry_cleanup_claim_state'
  ),
  'the initial cleanup lease is constrained to its valid time window'
);

select ok(
  (
    select
      pg_get_indexdef(index_row.indexrelid)
        like '%(promotion_expires_at, expiry_cleanup_started_at)%'
      and pg_get_expr(index_row.indpred, index_row.indrelid)
        ilike '%promoted_at IS NULL%'
      and pg_get_expr(index_row.indpred, index_row.indrelid)
        ilike '%temp_deleted_at IS NULL%'
    from pg_index as index_row
    join pg_class as index_relation
      on index_relation.oid = index_row.indexrelid
    join pg_namespace as schema_row
      on schema_row.oid = index_relation.relnamespace
    where schema_row.nspname = 'private'
      and index_relation.relname =
        'personal_card_temp_uploads_expiry_cleanup_claim_idx'
  ),
  'the initial cleanup queue has a bounded partial index'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname = 'list_personal_card_expiry_cleanup'
      and function_row.prosecdef
      and coalesce(function_row.proconfig, array[]::text[])
        @> array['search_path=""']::text[]
  ),
  1::bigint,
  'the initial cleanup queue is SECURITY DEFINER with an empty search_path'
);

select ok(
  (
    select upper(pg_get_functiondef(function_row.oid))
      like '%FOR UPDATE SKIP LOCKED%'
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname = 'list_personal_card_expiry_cleanup'
  ),
  'parallel initial-cleanup workers skip already locked rows'
);

select ok(
  (
    select pg_get_functiondef(function_row.oid)
      not ilike '%storage.objects%'
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname = 'list_personal_card_expiry_cleanup'
  ),
  'the database queue never deletes Storage metadata or objects directly'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname = 'list_personal_card_expiry_cleanup'
      and has_function_privilege('service_role', function_row.oid, 'EXECUTE')
  ),
  0::bigint,
  'service_role cannot lease the retired initial cleanup queue after unified cutover'
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
      and function_row.proname = 'list_personal_card_expiry_cleanup'
      and has_function_privilege(
        browser_role.role_name,
        function_row.oid,
        'EXECUTE'
      )
  ),
  0::bigint,
  'browser roles cannot lease initial cleanup candidates'
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
      and function_row.proname = 'list_personal_card_expiry_cleanup'
      and acl_row.grantee = 0
      and acl_row.privilege_type = 'EXECUTE'
  ),
  0::bigint,
  'PUBLIC execute is explicitly absent from the initial cleanup queue'
);

-- Timing and retry-lease behavior ---------------------------------------

insert into auth.users (
  id,
  created_at,
  updated_at,
  is_anonymous,
  raw_user_meta_data
)
values (
  'a2000000-0000-4000-8000-000000000001',
  now(),
  now(),
  true,
  '{}'::jsonb
);

create temp table test_cleanup_user (
  user_id uuid primary key
) on commit drop;

insert into test_cleanup_user (user_id)
select identity_row.user_id
from private.user_identities as identity_row
where identity_row.auth_user_id =
  'a2000000-0000-4000-8000-000000000001'
  and identity_row.revoked_at is null;

create temp table test_cleanup_fixtures (
  fixture_name text primary key,
  upload_id uuid not null unique,
  issued_at timestamptz not null,
  promoted_at timestamptz,
  temp_deleted_at timestamptz,
  expiry_cleanup_started_at timestamptz
) on commit drop;

insert into test_cleanup_fixtures (
  fixture_name,
  upload_id,
  issued_at,
  promoted_at,
  temp_deleted_at,
  expiry_cleanup_started_at
)
values
  (
    'eligible',
    'e2000000-0000-4000-8000-000000000001',
    now() - interval '20 minutes',
    null,
    null,
    null
  ),
  (
    'promotion_open',
    'e2000000-0000-4000-8000-000000000002',
    now(),
    null,
    null,
    null
  ),
  (
    'promoted',
    'e2000000-0000-4000-8000-000000000003',
    now() - interval '20 minutes',
    now() - interval '15 minutes',
    null,
    null
  ),
  (
    'already_deleted',
    'e2000000-0000-4000-8000-000000000004',
    now() - interval '20 minutes',
    null,
    now() - interval '9 minutes',
    null
  ),
  (
    'fresh_lease',
    'e2000000-0000-4000-8000-000000000005',
    now() - interval '40 minutes',
    null,
    null,
    now() - interval '1 minute'
  ),
  (
    'stale_lease',
    'e2000000-0000-4000-8000-000000000006',
    now() - interval '40 minutes',
    null,
    null,
    now() - interval '20 minutes'
  ),
  (
    'final_redelete',
    'e2000000-0000-4000-8000-000000000007',
    now() - interval '3 hours',
    null,
    now() - interval '2 hours 49 minutes',
    null
  ),
  (
    'safety_margin_open',
    'e2000000-0000-4000-8000-000000000008',
    now() - interval '2 hours 5 minutes',
    null,
    null,
    null
  );

insert into private.personal_card_temp_uploads (
  id,
  user_id,
  temp_path,
  declared_content_type,
  declared_size_bytes,
  issued_at,
  promotion_expires_at,
  signed_url_expires_at,
  promoted_at,
  permanent_path,
  temp_deleted_at,
  expiry_cleanup_started_at
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
  fixture.promoted_at,
  case
    when fixture.promoted_at is not null
      then user_row.user_id::text || '/' || fixture.upload_id::text || '.webp'
    else null
  end,
  fixture.temp_deleted_at,
  fixture.expiry_cleanup_started_at
from test_cleanup_fixtures as fixture
cross join test_cleanup_user as user_row;

update private.personal_card_temp_uploads
set cleanup_started_at = now() - interval '1 minute'
where id = 'e2000000-0000-4000-8000-000000000008';

select throws_ok(
  $sql$
    update private.personal_card_temp_uploads
    set expiry_cleanup_started_at = promotion_expires_at - interval '1 second'
    where id = 'e2000000-0000-4000-8000-000000000001'
  $sql$,
  '23514',
  null,
  'an initial-cleanup lease cannot begin before promotion expiry'
);

create temp table test_initial_cleanup_result (
  result jsonb not null
) on commit drop;

insert into test_initial_cleanup_result (result)
values (api_private.list_personal_card_expiry_cleanup(100));

select is(
  (select jsonb_array_length(result) from test_initial_cleanup_result),
  2,
  'initial cleanup claims only eligible unpromoted and undeleted objects'
);

select ok(
  (
    select
      result @> jsonb_build_array(jsonb_build_object(
        'upload_id', 'e2000000-0000-4000-8000-000000000001',
        'temp_path', (
          select temp_path
          from private.personal_card_temp_uploads
          where id = 'e2000000-0000-4000-8000-000000000001'
        )
      ))
      and result @> jsonb_build_array(jsonb_build_object(
        'upload_id', 'e2000000-0000-4000-8000-000000000006',
        'temp_path', (
          select temp_path
          from private.personal_card_temp_uploads
          where id = 'e2000000-0000-4000-8000-000000000006'
        )
      ))
    from test_initial_cleanup_result
  ),
  'initial cleanup returns only database-owned identifiers and paths'
);

select is(
  (
    select count(*)::bigint
    from private.personal_card_temp_uploads
    where id in (
      'e2000000-0000-4000-8000-000000000001',
      'e2000000-0000-4000-8000-000000000006'
    )
      and expiry_cleanup_started_at >= promotion_expires_at
      and expiry_cleanup_started_at > now() - interval '1 minute'
  ),
  2::bigint,
  'claimed rows receive a fresh lease after the promotion deadline'
);

select is(
  (
    select expiry_cleanup_started_at
    from private.personal_card_temp_uploads
    where id = 'e2000000-0000-4000-8000-000000000005'
  ),
  (
    select issued_at + interval '39 minutes'
    from private.personal_card_temp_uploads
    where id = 'e2000000-0000-4000-8000-000000000005'
  ),
  'a fresh initial-cleanup lease is not stolen before its retry interval'
);

select is(
  api_private.mark_personal_card_temp_deleted(
    'e2000000-0000-4000-8000-000000000001'
  ),
  '{"status":"updated"}'::jsonb,
  'Storage deletion success uses the existing temporary-deletion marker'
);

select is(
  api_private.list_personal_card_expiry_cleanup(100),
  '[]'::jsonb,
  'deleted objects and freshly leased failures are not immediately reissued'
);

-- Final re-delete boundary with post-expiry safety margin ----------------

create temp table test_final_cleanup_result (
  result jsonb not null
) on commit drop;

insert into test_final_cleanup_result (result)
values (api_private.list_personal_card_temp_cleanup(100));

select is(
  (select jsonb_array_length(result) from test_final_cleanup_result),
  1,
  'the final queue waits ten minutes beyond signed URL expiry'
);

select ok(
  (
    select result @> jsonb_build_array(jsonb_build_object(
      'upload_id', 'e2000000-0000-4000-8000-000000000007',
      'temp_path', (
        select temp_path
        from private.personal_card_temp_uploads
        where id = 'e2000000-0000-4000-8000-000000000007'
      )
    ))
    from test_final_cleanup_result
  ),
  'final cleanup reissues a path even when initial deletion was recorded'
);

select is(
  api_private.complete_personal_card_temp_cleanup(
    'e2000000-0000-4000-8000-000000000008'
  ),
  '{"status":"stale"}'::jsonb,
  'final completion is rejected while the post-expiry safety margin is open'
);

select is(
  (
    select cleanup_completed_at
    from private.personal_card_temp_uploads
    where id = 'e2000000-0000-4000-8000-000000000008'
  ),
  null::timestamptz,
  'a premature completion cannot mark final cleanup complete'
);

select is(
  api_private.complete_personal_card_temp_cleanup(
    'e2000000-0000-4000-8000-000000000007'
  ),
  '{"status":"updated"}'::jsonb,
  'Storage re-delete success completes the two-hour final cleanup'
);

select ok(
  (
    select
      cleanup_completed_at is not null
      and cleanup_completed_at >= signed_url_expires_at + interval '10 minutes'
      and temp_deleted_at = cleanup_completed_at
    from private.personal_card_temp_uploads
    where id = 'e2000000-0000-4000-8000-000000000007'
  ),
  'final cleanup replaces the first marker after the safety margin closes'
);

select * from finish();
rollback;
