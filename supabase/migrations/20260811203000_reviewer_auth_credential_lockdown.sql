-- Store-review credentials are deliberately narrower than ordinary Auth
-- users. A reviewer must be a fresh, reusable email/password credential with
-- one confirmed email identity and no alternate or pending credential state.
-- The lock protocol below closes recovery, GoTrue user-update, and automatic
-- identity-linking races without adding a production location bypass.

begin;

create sequence private.reviewer_auth_guard_denials;

revoke all on sequence private.reviewer_auth_guard_denials
  from public, anon, authenticated, service_role;

create or replace function private.reviewer_auth_has_no_auxiliary_credentials(
  p_auth_user_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_exists boolean;
begin
  if exists (
    select 1
    from auth.mfa_factors as factor_row
    where factor_row.user_id = p_auth_user_id
  ) then
    return false;
  end if;

  -- Passkeys are separate from mfa_factors in newer GoTrue schemas. Keep the
  -- migration compatible with an installed version that has not introduced
  -- these tables, while treating every present credential/challenge as an
  -- invalid reviewer state.
  if to_regclass('auth.webauthn_credentials') is not null then
    execute 'select exists (
      select 1 from auth.webauthn_credentials where user_id = $1
    )'
    into v_exists
    using p_auth_user_id;
    if v_exists then
      return false;
    end if;
  end if;

  if to_regclass('auth.webauthn_challenges') is not null then
    execute 'select exists (
      select 1 from auth.webauthn_challenges where user_id = $1
    )'
    into v_exists
    using p_auth_user_id;
    if v_exists then
      return false;
    end if;
  end if;

  return true;
end;
$$;

revoke all on function private.reviewer_auth_has_no_auxiliary_credentials(uuid)
  from public, anon, authenticated, service_role;

create or replace function private.reviewer_auth_credential_is_valid(
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select
      auth_user.deleted_at is null
      and auth_user.is_anonymous is false
      and auth_user.is_sso_user is false
      and nullif(btrim(auth_user.email), '') is not null
      and auth_user.email_confirmed_at is not null
      and nullif(auth_user.encrypted_password, '') is not null
      and nullif(btrim(auth_user.phone), '') is null
      and auth_user.phone_confirmed_at is null
      and nullif(auth_user.confirmation_token, '') is null
      and nullif(auth_user.recovery_token, '') is null
      and auth_user.recovery_sent_at is null
      and nullif(auth_user.email_change_token_new, '') is null
      and nullif(auth_user.email_change_token_current, '') is null
      and nullif(btrim(auth_user.email_change), '') is null
      and auth_user.email_change_sent_at is null
      and coalesce(auth_user.email_change_confirm_status, 0) = 0
      and nullif(btrim(auth_user.phone_change), '') is null
      and nullif(auth_user.phone_change_token, '') is null
      and auth_user.phone_change_sent_at is null
      and nullif(auth_user.reauthentication_token, '') is null
      and auth_user.reauthentication_sent_at is null
      and auth_user.raw_app_meta_data ->> 'provider' = 'email'
      and auth_user.raw_app_meta_data -> 'providers' = '["email"]'::jsonb
      and private.reviewer_auth_has_no_auxiliary_credentials(auth_user.id)
      and (
        select count(*) = 1
          and bool_and(
            auth_identity.provider = 'email'
            and auth_identity.provider_id = auth_user.id::text
            and auth_identity.identity_data ->> 'sub' = auth_user.id::text
            and lower(auth_identity.identity_data ->> 'email')
              = lower(auth_user.email)
            and auth_identity.identity_data -> 'email_verified' = 'true'::jsonb
          )
        from auth.identities as auth_identity
        where auth_identity.user_id = auth_user.id
      )
    from private.user_identities as service_identity
    join auth.users as auth_user
      on auth_user.id = service_identity.auth_user_id
    where service_identity.user_id = p_user_id
      and service_identity.revoked_at is null
  ), false)
$$;

revoke all on function private.reviewer_auth_credential_is_valid(uuid)
  from public, anon, authenticated, service_role;

create or replace function private.assert_reviewer_auth_credential_cutover()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from private.reviewer_accounts as reviewer_row
    where reviewer_row.revoked_at is null
      and not private.reviewer_auth_credential_is_valid(reviewer_row.user_id)
  ) then
    -- Deliberately omit the row count, UUID, platform, and credential fields.
    raise exception 'active reviewer credential cutover validation failed'
      using errcode = '23514';
  end if;
end;
$$;

