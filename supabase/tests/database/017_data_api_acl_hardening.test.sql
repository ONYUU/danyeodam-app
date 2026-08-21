begin;

create extension if not exists pgtap with schema extensions;

select plan(13);

select is(
  (
    select count(*)::bigint
    from information_schema.table_privileges as privilege_row
    where privilege_row.table_schema = 'public'
      and privilege_row.grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')
  ),
  0::bigint,
  'Data API roles have no direct privilege on existing public application tables'
);

select ok(
  not exists (
    select 1
    from pg_class as table_row
    join pg_namespace as schema_row
      on schema_row.oid = table_row.relnamespace
    where schema_row.nspname = 'public'
      and table_row.relkind in ('r', 'p')
      and (not table_row.relrowsecurity or not table_row.relforcerowsecurity)
  ),
  'every existing public application table enables and forces RLS'
);

select ok(
  not exists (
    select 1
    from pg_class as sequence_row
    join pg_namespace as schema_row
      on schema_row.oid = sequence_row.relnamespace
    cross join unnest(array['anon', 'authenticated', 'service_role']) as role_name
    where schema_row.nspname = 'public'
      and sequence_row.relkind = 'S'
      and has_sequence_privilege(
        role_name,
        sequence_row.oid,
        'USAGE, SELECT, UPDATE'
      )
  ),
  'Data API roles have no direct privilege on existing public sequences'
);

select ok(
  not has_schema_privilege('anon', 'api_private', 'USAGE'),
  'anon cannot use the server-only RPC schema'
);

select ok(
  not has_schema_privilege('authenticated', 'api_private', 'USAGE'),
  'authenticated cannot use the server-only RPC schema'
);

select ok(
  has_schema_privilege('service_role', 'api_private', 'USAGE'),
  'service_role retains server-only RPC schema usage'
);

select ok(
  has_function_privilege(
    'service_role',
    'api_private.list_public_spots()',
    'EXECUTE'
  ),
  'service_role retains an explicitly granted live RPC'
);

select ok(
  not has_function_privilege(
    'anon',
    'api_private.list_public_spots()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'api_private.list_public_spots()',
    'EXECUTE'
  ),
  'browser roles cannot execute the live server-only RPC'
);

create table public.data_api_acl_default_probe (
  id bigint generated always as identity primary key
);

create function public.data_api_acl_public_function_probe()
returns integer
language sql
security definer
set search_path = ''
as $$
  select 1
$$;

create function private.data_api_acl_private_function_probe()
returns integer
language sql
security definer
set search_path = ''
as $$
  select 1
$$;

create function api_private.data_api_acl_rpc_probe()
returns integer
language sql
security definer
set search_path = ''
as $$
  select 1
$$;

select ok(
  not exists (
    select 1
    from unnest(array['anon', 'authenticated', 'service_role']) as role_name
    where has_table_privilege(
      role_name,
      'public.data_api_acl_default_probe',
      'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN'
    )
  ),
  'a future public table receives no implicit Data API or maintenance privilege'
);

select ok(
  not exists (
    select 1
    from unnest(array['anon', 'authenticated', 'service_role']) as role_name
    where has_sequence_privilege(
      role_name,
      'public.data_api_acl_default_probe_id_seq',
      'USAGE, SELECT, UPDATE'
    )
  ),
  'a future public sequence receives no implicit Data API privilege'
);

select ok(
  not exists (
    select 1
    from unnest(array['anon', 'authenticated', 'service_role']) as role_name
    where has_function_privilege(
      role_name,
      'public.data_api_acl_public_function_probe()',
      'EXECUTE'
    )
  )
  and not exists (
    select 1
    from unnest(array['anon', 'authenticated', 'service_role']) as role_name
    where has_function_privilege(
      role_name,
      'private.data_api_acl_private_function_probe()',
      'EXECUTE'
    )
  ),
  'future public and private functions receive no implicit EXECUTE privilege'
);

select ok(
  not exists (
    select 1
    from unnest(array['anon', 'authenticated', 'service_role']) as role_name
    where has_function_privilege(
      role_name,
      'api_private.data_api_acl_rpc_probe()',
      'EXECUTE'
    )
  ),
  'a future server RPC is unreachable until its grant is explicit'
);

grant execute on function api_private.data_api_acl_rpc_probe()
  to service_role;

select ok(
  has_function_privilege(
    'service_role',
    'api_private.data_api_acl_rpc_probe()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'api_private.data_api_acl_rpc_probe()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'api_private.data_api_acl_rpc_probe()',
    'EXECUTE'
  ),
  'an explicit service_role RPC grant remains possible without browser access'
);

select * from finish();

rollback;
