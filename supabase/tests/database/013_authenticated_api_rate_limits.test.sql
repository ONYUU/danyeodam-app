begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

-- Schema and least-privilege boundary ------------------------------------

select set_eq(
  $$
    select column_name::text
    from information_schema.columns
    where table_schema = 'private'
      and table_name = 'rate_limit_windows'
  $$,
  $$
    values
      ('user_id'::text),
      ('purpose'::text),
      ('attempted_at'::text),
      ('updated_at'::text)
  $$,
  'authenticated rate state stores only logical owner, fixed purpose, and timestamps'
);

select ok(
  (
    select relation_row.relrowsecurity and relation_row.relforcerowsecurity
    from pg_class as relation_row
    join pg_namespace as schema_row
      on schema_row.oid = relation_row.relnamespace
    where schema_row.nspname = 'private'
      and relation_row.relname = 'rate_limit_windows'
  ),
  'authenticated rate state enables and forces RLS'
);

select is(
  (
    select count(*)::bigint
    from pg_class as relation_row
    join pg_namespace as schema_row
      on schema_row.oid = relation_row.relnamespace
    cross join lateral aclexplode(
      coalesce(
        relation_row.relacl,
        acldefault('r', relation_row.relowner)
      )
    ) as acl_row
    where schema_row.nspname = 'private'
      and relation_row.relname = 'rate_limit_windows'
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
  'PUBLIC and Data API roles have no direct rate-state privileges'
);

select ok(
  to_regprocedure(
    'api_private.consume_authenticated_api_rate_limit(uuid,text)'
  ) is null,
  'no standalone service-role rate-consumption RPC exists'
);

select ok(
  not has_function_privilege(
    'service_role',
    'private.consume_authenticated_api_rate_limit(uuid,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'private.consume_authenticated_api_rate_limit(uuid,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'private.consume_authenticated_api_rate_limit(uuid,text)',
    'EXECUTE'
  )
  and not exists (
    select 1
    from pg_proc as function_row
    cross join lateral aclexplode(
      coalesce(
        function_row.proacl,
        acldefault('f', function_row.proowner)
      )
    ) as acl_row
    where function_row.oid =
      'private.consume_authenticated_api_rate_limit(uuid,text)'::regprocedure
      and acl_row.grantee = 0
      and acl_row.privilege_type = 'EXECUTE'
  ),
  'the limiter helper has no PUBLIC or Data API execution grant'
);

select ok(
  (
    select procedure_row.prosecdef
      and coalesce(procedure_row.proconfig, array[]::text[])
        @> array['search_path=""']::text[]
    from pg_proc as procedure_row
    where procedure_row.oid =
      'private.consume_authenticated_api_rate_limit(uuid,text)'::regprocedure
  ),
  'private rate consumption is SECURITY DEFINER with an empty search path'
);

select ok(
  exists (
    select 1
    from pg_constraint as constraint_row
    where constraint_row.conrelid = 'private.rate_limit_windows'::regclass
      and constraint_row.conname = 'rate_limit_windows_attempts_bounded'
      and pg_get_constraintdef(constraint_row.oid)
        like '%cardinality(attempted_at) <= 60%'
  ),
  'rate state is physically bounded to sixty timestamps'
);

select ok(
  lower(pg_get_functiondef(
    'private.consume_authenticated_api_rate_limit(uuid,text)'::regprocedure
  )) like '%private.lock_active_user_id_for_auth(p_auth_user_id)%'
  and lower(pg_get_functiondef(
    'private.consume_authenticated_api_rate_limit(uuid,text)'::regprocedure
  )) like '%danyeodam:authenticated-api-rate:%'
  and lower(pg_get_functiondef(
    'private.consume_authenticated_api_rate_limit(uuid,text)'::regprocedure
  )) like '%for update%'
  and lower(pg_get_functiondef(
    'private.consume_authenticated_api_rate_limit(uuid,text)'::regprocedure
  )) like '%attempted_at > v_now - interval ''60 seconds''%'
  and lower(pg_get_functiondef(
    'private.consume_authenticated_api_rate_limit(uuid,text)'::regprocedure
  )) like '%when ''collection_read'' then v_limit := 60%'
  and lower(pg_get_functiondef(
    'private.consume_authenticated_api_rate_limit(uuid,text)'::regprocedure
  )) like '%when ''acquire'' then v_limit := 10%'
  and lower(pg_get_functiondef(
    'private.consume_authenticated_api_rate_limit(uuid,text)'::regprocedure
  )) like '%when ''event_batch'' then v_limit := 12%'
  and lower(pg_get_functiondef(
    'private.consume_authenticated_api_rate_limit(uuid,text)'::regprocedure
  )) like '%when ''participant_write'' then v_limit := 30%'
  and lower(pg_get_functiondef(
    'private.consume_authenticated_api_rate_limit(uuid,text)'::regprocedure
  )) like '%when ''admin_mutation'' then%v_limit := 30%',
  'fixed limits recheck identity and serialize one owner before rolling-state update'
);

-- Exact public wrappers, private inners, and continuations ----------------

select set_eq(
  $$
    select function_row.oid::regprocedure::text
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.oid in (
        'api_private.get_user_collection(uuid,integer,timestamptz,uuid)'::regprocedure,
        'api_private.acquire_context(uuid,uuid,uuid,boolean)'::regprocedure,
        'api_private.acquire_context_continuation(uuid,uuid,uuid,boolean,uuid)'::regprocedure,
        'api_private.acquire_commit(uuid,uuid,uuid,boolean,timestamptz,uuid)'::regprocedure,
        'api_private.record_acquire_failure(uuid,uuid,uuid,text,jsonb,uuid)'::regprocedure,
        'api_private.ingest_client_events(uuid,boolean,jsonb)'::regprocedure,
        'api_private.begin_personal_card_promotion(uuid,boolean,uuid,text,text,uuid)'::regprocedure,
        'api_private.complete_personal_card_promotion_with_size(uuid,uuid,uuid,uuid,text,text,bigint,uuid)'::regprocedure,
        'api_private.create_personal_card_share(uuid,boolean,boolean,uuid,text)'::regprocedure,
        'api_private.create_personal_card_share_continuation(uuid,boolean,boolean,uuid,text,uuid)'::regprocedure,
        'api_private.create_physical_request(uuid,boolean,text)'::regprocedure,
        'api_private.issue_participant_invites(uuid,text[],text)'::regprocedure,
        'api_private.grant_retro_acquisition(uuid,uuid,uuid,text)'::regprocedure,
        'api_private.moderate_content_report(uuid,uuid,uuid,text,text,text)'::regprocedure,
        'api_private.moderate_personal_card_share(uuid,uuid,uuid,text,text,text,boolean)'::regprocedure,
        'api_private.moderate_share_owner_suspension(uuid,uuid,uuid,text,text,text)'::regprocedure,
        'api_private.resolve_location_correction_admin(uuid,uuid,text)'::regprocedure
      )
      and function_row.prosecdef
      and coalesce(function_row.proconfig, array[]::text[])
        @> array['search_path=""']::text[]
      and has_function_privilege('service_role', function_row.oid, 'EXECUTE')
  $$,
  $$
    values
      ('api_private.get_user_collection(uuid,integer,timestamp with time zone,uuid)'::text),
      ('api_private.acquire_context(uuid,uuid,uuid,boolean)'::text),
      ('api_private.acquire_context_continuation(uuid,uuid,uuid,boolean,uuid)'::text),
      ('api_private.acquire_commit(uuid,uuid,uuid,boolean,timestamp with time zone,uuid)'::text),
      ('api_private.record_acquire_failure(uuid,uuid,uuid,text,jsonb,uuid)'::text),
      ('api_private.ingest_client_events(uuid,boolean,jsonb)'::text),
      ('api_private.begin_personal_card_promotion(uuid,boolean,uuid,text,text,uuid)'::text),
      ('api_private.complete_personal_card_promotion_with_size(uuid,uuid,uuid,uuid,text,text,bigint,uuid)'::text),
      ('api_private.create_personal_card_share(uuid,boolean,boolean,uuid,text)'::text),
      ('api_private.create_personal_card_share_continuation(uuid,boolean,boolean,uuid,text,uuid)'::text),
      ('api_private.create_physical_request(uuid,boolean,text)'::text),
      ('api_private.issue_participant_invites(uuid,text[],text)'::text),
      ('api_private.grant_retro_acquisition(uuid,uuid,uuid,text)'::text),
      ('api_private.moderate_content_report(uuid,uuid,uuid,text,text,text)'::text),
      ('api_private.moderate_personal_card_share(uuid,uuid,uuid,text,text,text,boolean)'::text),
      ('api_private.moderate_share_owner_suspension(uuid,uuid,uuid,text,text,text)'::text),
      ('api_private.resolve_location_correction_admin(uuid,uuid,text)'::text)
  $$,
  'only the exact hardened public wrappers and continuations are service callable'
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
      and (
        function_row.proname in (
          'get_user_collection',
          'acquire_context',
          'acquire_context_continuation',
          'acquire_commit',
          'record_acquire_failure',
          'ingest_client_events',
          'begin_personal_card_promotion',
          'complete_personal_card_promotion_with_size',
          'create_personal_card_share',
          'create_personal_card_share_continuation',
          'create_physical_request',
          'issue_participant_invites',
          'grant_retro_acquisition',
          'moderate_content_report',
          'moderate_personal_card_share',
          'moderate_share_owner_suspension',
          'resolve_location_correction_admin'
        )
      )
      and has_function_privilege(
        browser_role.role_name,
        function_row.oid,
        'EXECUTE'
      )
  ),
  0::bigint,
  'browser roles cannot execute any authenticated wrapper'
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
        'get_user_collection',
        'acquire_context',
        'acquire_context_continuation',
        'acquire_commit',
        'record_acquire_failure',
        'ingest_client_events',
        'begin_personal_card_promotion',
        'complete_personal_card_promotion_with_size',
        'create_personal_card_share',
        'create_personal_card_share_continuation',
        'create_physical_request',
        'issue_participant_invites',
        'grant_retro_acquisition',
        'moderate_content_report',
        'moderate_personal_card_share',
        'moderate_share_owner_suspension',
        'resolve_location_correction_admin'
      )
      and acl_row.grantee = 0
      and acl_row.privilege_type = 'EXECUTE'
  ),
  0::bigint,
  'PUBLIC cannot execute any authenticated wrapper'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and (
        function_row.proname like '%\_unrated' escape '\'
        or function_row.proname =
          'complete_personal_card_promotion_with_size_unbound'
      )
      and (
        has_function_privilege('service_role', function_row.oid, 'EXECUTE')
        or has_function_privilege('anon', function_row.oid, 'EXECUTE')
        or has_function_privilege('authenticated', function_row.oid, 'EXECUTE')
        or exists (
          select 1
          from aclexplode(
            coalesce(
              function_row.proacl,
              acldefault('f', function_row.proowner)
            )
          ) as acl_row
          where acl_row.grantee = 0
            and acl_row.privilege_type = 'EXECUTE'
        )
      )
  ),
  0::bigint,
  'PUBLIC and Data API roles cannot bypass renamed inner functions'
);

