-- DANYEODAM API-CONTRACT v0.4.0 account and complete-data deletion.
--
-- A request atomically revokes every product capability and public share.
-- Storage and Auth are external systems, so a bounded, lease-owned worker
-- performs two Storage deletion passes before product rows and Auth users are
-- hard-deleted. The worker never gives up: failures remain retryable and are
-- exposed only as aggregate operational backlog.

begin;

-- MANDATORY CUTOVER PRECONDITION: stop every application/admin ingress and
-- every scheduled/maintenance writer, then verify that no other client
-- transaction is active before this migration starts. Historical location
-- bodies contain irreconcilable cross-table orders (the retention purge can
-- reach correction -> jobs, while erasure completion reaches jobs ->
-- correction), so no ordering of these table locks can make this an online
-- writer-compatible migration. Keep writers stopped until commit.
--
-- After that externally verified quiescence, drain and hold the source tables
-- whose DELETEs create retained audit redactions and whose rows feed Storage
-- backfills. The locks are a fail-closed final boundary against an accidental
-- writer restart; they are not a zero-downtime substitute for the cutover
-- precondition above.
lock table auth.users in share row exclusive mode;
-- Every correction/withdrawal snapshot and every erasure finisher writes or
-- row-locks its data_erasure_jobs row before reaching any Storage manifest,
-- temp upload, field ledger, or card mutation. Drain that common gate first.
-- This is required because the two historical bodies otherwise disagree:
-- snapshot is manifest -> cards, while finish is cards -> manifest.
-- EXCLUSIVE (not SHARE ROW EXCLUSIVE) is intentional: SELECT FOR UPDATE takes
-- ROW SHARE, and a finisher must be stopped at that point before card deletes.
lock table private.data_erasure_jobs in exclusive mode;
-- Auth INSERT owns auth.users before its provisioning trigger writes
-- app_users, while recovery deletes an erasure job before app_users. The two
-- source gates above therefore precede this parent-table DML drain. Keep only
-- SHARE ROW EXCLUSIVE here: it blocks new app_users DML but remains compatible
-- with the ROW SHARE/KEY SHARE needed by an already-running FK child writer.
lock table public.app_users in share row exclusive mode;
-- Historical completion owns a temporary-upload row before it inserts the
-- personal card. Drain in that same order so the migration cannot hold the
-- card table while waiting on a writer that is itself waiting on the card
-- table. The compatibility trigger installed below closes the final
-- already-parsed begin-function window.
lock table private.personal_card_temp_uploads in share row exclusive mode;
lock table private.personal_card_field_object_ledger in share row exclusive mode;
lock table private.data_erasure_manifest in share row exclusive mode;
lock table public.personal_cards in share row exclusive mode;
lock table storage.objects in share row exclusive mode;

-- -------------------------------------------------------------------------
-- Durable audit redaction
-- -------------------------------------------------------------------------

-- Auth users may have approved content owned by other users. Preserve the
-- business audit fact without retaining a deleted Auth UUID.
alter table private.retro_grants
  alter column admin_auth_user_id drop not null,
  add column admin_redacted_at timestamptz,
  add constraint retro_grants_admin_audit_identity check (
    num_nonnulls(admin_auth_user_id, admin_redacted_at) = 1
  );

alter table public.region_translations
  add column approved_by_redacted_at timestamptz,
  drop constraint region_translations_approval_audit,
  add constraint region_translations_approval_audit check (
    (
      status = 'draft'
      and approved_at is null
      and approved_by is null
      and approved_by_redacted_at is null
    )
    or (
      status = 'approved'
      and approved_at is not null
      and num_nonnulls(approved_by, approved_by_redacted_at) = 1
      and (
        approved_by_redacted_at is null
        or approved_by_redacted_at >= approved_at
      )
    )
  );

alter table public.spot_translations
  add column approved_by_redacted_at timestamptz,
  drop constraint spot_translations_approval_audit,
  add constraint spot_translations_approval_audit check (
    (
      status = 'draft'
      and approved_at is null
      and approved_by is null
      and approved_by_redacted_at is null
    )
    or (
      status = 'approved'
      and approved_at is not null
      and num_nonnulls(approved_by, approved_by_redacted_at) = 1
      and (
        approved_by_redacted_at is null
        or approved_by_redacted_at >= approved_at
      )
    )
  );

alter table public.card_translations
  add column approved_by_redacted_at timestamptz,
  drop constraint card_translations_approval_audit,
  add constraint card_translations_approval_audit check (
    (
      status = 'draft'
      and approved_at is null
      and approved_by is null
      and approved_by_redacted_at is null
    )
    or (
      status = 'approved'
      and approved_at is not null
      and num_nonnulls(approved_by, approved_by_redacted_at) = 1
      and (
        approved_by_redacted_at is null
        or approved_by_redacted_at >= approved_at
      )
    )
  );

-- A redeemed invitation must stay distinguishable from an unused code after
-- its logical user is deleted.
alter table private.participant_invite_codes
  add column redeemed_by_redacted_at timestamptz,
  drop constraint participant_invite_codes_redeem_state,
  add constraint participant_invite_codes_redeem_state check (
    (
      redeemed_at is null
      and redeemed_by_user_id is null
      and redeemed_by_redacted_at is null
    )
    or (
      redeemed_at is not null
      and num_nonnulls(redeemed_by_user_id, redeemed_by_redacted_at) = 1
      and (
        redeemed_by_redacted_at is null
        or redeemed_by_redacted_at >= redeemed_at
      )
    )
  );

alter table private.location_correction_requests
  add column resolved_by_redacted_at timestamptz,
  drop constraint location_corrections_resolution_consistent,
  add constraint location_corrections_resolution_consistent check (
    (
      status = 'open'
      and resolved_at is null
      and resolved_by_auth_user_id is null
      and resolved_by_redacted_at is null
    )
    or (
      status = 'approved_pending_correction'
      and resolved_at is null
      and num_nonnulls(
        resolved_by_auth_user_id,
        resolved_by_redacted_at
      ) = 1
    )
    or (
      status in ('corrected', 'rejected')
      and resolved_at is not null
      and resolved_at >= requested_at
      and num_nonnulls(
        resolved_by_auth_user_id,
        resolved_by_redacted_at
      ) = 1
      and (
        resolved_by_redacted_at is null
        or resolved_by_redacted_at >= resolved_at
      )
    )
  );

alter table private.share_owner_suspensions
  alter column suspended_by_auth_user_id drop not null,
  add column suspended_by_redacted_at timestamptz,
  add column lifted_by_redacted_at timestamptz,
  drop constraint share_owner_suspensions_lift_consistent,
  add constraint share_owner_suspensions_actor_consistent check (
    num_nonnulls(
      suspended_by_auth_user_id,
      suspended_by_redacted_at
    ) = 1
  ),
  add constraint share_owner_suspensions_lift_consistent check (
    (
      lifted_at is null
      and lifted_by_auth_user_id is null
      and lifted_by_redacted_at is null
    )
    or (
      lifted_at is not null
      and lifted_at >= suspended_at
      and num_nonnulls(
        lifted_by_auth_user_id,
        lifted_by_redacted_at
      ) = 1
      and (
        lifted_by_redacted_at is null
        or lifted_by_redacted_at >= lifted_at
      )
    )
  );

alter table private.content_reports
  alter column share_secret_hash drop not null,
  add column share_secret_redacted_at timestamptz,
  add column personal_card_redacted_at timestamptz,
  add column owner_redacted_at timestamptz,
  add column resolved_by_redacted_at timestamptz,
  drop constraint content_reports_resolution_consistent;

-- ON DELETE SET NULL may have removed an older report's card or owner before
-- this migration. Backfill those historical absences before validating the
-- new exactly-one audit constraints so an in-place upgrade is safe.
update private.content_reports
set personal_card_redacted_at = created_at,
    share_secret_hash = null,
    share_secret_redacted_at = created_at
where personal_card_id is null;

update private.content_reports
set owner_redacted_at = created_at
where owner_user_id is null;

alter table private.content_reports
  add constraint content_reports_share_secret_audit check (
    num_nonnulls(share_secret_hash, share_secret_redacted_at) = 1
  ),
  add constraint content_reports_card_audit check (
    num_nonnulls(personal_card_id, personal_card_redacted_at) = 1
  ),
  add constraint content_reports_owner_audit check (
    num_nonnulls(owner_user_id, owner_redacted_at) = 1
  ),
  add constraint content_reports_resolution_consistent check (
    (
      status = 'open'
      and resolved_at is null
      and resolved_by_auth_user_id is null
      and resolved_by_redacted_at is null
      and resolution_code is null
    )
    or (
      status <> 'open'
      and resolved_at is not null
      and resolution_code is not null
      and num_nonnulls(
        resolved_by_auth_user_id,
        resolved_by_redacted_at
      ) = 1
      and (
        resolved_by_redacted_at is null
        or resolved_by_redacted_at >= resolved_at
      )
    )
  );

alter table private.moderation_actions
  alter column admin_auth_user_id drop not null,
  add column admin_redacted_at timestamptz,
  add column personal_card_redacted_at timestamptz,
  add column owner_redacted_at timestamptz,
  add column suspension_redacted_at timestamptz,
  drop constraint moderation_actions_one_target,
  add constraint moderation_actions_admin_audit check (
    num_nonnulls(admin_auth_user_id, admin_redacted_at) = 1
  ),
  add constraint moderation_actions_one_target check (
    num_nonnulls(
      personal_card_id,
      personal_card_redacted_at,
      report_id,
      suspension_id,
      suspension_redacted_at
    ) >= 1
  ),
  add constraint moderation_actions_card_audit check (
    num_nonnulls(personal_card_id, personal_card_redacted_at) <= 1
  ),
  add constraint moderation_actions_owner_audit check (
    num_nonnulls(owner_user_id, owner_redacted_at) <= 1
  ),
  add constraint moderation_actions_suspension_audit check (
    num_nonnulls(suspension_id, suspension_redacted_at) <= 1
  );

-- Preserve append-only audit semantics while allowing only the irreversible
-- identifier-to-redaction-marker transition required by account deletion.
-- The existing trigger calls this function for every UPDATE or DELETE.
create or replace function private.reject_moderation_action_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin_transition boolean;
  v_card_transition boolean;
  v_owner_transition boolean;
  v_suspension_transition boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'moderation actions are append-only'
      using errcode = '23514';
  end if;

  v_admin_transition :=
    (new.admin_auth_user_id is not distinct from old.admin_auth_user_id
      and new.admin_redacted_at is not distinct from old.admin_redacted_at)
    or (
      old.admin_auth_user_id is not null
      and old.admin_redacted_at is null
      and new.admin_auth_user_id is null
      and new.admin_redacted_at is not null
      and new.admin_redacted_at >= old.created_at
    );

  v_card_transition :=
    (new.personal_card_id is not distinct from old.personal_card_id
      and new.personal_card_redacted_at
        is not distinct from old.personal_card_redacted_at)
    or (
      old.personal_card_id is not null
      and old.personal_card_redacted_at is null
      and new.personal_card_id is null
      and new.personal_card_redacted_at is not null
      and new.personal_card_redacted_at >= old.created_at
    );

  v_owner_transition :=
    (new.owner_user_id is not distinct from old.owner_user_id
      and new.owner_redacted_at is not distinct from old.owner_redacted_at)
    or (
      old.owner_user_id is not null
      and old.owner_redacted_at is null
      and new.owner_user_id is null
      and new.owner_redacted_at is not null
      and new.owner_redacted_at >= old.created_at
    );

  v_suspension_transition :=
    (new.suspension_id is not distinct from old.suspension_id
      and new.suspension_redacted_at
        is not distinct from old.suspension_redacted_at)
    or (
      old.suspension_id is not null
      and old.suspension_redacted_at is null
      and new.suspension_id is null
      and new.suspension_redacted_at is not null
      and new.suspension_redacted_at >= old.created_at
    );

  if row(
      new.id,
      new.client_action_id,
      new.report_id,
      new.action,
      new.previous_state,
      new.resulting_state,
      new.reason_code,
      new.note,
      new.affected_count,
      new.created_at
    ) is distinct from row(
      old.id,
      old.client_action_id,
      old.report_id,
      old.action,
      old.previous_state,
      old.resulting_state,
      old.reason_code,
      old.note,
      old.affected_count,
      old.created_at
    )
    or not v_admin_transition
    or not v_card_transition
    or not v_owner_transition
    or not v_suspension_transition
  then
    raise exception 'moderation actions are append-only'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function private.reject_moderation_action_mutation()
  from public, anon, authenticated, service_role;

-- Historical card erasure could precede this redaction schema. Moderation
-- actions intentionally have no FK to the deleted card, so replace orphaned
-- identifiers with an irreversible marker after installing the narrow audit
-- transition above; the v0.3.9 trigger otherwise rejects every UPDATE.
update private.moderation_actions as action_row
set personal_card_id = null,
    personal_card_redacted_at = greatest(action_row.created_at, clock_timestamp())
where action_row.personal_card_id is not null
  and not exists (
    select 1
    from public.personal_cards as card_row
    where card_row.id = action_row.personal_card_id
  );

-- Upgrade rows whose Auth actor was deleted before this migration installed
-- the BEFORE DELETE redaction trigger. These audit tables deliberately have
-- no Auth FK, so absence must be projected to the same irreversible marker.
update private.location_correction_requests as correction_row
set resolved_by_auth_user_id = null,
    resolved_by_redacted_at = greatest(
      correction_row.requested_at,
      coalesce(correction_row.resolved_at, correction_row.requested_at)
    )
where correction_row.resolved_by_auth_user_id is not null
  and not exists (
    select 1 from auth.users as auth_user
    where auth_user.id = correction_row.resolved_by_auth_user_id
  );

update private.share_owner_suspensions as suspension_row
set suspended_by_auth_user_id = null,
    suspended_by_redacted_at = suspension_row.suspended_at
where suspension_row.suspended_by_auth_user_id is not null
  and not exists (
    select 1 from auth.users as auth_user
    where auth_user.id = suspension_row.suspended_by_auth_user_id
  );

update private.share_owner_suspensions as suspension_row
set lifted_by_auth_user_id = null,
    lifted_by_redacted_at = suspension_row.lifted_at
where suspension_row.lifted_by_auth_user_id is not null
  and not exists (
    select 1 from auth.users as auth_user
    where auth_user.id = suspension_row.lifted_by_auth_user_id
  );

update private.content_reports as report_row
set resolved_by_auth_user_id = null,
    resolved_by_redacted_at = report_row.resolved_at
where report_row.resolved_by_auth_user_id is not null
  and not exists (
    select 1 from auth.users as auth_user
    where auth_user.id = report_row.resolved_by_auth_user_id
  );

update private.moderation_actions as action_row
set admin_auth_user_id = null,
    admin_redacted_at = action_row.created_at
where action_row.admin_auth_user_id is not null
  and not exists (
    select 1 from auth.users as auth_user
    where auth_user.id = action_row.admin_auth_user_id
  );

-- Translation mutation guards need one narrow exception for deleting an Auth
-- identifier. Content, status, locale, and the original approval time remain
-- immutable.
create or replace function private.guard_region_translation_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_region_code text := case
    when tg_op = 'DELETE' then old.region_code
    else new.region_code
  end;
  v_is_audit_redaction boolean := false;
begin
  if tg_op = 'UPDATE' and (
    new.region_code is distinct from old.region_code
    or new.locale is distinct from old.locale
  ) then
    raise exception
      'translation parent and locale are immutable; delete and recreate draft rows'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' then
    v_is_audit_redaction :=
      old.status = 'approved'
      and new.status = old.status
      and new.name = old.name
      and new.approved_at is not distinct from old.approved_at
      and old.approved_by is not null
      and new.approved_by is null
      and old.approved_by_redacted_at is null
      and new.approved_by_redacted_at is not null
      and new.approved_by_redacted_at >= old.approved_at;
  end if;

  perform 1
  from public.regions as region_row
  where region_row.code = v_region_code
  for update of region_row;

  if exists (
    select 1
    from public.spots as spot_row
    where spot_row.region = v_region_code
      and spot_row.status in ('teaser', 'open')
  ) and (
    tg_op = 'DELETE'
    or old.status = 'approved' and new.status <> 'approved'
  ) then
    raise exception 'public region translations cannot be removed or demoted'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE'
    and not v_is_audit_redaction
    and old.status = 'approved'
    and new.status = 'approved'
    and (
      new.name is distinct from old.name
      or new.approved_at is distinct from old.approved_at
      or new.approved_by is distinct from old.approved_by
      or new.approved_by_redacted_at is distinct from old.approved_by_redacted_at
    )
    and (
      new.approved_at is null
      or new.approved_at <= old.approved_at
      or new.approved_by is null
      or new.approved_by_redacted_at is not null
    )
  then
    raise exception 'approved region translation edits require a fresh approval audit'
      using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function private.guard_spot_translation_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_spot_id uuid := case
    when tg_op = 'DELETE' then old.spot_id
    else new.spot_id
  end;
  v_status public.spot_status;
  v_is_audit_redaction boolean := false;
