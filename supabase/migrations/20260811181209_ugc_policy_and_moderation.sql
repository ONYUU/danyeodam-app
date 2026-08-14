-- DANYEODAM v0.3.5 UGC policy, manual review, reporting, and moderation.
--
-- The consumer product exposes user photos only through unguessable secret
-- links. There is no feed, search, profile, comment, or follow surface. New
-- shares remain non-public until an administrator approves them. All browser
-- roles are denied direct table/RPC access; Next.js Route Handlers call this
-- surface with service_role after authenticating the request where required.

-- -------------------------------------------------------------------------
-- Canonical moderation states
-- -------------------------------------------------------------------------

drop trigger if exists personal_cards_block_activation_until_policy_model
  on public.personal_cards;
drop function if exists private.block_share_activation_until_policy_model();

alter table public.personal_cards
  drop constraint if exists personal_cards_share_state_consistent,
  drop constraint if exists personal_cards_active_share_reviewed,
  add column if not exists share_reviewed_by_redacted_at timestamptz;

alter table public.personal_cards
  alter column share_state drop default;

create type public.personal_card_share_state_v2 as enum (
  'private',
  'pending',
  'active',
  'rejected',
  'taken_down'
);

alter table public.personal_cards
  alter column share_state type public.personal_card_share_state_v2
  using (
    case share_state::text
      when 'private' then 'private'
      when 'pending_review' then 'pending'
      when 'active' then 'active'
      when 'rejected' then 'rejected'
      when 'removed' then 'taken_down'
      when 'suspended' then 'taken_down'
      else 'taken_down'
    end
  )::public.personal_card_share_state_v2;

drop type public.personal_card_share_state;
alter type public.personal_card_share_state_v2
  rename to personal_card_share_state;

alter table public.personal_cards
  alter column share_state set default 'private';

-- Every slug that predates this UGC boundary may already have appeared in a
-- URL path or intermediary log. Invalidate it instead of carrying it into the
-- moderated system. The owner must submit again after the creation gate opens,
-- which generates a fresh secret.
update public.personal_cards
set share_state = 'private',
    share_slug = null,
    shared_at = null,
    share_submitted_at = null,
    share_terms_acceptance_id = null,
    share_community_acceptance_id = null,
    share_resubmission_required = true,
    share_reason_code = 'LEGACY_SLUG_ROTATION_REQUIRED',
    share_reviewed_at = null,
    share_reviewed_by = null,
    share_reviewed_by_redacted_at = null
where share_slug is not null;

alter table public.personal_cards
  add constraint personal_cards_share_state_consistent check (
    (
      share_state = 'private'
      and share_slug is null
      and shared_at is null
      and share_submitted_at is null
      and share_terms_acceptance_id is null
      and share_community_acceptance_id is null
      and share_reviewed_at is null
      and share_reviewed_by is null
      and share_reviewed_by_redacted_at is null
      and (
        (
          not share_resubmission_required
          and share_reason_code is null
        )
        or (
          share_resubmission_required
          and share_reason_code = 'LEGACY_SLUG_ROTATION_REQUIRED'
        )
      )
    )
    or (
      share_state = 'pending'
      and share_slug is not null
      and shared_at is not null
      and share_submitted_at is not null
      and share_reviewed_at is null
      and share_reviewed_by is null
      and share_reviewed_by_redacted_at is null
    )
    or (
      share_state in ('active', 'rejected', 'taken_down')
      and share_slug is not null
      and shared_at is not null
      and share_submitted_at is not null
      and share_reviewed_at is not null
      and num_nonnulls(
        share_reviewed_by,
        share_reviewed_by_redacted_at
      ) = 1
    )
  );

-- -------------------------------------------------------------------------
-- Policy documents and acceptance snapshots
-- -------------------------------------------------------------------------

create type private.policy_type as enum (
  'terms_of_use',
  'privacy_policy',
  'community_guidelines'
);

create table private.policy_documents (
  id uuid primary key default gen_random_uuid(),
  policy_type private.policy_type not null,
  version text not null
    check (version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  effective_at timestamptz not null,
  published_at timestamptz not null default now(),
  is_current boolean not null default false,
  created_at timestamptz not null default now(),
  constraint policy_documents_type_version_unique
    unique (policy_type, version)
);

create unique index policy_documents_one_current_type_idx
  on private.policy_documents(policy_type)
  where is_current;

create table private.policy_document_locales (
  policy_document_id uuid not null
    references private.policy_documents(id) on delete cascade,
  locale public.content_locale not null,
  document_url text not null
    check (
      char_length(document_url) <= 2048
      and document_url ~ '^https://'
    ),
  sha256 bytea not null check (octet_length(sha256) = 32),
  created_at timestamptz not null default now(),
  primary key (policy_document_id, locale)
);

create table private.policy_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  policy_document_id uuid not null
    references private.policy_documents(id) on delete restrict,
  accepted_locale public.content_locale not null,
  accepted_sha256 bytea not null check (octet_length(accepted_sha256) = 32),
  accepted_at timestamptz not null default now(),
  constraint policy_acceptances_document_locale_fkey
    foreign key (policy_document_id, accepted_locale)
    references private.policy_document_locales(policy_document_id, locale)
    on delete restrict,
  constraint policy_acceptances_user_document_unique
    unique (user_id, policy_document_id),
  constraint policy_acceptances_id_user_unique
    unique (id, user_id)
);

create index policy_acceptances_user_accepted_idx
  on private.policy_acceptances(user_id, accepted_at desc);
create index policy_acceptances_document_idx
  on private.policy_acceptances(policy_document_id);

alter table public.personal_cards
  add constraint personal_cards_share_terms_acceptance_fkey
    foreign key (share_terms_acceptance_id, user_id)
    references private.policy_acceptances(id, user_id) on delete restrict,
  add constraint personal_cards_share_community_acceptance_fkey
    foreign key (share_community_acceptance_id, user_id)
    references private.policy_acceptances(id, user_id) on delete restrict;

-- -------------------------------------------------------------------------
-- Reports, rate windows, owner suspensions, and immutable moderation audit
-- -------------------------------------------------------------------------

create type private.content_report_target as enum ('content', 'user');
create type private.content_report_reason as enum (
  'sexual_content',
  'violence',
  'hate_or_harassment',
  'privacy',
  'copyright',
  'spam',
  'illegal',
  'other'
);
create type private.content_report_status as enum (
  'open',
  'resolved',
  'dismissed'
);

create table private.share_owner_suspensions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  suspended_at timestamptz not null default now(),
  suspended_by_auth_user_id uuid not null,
  reason_code text not null check (reason_code ~ '^[A-Z0-9_]{1,64}$'),
  note text not null check (char_length(btrim(note)) between 1 and 500),
  lifted_at timestamptz,
  lifted_by_auth_user_id uuid,
  constraint share_owner_suspensions_lift_consistent check (
    (lifted_at is null and lifted_by_auth_user_id is null)
    or (
      lifted_at is not null
      and lifted_by_auth_user_id is not null
      and lifted_at >= suspended_at
    )
  )
);

create unique index share_owner_suspensions_one_active_owner_idx
  on private.share_owner_suspensions(user_id)
  where lifted_at is null;

create index share_owner_suspensions_admin_idx
  on private.share_owner_suspensions(suspended_by_auth_user_id, suspended_at desc);

create table private.user_blocks (
  id uuid primary key default gen_random_uuid(),
  blocker_user_id uuid not null references public.app_users(id) on delete cascade,
  blocked_user_id uuid not null references public.app_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint user_blocks_distinct_users check (blocker_user_id <> blocked_user_id),
  constraint user_blocks_revocation_order check (
    revoked_at is null or revoked_at >= created_at
  )
);

create unique index user_blocks_one_active_pair_idx
  on private.user_blocks(blocker_user_id, blocked_user_id)
  where revoked_at is null;
create index user_blocks_blocker_list_idx
  on private.user_blocks(blocker_user_id, created_at desc, id desc);

create table private.user_block_actions (
  id uuid primary key default gen_random_uuid(),
  blocker_user_id uuid not null references public.app_users(id) on delete cascade,
  blocked_user_id uuid not null references public.app_users(id) on delete cascade,
  block_id uuid not null references private.user_blocks(id) on delete restrict,
  client_action_id uuid not null,
  action text not null check (action in ('block', 'unblock')),
  share_secret_hash bytea,
  created_at timestamptz not null default now(),
  constraint user_block_actions_blocker_client_unique
    unique (blocker_user_id, client_action_id),
  constraint user_block_actions_payload_consistent check (
    (
      action = 'block'
      and share_secret_hash is not null
      and octet_length(share_secret_hash) = 32
    )
    or (action = 'unblock' and share_secret_hash is null)
  )
);

create index user_block_actions_rate_idx
  on private.user_block_actions(blocker_user_id, created_at desc)
  where action = 'block';

create table private.content_reports (
  id uuid primary key default gen_random_uuid(),
  client_report_id uuid not null unique,
  personal_card_id uuid references public.personal_cards(id) on delete set null,
  owner_user_id uuid references public.app_users(id) on delete set null,
  share_secret_hash bytea not null check (octet_length(share_secret_hash) = 32),
  target private.content_report_target not null,
  reason private.content_report_reason not null,
  comment text check (
    comment is null
    or char_length(btrim(comment)) between 1 and 300
  ),
  status private.content_report_status not null default 'open',
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by_auth_user_id uuid,
  resolution_code text check (
    resolution_code is null
    or resolution_code ~ '^[A-Z0-9_]{1,64}$'
  ),
  constraint content_reports_resolution_consistent check (
    (
      status = 'open'
      and resolved_at is null
      and resolved_by_auth_user_id is null
      and resolution_code is null
    )
    or (
      status <> 'open'
      and resolved_at is not null
      and resolved_by_auth_user_id is not null
      and resolution_code is not null
    )
  )
);

create index content_reports_queue_idx
  on private.content_reports(status, created_at, id);
create index content_reports_card_open_idx
  on private.content_reports(personal_card_id, created_at desc)
  where status = 'open';

create table private.public_report_rate_limits (
  reporter_key_hash bytea primary key check (octet_length(reporter_key_hash) = 32),
  window_started_at timestamptz not null,
  request_count smallint not null check (request_count between 1 and 5),
  expires_at timestamptz not null,
  constraint public_report_rate_window_order check (
    expires_at > window_started_at
  )
);

create index public_report_rate_limits_expiry_idx
  on private.public_report_rate_limits(expires_at);

