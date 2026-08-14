-- Reviewer credentials are reusable store-review resources, not recovery
-- identities. Once a logical user has appeared in reviewer_accounts, generic
-- recovery and email-linking flows must never transfer or mutate that user.

-- Keep the security marker even if a reviewer membership row is later removed
-- by an operator. The marker follows the logical user's account-deletion
-- lifecycle: deleting app_users also removes its now-unreachable history.
create table private.reviewer_user_history (
  user_id uuid primary key
    references public.app_users(id) on delete cascade,
  first_marked_at timestamptz not null default now()
);

alter table private.reviewer_user_history enable row level security;
alter table private.reviewer_user_history force row level security;

revoke all on table private.reviewer_user_history
  from public, anon, authenticated, service_role;

insert into private.reviewer_user_history (user_id, first_marked_at)
select reviewer_row.user_id, min(reviewer_row.granted_at)
from private.reviewer_accounts as reviewer_row
group by reviewer_row.user_id
on conflict (user_id) do nothing;

create or replace function private.user_has_reviewer_history(
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.reviewer_user_history as history_row
    where history_row.user_id = p_user_id
  )
$$;

revoke all on function private.user_has_reviewer_history(uuid)
  from public, anon, authenticated, service_role;

create or replace function private.lock_down_reviewer_recovery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended(
      'danyeodam:recovery:target:' || new.user_id::text,
      0
    )
  );

  -- A logical user transferred through generic recovery is never eligible to
  -- become a reusable store credential. If claim wins this same advisory lock
  -- first, reviewer designation fails and operations must provision a fresh
  -- logical user instead.
  if tg_op = 'INSERT' and exists (
    select 1
    from private.recovery_codes as code_row
    where code_row.user_id = new.user_id
      and code_row.claimed_at is not null
  ) then
    raise exception 'reviewer designation requires a fresh logical user'
      using errcode = '23514';
  end if;

  insert into private.reviewer_user_history (user_id)
  values (new.user_id)
  on conflict (user_id) do nothing;

  update private.recovery_codes as code_row
  set revoked_at = clock_timestamp()
  where code_row.user_id = new.user_id
    and code_row.revoked_at is null
    and code_row.claimed_at is null;

  return new;
end;
$$;

revoke all on function private.lock_down_reviewer_recovery()
  from public, anon, authenticated, service_role;

create trigger reviewer_accounts_lock_down_recovery
before insert or update on private.reviewer_accounts
for each row execute function private.lock_down_reviewer_recovery();

-- CREATE TRIGGER has waited for any reviewer writer that raced the initial
-- history backfill. Repeat the backfill while its table lock is still held so
-- every such committed row also receives the permanent security marker.
insert into private.reviewer_user_history (user_id, first_marked_at)
select reviewer_row.user_id, min(reviewer_row.granted_at)
from private.reviewer_accounts as reviewer_row
group by reviewer_row.user_id
on conflict (user_id) do nothing;

create or replace function private.guard_reviewer_recovery_code()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.claimed_at is not null then
    if tg_op = 'INSERT' or old.claimed_at is null then
      -- Claim is also forbidden when the claimant Auth identity has ever
      -- belonged to a reviewer logical user. The claim RPC revokes the old
      -- binding before it writes claimed_at, so inspect all identity history,
      -- not only the newly active target binding. Raising here rolls the whole
      -- transfer back and remains externally indistinguishable from a bad code.
      if new.claimed_by_auth_user_id is not null and exists (
        select 1
        from private.user_identities as claimant_identity
        join private.reviewer_user_history as claimant_history
          on claimant_history.user_id = claimant_identity.user_id
        where claimant_identity.auth_user_id = new.claimed_by_auth_user_id
      ) then
        raise exception 'recovery code not found'
          using errcode = 'P0002';
      end if;
    end if;
  end if;

  if private.user_has_reviewer_history(new.user_id) then
    if new.claimed_at is not null then
      if tg_op = 'INSERT' or old.claimed_at is null then
        -- The server maps this intentional, non-enumerating DB denial to the
        -- same 404 result as an unknown digest. Raising aborts every identity
        -- mutation already attempted by claim_recovery_code.
        raise exception 'recovery code not found'
          using errcode = 'P0002';
      end if;
    end if;

    if new.revoked_at is null and new.claimed_at is null then
      raise exception 'recovery is disabled for reviewer accounts'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.guard_reviewer_recovery_code()
  from public, anon, authenticated, service_role;