begin
  if tg_op = 'UPDATE' and (
    new.spot_id is distinct from old.spot_id
    or new.locale is distinct from old.locale
  ) then
    raise exception
      'translation parent and locale are immutable; delete and recreate draft rows'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' then
    v_is_audit_redaction :=
      old.status = 'approved'
      and new.status = old.status
      and new.name = old.name
      and new.approved_at is not distinct from old.approved_at
      and old.approved_by is not null
      and new.approved_by is null
      and old.approved_by_redacted_at is null
      and new.approved_by_redacted_at is not null
      and new.approved_by_redacted_at >= old.approved_at;
  end if;

  select spot_row.status
  into v_status
  from public.spots as spot_row
  where spot_row.id = v_spot_id
  for update of spot_row;

  if v_status in ('teaser', 'open') and (
    tg_op = 'DELETE'
    or old.status = 'approved' and new.status <> 'approved'
  ) then
    raise exception 'public spot translations cannot be removed or demoted'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE'
    and not v_is_audit_redaction
    and old.status = 'approved'
    and new.status = 'approved'
    and (
      new.name is distinct from old.name
      or new.approved_at is distinct from old.approved_at
      or new.approved_by is distinct from old.approved_by
      or new.approved_by_redacted_at is distinct from old.approved_by_redacted_at
    )
    and (
      new.approved_at is null
      or new.approved_at <= old.approved_at
      or new.approved_by is null
      or new.approved_by_redacted_at is not null
    )
  then
    raise exception 'approved spot translation edits require a fresh approval audit'
      using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function private.guard_card_translation_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_card_id uuid := case
    when tg_op = 'DELETE' then old.card_id
    else new.card_id
  end;
  v_is_published boolean;
  v_is_audit_redaction boolean := false;
begin
  if tg_op = 'UPDATE' and (
    new.card_id is distinct from old.card_id
    or new.locale is distinct from old.locale
  ) then
    raise exception
      'translation parent and locale are immutable; delete and recreate draft rows'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' then
    v_is_audit_redaction :=
      old.status = 'approved'
      and new.status = old.status
      and new.title = old.title
      and new.approved_at is not distinct from old.approved_at
      and old.approved_by is not null
      and new.approved_by is null
      and old.approved_by_redacted_at is null
      and new.approved_by_redacted_at is not null
      and new.approved_by_redacted_at >= old.approved_at;
  end if;

  select card_row.is_published
  into v_is_published
  from public.cards as card_row
  where card_row.id = v_card_id
  for update of card_row;

  if exists (
    select 1
    from public.acquisitions as acquisition_row
    where acquisition_row.card_id = v_card_id
  ) and not v_is_audit_redaction and (
    tg_op in ('INSERT', 'DELETE')
    or new.title is distinct from old.title
    or new.status is distinct from old.status
    or new.locale is distinct from old.locale
    or new.approved_at is distinct from old.approved_at
    or new.approved_by is distinct from old.approved_by
    or new.approved_by_redacted_at is distinct from old.approved_by_redacted_at
  ) then
    raise exception 'acquired card translations are immutable; create a new card version'
      using errcode = '23514';
  end if;

  if coalesce(v_is_published, false) and (
    tg_op = 'DELETE'
    or old.status = 'approved' and new.status <> 'approved'
  ) then
    raise exception 'published card translations cannot be removed or demoted'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE'
    and not v_is_audit_redaction
    and old.status = 'approved'
    and new.status = 'approved'
    and (
      new.title is distinct from old.title
      or new.approved_at is distinct from old.approved_at
      or new.approved_by is distinct from old.approved_by
      or new.approved_by_redacted_at is distinct from old.approved_by_redacted_at
    )
    and (
      new.approved_at is null
      or new.approved_at <= old.approved_at
      or new.approved_by is null
      or new.approved_by_redacted_at is not null
    )
  then
    raise exception 'approved card translation edits require a fresh approval audit'
      using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.guard_region_translation_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_spot_translation_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_card_translation_mutation()
  from public, anon, authenticated, service_role;

create or replace function private.redact_auth_audits_before_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  update private.retro_grants
  set admin_auth_user_id = null,
      admin_redacted_at = v_now
  where admin_auth_user_id = old.id;

  update public.region_translations
  set approved_by = null,
      approved_by_redacted_at = greatest(v_now, approved_at)
  where approved_by = old.id;

  update public.spot_translations
  set approved_by = null,
      approved_by_redacted_at = greatest(v_now, approved_at)
  where approved_by = old.id;

  update public.card_translations
  set approved_by = null,
      approved_by_redacted_at = greatest(v_now, approved_at)
  where approved_by = old.id;

  update public.personal_cards
  set share_reviewed_by = null,
      share_reviewed_by_redacted_at = greatest(v_now, share_reviewed_at)
  where share_reviewed_by = old.id;

  update private.location_correction_requests
  set resolved_by_auth_user_id = null,
      resolved_by_redacted_at = greatest(
        v_now,
        coalesce(resolved_at, requested_at)
      )
  where resolved_by_auth_user_id = old.id;

  update private.share_owner_suspensions
  set suspended_by_auth_user_id = null,
      suspended_by_redacted_at = greatest(v_now, suspended_at)
  where suspended_by_auth_user_id = old.id;

  update private.share_owner_suspensions
  set lifted_by_auth_user_id = null,
      lifted_by_redacted_at = greatest(v_now, lifted_at)
  where lifted_by_auth_user_id = old.id;

  update private.content_reports
  set resolved_by_auth_user_id = null,
      resolved_by_redacted_at = greatest(v_now, resolved_at)
  where resolved_by_auth_user_id = old.id;

  update private.moderation_actions
  set admin_auth_user_id = null,
      admin_redacted_at = greatest(v_now, created_at)
  where admin_auth_user_id = old.id;

  return old;
end;
$$;

revoke all on function private.redact_auth_audits_before_delete()
  from public, anon, authenticated, service_role;

create trigger account_deletion_redact_auth_audits
before delete on auth.users
for each row execute function private.redact_auth_audits_before_delete();

create or replace function private.redact_logical_user_audits_before_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  update private.participant_invite_codes
  set redeemed_by_user_id = null,
      redeemed_by_redacted_at = greatest(v_now, redeemed_at)
  where redeemed_by_user_id = old.id;

  update private.content_reports
  set owner_user_id = null,
      owner_redacted_at = greatest(v_now, created_at)
  where owner_user_id = old.id;

  update private.moderation_actions
  set owner_user_id = null,
      owner_redacted_at = greatest(v_now, created_at)
  where owner_user_id = old.id;

  return old;
end;
$$;

revoke all on function private.redact_logical_user_audits_before_delete()
  from public, anon, authenticated, service_role;

create trigger account_deletion_redact_logical_user_audits
before delete on public.app_users
for each row execute function private.redact_logical_user_audits_before_delete();

create or replace function private.redact_personal_card_audits_before_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  update private.content_reports
  set personal_card_id = null,
      personal_card_redacted_at = greatest(v_now, created_at),
      share_secret_hash = null,
      share_secret_redacted_at = greatest(v_now, created_at)
  where personal_card_id = old.id;

  update private.moderation_actions
  set personal_card_id = null,
      personal_card_redacted_at = greatest(v_now, created_at)
  where personal_card_id = old.id;

  return old;
end;
$$;

revoke all on function private.redact_personal_card_audits_before_delete()
  from public, anon, authenticated, service_role;

create trigger account_deletion_redact_personal_card_audits
before delete on public.personal_cards
for each row execute function private.redact_personal_card_audits_before_delete();

create or replace function private.redact_suspension_audits_before_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.moderation_actions
  set suspension_id = null,
      suspension_redacted_at = greatest(clock_timestamp(), created_at)
  where suspension_id = old.id;
  return old;
end;
$$;

revoke all on function private.redact_suspension_audits_before_delete()
  from public, anon, authenticated, service_role;

create trigger account_deletion_redact_suspension_audits
before delete on private.share_owner_suspensions
for each row execute function private.redact_suspension_audits_before_delete();

-- Every retained-audit redaction predicate needs a direct lookup index. The
-- deletion worker must not scan global moderation history while deleting one
-- account or one card as the service grows.
create index content_reports_owner_redaction_idx
  on private.content_reports(owner_user_id)
  where owner_user_id is not null;
create index content_reports_card_redaction_idx
  on private.content_reports(personal_card_id)
  where personal_card_id is not null;
create index content_reports_resolver_redaction_idx
  on private.content_reports(resolved_by_auth_user_id)
  where resolved_by_auth_user_id is not null;
create index moderation_actions_owner_redaction_idx
  on private.moderation_actions(owner_user_id)
  where owner_user_id is not null;
create index moderation_actions_admin_redaction_idx
  on private.moderation_actions(admin_auth_user_id)
  where admin_auth_user_id is not null;
create index location_corrections_resolver_redaction_idx
  on private.location_correction_requests(resolved_by_auth_user_id)
  where resolved_by_auth_user_id is not null;
create index share_suspensions_lifter_redaction_idx
  on private.share_owner_suspensions(lifted_by_auth_user_id)
  where lifted_by_auth_user_id is not null;

-- -------------------------------------------------------------------------
-- Account deletion state, external manifests, and public throttles
-- -------------------------------------------------------------------------

create table private.account_deletion_jobs (
  id uuid primary key,
  user_id uuid references public.app_users(id) on delete set null,
  status_token_hash bytea not null check (octet_length(status_token_hash) = 32),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed')),
  phase text not null default 'storage_initial'
    check (phase in (
      'storage_initial',
      'storage_final',
      'database',
      'auth',
      'finalize',
      'done'
    )),
  storage_prefix uuid,
  requested_at timestamptz not null default clock_timestamp(),
  complete_by timestamptz not null,
  next_attempt_at timestamptz,
  attempt_count bigint not null default 0 check (attempt_count >= 0),
  consecutive_failure_count bigint not null default 0
    check (consecutive_failure_count >= 0),
  last_error_code text check (
    last_error_code is null
    or last_error_code in (
      'STORAGE_LIST_FAILED',
      'STORAGE_DELETE_FAILED',
      'DATABASE_DELETE_FAILED',
      'AUTH_DELETE_FAILED',
      'WORKER_TIMEOUT',
      'WORKER_UNEXPECTED'
    )
  ),
  last_error_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  database_deleted_at timestamptz,
  final_storage_empty_at timestamptz,
  completed_at timestamptz,
  result_code text check (result_code is null or result_code = 'DELETED'),
  receipt_expires_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  constraint account_deletion_jobs_deadline_exact check (
    complete_by = requested_at + interval '24 hours'
  ),
  constraint account_deletion_jobs_lease_consistent check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  ),
  constraint account_deletion_jobs_error_consistent check (
    (last_error_code is null and last_error_at is null)
    or (last_error_code is not null and last_error_at is not null)
  ),
  constraint account_deletion_jobs_completion_consistent check (
    (
      status = 'completed'
      and phase = 'done'
      and user_id is null
      and storage_prefix is null
      and next_attempt_at is null
      and lease_token is null
      and lease_expires_at is null
      and completed_at is not null
      and result_code = 'DELETED'
      and receipt_expires_at = completed_at + interval '30 days'
    )
    or (
      status <> 'completed'
      and phase <> 'done'
      and completed_at is null
      and result_code is null
      and receipt_expires_at is null
    )
  )
);

create unique index account_deletion_jobs_one_live_user_idx
  on private.account_deletion_jobs(user_id)
  where user_id is not null;

create index account_deletion_jobs_worker_idx
  on private.account_deletion_jobs(next_attempt_at, requested_at, id)
  where status <> 'completed';

create index account_deletion_jobs_receipt_expiry_idx
  on private.account_deletion_jobs(receipt_expires_at)
  where status = 'completed';

create table private.account_deletion_storage_manifest (
  id bigint generated always as identity primary key,
  request_id uuid not null
    references private.account_deletion_jobs(id) on delete cascade,
  bucket text not null check (bucket in ('personal-card-temp', 'personal-cards')),
  object_path text not null check (
    char_length(object_path) between 1 and 512
    and object_path !~ '(^|/)\.\.(/|$)'
  ),
  first_deleted_at timestamptz,
  final_delete_after timestamptz not null,
  deleted_at timestamptz,
  attempt_count bigint not null default 0 check (attempt_count >= 0),
  last_attempt_at timestamptz,
  constraint account_deletion_storage_manifest_unique
    unique (request_id, bucket, object_path),
  constraint account_deletion_storage_manifest_attempt_consistent check (
    attempt_count = 0 or last_attempt_at is not null
  ),
  constraint account_deletion_storage_manifest_passes_consistent check (
    (first_deleted_at is null and deleted_at is null)
    or (
      first_deleted_at is not null
      and final_delete_after >= first_deleted_at
      and (deleted_at is null or deleted_at >= final_delete_after)
    )
  )
);

create index account_deletion_storage_manifest_worker_idx
  on private.account_deletion_storage_manifest(
    request_id,
    first_deleted_at,
    final_delete_after,
    id
  )
  where deleted_at is null;

create table private.account_deletion_auth_manifest (
  request_id uuid not null
    references private.account_deletion_jobs(id) on delete cascade,
  auth_user_id uuid not null,
  primary key (request_id, auth_user_id)
);

-- Retro/gift promotions need the same durable Storage/Database boundary as
-- field promotions, but must never share a path with the field-specific
-- erasure ledger. Only the permanent derived object is represented here; the
-- existing temporary-upload state machine already owns the temporary path.
-- A pending promotion is conservatively charged five MiB until exact-size
-- completion replaces the reservation with a personal-card row.
create table private.personal_card_permanent_object_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null
    references public.app_users(id) on delete restrict,
  upload_id uuid
    references private.personal_card_temp_uploads(id) on delete restrict,
  processing_token uuid not null,
  object_path text not null unique,
  origin text not null check (origin in ('promotion', 'legacy_orphan')),
  reserved_bytes bigint not null check (reserved_bytes between 1 and 5242880),
  final_delete_not_before timestamptz not null,
  state text not null default 'active'
    check (state in ('active', 'cleanup_pending')),
  created_at timestamptz not null default clock_timestamp(),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  lease_token uuid,
  lease_expires_at timestamptz,
  first_deleted_at timestamptz,
  final_delete_after timestamptz,
  constraint personal_card_permanent_object_ledger_origin_exact check (
    (origin = 'promotion' and upload_id is not null)
    or (origin = 'legacy_orphan' and upload_id is null)
  ),
  constraint personal_card_permanent_object_ledger_path_exact check (
    object_path = user_id::text || '/' || processing_token::text || '.webp'
    and char_length(object_path) between 1 and 256
  ),
  constraint personal_card_permanent_object_ledger_lease_consistent check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  ),
  constraint personal_card_permanent_object_ledger_cleanup_consistent check (
    (
      state = 'active'
      and first_deleted_at is null
      and final_delete_after is null
    )
    or (
      state = 'cleanup_pending'
      and final_delete_after is not null
      and final_delete_after >= final_delete_not_before
      and (
        first_deleted_at is null
        or final_delete_after >= first_deleted_at
      )
    )
  )
);

create unique index personal_card_permanent_object_ledger_token_idx
  on private.personal_card_permanent_object_ledger(processing_token);
create index personal_card_permanent_object_ledger_owner_idx
  on private.personal_card_permanent_object_ledger(user_id, id);
create index personal_card_permanent_object_ledger_worker_idx
  on private.personal_card_permanent_object_ledger(next_attempt_at, id);

-- The unified maintenance queue leases exactly one item at a time. These
-- columns supersede the two historical timestamp-only claims and let result
-- recording reject stale workers explicitly.
alter table private.personal_card_temp_uploads
  add column maintenance_cleanup_token uuid,
  add column maintenance_cleanup_phase text
    check (maintenance_cleanup_phase in ('promotion_expired', 'signed_url_expired')),
  add column maintenance_cleanup_expires_at timestamptz,
  add column maintenance_cleanup_next_attempt_at timestamptz,
  add constraint personal_card_temp_uploads_maintenance_lease_consistent check (
    (
      maintenance_cleanup_token is null
      and maintenance_cleanup_phase is null
      and maintenance_cleanup_expires_at is null
    )
    or (
      maintenance_cleanup_token is not null
      and maintenance_cleanup_phase is not null
      and maintenance_cleanup_expires_at is not null
    )
  );

