-- Preserve active participant entitlements across generic invite and recovery
-- upserts introduced before the store-reviewer role existed.
--
-- Generic service flows may extend access, but they must never silently lower
-- an active public-beta entitlement or a reviewer membership. Explicit
-- reviewer revocation remains possible by revoking reviewer_accounts first;
-- an explicit participant_access revocation (NEW.revoked_at is non-null) is
-- never blocked by this trigger.

create or replace function private.preserve_participant_access_precedence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.revoked_at is not null then
    return new;
  end if;

  if exists (
    select 1
    from private.reviewer_accounts as reviewer_row
    where reviewer_row.user_id = new.user_id
      and reviewer_row.revoked_at is null
  ) then
    new.access_kind := 'store_reviewer';
    return new;
  end if;

  if tg_op = 'UPDATE'
    and old.revoked_at is null
    and (old.expires_at is null or old.expires_at > statement_timestamp())
    and old.access_kind = 'public_beta'
    and new.access_kind = 'internal_tester'
  then
    new.access_kind := 'public_beta';
  end if;

  return new;
end;
$$;

revoke all on function private.preserve_participant_access_precedence()
  from public, anon, authenticated, service_role;

drop trigger if exists participant_access_preserve_precedence
  on private.participant_access;

create trigger participant_access_preserve_precedence
before insert or update on private.participant_access
for each row execute function private.preserve_participant_access_precedence();