revoke all on function private.assert_reviewer_auth_credential_cutover()
  from public, anon, authenticated, service_role;

create or replace function private.lock_down_reviewer_recovery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth_user_id uuid;
  v_auxiliary_id uuid;
begin
  if tg_op = 'UPDATE' then
    if old.user_id is distinct from new.user_id then
      raise exception 'reviewer logical user cannot be changed'
        using errcode = '23514';
    end if;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'danyeodam:recovery:target:' || new.user_id::text,
      0
    )
  );

  -- Revocation deliberately skips credential validation so cleanup remains
  -- possible after identities have already been closed.
  if new.revoked_at is null then
    select service_identity.auth_user_id
    into v_auth_user_id
    from private.user_identities as service_identity
    join auth.users as auth_user
      on auth_user.id = service_identity.auth_user_id
    where service_identity.user_id = new.user_id
      and service_identity.revoked_at is null
    for update of service_identity, auth_user;

    -- Lock the complete Auth identity set after the service/Auth rows. An
    -- identity mutation takes the same advisory first (or fails its try-lock),
    -- so no automatic-provider row can appear between validation and commit.
    perform 1
    from auth.identities as auth_identity
    where auth_identity.user_id = v_auth_user_id
    order by auth_identity.id
    for update;

    perform 1
    from auth.mfa_factors as factor_row
    where factor_row.user_id = v_auth_user_id
    order by factor_row.id
    for update;

    if to_regclass('auth.webauthn_credentials') is not null then
      for v_auxiliary_id in execute
        'select id from auth.webauthn_credentials
         where user_id = $1 order by id for update'
        using v_auth_user_id
      loop
        null;
      end loop;
    end if;

    if to_regclass('auth.webauthn_challenges') is not null then
      for v_auxiliary_id in execute
        'select id from auth.webauthn_challenges
         where user_id = $1 order by id for update'
        using v_auth_user_id
      loop
        null;
      end loop;
    end if;

    if v_auth_user_id is null
      or not private.reviewer_auth_credential_is_valid(new.user_id)
    then
      raise exception 'reviewer designation requires one confirmed email/password identity'
        using errcode = '23514';
    end if;

    -- A revoked or deleted reviewer membership is never reissued in place.
    if tg_op = 'UPDATE' and old.revoked_at is not null then
      raise exception 'revoked reviewer credentials cannot be reactivated'
        using errcode = '23514';
    elsif tg_op = 'INSERT' and exists (
        select 1
        from private.reviewer_user_history as history_row
        where history_row.user_id = new.user_id
      ) then
      raise exception 'revoked reviewer credentials cannot be reactivated'
        using errcode = '23514';
    end if;
  end if;

  -- A logical user transferred through generic recovery is never eligible to
  -- become a reusable store credential. The shared target advisory makes the
  -- winner deterministic.
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

create or replace function private.guard_reviewer_auth_credential_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
  v_key text;
  v_credential_changed boolean := false;
  v_active_user_id uuid;
begin
  -- GoTrue soft deletion redacts several credential columns in one or more
  -- updates. Once deleted_at is non-null, allow the complete deletion path.
  if new.deleted_at is not null then
    return new;
  end if;

  -- Password-hash re-encryption and a user password change are the same
  -- auth.users column update at this boundary. encrypted_password therefore
  -- remains intentionally fail-closed; the operational runbook requires
  -- reviewer replacement before Auth DB-encryption key/version changes.
  foreach v_key in array array[
    'email',
    'encrypted_password',
    'email_confirmed_at',
    'invited_at',
    'confirmation_token',
    'confirmation_sent_at',
    'recovery_token',
    'recovery_sent_at',
    'email_change_token_new',
    'email_change_token_current',
    'email_change',
    'email_change_sent_at',
    'email_change_confirm_status',
    'phone',
    'phone_confirmed_at',
    'phone_change',
    'phone_change_token',
    'phone_change_sent_at',
    'reauthentication_token',
    'reauthentication_sent_at',
    'is_sso_user',
    'is_anonymous',
    'raw_app_meta_data'
  ] loop
    if v_old -> v_key is distinct from v_new -> v_key then
      v_credential_changed := true;
      exit;
    end if;
  end loop;

  if not v_credential_changed then
    return new;
  end if;

  select service_identity.user_id
  into v_active_user_id
  from private.user_identities as service_identity
  where service_identity.auth_user_id = old.id
    and service_identity.revoked_at is null;

  -- auth.users is already row-locked. Never wait for designation's advisory,
  -- because designation owns advisory -> service identity -> auth.users. A
  -- try-lock lets a link/update that started first commit, while a designation
  -- that started first makes this mutation fail closed without deadlock.
  if v_active_user_id is not null and not pg_try_advisory_xact_lock(
    hashtextextended(
      'danyeodam:recovery:target:' || v_active_user_id::text,
      0
    )
  ) then
    perform nextval('private.reviewer_auth_guard_denials'::regclass);
    raise exception 'credential mutation is forbidden'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from private.user_identities as service_identity
    join private.reviewer_user_history as history_row
      on history_row.user_id = service_identity.user_id
    where service_identity.auth_user_id = old.id
  ) then
    perform nextval('private.reviewer_auth_guard_denials'::regclass);
    raise exception 'credential mutation is forbidden'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function private.guard_reviewer_auth_credential_mutation()
  from public, anon, authenticated, service_role;