create table private.moderation_actions (
  id uuid primary key default gen_random_uuid(),
  admin_auth_user_id uuid not null,
  client_action_id uuid not null,
  personal_card_id uuid,
  report_id uuid,
  owner_user_id uuid,
  suspension_id uuid,
  action text not null check (
    action in (
      'approve',
      'reject',
      'take_down',
      'reinstate',
      'suspend_owner',
      'unsuspend_owner',
      'dismiss_report'
    )
  ),
  previous_state text,
  resulting_state text,
  reason_code text not null check (reason_code ~ '^[A-Z0-9_]{1,64}$'),
  note text not null check (char_length(btrim(note)) between 1 and 500),
  affected_count integer not null default 1 check (affected_count >= 0),
  created_at timestamptz not null default now(),
  constraint moderation_actions_admin_client_unique
    unique (admin_auth_user_id, client_action_id),
  constraint moderation_actions_one_target check (
    num_nonnulls(personal_card_id, report_id, suspension_id) >= 1
  )
);

create index moderation_actions_card_idx
  on private.moderation_actions(personal_card_id, created_at desc)
  where personal_card_id is not null;
create index moderation_actions_report_idx
  on private.moderation_actions(report_id, created_at desc)
  where report_id is not null;
create index moderation_actions_suspension_idx
  on private.moderation_actions(suspension_id, created_at desc)
  where suspension_id is not null;

-- -------------------------------------------------------------------------
-- Policy and state invariants
-- -------------------------------------------------------------------------

create or replace function private.policy_document_is_complete(
  p_policy_document_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (
    select count(*)
    from private.policy_document_locales as locale_row
    where locale_row.policy_document_id = p_policy_document_id
  ) = 6
$$;

create or replace function private.policy_locales_json(
  p_policy_document_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_object_agg(
      locale_row.locale::text,
      jsonb_build_object(
        'url', locale_row.document_url,
        'sha256', encode(locale_row.sha256, 'hex')
      )
      order by locale_row.locale::text
    ),
    '{}'::jsonb
  )
  from private.policy_document_locales as locale_row
  where locale_row.policy_document_id = p_policy_document_id
$$;

create or replace function private.current_policy_requirements()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'type', document_row.policy_type,
        'version', document_row.version
      )
      order by document_row.policy_type::text
    ),
    '[]'::jsonb
  )
  from private.policy_documents as document_row
  where document_row.is_current
    and document_row.effective_at <= statement_timestamp()
    and document_row.policy_type in (
      'terms_of_use'::private.policy_type,
      'community_guidelines'::private.policy_type
    )
    and private.policy_document_is_complete(document_row.id)
$$;

create or replace function private.user_current_policy_acceptance_id(
  p_user_id uuid,
  p_policy_type private.policy_type
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select acceptance_row.id
  from private.policy_documents as document_row
  join private.policy_acceptances as acceptance_row
    on acceptance_row.policy_document_id = document_row.id
   and acceptance_row.user_id = p_user_id
  join private.policy_document_locales as locale_row
    on locale_row.policy_document_id = acceptance_row.policy_document_id
   and locale_row.locale = acceptance_row.accepted_locale
   and locale_row.sha256 = acceptance_row.accepted_sha256
  where document_row.policy_type = p_policy_type
    and document_row.is_current
    and document_row.effective_at <= statement_timestamp()
    and private.policy_document_is_complete(document_row.id)
  limit 1
$$;

create or replace function private.enforce_policy_document_current_ready()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_current
    and not private.policy_document_is_complete(new.id)
  then
    raise exception 'current policy requires all six locale documents'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger policy_documents_current_requires_locales
before insert or update of is_current on private.policy_documents
for each row execute function private.enforce_policy_document_current_ready();

create or replace function private.enforce_policy_current_switch_path()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (
    (
      tg_op = 'INSERT'
      and new.is_current
    )
    or (
      tg_op = 'UPDATE'
      and new.is_current is distinct from old.is_current
    )
  ) and current_setting('danyeodam.policy_current_switch_context', true)
    is distinct from 'enabled'
  then
    raise exception 'current policy changes require the policy publication RPC'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger policy_documents_current_switch_path
before insert or update of is_current on private.policy_documents
for each row execute function private.enforce_policy_current_switch_path();

create or replace function private.lock_policy_current_switch_statement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:policy-current-set',
    0
  ));
  return null;
end;
$$;

-- Even a migration/admin session that deliberately sets the internal context
-- cannot perform an is_current update outside the publication lock protocol.
create trigger policy_documents_current_switch_lock
before update of is_current on private.policy_documents
for each statement execute function private.lock_policy_current_switch_statement();

create or replace function private.enforce_published_policy_immutability()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'policy_documents' then
    if tg_op = 'DELETE' then
      raise exception 'published policy documents cannot be deleted; publish a new version'
        using errcode = '23514';
    end if;
    if new.id is distinct from old.id
      or new.policy_type is distinct from old.policy_type
      or new.version is distinct from old.version
      or new.effective_at is distinct from old.effective_at
      or new.published_at is distinct from old.published_at
      or new.created_at is distinct from old.created_at
    then
      raise exception 'published policy content is immutable; publish a new version'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'published policy locale documents cannot be deleted; publish a new version'
      using errcode = '23514';
  end if;
  raise exception 'published policy locale documents are immutable; publish a new version'
    using errcode = '23514';
end;
$$;

create trigger policy_documents_published_immutable
before update or delete on private.policy_documents
for each row execute function private.enforce_published_policy_immutability();

create trigger policy_document_locales_published_immutable
before update or delete on private.policy_document_locales
for each row execute function private.enforce_published_policy_immutability();

create or replace function private.enforce_share_moderation_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_terms_user_id uuid;
  v_community_user_id uuid;
  v_terms_policy_type private.policy_type;
  v_community_policy_type private.policy_type;
begin
  if (
    tg_op = 'INSERT'
    or new.share_state is distinct from old.share_state
  ) and (
    new.share_state in ('active', 'rejected', 'taken_down')
    or (
      tg_op = 'UPDATE'
      and old.share_state in ('rejected', 'taken_down')
      and new.share_state = 'pending'
    )
  ) and current_setting('danyeodam.moderation_context', true) is distinct from 'enabled'
  then
    raise exception 'moderated share transitions require the moderation RPC'
      using errcode = '23514';
  end if;

  if new.share_state = 'private' then
    if new.share_slug is not null
      or new.shared_at is not null
      or new.share_submitted_at is not null
      or new.share_terms_acceptance_id is not null
      or new.share_community_acceptance_id is not null
      or new.share_reviewed_at is not null
      or new.share_reviewed_by is not null
      or new.share_reviewed_by_redacted_at is not null
    then
      raise exception 'private share state contains public metadata'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if new.share_slug is null
    or new.shared_at is null
    or new.share_submitted_at is null
  then
    raise exception 'submitted share requires a secret and timestamps'
      using errcode = '23514';
  end if;

  if new.share_state = 'pending' then
    if not new.share_resubmission_required
      and (
        new.share_terms_acceptance_id is null
        or new.share_community_acceptance_id is null
      )
    then
      raise exception 'reviewable pending share requires policy snapshots'
        using errcode = '23514';
    end if;
    if new.share_reviewed_at is not null
      or new.share_reviewed_by is not null
      or new.share_reviewed_by_redacted_at is not null
    then
      raise exception 'pending share cannot carry a completed review'
        using errcode = '23514';
    end if;
    if not new.share_resubmission_required then
      select acceptance_row.user_id, document_row.policy_type
      into v_terms_user_id, v_terms_policy_type
      from private.policy_acceptances as acceptance_row
      join private.policy_documents as document_row
        on document_row.id = acceptance_row.policy_document_id
      where acceptance_row.id = new.share_terms_acceptance_id;

      select acceptance_row.user_id, document_row.policy_type
      into v_community_user_id, v_community_policy_type
      from private.policy_acceptances as acceptance_row
      join private.policy_documents as document_row
        on document_row.id = acceptance_row.policy_document_id
      where acceptance_row.id = new.share_community_acceptance_id;

      if v_terms_user_id is distinct from new.user_id
        or v_community_user_id is distinct from new.user_id
        or v_terms_policy_type is distinct from 'terms_of_use'::private.policy_type
        or v_community_policy_type is distinct from 'community_guidelines'::private.policy_type
      then
        raise exception 'pending share has invalid policy snapshots'
          using errcode = '23514';
      end if;
    end if;
    return new;
  end if;

  if new.share_reviewed_at is null
    or num_nonnulls(
      new.share_reviewed_by,
      new.share_reviewed_by_redacted_at
    ) <> 1
  then
    raise exception 'moderated share state requires review audit'
      using errcode = '23514';
  end if;

  if new.share_state = 'active' then
    if new.share_resubmission_required
      or new.share_terms_acceptance_id is null
      or new.share_community_acceptance_id is null
    then
      raise exception 'active share requires current policy snapshots'
        using errcode = '23514';
    end if;

    select acceptance_row.user_id
    into v_terms_user_id
    from private.policy_acceptances as acceptance_row
    where acceptance_row.id = new.share_terms_acceptance_id;

    select acceptance_row.user_id
    into v_community_user_id
    from private.policy_acceptances as acceptance_row
    where acceptance_row.id = new.share_community_acceptance_id;

    if v_terms_user_id is distinct from new.user_id
      or v_community_user_id is distinct from new.user_id
      or new.share_terms_acceptance_id is distinct from
        private.user_current_policy_acceptance_id(
          new.user_id,
          'terms_of_use'::private.policy_type
        )
      or new.share_community_acceptance_id is distinct from
        private.user_current_policy_acceptance_id(
          new.user_id,
          'community_guidelines'::private.policy_type
        )
      or exists (
        select 1
        from private.share_owner_suspensions as suspension_row
        where suspension_row.user_id = new.user_id
          and suspension_row.lifted_at is null
      )
    then
      raise exception 'active share failed policy or suspension checks'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

create trigger personal_cards_enforce_share_moderation_state
before insert or update of
  share_slug,
  shared_at,
  share_state,
  share_submitted_at,
  share_terms_acceptance_id,
  share_community_acceptance_id,
  share_resubmission_required,
  share_reviewed_at,
  share_reviewed_by,
  share_reviewed_by_redacted_at
on public.personal_cards
for each row execute function private.enforce_share_moderation_state();

create or replace function private.reject_moderation_action_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'moderation actions are append-only'
    using errcode = '23514';
end;
$$;

create trigger moderation_actions_append_only
before update or delete on private.moderation_actions
for each row execute function private.reject_moderation_action_mutation();

-- -------------------------------------------------------------------------
-- Public policy and authenticated acceptance RPCs
-- -------------------------------------------------------------------------

