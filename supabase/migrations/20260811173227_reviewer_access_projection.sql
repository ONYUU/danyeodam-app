-- DANYEODAM API-CONTRACT v0.3.1 reviewer-access projection.
--
-- Reviewer authorization is deliberately stored in private database tables.
-- User-editable JWT metadata is never consulted. The only Data API surface is
-- a service-role-only SECURITY DEFINER function that rechecks the active
-- auth-user to logical-user binding on every request.

alter table private.participant_access
  drop constraint participant_access_access_kind_check;

alter table private.participant_access
  add constraint participant_access_access_kind_check
  check (access_kind in ('internal_tester', 'public_beta', 'store_reviewer'));

create table private.reviewer_accounts (
  user_id uuid primary key references public.app_users(id) on delete cascade,
  store_platform text not null
    check (store_platform in ('app_store', 'play_store')),
  fixture_version text not null
    check (
      char_length(fixture_version) between 1 and 64
      and fixture_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    ),
  granted_at timestamptz not null default now(),
  granted_by_auth_user_id uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint reviewer_accounts_revoked_after_granted
    check (revoked_at is null or revoked_at >= granted_at)
);

create index reviewer_accounts_granted_by_idx
  on private.reviewer_accounts(granted_by_auth_user_id)
  where granted_by_auth_user_id is not null;

create index reviewer_accounts_active_store_idx
  on private.reviewer_accounts(store_platform, user_id)
  where revoked_at is null;

create trigger reviewer_accounts_set_updated_at
before update on private.reviewer_accounts
for each row execute function private.set_updated_at();

alter table private.reviewer_accounts enable row level security;
alter table private.reviewer_accounts force row level security;

revoke all on table private.reviewer_accounts
  from public, anon, authenticated, service_role;

create or replace function api_private.get_access_projection(
  p_auth_user_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with active_identity as (
    select identity_row.user_id
    from private.user_identities as identity_row
    join auth.users as auth_user
      on auth_user.id = identity_row.auth_user_id
    where identity_row.auth_user_id = p_auth_user_id
      and identity_row.revoked_at is null
      and auth_user.deleted_at is null
  ),
  active_access as (
    select access_row.user_id, access_row.access_kind
    from private.participant_access as access_row
    join active_identity as identity_row
      on identity_row.user_id = access_row.user_id
    where access_row.revoked_at is null
      and (
        access_row.expires_at is null
        or access_row.expires_at > statement_timestamp()
      )
  ),
  active_reviewer as (
    select reviewer_row.user_id, reviewer_row.fixture_version
    from private.reviewer_accounts as reviewer_row
    join active_identity as identity_row
      on identity_row.user_id = reviewer_row.user_id
    where reviewer_row.revoked_at is null
  )
  select coalesce(
    (
      select jsonb_build_object(
        'status', 'ready',
        'participant', access_row.user_id is not null,
        'access_type', case
          when access_row.access_kind = 'store_reviewer'
            and reviewer_row.user_id is not null
            then 'store_reviewer'
          else 'standard'
        end,
        'field_acquisition_requires_location', true,
        'fixture_version', case
          when access_row.access_kind = 'store_reviewer'
            and reviewer_row.user_id is not null
            then reviewer_row.fixture_version
          else null
        end
      )
      from active_identity as identity_row
      left join active_access as access_row
        on access_row.user_id = identity_row.user_id
      left join active_reviewer as reviewer_row
        on reviewer_row.user_id = identity_row.user_id
    ),
    jsonb_build_object('status', 'unauthorized')
  )
$$;

revoke all on function api_private.get_access_projection(uuid)
  from public, anon, authenticated, service_role;

grant execute on function api_private.get_access_projection(uuid)
  to service_role;