create or replace function private.guard_reviewer_auth_identity_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_auth_user_id uuid;
  v_new_auth_user_id uuid;
  v_binding_changed boolean;
  v_logical_user_id uuid;
  v_auth_user_id uuid;
begin
  if tg_op = 'INSERT' then
    v_new_auth_user_id := new.user_id;
    v_binding_changed := true;
  elsif tg_op = 'DELETE' then
    v_old_auth_user_id := old.user_id;
    v_binding_changed := true;
  else
    v_old_auth_user_id := old.user_id;
    v_new_auth_user_id := new.user_id;
    v_binding_changed := old.user_id is distinct from new.user_id
      or old.provider is distinct from new.provider
      or old.provider_id is distinct from new.provider_id
      or old.identity_data is distinct from new.identity_data;
  end if;

  -- A hard auth.users deletion reaches child tables through PostgreSQL's FK
  -- cascade trigger. Direct identity unlinking runs at trigger depth 1 and is
  -- still evaluated below.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;

  -- last_sign_in_at/updated_at-only writes are volatile sign-in state.
  if not v_binding_changed then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  -- GoTrue soft deletion first marks auth.users deleted, then obfuscates or
  -- deletes identities. A missing parent is the hard-delete cascade path.
  if (
    v_old_auth_user_id is not null
    and not exists (
      select 1 from auth.users as auth_user
      where auth_user.id = v_old_auth_user_id
        and auth_user.deleted_at is null
    )
  ) and (
    v_new_auth_user_id is null
    or not exists (
      select 1 from auth.users as auth_user
      where auth_user.id = v_new_auth_user_id
        and auth_user.deleted_at is null
    )
  ) then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  -- Serialize every identity insert/delete/binding change for a live service
  -- identity with reviewer designation. Old/new Auth IDs are sorted so a
  -- cross-user UPDATE cannot invert the advisory order.
  for v_logical_user_id in
    select distinct service_identity.user_id
    from private.user_identities as service_identity
    where service_identity.auth_user_id in (
      coalesce(v_old_auth_user_id, v_new_auth_user_id),
      coalesce(v_new_auth_user_id, v_old_auth_user_id)
    )
      and service_identity.revoked_at is null
    order by service_identity.user_id
  loop
    if not pg_try_advisory_xact_lock(
      hashtextextended(
        'danyeodam:recovery:target:' || v_logical_user_id::text,
        0
      )
    ) then
      perform nextval('private.reviewer_auth_guard_denials'::regclass);
      raise exception 'credential identity mutation is forbidden'
        using errcode = '23514';
    end if;
  end loop;

  foreach v_auth_user_id in array array[
    v_old_auth_user_id,
    v_new_auth_user_id
  ] loop
    if v_auth_user_id is not null and exists (
      select 1
      from private.user_identities as service_identity
      join private.reviewer_user_history as history_row
        on history_row.user_id = service_identity.user_id
      where service_identity.auth_user_id = v_auth_user_id
    ) then
      perform nextval('private.reviewer_auth_guard_denials'::regclass);
      raise exception 'credential identity mutation is forbidden'
        using errcode = '23514';
    end if;
  end loop;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function private.guard_reviewer_auth_identity_mutation()
  from public, anon, authenticated, service_role;

create or replace function private.guard_reviewer_auth_auxiliary_credential_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_auth_user_id uuid;
  v_new_auth_user_id uuid;
  v_logical_user_id uuid;
  v_auth_user_id uuid;