select is(
  (
    select count(*)::bigint
    from unnest(array[
      'api_private.get_user_collection(uuid,integer,timestamptz,uuid)'::regprocedure,
      'api_private.acquire_context(uuid,uuid,uuid,boolean)'::regprocedure,
      'api_private.ingest_client_events(uuid,boolean,jsonb)'::regprocedure,
      'api_private.begin_personal_card_promotion(uuid,boolean,uuid,text,text,uuid)'::regprocedure,
      'api_private.create_personal_card_share(uuid,boolean,boolean,uuid,text)'::regprocedure,
      'api_private.create_physical_request(uuid,boolean,text)'::regprocedure,
      'api_private.issue_participant_invites(uuid,text[],text)'::regprocedure,
      'api_private.grant_retro_acquisition(uuid,uuid,uuid,text)'::regprocedure,
      'api_private.moderate_content_report(uuid,uuid,uuid,text,text,text)'::regprocedure,
      'api_private.moderate_personal_card_share(uuid,uuid,uuid,text,text,text,boolean)'::regprocedure,
      'api_private.moderate_share_owner_suspension(uuid,uuid,uuid,text,text,text)'::regprocedure,
      'api_private.resolve_location_correction_admin(uuid,uuid,text)'::regprocedure
    ]) as wrapper(function_oid)
    where pg_get_functiondef(wrapper.function_oid)
      like '%private.consume_authenticated_api_rate_limit(%'
  ),
  12::bigint,
  'all twelve first-call domain wrappers consume inside their transaction'
);

