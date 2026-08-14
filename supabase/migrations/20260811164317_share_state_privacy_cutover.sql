-- DANYEODAM v0.3 legacy share privacy cutover.
--
-- This migration is intentionally independent from six-locale content. It
-- must remain deployable to a database that already has acquisitions and
-- personal cards so legacy public shares fail closed before any localized
-- content precondition is evaluated.

create type public.personal_card_share_state as enum (
  'private',
  'pending_review',
  'active',
  'rejected',
  'removed',
  'suspended'
);

create or replace function private.block_share_activation_until_policy_model()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.share_state = 'active'
    and (
      tg_op = 'INSERT'
      or old.share_state is distinct from 'active'
    )
  then
    raise exception
      'active sharing is disabled until policy and moderation controls ship'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

alter table public.personal_cards
  add column share_state public.personal_card_share_state not null
    default 'private',
  add column share_submitted_at timestamptz,
  add column share_terms_acceptance_id uuid,
  add column share_community_acceptance_id uuid,
  add column share_resubmission_required boolean not null default false,
  add column share_reason_code text
    check (
      share_reason_code is null
      or share_reason_code ~ '^[A-Z0-9_]{1,64}$'
    ),
  add column share_reviewed_at timestamptz,
  add column share_reviewed_by uuid references auth.users(id) on delete restrict;

create index personal_cards_share_reviewed_by_idx
  on public.personal_cards(share_reviewed_by);

update public.personal_cards
set share_state = case
      when share_slug is null then 'private'::public.personal_card_share_state
      else 'pending_review'::public.personal_card_share_state
    end,
    share_submitted_at = case
      when share_slug is null then null
      else coalesce(shared_at, created_at)
    end,
    share_resubmission_required = share_slug is not null,
    share_terms_acceptance_id = null,
    share_community_acceptance_id = null,
    share_reviewed_at = null,
    share_reviewed_by = null;

alter table public.personal_cards
  drop constraint personal_cards_shared_at_consistent,
  add constraint personal_cards_share_state_consistent check (
    (
      share_state = 'private'
      and share_slug is null
      and shared_at is null
      and share_submitted_at is null
      and not share_resubmission_required
      and share_terms_acceptance_id is null
      and share_community_acceptance_id is null
      and share_reviewed_at is null
      and share_reviewed_by is null
    )
    or (
      share_state <> 'private'
      and share_slug is not null
      and shared_at is not null
      and share_submitted_at is not null
    )
  ),
  add constraint personal_cards_active_share_reviewed check (
    share_state <> 'active'
    or (
      not share_resubmission_required
      and share_terms_acceptance_id is not null
      and share_community_acceptance_id is not null
      and share_reviewed_at is not null
      and share_reviewed_by is not null
    )
  );

create trigger personal_cards_block_activation_until_policy_model
before insert or update of share_state on public.personal_cards
for each row execute function private.block_share_activation_until_policy_model();

-- Raw share secrets must not survive the privacy boundary. Future share_view
-- rows reference the resolved personal-card id and keep an empty properties
-- object.
delete from analytics.events
where event_name = 'share_view';

alter table analytics.events
  drop constraint analytics_events_share_slug_base62,
  drop constraint analytics_events_properties_allowlist,
  add column personal_card_id uuid
    references public.personal_cards(id) on delete cascade,
  add column revisit_on_kst date generated always as (
    (occurred_at at time zone 'Asia/Seoul')::date
  ) stored;