create table private.account_deletion_rate_limits (
  scope text not null check (scope in (
    'account_deletion_recovery_ip',
    'account_deletion_recovery_subject',
    'account_deletion_status_ip'
  )),
  subject_hash bytea not null check (octet_length(subject_hash) = 32),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  expires_at timestamptz not null,
  primary key (scope, subject_hash, window_started_at),
  constraint account_deletion_rate_limits_expiry check (
    expires_at > window_started_at
    and expires_at <= window_started_at + interval '48 hours'
  )
);

-- Permanent anti-recreation marker for a deleted user's Storage prefix. It
-- stores no raw UUID, path, timestamp, request FK, or user FK. The marker must
-- outlive the receipt because an upload whose signature was accepted before
-- expiry has no externally guaranteed maximum body-stream duration.
create table private.account_deletion_storage_tombstone_key (
  singleton boolean primary key default true check (singleton),
  secret bytea not null check (octet_length(secret) = 32)
);

insert into private.account_deletion_storage_tombstone_key (singleton, secret)
values (true, extensions.gen_random_bytes(32));

create table private.account_deletion_storage_prefix_tombstones (
  prefix_hash bytea primary key check (octet_length(prefix_hash) = 32)
);

-- Permanent exact-path anti-recreation markers for cleaned active-account
-- objects. They contain no raw bucket, path, UUID, timestamp, or FK and close
-- the accepted-before-expiry/metadata-committed-after-cleanup upload race.
create table private.personal_card_storage_object_tombstones (
  object_hash bytea primary key check (octet_length(object_hash) = 32)
);

create or replace function private.personal_card_storage_object_hash(
  p_bucket text,
  p_object_path text
)
returns bytea
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_secret bytea;
begin
  if p_bucket is null
    or p_bucket not in ('personal-card-temp', 'personal-cards')
    or p_object_path is null
    or char_length(p_object_path) not between 1 and 256
    or p_object_path ~ '(^|/)\.\.(/|$)'
  then
    raise exception 'invalid personal-card Storage object identity'
      using errcode = '23514';
  end if;

  select key_row.secret
  into v_secret
  from private.account_deletion_storage_tombstone_key as key_row
  where key_row.singleton;
  if not found then
    raise exception 'personal-card Storage tombstone key is unavailable'
      using errcode = '23514';
  end if;

  return extensions.hmac(
    convert_to(
      'danyeodam:personal-card-storage-object:v1:'
        || p_bucket || ':' || p_object_path,
      'UTF8'
    ),
    v_secret,
    'sha256'
  );
end;
$$;

revoke all on function private.personal_card_storage_object_hash(text, text)
  from public, anon, authenticated, service_role;

-- A correction/withdrawal manifest becomes the durable owner of its exact
-- Storage paths at snapshot time. Record the irreversible keyed marker in
-- that same owner-serialized transaction, before any external deletion, so a
-- signed body accepted earlier cannot recreate metadata after either pass.
create or replace function private.tombstone_data_erasure_manifest_object()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  select job_row.user_id
  into v_user_id
  from private.data_erasure_jobs as job_row
  where job_row.id = new.job_id;
  if not found then
    raise exception 'data-erasure job is unavailable'
      using errcode = '23503';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_user_id::text,
    0
  ));

  insert into private.personal_card_storage_object_tombstones (object_hash)
  values (private.personal_card_storage_object_hash(
    new.bucket,
    new.object_path
  ))
  on conflict (object_hash) do nothing;
  return new;
end;
$$;

revoke all on function private.tombstone_data_erasure_manifest_object()
  from public, anon, authenticated, service_role;

create trigger data_erasure_manifest_tombstone_object
before insert on private.data_erasure_manifest
for each row execute function private.tombstone_data_erasure_manifest_object();

-- The wrapper installed below covers every new field-worker call. This
-- compatibility trigger also catches an old claim body that was parsed before
-- cutover and resumes after the migration-held source-table lock is released.
create or replace function private.tombstone_claimed_personal_card_field_object()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.lease_token is not null
    and new.lease_token is distinct from old.lease_token
  then
    insert into private.personal_card_storage_object_tombstones (object_hash)
    values (private.personal_card_storage_object_hash(
      new.bucket::text,
      new.object_path
    ))
    on conflict (object_hash) do nothing;
  end if;
  return new;
end;
$$;

revoke all on function private.tombstone_claimed_personal_card_field_object()
  from public, anon, authenticated, service_role;

create trigger personal_card_field_ledger_claim_tombstone
after update of lease_token on private.personal_card_field_object_ledger
for each row execute function private.tombstone_claimed_personal_card_field_object();

-- The source locks at the top make these cutover backfills complete: no old
-- manifest INSERT or field claim UPDATE can commit in the scan/trigger gap.
insert into private.personal_card_storage_object_tombstones (object_hash)
select private.personal_card_storage_object_hash(
  manifest_row.bucket,
  manifest_row.object_path
)
from private.data_erasure_manifest as manifest_row
on conflict (object_hash) do nothing;

insert into private.personal_card_storage_object_tombstones (object_hash)
select private.personal_card_storage_object_hash(
  ledger_row.bucket::text,
  ledger_row.object_path
)
from private.personal_card_field_object_ledger as ledger_row
where ledger_row.state = 'cleanup_pending'
   or ledger_row.lease_token is not null
   or ledger_row.first_deleted_at is not null
on conflict (object_hash) do nothing;

create index account_deletion_rate_limits_expiry_idx
  on private.account_deletion_rate_limits(expires_at);

create table private.account_deletion_admin_actions (
  id bigint generated always as identity primary key,
  admin_auth_user_id uuid not null
    references auth.users(id) on delete cascade,
  request_id uuid not null
    references private.account_deletion_jobs(id) on delete cascade,
  client_action_id uuid not null,
  action text not null check (action = 'retry'),
  reason_code text not null check (reason_code in (
    'OVERDUE',
    'TRANSIENT_FAILURE',
    'WORKER_STALLED',
    'MANUAL_REVIEW'
  )),
  note text not null check (
    note = btrim(note)
    and char_length(note) between 1 and 500
  ),
  result_status text not null check (
    result_status in ('retry_scheduled', 'completed')
  ),
  result_next_attempt_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint account_deletion_admin_actions_idempotency
    unique (admin_auth_user_id, client_action_id),
  constraint account_deletion_admin_actions_result_consistent check (
    (result_status = 'retry_scheduled' and result_next_attempt_at is not null)
    or (result_status = 'completed' and result_next_attempt_at is null)
  )
);

create index account_deletion_admin_actions_request_idx
  on private.account_deletion_admin_actions(request_id, created_at, id);

create index account_deletion_admin_actions_rate_idx
  on private.account_deletion_admin_actions(admin_auth_user_id, created_at);

create or replace function private.reject_account_deletion_admin_action_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
    and (
      not exists (
        select 1
        from private.account_deletion_jobs as job_row
        where job_row.id = old.request_id
      )
      or not exists (
        select 1
        from auth.users as auth_user
        where auth_user.id = old.admin_auth_user_id
      )
    )
  then
    -- Permit only the FK cascade used by receipt/job retention cleanup or
    -- the administrator's own complete account deletion.
    return old;
  end if;

  raise exception 'account deletion administrator actions are append-only'
    using errcode = '23514';
end;
$$;

revoke all on function private.reject_account_deletion_admin_action_mutation()
  from public, anon, authenticated, service_role;

create trigger account_deletion_admin_actions_append_only
before update or delete on private.account_deletion_admin_actions
for each row execute function private.reject_account_deletion_admin_action_mutation();

alter table private.account_deletion_jobs enable row level security;
alter table private.account_deletion_jobs force row level security;
alter table private.account_deletion_storage_manifest enable row level security;
alter table private.account_deletion_storage_manifest force row level security;
alter table private.account_deletion_auth_manifest enable row level security;
alter table private.account_deletion_auth_manifest force row level security;
alter table private.account_deletion_rate_limits enable row level security;
alter table private.account_deletion_rate_limits force row level security;
alter table private.account_deletion_storage_prefix_tombstones enable row level security;
alter table private.account_deletion_storage_prefix_tombstones force row level security;
alter table private.personal_card_storage_object_tombstones enable row level security;
alter table private.personal_card_storage_object_tombstones force row level security;
alter table private.account_deletion_storage_tombstone_key enable row level security;
alter table private.account_deletion_storage_tombstone_key force row level security;
alter table private.account_deletion_admin_actions enable row level security;
alter table private.account_deletion_admin_actions force row level security;
alter table private.personal_card_permanent_object_ledger enable row level security;
alter table private.personal_card_permanent_object_ledger force row level security;

revoke all on table
  private.account_deletion_jobs,
  private.account_deletion_storage_manifest,
  private.account_deletion_auth_manifest,
  private.account_deletion_rate_limits,
  private.account_deletion_storage_tombstone_key,
  private.account_deletion_storage_prefix_tombstones,
  private.personal_card_storage_object_tombstones,
  private.account_deletion_admin_actions,
  private.personal_card_permanent_object_ledger
from public, anon, authenticated, service_role;

-- The deletion worker deliberately lists one flat, canonical owner prefix.
-- Refuse the cutover if historical rows violate that invariant; silently
-- installing the trigger would make such objects invisible to the worker.
do $storage_path_preflight$
begin
  if exists (
    select 1
    from storage.objects as object_row
    where object_row.bucket_id in ('personal-card-temp', 'personal-cards')
      and object_row.name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.](jpg|jpeg|png|webp)$'
  ) then
    raise exception 'noncanonical personal-card Storage object blocks account-deletion cutover'
      using errcode = '23514';
  end if;
end;
$storage_path_preflight$;

create or replace function private.reject_deleted_account_storage_prefix()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_raw_prefix text;
  v_prefix text;
begin
  if tg_op = 'UPDATE'
    and old.bucket_id in ('personal-card-temp', 'personal-cards')
    and (
      new.bucket_id is distinct from old.bucket_id
      or new.name is distinct from old.name
    )
  then
    raise exception 'personal-card Storage object ownership is immutable'
      using errcode = '23514';
  end if;

  if new.bucket_id not in ('personal-card-temp', 'personal-cards') then
    return new;
  end if;

  v_raw_prefix := split_part(new.name, '/', 1);
  v_prefix := lower(v_raw_prefix);
  if v_raw_prefix <> v_prefix
    or v_prefix !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or new.name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.](jpg|jpeg|png|webp)$'
  then
    raise exception 'personal-card Storage objects require a canonical user UUID prefix'
      using errcode = '23514';
  end if;

  -- Canonical owner ordering also serializes an object commit that started
  -- before deletion against the deletion request snapshot/tombstone commit.
  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_prefix,
    0
  ));

  -- The signed-upload endpoint may accept a request before token expiry and
  -- commit Storage metadata after the final cleanup pass. Keep the database
  -- upload row as a permanent exact-path tombstone for active accounts. During
  -- account deletion the prefix tombstone below takes over before that row is
  -- hard-deleted.
  if new.bucket_id = 'personal-card-temp' and exists (
    select 1
    from private.personal_card_temp_uploads as upload_row
    where upload_row.temp_path = new.name
      and upload_row.cleanup_completed_at is not null
  ) then
    raise exception 'cleaned temporary Storage path is closed'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from private.personal_card_storage_object_tombstones as tombstone_row
    where tombstone_row.object_hash = extensions.hmac(
      convert_to(
        'danyeodam:personal-card-storage-object:v1:'
          || new.bucket_id || ':' || new.name,
        'UTF8'
      ),
      (
        select key_row.secret
        from private.account_deletion_storage_tombstone_key as key_row
        where key_row.singleton
      ),
      'sha256'
    )
  ) then
    raise exception 'cleaned personal-card Storage object is closed'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from private.account_deletion_storage_prefix_tombstones as tombstone_row
    where tombstone_row.prefix_hash = extensions.hmac(
      convert_to('danyeodam:account-delete-storage-prefix:v1:' || v_prefix, 'UTF8'),
      (
        select key_row.secret
        from private.account_deletion_storage_tombstone_key as key_row
        where key_row.singleton
      ),
      'sha256'
    )
  ) then
    raise exception 'account-deleted Storage prefix is closed'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.reject_deleted_account_storage_prefix()
  from public, anon, authenticated, service_role;

create trigger account_deletion_reject_storage_object
before insert or update of bucket_id, name on storage.objects
for each row execute function private.reject_deleted_account_storage_prefix();

create or replace function private.enforce_personal_card_permanent_object_ledger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from private.personal_card_field_object_ledger as field_row
    where field_row.object_path = new.object_path
  ) then
    raise exception 'personal-card object cannot have field and generic ledger owners'
      using errcode = '23514';
  end if;

  if new.origin = 'promotion' and not exists (
    select 1
    from private.personal_card_temp_uploads as upload_row
    join public.acquisitions as acquisition_row
      on acquisition_row.id = upload_row.processing_acquisition_id
     and acquisition_row.user_id = upload_row.user_id
    where upload_row.id = new.upload_id
      and upload_row.user_id = new.user_id
      and upload_row.processing_token = new.processing_token
      and upload_row.processing_permanent_path = new.object_path
      and upload_row.processing_expires_at is not null
      and new.final_delete_not_before >=
        upload_row.processing_expires_at + interval '10 minutes'
      and acquisition_row.acquisition_type in ('retro', 'gift')
  ) then
    raise exception 'generic promotion ledger requires an exact non-field binding'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_personal_card_permanent_object_ledger()
  from public, anon, authenticated, service_role;

create trigger personal_card_permanent_object_ledger_owned
before insert or update of
  user_id, upload_id, processing_token, object_path, origin,
  reserved_bytes, final_delete_not_before
on private.personal_card_permanent_object_ledger
for each row execute function private.enforce_personal_card_permanent_object_ledger();

create or replace function private.reject_generic_owned_field_object()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from private.personal_card_permanent_object_ledger as generic_row
    where generic_row.object_path = new.object_path
  ) then
    raise exception 'personal-card object cannot have field and generic ledger owners'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.reject_generic_owned_field_object()
  from public, anon, authenticated, service_role;

create trigger personal_card_field_object_ledger_no_generic_owner
before insert or update of object_path
on private.personal_card_field_object_ledger
for each row execute function private.reject_generic_owned_field_object();

-- Register every pre-cutover non-field processing path. Field paths remain
-- exclusively owned by personal_card_field_object_ledger.
insert into private.personal_card_permanent_object_ledger (
  user_id,
  upload_id,
  processing_token,
  object_path,
  origin,
  reserved_bytes,
  final_delete_not_before,
  next_attempt_at
)
select
  upload_row.user_id,
  upload_row.id,
  upload_row.processing_token,
  upload_row.processing_permanent_path,
  'promotion',
  5242880,
  upload_row.processing_expires_at + interval '10 minutes',
  clock_timestamp()
from private.personal_card_temp_uploads as upload_row
join public.acquisitions as acquisition_row
  on acquisition_row.id = upload_row.processing_acquisition_id
 and acquisition_row.user_id = upload_row.user_id
where upload_row.promoted_at is null
  and upload_row.processing_token is not null
  and upload_row.processing_expires_at is not null
  and upload_row.processing_permanent_path is not null
  and acquisition_row.acquisition_type in ('retro', 'gift');

-- Canonical protected-bucket objects that have no live card, processing row,
-- or field ledger predate durable promotion reconciliation. Import only
-- non-field owner prefixes; a field-associated orphan without a field ledger
-- is not safe to reclassify and blocks cutover below.
insert into private.personal_card_permanent_object_ledger (
  user_id,
  upload_id,
  processing_token,
  object_path,
  origin,
  reserved_bytes,
  final_delete_not_before,
  next_attempt_at
)
select
  split_part(object_row.name, '/', 1)::uuid,
  null,
  split_part(split_part(object_row.name, '/', 2), '.', 1)::uuid,
  object_row.name,
  'legacy_orphan',
  case
    when object_row.metadata ->> 'size' ~ '^[1-9][0-9]{0,6}$'
      and (object_row.metadata ->> 'size')::bigint <= 5242880
      then (object_row.metadata ->> 'size')::bigint
    else 5242880
  end,
  clock_timestamp() + interval '10 minutes',
  clock_timestamp()
from storage.objects as object_row
join public.app_users as user_row
  on user_row.id = split_part(object_row.name, '/', 1)::uuid
where object_row.bucket_id = 'personal-cards'
  and not exists (
    select 1
    from public.personal_cards as card_row
    where card_row.photo_path = object_row.name
  )
  and not exists (
    select 1
    from private.personal_card_temp_uploads as upload_row
    where upload_row.processing_permanent_path = object_row.name
       or upload_row.permanent_path = object_row.name
  )
  and not exists (
    select 1
    from private.personal_card_field_object_ledger as ledger_row
    where ledger_row.object_path = object_row.name
  );

