-- Store-reviewer fixture lifecycle.
--
-- Auth email/password creation remains an explicit Supabase Admin API
-- operation outside this database transaction. These service-role-only RPCs
-- accept only an already-bound logical user whose Auth credential satisfies
-- the reviewer lockdown invariant. No email, password, access token, refresh
-- token, or raw share secret is copied into lifecycle inventory or audit rows.

begin;

-- GoTrue Admin createUser({ email_confirm: true }) makes auth.users'
-- email_confirmed_at authoritative but currently retains provider-owned
-- identity_data.email_verified=false. Identity metadata is still exact-bound
-- by provider/provider_id/sub/email; confirmation is intentionally checked on
-- auth.users so the supported Admin API account lifecycle is not rejected.
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
      -- GoTrue password sessions derive their JWT authorization boundary from
      -- these columns. A reviewer credential must never be able to mint a
      -- service-role (or other non-user) token through role/audience drift.
      and auth_user.role = 'authenticated'
      and auth_user.aud = 'authenticated'
      and coalesce(auth_user.is_super_admin, false) is false
      and auth_user.banned_until is null
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
      and auth_user.raw_app_meta_data
        = '{"provider":"email","providers":["email"]}'::jsonb
      and auth_user.raw_user_meta_data in (
        '{}'::jsonb,
        '{"email_verified":true}'::jsonb
      )
      and private.reviewer_auth_has_no_auxiliary_credentials(auth_user.id)
      and (
        select count(*) = 1
          and bool_and(
            auth_identity.provider = 'email'
            and auth_identity.provider_id = auth_user.id::text
            and auth_identity.identity_data ->> 'sub' = auth_user.id::text
            and lower(auth_identity.identity_data ->> 'email')
              = lower(auth_user.email)
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

-- Revalidate every already-active reviewer against the stricter Admin API
-- metadata representation before installing the new guard. These locks use
-- the same canonical order as the original credential cutover so no Auth or
-- membership writer can cross the validation boundary. Any invalid legacy
-- reviewer aborts this entire migration, including the function replacement
-- and the Supabase migration-history insert.
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

-- Generic invitation redemption predates the two-phase reviewer fixture.
-- Keep its implementation as an internal primitive and put a reviewer-aware
-- lock boundary in front of it. The target advisory matches provision/reset,
-- so a prepared reviewer can never gain participant access between prepare
-- and complete through the precedence trigger.
alter function api_private.redeem_participant_invite(uuid, text)
  rename to redeem_participant_invite_before_reviewer_fixture;

revoke all on function api_private.redeem_participant_invite_before_reviewer_fixture(
  uuid, text
) from public, anon, authenticated, service_role;

create or replace function api_private.redeem_participant_invite(
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
begin
  if p_auth_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  select identity_row.user_id
  into v_user_id
  from private.user_identities as identity_row
  join auth.users as auth_user
    on auth_user.id = identity_row.auth_user_id
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
  join auth.users as auth_user
    on auth_user.id = identity_row.auth_user_id
  where identity_row.auth_user_id = p_auth_user_id
    and identity_row.user_id = v_user_id
    and identity_row.revoked_at is null
    and auth_user.deleted_at is null
  for share of identity_row;

  if v_rechecked_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  if exists (
      select 1
      from private.reviewer_user_history as history_row
      where history_row.user_id = v_user_id
    )
    or exists (
      select 1
      from private.reviewer_accounts as reviewer_row
      where reviewer_row.user_id = v_user_id
    )
    or exists (
      select 1
      from private.reviewer_access_actions as action_row
      where action_row.target_fingerprint
        = private.reviewer_lifecycle_target_fingerprint(v_user_id)
        and action_row.action in ('provision', 'reset')
        and action_row.completed_result_json is null
    )
  then
    return jsonb_build_object('status', 'not_found');
  end if;

  return api_private.redeem_participant_invite_before_reviewer_fixture(
    p_auth_user_id,
    p_code_hash_hex
  );
end;
$$;

revoke all on function api_private.redeem_participant_invite(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function api_private.redeem_participant_invite(uuid, text)
  to service_role;

-- The original credential guard predates the exact Admin createUser metadata
-- contract and therefore freezes provider-owned application metadata but not
-- raw_user_meta_data. Keep the supported GoTrue value immutable after reviewer
-- designation without rewriting the already-versioned lockdown migration.
create or replace function private.guard_reviewer_auth_user_metadata_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active_user_id uuid;
begin
  if new.deleted_at is not null
    or (
      old.raw_user_meta_data is not distinct from new.raw_user_meta_data
      and old.role is not distinct from new.role
      and old.aud is not distinct from new.aud
      and old.is_super_admin is not distinct from new.is_super_admin
      and old.banned_until is not distinct from new.banned_until
    )
  then
    return new;
  end if;

  select service_identity.user_id
  into v_active_user_id
  from private.user_identities as service_identity
  where service_identity.auth_user_id = old.id
    and service_identity.revoked_at is null;

  -- Match the credential guard's deadlock-free designation race boundary.
  -- A metadata UPDATE that began first may commit and is then revalidated by
  -- designation. If designation owns the target first, fail immediately
  -- instead of waiting auth.users -> advisory against advisory -> auth.users.
  if v_active_user_id is not null and not pg_try_advisory_xact_lock(
    hashtextextended(
      'danyeodam:recovery:target:' || v_active_user_id::text,
      0
    )
  ) then
    perform nextval('private.reviewer_auth_guard_denials'::regclass);
    raise exception 'credential metadata mutation is forbidden'
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
    raise exception 'credential metadata mutation is forbidden'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function private.guard_reviewer_auth_user_metadata_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists auth_users_guard_reviewer_user_metadata on auth.users;
create trigger auth_users_guard_reviewer_user_metadata
before update of
  raw_user_meta_data, role, aud, is_super_admin, banned_until
on auth.users
for each row execute function private.guard_reviewer_auth_user_metadata_mutation();

-- Reviewer accounts are dedicated Store identities, never upgraded real-user
-- accounts. Reject any logical/Auth history beyond the single fresh binding.
create or replace function private.reviewer_target_is_pristine(
  p_user_id uuid,
  p_allow_reviewer_reservation boolean
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    p_user_id is not null
    and (
      select count(*) = 1 and count(*) filter (where identity_row.revoked_at is null) = 1
      from private.user_identities as identity_row
      where identity_row.user_id = p_user_id
    )
    and (
      select count(*) = 1
      from private.user_identities as all_binding
      where all_binding.auth_user_id = (
        select target_binding.auth_user_id
        from private.user_identities as target_binding
        where target_binding.user_id = p_user_id
          and target_binding.revoked_at is null
      )
    )
    and not exists (
      select 1
      from private.user_identities as identity_row
      join private.admin_members as admin_row
        on admin_row.auth_user_id = identity_row.auth_user_id
      where identity_row.user_id = p_user_id
    )
    and not exists (
      select 1
      from private.user_identities as identity_row
      join private.participant_redeem_limits as limit_row
        on limit_row.auth_user_id = identity_row.auth_user_id
      where identity_row.user_id = p_user_id
    )
    and not exists (
      select 1
      from private.user_identities as identity_row
      join private.recovery_claim_limits as limit_row
        on limit_row.auth_user_id = identity_row.auth_user_id
      where identity_row.user_id = p_user_id
    )
    and not exists (
      select 1
      from private.user_identities as identity_row
      join private.account_deletion_auth_manifest as manifest_row
        on manifest_row.auth_user_id = identity_row.auth_user_id
      where identity_row.user_id = p_user_id
    )
    and not exists (
      select 1 from (
        select access_row.user_id
        from private.participant_access as access_row
        where access_row.user_id = p_user_id
        union all
        select reviewer_row.user_id
        from private.reviewer_accounts as reviewer_row
        where reviewer_row.user_id = p_user_id
          and not coalesce(p_allow_reviewer_reservation, false)
        union all
        select history_row.user_id
        from private.reviewer_user_history as history_row
        where history_row.user_id = p_user_id
          and not coalesce(p_allow_reviewer_reservation, false)
        union all
        select acquisition_row.user_id
        from public.acquisitions as acquisition_row
        where acquisition_row.user_id = p_user_id
        union all
        select card_row.user_id
        from public.personal_cards as card_row
        where card_row.user_id = p_user_id
        union all
        select request_row.user_id
        from public.physical_requests as request_row
        where request_row.user_id = p_user_id
        union all
        select event_row.user_id
        from analytics.events as event_row
        where event_row.user_id = p_user_id
        union all
        select code_row.user_id
        from private.recovery_codes as code_row
        where code_row.user_id = p_user_id
        union all
        select code_row.redeemed_by_user_id
        from private.participant_invite_codes as code_row
        where code_row.redeemed_by_user_id = p_user_id
        union all
        select acceptance_row.user_id
        from private.policy_acceptances as acceptance_row
        where acceptance_row.user_id = p_user_id
        union all
        select attestation_row.user_id
        from private.minimum_age_attestations as attestation_row
        where attestation_row.user_id = p_user_id
        union all
        select consent_row.user_id
        from private.location_consents as consent_row
        where consent_row.user_id = p_user_id
        union all
        select fact_row.user_id
        from private.location_use_facts as fact_row
        where fact_row.user_id = p_user_id
        union all
        select correction_row.user_id
        from private.location_correction_requests as correction_row
        where correction_row.user_id = p_user_id
        union all
        select disclosure_row.user_id
        from private.location_disclosure_accesses as disclosure_row
        where disclosure_row.user_id = p_user_id
        union all
        select upload_row.user_id
        from private.personal_card_temp_uploads as upload_row
        where upload_row.user_id = p_user_id
        union all
        select deletion_row.user_id
        from private.personal_card_deletion_requests as deletion_row
        where deletion_row.user_id = p_user_id
        union all
        select state_row.user_id
        from private.personal_card_upload_rate_states as state_row
        where state_row.user_id = p_user_id
        union all
        select ledger_row.user_id
        from private.personal_card_field_object_ledger as ledger_row
        where ledger_row.user_id = p_user_id
        union all
        select ledger_row.user_id
        from private.personal_card_permanent_object_ledger as ledger_row
        where ledger_row.user_id = p_user_id
        union all
        select erasure_row.user_id
        from private.data_erasure_jobs as erasure_row
        where erasure_row.user_id = p_user_id
        union all
        select deletion_row.user_id
        from private.account_deletion_jobs as deletion_row
        where deletion_row.user_id = p_user_id
        union all
        select rate_row.user_id
        from private.rate_limit_windows as rate_row
        where rate_row.user_id = p_user_id
        union all
        select suspension_row.user_id
        from private.share_owner_suspensions as suspension_row
        where suspension_row.user_id = p_user_id
        union all
        select report_row.owner_user_id
        from private.content_reports as report_row
        where report_row.owner_user_id = p_user_id
        union all
        select moderation_row.owner_user_id
        from private.moderation_actions as moderation_row
        where moderation_row.owner_user_id = p_user_id
        union all
        select block_row.blocker_user_id
        from private.user_blocks as block_row
        where block_row.blocker_user_id = p_user_id
           or block_row.blocked_user_id = p_user_id
        union all
        select action_row.blocker_user_id
        from private.user_block_actions as action_row
        where action_row.blocker_user_id = p_user_id
           or action_row.blocked_user_id = p_user_id
      ) as owned_row
    )
$$;

revoke all on function private.reviewer_target_is_pristine(uuid, boolean)
  from public, anon, authenticated, service_role;

create or replace function private.reviewer_target_is_pristine(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.reviewer_target_is_pristine(p_user_id, false)
$$;

revoke all on function private.reviewer_target_is_pristine(uuid)
  from public, anon, authenticated, service_role;

alter table private.policy_acceptances
  add column acceptance_source text not null default 'user'
    check (acceptance_source in ('user', 'reviewer_fixture'));

create table private.reviewer_fixture_templates (
  position smallint primary key check (position between 1 and 6),
  spot_slug text not null unique
    check (spot_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  sample_personal_card boolean not null default false
);

create unique index reviewer_fixture_templates_one_sample_idx
  on private.reviewer_fixture_templates(sample_personal_card)
  where sample_personal_card;

insert into private.reviewer_fixture_templates (
  position,
  spot_slug,
  sample_personal_card
) values
  (1, 'seoul-cheongjin-lol-park-nearby-exterior', false),
  (2, 'seoul-gwanghwamun-square', true),
  (3, 'seoul-ddp-history-park', false),
  (4, 'seoul-hongdae-red-road-r1', false),
  (5, 'seoul-seokchon-lake-park', false),
  (6, 'seoul-olympic-park', false);

create table private.reviewer_fixture_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  fixture_version text not null
    check (
      char_length(fixture_version) between 1 and 64
      and fixture_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    ),
  item_kind text not null
    check (item_kind in ('retro_acquisition', 'personal_card', 'public_share')),
  logical_key text not null
    check (
      char_length(logical_key) between 1 and 96
      and logical_key ~ '^[a-z0-9]+(?:[-:.][a-z0-9]+)*$'
    ),
  resource_id uuid not null,
  content_hash bytea not null check (octet_length(content_hash) = 32),
  created_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  constraint reviewer_fixture_items_revocation_order check (
    revoked_at is null or revoked_at >= created_at
  )
);

create unique index reviewer_fixture_items_active_logical_idx
  on private.reviewer_fixture_items(user_id, item_kind, logical_key)
  where revoked_at is null;

create index reviewer_fixture_items_user_lifecycle_idx
  on private.reviewer_fixture_items(user_id, revoked_at, item_kind, logical_key);

create index reviewer_fixture_items_resource_idx
  on private.reviewer_fixture_items(item_kind, resource_id);

-- The audit stores domain-separated UUID fingerprints, not raw Auth/logical
-- user identifiers. result_json may contain only non-secret counts, hashes,
-- platform/version, and opaque Storage object UUIDs needed for cleanup retry.
create table private.reviewer_access_actions (
  id uuid primary key default gen_random_uuid(),
  admin_fingerprint bytea not null check (octet_length(admin_fingerprint) = 32),
  target_fingerprint bytea not null check (octet_length(target_fingerprint) = 32),
  client_action_id uuid not null,
  action text not null check (action in ('provision', 'reset', 'revoke')),
  payload_hash bytea not null check (octet_length(payload_hash) = 32),
  result_json jsonb not null check (jsonb_typeof(result_json) = 'object'),
  completed_result_json jsonb
    check (
      completed_result_json is null
      or jsonb_typeof(completed_result_json) = 'object'
    ),
  created_at timestamptz not null default clock_timestamp(),
  constraint reviewer_access_actions_admin_client_unique
    unique (admin_fingerprint, client_action_id)
);

create index reviewer_access_actions_target_idx
  on private.reviewer_access_actions(target_fingerprint, created_at desc);

create unique index reviewer_access_actions_one_pending_fixture_idx
  on private.reviewer_access_actions(target_fingerprint)
  where completed_result_json is null and action in ('provision', 'reset');

alter table private.reviewer_fixture_templates enable row level security;
alter table private.reviewer_fixture_templates force row level security;
alter table private.reviewer_fixture_items enable row level security;
alter table private.reviewer_fixture_items force row level security;
alter table private.reviewer_access_actions enable row level security;
alter table private.reviewer_access_actions force row level security;

revoke all on table private.reviewer_fixture_templates,
  private.reviewer_fixture_items,
  private.reviewer_access_actions
  from public, anon, authenticated, service_role;

create or replace function private.reviewer_fixture_uuid(
  p_user_id uuid,
  p_key text
)
returns uuid
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_hex text;
begin
  if p_user_id is null
    or p_key is null
    or char_length(p_key) not between 1 and 256
  then
    raise exception 'invalid reviewer fixture UUID input'
      using errcode = '22023';
  end if;

  v_hex := encode(
    extensions.digest(
      'danyeodam:reviewer-fixture-uuid:v1:'
        || p_user_id::text || ':' || p_key,
      'sha256'
    ),
    'hex'
  );

  return (
    substr(v_hex, 1, 8) || '-' ||
    substr(v_hex, 9, 4) || '-5' ||
    substr(v_hex, 14, 3) || '-8' ||
    substr(v_hex, 18, 3) || '-' ||
    substr(v_hex, 21, 12)
  )::uuid;
end;
$$;

create or replace function private.reviewer_lifecycle_admin_fingerprint(
  p_auth_user_id uuid
)
returns bytea
language sql
immutable
security definer
set search_path = ''
as $$
  select extensions.digest(
    'danyeodam:reviewer-lifecycle-admin:v1:' || p_auth_user_id::text,
    'sha256'
  )
$$;

create or replace function private.reviewer_lifecycle_target_fingerprint(
  p_user_id uuid
)
returns bytea
language sql
immutable
security definer
set search_path = ''
as $$
  select extensions.digest(
    'danyeodam:reviewer-lifecycle-target:v1:' || p_user_id::text,
    'sha256'
  )
$$;

create or replace function private.reviewer_fixture_share_secret()
returns text
language sql
volatile
security definer
set search_path = ''
as $$
  select encode(extensions.gen_random_bytes(16), 'hex')
$$;

-- Completion is a no-count continuation of an already-counted prepare, but
-- it must retain the rate limiter's authorization strength. Lock the active
-- admin binding, Auth row, logical user, and membership in canonical order so
-- a concurrent admin revoke/delete either commits first and is observed, or
-- waits until this completion transaction ends.
create or replace function private.lock_reviewer_continuation_admin(
  p_admin_auth_user_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin_user_id uuid;
begin
  if p_admin_auth_user_id is null then
    return false;
  end if;

  select identity_row.user_id
  into v_admin_user_id
  from private.user_identities as identity_row
  join auth.users as auth_user
    on auth_user.id = identity_row.auth_user_id
  where identity_row.auth_user_id = p_admin_auth_user_id
    and identity_row.revoked_at is null
    and auth_user.deleted_at is null
  for share of identity_row, auth_user;
  if not found then
    return false;
  end if;

  perform 1
  from public.app_users as user_row
  where user_row.id = v_admin_user_id
    and user_row.deletion_requested_at is null
  for share of user_row;
  if not found then
    return false;
  end if;

  perform 1
  from private.admin_members as admin_row
  where admin_row.auth_user_id = p_admin_auth_user_id
    and admin_row.revoked_at is null
  for share of admin_row;
  return found;
end;
$$;

revoke all on function private.reviewer_fixture_uuid(uuid, text),
  private.reviewer_lifecycle_admin_fingerprint(uuid),
  private.reviewer_lifecycle_target_fingerprint(uuid),
  private.lock_reviewer_continuation_admin(uuid),
  private.reviewer_fixture_share_secret()
  from public, anon, authenticated, service_role;

create or replace function private.apply_reviewer_fixture(
  p_admin_auth_user_id uuid,
  p_user_id uuid,
  p_fixture_version text,
  p_client_action_id uuid,
  p_photo_object_id uuid,
  p_photo_size_bytes bigint,
  p_photo_sha256_hex text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_template record;
  v_acquisition_id uuid;
  v_expected_item_hash bytea;
  v_inserted integer;
  v_terms_document_id uuid;
  v_terms_version text;
  v_terms_sha bytea;
  v_community_document_id uuid;
  v_community_version text;
  v_community_sha bytea;
  v_terms_acceptance_id uuid;
  v_community_acceptance_id uuid;
  v_sample_slug text;
  v_sample_acquisition_id uuid;
  v_personal_card_id uuid;
  v_previous_photo_path text;
  v_previous_state text := 'private';
  v_photo_path text;
  v_share_slug text;
  v_constraint_name text;
  v_existing_card public.personal_cards%rowtype;
  v_retro_count integer;
  v_personal_count integer;
  v_share_count integer;
  v_fixture_hash text;
  v_personal_hash bytea;
  v_share_hash bytea;
begin
  if p_admin_auth_user_id is null
    or p_user_id is null
    or p_client_action_id is null
    or p_photo_object_id is null
    or p_photo_object_id <> private.reviewer_fixture_uuid(
      p_user_id,
      'photo:' || p_client_action_id::text
    )
    or p_photo_size_bytes is null
    or p_photo_size_bytes not between 1 and 5242880
    or p_photo_sha256_hex is null
    or p_photo_sha256_hex !~ '^[0-9A-Fa-f]{64}$'
  then
    raise exception 'invalid reviewer fixture photo binding'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from private.reviewer_accounts as reviewer_row
    join private.participant_access as access_row
      on access_row.user_id = reviewer_row.user_id
    where reviewer_row.user_id = p_user_id
      and reviewer_row.fixture_version = p_fixture_version
      and reviewer_row.revoked_at is null
      and access_row.access_kind = 'store_reviewer'
      and access_row.revoked_at is null
      and (
        access_row.expires_at is null
        or access_row.expires_at > statement_timestamp()
      )
  ) then
    raise exception 'reviewer membership disappeared during fixture apply'
      using errcode = '40001';
  end if;

  -- All published card responses are locked in the canonical card -> spot
  -- order used by acquisition. This freezes the exact six-card fixture while
  -- acquisitions and the inventory hash are written.
  perform card_row.id
  from private.reviewer_fixture_templates as template_row
  join public.spots as spot_row
    on spot_row.slug = template_row.spot_slug
  join public.cards as card_row
    on card_row.spot_id = spot_row.id
   and card_row.kind = 'region'
   and card_row.is_published
  order by card_row.id
  for share of card_row;

  perform spot_row.id
  from private.reviewer_fixture_templates as template_row
  join public.spots as spot_row
    on spot_row.slug = template_row.spot_slug
  order by spot_row.id
  for share of spot_row;

  if (
    select count(*)
    from private.reviewer_fixture_templates as template_row
    join public.spots as spot_row
      on spot_row.slug = template_row.spot_slug
     and spot_row.status = 'open'
    join public.cards as card_row
      on card_row.spot_id = spot_row.id
     and card_row.kind = 'region'
     and card_row.is_published
     and card_row.sketch_path is not null
    where (
      select count(*)
      from public.region_translations as translation_row
      where translation_row.region_code = spot_row.region
        and translation_row.status = 'approved'
    ) = 6
      and (
        select count(*)
        from public.spot_translations as translation_row
        where translation_row.spot_id = spot_row.id
          and translation_row.status = 'approved'
      ) = 6
      and (
        select count(*)
        from public.card_translations as translation_row
        where translation_row.card_id = card_row.id
          and translation_row.status = 'approved'
      ) = 6
  ) <> 6 then
    raise exception 'reviewer fixture content is not release-ready'
      using errcode = '23514';
  end if;

  select
    document_row.id,
    document_row.version,
    locale_row.sha256
  into v_terms_document_id, v_terms_version, v_terms_sha
  from private.policy_documents as document_row
  join private.policy_document_locales as locale_row
    on locale_row.policy_document_id = document_row.id
   and locale_row.locale = 'en'
  where document_row.policy_type = 'terms_of_use'
    and document_row.is_current
    and document_row.effective_at <= statement_timestamp()
    and private.policy_document_is_complete(document_row.id);

  select
    document_row.id,
    document_row.version,
    locale_row.sha256
  into v_community_document_id, v_community_version, v_community_sha
  from private.policy_documents as document_row
  join private.policy_document_locales as locale_row
    on locale_row.policy_document_id = document_row.id
   and locale_row.locale = 'en'
  where document_row.policy_type = 'community_guidelines'
    and document_row.is_current
    and document_row.effective_at <= statement_timestamp()
    and private.policy_document_is_complete(document_row.id);

  if v_terms_document_id is null or v_community_document_id is null then
    raise exception 'reviewer fixture policies are not release-ready'
      using errcode = '23514';
  end if;

  v_terms_acceptance_id := private.reviewer_fixture_uuid(
    p_user_id,
    'policy:' || v_terms_document_id::text
  );
  v_community_acceptance_id := private.reviewer_fixture_uuid(
    p_user_id,
    'policy:' || v_community_document_id::text
  );

  -- A reset may encounter a real user's acceptance for a newly-current
  -- policy document. Never relabel or reuse that row as reviewer-fixture
  -- provenance. The caller catches this named invariant and rolls back the
  -- entire apply subtransaction before returning fixture_conflict.
  if exists (
    select 1
    from private.policy_acceptances as acceptance_row
    where acceptance_row.user_id = p_user_id
      and (
        (
          acceptance_row.policy_document_id = v_terms_document_id
          and (
            acceptance_row.id <> v_terms_acceptance_id
            or acceptance_row.accepted_locale <> 'en'
            or acceptance_row.accepted_sha256 <> v_terms_sha
            or acceptance_row.acceptance_source <> 'reviewer_fixture'
          )
        )
        or (
          acceptance_row.policy_document_id = v_community_document_id
          and (
            acceptance_row.id <> v_community_acceptance_id
            or acceptance_row.accepted_locale <> 'en'
            or acceptance_row.accepted_sha256 <> v_community_sha
            or acceptance_row.acceptance_source <> 'reviewer_fixture'
          )
        )
      )
  ) then
    raise exception 'reviewer policy acceptance identity conflict'
      using errcode = '23514',
        constraint = 'reviewer_fixture_policy_acceptance_exact';
  end if;

  -- Retro acquisitions are deterministic per logical user, fixture version,
  -- and candidate slug. Reset never creates field sequence numbers or a
  -- second retro event for an already-installed item.
  for v_template in
    select
      template_row.position,
      template_row.spot_slug,
      template_row.sample_personal_card,
      spot_row.id as spot_id,
      card_row.id as card_id,
      card_row.code as card_code
    from private.reviewer_fixture_templates as template_row
    join public.spots as spot_row
      on spot_row.slug = template_row.spot_slug
    join public.cards as card_row
      on card_row.spot_id = spot_row.id
     and card_row.kind = 'region'
     and card_row.is_published
    order by template_row.position
  loop
    v_acquisition_id := private.reviewer_fixture_uuid(
      p_user_id,
      'retro:' || p_fixture_version || ':' || v_template.spot_slug
    );
    v_expected_item_hash := extensions.digest(
      'danyeodam:reviewer-retro:v1:' || p_fixture_version || ':'
        || v_template.spot_slug || ':' || v_template.card_id::text,
      'sha256'
    );

    insert into public.acquisitions (
      id,
      user_id,
      spot_id,
      card_id,
      acquisition_type,
      verification_result,
      idempotency_key,
      field_sequence,
      acquired_at
    ) values (
      v_acquisition_id,
      p_user_id,
      v_template.spot_id,
      v_template.card_id,
      'retro',
      'manual',
      private.reviewer_fixture_uuid(
        p_user_id,
        'retro-idempotency:' || p_fixture_version || ':' || v_template.spot_slug
      ),
      null,
      v_now
    ) on conflict (id) do nothing;
    get diagnostics v_inserted = row_count;

    if not exists (
      select 1
      from public.acquisitions as acquisition_row
      where acquisition_row.id = v_acquisition_id
        and acquisition_row.user_id = p_user_id
        and acquisition_row.spot_id = v_template.spot_id
        and acquisition_row.card_id = v_template.card_id
        and acquisition_row.acquisition_type = 'retro'
        and acquisition_row.verification_result = 'manual'
        and acquisition_row.field_sequence is null
    ) then
      raise exception 'reviewer retro acquisition identity conflict'
        using errcode = '23505';
    end if;

    insert into private.retro_grants (
      id,
      acquisition_id,
      admin_auth_user_id,
      reason_code,
      note,
      created_at
    ) values (
      private.reviewer_fixture_uuid(
        p_user_id,
        'retro-grant:' || p_fixture_version || ':' || v_template.spot_slug
      ),
      v_acquisition_id,
      p_admin_auth_user_id,
      'reviewer_fixture',
      'Store reviewer fixture retro grant',
      v_now
    ) on conflict (acquisition_id) do nothing;

    if v_inserted = 1 then
      insert into analytics.events (
        user_id,
        event_name,
        source,
        occurred_at,
        spot_id,
        properties
      ) values (
        p_user_id,
        'retro_granted',
        'server',
        v_now,
        v_template.spot_id,
        '{}'::jsonb
      );
    end if;

    if exists (
      select 1
      from private.reviewer_fixture_items as item_row
      where item_row.user_id = p_user_id
        and item_row.item_kind = 'retro_acquisition'
        and item_row.logical_key = v_template.spot_slug
        and item_row.revoked_at is null
        and (
          item_row.fixture_version <> p_fixture_version
          or item_row.resource_id <> v_acquisition_id
          or item_row.content_hash <> v_expected_item_hash
        )
    ) then
      raise exception 'reviewer retro inventory conflict'
        using errcode = '23514';
    end if;

    insert into private.reviewer_fixture_items (
      id,
      user_id,
      fixture_version,
      item_kind,
      logical_key,
      resource_id,
      content_hash,
      created_at
    )
    select
      private.reviewer_fixture_uuid(
        p_user_id,
        'item:retro:' || p_fixture_version || ':' || v_template.spot_slug
      ),
      p_user_id,
      p_fixture_version,
      'retro_acquisition',
      v_template.spot_slug,
      v_acquisition_id,
      v_expected_item_hash,
      v_now
    where not exists (
      select 1
      from private.reviewer_fixture_items as item_row
      where item_row.user_id = p_user_id
        and item_row.item_kind = 'retro_acquisition'
        and item_row.logical_key = v_template.spot_slug
        and item_row.revoked_at is null
    );

    if v_template.sample_personal_card then
      v_sample_slug := v_template.spot_slug;
      v_sample_acquisition_id := v_acquisition_id;
    end if;
  end loop;

  if v_sample_slug is null or v_sample_acquisition_id is null then
    raise exception 'reviewer fixture sample template is missing'
      using errcode = '23514';
  end if;

  insert into private.policy_acceptances (
    id,
    user_id,
    policy_document_id,
    accepted_locale,
    accepted_sha256,
    accepted_at,
    acceptance_source
  ) values (
    v_terms_acceptance_id,
    p_user_id,
    v_terms_document_id,
    'en',
    v_terms_sha,
    v_now,
    'reviewer_fixture'
  ) on conflict (user_id, policy_document_id) do nothing;

  if not exists (
    select 1
    from private.policy_acceptances as acceptance_row
    where acceptance_row.id = v_terms_acceptance_id
      and acceptance_row.user_id = p_user_id
      and acceptance_row.policy_document_id = v_terms_document_id
      and acceptance_row.accepted_locale = 'en'
      and acceptance_row.accepted_sha256 = v_terms_sha
      and acceptance_row.acceptance_source = 'reviewer_fixture'
  ) then
    raise exception 'reviewer policy acceptance identity conflict'
      using errcode = '23514',
        constraint = 'reviewer_fixture_policy_acceptance_exact';
  end if;

  insert into private.policy_acceptances (
    id,
    user_id,
    policy_document_id,
    accepted_locale,
    accepted_sha256,
    accepted_at,
    acceptance_source
  ) values (
    v_community_acceptance_id,
    p_user_id,
    v_community_document_id,
    'en',
    v_community_sha,
    v_now,
    'reviewer_fixture'
  ) on conflict (user_id, policy_document_id) do nothing;

  if not exists (
    select 1
    from private.policy_acceptances as acceptance_row
    where acceptance_row.id = v_community_acceptance_id
      and acceptance_row.user_id = p_user_id
      and acceptance_row.policy_document_id = v_community_document_id
      and acceptance_row.accepted_locale = 'en'
      and acceptance_row.accepted_sha256 = v_community_sha
      and acceptance_row.acceptance_source = 'reviewer_fixture'
  ) then
    raise exception 'reviewer policy acceptance identity conflict'
      using errcode = '23514',
        constraint = 'reviewer_fixture_policy_acceptance_exact';
  end if;

  select personal_card_row.*
  into v_existing_card
  from private.reviewer_fixture_items as item_row
  join public.personal_cards as personal_card_row
    on personal_card_row.id = item_row.resource_id
  where item_row.user_id = p_user_id
    and item_row.item_kind = 'personal_card'
    and item_row.logical_key = 'approved-sample'
    and item_row.revoked_at is null
  for update of personal_card_row;

  if found then
    if v_existing_card.user_id <> p_user_id
      or v_existing_card.acquisition_id <> v_sample_acquisition_id
      or v_existing_card.photo_size_bytes <> p_photo_size_bytes
    then
      raise exception 'reviewer personal-card inventory conflict'
        using errcode = '23514';
    end if;
    v_personal_card_id := v_existing_card.id;
    v_previous_photo_path := v_existing_card.photo_path;
    v_previous_state := v_existing_card.share_state::text;
  else
    update private.reviewer_fixture_items as item_row
    set revoked_at = v_now
    where item_row.user_id = p_user_id
      and item_row.item_kind in ('personal_card', 'public_share')
      and item_row.revoked_at is null;
    v_personal_card_id := private.reviewer_fixture_uuid(
      p_user_id,
      'personal-card:' || p_client_action_id::text
    );
  end if;

  update private.reviewer_fixture_items as item_row
  set revoked_at = v_now
  where item_row.user_id = p_user_id
    and item_row.item_kind in ('personal_card', 'public_share')
    and item_row.revoked_at is null;

  v_photo_path := p_user_id::text || '/' || p_photo_object_id::text || '.webp';
  perform set_config(
    'danyeodam.personal_card_photo_size_bytes',
    p_photo_size_bytes::text,
    true
  );
  perform set_config('danyeodam.moderation_context', 'enabled', true);

  for v_try in 1..5 loop
    v_share_slug := private.reviewer_fixture_share_secret();
    begin
      if v_existing_card.id is null then
        insert into public.personal_cards (
          id,
          user_id,
          acquisition_id,
          photo_path,
          caption,
          share_slug,
          shared_at,
          share_state,
          share_submitted_at,
          share_terms_acceptance_id,
          share_community_acceptance_id,
          share_resubmission_required,
          share_reason_code,
          share_reviewed_at,
          share_reviewed_by,
          share_reviewed_by_redacted_at,
          photo_size_bytes,
          created_at,
          updated_at
        ) values (
          v_personal_card_id,
          p_user_id,
          v_sample_acquisition_id,
          v_photo_path,
          '',
          v_share_slug,
          v_now,
          'active',
          v_now,
          v_terms_acceptance_id,
          v_community_acceptance_id,
          false,
          null,
          v_now,
          p_admin_auth_user_id,
          null,
          p_photo_size_bytes,
          v_now,
          v_now
        );
      else
        update public.personal_cards
        set photo_path = v_photo_path,
            caption = '',
            share_slug = v_share_slug,
            shared_at = v_now,
            share_state = 'active',
            share_submitted_at = v_now,
            share_terms_acceptance_id = v_terms_acceptance_id,
            share_community_acceptance_id = v_community_acceptance_id,
            share_resubmission_required = false,
            share_reason_code = null,
            share_reviewed_at = v_now,
            share_reviewed_by = p_admin_auth_user_id,
            share_reviewed_by_redacted_at = null,
            updated_at = v_now
        where id = v_personal_card_id
          and user_id = p_user_id;
      end if;
      exit;
    exception
      when unique_violation then
        get stacked diagnostics v_constraint_name = constraint_name;
        if v_constraint_name <> 'personal_cards_share_slug_key' or v_try = 5 then
          raise;
        end if;
        v_share_slug := null;
    end;
  end loop;

  if v_share_slug is null then
    raise exception 'reviewer fixture share secret allocation failed'
      using errcode = '23505';
  end if;

  -- Close the replaced path inside the same owner-locked transaction. A
  -- Storage upload accepted before reset can otherwise commit its metadata
  -- after the server has removed the old object and recreate an orphan.
  if v_previous_photo_path is not null
    and v_previous_photo_path is distinct from v_photo_path
  then
    insert into private.personal_card_storage_object_tombstones (object_hash)
    values (
      private.personal_card_storage_object_hash(
        'personal-cards',
        v_previous_photo_path
      )
    )
    on conflict (object_hash) do nothing;
  end if;

  if v_existing_card.id is null then
    insert into analytics.events (
      user_id,
      event_name,
      source,
      occurred_at,
      personal_card_id,
      properties
    ) values (
      p_user_id,
      'personal_card_created',
      'server',
      v_now,
      v_personal_card_id,
      '{}'::jsonb
    );
  end if;

  insert into analytics.events (
    user_id,
    event_name,
    source,
    occurred_at,
    personal_card_id,
    properties
  ) values (
    p_user_id,
    'share_created',
    'server',
    v_now,
    v_personal_card_id,
    '{}'::jsonb
  );

  insert into private.moderation_actions (
    id,
    admin_auth_user_id,
    client_action_id,
    personal_card_id,
    owner_user_id,
    action,
    previous_state,
    resulting_state,
    reason_code,
    note,
    affected_count,
    created_at
  ) values (
    private.reviewer_fixture_uuid(
      p_user_id,
      'moderation-row:' || p_client_action_id::text
    ),
    p_admin_auth_user_id,
    private.reviewer_fixture_uuid(
      p_user_id,
      'moderation-action:' || p_client_action_id::text
    ),
    v_personal_card_id,
    p_user_id,
    'approve',
    v_previous_state,
    'active',
    'REVIEWER_FIXTURE_APPROVED',
    'Approved deterministic Store reviewer fixture',
    1,
    v_now
  );

  v_personal_hash := extensions.digest(
    'danyeodam:reviewer-personal:v1:' || p_fixture_version || ':'
      || v_sample_slug || ':' || lower(p_photo_sha256_hex),
    'sha256'
  );
  v_share_hash := extensions.digest(
    'danyeodam:reviewer-share:v1:' || p_fixture_version || ':active:'
      || v_terms_version || ':' || v_community_version,
    'sha256'
  );

  insert into private.reviewer_fixture_items (
    id,
    user_id,
    fixture_version,
    item_kind,
    logical_key,
    resource_id,
    content_hash,
    created_at
  ) values
  (
    private.reviewer_fixture_uuid(
      p_user_id,
      'item:personal:' || p_client_action_id::text
    ),
    p_user_id,
    p_fixture_version,
    'personal_card',
    'approved-sample',
    v_personal_card_id,
    v_personal_hash,
    v_now
  ),
  (
    private.reviewer_fixture_uuid(
      p_user_id,
      'item:share:' || p_client_action_id::text
    ),
    p_user_id,
    p_fixture_version,
    'public_share',
    'approved-sample',
    v_personal_card_id,
    v_share_hash,
    v_now
  );

  select
    count(*) filter (where item_row.item_kind = 'retro_acquisition')::integer,
    count(*) filter (where item_row.item_kind = 'personal_card')::integer,
    count(*) filter (where item_row.item_kind = 'public_share')::integer,
    encode(
      extensions.digest(
        string_agg(
          item_row.item_kind || ':' || item_row.logical_key || ':'
            || encode(item_row.content_hash, 'hex'),
          E'\n' order by item_row.item_kind, item_row.logical_key
        ),
        'sha256'
      ),
      'hex'
    )
  into v_retro_count, v_personal_count, v_share_count, v_fixture_hash
  from private.reviewer_fixture_items as item_row
  where item_row.user_id = p_user_id
    and item_row.fixture_version = p_fixture_version
    and item_row.revoked_at is null;

  if v_retro_count <> 6 or v_personal_count <> 1 or v_share_count <> 1 then
    raise exception 'reviewer fixture inventory cardinality mismatch'
      using errcode = '23514';
  end if;

  return jsonb_build_object(
    'status', 'applied',
    'store_platform', (
      select reviewer_row.store_platform
      from private.reviewer_accounts as reviewer_row
      where reviewer_row.user_id = p_user_id
    ),
    'fixture_version', p_fixture_version,
    'retro_count', v_retro_count,
    'personal_card_count', v_personal_count,
    'active_share_count', v_share_count,
    'fixture_hash', v_fixture_hash,
    'photo_object_id', p_photo_object_id,
    'photo_sha256', lower(p_photo_sha256_hex),
    'photo_size_bytes', p_photo_size_bytes,
    'previous_photo_object_id', case
      when v_previous_photo_path is null then null
      else split_part(split_part(v_previous_photo_path, '/', 2), '.', 1)::uuid
    end
  );
end;
$$;

revoke all on function private.apply_reviewer_fixture(
  uuid, uuid, text, uuid, uuid, bigint, text
) from public, anon, authenticated, service_role;

create or replace function private.prepare_reviewer_fixture_lifecycle(
  p_admin_auth_user_id uuid,
  p_user_id uuid,
  p_store_platform text,
  p_fixture_version text,
  p_client_action_id uuid,
  p_action text,
  p_photo_size_bytes bigint,
  p_photo_sha256_hex text,
  p_rate_already_checked boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rate jsonb;
  v_admin_fingerprint bytea;
  v_target_fingerprint bytea;
  v_payload_hash bytea;
  v_existing private.reviewer_access_actions%rowtype;
  v_reviewer private.reviewer_accounts%rowtype;
  v_photo_object_id uuid;
  v_old_photo_object_ids jsonb;
  v_response jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if p_action not in ('provision', 'reset')
    or p_user_id is null
    or p_client_action_id is null
    or p_store_platform not in ('app_store', 'play_store')
    or p_fixture_version is null
    or char_length(p_fixture_version) not between 1 and 64
    or p_fixture_version !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    or p_photo_size_bytes is null
    or p_photo_size_bytes not between 1 and 5242880
    or p_photo_sha256_hex is null
    or p_photo_sha256_hex !~ '^[0-9A-Fa-f]{64}$'
    or p_rate_already_checked is null
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  if not p_rate_already_checked then
    v_rate := private.consume_authenticated_api_rate_limit(
      p_admin_auth_user_id,
      'admin_mutation'
    );
    if v_rate ->> 'status' <> 'allowed' then
      return v_rate;
    end if;
  end if;

  v_admin_fingerprint := private.reviewer_lifecycle_admin_fingerprint(
    p_admin_auth_user_id
  );
  v_target_fingerprint := private.reviewer_lifecycle_target_fingerprint(
    p_user_id
  );
  v_payload_hash := extensions.digest(
    'danyeodam:reviewer-lifecycle-payload:v1:' || p_action || ':'
      || p_user_id::text || ':' || p_store_platform || ':'
      || p_fixture_version || ':' || p_photo_size_bytes::text || ':'
      || lower(p_photo_sha256_hex),
    'sha256'
  );

  perform pg_advisory_xact_lock(
    hashtextextended('danyeodam:recovery:target:' || p_user_id::text, 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('danyeodam:reviewer-lifecycle:' || p_user_id::text, 0)
  );

  select action_row.*
  into v_existing
  from private.reviewer_access_actions as action_row
  where action_row.admin_fingerprint = v_admin_fingerprint
    and action_row.client_action_id = p_client_action_id
  for update;

  if found then
    if v_existing.action = p_action
      and v_existing.target_fingerprint = v_target_fingerprint
      and v_existing.payload_hash = v_payload_hash
    then
      -- A completed action remains an idempotent historical response. A
      -- prepared action, however, must never instruct the server to upload an
      -- object after a later revoke closed the reservation/membership.
      if v_existing.completed_result_json is null and (
        not exists (
          select 1
          from private.reviewer_accounts as reviewer_row
          join private.user_identities as identity_row
            on identity_row.user_id = reviewer_row.user_id
           and identity_row.revoked_at is null
          join auth.users as auth_user
            on auth_user.id = identity_row.auth_user_id
           and auth_user.deleted_at is null
          where reviewer_row.user_id = p_user_id
            and reviewer_row.revoked_at is null
            and reviewer_row.store_platform = p_store_platform
            and reviewer_row.fixture_version = p_fixture_version
        )
        or (
          p_action = 'reset'
          and not exists (
            select 1
            from private.participant_access as access_row
            where access_row.user_id = p_user_id
              and access_row.access_kind = 'store_reviewer'
              and access_row.revoked_at is null
              and (
                access_row.expires_at is null
                or access_row.expires_at > statement_timestamp()
              )
          )
        )
      ) then
        return jsonb_build_object('status', 'not_found');
      end if;
      return coalesce(
        v_existing.completed_result_json,
        v_existing.result_json || jsonb_build_object('status', 'prepared')
      );
    end if;
    return jsonb_build_object('status', 'idempotency_conflict');
  end if;

  if exists (
    select 1
    from private.reviewer_access_actions as action_row
    where action_row.target_fingerprint = v_target_fingerprint
      and action_row.action in ('provision', 'reset')
      and action_row.completed_result_json is null
  ) then
    return jsonb_build_object('status', 'fixture_conflict');
  end if;

  -- Lifecycle owns this exact target before the credential/identity row-lock
  -- phase. The active reviewer guard is then the fail-closed protection
  -- against an identity mutation that started first.
  perform 1
  from private.user_identities as identity_row
  join auth.users as auth_user
    on auth_user.id = identity_row.auth_user_id
  where identity_row.user_id = p_user_id
    and identity_row.revoked_at is null
    and auth_user.deleted_at is null
  for update of identity_row, auth_user;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  perform 1
  from public.app_users as app_user_row
  where app_user_row.id = p_user_id
    and app_user_row.deletion_requested_at is null
  for share of app_user_row;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if not private.reviewer_auth_credential_is_valid(p_user_id) then
    return jsonb_build_object('status', 'credential_invalid');
  end if;

  -- Fail before the out-of-transaction object upload when release content or
  -- required policies are not ready. Completion repeats the locked checks so
  -- a later content change can never install a partial fixture.
  perform pg_advisory_xact_lock_shared(
    hashtextextended('danyeodam:policy-current-set', 0)
  );
  if (
    select count(*)
    from private.reviewer_fixture_templates as template_row
    join public.spots as spot_row
      on spot_row.slug = template_row.spot_slug
     and spot_row.status = 'open'
    join public.cards as card_row
      on card_row.spot_id = spot_row.id
     and card_row.kind = 'region'
     and card_row.is_published
     and card_row.sketch_path is not null
    where (
      select count(*) from public.region_translations as translation_row
      where translation_row.region_code = spot_row.region
        and translation_row.status = 'approved'
    ) = 6
      and (
        select count(*) from public.spot_translations as translation_row
        where translation_row.spot_id = spot_row.id
          and translation_row.status = 'approved'
      ) = 6
      and (
        select count(*) from public.card_translations as translation_row
        where translation_row.card_id = card_row.id
          and translation_row.status = 'approved'
      ) = 6
  ) <> 6 or (
    select count(*)
    from private.policy_documents as document_row
    where document_row.policy_type in (
        'terms_of_use'::private.policy_type,
        'community_guidelines'::private.policy_type
      )
      and document_row.is_current
      and document_row.effective_at <= statement_timestamp()
      and private.policy_document_is_complete(document_row.id)
  ) <> 2 then
    return jsonb_build_object('status', 'fixture_conflict');
  end if;

  select reviewer_row.*
  into v_reviewer
  from private.reviewer_accounts as reviewer_row
  where reviewer_row.user_id = p_user_id
  for update;

  if p_action = 'provision' then
    if found then
      return jsonb_build_object('status', 'fixture_conflict');
    end if;
    -- Only an Admin-created credential that has never produced a session may
    -- become a reviewer. Keep this check provision-only: a designated
    -- reviewer must be able to sign in before a later reset.
    if not exists (
      select 1
      from private.user_identities as identity_row
      join auth.users as auth_user
        on auth_user.id = identity_row.auth_user_id
      where identity_row.user_id = p_user_id
        and identity_row.revoked_at is null
        and auth_user.last_sign_in_at is null
    ) then
      return jsonb_build_object('status', 'fixture_conflict');
    end if;
    if not private.reviewer_target_is_pristine(p_user_id) then
      return jsonb_build_object('status', 'fixture_conflict');
    end if;
    -- Reserve immutable reviewer history and freeze the exact Auth credential
    -- before the out-of-transaction Storage upload. Access is still closed:
    -- participant_access is installed only with the complete fixture below.
    insert into private.reviewer_accounts (
      user_id,
      store_platform,
      fixture_version,
      granted_at,
      granted_by_auth_user_id
    ) values (
      p_user_id,
      p_store_platform,
      p_fixture_version,
      v_now,
      p_admin_auth_user_id
    );
  else
    if not found
      or v_reviewer.revoked_at is not null
      or v_reviewer.store_platform <> p_store_platform
      or v_reviewer.fixture_version <> p_fixture_version
    then
      return jsonb_build_object('status', 'not_found');
    end if;
    if not exists (
      select 1
      from private.participant_access as access_row
      where access_row.user_id = p_user_id
        and access_row.access_kind = 'store_reviewer'
        and access_row.revoked_at is null
        and (
          access_row.expires_at is null
          or access_row.expires_at > statement_timestamp()
        )
    ) then
      return jsonb_build_object('status', 'not_found');
    end if;
  end if;

  -- Shared policy -> owner ordering matches every personal-card writer.
  perform pg_advisory_xact_lock_shared(
    hashtextextended('danyeodam:policy-current-set', 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('danyeodam:suspend-owner:' || p_user_id::text, 0)
  );

  select coalesce(
    jsonb_agg(
      split_part(split_part(card_row.photo_path, '/', 2), '.', 1)::uuid
      order by card_row.photo_path
    ),
    '[]'::jsonb
  )
  into v_old_photo_object_ids
  from private.reviewer_fixture_items as item_row
  join public.personal_cards as card_row
    on card_row.id = item_row.resource_id
  where item_row.user_id = p_user_id
    and item_row.item_kind = 'personal_card'
    and item_row.revoked_at is null;

  v_photo_object_id := private.reviewer_fixture_uuid(
    p_user_id,
    'photo:' || p_client_action_id::text
  );
  v_response := jsonb_build_object(
    'status', 'prepared',
    'action', p_action,
    'store_platform', p_store_platform,
    'fixture_version', p_fixture_version,
    'photo_object_id', v_photo_object_id,
    'photo_size_bytes', p_photo_size_bytes,
    'photo_sha256', lower(p_photo_sha256_hex),
    'old_photo_object_ids', v_old_photo_object_ids
  );

  insert into private.reviewer_access_actions (
    admin_fingerprint,
    target_fingerprint,
    client_action_id,
    action,
    payload_hash,
    result_json,
    created_at
  ) values (
    v_admin_fingerprint,
    v_target_fingerprint,
    p_client_action_id,
    p_action,
    v_payload_hash,
    v_response - 'status',
    v_now
  );

  return v_response;
end;
$$;

create or replace function api_private.provision_reviewer_access(
  p_admin_auth_user_id uuid,
  p_user_id uuid,
  p_store_platform text,
  p_fixture_version text,
  p_client_action_id uuid,
  p_photo_size_bytes bigint,
  p_photo_sha256_hex text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.prepare_reviewer_fixture_lifecycle(
    p_admin_auth_user_id,
    p_user_id,
    p_store_platform,
    p_fixture_version,
    p_client_action_id,
    'provision',
    p_photo_size_bytes,
    p_photo_sha256_hex,
    false
  )
$$;

create or replace function api_private.reset_reviewer_access(
  p_admin_auth_user_id uuid,
  p_user_id uuid,
  p_client_action_id uuid,
  p_photo_size_bytes bigint,
  p_photo_sha256_hex text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rate jsonb;
  v_reviewer private.reviewer_accounts%rowtype;
begin
  v_rate := private.consume_authenticated_api_rate_limit(
    p_admin_auth_user_id,
    'admin_mutation'
  );
  if v_rate ->> 'status' <> 'allowed' then
    return v_rate;
  end if;

  select reviewer_row.*
  into v_reviewer
  from private.reviewer_accounts as reviewer_row
  where reviewer_row.user_id = p_user_id
    and reviewer_row.revoked_at is null;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  return private.prepare_reviewer_fixture_lifecycle(
    p_admin_auth_user_id,
    p_user_id,
    v_reviewer.store_platform,
    v_reviewer.fixture_version,
    p_client_action_id,
    'reset',
    p_photo_size_bytes,
    p_photo_sha256_hex,
    true
  );
end;
$$;

create or replace function api_private.complete_reviewer_access_fixture(
  p_admin_auth_user_id uuid,
  p_user_id uuid,
  p_client_action_id uuid,
  p_photo_object_id uuid,
  p_photo_size_bytes bigint,
  p_photo_sha256_hex text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin_fingerprint bytea;
  v_target_fingerprint bytea;
  v_action private.reviewer_access_actions%rowtype;
  v_reviewer private.reviewer_accounts%rowtype;
  v_result jsonb;
  v_constraint_name text;
  v_now timestamptz := clock_timestamp();
begin
  if p_admin_auth_user_id is null
    or p_user_id is null
    or p_client_action_id is null
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  v_admin_fingerprint := private.reviewer_lifecycle_admin_fingerprint(
    p_admin_auth_user_id
  );
  v_target_fingerprint := private.reviewer_lifecycle_target_fingerprint(
    p_user_id
  );

  perform pg_advisory_xact_lock(
    hashtextextended('danyeodam:recovery:target:' || p_user_id::text, 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('danyeodam:reviewer-lifecycle:' || p_user_id::text, 0)
  );

  perform 1
  from private.user_identities as identity_row
  join auth.users as auth_user
    on auth_user.id = identity_row.auth_user_id
  where identity_row.user_id = p_user_id
    and identity_row.revoked_at is null
    and auth_user.deleted_at is null
  for update of identity_row, auth_user;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select action_row.*
  into v_action
  from private.reviewer_access_actions as action_row
  where action_row.admin_fingerprint = v_admin_fingerprint
    and action_row.client_action_id = p_client_action_id
    and action_row.target_fingerprint = v_target_fingerprint
    and action_row.action in ('provision', 'reset')
  for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Prepare is the single counted admin API attempt. Completion is an
  -- internal continuation bound to that exact admin fingerprint/action; it
  -- must not consume a second rate slot, but a revoked or deleted admin still
  -- cannot finish the prepared mutation.
  if not private.lock_reviewer_continuation_admin(p_admin_auth_user_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;

  if v_action.completed_result_json is not null then
    return v_action.completed_result_json;
  end if;

  if v_action.result_json ->> 'photo_object_id' is distinct from p_photo_object_id::text
    or v_action.result_json ->> 'photo_sha256' is distinct from lower(p_photo_sha256_hex)
    or (v_action.result_json ->> 'photo_size_bytes')::bigint
      is distinct from p_photo_size_bytes
  then
    return jsonb_build_object('status', 'idempotency_conflict');
  end if;

  if not private.reviewer_auth_credential_is_valid(p_user_id) then
    return jsonb_build_object('status', 'credential_invalid');
  end if;

  select reviewer_row.*
  into v_reviewer
  from private.reviewer_accounts as reviewer_row
  where reviewer_row.user_id = p_user_id
  for update;

  if v_action.action = 'provision' then
    if not found
      or v_reviewer.revoked_at is not null
      or v_reviewer.store_platform <> v_action.result_json ->> 'store_platform'
      or v_reviewer.fixture_version <> v_action.result_json ->> 'fixture_version'
    then
      return jsonb_build_object('status', 'not_found');
    end if;

  elsif not found
    or v_reviewer.revoked_at is not null
    or v_reviewer.store_platform <> v_action.result_json ->> 'store_platform'
    or v_reviewer.fixture_version <> v_action.result_json ->> 'fixture_version'
    or not exists (
      select 1
      from private.participant_access as access_row
      where access_row.user_id = p_user_id
        and access_row.access_kind = 'store_reviewer'
        and access_row.revoked_at is null
        and (
          access_row.expires_at is null
          or access_row.expires_at > statement_timestamp()
        )
    )
  then
    return jsonb_build_object('status', 'not_found');
  end if;

  perform pg_advisory_xact_lock_shared(
    hashtextextended('danyeodam:policy-current-set', 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('danyeodam:suspend-owner:' || p_user_id::text, 0)
  );

  if v_action.action = 'provision' then
    -- Prepare reserves only reviewer lifecycle rows. Recheck the complete
    -- product-data universe under target, policy, and owner locks immediately
    -- before opening participant access.
    if not private.reviewer_target_is_pristine(p_user_id, true) then
      return jsonb_build_object('status', 'fixture_conflict');
    end if;
  end if;

  begin
    if v_action.action = 'provision' then
      insert into private.participant_access (
        user_id,
        access_kind,
        granted_at,
        granted_by_auth_user_id,
        expires_at,
        revoked_at
      ) values (
        p_user_id,
        'store_reviewer',
        v_now,
        p_admin_auth_user_id,
        null,
        null
      );
    end if;

    v_result := private.apply_reviewer_fixture(
      p_admin_auth_user_id,
      p_user_id,
      v_action.result_json ->> 'fixture_version',
      p_client_action_id,
      p_photo_object_id,
      p_photo_size_bytes,
      p_photo_sha256_hex
    );
  exception
    when check_violation then
      get stacked diagnostics v_constraint_name = constraint_name;
      if v_constraint_name = 'reviewer_fixture_policy_acceptance_exact' then
        return jsonb_build_object('status', 'fixture_conflict');
      end if;
      raise;
  end;

  update private.reviewer_access_actions
  set completed_result_json = v_result
  where id = v_action.id;

  return v_result;
end;
$$;

revoke all on function private.prepare_reviewer_fixture_lifecycle(
  uuid, uuid, text, text, uuid, text, bigint, text, boolean
) from public, anon, authenticated, service_role;
revoke all on function api_private.provision_reviewer_access(
  uuid, uuid, text, text, uuid, bigint, text
) from public, anon, authenticated, service_role;
revoke all on function api_private.reset_reviewer_access(
  uuid, uuid, uuid, bigint, text
) from public, anon, authenticated, service_role;
revoke all on function api_private.complete_reviewer_access_fixture(
  uuid, uuid, uuid, uuid, bigint, text
) from public, anon, authenticated;

grant execute on function api_private.provision_reviewer_access(
  uuid, uuid, text, text, uuid, bigint, text
) to service_role;
grant execute on function api_private.reset_reviewer_access(
  uuid, uuid, uuid, bigint, text
) to service_role;
grant execute on function api_private.complete_reviewer_access_fixture(
  uuid, uuid, uuid, uuid, bigint, text
) to service_role;

-- The original one-argument revocation is an internal primitive after the
-- audited lifecycle exists. Remove its Data API entry point so callers cannot
-- bypass admin membership, rate limiting, idempotency audit, fixture inventory
-- revocation, or exact-path tombstones.
alter function api_private.revoke_reviewer_access(uuid)
  rename to revoke_reviewer_access_before_fixture_lifecycle;

revoke all on function api_private.revoke_reviewer_access_before_fixture_lifecycle(
  uuid
) from public, anon, authenticated, service_role;

create or replace function api_private.revoke_reviewer_access(
  p_admin_auth_user_id uuid,
  p_user_id uuid,
  p_client_action_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rate jsonb;
  v_admin_fingerprint bytea;
  v_target_fingerprint bytea;
  v_payload_hash bytea;
  v_existing private.reviewer_access_actions%rowtype;
  v_old_photo_object_ids jsonb;
  v_result jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if p_admin_auth_user_id is null
    or p_user_id is null
    or p_client_action_id is null
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  v_rate := private.consume_authenticated_api_rate_limit(
    p_admin_auth_user_id,
    'admin_mutation'
  );
  if v_rate ->> 'status' <> 'allowed' then
    return v_rate;
  end if;

  v_admin_fingerprint := private.reviewer_lifecycle_admin_fingerprint(
    p_admin_auth_user_id
  );
  v_target_fingerprint := private.reviewer_lifecycle_target_fingerprint(
    p_user_id
  );
  v_payload_hash := extensions.digest(
    'danyeodam:reviewer-lifecycle-payload:v1:revoke:' || p_user_id::text,
    'sha256'
  );

  perform pg_advisory_xact_lock(
    hashtextextended('danyeodam:recovery:target:' || p_user_id::text, 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('danyeodam:reviewer-lifecycle:' || p_user_id::text, 0)
  );

  select action_row.*
  into v_existing
  from private.reviewer_access_actions as action_row
  where action_row.admin_fingerprint = v_admin_fingerprint
    and action_row.client_action_id = p_client_action_id
  for update;
  if found then
    if v_existing.action = 'revoke'
      and v_existing.target_fingerprint = v_target_fingerprint
      and v_existing.payload_hash = v_payload_hash
    then
      return v_existing.result_json;
    end if;
    return jsonb_build_object('status', 'idempotency_conflict');
  end if;

  perform 1
  from private.user_identities as identity_row
  join auth.users as auth_user
    on auth_user.id = identity_row.auth_user_id
  where identity_row.user_id = p_user_id
    and identity_row.revoked_at is null
    and auth_user.deleted_at is null
  for update of identity_row, auth_user;

  -- Take the shared policy lock before the owner lock, matching every
  -- personal-card writer. The historical revoke primitive runs under both.
  perform pg_advisory_xact_lock_shared(
    hashtextextended('danyeodam:policy-current-set', 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('danyeodam:suspend-owner:' || p_user_id::text, 0)
  );

  -- Revoke is the final cleanup boundary. Include the active photo and every
  -- opaque lifecycle object recorded for this target, including a prepared
  -- upload that lost the race with revoke or an older cleanup response.
  select coalesce(
    jsonb_agg(
      object_row.photo_object_id order by object_row.photo_object_id
    ),
    '[]'::jsonb
  )
  into v_old_photo_object_ids
  from (
    select distinct candidate_row.photo_object_id
    from (
      select split_part(split_part(card_row.photo_path, '/', 2), '.', 1)::uuid
        as photo_object_id
      from private.reviewer_fixture_items as item_row
      join public.personal_cards as card_row
        on card_row.id = item_row.resource_id
      where item_row.user_id = p_user_id
        and item_row.item_kind = 'personal_card'
        and item_row.revoked_at is null

      union all

      select nullif(action_row.result_json ->> 'photo_object_id', '')::uuid
      from private.reviewer_access_actions as action_row
      where action_row.target_fingerprint = v_target_fingerprint

      union all

      select nullif(action_row.completed_result_json ->> 'photo_object_id', '')::uuid
      from private.reviewer_access_actions as action_row
      where action_row.target_fingerprint = v_target_fingerprint

      union all

      select nullif(
        action_row.completed_result_json ->> 'previous_photo_object_id',
        ''
      )::uuid
      from private.reviewer_access_actions as action_row
      where action_row.target_fingerprint = v_target_fingerprint
    ) as candidate_row
    where candidate_row.photo_object_id is not null
  ) as object_row;

  -- Close every exact reviewer photo path in the same transaction that closes
  -- DB access. An upload body may have been accepted before revoke and commit
  -- Storage metadata only after an external remove already observed no object.
  -- The existing storage.objects BEFORE trigger rejects that late commit from
  -- this digest-only permanent tombstone, even if the originating Node process
  -- crashes before it can run its NOT_FOUND compensation delete.
  insert into private.personal_card_storage_object_tombstones (object_hash)
  select private.personal_card_storage_object_hash(
    'personal-cards',
    p_user_id::text || '/' || object_id.value || '.webp'
  )
  from jsonb_array_elements_text(v_old_photo_object_ids) as object_id(value)
  on conflict (object_hash) do nothing;

  v_result := api_private.revoke_reviewer_access_before_fixture_lifecycle(
    p_user_id
  );
  if v_result ->> 'status' <> 'revoked' then
    return v_result;
  end if;

  update private.reviewer_fixture_items as item_row
  set revoked_at = v_now
  where item_row.user_id = p_user_id
    and item_row.revoked_at is null;

  v_result := v_result || jsonb_build_object(
    'old_photo_object_ids', v_old_photo_object_ids
  );
  insert into private.reviewer_access_actions (
    admin_fingerprint,
    target_fingerprint,
    client_action_id,
    action,
    payload_hash,
    result_json,
    created_at
  ) values (
    v_admin_fingerprint,
    v_target_fingerprint,
    p_client_action_id,
    'revoke',
    v_payload_hash,
    v_result,
    v_now
  );

  return v_result;
end;
$$;

revoke all on function api_private.revoke_reviewer_access(
  uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function api_private.revoke_reviewer_access(
  uuid, uuid, uuid
) to service_role;

create or replace function private.reject_reviewer_fixture_item_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    -- Full logical-account deletion is the only supported inventory removal.
    -- The cascading FK action runs after the parent app_users row disappears.
    if not exists (
      select 1
      from public.app_users as app_user_row
      where app_user_row.id = old.user_id
    ) then
      return old;
    end if;
    raise exception 'reviewer fixture inventory is append-only'
      using errcode = '23514';
  end if;
  if new.id is distinct from old.id
    or new.user_id is distinct from old.user_id
    or new.fixture_version is distinct from old.fixture_version
    or new.item_kind is distinct from old.item_kind
    or new.logical_key is distinct from old.logical_key
    or new.resource_id is distinct from old.resource_id
    or new.content_hash is distinct from old.content_hash
    or new.created_at is distinct from old.created_at
    or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at)
    or (old.revoked_at is null and new.revoked_at is null)
  then
    raise exception 'reviewer fixture inventory is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function private.reject_reviewer_access_action_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'reviewer lifecycle actions are append-only'
      using errcode = '23514';
  end if;
  -- A prepare row may be completed exactly once. Identity, payload, and the
  -- prepared photo binding are immutable; only result_json may transition
  -- from prepared to applied.
  if new.id is distinct from old.id
    or new.admin_fingerprint is distinct from old.admin_fingerprint
    or new.target_fingerprint is distinct from old.target_fingerprint
    or new.client_action_id is distinct from old.client_action_id
    or new.action is distinct from old.action
    or new.payload_hash is distinct from old.payload_hash
    or new.created_at is distinct from old.created_at
    or old.action = 'revoke'
    or new.result_json is distinct from old.result_json
    or old.completed_result_json is not null
    or new.completed_result_json ->> 'status' <> 'applied'
  then
    raise exception 'reviewer lifecycle action is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.reject_reviewer_fixture_item_mutation(),
  private.reject_reviewer_access_action_mutation()
  from public, anon, authenticated, service_role;

create trigger reviewer_fixture_items_immutable
before update or delete on private.reviewer_fixture_items
for each row execute function private.reject_reviewer_fixture_item_mutation();

create trigger reviewer_access_actions_immutable
before update or delete on private.reviewer_access_actions
for each row execute function private.reject_reviewer_access_action_mutation();

-- Account deletion can start after Storage accepted a prepared lifecycle
-- object but before the HTTP request completed. Capture every opaque object
-- binding from the append-only action ledger as soon as the deletion job is
-- inserted, so the existing two-pass account worker owns that orphan too.
create or replace function private.capture_reviewer_fixture_deletion_objects()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.user_id is null then return new; end if;

  insert into private.account_deletion_storage_manifest (
    request_id,
    bucket,
    object_path,
    final_delete_after
  )
  select
    new.id,
    'personal-cards',
    new.user_id::text || '/' || object_row.photo_object_id || '.webp',
    new.requested_at + interval '10 minutes'
  from (
    select distinct candidate_row.photo_object_id
    from (
      select action_row.result_json ->> 'photo_object_id' as photo_object_id
      from private.reviewer_access_actions as action_row
      where action_row.target_fingerprint
        = private.reviewer_lifecycle_target_fingerprint(new.user_id)

      union all

      select action_row.completed_result_json ->> 'photo_object_id'
      from private.reviewer_access_actions as action_row
      where action_row.target_fingerprint
        = private.reviewer_lifecycle_target_fingerprint(new.user_id)

      union all

      select action_row.completed_result_json ->> 'previous_photo_object_id'
      from private.reviewer_access_actions as action_row
      where action_row.target_fingerprint
        = private.reviewer_lifecycle_target_fingerprint(new.user_id)
    ) as candidate_row
    where candidate_row.photo_object_id
      ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) as object_row
  on conflict (request_id, bucket, object_path) do update
  set final_delete_after = greatest(
    private.account_deletion_storage_manifest.final_delete_after,
    excluded.final_delete_after
  );

  return new;
end;
$$;

revoke all on function private.capture_reviewer_fixture_deletion_objects()
  from public, anon, authenticated, service_role;

create trigger account_deletion_capture_reviewer_fixture_objects
after insert on private.account_deletion_jobs
for each row execute function private.capture_reviewer_fixture_deletion_objects();

commit;