-- This is the only supported current-policy switch path. The exclusive
-- transaction advisory lock is acquired before any policy row lock. Policy
-- acceptance takes the shared form of the same lock before locking its two
-- required rows, which gives both paths one stable lock order.
create or replace function api_private.set_current_policy_documents(
  p_policy_document_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_selected_count integer;
  v_selected_type_count integer;
  v_all_complete boolean;
  v_all_effective boolean;
  v_current_count integer;
begin
  if p_policy_document_ids is null
    or cardinality(p_policy_document_ids) <> 3
    or array_position(p_policy_document_ids, null) is not null
    or (
      select count(distinct document_id)
      from unnest(p_policy_document_ids) as selected(document_id)
    ) <> 3
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:policy-current-set',
    0
  ));

  -- Lock the old and proposed sets in a deterministic order, after the
  -- advisory lock, before validating or mutating current flags.
  perform document_row.id
  from private.policy_documents as document_row
  where document_row.is_current
    or document_row.id = any(p_policy_document_ids)
  order by document_row.id
  for update of document_row;

  select
    count(*)::integer,
    count(distinct document_row.policy_type)::integer,
    coalesce(bool_and(private.policy_document_is_complete(document_row.id)), false),
    coalesce(bool_and(document_row.effective_at <= statement_timestamp()), false)
  into
    v_selected_count,
    v_selected_type_count,
    v_all_complete,
    v_all_effective
  from private.policy_documents as document_row
  where document_row.id = any(p_policy_document_ids);

  if v_selected_count <> 3
    or v_selected_type_count <> 3
    or not v_all_complete
    or not v_all_effective
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  perform set_config('danyeodam.policy_current_switch_context', 'enabled', true);
  update private.policy_documents as document_row
  set is_current = false
  where document_row.is_current
    and not (document_row.id = any(p_policy_document_ids));

  update private.policy_documents as document_row
  set is_current = true
  where document_row.id = any(p_policy_document_ids)
    and not document_row.is_current;
  perform set_config('danyeodam.policy_current_switch_context', 'disabled', true);

  select count(*)::integer
  into v_current_count
  from private.policy_documents as document_row
  where document_row.is_current
    and document_row.id = any(p_policy_document_ids);

  if v_current_count <> 3 then
    raise exception 'policy publication failed to install one complete current set'
      using errcode = '23514';
  end if;

  return jsonb_build_object('status', 'switched');
exception
  when others then
    perform set_config('danyeodam.policy_current_switch_context', 'disabled', true);
    raise;
end;
$$;

create or replace function api_private.get_current_policies()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_policies jsonb;
begin
  select count(*)::integer
  into v_count
  from private.policy_documents as document_row
  where document_row.is_current
    and document_row.effective_at <= statement_timestamp()
    and private.policy_document_is_complete(document_row.id);

  if v_count <> 3 then
    return jsonb_build_object('status', 'not_ready');
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'type', document_row.policy_type,
      'version', document_row.version,
      'effective_at', document_row.effective_at,
      'documents', private.policy_locales_json(document_row.id)
    )
    order by document_row.policy_type::text
  )
  into v_policies
  from private.policy_documents as document_row
  where document_row.is_current
    and document_row.effective_at <= statement_timestamp()
    and private.policy_document_is_complete(document_row.id);

  return jsonb_build_object('status', 'ready', 'policies', v_policies);
end;
$$;

create or replace function api_private.accept_current_policies(
  p_auth_user_id uuid,
  p_acceptances jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_document record;
  v_locked_count integer := 0;
  v_locked_terms_id uuid;
  v_locked_community_id uuid;
  v_matching_count integer;
  v_current_terms_id uuid;
  v_current_community_id uuid;
  v_terms_acceptance_id uuid;
  v_community_acceptance_id uuid;
  v_required jsonb;
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
    and auth_user.deleted_at is null
  for share of identity_row;

  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  if p_acceptances is null
    or jsonb_typeof(p_acceptances) <> 'array'
    or jsonb_array_length(p_acceptances) <> 2
    or exists (
      select 1
      from jsonb_array_elements(p_acceptances) as input_row(value)
      where jsonb_typeof(input_row.value) <> 'object'
        or input_row.value - array['type', 'version', 'locale']::text[] <> '{}'::jsonb
        or jsonb_typeof(input_row.value -> 'type') <> 'string'
        or jsonb_typeof(input_row.value -> 'version') <> 'string'
        or jsonb_typeof(input_row.value -> 'locale') <> 'string'
        or input_row.value ->> 'type' not in (
          'terms_of_use',
          'community_guidelines'
        )
        or input_row.value ->> 'locale' not in (
          'ko', 'en', 'ja', 'zh-Hans', 'zh-Hant', 'vi'
        )
    )
    or (
      select count(*)
      from jsonb_array_elements(p_acceptances) as input_row(value)
    ) <> (
      select count(distinct input_row.value ->> 'type')
      from jsonb_array_elements(p_acceptances) as input_row(value)
    )
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  perform pg_advisory_xact_lock_shared(hashtextextended(
    'danyeodam:policy-current-set',
    0
  ));

  -- Lock exactly the two UGC consent documents after the shared publication
  -- lock. Immutable locale rows make the selected URL/hash snapshot stable.
  for v_document in
    select document_row.id, document_row.policy_type
    from private.policy_documents as document_row
    where document_row.is_current
      and document_row.effective_at <= statement_timestamp()
      and document_row.policy_type in (
        'terms_of_use'::private.policy_type,
        'community_guidelines'::private.policy_type
      )
      and private.policy_document_is_complete(document_row.id)
    order by document_row.id
    for share of document_row
  loop
    v_locked_count := v_locked_count + 1;
    if v_document.policy_type = 'terms_of_use'::private.policy_type then
      v_locked_terms_id := v_document.id;
    else
      v_locked_community_id := v_document.id;
    end if;
  end loop;

  v_required := private.current_policy_requirements();
  if v_locked_count <> 2
    or v_locked_terms_id is null
    or v_locked_community_id is null
  then
    return jsonb_build_object(
      'status', 'policy_required',
      'required', v_required
    );
  end if;

  select count(*)::integer
  into v_matching_count
  from jsonb_array_elements(p_acceptances) as input_row(value)
  join private.policy_documents as document_row
    on document_row.id in (v_locked_terms_id, v_locked_community_id)
   and document_row.policy_type::text = input_row.value ->> 'type'
   and document_row.version = input_row.value ->> 'version'
  join private.policy_document_locales as locale_row
    on locale_row.policy_document_id = document_row.id
   and locale_row.locale::text = input_row.value ->> 'locale';

  if v_matching_count <> 2 then
    return jsonb_build_object(
      'status', 'policy_required',
      'required', v_required
    );
  end if;

  insert into private.policy_acceptances (
    user_id,
    policy_document_id,
    accepted_locale,
    accepted_sha256
  )
  select
    v_user_id,
    document_row.id,
    locale_row.locale,
    locale_row.sha256
  from jsonb_array_elements(p_acceptances) as input_row(value)
  join private.policy_documents as document_row
    on document_row.id in (v_locked_terms_id, v_locked_community_id)
   and document_row.policy_type::text = input_row.value ->> 'type'
   and document_row.version = input_row.value ->> 'version'
  join private.policy_document_locales as locale_row
    on locale_row.policy_document_id = document_row.id
   and locale_row.locale::text = input_row.value ->> 'locale'
  on conflict (user_id, policy_document_id) do nothing;

  select document_row.id
  into v_current_terms_id
  from private.policy_documents as document_row
  where document_row.is_current
    and document_row.policy_type = 'terms_of_use';

  select document_row.id
  into v_current_community_id
  from private.policy_documents as document_row
  where document_row.is_current
    and document_row.policy_type = 'community_guidelines';

  v_terms_acceptance_id := private.user_current_policy_acceptance_id(
    v_user_id,
    'terms_of_use'
  );
  v_community_acceptance_id := private.user_current_policy_acceptance_id(
    v_user_id,
    'community_guidelines'
  );

  if v_current_terms_id is distinct from v_locked_terms_id
    or v_current_community_id is distinct from v_locked_community_id
    or v_terms_acceptance_id is null
    or v_community_acceptance_id is null
  then
    return jsonb_build_object(
      'status', 'policy_required',
      'required', private.current_policy_requirements()
    );
  end if;

  return jsonb_build_object('status', 'accepted');
end;
$$;

-- The photo upload and promotion RPCs predate policy acceptance. Preserve
-- their well-tested storage/lease implementation behind non-callable internal
-- names, and expose policy-gated wrappers under the contract names.
alter function api_private.issue_personal_card_temp_upload(uuid, boolean, text, bigint)
  rename to issue_personal_card_temp_upload_after_policy_check;
alter function api_private.begin_personal_card_promotion(uuid, boolean, uuid, text, text, uuid)
  rename to begin_personal_card_promotion_after_policy_check;

revoke all on function api_private.issue_personal_card_temp_upload_after_policy_check(
  uuid, boolean, text, bigint
) from public, anon, authenticated, service_role;
revoke all on function api_private.begin_personal_card_promotion_after_policy_check(
  uuid, boolean, uuid, text, text, uuid
) from public, anon, authenticated, service_role;

create or replace function api_private.issue_personal_card_temp_upload(
  p_auth_user_id uuid,
  p_public_gate_open boolean,
  p_declared_content_type text,
  p_declared_size_bytes bigint
)
returns jsonb
language plpgsql
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
    and auth_user.deleted_at is null
  for share of identity_row;

  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  if not coalesce(p_public_gate_open, false)
    and not exists (
      select 1
      from private.participant_access as access_row
      where access_row.user_id = v_user_id
        and access_row.revoked_at is null
        and (
          access_row.expires_at is null
          or access_row.expires_at > statement_timestamp()
        )
    )
  then
    return jsonb_build_object('status', 'gate_closed');
  end if;

  perform pg_advisory_xact_lock_shared(hashtextextended(
    'danyeodam:policy-current-set',
    0
  ));

  if private.user_current_policy_acceptance_id(
      v_user_id,
      'terms_of_use'::private.policy_type
    ) is null
    or private.user_current_policy_acceptance_id(
      v_user_id,
      'community_guidelines'::private.policy_type
    ) is null
  then
    return jsonb_build_object(
      'status', 'policy_required',
      'required', private.current_policy_requirements()
    );
  end if;

  return api_private.issue_personal_card_temp_upload_after_policy_check(
    p_auth_user_id,
    p_public_gate_open,
    p_declared_content_type,
    p_declared_size_bytes
  );
end;
$$;

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
    and auth_user.deleted_at is null
  for share of identity_row;

  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  if not coalesce(p_public_gate_open, false)
    and not exists (
      select 1
      from private.participant_access as access_row
      where access_row.user_id = v_user_id
        and access_row.revoked_at is null
        and (
          access_row.expires_at is null
          or access_row.expires_at > statement_timestamp()
        )
    )
  then
    return jsonb_build_object('status', 'gate_closed');
  end if;

  perform pg_advisory_xact_lock_shared(hashtextextended(
    'danyeodam:policy-current-set',
    0
  ));

  if private.user_current_policy_acceptance_id(
      v_user_id,
      'terms_of_use'::private.policy_type
    ) is null
    or private.user_current_policy_acceptance_id(
      v_user_id,
      'community_guidelines'::private.policy_type
    ) is null
  then
    return jsonb_build_object(
      'status', 'policy_required',
      'required', private.current_policy_requirements()
    );
  end if;

  return api_private.begin_personal_card_promotion_after_policy_check(
    p_auth_user_id,
    p_public_gate_open,
    p_acquisition_id,
    p_temp_path,
    p_caption,
    p_processing_token
  );
end;
$$;

revoke all on function api_private.issue_personal_card_temp_upload(
  uuid, boolean, text, bigint
) from public, anon, authenticated;
revoke all on function api_private.begin_personal_card_promotion(
  uuid, boolean, uuid, text, text, uuid
) from public, anon, authenticated;
grant execute on function api_private.issue_personal_card_temp_upload(
  uuid, boolean, text, bigint
) to service_role;
grant execute on function api_private.begin_personal_card_promotion(
  uuid, boolean, uuid, text, text, uuid
) to service_role;

-- -------------------------------------------------------------------------
-- Share submission, owner status/revoke, and active-only public read
-- -------------------------------------------------------------------------

create or replace function api_private.create_personal_card_share(
  p_auth_user_id uuid,
  p_public_gate_open boolean,
  p_public_share_creation_open boolean,
  p_personal_card_id uuid,
  p_share_slug text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_card public.personal_cards%rowtype;
  v_terms_acceptance_id uuid;
  v_community_acceptance_id uuid;
  v_required jsonb;
  v_occurred_at timestamptz := clock_timestamp();
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
    and auth_user.deleted_at is null
  for share of identity_row;

  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  if not coalesce(p_public_gate_open, false)
    and not exists (
      select 1
      from private.participant_access as access_row
      where access_row.user_id = v_user_id
        and access_row.revoked_at is null
        and (
          access_row.expires_at is null
          or access_row.expires_at > statement_timestamp()
        )
    )
  then
    return jsonb_build_object('status', 'participant_gate_closed');
  end if;

  -- Policy publication owns the exclusive form of this lock. Take the shared
  -- form before every current-acceptance read, then keep it through the card
  -- snapshot write so a submitted review can never straddle current sets.
  perform pg_advisory_xact_lock_shared(hashtextextended(
    'danyeodam:policy-current-set',
    0
  ));

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_user_id::text,
    0
  ));

  if exists (
    select 1
    from private.share_owner_suspensions as suspension_row
    where suspension_row.user_id = v_user_id
      and suspension_row.lifted_at is null
  ) then
    return jsonb_build_object('status', 'account_suspended');
  end if;

  select personal_card_row.*
  into v_card
  from public.personal_cards as personal_card_row
  where personal_card_row.id = p_personal_card_id
    and personal_card_row.user_id = v_user_id
  for update of personal_card_row;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_card.share_slug is not null
    and (
      v_card.share_state <> 'pending'
      or (
        not v_card.share_resubmission_required
        and v_card.share_terms_acceptance_id is not distinct from
          private.user_current_policy_acceptance_id(
            v_user_id,
            'terms_of_use'::private.policy_type
          )
        and v_card.share_community_acceptance_id is not distinct from
          private.user_current_policy_acceptance_id(
            v_user_id,
            'community_guidelines'::private.policy_type
          )
      )
    )
  then
    return jsonb_build_object(
      'status', 'existing',
      'share_slug', v_card.share_slug,
      'share_state', v_card.share_state
    );
  end if;

  if not coalesce(p_public_share_creation_open, false) then
    return jsonb_build_object('status', 'share_creation_gate_closed');
  end if;

  v_terms_acceptance_id := private.user_current_policy_acceptance_id(
    v_user_id,
    'terms_of_use'::private.policy_type
  );
  v_community_acceptance_id := private.user_current_policy_acceptance_id(
    v_user_id,
    'community_guidelines'::private.policy_type
  );

  if v_terms_acceptance_id is null or v_community_acceptance_id is null then
    v_required := private.current_policy_requirements();
    return jsonb_build_object(
      'status', 'policy_required',
      'required', v_required
    );
  end if;

  if v_card.share_slug is not null then
    update public.personal_cards as personal_card_row
    set share_state = 'pending',
        share_terms_acceptance_id = v_terms_acceptance_id,
        share_community_acceptance_id = v_community_acceptance_id,
        share_resubmission_required = false,
        share_reason_code = null,
        share_reviewed_at = null,
        share_reviewed_by = null,
        share_reviewed_by_redacted_at = null
    where personal_card_row.id = v_card.id;

    return jsonb_build_object(
      'status', 'pending',
      'share_slug', v_card.share_slug,
      'share_state', 'pending'
    );
  end if;

  if p_share_slug is null or p_share_slug !~ '^[A-Za-z0-9]{22,128}$' then
    return jsonb_build_object('status', 'slug_conflict');
  end if;

  begin
    update public.personal_cards as personal_card_row
    set share_slug = p_share_slug,
        shared_at = v_occurred_at,
        share_state = 'pending',
        share_submitted_at = v_occurred_at,
        share_terms_acceptance_id = v_terms_acceptance_id,
        share_community_acceptance_id = v_community_acceptance_id,
        share_resubmission_required = false,
        share_reason_code = null,
        share_reviewed_at = null,
        share_reviewed_by = null,
        share_reviewed_by_redacted_at = null
    where personal_card_row.id = v_card.id;
  exception
    when unique_violation then
      return jsonb_build_object('status', 'slug_conflict');
  end;

  insert into analytics.events (
    user_id,
    event_name,
    source,
    occurred_at,
    properties
  ) values (
    v_user_id,
    'share_created',
    'server',
    v_occurred_at,
    '{}'::jsonb
  );

  return jsonb_build_object(
    'status', 'pending',
    'share_slug', p_share_slug,
    'share_state', 'pending'
  );