do $permanent_object_cutover_preflight$
begin
  if exists (
    select 1
    from private.personal_card_permanent_object_ledger as generic_row
    join private.personal_card_field_object_ledger as field_row
      on field_row.object_path = generic_row.object_path
  ) then
    raise exception 'personal-card object has dual ledger ownership'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from storage.objects as object_row
    where object_row.bucket_id = 'personal-cards'
      and not exists (
        select 1 from public.personal_cards as card_row
        where card_row.photo_path = object_row.name
      )
      and not exists (
        select 1 from private.personal_card_temp_uploads as upload_row
        where upload_row.processing_permanent_path = object_row.name
           or upload_row.permanent_path = object_row.name
      )
      and not exists (
        select 1 from private.personal_card_field_object_ledger as field_row
        where field_row.object_path = object_row.name
      )
      and not exists (
        select 1 from private.personal_card_permanent_object_ledger as generic_row
        where generic_row.object_path = object_row.name
      )
  ) then
    raise exception 'unowned personal-card Storage object blocks cutover'
      using errcode = '23514';
  end if;
end;
$permanent_object_cutover_preflight$;

create or replace function private.ensure_nonfield_promotion_object_ledger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_acquisition_type public.acquisition_type;
begin
  if new.promoted_at is not null
    or new.processing_token is null
    or new.processing_expires_at is null
    or new.processing_acquisition_id is null
    or new.processing_permanent_path is null
  then
    return new;
  end if;

  select acquisition_row.acquisition_type
  into v_acquisition_type
  from public.acquisitions as acquisition_row
  where acquisition_row.id = new.processing_acquisition_id
    and acquisition_row.user_id = new.user_id;

  if v_acquisition_type not in ('retro', 'gift') then return new; end if;

  insert into private.personal_card_permanent_object_ledger (
    user_id, upload_id, processing_token, object_path, origin,
    reserved_bytes, final_delete_not_before, next_attempt_at
  ) values (
    new.user_id, new.id, new.processing_token, new.processing_permanent_path,
    'promotion', 5242880, new.processing_expires_at + interval '10 minutes',
    clock_timestamp()
  ) on conflict (object_path) do nothing;

  if not exists (
    select 1
    from private.personal_card_permanent_object_ledger as ledger_row
    where ledger_row.user_id = new.user_id
      and ledger_row.upload_id = new.id
      and ledger_row.processing_token = new.processing_token
      and ledger_row.object_path = new.processing_permanent_path
      and ledger_row.origin = 'promotion'
  ) then
    raise exception 'non-field promotion ledger registration mismatch'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.ensure_nonfield_promotion_object_ledger()
  from public, anon, authenticated, service_role;

create trigger personal_card_temp_uploads_nonfield_ledger_compatibility
after update of processing_token, processing_expires_at,
  processing_acquisition_id, processing_permanent_path
on private.personal_card_temp_uploads
for each row execute function private.ensure_nonfield_promotion_object_ledger();

alter function api_private.begin_personal_card_promotion(
  uuid, boolean, uuid, text, text, uuid
) rename to begin_personal_card_promotion_before_generic_ledger;

revoke all on function api_private.begin_personal_card_promotion_before_generic_ledger(
  uuid, boolean, uuid, text, text, uuid
) from public, anon, authenticated, service_role;