begin
  if tg_op <> 'INSERT' then
    v_old_auth_user_id := old.user_id;
  end if;
  if tg_op <> 'DELETE' then
    v_new_auth_user_id := new.user_id;
  end if;

  -- Preserve auth.users hard-delete cascades while continuing to reject a
  -- direct factor/passkey deletion on a live reviewer credential.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;

  -- GoTrue deletes factors/passkeys after marking auth.users.deleted_at and
  -- hard deletion cascades after the parent disappears.
  if (
    v_old_auth_user_id is not null
    and not exists (
      select 1 from auth.users as auth_user
      where auth_user.id = v_old_auth_user_id
        and auth_user.deleted_at is null
    )
  ) and (
    v_new_auth_user_id is null
    or not exists (
      select 1 from auth.users as auth_user
      where auth_user.id = v_new_auth_user_id
        and auth_user.deleted_at is null
    )
  ) then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  for v_logical_user_id in
    select distinct service_identity.user_id
    from private.user_identities as service_identity
    where service_identity.auth_user_id in (
      coalesce(v_old_auth_user_id, v_new_auth_user_id),
      coalesce(v_new_auth_user_id, v_old_auth_user_id)
    )
      and service_identity.revoked_at is null
    order by service_identity.user_id
  loop
    if not pg_try_advisory_xact_lock(
      hashtextextended(
        'danyeodam:recovery:target:' || v_logical_user_id::text,
        0
      )
    ) then
      perform nextval('private.reviewer_auth_guard_denials'::regclass);
      raise exception 'auxiliary credential mutation is forbidden'
        using errcode = '23514';
    end if;
  end loop;

  foreach v_auth_user_id in array array[
    v_old_auth_user_id,
    v_new_auth_user_id
  ] loop
    if v_auth_user_id is not null and exists (
      select 1
      from private.user_identities as service_identity
      join private.reviewer_user_history as history_row
        on history_row.user_id = service_identity.user_id
      where service_identity.auth_user_id = v_auth_user_id
    ) then
      perform nextval('private.reviewer_auth_guard_denials'::regclass);
      raise exception 'auxiliary credential mutation is forbidden'
        using errcode = '23514';
    end if;
  end loop;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function private.guard_reviewer_auth_auxiliary_credential_mutation()
  from public, anon, authenticated, service_role;

-- A cutover must never silently grandfather an invalid active reviewer.
-- Lock every participating membership/Auth table, validate without logging identifiers,
-- and only then install the Auth guards.
lock table private.reviewer_accounts in share row exclusive mode;
lock table private.user_identities in share row exclusive mode;
lock table auth.users in share row exclusive mode;
lock table auth.identities in share row exclusive mode;
lock table auth.mfa_factors in share row exclusive mode;

do $$
begin
  if to_regclass('auth.webauthn_credentials') is not null then
    execute 'lock table auth.webauthn_credentials in share row exclusive mode';
  end if;
  if to_regclass('auth.webauthn_challenges') is not null then
    execute 'lock table auth.webauthn_challenges in share row exclusive mode';
  end if;
end;
$$;

select private.assert_reviewer_auth_credential_cutover();

drop trigger if exists auth_users_guard_reviewer_credentials on auth.users;
create trigger auth_users_guard_reviewer_credentials
before update on auth.users
for each row execute function private.guard_reviewer_auth_credential_mutation();

drop trigger if exists auth_identities_guard_reviewer_credentials on auth.identities;
create trigger auth_identities_guard_reviewer_credentials
before insert or update or delete on auth.identities
for each row execute function private.guard_reviewer_auth_identity_mutation();

drop trigger if exists auth_mfa_factors_guard_reviewer_credentials on auth.mfa_factors;
create trigger auth_mfa_factors_guard_reviewer_credentials
before insert or update or delete on auth.mfa_factors
for each row execute function private.guard_reviewer_auth_auxiliary_credential_mutation();

do $$
begin
  if to_regclass('auth.webauthn_credentials') is not null then
    execute 'drop trigger if exists auth_webauthn_credentials_guard_reviewer
      on auth.webauthn_credentials';
    execute 'create trigger auth_webauthn_credentials_guard_reviewer
      before insert or update or delete on auth.webauthn_credentials
      for each row execute function
        private.guard_reviewer_auth_auxiliary_credential_mutation()';
  end if;
  if to_regclass('auth.webauthn_challenges') is not null then
    execute 'drop trigger if exists auth_webauthn_challenges_guard_reviewer
      on auth.webauthn_challenges';
    execute 'create trigger auth_webauthn_challenges_guard_reviewer
      before insert or update or delete on auth.webauthn_challenges
      for each row execute function
        private.guard_reviewer_auth_auxiliary_credential_mutation()';
  end if;
end;
$$;

commit;