end;
$$;

create or replace function api_private.get_personal_card_share_status(
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
  v_card public.personal_cards%rowtype;
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
    and auth_user.deleted_at is null
  for share of identity_row;

  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  select personal_card_row.*
  into v_card
  from public.personal_cards as personal_card_row
  where personal_card_row.id = p_personal_card_id
    and personal_card_row.user_id = v_user_id
  for share of personal_card_row;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  return jsonb_build_object(
    'status', 'found',
    'share_state', v_card.share_state,
    'share_slug', v_card.share_slug,
    'reason_code', v_card.share_reason_code,
    'submitted_at', v_card.share_submitted_at,
    'reviewed_at', v_card.share_reviewed_at
  );
end;
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
  v_existing public.personal_cards%rowtype;
  v_occurred_at timestamptz := clock_timestamp();
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
    and auth_user.deleted_at is null
  for share of identity_row;

  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  select personal_card_row.*
  into v_existing
  from public.personal_cards as personal_card_row
  where personal_card_row.id = p_personal_card_id
    and personal_card_row.user_id = v_user_id
  for update of personal_card_row;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_existing.share_slug is null and v_existing.share_state = 'private' then
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
      share_reviewed_by = null,
      share_reviewed_by_redacted_at = null
  where personal_card_row.id = v_existing.id;

  insert into analytics.events (
    user_id,
    event_name,
    source,
    occurred_at,
    properties
  ) values (
    v_user_id,
    'share_revoked',
    'server',
    v_occurred_at,
    '{}'::jsonb
  );

  return jsonb_build_object('status', 'revoked');
end;
$$;

-- Keep the existing signature but replace it in the same migration so JSON
-- and photo handlers both fail closed on every state except active.
drop function api_private.get_public_share(text, uuid, boolean);

create or replace function api_private.get_public_share(
  p_share_slug text,
  p_viewer_auth_user_id uuid,
  p_record_view boolean,
  p_public_share_publication_open boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_viewer_user_id uuid;
  v_share record;
begin
  if not coalesce(p_public_share_publication_open, false) then
    return jsonb_build_object('status', 'not_found');
  end if;

  if p_viewer_auth_user_id is not null then
    select identity_row.user_id
    into v_viewer_user_id
    from private.user_identities as identity_row
    join auth.users as auth_user on auth_user.id = identity_row.auth_user_id
    where identity_row.auth_user_id = p_viewer_auth_user_id
      and identity_row.revoked_at is null
      and auth_user.deleted_at is null
    for share of identity_row;

    if v_viewer_user_id is null then
      return jsonb_build_object('status', 'unauthorized');
    end if;
  end if;

  if p_share_slug is null or p_share_slug !~ '^[A-Za-z0-9]{22,128}$' then
    return jsonb_build_object('status', 'not_found');
  end if;

  select
    personal_card_row.id as personal_card_id,
    acquisition_row.acquired_on_kst,
    private.localized_spot_name(spot_row.id) as spot_name,
    personal_card_row.caption,
    personal_card_row.photo_path
  into v_share
  from public.personal_cards as personal_card_row
  join public.acquisitions as acquisition_row
    on acquisition_row.id = personal_card_row.acquisition_id
   and acquisition_row.user_id = personal_card_row.user_id
  join public.spots as spot_row on spot_row.id = acquisition_row.spot_id
  where personal_card_row.share_slug = p_share_slug
    and personal_card_row.share_state = 'active'
    and not exists (
      select 1
      from private.share_owner_suspensions as suspension_row
      where suspension_row.user_id = personal_card_row.user_id
        and suspension_row.lifted_at is null
    )
    and (
      v_viewer_user_id is null
      or not exists (
        select 1
        from private.user_blocks as block_row
        where block_row.blocker_user_id = v_viewer_user_id
          and block_row.blocked_user_id = personal_card_row.user_id
          and block_row.revoked_at is null
      )
    )
  for share of personal_card_row;

  if not found or v_share.spot_name is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  if coalesce(p_record_view, false) then
    insert into analytics.events (
      user_id,
      event_name,
      source,
      occurred_at,
      personal_card_id,
      properties
    ) values (
      null,
      'share_view',
      'server',
      clock_timestamp(),
      v_share.personal_card_id,
      '{}'::jsonb
    );
  end if;

  return jsonb_build_object(
    'status', 'found',
    'personal_card_id', v_share.personal_card_id,
    'date_kst', to_char(v_share.acquired_on_kst, 'YYYY-MM-DD'),
    'spot', jsonb_build_object('name', v_share.spot_name),
    'caption', v_share.caption,
    'photo_path', v_share.photo_path
  );
end;
$$;

-- -------------------------------------------------------------------------
-- Authenticated service-user blocks
-- -------------------------------------------------------------------------

create or replace function api_private.create_user_block(
  p_auth_user_id uuid,
  p_share_slug text,
  p_client_action_id uuid,
  p_public_share_publication_open boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_blocker_user_id uuid;
  v_blocked_user_id uuid;
  v_secret_hash bytea;
  v_existing_action private.user_block_actions%rowtype;
  v_block private.user_blocks%rowtype;
  v_now timestamptz := clock_timestamp();
  v_retry_seconds integer;
begin
  if not coalesce(p_public_share_publication_open, false) then
    return jsonb_build_object('status', 'not_found');
  end if;

  if p_auth_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  if p_share_slug is null
    or p_share_slug !~ '^[A-Za-z0-9]{22,128}$'
    or p_client_action_id is null
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  select identity_row.user_id
  into v_blocker_user_id
  from private.user_identities as identity_row
  join auth.users as auth_user on auth_user.id = identity_row.auth_user_id
  where identity_row.auth_user_id = p_auth_user_id
    and identity_row.revoked_at is null
    and auth_user.deleted_at is null
  for share of identity_row;

  if v_blocker_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  v_secret_hash := extensions.digest(p_share_slug, 'sha256');
  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:user-block:' || v_blocker_user_id::text || ':' || p_client_action_id::text,
    0
  ));

  select action_row.*
  into v_existing_action
  from private.user_block_actions as action_row
  where action_row.blocker_user_id = v_blocker_user_id
    and action_row.client_action_id = p_client_action_id;

  if found then
    if v_existing_action.action = 'block'
      and v_existing_action.share_secret_hash = v_secret_hash
    then
      return jsonb_build_object('status', 'blocked', 'duplicate', true);
    end if;
    return jsonb_build_object('status', 'idempotency_conflict');
  end if;

  -- Serialize the complete per-blocker rate window, not only a target pair.
  -- Without this lock two requests for different owners can both observe 19
  -- prior actions and each create a twentieth action.
  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:user-block-rate:' || v_blocker_user_id::text,
    0
  ));
  v_now := clock_timestamp();

  select personal_card_row.user_id
  into v_blocked_user_id
  from public.personal_cards as personal_card_row
  where personal_card_row.share_slug = p_share_slug
    and personal_card_row.share_state = 'active'
    and not exists (
      select 1
      from private.share_owner_suspensions as suspension_row
      where suspension_row.user_id = personal_card_row.user_id
        and suspension_row.lifted_at is null
    )
  for share of personal_card_row;

  if v_blocked_user_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_blocked_user_id = v_blocker_user_id then
    return jsonb_build_object('status', 'invalid');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:user-block-pair:' || v_blocker_user_id::text || ':' || v_blocked_user_id::text,
    0
  ));

  if (
    select count(*)
    from private.user_block_actions as action_row
    where action_row.blocker_user_id = v_blocker_user_id
      and action_row.action = 'block'
      and action_row.created_at > v_now - interval '1 hour'
  ) >= 20 then
    select greatest(
      1,
      ceil(extract(epoch from min(action_row.created_at) + interval '1 hour' - v_now))::integer
    )
    into v_retry_seconds
    from private.user_block_actions as action_row
    where action_row.blocker_user_id = v_blocker_user_id
      and action_row.action = 'block'
      and action_row.created_at > v_now - interval '1 hour';
    return jsonb_build_object(
      'status', 'rate_limited',
      'retry_after_seconds', v_retry_seconds
    );
  end if;

  select block_row.*
  into v_block
  from private.user_blocks as block_row
  where block_row.blocker_user_id = v_blocker_user_id
    and block_row.blocked_user_id = v_blocked_user_id
    and block_row.revoked_at is null
  for update of block_row;

  if not found then
    insert into private.user_blocks (blocker_user_id, blocked_user_id, created_at)
    values (v_blocker_user_id, v_blocked_user_id, v_now)
    returning * into v_block;
  end if;

  insert into private.user_block_actions (
    blocker_user_id,
    blocked_user_id,
    block_id,
    client_action_id,
    action,
    share_secret_hash,
    created_at
  ) values (
    v_blocker_user_id,
    v_blocked_user_id,
    v_block.id,
    p_client_action_id,
    'block',
    v_secret_hash,
    v_now
  );

  return jsonb_build_object('status', 'blocked', 'duplicate', false);