create or replace function api_private.begin_personal_card_promotion(
  p_auth_user_id uuid,
  p_public_gate_open boolean,
  p_acquisition_id uuid,
  p_temp_path text,
  p_caption text,
  p_processing_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_permanent_path text;
  v_outstanding bigint;
  v_result jsonb;
  v_type public.acquisition_type;
begin
  v_user_id := private.lock_active_user_id_for_auth(p_auth_user_id);
  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  perform pg_advisory_xact_lock_shared(hashtextextended(
    'danyeodam:policy-current-set',
    0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_user_id::text,
    0
  ));

  if p_processing_token is null then
    return jsonb_build_object('status', 'validation_failed');
  end if;
  v_permanent_path :=
    v_user_id::text || '/' || p_processing_token::text || '.webp';

  if not exists (
      select 1
      from private.personal_card_field_object_ledger as field_row
      where field_row.object_path = v_permanent_path
    ) and not exists (
      select 1
      from private.personal_card_permanent_object_ledger as generic_row
      where generic_row.object_path = v_permanent_path
    )
  then
    select
      (select count(*)
       from private.personal_card_field_object_ledger as field_row
       where field_row.user_id = v_user_id
         and field_row.bucket = 'personal-cards')
      +
      (select count(*)
       from private.personal_card_permanent_object_ledger as generic_row
       where generic_row.user_id = v_user_id)
    into v_outstanding;

    if v_outstanding >= 20 then
      return jsonb_build_object(
        'status', 'quota_exceeded',
        'reason', 'permanent_object_backlog'
      );
    end if;
  end if;

  v_result := api_private.begin_personal_card_promotion_before_generic_ledger(
    p_auth_user_id,
    p_public_gate_open,
    p_acquisition_id,
    p_temp_path,
    p_caption,
    p_processing_token
  );

  if v_result ->> 'status' = 'ready' then
    select acquisition_row.acquisition_type
    into v_type
    from public.acquisitions as acquisition_row
    where acquisition_row.id = p_acquisition_id
      and acquisition_row.user_id = v_user_id;

    if v_type in ('retro', 'gift') and not exists (
      select 1
      from private.personal_card_permanent_object_ledger as ledger_row
      where ledger_row.user_id = v_user_id
        and ledger_row.upload_id = (v_result ->> 'upload_id')::uuid
        and ledger_row.processing_token = p_processing_token
        and ledger_row.object_path = v_result ->> 'permanent_path'
        and ledger_row.origin = 'promotion'
        and ledger_row.state = 'active'
    ) then
      raise exception 'non-field promotion did not register its permanent object'
        using errcode = '23514';
    end if;
  end if;

  return v_result;
end;
$$;

alter function api_private.complete_personal_card_promotion(
  uuid, uuid, uuid, uuid, text, text
) rename to complete_personal_card_promotion_before_generic_ledger;

revoke all on function api_private.complete_personal_card_promotion_before_generic_ledger(
  uuid, uuid, uuid, uuid, text, text
) from public, anon, authenticated, service_role;

create or replace function api_private.complete_personal_card_promotion(
  p_auth_user_id uuid,
  p_upload_id uuid,
  p_processing_token uuid,
  p_acquisition_id uuid,
  p_permanent_path text,
  p_caption text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_type public.acquisition_type;
  v_result jsonb;
begin
  v_user_id := private.lock_active_user_id_for_auth(p_auth_user_id);
  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  perform pg_advisory_xact_lock_shared(hashtextextended(
    'danyeodam:policy-current-set',
    0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_user_id::text,
    0
  ));

  select acquisition_row.acquisition_type
  into v_type
  from public.acquisitions as acquisition_row
  where acquisition_row.id = p_acquisition_id
    and acquisition_row.user_id = v_user_id;

  if v_type in ('retro', 'gift')
    and not exists (
      select 1
      from private.personal_card_permanent_object_ledger as ledger_row
      where ledger_row.user_id = v_user_id
        and ledger_row.upload_id = p_upload_id
        and ledger_row.processing_token = p_processing_token
        and ledger_row.object_path = p_permanent_path
        and ledger_row.origin = 'promotion'
        and ledger_row.state = 'active'
    )
    and not exists (
      select 1
      from public.personal_cards as card_row
      where card_row.user_id = v_user_id
        and card_row.acquisition_id = p_acquisition_id
        and card_row.photo_path = p_permanent_path
    )
  then
    return jsonb_build_object('status', 'stale');
  end if;

  v_result := api_private.complete_personal_card_promotion_before_generic_ledger(
    p_auth_user_id,
    p_upload_id,
    p_processing_token,
    p_acquisition_id,
    p_permanent_path,
    p_caption
  );

  if v_type in ('retro', 'gift')
    and v_result ->> 'status' in ('created', 'already_created')
  then
    if not exists (
      select 1
      from public.personal_cards as card_row
      where card_row.id = (v_result ->> 'personal_card_id')::uuid
        and card_row.user_id = v_user_id
        and card_row.acquisition_id = p_acquisition_id
        and card_row.photo_path = p_permanent_path
    ) then
      raise exception 'completed non-field card does not own the permanent object'
        using errcode = '23514';
    end if;

    delete from private.personal_card_permanent_object_ledger as ledger_row
    where ledger_row.user_id = v_user_id
      and ledger_row.upload_id = p_upload_id
      and ledger_row.processing_token = p_processing_token
      and ledger_row.object_path = p_permanent_path
      and ledger_row.origin = 'promotion';
  end if;

  return v_result;
end;
$$;

revoke all on function api_private.begin_personal_card_promotion(
  uuid, boolean, uuid, text, text, uuid
) from public, anon, authenticated, service_role;
revoke all on function api_private.complete_personal_card_promotion(
  uuid, uuid, uuid, uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function api_private.begin_personal_card_promotion(
  uuid, boolean, uuid, text, text, uuid
) to service_role;
grant execute on function api_private.complete_personal_card_promotion(
  uuid, uuid, uuid, uuid, text, text
) to service_role;

-- All pre-cutover writers and every existing app_users FK child DDL above are
-- now drained while their required parent ROW SHARE/KEY SHARE remained
-- compatible with the app_users source gate. Upgrade to ACCESS EXCLUSIVE only
-- here, after the child locks, immediately before the new column's first use.
alter table public.app_users
  add column deletion_requested_at timestamptz;

-- Claim one oldest item across both temporary phases and the non-field
-- permanent ledger. A one-item claim is intentional: the HTTP worker checks
-- its remaining hard budget before every claim and can therefore always
-- attempt both Storage deletion and lease release/recording.
create or replace function api_private.claim_personal_card_storage_cleanup(
  p_worker_token uuid,
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate record;
  v_upload private.personal_card_temp_uploads%rowtype;
  v_ledger private.personal_card_permanent_object_ledger%rowtype;
  v_now timestamptz := clock_timestamp();
  v_phase text;
begin
  if p_worker_token is null or p_limit is distinct from 1 then
    return jsonb_build_object('status', 'invalid');
  end if;

  for v_candidate in
    select candidate_row.*
    from (
      select
        'temporary'::text as queue_kind,
        upload_row.id::text as row_key,
        upload_row.user_id,
        greatest(
          upload_row.promotion_expires_at,
          coalesce(
            upload_row.maintenance_cleanup_next_attempt_at,
            upload_row.promotion_expires_at
          )
        ) as due_at,
        'promotion_expired'::text as queue_phase
      from private.personal_card_temp_uploads as upload_row
      join public.app_users as user_row on user_row.id = upload_row.user_id
      where upload_row.promotion_expires_at <= v_now
        and upload_row.signed_url_expires_at > v_now
        and upload_row.promoted_at is null
        and upload_row.temp_deleted_at is null
        and (
          upload_row.maintenance_cleanup_token is null
          or upload_row.maintenance_cleanup_expires_at <= v_now
        )
        and coalesce(
          upload_row.maintenance_cleanup_next_attempt_at,
          upload_row.promotion_expires_at
        ) <= v_now
        and user_row.deletion_requested_at is null
        and not exists (
          select 1
          from private.personal_card_field_object_ledger as field_row
          where field_row.object_path = upload_row.temp_path
        )

      union all

      select
        'temporary',
        upload_row.id::text,
        upload_row.user_id,
        greatest(
          upload_row.signed_url_expires_at + interval '10 minutes',
          coalesce(
            upload_row.maintenance_cleanup_next_attempt_at,
            upload_row.signed_url_expires_at + interval '10 minutes'
          )
        ),
        'signed_url_expired'
      from private.personal_card_temp_uploads as upload_row
      join public.app_users as user_row on user_row.id = upload_row.user_id
      where upload_row.signed_url_expires_at + interval '10 minutes' <= v_now
        and upload_row.cleanup_completed_at is null
        and (
          upload_row.maintenance_cleanup_token is null
          or upload_row.maintenance_cleanup_expires_at <= v_now
        )
        and coalesce(
          upload_row.maintenance_cleanup_next_attempt_at,
          upload_row.signed_url_expires_at + interval '10 minutes'
        ) <= v_now
        and user_row.deletion_requested_at is null
        and not exists (
          select 1
          from private.personal_card_field_object_ledger as field_row
          where field_row.object_path = upload_row.temp_path
        )

      union all

      select
        'permanent',
        ledger_row.id::text,
        ledger_row.user_id,
        ledger_row.next_attempt_at,
        case when ledger_row.first_deleted_at is null then 'first' else 'final' end
      from private.personal_card_permanent_object_ledger as ledger_row
      join public.app_users as user_row on user_row.id = ledger_row.user_id
      where ledger_row.next_attempt_at <= v_now
        and (
          ledger_row.lease_token is null
          or ledger_row.lease_expires_at <= v_now
        )
        and user_row.deletion_requested_at is null
    ) as candidate_row
    order by candidate_row.due_at, candidate_row.queue_kind, candidate_row.row_key
    limit 64
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      'danyeodam:suspend-owner:' || v_candidate.user_id::text,
      0
    ));

    if exists (
      select 1
      from public.app_users as user_row
      where user_row.id = v_candidate.user_id
        and user_row.deletion_requested_at is not null
    ) then
      continue;
    end if;

    if v_candidate.queue_kind = 'temporary' then
      select upload_row.*
      into v_upload
      from private.personal_card_temp_uploads as upload_row
      where upload_row.id = v_candidate.row_key::uuid
        and upload_row.user_id = v_candidate.user_id
      for update;

      if not found or (
        v_upload.maintenance_cleanup_token is not null
        and v_upload.maintenance_cleanup_expires_at > v_now
      ) then
        continue;
      end if;

      -- A field ledger is the sole reconciler while it retains this exact
      -- temp path. Once its final pass removes the ledger, the unified final
      -- temp phase may close the upload row without concurrent ownership.
      if exists (
        select 1
        from private.personal_card_field_object_ledger as field_row
        where field_row.object_path = v_upload.temp_path
      ) then
        continue;
      end if;

      if v_candidate.queue_phase = 'promotion_expired' then
        if v_upload.promotion_expires_at > v_now
          or v_upload.signed_url_expires_at <= v_now
          or v_upload.promoted_at is not null
          or v_upload.temp_deleted_at is not null
        then
          continue;
        end if;
      else
        if v_upload.signed_url_expires_at + interval '10 minutes' > v_now
          or v_upload.cleanup_completed_at is not null
        then
          continue;
        end if;
      end if;

      update private.personal_card_temp_uploads
      set maintenance_cleanup_token = p_worker_token,
          maintenance_cleanup_phase = v_candidate.queue_phase,
          maintenance_cleanup_expires_at = v_now + interval '2 minutes'
      where id = v_upload.id;

      insert into private.personal_card_storage_object_tombstones (object_hash)
      values (extensions.hmac(
        convert_to(
          'danyeodam:personal-card-storage-object:v1:personal-card-temp:'
            || v_upload.temp_path,
          'UTF8'
        ),
        (
          select key_row.secret
          from private.account_deletion_storage_tombstone_key as key_row
          where key_row.singleton
        ),
        'sha256'
      )) on conflict (object_hash) do nothing;

      return jsonb_build_object(
        'status', 'ready',
        'item', jsonb_build_object(
          'kind', 'temporary',
          'upload_id', v_upload.id,
          'path', v_upload.temp_path,
          'phase', v_candidate.queue_phase
        )
      );
    end if;

    select ledger_row.*
    into v_ledger
    from private.personal_card_permanent_object_ledger as ledger_row
    where ledger_row.id = v_candidate.row_key::bigint
      and ledger_row.user_id = v_candidate.user_id
    for update;

    if not found
      or v_ledger.next_attempt_at > v_now
      or (
        v_ledger.lease_token is not null
        and v_ledger.lease_expires_at > v_now
      )
    then
      continue;
    end if;

    if exists (
      select 1
      from public.personal_cards as card_row
      where card_row.user_id = v_ledger.user_id
        and card_row.photo_path = v_ledger.object_path
    ) or exists (
      select 1
      from private.account_deletion_storage_manifest as item_row
      join private.account_deletion_jobs as job_row
        on job_row.id = item_row.request_id
      where job_row.status <> 'completed'
        and item_row.bucket = 'personal-cards'
        and item_row.object_path = v_ledger.object_path
    ) then
      delete from private.personal_card_permanent_object_ledger
      where id = v_ledger.id;
      continue;
    end if;

    if v_ledger.origin = 'promotion' and exists (
      select 1
      from private.personal_card_temp_uploads as upload_row
      where upload_row.id = v_ledger.upload_id
        and upload_row.user_id = v_ledger.user_id
        and upload_row.processing_token = v_ledger.processing_token
        and upload_row.processing_permanent_path = v_ledger.object_path
        and upload_row.promoted_at is null
        and upload_row.processing_expires_at > v_now
    ) then
      update private.personal_card_permanent_object_ledger
      set next_attempt_at = (
        select upload_row.processing_expires_at
        from private.personal_card_temp_uploads as upload_row
        where upload_row.id = v_ledger.upload_id
      )
      where id = v_ledger.id;
      continue;
    end if;

    v_phase := case when v_ledger.first_deleted_at is null then 'first' else 'final' end;
    if v_phase = 'final' and greatest(
      v_ledger.final_delete_not_before,
      v_ledger.final_delete_after
    ) > v_now then
      update private.personal_card_permanent_object_ledger
      set next_attempt_at = greatest(
        v_ledger.final_delete_not_before,
        v_ledger.final_delete_after
      )
      where id = v_ledger.id;
      continue;
    end if;

    update private.personal_card_permanent_object_ledger
    set state = 'cleanup_pending',
        final_delete_after = greatest(
          v_ledger.final_delete_not_before,
          coalesce(v_ledger.final_delete_after, v_now + interval '10 minutes')
        ),
        attempt_count = attempt_count + 1,
        lease_token = p_worker_token,
        lease_expires_at = v_now + interval '2 minutes'
    where id = v_ledger.id;

    insert into private.personal_card_storage_object_tombstones (object_hash)
    values (extensions.hmac(
      convert_to(
        'danyeodam:personal-card-storage-object:v1:personal-cards:'
          || v_ledger.object_path,
        'UTF8'
      ),
      (
        select key_row.secret
        from private.account_deletion_storage_tombstone_key as key_row
        where key_row.singleton
      ),
      'sha256'
    )) on conflict (object_hash) do nothing;

    return jsonb_build_object(
      'status', 'ready',
      'item', jsonb_build_object(
        'kind', 'permanent',
        'ledger_id', v_ledger.id::text,
        'path', v_ledger.object_path,
        'phase', v_phase
      )
    );
  end loop;

  return jsonb_build_object('status', 'empty');
end;
$$;

create or replace function api_private.record_personal_card_storage_cleanup_result(
  p_worker_token uuid,
  p_kind text,
  p_upload_id uuid,
  p_ledger_id bigint,
  p_phase text,
  p_deleted boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_upload private.personal_card_temp_uploads%rowtype;
  v_ledger private.personal_card_permanent_object_ledger%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_worker_token is null or p_deleted is null or not (
    (
      p_kind = 'temporary'
      and p_upload_id is not null
      and p_ledger_id is null
      and p_phase in ('promotion_expired', 'signed_url_expired')
    )
    or (
      p_kind = 'permanent'
      and p_ledger_id is not null
      and p_upload_id is null
      and p_phase in ('first', 'final')
    )
  )
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  if p_kind = 'temporary' then
    select upload_row.user_id
    into v_user_id
    from private.personal_card_temp_uploads as upload_row
    where upload_row.id = p_upload_id;
  else
    select ledger_row.user_id
    into v_user_id
    from private.personal_card_permanent_object_ledger as ledger_row
    where ledger_row.id = p_ledger_id;
  end if;
  if not found then return jsonb_build_object('status', 'not_found'); end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_user_id::text,
    0
  ));

  if p_kind = 'temporary' then
    select upload_row.*
    into v_upload
    from private.personal_card_temp_uploads as upload_row
    where upload_row.id = p_upload_id
      and upload_row.user_id = v_user_id
    for update;

    if not found then return jsonb_build_object('status', 'not_found'); end if;
    if v_upload.maintenance_cleanup_token is distinct from p_worker_token
      or v_upload.maintenance_cleanup_phase is distinct from p_phase
      or v_upload.maintenance_cleanup_expires_at <= v_now
    then
      return jsonb_build_object('status', 'forbidden');
    end if;

    if not p_deleted then
      update private.personal_card_temp_uploads
      set maintenance_cleanup_next_attempt_at = v_now + interval '5 minutes',
          maintenance_cleanup_token = null,
          maintenance_cleanup_phase = null,
          maintenance_cleanup_expires_at = null
      where id = p_upload_id;
      return jsonb_build_object('status', 'retry');
    end if;

    if p_phase = 'promotion_expired' then
      update private.personal_card_temp_uploads
      set temp_deleted_at = coalesce(temp_deleted_at, v_now),
          expiry_cleanup_started_at = coalesce(expiry_cleanup_started_at, v_now),
          maintenance_cleanup_next_attempt_at = null,
          maintenance_cleanup_token = null,
          maintenance_cleanup_phase = null,
          maintenance_cleanup_expires_at = null
      where id = p_upload_id;
    else
      update private.personal_card_temp_uploads
      set temp_deleted_at = coalesce(temp_deleted_at, v_now),
          cleanup_started_at = coalesce(cleanup_started_at, v_now),
          cleanup_completed_at = coalesce(cleanup_completed_at, v_now),
          maintenance_cleanup_next_attempt_at = null,
          maintenance_cleanup_token = null,
          maintenance_cleanup_phase = null,
          maintenance_cleanup_expires_at = null
      where id = p_upload_id;
    end if;
    return jsonb_build_object('status', 'completed');
  end if;

  select ledger_row.*
  into v_ledger
  from private.personal_card_permanent_object_ledger as ledger_row
  where ledger_row.id = p_ledger_id
    and ledger_row.user_id = v_user_id
  for update;

  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_ledger.lease_token is distinct from p_worker_token
    or v_ledger.lease_expires_at <= v_now
    or p_phase is distinct from (case
      when v_ledger.first_deleted_at is null then 'first'
      else 'final'
    end)
  then
    return jsonb_build_object('status', 'forbidden');
  end if;

  if not p_deleted then
    update private.personal_card_permanent_object_ledger
    set next_attempt_at = v_now + interval '5 minutes',
        lease_token = null,
        lease_expires_at = null
    where id = p_ledger_id;
    return jsonb_build_object('status', 'retry');
  end if;

  if p_phase = 'first' then
    update private.personal_card_permanent_object_ledger
    set first_deleted_at = v_now,
        final_delete_after = greatest(
          v_ledger.final_delete_not_before,
          v_ledger.final_delete_after,
          v_now + interval '10 minutes'
        ),
        next_attempt_at = greatest(
          v_ledger.final_delete_not_before,
          v_ledger.final_delete_after,
          v_now + interval '10 minutes'
        ),
        lease_token = null,
        lease_expires_at = null
    where id = p_ledger_id;
    return jsonb_build_object('status', 'recorded');
  end if;

  if greatest(v_ledger.final_delete_not_before, v_ledger.final_delete_after) > v_now then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if exists (
    select 1
    from public.personal_cards as card_row
    where card_row.user_id = v_ledger.user_id
      and card_row.photo_path = v_ledger.object_path
  ) then
    delete from private.personal_card_permanent_object_ledger
    where id = p_ledger_id;
    return jsonb_build_object('status', 'referenced');
  end if;

  delete from private.personal_card_permanent_object_ledger
  where id = p_ledger_id;
  return jsonb_build_object('status', 'completed');
end;
$$;

create or replace function api_private.get_personal_card_storage_cleanup_backlog()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with due_items as (
    select
      'promotion_expired'::text as phase,
      upload_row.promotion_expires_at as due_at
    from private.personal_card_temp_uploads as upload_row
    join public.app_users as user_row on user_row.id = upload_row.user_id
    where upload_row.promotion_expires_at <= statement_timestamp()
      and upload_row.signed_url_expires_at > statement_timestamp()
      and upload_row.promoted_at is null
      and upload_row.temp_deleted_at is null
      and user_row.deletion_requested_at is null
      and not exists (
        select 1
        from private.personal_card_field_object_ledger as field_row
        where field_row.object_path = upload_row.temp_path
      )

    union all

    select
      'signed_url_expired',
      upload_row.signed_url_expires_at + interval '10 minutes'
    from private.personal_card_temp_uploads as upload_row
    join public.app_users as user_row on user_row.id = upload_row.user_id
    where upload_row.signed_url_expires_at + interval '10 minutes'
        <= statement_timestamp()
      and upload_row.cleanup_completed_at is null
      and user_row.deletion_requested_at is null
      and not exists (
        select 1
        from private.personal_card_field_object_ledger as field_row
        where field_row.object_path = upload_row.temp_path
      )

    union all

    select
      'permanent',
      ledger_row.next_attempt_at
    from private.personal_card_permanent_object_ledger as ledger_row
    join public.app_users as user_row on user_row.id = ledger_row.user_id
    where ledger_row.next_attempt_at <= statement_timestamp()
      and user_row.deletion_requested_at is null
      and not (
        ledger_row.origin = 'promotion'
        and exists (
          select 1
          from private.personal_card_temp_uploads as upload_row
          where upload_row.id = ledger_row.upload_id
            and upload_row.processing_token = ledger_row.processing_token
            and upload_row.processing_permanent_path = ledger_row.object_path
            and upload_row.promoted_at is null
            and upload_row.processing_expires_at > statement_timestamp()
        )
      )
  )
  select jsonb_build_object(
    'status', 'ready',
    'total_pending', count(*),
    'promotion_expired_pending', count(*) filter (where phase = 'promotion_expired'),
    'signed_url_expired_pending', count(*) filter (where phase = 'signed_url_expired'),
    'permanent_pending', count(*) filter (where phase = 'permanent'),
    'overdue_15m', count(*) filter (
      where due_at <= statement_timestamp() - interval '15 minutes'
    ),
    'oldest_due_at', min(due_at)
  )
  from due_items
$$;

-- Preserve the location-compliance worker contract while guaranteeing that
-- every path returned to Node is durably closed before external Storage I/O.
-- Replace candidate selection as well: deletion-requested owners and paths
-- currently leased by the unified temp worker must be excluded before the
-- field lease UPDATE, not filtered from an already-leased result.
alter function api_private.claim_personal_card_field_object_cleanup(uuid, integer)
  rename to claim_personal_card_field_object_cleanup_before_exact_tombstone;

create or replace function api_private.claim_personal_card_field_object_cleanup(
  p_worker_token uuid,
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate record;
  v_ledger private.personal_card_field_object_ledger%rowtype;
  v_items jsonb := '[]'::jsonb;
  v_phase text;
  v_now timestamptz := clock_timestamp();
begin
  if p_worker_token is null or p_limit is null or p_limit not between 1 and 4 then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- Candidate discovery is only a hint. Cheap ownership and mutual-exclusion
  -- predicates run before LIMIT so stale/deleting owners cannot fill the
  -- candidate window and starve eligible accounts.
  for v_candidate in
    select ledger_row.id, ledger_row.user_id
    from private.personal_card_field_object_ledger as ledger_row
    join public.app_users as user_row on user_row.id = ledger_row.user_id
    where ledger_row.next_attempt_at <= v_now
      and (
        ledger_row.lease_token is null
        or ledger_row.lease_expires_at <= v_now
      )
      and user_row.deletion_requested_at is null
      and (
        ledger_row.first_deleted_at is null
        or greatest(
          ledger_row.final_delete_not_before,
          ledger_row.final_delete_after
        ) <= v_now
      )
      and not exists (
        select 1
        from private.data_erasure_manifest as item_row
        join private.data_erasure_jobs as job_row on job_row.id = item_row.job_id
        where job_row.state <> 'completed'
          and item_row.bucket = ledger_row.bucket
          and item_row.object_path = ledger_row.object_path
      )
      and not exists (
        select 1
        from private.account_deletion_storage_manifest as item_row
        join private.account_deletion_jobs as job_row
          on job_row.id = item_row.request_id
        where job_row.status <> 'completed'
          and item_row.bucket = ledger_row.bucket
          and item_row.object_path = ledger_row.object_path
      )
      and not exists (
        select 1
        from private.personal_card_temp_uploads as upload_row
        where upload_row.id = ledger_row.upload_id
          and upload_row.user_id = ledger_row.user_id
          and upload_row.processing_acquisition_id = ledger_row.field_acquisition_id
          and upload_row.processing_token = ledger_row.processing_token
          and upload_row.promoted_at is null
          and upload_row.processing_expires_at > v_now
      )
      and not (
        ledger_row.bucket = 'personal-card-temp'
        and exists (
          select 1
          from private.personal_card_temp_uploads as upload_row
          where upload_row.id = ledger_row.upload_id
            and upload_row.maintenance_cleanup_token is not null
            and upload_row.maintenance_cleanup_expires_at > v_now
        )
      )
    order by ledger_row.next_attempt_at, ledger_row.user_id, ledger_row.id
    limit 64
  loop
    exit when jsonb_array_length(v_items) >= p_limit;

    perform pg_advisory_xact_lock(hashtextextended(
      'danyeodam:suspend-owner:' || v_candidate.user_id::text,
      0
    ));

    if not exists (
      select 1
      from public.app_users as user_row
      where user_row.id = v_candidate.user_id
        and user_row.deletion_requested_at is null
    ) then
      continue;
    end if;

    select ledger_row.*
    into v_ledger
    from private.personal_card_field_object_ledger as ledger_row
    where ledger_row.id = v_candidate.id
      and ledger_row.user_id = v_candidate.user_id
    for update;

    if not found
      or v_ledger.next_attempt_at > v_now
      or (
        v_ledger.lease_token is not null
        and v_ledger.lease_expires_at > v_now
      )
    then
      continue;
    end if;

    -- Exact committed ownership wins over cleanup and self-heals a response
    -- that was lost after the card transaction committed.
    if v_ledger.state = 'active'
      and v_ledger.bucket = 'personal-cards'
      and exists (
        select 1
        from public.personal_cards as card_row
        where card_row.user_id = v_ledger.user_id
          and card_row.acquisition_id = v_ledger.field_acquisition_id
          and card_row.photo_path = v_ledger.object_path
      )
    then
      delete from private.personal_card_field_object_ledger
      where id = v_ledger.id;
      continue;
    end if;

    if v_ledger.state = 'active'
      and v_ledger.bucket = 'personal-card-temp'
      and exists (
        select 1
        from private.personal_card_temp_uploads as upload_row
        where upload_row.id = v_ledger.upload_id
          and upload_row.cleanup_completed_at is not null
      )
    then
      delete from private.personal_card_field_object_ledger
      where id = v_ledger.id;
      continue;
    end if;

    if exists (
      select 1
      from private.data_erasure_manifest as item_row
      join private.data_erasure_jobs as job_row on job_row.id = item_row.job_id
      where job_row.state <> 'completed'
        and item_row.bucket = v_ledger.bucket
        and item_row.object_path = v_ledger.object_path
    ) or exists (
      select 1
      from private.account_deletion_storage_manifest as item_row
      join private.account_deletion_jobs as job_row
        on job_row.id = item_row.request_id
      where job_row.status <> 'completed'
        and item_row.bucket = v_ledger.bucket
        and item_row.object_path = v_ledger.object_path
    ) then
      continue;
    end if;

    if v_ledger.state = 'active' and exists (
      select 1
      from private.personal_card_temp_uploads as upload_row
      where upload_row.id = v_ledger.upload_id
        and upload_row.user_id = v_ledger.user_id
        and upload_row.processing_acquisition_id = v_ledger.field_acquisition_id
        and upload_row.processing_token = v_ledger.processing_token
        and upload_row.promoted_at is null
        and upload_row.processing_expires_at > v_now
    ) then
      continue;
    end if;

    if v_ledger.bucket = 'personal-card-temp' and exists (
      select 1
      from private.personal_card_temp_uploads as upload_row
      where upload_row.id = v_ledger.upload_id
        and upload_row.maintenance_cleanup_token is not null
        and upload_row.maintenance_cleanup_expires_at > v_now
    ) then
      continue;
    end if;

    v_phase := case
      when v_ledger.first_deleted_at is null then 'first'
      else 'final'
    end;
    if v_phase = 'final' and greatest(
      v_ledger.final_delete_after,
      v_ledger.final_delete_not_before
    ) > v_now then
      continue;
    end if;

    update private.personal_card_field_object_ledger
    set state = 'cleanup_pending',
        final_delete_after = greatest(
          v_ledger.final_delete_not_before,
          coalesce(final_delete_after, v_now + interval '10 minutes')
        ),
        attempt_count = attempt_count + 1,
        lease_token = p_worker_token,
        lease_expires_at = v_now + interval '5 minutes'
    where id = v_ledger.id;

    -- The UPDATE trigger covers pre-cutover parsed bodies; keep this explicit
    -- insert at the offered-result boundary as a fail-closed invariant.
    insert into private.personal_card_storage_object_tombstones (object_hash)
    values (private.personal_card_storage_object_hash(
      v_ledger.bucket,
      v_ledger.object_path
    ))
    on conflict (object_hash) do nothing;

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'id', v_ledger.id,
      'bucket', v_ledger.bucket,
      'object_path', v_ledger.object_path,
      'phase', v_phase
    ));
  end loop;

  return jsonb_build_object('status', 'ready', 'items', v_items);