create trigger recovery_codes_guard_reviewer_transfer
before insert or update of user_id, revoked_at, claimed_at
on private.recovery_codes
for each row execute function private.guard_reviewer_recovery_code();

-- Run the legacy-code cutover only after the recovery-code trigger exists.
-- CREATE TRIGGER has waited for concurrent writers before this update, and
-- the trigger then prevents a late writer from reactivating a reviewer code.
-- Expired codes are included so a future clock/configuration change cannot
-- make them usable.
update private.recovery_codes as code_row
set revoked_at = clock_timestamp()
where code_row.revoked_at is null
  and code_row.claimed_at is null
  and private.user_has_reviewer_history(code_row.user_id);

create or replace function api_private.issue_recovery_code(
  p_auth_user_id uuid,
  p_code_hash_hex text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_rechecked_user_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  if p_auth_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  select identity_row.user_id
  into v_user_id
  from private.user_identities as identity_row
  join auth.users as auth_user on auth_user.id = identity_row.auth_user_id
  where identity_row.auth_user_id = p_auth_user_id
    and identity_row.revoked_at is null
    and auth_user.deleted_at is null;

  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('danyeodam:recovery:target:' || v_user_id::text, 0)
  );

  select identity_row.user_id
  into v_rechecked_user_id
  from private.user_identities as identity_row
  join auth.users as auth_user on auth_user.id = identity_row.auth_user_id
  where identity_row.auth_user_id = p_auth_user_id
    and identity_row.user_id = v_user_id
    and identity_row.revoked_at is null
    and auth_user.deleted_at is null
  for share of identity_row;

  if v_rechecked_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  if private.user_has_reviewer_history(v_user_id) then
    return jsonb_build_object('status', 'reviewer_forbidden');
  end if;

  if not exists (
    select 1
    from public.acquisitions as acquisition_row
    where acquisition_row.user_id = v_user_id
  ) then
    return jsonb_build_object('status', 'no_acquisition');
  end if;

  if p_code_hash_hex is null
    or p_code_hash_hex !~ '^[0-9A-Fa-f]{64}$'
  then
    raise exception 'invalid recovery code digest'
      using errcode = '22023';
  end if;

  update private.recovery_codes
  set revoked_at = v_now
  where user_id = v_user_id
    and revoked_at is null
    and claimed_at is null;

  insert into private.recovery_codes (
    user_id,
    code_hash,
    issued_at
  )
  values (
    v_user_id,
    decode(lower(p_code_hash_hex), 'hex'),
    v_now
  );

  return jsonb_build_object('status', 'issued');
end;
$$;