end;
$$;

create or replace function api_private.list_user_blocks(
  p_auth_user_id uuid,
  p_limit integer,
  p_before_created_at timestamptz,
  p_before_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_items jsonb;
  v_has_more boolean;
  v_next_id uuid;
  v_next_created_at timestamptz;
begin
  if p_auth_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  if p_limit is null
    or p_limit < 1
    or p_limit > 100
    or ((p_before_created_at is null) <> (p_before_id is null))
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  select identity_row.user_id
  into v_user_id
  from private.user_identities as identity_row
  join auth.users as auth_user on auth_user.id = identity_row.auth_user_id
  where identity_row.auth_user_id = p_auth_user_id
    and identity_row.revoked_at is null
    and auth_user.deleted_at is null
  for share of identity_row;

  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object('id', block_row.id, 'created_at', block_row.created_at)
      order by block_row.created_at desc, block_row.id desc
    ),
    '[]'::jsonb
  )
  into v_items
  from (
    select stored_block.id, stored_block.created_at
    from private.user_blocks as stored_block
    where stored_block.blocker_user_id = v_user_id
      and stored_block.revoked_at is null
      and (
        p_before_created_at is null
        or stored_block.created_at < p_before_created_at
        or (
          stored_block.created_at = p_before_created_at
          and stored_block.id < p_before_id
        )
      )
    order by stored_block.created_at desc, stored_block.id desc
    limit p_limit
  ) as block_row;

  select exists (
    select 1
    from private.user_blocks as stored_block
    where stored_block.blocker_user_id = v_user_id
      and stored_block.revoked_at is null
      and (
        p_before_created_at is null
        or stored_block.created_at < p_before_created_at
        or (
          stored_block.created_at = p_before_created_at
          and stored_block.id < p_before_id
        )
      )
    order by stored_block.created_at desc, stored_block.id desc
    offset p_limit
    limit 1
  ) into v_has_more;

  if v_has_more then
    select stored_block.id, stored_block.created_at
    into v_next_id, v_next_created_at
    from private.user_blocks as stored_block
    where stored_block.blocker_user_id = v_user_id
      and stored_block.revoked_at is null
      and (
        p_before_created_at is null
        or stored_block.created_at < p_before_created_at
        or (
          stored_block.created_at = p_before_created_at
          and stored_block.id < p_before_id
        )
      )
    order by stored_block.created_at desc, stored_block.id desc
    offset (p_limit - 1)
    limit 1;
  end if;

  return jsonb_build_object(
    'status', 'ready',
    'items', v_items,
    'has_more', v_has_more,
    'next_anchor', case
      when v_has_more then jsonb_build_object(
        'id', v_next_id,
        'created_at', v_next_created_at
      )
      else null
    end
  );
end;
$$;

create or replace function api_private.revoke_user_block(
  p_auth_user_id uuid,
  p_block_id uuid,
  p_client_action_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_block private.user_blocks%rowtype;
  v_existing_action private.user_block_actions%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_auth_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  if p_block_id is null or p_client_action_id is null then
    return jsonb_build_object('status', 'invalid');
  end if;

  select identity_row.user_id
  into v_user_id
  from private.user_identities as identity_row
  join auth.users as auth_user on auth_user.id = identity_row.auth_user_id
  where identity_row.auth_user_id = p_auth_user_id
    and identity_row.revoked_at is null
    and auth_user.deleted_at is null
  for share of identity_row;

  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:user-block:' || v_user_id::text || ':' || p_client_action_id::text,
    0
  ));

  select action_row.*
  into v_existing_action
  from private.user_block_actions as action_row
  where action_row.blocker_user_id = v_user_id
    and action_row.client_action_id = p_client_action_id;

  if found then
    if v_existing_action.action = 'unblock'
      and v_existing_action.block_id = p_block_id
    then
      return jsonb_build_object('status', 'revoked', 'duplicate', true);
    end if;
    return jsonb_build_object('status', 'idempotency_conflict');
  end if;

  select block_row.*
  into v_block
  from private.user_blocks as block_row
  where block_row.id = p_block_id
    and block_row.blocker_user_id = v_user_id
  for update of block_row;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_block.revoked_at is null then
    update private.user_blocks
    set revoked_at = v_now
    where id = v_block.id;
  end if;

  insert into private.user_block_actions (
    blocker_user_id,
    blocked_user_id,
    block_id,
    client_action_id,
    action,
    share_secret_hash,
    created_at
  ) values (
    v_user_id,
    v_block.blocked_user_id,
    v_block.id,
    p_client_action_id,
    'unblock',
    null,
    v_now
  );

  return jsonb_build_object('status', 'revoked', 'duplicate', false);
end;
$$;

-- -------------------------------------------------------------------------
-- Public reports with idempotency and a hashed one-hour rate window
-- -------------------------------------------------------------------------