-- Fixtures ---------------------------------------------------------------

insert into auth.users (id, created_at, updated_at, is_anonymous, raw_user_meta_data)
values
  ('a1200000-0000-4000-8000-000000000001', now(), now(), true, '{}'),
  ('a1200000-0000-4000-8000-000000000002', now(), now(), true, '{}'),
  ('a1200000-0000-4000-8000-000000000003', now(), now(), true, '{}');

create temp table authenticated_rate_users (
  fixture_name text primary key,
  auth_user_id uuid not null,
  user_id uuid not null
) on commit drop;

insert into authenticated_rate_users (fixture_name, auth_user_id, user_id)
select fixture.fixture_name, fixture.auth_user_id, identity_row.user_id
from (
  values
    ('limits', 'a1200000-0000-4000-8000-000000000001'::uuid),
    ('regular', 'a1200000-0000-4000-8000-000000000002'::uuid),
    ('revoked', 'a1200000-0000-4000-8000-000000000003'::uuid)
) as fixture(fixture_name, auth_user_id)
join private.user_identities as identity_row
  on identity_row.auth_user_id = fixture.auth_user_id
 and identity_row.revoked_at is null;

insert into private.admin_members (auth_user_id)
values ('a1200000-0000-4000-8000-000000000001');

select is(
  private.consume_authenticated_api_rate_limit(null, 'acquire'),
  '{"status":"unauthorized"}'::jsonb,
  'a missing Auth UID is rejected without state'
);