end;
$$;

revoke all on function api_private.claim_personal_card_field_object_cleanup(
  uuid, integer
) from public, anon, authenticated, service_role;
revoke all on function
  api_private.claim_personal_card_field_object_cleanup_before_exact_tombstone(
    uuid, integer
  )
from public, anon, authenticated, service_role;
grant execute on function api_private.claim_personal_card_field_object_cleanup(
  uuid, integer
) to service_role;

revoke all on function api_private.claim_personal_card_storage_cleanup(uuid, integer)
  from public, anon, authenticated, service_role;
revoke all on function api_private.record_personal_card_storage_cleanup_result(
  uuid, text, uuid, bigint, text, boolean
) from public, anon, authenticated, service_role;
revoke all on function api_private.get_personal_card_storage_cleanup_backlog()
  from public, anon, authenticated, service_role;
grant execute on function api_private.claim_personal_card_storage_cleanup(uuid, integer)
  to service_role;
grant execute on function api_private.record_personal_card_storage_cleanup_result(
  uuid, text, uuid, bigint, text, boolean
) to service_role;
grant execute on function api_private.get_personal_card_storage_cleanup_backlog()
  to service_role;

-- The unified lease/token queue is now the only supported temporary-upload
-- worker. Keeping the two timestamp-only claim functions executable would
-- reintroduce dual ownership and permit un-tombstoned late metadata commits.
revoke all on function api_private.list_personal_card_expiry_cleanup(integer)
  from public, anon, authenticated, service_role;
revoke all on function api_private.list_personal_card_temp_cleanup(integer)
  from public, anon, authenticated, service_role;

create or replace function private.account_deletion_public_result(
  p_job private.account_deletion_jobs
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'status', 'accepted',
    'deletion_request', jsonb_build_object(
      'id', p_job.id,
      'status', case
        when p_job.status = 'completed' then 'completed'
        else 'pending'
      end,
      'requested_at', p_job.requested_at,
      'complete_by', p_job.complete_by
    )
  )
$$;

revoke all on function private.account_deletion_public_result(
  private.account_deletion_jobs
) from public, anon, authenticated, service_role;

create or replace function private.begin_account_deletion(
  p_user_id uuid,
  p_request_id uuid,
  p_status_token_hash bytea,
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing private.account_deletion_jobs%rowtype;
  v_job private.account_deletion_jobs%rowtype;
begin
  if p_user_id is null
    or p_request_id is null
    or p_status_token_hash is null
    or octet_length(p_status_token_hash) <> 32
  then
    raise exception 'invalid account deletion request'
      using errcode = '22023';
  end if;

  select job_row.*
  into v_existing
  from private.account_deletion_jobs as job_row
  where job_row.id = p_request_id;

  if found then
    if v_existing.status_token_hash = p_status_token_hash
      and (v_existing.user_id = p_user_id or v_existing.user_id is null)
    then
      return private.account_deletion_public_result(v_existing);
    end if;
    return jsonb_build_object('status', 'idempotency_conflict');
  end if;

  select job_row.*
  into v_existing
  from private.account_deletion_jobs as job_row
  where job_row.user_id = p_user_id;

  if found then
    if v_existing.status_token_hash = p_status_token_hash
      and v_existing.id = p_request_id
    then
      return private.account_deletion_public_result(v_existing);
    end if;
    return jsonb_build_object('status', 'already_requested');
  end if;

  insert into private.account_deletion_jobs (
    id,
    user_id,
    status_token_hash,
    storage_prefix,
    requested_at,
    complete_by,
    next_attempt_at,
    updated_at
  ) values (
    p_request_id,
    p_user_id,
    p_status_token_hash,
    p_user_id,
    p_now,
    p_now + interval '24 hours',
    p_now,
    p_now
  ) returning * into v_job;

  insert into private.account_deletion_storage_prefix_tombstones (
    prefix_hash
  ) values (
    extensions.hmac(
      convert_to(
        'danyeodam:account-delete-storage-prefix:v1:' || p_user_id::text,
        'UTF8'
      ),
      (
        select key_row.secret
        from private.account_deletion_storage_tombstone_key as key_row
        where key_row.singleton
      ),
      'sha256'
    )
  ) on conflict (prefix_hash) do nothing;

  -- Delete only Auth users that are not currently bound to another logical
  -- account. Recovery can legitimately move an Auth UID away from an older
  -- user; deleting that UID would delete the new owner's credential.
  insert into private.account_deletion_auth_manifest (
    request_id,
    auth_user_id
  )
  select distinct p_request_id, identity_row.auth_user_id
  from private.user_identities as identity_row
  where identity_row.user_id = p_user_id
    and not exists (
      select 1
      from private.user_identities as other_identity
      where other_identity.auth_user_id = identity_row.auth_user_id
        and other_identity.user_id <> p_user_id
        and other_identity.revoked_at is null
    )
  on conflict do nothing;

  -- Snapshot every durable source of an owned Storage path, including paths
  -- already controlled by location erasure and ambiguous-promotion ledgers.
  insert into private.account_deletion_storage_manifest (
    request_id,
    bucket,
    object_path,
    final_delete_after
  )
  select
    p_request_id,
    path_row.bucket,
    path_row.object_path,
    max(path_row.final_delete_after)
  from (
    select
      'personal-cards'::text as bucket,
      card_row.photo_path as object_path,
      p_now + interval '10 minutes' as final_delete_after
    from public.personal_cards as card_row
    where card_row.user_id = p_user_id

    union all

    select
      'personal-card-temp',
      upload_row.temp_path,
      greatest(
        upload_row.signed_url_expires_at + interval '10 minutes',
        p_now + interval '10 minutes'
      )
    from private.personal_card_temp_uploads as upload_row
    where upload_row.user_id = p_user_id
      and upload_row.cleanup_completed_at is null

    union all

    select
      'personal-cards',
      upload_row.processing_permanent_path,
      p_now + interval '10 minutes'
    from private.personal_card_temp_uploads as upload_row
    where upload_row.user_id = p_user_id
      and upload_row.cleanup_completed_at is null
      and upload_row.processing_permanent_path is not null

    union all

    select
      'personal-cards',
      upload_row.permanent_path,
      p_now + interval '10 minutes'
    from private.personal_card_temp_uploads as upload_row
    where upload_row.user_id = p_user_id
      and upload_row.cleanup_completed_at is null
      and upload_row.permanent_path is not null

    union all

    select
      ledger_row.bucket,
      ledger_row.object_path,
      greatest(
        ledger_row.final_delete_not_before,
        coalesce(ledger_row.final_delete_after, p_now + interval '10 minutes'),
        p_now + interval '10 minutes'
      )
    from private.personal_card_field_object_ledger as ledger_row
    where ledger_row.user_id = p_user_id

    union all

    select
      'personal-cards',
      ledger_row.object_path,
      greatest(
        ledger_row.final_delete_not_before,
        coalesce(ledger_row.final_delete_after, p_now + interval '10 minutes'),
        p_now + interval '10 minutes'
      )
    from private.personal_card_permanent_object_ledger as ledger_row
    where ledger_row.user_id = p_user_id

    union all

    select
      item_row.bucket,
      item_row.object_path,
      greatest(item_row.final_delete_after, p_now + interval '10 minutes')
    from private.data_erasure_jobs as erasure_job
    join private.data_erasure_manifest as item_row
      on item_row.job_id = erasure_job.id
    where erasure_job.user_id = p_user_id
  ) as path_row
  where path_row.object_path is not null
    and path_row.object_path like p_user_id::text || '/%'
    and path_row.object_path !~ '(^|/)\.\.(/|$)'
  group by path_row.bucket, path_row.object_path
  on conflict (request_id, bucket, object_path) do update
  set final_delete_after = greatest(
    private.account_deletion_storage_manifest.final_delete_after,
    excluded.final_delete_after
  );

  -- Manifest ownership begins in this transaction under the same owner lock.
  -- Remove both standalone queues only after every path and its maximum
  -- final-pass boundary has been copied. Deleting these restrictive child
  -- rows is safe and prevents the location worker from duplicating either
  -- Storage pass while the account request remains pending.
  delete from private.personal_card_field_object_ledger
  where user_id = p_user_id;

  delete from private.personal_card_permanent_object_ledger
  where user_id = p_user_id;

  -- The account-deletion manifest now owns all pending location-erasure paths.
  -- Removing those jobs under the owner lock prevents a second DB cleanup
  -- state machine from racing the final account deletion.
  delete from private.data_erasure_jobs
  where user_id = p_user_id;

  update public.app_users
  set deletion_requested_at = p_now,
      updated_at = p_now
  where id = p_user_id;

  update private.user_identities
  set revoked_at = coalesce(revoked_at, p_now)
  where user_id = p_user_id;

  update private.participant_access
  set revoked_at = coalesce(revoked_at, p_now)
  where user_id = p_user_id;

  update private.reviewer_accounts
  set revoked_at = coalesce(revoked_at, p_now),
      updated_at = p_now
  where user_id = p_user_id;

  update private.recovery_codes
  set revoked_at = p_now
  where user_id = p_user_id
    and revoked_at is null
    and claimed_at is null;

  -- Clear every public secret in the same transaction. This update matches
  -- the canonical five-state UGC constraint and is independent of age gates.
  update public.personal_cards
  set share_state = 'private',
      share_slug = null,
      shared_at = null,
      share_submitted_at = null,
      share_terms_acceptance_id = null,
      share_community_acceptance_id = null,
      share_resubmission_required = false,
      share_reason_code = null,
      share_reviewed_at = null,
      share_reviewed_by = null,
      share_reviewed_by_redacted_at = null,
      updated_at = p_now
  where user_id = p_user_id;

  return private.account_deletion_public_result(v_job);
end;
$$;

revoke all on function private.begin_account_deletion(
  uuid, uuid, bytea, timestamptz
) from public, anon, authenticated, service_role;

create or replace function api_private.request_account_deletion(
  p_auth_user_id uuid,
  p_request_id uuid,
  p_status_token_hash_hex text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_token_hash bytea;
  v_existing private.account_deletion_jobs%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_auth_user_id is null
    or p_request_id is null
    or p_status_token_hash_hex is null
    or p_status_token_hash_hex !~ '^[0-9A-Fa-f]{64}$'
  then
    raise exception 'invalid account deletion request'
      using errcode = '22023';
  end if;

  v_token_hash := decode(lower(p_status_token_hash_hex), 'hex');

  -- Permit a same-payload transport retry after the first transaction has
  -- revoked the active identity. No other deleted-account operation uses this
  -- manifest-only exception.
  select job_row.*
  into v_existing
  from private.account_deletion_jobs as job_row
  join private.account_deletion_auth_manifest as identity_row
    on identity_row.request_id = job_row.id
   and identity_row.auth_user_id = p_auth_user_id
  where job_row.id = p_request_id;

  if found then
    if v_existing.status_token_hash = v_token_hash then
      return private.account_deletion_public_result(v_existing);
    end if;
    return jsonb_build_object('status', 'idempotency_conflict');
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

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:recovery:target:' || v_user_id::text,
    0
  ));

  perform identity_row.id
  from private.user_identities as identity_row
  where identity_row.user_id = v_user_id
     or identity_row.auth_user_id = p_auth_user_id
  order by identity_row.user_id::text, identity_row.auth_user_id::text
  for update;

  if not exists (
    select 1
    from private.user_identities as identity_row
    join auth.users as auth_user
      on auth_user.id = identity_row.auth_user_id
    where identity_row.auth_user_id = p_auth_user_id
      and identity_row.user_id = v_user_id
      and identity_row.revoked_at is null
      and auth_user.deleted_at is null
  ) then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_user_id::text,
    0
  ));

  return private.begin_account_deletion(
    v_user_id,
    p_request_id,
    v_token_hash,
    v_now
  );
end;
$$;

create or replace function private.consume_account_deletion_rate_limit(
  p_scope text,
  p_subject_hash bytea,
  p_limit integer,
  p_window_seconds integer,
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window_start timestamptz;
  v_count integer;
  v_retry_after integer;
begin
  if p_subject_hash is null or octet_length(p_subject_hash) <> 32 then
    raise exception 'invalid account deletion rate limit subject'
      using errcode = '22023';
  end if;

  if not (
    (p_scope = 'account_deletion_recovery_ip' and p_limit = 20 and p_window_seconds = 3600)
    or (p_scope = 'account_deletion_recovery_subject' and p_limit = 5 and p_window_seconds = 900)
    or (p_scope = 'account_deletion_status_ip' and p_limit = 60 and p_window_seconds = 60)
  ) then
    raise exception 'unsupported account deletion rate limit'
      using errcode = '22023';
  end if;

  -- Public rights requests must not inherit an unbounded global cleanup. The
  -- worker performs the main bounded purge; this opportunistic batch merely
  -- keeps normal traffic tidy without turning one request into table cleanup.
  with expired as (
    select limit_row.scope, limit_row.subject_hash, limit_row.window_started_at
    from private.account_deletion_rate_limits as limit_row
    where limit_row.expires_at <= p_now
    order by limit_row.expires_at
    limit 100
  )
  delete from private.account_deletion_rate_limits as limit_row
  using expired
  where limit_row.scope = expired.scope
    and limit_row.subject_hash = expired.subject_hash
    and limit_row.window_started_at = expired.window_started_at;

  v_window_start := to_timestamp(
    floor(extract(epoch from p_now) / p_window_seconds) * p_window_seconds
  );

  insert into private.account_deletion_rate_limits (
    scope,
    subject_hash,
    window_started_at,
    request_count,
    expires_at
  ) values (
    p_scope,
    p_subject_hash,
    v_window_start,
    1,
    least(
      v_window_start + make_interval(secs => p_window_seconds) + interval '1 hour',
      v_window_start + interval '48 hours'
    )
  )
  on conflict (scope, subject_hash, window_started_at) do update
  set request_count = private.account_deletion_rate_limits.request_count + 1
  returning request_count into v_count;

  v_retry_after := greatest(
    1,
    ceil(extract(epoch from (
      v_window_start + make_interval(secs => p_window_seconds) - p_now
    )))::integer
  );

  return jsonb_build_object(
    'status', case when v_count <= p_limit then 'allowed' else 'rate_limited' end,
    'retry_after_seconds', v_retry_after
  );
end;
$$;

revoke all on function private.consume_account_deletion_rate_limit(
  text, bytea, integer, integer, timestamptz
) from public, anon, authenticated, service_role;

create or replace function api_private.consume_account_deletion_public_rate_limit(
  p_scope text,
  p_subject_hash_hex text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_window_seconds integer;
begin
  if p_subject_hash_hex is null
    or p_subject_hash_hex !~ '^[0-9A-Fa-f]{64}$'
  then
    raise exception 'invalid public account deletion rate-limit digest'
      using errcode = '22023';
  end if;

  case p_scope
    when 'account_deletion_recovery_ip' then
      v_limit := 20;
      v_window_seconds := 3600;
    when 'account_deletion_status_ip' then
      v_limit := 60;
      v_window_seconds := 60;
    else
      raise exception 'unsupported account deletion rate-limit scope'
        using errcode = '22023';
  end case;

  return private.consume_account_deletion_rate_limit(
    p_scope,
    decode(lower(p_subject_hash_hex), 'hex'),
    v_limit,
    v_window_seconds,
    clock_timestamp()
  );
end;
$$;

create or replace function api_private.request_account_deletion_by_recovery(
  p_recovery_code_hash_hex text,
  p_request_id uuid,
  p_status_token_hash_hex text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code_hash bytea;
  v_token_hash bytea;
  v_code private.recovery_codes%rowtype;
  v_existing private.account_deletion_jobs%rowtype;
  v_rate jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if p_request_id is null
    or p_recovery_code_hash_hex is null
    or p_recovery_code_hash_hex !~ '^[0-9A-Fa-f]{64}$'
    or p_status_token_hash_hex is null
    or p_status_token_hash_hex !~ '^[0-9A-Fa-f]{64}$'
  then
    raise exception 'invalid recovery account deletion request'
      using errcode = '22023';
  end if;

  v_code_hash := decode(lower(p_recovery_code_hash_hex), 'hex');
  v_token_hash := decode(lower(p_status_token_hash_hex), 'hex');

  select job_row.*
  into v_existing
  from private.account_deletion_jobs as job_row
  where job_row.id = p_request_id;

  if found then
    if v_existing.status_token_hash = v_token_hash then
      return private.account_deletion_public_result(v_existing);
    end if;
    return jsonb_build_object('status', 'idempotency_conflict');
  end if;

  v_rate := private.consume_account_deletion_rate_limit(
    'account_deletion_recovery_subject',
    v_code_hash,
    5,
    900,
    v_now
  );
  if v_rate ->> 'status' = 'rate_limited' then return v_rate; end if;

  select code_row.*
  into v_code
  from private.recovery_codes as code_row
  where code_row.code_hash = v_code_hash
    and code_row.revoked_at is null
    and code_row.claimed_at is null
    and (code_row.expires_at is null or code_row.expires_at > v_now);

  if not found then return jsonb_build_object('status', 'not_found'); end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:recovery:target:' || v_code.user_id::text,
    0
  ));

  perform identity_row.id
  from private.user_identities as identity_row
  where identity_row.user_id = v_code.user_id
  order by identity_row.user_id::text, identity_row.auth_user_id::text
  for update;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_code.user_id::text,
    0
  ));

  select code_row.*
  into v_code
  from private.recovery_codes as code_row
  where code_row.id = v_code.id
    and code_row.code_hash = v_code_hash
    and code_row.revoked_at is null
    and code_row.claimed_at is null
    and (code_row.expires_at is null or code_row.expires_at > v_now)
  for update;

  if not found then return jsonb_build_object('status', 'not_found'); end if;

  return private.begin_account_deletion(
    v_code.user_id,
    p_request_id,
    v_token_hash,
    v_now
  );