create or replace function api_private.create_content_report(
  p_share_slug text,
  p_client_report_id uuid,
  p_target text,
  p_reason text,
  p_comment text,
  p_reporter_key_hash_hex text,
  p_public_share_publication_open boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing private.content_reports%rowtype;
  v_share record;
  v_owner_user_id uuid;
  v_secret_hash bytea;
  v_reporter_hash bytea;
  v_rate private.public_report_rate_limits%rowtype;
  v_now timestamptz := clock_timestamp();
  v_report_id uuid;
  v_retry_seconds integer;
begin
  if not coalesce(p_public_share_publication_open, false) then
    return jsonb_build_object('status', 'not_found');
  end if;

  if p_share_slug is null
    or p_share_slug !~ '^[A-Za-z0-9]{22,128}$'
    or p_client_report_id is null
    or p_target not in ('content', 'user')
    or p_reason not in (
      'sexual_content', 'violence', 'hate_or_harassment', 'privacy',
      'copyright', 'spam', 'illegal', 'other'
    )
    or (p_comment is not null and char_length(btrim(p_comment)) not between 1 and 300)
    or p_reporter_key_hash_hex is null
    or p_reporter_key_hash_hex !~ '^[0-9a-f]{64}$'
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  v_secret_hash := extensions.digest(p_share_slug, 'sha256');
  v_reporter_hash := decode(p_reporter_key_hash_hex, 'hex');

  perform pg_advisory_xact_lock(
    hashtextextended('danyeodam:report-id:' || p_client_report_id::text, 0)
  );

  -- Resolve only enough information to join the owner-level suspension lock.
  -- The second lookup below is authoritative because a suspension can commit
  -- between this snapshot and the advisory lock acquisition.
  select personal_card_row.user_id
  into v_owner_user_id
  from public.personal_cards as personal_card_row
  where personal_card_row.share_slug = p_share_slug
    and personal_card_row.share_state = 'active'
    and not exists (
      select 1
      from private.share_owner_suspensions as suspension_row
      where suspension_row.user_id = personal_card_row.user_id
        and suspension_row.lifted_at is null
    );

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_owner_user_id::text,
    0
  ));

  -- Suspension uses owner advisory -> card UPDATE. Reusing that order here
  -- makes report creation linearize entirely before or after suspension and
  -- avoids the card -> owner inversion that would deadlock.
  select personal_card_row.id, personal_card_row.user_id
  into v_share
  from public.personal_cards as personal_card_row
  where personal_card_row.share_slug = p_share_slug
    and personal_card_row.user_id = v_owner_user_id
    and personal_card_row.share_state = 'active'
    and not exists (
      select 1
      from private.share_owner_suspensions as suspension_row
      where suspension_row.user_id = personal_card_row.user_id
        and suspension_row.lifted_at is null
    )
  for share of personal_card_row;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select report_row.*
  into v_existing
  from private.content_reports as report_row
  where report_row.client_report_id = p_client_report_id;

  if found then
    if v_existing.share_secret_hash = v_secret_hash
      and v_existing.target::text = p_target
      and v_existing.reason::text = p_reason
      and coalesce(v_existing.comment, '') = coalesce(btrim(p_comment), '')
    then
      return jsonb_build_object(
        'status', 'received',
        'report_id', v_existing.id,
        'duplicate', true
      );
    end if;
    return jsonb_build_object('status', 'idempotency_conflict');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('danyeodam:report-rate:' || p_reporter_key_hash_hex, 0)
  );

  delete from private.public_report_rate_limits as rate_row
  where rate_row.expires_at < v_now;

  select rate_row.*
  into v_rate
  from private.public_report_rate_limits as rate_row
  where rate_row.reporter_key_hash = v_reporter_hash
  for update of rate_row;

  if not found or v_rate.window_started_at + interval '1 hour' <= v_now then
    insert into private.public_report_rate_limits (
      reporter_key_hash,
      window_started_at,
      request_count,
      expires_at
    ) values (
      v_reporter_hash,
      v_now,
      1,
      v_now + interval '48 hours'
    )
    on conflict (reporter_key_hash) do update
    set window_started_at = excluded.window_started_at,
        request_count = 1,
        expires_at = excluded.expires_at;
  elsif v_rate.request_count >= 5 then
    v_retry_seconds := greatest(
      1,
      ceil(extract(epoch from (
        v_rate.window_started_at + interval '1 hour' - v_now
      )))::integer
    );
    return jsonb_build_object(
      'status', 'rate_limited',
      'retry_after_seconds', v_retry_seconds
    );
  else
    update private.public_report_rate_limits as rate_row
    set request_count = rate_row.request_count + 1,
        expires_at = v_now + interval '48 hours'
    where rate_row.reporter_key_hash = v_reporter_hash;
  end if;

  insert into private.content_reports (
    client_report_id,
    personal_card_id,
    owner_user_id,
    share_secret_hash,
    target,
    reason,
    comment
  ) values (
    p_client_report_id,
    v_share.id,
    v_share.user_id,
    v_secret_hash,
    p_target::private.content_report_target,
    p_reason::private.content_report_reason,
    nullif(btrim(p_comment), '')
  )
  returning id into v_report_id;

  return jsonb_build_object(
    'status', 'received',
    'report_id', v_report_id,
    'duplicate', false
  );
end;
$$;

-- -------------------------------------------------------------------------
-- Administrator queue, content access, and append-only actions
-- -------------------------------------------------------------------------