select is(
  private.consume_authenticated_api_rate_limit(
    'a1200000-0000-4000-8000-000000000001',
    'caller_defined_limit'
  ),
  '{"status":"invalid"}'::jsonb,
  'callers cannot introduce a purpose or caller-selected limit'
);

select is(
  private.consume_authenticated_api_rate_limit(
    'a1200000-0000-4000-8000-000000000002',
    'admin_mutation'
  ),
  '{"status":"forbidden"}'::jsonb,
  'the admin purpose rechecks current administrator membership'
);

update private.user_identities
set revoked_at = clock_timestamp()
where auth_user_id = 'a1200000-0000-4000-8000-000000000003'
  and revoked_at is null;

select is(
  private.consume_authenticated_api_rate_limit(
    'a1200000-0000-4000-8000-000000000003',
    'collection_read'
  ),
  '{"status":"unauthorized"}'::jsonb,
  'a revoked binding is rejected by the database recheck'
);

select is(
  (
    select count(*)::bigint
    from private.rate_limit_windows as window_row
    where window_row.user_id in (
      select user_id
      from authenticated_rate_users
      where fixture_name in ('regular', 'revoked')
    )
  ),
  0::bigint,
  'forbidden and unauthorized attempts do not create rate state'
);

-- Exact rolling limits ---------------------------------------------------

create temp table authenticated_rate_results (
  purpose text not null,
  sequence_number integer not null,
  result jsonb not null
) on commit drop;

do $rate_limits$
declare
  v_purpose record;
  v_sequence integer;
