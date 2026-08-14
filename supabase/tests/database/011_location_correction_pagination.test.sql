begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

select ok(
  to_regprocedure(
    'api_private.list_own_location_corrections(uuid,integer,timestamptz,uuid)'
  ) is not null
  and to_regprocedure(
    'api_private.list_own_location_corrections(uuid,integer)'
  ) is null,
  'correction history exposes only the keyset RPC signature'
);

select ok(
  has_function_privilege(
    'service_role',
    'api_private.list_own_location_corrections(uuid,integer,timestamptz,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'api_private.list_own_location_corrections(uuid,integer,timestamptz,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'api_private.list_own_location_corrections(uuid,integer,timestamptz,uuid)',
    'EXECUTE'
  ),
  'correction-history keyset RPC remains service-role-only'
);

insert into auth.users (
  id, created_at, updated_at, is_anonymous, raw_user_meta_data
) values (
  'c9000000-0000-4000-8000-000000000001',
  now(), now(), true, '{}'
);

create temp table correction_page_user as
select identity_row.user_id
from private.user_identities as identity_row
where identity_row.auth_user_id = 'c9000000-0000-4000-8000-000000000001'
  and identity_row.revoked_at is null;

select is(
  (
    select count(*)::bigint
    from private.participant_access as access_row
    where access_row.user_id = (select user_id from correction_page_user)
  ) + (
    select count(*)::bigint
    from private.minimum_age_attestations as attestation_row
    where attestation_row.user_id = (select user_id from correction_page_user)
  ),
  0::bigint,
  'pagination fixture has neither participant access nor a minimum-age attestation'
);

insert into private.location_correction_requests (
  id,
  user_id,
  client_request_id,
  request_fingerprint,
  reason,
  status,
  requested_at,
  resolved_at,
  resolved_by_auth_user_id
)
select
  (
    'c9100000-0000-4000-8000-' || lpad(to_hex(series_row.value), 12, '0')
  )::uuid,
  (select user_id from correction_page_user),
  (
    'c9200000-0000-4000-8000-' || lpad(to_hex(series_row.value), 12, '0')
  )::uuid,
  extensions.digest('correction-page:' || series_row.value::text, 'sha256'),
  'other',
  'rejected',
  '2026-08-12 00:00:00+00'::timestamptz
    + (((series_row.value - 1) / 2) * interval '1 second'),
  '2026-08-12 00:01:00+00'::timestamptz
    + (((series_row.value - 1) / 2) * interval '1 second'),
  'c9000000-0000-4000-8000-000000000001'
from generate_series(1, 102) as series_row(value);

create temp table correction_page_one as
select api_private.list_own_location_corrections(
  'c9000000-0000-4000-8000-000000000001',
  100,
  null,
  null
) as result;

select is(
  (select result ->> 'status' from correction_page_one),
  'ready',
  'active identity reads correction history without an age or participant gate'
);

select is(
  (select jsonb_array_length(result -> 'items') from correction_page_one),
  100,
  'first correction-history page is bounded at the requested maximum'
);

select is(
  (select result #>> '{items,0,id}' from correction_page_one),
  'c9100000-0000-4000-8000-000000000066',
  'first page starts at the newest UUID within the newest requested-at tie'
);

select is(
  (select result #>> '{items,99,id}' from correction_page_one),
  'c9100000-0000-4000-8000-000000000003',
  'first page keeps deterministic requested-at and UUID descending order'
);

create temp table correction_page_two as
select api_private.list_own_location_corrections(
  'c9000000-0000-4000-8000-000000000001',
  100,
  (select (result #>> '{items,99,requested_at}')::timestamptz
   from correction_page_one),
  (select (result #>> '{items,99,id}')::uuid from correction_page_one)
) as result;

select is(
  (select jsonb_array_length(result -> 'items') from correction_page_two),
  2,
  'second keyset page exposes rows beyond the former 100-row truncation'
);

select is(
  (
    select count(distinct (item_row.item ->> 'id'))::bigint
    from (
      select jsonb_array_elements(result -> 'items') as item
      from correction_page_one
      union all
      select jsonb_array_elements(result -> 'items') as item
      from correction_page_two
    ) as item_row
  ),
  102::bigint,
  'two pages cover all correction requests exactly once'
);

create temp table correction_tie_page_one as
select api_private.list_own_location_corrections(
  'c9000000-0000-4000-8000-000000000001',
  99,
  null,
  null
) as result;

create temp table correction_tie_page_two as
select api_private.list_own_location_corrections(
  'c9000000-0000-4000-8000-000000000001',
  10,
  (select (result #>> '{items,98,requested_at}')::timestamptz
   from correction_tie_page_one),
  (select (result #>> '{items,98,id}')::uuid from correction_tie_page_one)
) as result;

select ok(
  (
    select result #>> '{items,98,requested_at}'
    from correction_tie_page_one
  ) = (
    select result #>> '{items,0,requested_at}'
    from correction_tie_page_two
  )
  and (
    select result #>> '{items,98,id}'
    from correction_tie_page_one
  ) = 'c9100000-0000-4000-8000-000000000004'
  and (
    select result #>> '{items,0,id}'
    from correction_tie_page_two
  ) = 'c9100000-0000-4000-8000-000000000003',
  'UUID tiebreaker continues a page split inside one requested-at timestamp'
);

select is(
  api_private.list_own_location_corrections(
    'c9000000-0000-4000-8000-000000000001',
    50,
    '2026-08-12 00:00:00+00'::timestamptz,
    null
  ),
  '{"status":"invalid"}'::jsonb,
  'partial keyset anchors are rejected at the database boundary'
);

select is(
  api_private.list_own_location_corrections(
    'c9000000-0000-4000-8000-000000000099',
    50,
    null,
    null
  ),
  '{"status":"unauthorized"}'::jsonb,
  'missing active identity cannot read correction history'
);

select * from finish();
rollback;