create or replace function api_private.list_share_moderation_queue(
  p_admin_auth_user_id uuid,
  p_share_state text,
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
  if p_admin_auth_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  if not exists (
    select 1
    from private.user_identities as identity_row
    join auth.users as auth_user on auth_user.id = identity_row.auth_user_id
    join private.admin_members as admin_row
      on admin_row.auth_user_id = identity_row.auth_user_id
     and admin_row.revoked_at is null
    where identity_row.auth_user_id = p_admin_auth_user_id
      and identity_row.revoked_at is null
      and auth_user.deleted_at is null
  ) then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if p_share_state not in ('pending', 'active', 'rejected', 'taken_down')
    or p_limit not between 1 and 100
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  select coalesce(jsonb_agg(to_jsonb(queue_row) order by queue_row.submitted_at, queue_row.id), '[]'::jsonb)
  into v_items
  from (
    select
      personal_card_row.id,
      personal_card_row.share_state::text as share_state,
      personal_card_row.share_submitted_at as submitted_at,
      personal_card_row.caption,
      private.localized_spot_name(acquisition_row.spot_id) as spot_name,
      personal_card_row.share_reason_code as reason_code,
      exists (
        select 1
        from private.share_owner_suspensions as suspension_row
        where suspension_row.user_id = personal_card_row.user_id
          and suspension_row.lifted_at is null
      ) as owner_suspended,
      (
        select count(*)::integer
        from private.content_reports as report_row
        where report_row.personal_card_id = personal_card_row.id
          and report_row.status = 'open'
      ) as open_report_count
    from public.personal_cards as personal_card_row
    join public.acquisitions as acquisition_row
      on acquisition_row.id = personal_card_row.acquisition_id
     and acquisition_row.user_id = personal_card_row.user_id
    where personal_card_row.share_state::text = p_share_state
    order by personal_card_row.share_submitted_at, personal_card_row.id
    limit p_limit
  ) as queue_row;

  return jsonb_build_object('status', 'ready', 'items', v_items);
end;
$$;

create or replace function api_private.get_moderation_share_photo(
  p_admin_auth_user_id uuid,
  p_personal_card_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_photo_path text;
begin
  if p_admin_auth_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  if not exists (
    select 1
    from private.user_identities as identity_row
    join auth.users as auth_user on auth_user.id = identity_row.auth_user_id
    join private.admin_members as admin_row
      on admin_row.auth_user_id = identity_row.auth_user_id
     and admin_row.revoked_at is null
    where identity_row.auth_user_id = p_admin_auth_user_id
      and identity_row.revoked_at is null
      and auth_user.deleted_at is null
  ) then
    return jsonb_build_object('status', 'forbidden');
  end if;

  select personal_card_row.photo_path
  into v_photo_path
  from public.personal_cards as personal_card_row
  where personal_card_row.id = p_personal_card_id
    and personal_card_row.share_state <> 'private'
  for share of personal_card_row;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  return jsonb_build_object('status', 'found', 'photo_path', v_photo_path);
end;
$$;

create or replace function api_private.moderate_personal_card_share(
  p_admin_auth_user_id uuid,
  p_personal_card_id uuid,
  p_client_action_id uuid,
  p_action text,
  p_reason_code text,
  p_note text,
  p_public_share_publication_open boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_card public.personal_cards%rowtype;
  v_existing private.moderation_actions%rowtype;
  v_previous_state text;
  v_resulting_state text;
  v_affected integer := 1;
  v_suspension_id uuid;
  v_owner_user_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  if p_admin_auth_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  if not exists (
    select 1
    from private.user_identities as identity_row
    join auth.users as auth_user on auth_user.id = identity_row.auth_user_id
    join private.admin_members as admin_row
      on admin_row.auth_user_id = identity_row.auth_user_id
     and admin_row.revoked_at is null
    where identity_row.auth_user_id = p_admin_auth_user_id
      and identity_row.revoked_at is null
      and auth_user.deleted_at is null
    for share of identity_row, admin_row
  ) then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if p_personal_card_id is null
    or p_client_action_id is null
    or p_action not in (
      'approve', 'reject', 'take_down', 'reinstate',
      'suspend_owner'
    )
    or p_reason_code is null
    or p_reason_code !~ '^[A-Z0-9_]{1,64}$'
    or p_note is null
    or char_length(btrim(p_note)) not between 1 and 500
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  if p_action in ('approve', 'reinstate')
    and not coalesce(p_public_share_publication_open, false)
  then
    return jsonb_build_object('status', 'publication_gate_closed');
  end if;

  if p_action = 'approve' then
    -- This is deliberately the first stateful lock in approval. Publication
    -- takes the exclusive form before policy rows; approval holds the shared
    -- form through the active-state update and its trigger recheck.
    perform pg_advisory_xact_lock_shared(hashtextextended(
      'danyeodam:policy-current-set',
      0
    ));
  end if;

  perform set_config('danyeodam.moderation_context', 'enabled', true);

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:moderation:' || p_admin_auth_user_id::text || ':' || p_client_action_id::text,
    0
  ));

  select action_row.*
  into v_existing
  from private.moderation_actions as action_row
  where action_row.admin_auth_user_id = p_admin_auth_user_id
    and action_row.client_action_id = p_client_action_id;

  if found then
    if v_existing.personal_card_id = p_personal_card_id
      and v_existing.report_id is null
      and v_existing.action = p_action
      and v_existing.reason_code = p_reason_code
      and v_existing.note = btrim(p_note)
    then
      return jsonb_build_object(
        'status', 'duplicate',
        'share_state', v_existing.resulting_state,
        'affected', v_existing.affected_count
      );
    end if;
    return jsonb_build_object('status', 'idempotency_conflict');
  end if;

  if p_action in ('approve', 'reinstate', 'suspend_owner') then
    select personal_card_row.user_id
    into v_owner_user_id
    from public.personal_cards as personal_card_row
    where personal_card_row.id = p_personal_card_id;

    if v_owner_user_id is null then
      return jsonb_build_object('status', 'not_found');
    end if;

    perform pg_advisory_xact_lock(hashtextextended(
      'danyeodam:suspend-owner:' || v_owner_user_id::text,
      0
    ));
  end if;

  select personal_card_row.*
  into v_card
  from public.personal_cards as personal_card_row
  where personal_card_row.id = p_personal_card_id
  for update of personal_card_row;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  v_previous_state := v_card.share_state::text;

  if p_action = 'approve' then
    if v_card.share_state <> 'pending' then
      return jsonb_build_object('status', 'conflict', 'reason', 'invalid_transition');
    end if;
    if v_card.share_resubmission_required
      or v_card.share_terms_acceptance_id is distinct from
        private.user_current_policy_acceptance_id(
          v_card.user_id,
          'terms_of_use'::private.policy_type
        )
      or v_card.share_community_acceptance_id is distinct from
        private.user_current_policy_acceptance_id(
          v_card.user_id,
          'community_guidelines'::private.policy_type
        )
    then
      return jsonb_build_object('status', 'conflict', 'reason', 'policy_resubmission_required');
    end if;
    if exists (
      select 1 from private.share_owner_suspensions as suspension_row
      where suspension_row.user_id = v_card.user_id
        and suspension_row.lifted_at is null
    ) then
      return jsonb_build_object('status', 'conflict', 'reason', 'owner_suspended');
    end if;
    update public.personal_cards
    set share_state = 'active',
        share_reason_code = null,
        share_reviewed_at = v_now,
        share_reviewed_by = p_admin_auth_user_id,
        share_reviewed_by_redacted_at = null
    where id = v_card.id;
    v_resulting_state := 'active';
  elsif p_action = 'reject' then
    if v_card.share_state <> 'pending' then
      return jsonb_build_object('status', 'conflict', 'reason', 'invalid_transition');
    end if;
    update public.personal_cards
    set share_state = 'rejected',
        share_reason_code = p_reason_code,
        share_reviewed_at = v_now,
        share_reviewed_by = p_admin_auth_user_id,
        share_reviewed_by_redacted_at = null
    where id = v_card.id;
    v_resulting_state := 'rejected';
  elsif p_action = 'take_down' then
    if v_card.share_state <> 'active' then
      return jsonb_build_object('status', 'conflict', 'reason', 'invalid_transition');
    end if;
    update public.personal_cards
    set share_state = 'taken_down',
        share_reason_code = p_reason_code,
        share_reviewed_at = v_now,
        share_reviewed_by = p_admin_auth_user_id,
        share_reviewed_by_redacted_at = null
    where id = v_card.id;
    v_resulting_state := 'taken_down';
  elsif p_action = 'reinstate' then
    if v_card.share_state not in ('rejected', 'taken_down') then
      return jsonb_build_object('status', 'conflict', 'reason', 'invalid_transition');
    end if;
    if exists (
      select 1 from private.share_owner_suspensions as suspension_row
      where suspension_row.user_id = v_card.user_id
        and suspension_row.lifted_at is null
    ) then
      return jsonb_build_object('status', 'conflict', 'reason', 'owner_suspended');
    end if;
    update public.personal_cards
    set share_state = 'pending',
        share_terms_acceptance_id = null,
        share_community_acceptance_id = null,
        share_resubmission_required = true,
        share_reason_code = null,
        share_reviewed_at = null,
        share_reviewed_by = null,
        share_reviewed_by_redacted_at = null
    where id = v_card.id;
    v_resulting_state := 'pending';
  elsif p_action = 'suspend_owner' then
    select suspension_row.id
    into v_suspension_id
    from private.share_owner_suspensions as suspension_row
    where suspension_row.user_id = v_card.user_id
      and suspension_row.lifted_at is null
    for update of suspension_row;

    if v_suspension_id is null then
      insert into private.share_owner_suspensions (
        user_id,
        suspended_at,
        suspended_by_auth_user_id,
        reason_code,
        note
      ) values (
        v_card.user_id,
        v_now,
        p_admin_auth_user_id,
        p_reason_code,
        btrim(p_note)
      )
      returning id into v_suspension_id;
    end if;

    update public.personal_cards
    set share_state = 'taken_down',
        share_reason_code = p_reason_code,
        share_reviewed_at = v_now,
        share_reviewed_by = p_admin_auth_user_id,
        share_reviewed_by_redacted_at = null
    where user_id = v_card.user_id
      and share_state in ('pending', 'active');
    get diagnostics v_affected = row_count;
    select share_state::text into v_resulting_state
    from public.personal_cards where id = v_card.id;
  end if;

  insert into private.moderation_actions (
    admin_auth_user_id,
    client_action_id,
    personal_card_id,
    owner_user_id,
    suspension_id,
    action,
    previous_state,
    resulting_state,
    reason_code,
    note,
    affected_count
  ) values (
    p_admin_auth_user_id,
    p_client_action_id,
    v_card.id,
    v_card.user_id,
    v_suspension_id,
    p_action,
    v_previous_state,
    v_resulting_state,
    p_reason_code,
    btrim(p_note),
    v_affected
  );

  return jsonb_build_object(
    'status', 'applied',
    'share_state', v_resulting_state,
    'affected', v_affected
  );
end;
$$;

create or replace function api_private.list_content_reports(
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
  if p_admin_auth_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  if not exists (
    select 1
    from private.user_identities as identity_row
    join auth.users as auth_user on auth_user.id = identity_row.auth_user_id
    join private.admin_members as admin_row
      on admin_row.auth_user_id = identity_row.auth_user_id
     and admin_row.revoked_at is null
    where identity_row.auth_user_id = p_admin_auth_user_id
      and identity_row.revoked_at is null
      and auth_user.deleted_at is null
  ) then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if p_status not in ('open', 'resolved', 'dismissed')
    or p_limit not between 1 and 100
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  select coalesce(jsonb_agg(to_jsonb(queue_row) order by queue_row.created_at, queue_row.id), '[]'::jsonb)
  into v_items
  from (
    select
      report_row.id,
      report_row.personal_card_id,
      report_row.target::text as target,
      report_row.reason::text as reason,
      report_row.comment,
      report_row.status::text as status,
      report_row.created_at
    from private.content_reports as report_row
    where report_row.status::text = p_status
    order by report_row.created_at, report_row.id
    limit p_limit
  ) as queue_row;

  return jsonb_build_object('status', 'ready', 'items', v_items);
end;
$$;

create or replace function api_private.moderate_content_report(
  p_admin_auth_user_id uuid,
  p_report_id uuid,
  p_client_action_id uuid,
  p_action text,
  p_reason_code text,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_report private.content_reports%rowtype;
  v_card public.personal_cards%rowtype;
  v_existing private.moderation_actions%rowtype;
  v_previous_state text;
  v_resulting_state text;
  v_affected integer := 0;
  v_audit_action text;
  v_suspension_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  if p_admin_auth_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  if not exists (
    select 1
    from private.user_identities as identity_row
    join auth.users as auth_user on auth_user.id = identity_row.auth_user_id
    join private.admin_members as admin_row
      on admin_row.auth_user_id = identity_row.auth_user_id
     and admin_row.revoked_at is null
    where identity_row.auth_user_id = p_admin_auth_user_id
      and identity_row.revoked_at is null
      and auth_user.deleted_at is null
    for share of identity_row, admin_row
  ) then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if p_report_id is null
    or p_client_action_id is null
    or p_action not in ('dismiss', 'take_down', 'suspend_owner')
    or p_reason_code is null
    or p_reason_code !~ '^[A-Z0-9_]{1,64}$'
    or p_note is null
    or char_length(btrim(p_note)) not between 1 and 500
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  perform set_config('danyeodam.moderation_context', 'enabled', true);

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:moderation:' || p_admin_auth_user_id::text || ':' || p_client_action_id::text,
    0
  ));

  select action_row.* into v_existing
  from private.moderation_actions as action_row
  where action_row.admin_auth_user_id = p_admin_auth_user_id
    and action_row.client_action_id = p_client_action_id;

  v_audit_action := case when p_action = 'dismiss' then 'dismiss_report' else p_action end;

  if found then
    if v_existing.report_id = p_report_id
      and v_existing.action = v_audit_action
      and v_existing.reason_code = p_reason_code
      and v_existing.note = btrim(p_note)
    then
      return jsonb_build_object('status', 'duplicate');
    end if;
    return jsonb_build_object('status', 'idempotency_conflict');
  end if;

  select report_row.* into v_report
  from private.content_reports as report_row
  where report_row.id = p_report_id
  for update of report_row;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_report.status <> 'open' then
    return jsonb_build_object('status', 'conflict', 'reason', 'already_resolved');
  end if;

  if p_action = 'suspend_owner' then
    if v_report.owner_user_id is null then
      return jsonb_build_object('status', 'conflict', 'reason', 'content_unavailable');
    end if;
    perform pg_advisory_xact_lock(hashtextextended(
      'danyeodam:suspend-owner:' || v_report.owner_user_id::text,
      0
    ));
  end if;

  if v_report.personal_card_id is not null then
    select personal_card_row.* into v_card
    from public.personal_cards as personal_card_row
    where personal_card_row.id = v_report.personal_card_id
    for update of personal_card_row;
  end if;

  if v_card.id is not null then
    v_previous_state := v_card.share_state::text;
    v_resulting_state := v_previous_state;
  end if;

  if p_action = 'dismiss' then
    update private.content_reports
    set status = 'dismissed',
        resolved_at = v_now,
        resolved_by_auth_user_id = p_admin_auth_user_id,
        resolution_code = p_reason_code
    where id = v_report.id;
  elsif p_action = 'take_down' then
    if v_card.id is null or v_card.share_state = 'private' then
      return jsonb_build_object('status', 'conflict', 'reason', 'content_unavailable');
    end if;
    if v_card.share_state <> 'taken_down' then
      v_affected := 1;
    end if;
    update public.personal_cards
    set share_state = 'taken_down',
        share_reason_code = p_reason_code,
        share_reviewed_at = v_now,
        share_reviewed_by = p_admin_auth_user_id,
        share_reviewed_by_redacted_at = null
    where id = v_card.id;
    v_resulting_state := 'taken_down';
    update private.content_reports
    set status = 'resolved',
        resolved_at = v_now,
        resolved_by_auth_user_id = p_admin_auth_user_id,
        resolution_code = p_reason_code
    where id = v_report.id;
  else
    select suspension_row.id
    into v_suspension_id
    from private.share_owner_suspensions as suspension_row
    where suspension_row.user_id = v_report.owner_user_id
      and suspension_row.lifted_at is null
    for update of suspension_row;

    if v_suspension_id is null then
      insert into private.share_owner_suspensions (
        user_id, suspended_at, suspended_by_auth_user_id, reason_code, note
      ) values (
        v_report.owner_user_id, v_now, p_admin_auth_user_id,
        p_reason_code, btrim(p_note)
      )
      returning id into v_suspension_id;
    end if;

    update public.personal_cards
    set share_state = 'taken_down',
        share_reason_code = p_reason_code,
        share_reviewed_at = v_now,
        share_reviewed_by = p_admin_auth_user_id,
        share_reviewed_by_redacted_at = null
    where user_id = v_report.owner_user_id
      and share_state in ('pending', 'active');
    get diagnostics v_affected = row_count;
    if v_card.id is not null then
      select personal_card_row.share_state::text
      into v_resulting_state
      from public.personal_cards as personal_card_row
      where personal_card_row.id = v_card.id;
    end if;
    update private.content_reports
    set status = 'resolved',
        resolved_at = v_now,
        resolved_by_auth_user_id = p_admin_auth_user_id,
        resolution_code = p_reason_code
    where id = v_report.id;
  end if;

  insert into private.moderation_actions (
    admin_auth_user_id,
    client_action_id,
    personal_card_id,
    report_id,
    owner_user_id,
    suspension_id,
    action,
    previous_state,
    resulting_state,
    reason_code,
    note,
    affected_count
  ) values (
    p_admin_auth_user_id,
    p_client_action_id,
    v_report.personal_card_id,
    v_report.id,
    v_report.owner_user_id,
    v_suspension_id,
    v_audit_action,
    v_previous_state,
    v_resulting_state,
    p_reason_code,
    btrim(p_note),
    v_affected
  );

  return jsonb_build_object('status', 'applied');
end;
$$;

create or replace function api_private.list_share_owner_suspensions(
  p_admin_auth_user_id uuid,
  p_status text,
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_items jsonb;
begin
  if p_admin_auth_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  if not exists (
    select 1
    from private.user_identities as identity_row
    join auth.users as auth_user on auth_user.id = identity_row.auth_user_id
    join private.admin_members as admin_row
      on admin_row.auth_user_id = identity_row.auth_user_id
     and admin_row.revoked_at is null
    where identity_row.auth_user_id = p_admin_auth_user_id
      and identity_row.revoked_at is null
      and auth_user.deleted_at is null
    for share of identity_row, admin_row
  ) then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if p_status not in ('active', 'lifted') or p_limit not between 1 and 100 then
    return jsonb_build_object('status', 'invalid');
  end if;

  select coalesce(
    jsonb_agg(to_jsonb(queue_row) order by queue_row.suspended_at desc, queue_row.id),
    '[]'::jsonb
  )
  into v_items
  from (
    select
      suspension_row.id,
      suspension_row.suspended_at,
      suspension_row.lifted_at,
      suspension_row.reason_code,
      suspension_row.note
    from private.share_owner_suspensions as suspension_row
    where (p_status = 'active' and suspension_row.lifted_at is null)
       or (p_status = 'lifted' and suspension_row.lifted_at is not null)
    order by suspension_row.suspended_at desc, suspension_row.id
    limit p_limit
  ) as queue_row;

  return jsonb_build_object('status', 'ready', 'items', v_items);
end;
$$;

create or replace function api_private.moderate_share_owner_suspension(
  p_admin_auth_user_id uuid,
  p_suspension_id uuid,
  p_client_action_id uuid,
  p_action text,
  p_reason_code text,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_suspension private.share_owner_suspensions%rowtype;
  v_existing private.moderation_actions%rowtype;
  v_owner_user_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  if p_admin_auth_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  if not exists (
    select 1
    from private.user_identities as identity_row
    join auth.users as auth_user on auth_user.id = identity_row.auth_user_id
    join private.admin_members as admin_row
      on admin_row.auth_user_id = identity_row.auth_user_id
     and admin_row.revoked_at is null
    where identity_row.auth_user_id = p_admin_auth_user_id
      and identity_row.revoked_at is null
      and auth_user.deleted_at is null
    for share of identity_row, admin_row
  ) then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if p_suspension_id is null
    or p_client_action_id is null
    or p_action <> 'unsuspend_owner'
    or p_reason_code is null
    or p_reason_code !~ '^[A-Z0-9_]{1,64}$'
    or p_note is null
    or char_length(btrim(p_note)) not between 1 and 500
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:moderation:' || p_admin_auth_user_id::text || ':' || p_client_action_id::text,
    0
  ));

  select action_row.*
  into v_existing
  from private.moderation_actions as action_row
  where action_row.admin_auth_user_id = p_admin_auth_user_id
    and action_row.client_action_id = p_client_action_id;

  if found then
    if v_existing.suspension_id = p_suspension_id
      and v_existing.personal_card_id is null
      and v_existing.report_id is null
      and v_existing.action = 'unsuspend_owner'
      and v_existing.reason_code = p_reason_code
      and v_existing.note = btrim(p_note)
    then
      return jsonb_build_object('status', 'duplicate');
    end if;
    return jsonb_build_object('status', 'idempotency_conflict');
  end if;

  select suspension_row.user_id
  into v_owner_user_id
  from private.share_owner_suspensions as suspension_row
  where suspension_row.id = p_suspension_id;

  if v_owner_user_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_owner_user_id::text,
    0
  ));

  select suspension_row.*
  into v_suspension
  from private.share_owner_suspensions as suspension_row
  where suspension_row.id = p_suspension_id
  for update of suspension_row;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_suspension.lifted_at is not null then
    return jsonb_build_object('status', 'conflict', 'reason', 'already_lifted');
  end if;

  update private.share_owner_suspensions
  set lifted_at = v_now,
      lifted_by_auth_user_id = p_admin_auth_user_id
  where id = v_suspension.id;

  insert into private.moderation_actions (
    admin_auth_user_id,
    client_action_id,
    suspension_id,
    action,
    previous_state,
    resulting_state,
    reason_code,
    note,
    affected_count
  ) values (
    p_admin_auth_user_id,
    p_client_action_id,
    v_suspension.id,
    'unsuspend_owner',
    'active',
    'lifted',
    p_reason_code,
    btrim(p_note),
    1
  );

  return jsonb_build_object('status', 'applied');