alter table analytics.events
  add constraint analytics_events_personal_card_boundary check (
    (
      event_name = 'share_view'
      and personal_card_id is not null
    )
    or (
      event_name <> 'share_view'
      and personal_card_id is null
    )
  ),
  add constraint analytics_events_properties_allowlist check (
    case event_name
      when 'landing_view' then
        properties = jsonb_build_object('ref', properties -> 'ref')
        and jsonb_typeof(properties -> 'ref') = 'string'
        and properties ->> 'ref' in ('sns', 'share', 'direct')
      when 'share_view' then properties = '{}'::jsonb
      when 'spot_view' then
        properties = jsonb_build_object('spot_id', properties -> 'spot_id')
        and jsonb_typeof(properties -> 'spot_id') = 'string'
        and properties ->> 'spot_id' = spot_id::text
      when 'acquire_attempt' then
        properties = jsonb_build_object('spot_id', properties -> 'spot_id')
        and jsonb_typeof(properties -> 'spot_id') = 'string'
        and properties ->> 'spot_id' = spot_id::text
      when 'personal_card_started' then
        properties = jsonb_build_object('spot_id', properties -> 'spot_id')
        and jsonb_typeof(properties -> 'spot_id') = 'string'
        and properties ->> 'spot_id' = spot_id::text
      when 'acquire_success' then
        properties = jsonb_build_object('spot_id', properties -> 'spot_id')
        and jsonb_typeof(properties -> 'spot_id') = 'string'
        and properties ->> 'spot_id' = spot_id::text
      when 'acquire_fail' then
        properties = jsonb_build_object('code', properties -> 'code')
        and jsonb_typeof(properties -> 'code') = 'string'
        and properties ->> 'code' in (
          'OUT_OF_RANGE',
          'LOW_ACCURACY',
          'ALREADY_ACQUIRED_TODAY',
          'SPOT_NOT_OPEN',
          'GATE_CLOSED'
        )
      when 'physical_interest_view' then properties = '{}'::jsonb
      when 'personal_card_created' then properties = '{}'::jsonb
      when 'share_created' then properties = '{}'::jsonb
      when 'share_revoked' then properties = '{}'::jsonb
      when 'physical_interest' then properties = '{}'::jsonb
      when 'retro_granted' then properties = '{}'::jsonb
      when 'revisit' then properties = '{}'::jsonb
      else false
    end
  );

create index analytics_events_personal_card_received_idx
  on analytics.events(personal_card_id, received_at desc)
  where personal_card_id is not null;

create unique index analytics_events_one_revisit_per_user_kst_day_idx
  on analytics.events(user_id, revisit_on_kst)
  where event_name = 'revisit';

-- While the localized-content migration is blocked, the previous application
-- can still reach these legacy signatures. Close creation/public reads and
-- preserve owner revocation so a partial deployment remains private and safe.
create or replace function api_private.create_personal_card_share(
  p_auth_user_id uuid,
  p_public_gate_open boolean,
  p_personal_card_id uuid,
  p_share_slug text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('status', 'share_creation_gate_closed')
$$;

create or replace function api_private.get_public_share(
  p_share_slug text,
  p_record_view boolean
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('status', 'not_found')
$$;

create or replace function api_private.revoke_personal_card_share(
  p_auth_user_id uuid,
  p_personal_card_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_existing record;
  v_occurred_at timestamptz := clock_timestamp();
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
    and auth_user.deleted_at is null
  for share of identity_row;

  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  if p_personal_card_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  select
    personal_card_row.share_slug,
    personal_card_row.share_state
  into v_existing
  from public.personal_cards as personal_card_row
  where personal_card_row.id = p_personal_card_id
    and personal_card_row.user_id = v_user_id
  for update of personal_card_row;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_existing.share_slug is null
    and v_existing.share_state = 'private'
  then
    return jsonb_build_object('status', 'already_revoked');
  end if;

  update public.personal_cards as personal_card_row
  set share_slug = null,
      shared_at = null,
      share_state = 'private',
      share_submitted_at = null,
      share_terms_acceptance_id = null,
      share_community_acceptance_id = null,
      share_resubmission_required = false,
      share_reason_code = null,
      share_reviewed_at = null,
      share_reviewed_by = null
  where personal_card_row.id = p_personal_card_id
    and personal_card_row.user_id = v_user_id;

  insert into analytics.events (
    user_id,
    event_name,
    source,
    occurred_at,
    properties
  )
  values (
    v_user_id,
    'share_revoked',
    'server',
    v_occurred_at,
    '{}'::jsonb
  );

  return jsonb_build_object('status', 'revoked');
end;
$$;

revoke all on function private.block_share_activation_until_policy_model()
  from public, anon, authenticated, service_role;
revoke all on function api_private.create_personal_card_share(
  uuid, boolean, uuid, text
) from public, anon, authenticated;
revoke all on function api_private.revoke_personal_card_share(uuid, uuid)
  from public, anon, authenticated;
revoke all on function api_private.get_public_share(text, boolean)
  from public, anon, authenticated;

grant execute on function api_private.create_personal_card_share(
  uuid, boolean, uuid, text
) to service_role;
grant execute on function api_private.revoke_personal_card_share(uuid, uuid)
  to service_role;
grant execute on function api_private.get_public_share(text, boolean)
  to service_role;