end;
$$;

create or replace function api_private.get_account_deletion_status_candidate(
  p_request_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select jsonb_build_object(
        'status', 'found',
        'status_token_hash', encode(job_row.status_token_hash, 'hex'),
        'id', job_row.id,
        'public_status', case
          when job_row.status = 'completed' then 'completed'
          else 'pending'
        end,
        'reason_code', case
          when job_row.status = 'completed' then null
          when job_row.complete_by <= statement_timestamp() then 'overdue'
          when job_row.last_error_code is not null then 'retrying'
          else 'processing'
        end,
        'requested_at', job_row.requested_at,
        'complete_by', job_row.complete_by,
        'completed_at', job_row.completed_at
      )
      from private.account_deletion_jobs as job_row
      where job_row.id = p_request_id
        and (
          job_row.receipt_expires_at is null
          or job_row.receipt_expires_at > statement_timestamp()
        )
    ),
    jsonb_build_object('status', 'not_found')
  )
$$;

create or replace function private.hard_delete_account_product_data(
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null then
    raise exception 'account deletion user is missing'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:recovery:target:' || p_user_id::text,
    0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || p_user_id::text,
    0
  ));

  -- Location jobs and field-object ledgers have restrictive children. They
  -- are safe to remove only after the account worker has completed both
  -- Storage passes for its superset manifest.
  delete from private.data_erasure_jobs
  where user_id = p_user_id;

  delete from private.personal_card_field_object_ledger
  where user_id = p_user_id;

  delete from private.personal_card_permanent_object_ledger
  where user_id = p_user_id;

  -- Avoid restrictive/cross-audit ordering during the final app_users delete.
  delete from private.user_block_actions
  where blocker_user_id = p_user_id
     or blocked_user_id = p_user_id;

  delete from private.user_blocks
  where blocker_user_id = p_user_id
     or blocked_user_id = p_user_id;

  -- These BEFORE DELETE triggers redact retained reports and moderation
  -- audits before owned rows disappear.
  delete from public.personal_cards
  where user_id = p_user_id;

  delete from private.personal_card_temp_uploads
  where user_id = p_user_id;

  delete from private.location_consents
  where user_id = p_user_id;

  delete from private.location_correction_requests
  where user_id = p_user_id;

  delete from private.policy_acceptances
  where user_id = p_user_id;

  delete from private.location_attempt_tombstones
  where owner_fingerprint = private.location_attempt_owner_fingerprint(p_user_id);

  -- The remaining owner-bound rows use ON DELETE CASCADE/SET NULL. The
  -- app_users trigger first redacts invite redemption and retained UGC audit.
  delete from public.app_users
  where id = p_user_id;

  if not found then
    raise exception 'account deletion user disappeared unexpectedly'
      using errcode = '40001';
  end if;
end;
$$;

revoke all on function private.hard_delete_account_product_data(uuid)
  from public, anon, authenticated, service_role;

create or replace function api_private.claim_account_deletion_jobs(
  p_worker_token uuid,
  p_job_limit integer default 1,
  p_item_limit integer default 4
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_jobs jsonb;
begin
  if p_worker_token is null
    or p_job_limit <> 1
    or p_item_limit is null
    or p_item_limit not between 1 and 4
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  with expired as (
    select job_row.id
    from private.account_deletion_jobs as job_row
    where job_row.status = 'completed'
      and job_row.receipt_expires_at <= v_now
    order by job_row.receipt_expires_at, job_row.id
    limit 250
  )
  delete from private.account_deletion_jobs as job_row
  using expired
  where job_row.id = expired.id;

  with expired as (
    select limit_row.scope, limit_row.subject_hash, limit_row.window_started_at
    from private.account_deletion_rate_limits as limit_row
    where limit_row.expires_at <= v_now
    order by limit_row.expires_at
    limit 1000
  )
  delete from private.account_deletion_rate_limits as limit_row
  using expired
  where limit_row.scope = expired.scope
    and limit_row.subject_hash = expired.subject_hash
    and limit_row.window_started_at = expired.window_started_at;

  with candidate as (
    select job_row.id
    from private.account_deletion_jobs as job_row
    where (
      job_row.status = 'pending'
      and job_row.next_attempt_at <= v_now
    ) or (
      job_row.status = 'processing'
      and job_row.lease_expires_at <= v_now
    )
    -- A storage page yields briefly before it can be reclaimed. Order by the
    -- due time first so one large oldest account cannot monopolize every
    -- batch in a maintenance invocation while newer due requests starve.
    order by
      case
        when job_row.status = 'processing' then job_row.lease_expires_at
        else job_row.next_attempt_at
      end,
      job_row.requested_at,
      job_row.id
    for update skip locked
    limit p_job_limit
  ), leased as (
    update private.account_deletion_jobs as job_row
    set status = 'processing',
        lease_token = p_worker_token,
        lease_expires_at = v_now + interval '5 minutes',
        attempt_count = job_row.attempt_count + 1,
        updated_at = v_now
    from candidate
    where job_row.id = candidate.id
    returning job_row.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', leased.id,
    'phase', leased.phase,
    'storage_prefix', leased.storage_prefix,
    'storage_items', case
      when leased.phase in ('storage_initial', 'storage_final') then coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', item_row.id,
          'bucket', item_row.bucket,
          'object_path', item_row.object_path,
          'pass', case
            when item_row.first_deleted_at is null then 'first'
            else 'final'
          end
        ) order by item_row.id)
        from (
          select manifest_row.*
          from private.account_deletion_storage_manifest as manifest_row
          where manifest_row.request_id = leased.id
            and manifest_row.deleted_at is null
            and (
              manifest_row.first_deleted_at is null
              or (
                leased.phase = 'storage_final'
                and manifest_row.final_delete_after <= v_now
              )
            )
          order by
            case when manifest_row.first_deleted_at is null then 0 else 1 end,
            manifest_row.final_delete_after,
            manifest_row.id
          limit p_item_limit
        ) as item_row
      ), '[]'::jsonb)
      else '[]'::jsonb
    end,
    'auth_user_ids', case
      when leased.phase = 'auth' then coalesce((
        select jsonb_agg(identity_row.auth_user_id order by identity_row.auth_user_id)
        from (
          select manifest_row.auth_user_id
          from private.account_deletion_auth_manifest as manifest_row
          where manifest_row.request_id = leased.id
          order by manifest_row.auth_user_id
          limit p_item_limit
        ) as identity_row
      ), '[]'::jsonb)
      else '[]'::jsonb
    end
  ) order by leased.requested_at, leased.id), '[]'::jsonb)
  into v_jobs
  from leased;

  return jsonb_build_object('status', 'ready', 'jobs', v_jobs);
end;
$$;

create or replace function api_private.register_account_deletion_storage_paths(
  p_request_id uuid,
  p_worker_token uuid,
  p_paths jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job private.account_deletion_jobs%rowtype;
  v_now timestamptz := clock_timestamp();
  v_registered integer;
begin
  if p_paths is null
    or jsonb_typeof(p_paths) is distinct from 'array'
    or jsonb_array_length(p_paths) not between 1 and 4
    or exists (
      select 1
      from jsonb_array_elements(p_paths) as path_row(value)
      where jsonb_typeof(path_row.value) is distinct from 'object'
        or not (path_row.value ?& array['bucket', 'object_path']::text[])
        or path_row.value - array['bucket', 'object_path']::text[] <> '{}'::jsonb
        or jsonb_typeof(path_row.value -> 'bucket') is distinct from 'string'
        or path_row.value ->> 'bucket' not in ('personal-card-temp', 'personal-cards')
        or jsonb_typeof(path_row.value -> 'object_path') is distinct from 'string'
    )
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  select job_row.*
  into v_job
  from private.account_deletion_jobs as job_row
  where job_row.id = p_request_id
  for update;

  if not found
    or v_job.status <> 'processing'
    or v_job.phase not in ('storage_initial', 'storage_final')
    or v_job.lease_token is distinct from p_worker_token
    or v_job.lease_expires_at <= v_now
    or v_job.storage_prefix is null
  then
    return jsonb_build_object('status', 'forbidden');
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_paths) as path_row(value)
    where char_length(path_row.value ->> 'object_path') not between 1 and 512
      or path_row.value ->> 'object_path'
        not like v_job.storage_prefix::text || '/%'
      or path_row.value ->> 'object_path' ~ '(^|/)\.\.(/|$)'
  ) then
    return jsonb_build_object('status', 'invalid');
  end if;

  insert into private.account_deletion_storage_manifest (
    request_id,
    bucket,
    object_path,
    final_delete_after
  )
  select
    p_request_id,
    path_row.value ->> 'bucket',
    path_row.value ->> 'object_path',
    v_now + interval '10 minutes'
  from jsonb_array_elements(p_paths) as path_row(value)
  on conflict (request_id, bucket, object_path) do update
  set first_deleted_at = null,
      deleted_at = null,
      final_delete_after = greatest(
        private.account_deletion_storage_manifest.final_delete_after,
        excluded.final_delete_after
      );
  get diagnostics v_registered = row_count;

  return jsonb_build_object('status', 'registered', 'count', v_registered);
end;
$$;