begin
  for v_purpose in
    select *
    from (
      values
        ('collection_read'::text, 60),
        ('acquire'::text, 10),
        ('event_batch'::text, 12),
        ('participant_write'::text, 30),
        ('admin_mutation'::text, 30)
    ) as purpose_row(purpose, request_limit)
  loop
    for v_sequence in 1..v_purpose.request_limit loop
      insert into authenticated_rate_results (purpose, sequence_number, result)
      values (
        v_purpose.purpose,
        v_sequence,
        private.consume_authenticated_api_rate_limit(
          'a1200000-0000-4000-8000-000000000001',
          v_purpose.purpose
        )
      );
    end loop;

    insert into authenticated_rate_results (purpose, sequence_number, result)
    values (
      v_purpose.purpose,
      v_purpose.request_limit + 1,
      private.consume_authenticated_api_rate_limit(
        'a1200000-0000-4000-8000-000000000001',
        v_purpose.purpose
      )
    );
  end loop;
end;
$rate_limits$;

select is(
  (
    select count(*)::bigint
    from authenticated_rate_results as result_row
    where result_row.result ->> 'status' = 'allowed'
      and result_row.result ->> 'user_id' = (
        select user_id::text
        from authenticated_rate_users
        where fixture_name = 'limits'
      )
  ),
  142::bigint,
  'all five purpose domains allow exactly their fixed rolling capacity'
);

select is(
  (
    select count(*)::bigint
    from authenticated_rate_results as result_row
    where result_row.result ->> 'status' = 'rate_limited'
      and (result_row.result ->> 'retry_after_seconds')::integer between 1 and 60
  ),
  5::bigint,
  'the next request in every domain is denied with a bounded retry interval'
);

select set_eq(
  $$
    select window_row.purpose, cardinality(window_row.attempted_at)::integer
    from private.rate_limit_windows as window_row
    where window_row.user_id = (
      select user_id from authenticated_rate_users where fixture_name = 'limits'
    )
  $$,
  $$
    values
      ('collection_read'::text, 60),
      ('acquire'::text, 10),
      ('event_batch'::text, 12),
      ('participant_write'::text, 30),
      ('admin_mutation'::text, 30)
  $$,
  'denied attempts cannot expand any purpose beyond its fixed capacity'
);

update private.rate_limit_windows
set attempted_at = array(
      select clock_timestamp() - interval '2 minutes'
      from generate_series(1, 10)
    ),
    updated_at = clock_timestamp()
where user_id = (
    select user_id from authenticated_rate_users where fixture_name = 'limits'
  )
  and purpose = 'acquire';

select is(
  private.consume_authenticated_api_rate_limit(
    'a1200000-0000-4000-8000-000000000001',
    'acquire'
  ) ->> 'status',
  'allowed',
  'expired attempts leave the exact rolling sixty-second window'
);

select is(
  (
    select cardinality(window_row.attempted_at)::integer
    from private.rate_limit_windows as window_row
    where window_row.user_id = (
      select user_id from authenticated_rate_users where fixture_name = 'limits'
    )
      and window_row.purpose = 'acquire'
  ),
  1,
  'rolling-window pruning persists only the new in-window attempt'
);

select throws_ok(
  format(
    $sql$
      update private.rate_limit_windows
      set attempted_at = array(
        select clock_timestamp() from generate_series(1, 61)
      )
      where user_id = %L and purpose = 'collection_read'
    $sql$,
    (select user_id from authenticated_rate_users where fixture_name = 'limits')
  ),
  '23514',
  null,
  'the table rejects an oversized timestamp history even for a privileged writer'
);

-- Expected-owner continuations fail closed before any domain mutation.
select is(
  api_private.acquire_context_continuation(
    'a1200000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    true,
    '00000000-0000-4000-8000-000000000003'
  ),
  '{"status":"error","code":"UNAUTHORIZED"}'::jsonb,
  'acquire continuation rejects a mismatched logical owner'
);

select is(
  api_private.create_personal_card_share_continuation(
    'a1200000-0000-4000-8000-000000000002',
    true,
    true,
    '00000000-0000-4000-8000-000000000001',
    repeat('A', 22),
    '00000000-0000-4000-8000-000000000003'
  ),
  '{"status":"unauthorized"}'::jsonb,
  'share continuation rejects a mismatched logical owner'
);

select * from finish();
rollback;