revoke all on function api_private.issue_recovery_code(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function api_private.issue_recovery_code(uuid, text)
  to service_role;

-- The Auth email mutation remains outside PostgreSQL, but the application
-- server must obtain this fail-closed DB decision before calling Auth.
create or replace function api_private.get_email_link_eligibility(
  p_auth_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if p_auth_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  select identity_row.user_id
  into v_user_id
  from private.user_identities as identity_row
  join auth.users as auth_user on auth_user.id = identity_row.auth_user_id
  where identity_row.auth_user_id = p_auth_user_id
    and identity_row.revoked_at is null
    and auth_user.deleted_at is null;

  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  if private.user_has_reviewer_history(v_user_id) then
    return jsonb_build_object('status', 'reviewer_forbidden');
  end if;

  return jsonb_build_object('status', 'eligible');
end;
$$;

revoke all on function api_private.get_email_link_eligibility(uuid)
  from public, anon, authenticated, service_role;
grant execute on function api_private.get_email_link_eligibility(uuid)
  to service_role;

-- Security-first primitive for the later reviewer lifecycle API. It is
-- intentionally service-role-only and does not create, reset, or provision a
-- fixture. Auth refresh-session cleanup remains an out-of-transaction,
-- best-effort operation; active identity revocation is the immediate 401
-- boundary for every protected API.
create or replace function api_private.revoke_reviewer_access(
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_participant_rows integer := 0;
  v_identity_rows integer := 0;
  v_recovery_code_rows integer := 0;
  v_share_rows integer := 0;
  v_optional_share_assignment text := '';
begin
  if p_user_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('danyeodam:recovery:target:' || p_user_id::text, 0)
  );

  -- History, not the mutable membership row, is the authorization and lock
  -- target. This lets operations close residue even if an old reviewer row
  -- was deleted before the supported revoke primitive was introduced.
  perform 1
  from private.reviewer_user_history as history_row
  where history_row.user_id = p_user_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  update private.recovery_codes as code_row
  set revoked_at = v_now
  where code_row.user_id = p_user_id
    and code_row.revoked_at is null
    and code_row.claimed_at is null;
  get diagnostics v_recovery_code_rows = row_count;

  -- Revoke any surviving reviewer membership first so the participant
  -- precedence trigger permits the explicit store_reviewer entitlement
  -- revocation below. A historical reviewer may have no membership row.
  update private.reviewer_accounts as reviewer_row
  set revoked_at = coalesce(reviewer_row.revoked_at, v_now)
  where reviewer_row.user_id = p_user_id;

  update private.participant_access as access_row
  set revoked_at = v_now
  where access_row.user_id = p_user_id
    and access_row.revoked_at is null;
  get diagnostics v_participant_rows = row_count;

  update private.user_identities as identity_row
  set revoked_at = v_now
  where identity_row.user_id = p_user_id
    and identity_row.revoked_at is null;
  get diagnostics v_identity_rows = row_count;

  -- UGC moderation may later add this redaction column. Dynamic inclusion
  -- keeps this migration valid on main while satisfying the future private
  -- share-state invariant after that separate migration lands.
  if exists (
    select 1
    from information_schema.columns as column_row
    where column_row.table_schema = 'public'
      and column_row.table_name = 'personal_cards'
      and column_row.column_name = 'share_reviewed_by_redacted_at'
  ) then
    v_optional_share_assignment := ', share_reviewed_by_redacted_at = null';
  end if;

  execute
    'update public.personal_cards
     set share_slug = null,
         shared_at = null,
         share_state = ''private'',
         share_submitted_at = null,
         share_terms_acceptance_id = null,
         share_community_acceptance_id = null,
         share_resubmission_required = false,
         share_reason_code = null,
         share_reviewed_at = null,
         share_reviewed_by = null' || v_optional_share_assignment || '
     where user_id = $1
       and (
         share_slug is not null
         or shared_at is not null
         or share_state::text <> ''private''
         or share_submitted_at is not null
         or share_terms_acceptance_id is not null
         or share_community_acceptance_id is not null
         or share_resubmission_required
         or share_reason_code is not null
         or share_reviewed_at is not null
         or share_reviewed_by is not null
       )'
  using p_user_id;
  get diagnostics v_share_rows = row_count;

  return jsonb_build_object(
    'status', 'revoked',
    'participant_rows', v_participant_rows,
    'identity_rows', v_identity_rows,
    'recovery_code_rows', v_recovery_code_rows,
    'share_rows', v_share_rows
  );
end;
$$;

revoke all on function api_private.revoke_reviewer_access(uuid)
  from public, anon, authenticated, service_role;
grant execute on function api_private.revoke_reviewer_access(uuid)
  to service_role;