create or replace function api_private.record_account_deletion_storage_result(
  p_request_id uuid,
  p_worker_token uuid,
  p_item_id bigint,
  p_pass text,
  p_deleted boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job private.account_deletion_jobs%rowtype;
  v_item private.account_deletion_storage_manifest%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_item_id is null
    or p_pass not in ('first', 'final')
    or p_deleted is null
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  select job_row.*
  into v_job
  from private.account_deletion_jobs as job_row
  where job_row.id = p_request_id
  for update;

  if not found
    or v_job.status <> 'processing'
    or v_job.phase not in ('storage_initial', 'storage_final')
    or v_job.lease_token is distinct from p_worker_token
    or v_job.lease_expires_at <= v_now
  then
    return jsonb_build_object('status', 'forbidden');
  end if;

  select item_row.*
  into v_item
  from private.account_deletion_storage_manifest as item_row
  where item_row.id = p_item_id
    and item_row.request_id = p_request_id
  for update;

  if not found then return jsonb_build_object('status', 'not_found'); end if;

  if p_pass = 'first' and v_item.first_deleted_at is not null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if p_pass = 'final' and (
    v_item.first_deleted_at is null
    or v_item.final_delete_after > v_now
    or v_item.deleted_at is not null
  ) then
    return jsonb_build_object('status', 'not_found');
  end if;

  update private.account_deletion_storage_manifest
  set attempt_count = attempt_count + 1,
      last_attempt_at = v_now,
      first_deleted_at = case
        when p_deleted and p_pass = 'first' then v_now
        else first_deleted_at
      end,
      final_delete_after = case
        when p_deleted and p_pass = 'first'
          then greatest(final_delete_after, v_now + interval '10 minutes')
        else final_delete_after
      end,
      deleted_at = case
        when p_deleted and p_pass = 'final' then v_now
        else deleted_at
      end
  where id = p_item_id;

  return jsonb_build_object(
    'status', case when p_deleted then 'recorded' else 'retry' end
  );
end;
$$;

create or replace function api_private.mark_account_deletion_auth_removed(
  p_request_id uuid,
  p_worker_token uuid,
  p_auth_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job private.account_deletion_jobs%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  select job_row.*
  into v_job
  from private.account_deletion_jobs as job_row
  where job_row.id = p_request_id
  for update;

  if not found
    or v_job.status <> 'processing'
    or v_job.phase <> 'auth'
    or v_job.lease_token is distinct from p_worker_token
    or v_job.lease_expires_at <= v_now
  then
    return jsonb_build_object('status', 'forbidden');
  end if;

  delete from private.account_deletion_auth_manifest
  where request_id = p_request_id
    and auth_user_id = p_auth_user_id;

  return jsonb_build_object(
    'status', case when found then 'removed' else 'not_found' end
  );
end;
$$;

create or replace function api_private.advance_account_deletion_job(
  p_request_id uuid,
  p_worker_token uuid,
  p_completed_phase text,
  p_prefix_scan_empty boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job private.account_deletion_jobs%rowtype;
  v_now timestamptz := clock_timestamp();
  v_next timestamptz;
  v_user_id uuid;
begin
  select job_row.*
  into v_job
  from private.account_deletion_jobs as job_row
  where job_row.id = p_request_id
  for update;

  if not found
    or v_job.status <> 'processing'
    or v_job.lease_token is distinct from p_worker_token
    or v_job.lease_expires_at <= v_now
    or v_job.phase <> p_completed_phase
  then
    return jsonb_build_object('status', 'forbidden');
  end if;

  if p_completed_phase = 'storage_initial' then
    if not coalesce(p_prefix_scan_empty, false)
      or exists (
        select 1
        from private.account_deletion_storage_manifest as item_row
        where item_row.request_id = p_request_id
          and item_row.first_deleted_at is null
      )
    then
      update private.account_deletion_jobs
      set status = 'pending',
          next_attempt_at = v_now + interval '5 seconds',
          consecutive_failure_count = 0,
          last_error_code = null,
          last_error_at = null,
          lease_token = null,
          lease_expires_at = null,
          updated_at = v_now
      where id = p_request_id;
      return jsonb_build_object('status', 'retry');
    end if;

    select coalesce(min(item_row.final_delete_after), v_now)
    into v_next
    from private.account_deletion_storage_manifest as item_row
    where item_row.request_id = p_request_id
      and item_row.deleted_at is null;

    update private.account_deletion_jobs
    set status = 'pending',
        phase = 'storage_final',
        next_attempt_at = greatest(v_next, v_now),
        consecutive_failure_count = 0,
        last_error_code = null,
        last_error_at = null,
        lease_token = null,
        lease_expires_at = null,
        updated_at = v_now
    where id = p_request_id;
    return jsonb_build_object('status', 'advanced');

  elsif p_completed_phase = 'storage_final' then
    if not coalesce(p_prefix_scan_empty, false)
      or exists (
        select 1
        from private.account_deletion_storage_manifest as item_row
        where item_row.request_id = p_request_id
          and item_row.first_deleted_at is null
      )
    then
      v_next := v_now;
    else
      select min(item_row.final_delete_after)
      into v_next
      from private.account_deletion_storage_manifest as item_row
      where item_row.request_id = p_request_id
        and item_row.deleted_at is null;
    end if;

    if not coalesce(p_prefix_scan_empty, false) or v_next is not null then
      update private.account_deletion_jobs
      set status = 'pending',
          next_attempt_at = greatest(
            coalesce(v_next, v_now + interval '5 seconds'),
            v_now + interval '5 seconds'
          ),
          final_storage_empty_at = null,
          consecutive_failure_count = 0,
          last_error_code = null,
          last_error_at = null,
          lease_token = null,
          lease_expires_at = null,
          updated_at = v_now
      where id = p_request_id;
      return jsonb_build_object('status', 'retry');
    end if;

    -- The permanent prefix tombstone and Storage metadata trigger reject late
    -- commits after deletion starts. Keep a second empty listing separated by
    -- a quarantine interval as defense in depth before durable correlations
    -- are removed; this does not depend on an external gateway timeout.
    if v_job.final_storage_empty_at is null then
      update private.account_deletion_jobs
      set status = 'pending',
          next_attempt_at = v_now + interval '70 minutes',
          final_storage_empty_at = v_now,
          consecutive_failure_count = 0,
          last_error_code = null,
          last_error_at = null,
          lease_token = null,
          lease_expires_at = null,
          updated_at = v_now
      where id = p_request_id;
      return jsonb_build_object('status', 'retry');
    end if;

    if v_job.final_storage_empty_at + interval '70 minutes' > v_now then
      update private.account_deletion_jobs
      set status = 'pending',
          next_attempt_at = v_job.final_storage_empty_at + interval '70 minutes',
          consecutive_failure_count = 0,
          last_error_code = null,
          last_error_at = null,
          lease_token = null,
          lease_expires_at = null,
          updated_at = v_now
      where id = p_request_id;
      return jsonb_build_object('status', 'retry');
    end if;

    update private.account_deletion_jobs
    set status = 'pending',
        phase = 'database',
        next_attempt_at = v_now,
        final_storage_empty_at = null,
        consecutive_failure_count = 0,
        last_error_code = null,
        last_error_at = null,
        lease_token = null,
        lease_expires_at = null,
        updated_at = v_now
    where id = p_request_id;
    return jsonb_build_object('status', 'advanced');

  elsif p_completed_phase = 'database' then
    v_user_id := v_job.user_id;
    if v_user_id is null then return jsonb_build_object('status', 'not_ready'); end if;

    perform private.hard_delete_account_product_data(v_user_id);

    update private.account_deletion_jobs
    set status = 'pending',
        phase = 'auth',
        database_deleted_at = v_now,
        next_attempt_at = v_now,
        consecutive_failure_count = 0,
        last_error_code = null,
        last_error_at = null,
        lease_token = null,
        lease_expires_at = null,
        updated_at = v_now
    where id = p_request_id;
    return jsonb_build_object('status', 'advanced');

  elsif p_completed_phase = 'auth' then
    if exists (
      select 1
      from private.account_deletion_auth_manifest as identity_row
      where identity_row.request_id = p_request_id
    ) then
      update private.account_deletion_jobs
      set status = 'pending',
          next_attempt_at = v_now,
          consecutive_failure_count = 0,
          last_error_code = null,
          last_error_at = null,
          lease_token = null,
          lease_expires_at = null,
          updated_at = v_now
      where id = p_request_id;
      return jsonb_build_object('status', 'retry');
    end if;

    update private.account_deletion_jobs
    set status = 'pending',
        phase = 'finalize',
        next_attempt_at = v_now,
        consecutive_failure_count = 0,
        last_error_code = null,
        last_error_at = null,
        lease_token = null,
        lease_expires_at = null,
        updated_at = v_now
    where id = p_request_id;
    return jsonb_build_object('status', 'advanced');

  elsif p_completed_phase = 'finalize' then
    if v_job.user_id is not null
      or exists (
        select 1
        from private.account_deletion_auth_manifest as identity_row
        where identity_row.request_id = p_request_id
      )
      or exists (
        select 1
        from private.account_deletion_storage_manifest as item_row
        where item_row.request_id = p_request_id
          and item_row.deleted_at is null
      )
    then
      return jsonb_build_object('status', 'not_ready');
    end if;

    delete from private.account_deletion_storage_manifest
    where request_id = p_request_id;

    update private.account_deletion_jobs
    set status = 'completed',
        phase = 'done',
        storage_prefix = null,
        next_attempt_at = null,
        consecutive_failure_count = 0,
        last_error_code = null,
        last_error_at = null,
        lease_token = null,
        lease_expires_at = null,
        completed_at = v_now,
        result_code = 'DELETED',
        receipt_expires_at = v_now + interval '30 days',
        updated_at = v_now
    where id = p_request_id;
    return jsonb_build_object('status', 'completed');
  end if;

  return jsonb_build_object('status', 'invalid');
end;
$$;

create or replace function api_private.fail_account_deletion_job(
  p_request_id uuid,
  p_worker_token uuid,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job private.account_deletion_jobs%rowtype;
  v_now timestamptz := clock_timestamp();
  v_retry_seconds integer;
begin
  if p_error_code not in (
    'STORAGE_LIST_FAILED',
    'STORAGE_DELETE_FAILED',
    'DATABASE_DELETE_FAILED',
    'AUTH_DELETE_FAILED',
    'WORKER_TIMEOUT',
    'WORKER_UNEXPECTED'
  ) then
    return jsonb_build_object('status', 'invalid');
  end if;

  select job_row.*
  into v_job
  from private.account_deletion_jobs as job_row
  where job_row.id = p_request_id
  for update;

  if not found
    or v_job.status <> 'processing'
    or v_job.lease_token is distinct from p_worker_token
    or v_job.lease_expires_at <= v_now
  then
    return jsonb_build_object('status', 'forbidden');
  end if;

  -- This is deliberately unbounded in retry count. The delay is capped, not
  -- the attempts; overdue/high-attempt aggregates drive human alerts.
  v_retry_seconds := least(
    1800,
    (15 * power(2, least(v_job.consecutive_failure_count, 7)))::integer
  );

  update private.account_deletion_jobs
  set status = 'pending',
      next_attempt_at = v_now + make_interval(secs => v_retry_seconds),
      consecutive_failure_count = consecutive_failure_count + 1,
      last_error_code = p_error_code,
      last_error_at = v_now,
      lease_token = null,
      lease_expires_at = null,
      updated_at = v_now
  where id = p_request_id;

  return jsonb_build_object(
    'status', 'retrying',
    'retry_after_seconds', v_retry_seconds
  );
end;
$$;

create or replace function private.account_deletion_backlog_result()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'status', 'ready',
    'pending_jobs', count(*) filter (where job_row.status <> 'completed'),
    'overdue_jobs', count(*) filter (
      where job_row.status <> 'completed'
        and job_row.complete_by <= statement_timestamp()
    ),
    'high_attempt_jobs', count(*) filter (
      where job_row.status <> 'completed'
        and job_row.consecutive_failure_count >= 10
    ),
    'max_attempt_count', coalesce(max(job_row.consecutive_failure_count) filter (
      where job_row.status <> 'completed'
    ), 0),
    'oldest_requested_at', min(job_row.requested_at) filter (
      where job_row.status <> 'completed'
    ),
    'retrying_jobs', count(*) filter (
      where job_row.status <> 'completed'
        and job_row.last_error_code is not null
    ),
    'completed_receipts', count(*) filter (where job_row.status = 'completed')
  )
  from private.account_deletion_jobs as job_row
$$;

revoke all on function private.account_deletion_backlog_result()
  from public, anon, authenticated, service_role;

create or replace function private.account_deletion_admin_is_active(
  p_admin_auth_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_admin_auth_user_id is not null
    and exists (
      select 1
      from private.user_identities as identity_row
      join auth.users as auth_user
        on auth_user.id = identity_row.auth_user_id
       and auth_user.deleted_at is null
      join private.admin_members as admin_row
        on admin_row.auth_user_id = identity_row.auth_user_id
       and admin_row.revoked_at is null
      where identity_row.auth_user_id = p_admin_auth_user_id
        and identity_row.revoked_at is null
    )
$$;

revoke all on function private.account_deletion_admin_is_active(uuid)
  from public, anon, authenticated, service_role;

create or replace function api_private.get_account_deletion_backlog()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.account_deletion_backlog_result()
$$;

create or replace function api_private.get_account_deletion_backlog_admin(
  p_admin_auth_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.account_deletion_admin_is_active(p_admin_auth_user_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;
  return private.account_deletion_backlog_result();
end;
$$;

create or replace function api_private.list_account_deletion_jobs_admin(
  p_admin_auth_user_id uuid,
  p_status text,
  p_limit integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_items jsonb;
begin
  if not private.account_deletion_admin_is_active(p_admin_auth_user_id) then
    return jsonb_build_object('status', 'forbidden');
  end if;

  if p_status is null
    or p_status not in ('active', 'pending', 'processing', 'completed', 'all')
    or p_limit is null
    or p_limit < 1
    or p_limit > 100
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  select coalesce(jsonb_agg(job_projection.result order by
    job_projection.is_completed,
    job_projection.complete_by,
    job_projection.requested_at,
    job_projection.id
  ), '[]'::jsonb)
  into v_items
  from (
    select
      job_row.id,
      job_row.status = 'completed' as is_completed,
      job_row.complete_by,
      job_row.requested_at,
      jsonb_build_object(
        'id', job_row.id,
        'status', job_row.status,
        'phase', job_row.phase,
        'last_error_code', job_row.last_error_code,
        'last_error_at', job_row.last_error_at,
        'attempt_count', job_row.attempt_count,
        'consecutive_failure_count', job_row.consecutive_failure_count,
        'requested_at', job_row.requested_at,
        'complete_by', job_row.complete_by,
        'next_attempt_at', job_row.next_attempt_at,
        'lease_state', case
          when job_row.lease_token is null then 'none'
          when job_row.lease_expires_at > statement_timestamp() then 'active'
          else 'expired'
        end,
        'lease_expires_at', job_row.lease_expires_at,
        'database_deleted_at', job_row.database_deleted_at,
        'completed_at', job_row.completed_at,
        'updated_at', job_row.updated_at
      ) as result
    from private.account_deletion_jobs as job_row
    where p_status = 'all'
      or (p_status = 'active' and job_row.status <> 'completed')
      or job_row.status = p_status
    order by
      job_row.status = 'completed',
      job_row.complete_by,
      job_row.requested_at,
      job_row.id
    limit p_limit
  ) as job_projection;

  return jsonb_build_object('status', 'ready', 'items', v_items);
end;
$$;

create or replace function api_private.retry_account_deletion_job_admin(
  p_admin_auth_user_id uuid,
  p_request_id uuid,
  p_client_action_id uuid,
  p_reason_code text,
  p_note text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job private.account_deletion_jobs%rowtype;
  v_existing private.account_deletion_admin_actions%rowtype;
  v_result_status text;
  v_result_next_attempt_at timestamptz;
  v_rate_count integer;
  v_rate_oldest timestamptz;
  v_now timestamptz := clock_timestamp();
begin
  if p_admin_auth_user_id is null
    or not exists (
      select 1
      from private.user_identities as identity_row
      join auth.users as auth_user
        on auth_user.id = identity_row.auth_user_id
       and auth_user.deleted_at is null
      join private.admin_members as admin_row
        on admin_row.auth_user_id = identity_row.auth_user_id
       and admin_row.revoked_at is null
      where identity_row.auth_user_id = p_admin_auth_user_id
        and identity_row.revoked_at is null
      for share of identity_row, auth_user, admin_row
    )
  then
    return jsonb_build_object('status', 'forbidden');
  end if;

  if p_request_id is null
    or p_client_action_id is null
    or p_reason_code is null
    or p_reason_code not in (
      'OVERDUE',
      'TRANSIENT_FAILURE',
      'WORKER_STALLED',
      'MANUAL_REVIEW'
    )
    or p_note is null
    or char_length(btrim(p_note)) not between 1 and 500
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:account-deletion-admin-rate:' || p_admin_auth_user_id::text,
    0
  ));

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:account-deletion-admin:'
      || p_admin_auth_user_id::text || ':' || p_client_action_id::text,
    0
  ));

  select action_row.*
  into v_existing
  from private.account_deletion_admin_actions as action_row
  where action_row.admin_auth_user_id = p_admin_auth_user_id
    and action_row.client_action_id = p_client_action_id;

  if found then
    if v_existing.request_id = p_request_id
      and v_existing.action = 'retry'
      and v_existing.reason_code = p_reason_code
      and v_existing.note = btrim(p_note)
    then
      return jsonb_strip_nulls(jsonb_build_object(
        'status', 'duplicate',
        'id', v_existing.request_id,
        'original_status', v_existing.result_status,
        'next_attempt_at', v_existing.result_next_attempt_at
      ));
    end if;
    return jsonb_build_object('status', 'idempotency_conflict');
  end if;

  select count(*)::integer, min(action_row.created_at)
  into v_rate_count, v_rate_oldest
  from private.account_deletion_admin_actions as action_row
  where action_row.admin_auth_user_id = p_admin_auth_user_id
    and action_row.created_at > v_now - interval '1 minute';

  if v_rate_count >= 30 then
    return jsonb_build_object(
      'status', 'rate_limited',
      'retry_after_seconds', greatest(
        1,
        ceil(extract(epoch from (
          v_rate_oldest + interval '1 minute' - v_now
        )))::integer
      )
    );
  end if;

  select job_row.*
  into v_job
  from private.account_deletion_jobs as job_row
  where job_row.id = p_request_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_job.status = 'completed' then
    v_result_status := 'completed';
    v_result_next_attempt_at := null;
  else
    -- A repeated retry for a due, unleased pending job is a no-op. Other
    -- non-completed states are made immediately claimable and any old worker
    -- lease is invalidated. No identity, access, or user row is changed here.
    if not (
      v_job.status = 'pending'
      and v_job.lease_token is null
      and v_job.next_attempt_at is not null
      and v_job.next_attempt_at <= v_now
    ) then
      update private.account_deletion_jobs
      set status = 'pending',
          next_attempt_at = v_now,
          lease_token = null,
          lease_expires_at = null,
          updated_at = v_now
      where id = p_request_id
      returning * into v_job;
    end if;
    v_result_status := 'retry_scheduled';
    v_result_next_attempt_at := v_job.next_attempt_at;
  end if;

  insert into private.account_deletion_admin_actions (
    admin_auth_user_id,
    request_id,
    client_action_id,
    action,
    reason_code,
    note,
    result_status,
    result_next_attempt_at,
    created_at
  ) values (
    p_admin_auth_user_id,
    p_request_id,
    p_client_action_id,
    'retry',
    p_reason_code,
    btrim(p_note),
    v_result_status,
    v_result_next_attempt_at,
    v_now
  );

  return jsonb_strip_nulls(jsonb_build_object(
    'status', v_result_status,
    'id', v_job.id,
    'next_attempt_at', v_result_next_attempt_at
  ));
end;
$$;

revoke all on function api_private.request_account_deletion(uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function api_private.consume_account_deletion_public_rate_limit(text, text)
  from public, anon, authenticated, service_role;
revoke all on function api_private.request_account_deletion_by_recovery(text, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function api_private.get_account_deletion_status_candidate(uuid)
  from public, anon, authenticated, service_role;
revoke all on function api_private.claim_account_deletion_jobs(uuid, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function api_private.register_account_deletion_storage_paths(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function api_private.record_account_deletion_storage_result(
  uuid, uuid, bigint, text, boolean
) from public, anon, authenticated, service_role;
revoke all on function api_private.mark_account_deletion_auth_removed(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function api_private.advance_account_deletion_job(
  uuid, uuid, text, boolean
) from public, anon, authenticated, service_role;
revoke all on function api_private.fail_account_deletion_job(uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function api_private.get_account_deletion_backlog()
  from public, anon, authenticated, service_role;
revoke all on function api_private.get_account_deletion_backlog_admin(uuid)
  from public, anon, authenticated, service_role;
revoke all on function api_private.list_account_deletion_jobs_admin(uuid, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function api_private.retry_account_deletion_job_admin(
  uuid, uuid, uuid, text, text
)
  from public, anon, authenticated, service_role;

grant execute on function api_private.request_account_deletion(uuid, uuid, text)
  to service_role;
grant execute on function api_private.consume_account_deletion_public_rate_limit(text, text)
  to service_role;
grant execute on function api_private.request_account_deletion_by_recovery(text, uuid, text)
  to service_role;
grant execute on function api_private.get_account_deletion_status_candidate(uuid)
  to service_role;
grant execute on function api_private.claim_account_deletion_jobs(uuid, integer, integer)
  to service_role;
grant execute on function api_private.register_account_deletion_storage_paths(uuid, uuid, jsonb)
  to service_role;
grant execute on function api_private.record_account_deletion_storage_result(
  uuid, uuid, bigint, text, boolean
) to service_role;
grant execute on function api_private.mark_account_deletion_auth_removed(uuid, uuid, uuid)
  to service_role;
grant execute on function api_private.advance_account_deletion_job(
  uuid, uuid, text, boolean
) to service_role;
grant execute on function api_private.fail_account_deletion_job(uuid, uuid, text)
  to service_role;
grant execute on function api_private.get_account_deletion_backlog()
  to service_role;
grant execute on function api_private.get_account_deletion_backlog_admin(uuid)
  to service_role;
grant execute on function api_private.list_account_deletion_jobs_admin(uuid, text, integer)
  to service_role;
grant execute on function api_private.retry_account_deletion_job_admin(
  uuid, uuid, uuid, text, text
)
  to service_role;

commit;