end;
$$;

-- -------------------------------------------------------------------------
-- RLS, table ACLs, function ACLs
-- -------------------------------------------------------------------------

alter table private.policy_documents enable row level security;
alter table private.policy_documents force row level security;
alter table private.policy_document_locales enable row level security;
alter table private.policy_document_locales force row level security;
alter table private.policy_acceptances enable row level security;
alter table private.policy_acceptances force row level security;
alter table private.share_owner_suspensions enable row level security;
alter table private.share_owner_suspensions force row level security;
alter table private.user_blocks enable row level security;
alter table private.user_blocks force row level security;
alter table private.user_block_actions enable row level security;
alter table private.user_block_actions force row level security;
alter table private.content_reports enable row level security;
alter table private.content_reports force row level security;
alter table private.public_report_rate_limits enable row level security;
alter table private.public_report_rate_limits force row level security;
alter table private.moderation_actions enable row level security;
alter table private.moderation_actions force row level security;

revoke all on table private.policy_documents from public, anon, authenticated, service_role;
revoke all on table private.policy_document_locales from public, anon, authenticated, service_role;
revoke all on table private.policy_acceptances from public, anon, authenticated, service_role;
revoke all on table private.share_owner_suspensions from public, anon, authenticated, service_role;
revoke all on table private.user_blocks from public, anon, authenticated, service_role;
revoke all on table private.user_block_actions from public, anon, authenticated, service_role;
revoke all on table private.content_reports from public, anon, authenticated, service_role;
revoke all on table private.public_report_rate_limits from public, anon, authenticated, service_role;
revoke all on table private.moderation_actions from public, anon, authenticated, service_role;
revoke insert, update, delete on table public.personal_cards from service_role;

revoke all on function private.policy_document_is_complete(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.policy_locales_json(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.current_policy_requirements()
  from public, anon, authenticated, service_role;
revoke all on function private.user_current_policy_acceptance_id(uuid, private.policy_type)
  from public, anon, authenticated, service_role;
revoke all on function private.enforce_policy_document_current_ready()
  from public, anon, authenticated, service_role;
revoke all on function private.enforce_policy_current_switch_path()
  from public, anon, authenticated, service_role;
revoke all on function private.lock_policy_current_switch_statement()
  from public, anon, authenticated, service_role;
revoke all on function private.enforce_published_policy_immutability()
  from public, anon, authenticated, service_role;
revoke all on function private.enforce_share_moderation_state()
  from public, anon, authenticated, service_role;
revoke all on function private.reject_moderation_action_mutation()
  from public, anon, authenticated, service_role;

revoke all on function api_private.get_current_policies()
  from public, anon, authenticated;
revoke all on function api_private.set_current_policy_documents(uuid[])
  from public, anon, authenticated;
revoke all on function api_private.accept_current_policies(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function api_private.create_personal_card_share(
  uuid, boolean, boolean, uuid, text
) from public, anon, authenticated;
revoke all on function api_private.get_personal_card_share_status(uuid, uuid)
  from public, anon, authenticated;
revoke all on function api_private.revoke_personal_card_share(uuid, uuid)
  from public, anon, authenticated;
revoke all on function api_private.get_public_share(text, uuid, boolean, boolean)
  from public, anon, authenticated;
revoke all on function api_private.create_user_block(uuid, text, uuid, boolean)
  from public, anon, authenticated;
revoke all on function api_private.list_user_blocks(uuid, integer, timestamptz, uuid)
  from public, anon, authenticated;
revoke all on function api_private.revoke_user_block(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function api_private.create_content_report(
  text, uuid, text, text, text, text, boolean
) from public, anon, authenticated;
revoke all on function api_private.list_share_moderation_queue(uuid, text, integer)
  from public, anon, authenticated;
revoke all on function api_private.get_moderation_share_photo(uuid, uuid)
  from public, anon, authenticated;
revoke all on function api_private.moderate_personal_card_share(
  uuid, uuid, uuid, text, text, text, boolean
) from public, anon, authenticated;
revoke all on function api_private.list_content_reports(uuid, text, integer)
  from public, anon, authenticated;
revoke all on function api_private.moderate_content_report(
  uuid, uuid, uuid, text, text, text
) from public, anon, authenticated;
revoke all on function api_private.list_share_owner_suspensions(uuid, text, integer)
  from public, anon, authenticated;
revoke all on function api_private.moderate_share_owner_suspension(
  uuid, uuid, uuid, text, text, text
) from public, anon, authenticated;

grant execute on function api_private.get_current_policies()
  to service_role;
grant execute on function api_private.set_current_policy_documents(uuid[])
  to service_role;
grant execute on function api_private.accept_current_policies(uuid, jsonb)
  to service_role;
grant execute on function api_private.create_personal_card_share(
  uuid, boolean, boolean, uuid, text
) to service_role;
grant execute on function api_private.get_personal_card_share_status(uuid, uuid)
  to service_role;
grant execute on function api_private.revoke_personal_card_share(uuid, uuid)
  to service_role;
grant execute on function api_private.get_public_share(text, uuid, boolean, boolean)
  to service_role;
grant execute on function api_private.create_user_block(uuid, text, uuid, boolean)
  to service_role;
grant execute on function api_private.list_user_blocks(uuid, integer, timestamptz, uuid)
  to service_role;
grant execute on function api_private.revoke_user_block(uuid, uuid, uuid)
  to service_role;
grant execute on function api_private.create_content_report(
  text, uuid, text, text, text, text, boolean
) to service_role;
grant execute on function api_private.list_share_moderation_queue(uuid, text, integer)
  to service_role;
grant execute on function api_private.get_moderation_share_photo(uuid, uuid)
  to service_role;
grant execute on function api_private.moderate_personal_card_share(
  uuid, uuid, uuid, text, text, text, boolean
) to service_role;
grant execute on function api_private.list_content_reports(uuid, text, integer)
  to service_role;
grant execute on function api_private.moderate_content_report(
  uuid, uuid, uuid, text, text, text
) to service_role;
grant execute on function api_private.list_share_owner_suspensions(uuid, text, integer)
  to service_role;
grant execute on function api_private.moderate_share_owner_suspension(
  uuid, uuid, uuid, text, text, text
) to service_role;
