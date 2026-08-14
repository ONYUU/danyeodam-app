-- DANYEODAM location-compliance and minimum-age backend boundary.
--
-- Device coordinates and accuracy remain transient Node.js inputs. This
-- migration deliberately stores only the server-side fact that a location
-- decision was requested and its coarse outcome.

begin;

-- -------------------------------------------------------------------------
-- Four-policy, six-locale publication contract
-- -------------------------------------------------------------------------

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
    or cardinality(p_policy_document_ids) <> 4
    or array_position(p_policy_document_ids, null) is not null
    or (
      select count(distinct document_id)
      from unnest(p_policy_document_ids) as selected(document_id)
    ) <> 4
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:policy-current-set',
    0
  ));

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

  if v_selected_count <> 4
    or v_selected_type_count <> 4
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

  if v_current_count <> 4 then
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
stable
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

  if v_count <> 4 then
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

-- -------------------------------------------------------------------------
-- Minimum-age attestation, location consent, facts, disclosure, correction
-- -------------------------------------------------------------------------

create type private.location_consent_state as enum (
  'active',
  'paused',
  'withdrawal_pending'
);

create type private.location_use_purpose as enum ('field_acquisition');
create type private.location_use_outcome as enum ('pending', 'passed', 'failed');
create type private.location_correction_reason as enum (
  'not_my_visit',
  'wrong_spot',
  'incorrect_outcome',
  'other'
);
create type private.location_correction_status as enum (
  'open',
  'approved_pending_correction',
  'corrected',
  'rejected'
);
create type private.data_erasure_scope as enum (
  'location_withdrawal',
  'location_correction'
);
create type private.data_erasure_state as enum (
  'pending',
  'storage_pending',
  'database_pending',
  'completed'
);

create table private.minimum_age_attestations (
  user_id uuid primary key references public.app_users(id) on delete cascade,
  minimum_age_passed boolean not null,
  version text not null,
  attested_at timestamptz not null default clock_timestamp(),
  constraint minimum_age_attestations_exact_pass check (minimum_age_passed),
  constraint minimum_age_attestations_exact_version check (version = '18plus-v1')
);

create table private.location_consents (
  user_id uuid primary key references public.app_users(id) on delete cascade,
  state private.location_consent_state not null,
  policy_acceptance_id uuid not null,
  consented_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  withdrawal_requested_at timestamptz,
  constraint location_consents_acceptance_owner_fkey
    foreign key (policy_acceptance_id, user_id)
    references private.policy_acceptances(id, user_id) on delete restrict,
  constraint location_consents_withdrawal_state check (
    (state = 'withdrawal_pending' and withdrawal_requested_at is not null)
    or (state <> 'withdrawal_pending' and withdrawal_requested_at is null)
  )
);

create index location_consents_acceptance_idx
  on private.location_consents(policy_acceptance_id);

create table private.location_use_facts (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.app_users(id) on delete cascade,
  idempotency_key uuid not null,
  spot_id uuid not null references public.spots(id) on delete restrict,
  purpose private.location_use_purpose not null,
  collected_at timestamptz not null default clock_timestamp(),
  decided_at timestamptz,
  outcome private.location_use_outcome not null default 'pending',
  terminal_failure_code text,
  terminal_failure_details jsonb not null default '{}'::jsonb,
  constraint location_use_facts_user_attempt_unique
    unique (user_id, idempotency_key, purpose),
  constraint location_use_facts_decision_consistent check (
    (outcome = 'pending' and decided_at is null)
    or (outcome <> 'pending' and decided_at is not null and decided_at >= collected_at)
  ),
  constraint location_use_facts_terminal_failure_consistent check ((
    (
      outcome <> 'failed'
      and terminal_failure_code is null
      and terminal_failure_details = '{}'::jsonb
    )
    or (
      outcome = 'failed'
      and terminal_failure_code in (
        'OUT_OF_RANGE',
        'LOW_ACCURACY',
        'ALREADY_ACQUIRED_TODAY',
        'SPOT_NOT_OPEN',
        'GATE_CLOSED'
      )
      and (
        (
          terminal_failure_code = 'LOW_ACCURACY'
          and terminal_failure_details = '{"retry":true}'::jsonb
        )
        or (
          terminal_failure_code = 'OUT_OF_RANGE'
          and terminal_failure_details - 'distance_band' = '{}'::jsonb
          and jsonb_typeof(terminal_failure_details -> 'distance_band') = 'string'
          and terminal_failure_details ->> 'distance_band' in ('near', 'far')
        )
        or (
          terminal_failure_code in (
            'ALREADY_ACQUIRED_TODAY',
            'SPOT_NOT_OPEN',
            'GATE_CLOSED'
          )
          and terminal_failure_details = '{}'::jsonb
        )
      )
    )
  ) is true)
);

create index location_use_facts_user_cursor_idx
  on private.location_use_facts(user_id, collected_at desc, id desc);
create index location_use_facts_retention_idx
  on private.location_use_facts(collected_at, id);
create index location_use_facts_spot_idx
  on private.location_use_facts(spot_id);

-- Privacy-right pagination intentionally exposes only the already-disclosed
-- KST visit date and opaque acquisition id. Do not use acquired_at as a
-- cursor anchor because a signed (but unencrypted) cursor is user-decodable.
create index acquisitions_field_correction_subject_page_idx
  on public.acquisitions(user_id, acquired_on_kst desc, id desc)
  where acquisition_type = 'field';

-- A completed correction or full withdrawal removes the original attempt row,
-- but an offline retry carrying the same logical idempotency key must not
-- recreate it. Keep separate domain-separated owner and request-key digests
-- for six months. This permits a successful recovery rebind to move an
-- already-minimized tombstone without retaining a raw user id or request key.
-- No spot, visit time, outcome, coordinates, or accuracy is present.
create table private.location_attempt_tombstones (
  owner_fingerprint bytea not null
    check (octet_length(owner_fingerprint) = 32),
  attempt_key_fingerprint bytea not null
    check (octet_length(attempt_key_fingerprint) = 32),
  expires_at timestamptz not null,
  primary key (owner_fingerprint, attempt_key_fingerprint)
);

create index location_attempt_tombstones_expiry_idx
  on private.location_attempt_tombstones(
    expires_at,
    owner_fingerprint,
    attempt_key_fingerprint
  );

-- A promotion crosses the Storage/Database transaction boundary. Register
-- both the signed temporary path and server-generated permanent path before
-- Storage I/O so an ambiguous completion response can never erase the only
-- durable correlation to its field acquisition. A committed exact card keeps
-- correlation through the promotion row; otherwise maintenance performs two
-- deletion passes before removing each ledger item.
create table private.personal_card_field_object_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  field_acquisition_id uuid not null,
  upload_id uuid not null,
  processing_token uuid not null,
  bucket text not null check (bucket in ('personal-card-temp', 'personal-cards')),
  object_path text not null unique,
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
  constraint personal_card_field_object_ledger_acquisition_fkey
    foreign key (field_acquisition_id, user_id)
    references public.acquisitions(id, user_id) on delete restrict,
  constraint personal_card_field_object_ledger_upload_fkey
    foreign key (upload_id)
    references private.personal_card_temp_uploads(id) on delete restrict,
  constraint personal_card_field_object_ledger_path_exact check (
    object_path like user_id::text || '/%'
    and object_path !~ '(^|/)\.\.(/|$)'
    and char_length(object_path) between 1 and 256
    and (
      bucket = 'personal-card-temp'
      or object_path = user_id::text || '/' || processing_token::text || '.webp'
    )
  ),
  constraint personal_card_field_object_ledger_lease_consistent check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  ),
  constraint personal_card_field_object_ledger_cleanup_consistent check (
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

create unique index personal_card_field_object_ledger_token_bucket_idx
  on private.personal_card_field_object_ledger(processing_token, bucket);
create index personal_card_field_object_ledger_worker_idx
  on private.personal_card_field_object_ledger(next_attempt_at, id);

-- Freeze the pre-ledger promotion table while committed processing bindings are
-- backfilled. An already-running historical function body is not redispatched
-- to the new wrapper after this transaction commits; its later lease UPDATE is
-- instead repaired by the compatibility trigger installed below. Deployment
-- still quiesces and drains every old writer because this table lock cannot
-- replace already-parsed acquire/share/recovery bodies.
lock table private.personal_card_temp_uploads in share row exclusive mode;

insert into private.personal_card_field_object_ledger (
  user_id,
  field_acquisition_id,
  upload_id,
  processing_token,
  bucket,
  object_path,
  final_delete_not_before,
  next_attempt_at
)
select
  upload_row.user_id,
  upload_row.processing_acquisition_id,
  upload_row.id,
  upload_row.processing_token,
  path_row.bucket,
  path_row.object_path,
  path_row.final_delete_not_before,
  path_row.initial_next_attempt_at
from private.personal_card_temp_uploads as upload_row
join public.acquisitions as acquisition_row
  on acquisition_row.id = upload_row.processing_acquisition_id
 and acquisition_row.user_id = upload_row.user_id
 and acquisition_row.acquisition_type = 'field'
cross join lateral (
  values
    (
      'personal-card-temp'::text,
      upload_row.temp_path,
      upload_row.signed_url_expires_at + interval '10 minutes',
      upload_row.promotion_expires_at
    ),
    (
      'personal-cards'::text,
      upload_row.processing_permanent_path,
      upload_row.processing_expires_at + interval '10 minutes',
      clock_timestamp()
    )
) as path_row(
  bucket,
  object_path,
  final_delete_not_before,
  initial_next_attempt_at
)
where upload_row.promoted_at is null
  and upload_row.processing_token is not null
  and upload_row.processing_acquisition_id is not null
  and upload_row.processing_permanent_path is not null;

do $$
declare
  v_processing_count bigint;
  v_ledger_count bigint;
begin
  select count(*)
  into v_processing_count
  from private.personal_card_temp_uploads as upload_row
  join public.acquisitions as acquisition_row
    on acquisition_row.id = upload_row.processing_acquisition_id
   and acquisition_row.user_id = upload_row.user_id
   and acquisition_row.acquisition_type = 'field'
  where upload_row.promoted_at is null
    and upload_row.processing_token is not null
    and upload_row.processing_permanent_path is not null;

  select count(*) into v_ledger_count
  from private.personal_card_field_object_ledger;

  if v_ledger_count <> v_processing_count * 2 then
    raise exception 'field object ledger cutover backfill mismatch'
      using errcode = '23514';
  end if;
  raise notice 'field object ledger cutover backfilled % active lease(s)',
    v_processing_count;
end;
$$;

-- These two client events cannot be correlated to a logical attempt/card and
-- therefore cannot satisfy exact correction or post-withdrawal erasure. Retire
-- their transport at cutover; enum labels remain only for migration history.
do $$
declare
  v_retired_count bigint;
  v_legacy_failure_count bigint;
begin
  select count(*)
  into v_retired_count
  from analytics.events as event_row
  where event_row.source = 'client'
    and event_row.event_name::text in (
      'acquire_attempt',
      'personal_card_started'
    );

  delete from analytics.events as event_row
  where event_row.source = 'client'
    and event_row.event_name::text in (
      'acquire_attempt',
      'personal_card_started'
    );

  -- Pre-ledger server failures do not carry an idempotency key, so guessing a
  -- fact would corrupt correction boundaries. Remove them at cutover instead
  -- of retaining user/spot/time/code indefinitely.
  select count(*)
  into v_legacy_failure_count
  from analytics.events as event_row
  where event_row.source = 'server'
    and event_row.event_name = 'acquire_fail';

  delete from analytics.events as event_row
  where event_row.source = 'server'
    and event_row.event_name = 'acquire_fail';

  raise notice 'retired uncorrelated client location events: %', v_retired_count;
  raise notice 'retired uncorrelated server acquire failures: %', v_legacy_failure_count;
end;
$$;

alter table analytics.events
  add constraint analytics_events_retired_uncorrelated_client_location check (
    event_name::text not in ('acquire_attempt', 'personal_card_started')
  );

-- Correlate only server acquisition terminal events to the exact bounded fact.
-- The column starts nullable for audited legacy matching; uncorrelated server
-- failures are retired above and remaining uncorrelated successes are retired
-- after every backfilled acquisition has one exact replacement below.
alter table analytics.events
  add column location_use_fact_id bigint
    references private.location_use_facts(id) on delete cascade,
  add constraint analytics_events_location_fact_boundary check (
    location_use_fact_id is null
    or event_name in ('acquire_success', 'acquire_fail')
  ),
  add constraint analytics_events_server_acquire_fail_has_fact check (
    event_name <> 'acquire_fail'
    or source <> 'server'
    or location_use_fact_id is not null
  );

create unique index analytics_events_location_fact_terminal_idx
  on analytics.events(location_use_fact_id)
  where location_use_fact_id is not null;

-- Audited cutover for visits that predate this compliance ledger. The source
-- already contains the exact bounded fields needed here; no coordinates,
-- accuracy, request body, or IP data are copied.
insert into private.location_use_facts (
  user_id,
  idempotency_key,
  spot_id,
  purpose,
  collected_at,
  decided_at,
  outcome
)
select
  acquisition_row.user_id,
  acquisition_row.idempotency_key,
  acquisition_row.spot_id,
  'field_acquisition',
  acquisition_row.acquired_at,
  acquisition_row.acquired_at,
  'passed'
from public.acquisitions as acquisition_row
where acquisition_row.acquisition_type = 'field';

do $$
begin
  if (
    select count(*)
    from private.location_use_facts as fact_row
    where fact_row.purpose = 'field_acquisition'
  ) <> (
    select count(*)
    from public.acquisitions as acquisition_row
    where acquisition_row.acquisition_type = 'field'
  ) then
    raise exception 'field acquisition location-ledger backfill mismatch'
      using errcode = '23514';
  end if;
end;
$$;

-- Link one exact legacy success event per backfilled acquisition. If an old
-- deployment omitted that analytics row, create a bounded server fact rather
-- than leaving a passed acquisition without a terminal correlation.
with exact_legacy_event as (
  select
    fact_row.id as location_use_fact_id,
    max(event_row.id) as event_id
  from private.location_use_facts as fact_row
  join public.acquisitions as acquisition_row
    on acquisition_row.user_id = fact_row.user_id
   and acquisition_row.idempotency_key = fact_row.idempotency_key
   and acquisition_row.spot_id = fact_row.spot_id
   and acquisition_row.acquisition_type = 'field'
   and acquisition_row.acquired_at = fact_row.collected_at
  join analytics.events as event_row
    on event_row.user_id = fact_row.user_id
   and event_row.event_name = 'acquire_success'
   and event_row.spot_id = fact_row.spot_id
   and event_row.occurred_at = acquisition_row.acquired_at
   and event_row.location_use_fact_id is null
  where fact_row.purpose = 'field_acquisition'
    and fact_row.outcome = 'passed'
  group by fact_row.id
)
update analytics.events as event_row
set location_use_fact_id = exact_row.location_use_fact_id
from exact_legacy_event as exact_row
where event_row.id = exact_row.event_id;

insert into analytics.events (
  user_id,
  event_name,
  source,
  occurred_at,
  spot_id,
  properties,
  location_use_fact_id
)
select
  fact_row.user_id,
  'acquire_success',
  'server',
  fact_row.collected_at,
  fact_row.spot_id,
  jsonb_build_object('spot_id', fact_row.spot_id::text),
  fact_row.id
from private.location_use_facts as fact_row
where fact_row.purpose = 'field_acquisition'
  and fact_row.outcome = 'passed'
  and not exists (
    select 1
    from analytics.events as event_row
    where event_row.location_use_fact_id = fact_row.id
  );

-- Every backfilled field acquisition now has one exact correlated terminal
-- event. Any remaining legacy server success row is uncorrelated (for
-- example a duplicate or an orphan) and cannot be safely guessed. Remove it
-- before making the inverse boundary VALID so post-cutover writers can never
-- recreate an indefinitely retained nullable success event.
do $$
declare
  v_uncorrelated_success_count bigint;
begin
  select count(*)
  into v_uncorrelated_success_count
  from analytics.events as event_row
  where event_row.source = 'server'
    and event_row.event_name = 'acquire_success'
    and event_row.location_use_fact_id is null;

  delete from analytics.events as event_row
  where event_row.source = 'server'
    and event_row.event_name = 'acquire_success'
    and event_row.location_use_fact_id is null;

  raise notice 'retired uncorrelated server acquire successes: %',
    v_uncorrelated_success_count;
end;
$$;

alter table analytics.events
  add constraint analytics_events_server_acquire_success_has_fact check (
    event_name <> 'acquire_success'
    or source <> 'server'
    or location_use_fact_id is not null
  );

-- Card-derived server events created after this cutover are correlated to the
-- exact personal card by the wrappers below. Legacy nullable rows remain
-- readable but cannot be guessed or over-deleted during a targeted correction.
alter table analytics.events
  drop constraint analytics_events_personal_card_boundary,
  add constraint analytics_events_personal_card_boundary check (
    (
      event_name = 'share_view'
      and personal_card_id is not null
    )
    or (
      event_name in (
        'personal_card_created',
        'share_created',
        'share_revoked'
      )
    )
    or (
      event_name not in (
        'share_view',
        'personal_card_created',
        'share_created',
        'share_revoked'
      )
      and personal_card_id is null
    )
  );

create table private.location_disclosure_accesses (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.app_users(id) on delete cascade,
  disclosed_count smallint not null check (disclosed_count between 0 and 100),
  accessed_at timestamptz not null default clock_timestamp()
);

create index location_disclosure_accesses_user_idx
  on private.location_disclosure_accesses(user_id, accessed_at desc);

create table private.location_correction_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  location_use_fact_id bigint references private.location_use_facts(id) on delete set null,
  field_acquisition_id uuid references public.acquisitions(id) on delete set null,
  client_request_id uuid not null,
  request_fingerprint bytea not null check (octet_length(request_fingerprint) = 32),
  reason private.location_correction_reason not null,
  status private.location_correction_status not null default 'open',
  requested_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz,
  resolved_by_auth_user_id uuid,
  constraint location_corrections_user_client_unique
    unique (user_id, client_request_id),
  constraint location_corrections_exact_subject check (
    (
      status in ('open', 'approved_pending_correction')
      and num_nonnulls(location_use_fact_id, field_acquisition_id) = 1
    )
    or (
      status in ('corrected', 'rejected')
      and num_nonnulls(location_use_fact_id, field_acquisition_id) between 0 and 1
    )
  ),
  constraint location_corrections_resolution_consistent check (
    (status = 'open' and resolved_at is null and resolved_by_auth_user_id is null)
    or (
      status = 'approved_pending_correction'
      and resolved_at is null
      and resolved_by_auth_user_id is not null
    )
    or (
      status in ('corrected', 'rejected')
      and resolved_at is not null
      and resolved_by_auth_user_id is not null
      and resolved_at >= requested_at
    )
  )
);

create index location_corrections_user_idx
  on private.location_correction_requests(user_id, requested_at desc, id desc);
create index location_corrections_admin_queue_idx
  on private.location_correction_requests(status, requested_at, id);
create index location_corrections_fact_idx
  on private.location_correction_requests(location_use_fact_id)
  where location_use_fact_id is not null;
create unique index location_corrections_one_active_per_fact_idx
  on private.location_correction_requests(user_id, location_use_fact_id)
  where location_use_fact_id is not null
    and status in ('open', 'approved_pending_correction');
create unique index location_corrections_one_active_per_acquisition_idx
  on private.location_correction_requests(user_id, field_acquisition_id)
  where field_acquisition_id is not null
    and status in ('open', 'approved_pending_correction');

create table private.data_erasure_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  scope private.data_erasure_scope not null,
  correction_request_id uuid references private.location_correction_requests(id) on delete restrict,
  state private.data_erasure_state not null default 'pending',
  requested_at timestamptz not null default clock_timestamp(),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  lease_token uuid,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  constraint data_erasure_jobs_lease_consistent check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  ),
  constraint data_erasure_jobs_completion_consistent check (
    (state = 'completed' and completed_at is not null)
    or (state <> 'completed' and completed_at is null)
  ),
  constraint data_erasure_jobs_scope_subject check (
    (scope = 'location_withdrawal' and correction_request_id is null)
    or (scope = 'location_correction' and correction_request_id is not null)
  )
);

create unique index data_erasure_jobs_one_open_withdrawal_idx
  on private.data_erasure_jobs(user_id)
  where scope = 'location_withdrawal' and state <> 'completed';
create unique index data_erasure_jobs_one_correction_idx
  on private.data_erasure_jobs(correction_request_id)
  where correction_request_id is not null;
create index data_erasure_jobs_worker_idx
  on private.data_erasure_jobs(next_attempt_at, requested_at)
  where state <> 'completed';

create table private.data_erasure_manifest (
  id bigint generated always as identity primary key,
  job_id uuid not null references private.data_erasure_jobs(id) on delete cascade,
  bucket text not null check (bucket in ('personal-card-temp', 'personal-cards')),
  object_path text not null check (
    char_length(object_path) between 1 and 256
    and object_path !~ '(^|/)\.\.(/|$)'
  ),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_attempt_at timestamptz,
  first_deleted_at timestamptz,
  final_delete_after timestamptz not null,
  deleted_at timestamptz,
  constraint data_erasure_manifest_job_object_unique
    unique (job_id, bucket, object_path),
  constraint data_erasure_manifest_attempt_consistent check (
    attempt_count = 0 or last_attempt_at is not null
  ),
  constraint data_erasure_manifest_two_phase_consistent check (
    final_delete_after >= first_deleted_at
    or first_deleted_at is null
  ),
  constraint data_erasure_manifest_final_delete_consistent check (
    deleted_at is null
    or (
      first_deleted_at is not null
      and deleted_at >= final_delete_after
    )
  )
);

create index data_erasure_manifest_pending_idx
  on private.data_erasure_manifest(job_id, id)
  where deleted_at is null;

-- Every new application table remains inaccessible directly, including to a
-- leaked browser credential. Only the narrow service-role RPCs below execute.
alter table private.minimum_age_attestations enable row level security;
alter table private.minimum_age_attestations force row level security;
alter table private.location_consents enable row level security;
alter table private.location_consents force row level security;
alter table private.location_use_facts enable row level security;
alter table private.location_use_facts force row level security;
alter table private.location_attempt_tombstones enable row level security;
alter table private.location_attempt_tombstones force row level security;
alter table private.personal_card_field_object_ledger enable row level security;
alter table private.personal_card_field_object_ledger force row level security;
alter table private.location_disclosure_accesses enable row level security;
alter table private.location_disclosure_accesses force row level security;
alter table private.location_correction_requests enable row level security;
alter table private.location_correction_requests force row level security;
alter table private.data_erasure_jobs enable row level security;
alter table private.data_erasure_jobs force row level security;
alter table private.data_erasure_manifest enable row level security;
alter table private.data_erasure_manifest force row level security;

revoke all on table private.minimum_age_attestations
  from public, anon, authenticated, service_role;
revoke all on table private.location_consents
  from public, anon, authenticated, service_role;
revoke all on table private.location_use_facts
  from public, anon, authenticated, service_role;
revoke all on table private.location_attempt_tombstones
  from public, anon, authenticated, service_role;
revoke all on table private.personal_card_field_object_ledger
  from public, anon, authenticated, service_role;
revoke all on table private.location_disclosure_accesses
  from public, anon, authenticated, service_role;
revoke all on table private.location_correction_requests
  from public, anon, authenticated, service_role;
revoke all on table private.data_erasure_jobs
  from public, anon, authenticated, service_role;
revoke all on table private.data_erasure_manifest
  from public, anon, authenticated, service_role;

-- -------------------------------------------------------------------------
-- Active-adult identity and exact attestation RPCs
-- -------------------------------------------------------------------------

create or replace function private.active_user_id_for_auth(
  p_auth_user_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select identity_row.user_id
  from private.user_identities as identity_row
  join auth.users as auth_user on auth_user.id = identity_row.auth_user_id
  where identity_row.auth_user_id = p_auth_user_id
    and identity_row.revoked_at is null
    and auth_user.deleted_at is null
  limit 1
$$;

create or replace function private.lock_active_user_id_for_auth(
  p_auth_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  select identity_row.user_id
  into v_user_id
  from private.user_identities as identity_row
  join auth.users as auth_user on auth_user.id = identity_row.auth_user_id
  where identity_row.auth_user_id = p_auth_user_id
    and identity_row.revoked_at is null
    and auth_user.deleted_at is null
  for share of identity_row;

  return v_user_id;
end;
$$;

create or replace function private.user_has_current_minimum_age_attestation(
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
    from private.minimum_age_attestations as attestation_row
    where attestation_row.user_id = p_user_id
      and attestation_row.minimum_age_passed
      and attestation_row.version = '18plus-v1'
  )
$$;

create or replace function private.location_attempt_owner_fingerprint(
  p_user_id uuid
)
returns bytea
language sql
immutable
strict
set search_path = ''
as $$
  select extensions.digest(
    'danyeodam:location-attempt-owner:v1:' || p_user_id::text,
    'sha256'
  )
$$;

create or replace function private.location_attempt_key_fingerprint(
  p_idempotency_key uuid
)
returns bytea
language sql
immutable
strict
set search_path = ''
as $$
  select extensions.digest(
    'danyeodam:location-attempt-key:v1:' || p_idempotency_key::text,
    'sha256'
  )
$$;

create or replace function private.location_attempt_is_tombstoned(
  p_user_id uuid,
  p_idempotency_key uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.location_attempt_tombstones as tombstone_row
    where tombstone_row.owner_fingerprint =
        private.location_attempt_owner_fingerprint(p_user_id)
      and tombstone_row.attempt_key_fingerprint =
        private.location_attempt_key_fingerprint(p_idempotency_key)
      and tombstone_row.expires_at > statement_timestamp()
  )
$$;

create or replace function private.adult_active_user_id_for_auth(
  p_auth_user_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select user_row.user_id
  from (
    select private.active_user_id_for_auth(p_auth_user_id) as user_id
  ) as user_row
  where user_row.user_id is not null
    and private.user_has_current_minimum_age_attestation(user_row.user_id)
$$;

create or replace function api_private.has_active_adult_identity(
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
  v_user_id := private.active_user_id_for_auth(p_auth_user_id);
  if v_user_id is null then
    return jsonb_build_object('status', 'inactive');
  end if;
  if not private.user_has_current_minimum_age_attestation(v_user_id) then
    return jsonb_build_object('status', 'minimum_age_attestation_required');
  end if;
  return jsonb_build_object('status', 'active');
end;
$$;

create or replace function api_private.has_active_service_identity(
  p_auth_user_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when private.active_user_id_for_auth(p_auth_user_id) is null
      then jsonb_build_object('status', 'inactive')
    else jsonb_build_object('status', 'active')
  end
$$;

create or replace function api_private.record_minimum_age_attestation(
  p_auth_user_id uuid,
  p_attestation jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_attested_at timestamptz;
begin
  if p_attestation is null
    or jsonb_typeof(p_attestation) is distinct from 'object'
    or not (p_attestation ?& array['minimum_age_passed', 'version']::text[])
    or p_attestation - array['minimum_age_passed', 'version']::text[]
      is distinct from '{}'::jsonb
    or jsonb_typeof(p_attestation -> 'minimum_age_passed')
      is distinct from 'boolean'
    or (p_attestation ->> 'minimum_age_passed')::boolean is not true
    or jsonb_typeof(p_attestation -> 'version') is distinct from 'string'
    or p_attestation ->> 'version' is distinct from '18plus-v1'
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  if p_auth_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  -- Take the auth-scoped advisory before any identity row lock. Recovery uses
  -- the same order, so an attestation cannot deadlock with identity rebinding.
  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:minimum-age-auth:' || p_auth_user_id::text,
    0
  ));

  v_user_id := private.lock_active_user_id_for_auth(p_auth_user_id);
  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  insert into private.minimum_age_attestations (
    user_id,
    minimum_age_passed,
    version
  ) values (
    v_user_id,
    true,
    '18plus-v1'
  )
  on conflict (user_id) do nothing;

  select attestation_row.attested_at
  into v_attested_at
  from private.minimum_age_attestations as attestation_row
  where attestation_row.user_id = v_user_id
    and attestation_row.minimum_age_passed
    and attestation_row.version = '18plus-v1';

  if v_attested_at is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  return jsonb_build_object('status', 'attested');
end;
$$;

-- Recovery changes the active logical user. Preserve a valid claimant-side
-- attestation in the same database transaction without copying any DOB or age
-- material (none exists in this model). A disposable claimant is required to
-- have zero acquisitions, so its incomplete/failed location attempts and
-- consent are minimized away instead of being merged into the recovered
-- identity. Keep the former implementation private so a caller cannot bypass
-- the merge wrapper.
alter function api_private.claim_recovery_code(uuid, text)
  rename to claim_recovery_code_before_minimum_age_merge;

revoke all on function api_private.claim_recovery_code_before_minimum_age_merge(
  uuid, text
) from public, anon, authenticated, service_role;

-- Guard the legitimate same-target case before the historical merge mutates
-- identities or deletes the disposable side. A user may issue a code, erase
-- their sole acquisition through correction/withdrawal, and then present the
-- still-valid code from the same anonymous auth. Consuming that code is an
-- idempotent restore; it must not self-merge and delete participant, demand,
-- analytics, age, or minimized location state.
alter function api_private.claim_recovery_code_before_minimum_age_merge(uuid, text)
  rename to claim_recovery_code_before_self_claim_guard;

revoke all on function api_private.claim_recovery_code_before_self_claim_guard(
  uuid, text
) from public, anon, authenticated, service_role;

create or replace function api_private.claim_recovery_code_before_minimum_age_merge(
  p_auth_user_id uuid,
  p_code_hash_hex text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_user_id uuid;
  v_target_user_id uuid;
  v_code_id uuid;
  v_is_anonymous boolean;
  v_now timestamptz := clock_timestamp();
  v_limit private.recovery_claim_limits%rowtype;
begin
  if p_auth_user_id is null
    or p_code_hash_hex is null
    or p_code_hash_hex !~ '^[0-9A-Fa-f]{64}$'
  then
    return api_private.claim_recovery_code_before_self_claim_guard(
      p_auth_user_id,
      p_code_hash_hex
    );
  end if;

  select identity_row.user_id, coalesce(auth_user.is_anonymous, false)
  into v_current_user_id, v_is_anonymous
  from private.user_identities as identity_row
  join auth.users as auth_user
    on auth_user.id = identity_row.auth_user_id
   and auth_user.deleted_at is null
  where identity_row.auth_user_id = p_auth_user_id
    and identity_row.revoked_at is null;

  select code_row.user_id
  into v_target_user_id
  from private.recovery_codes as code_row
  where code_row.code_hash = decode(lower(p_code_hash_hex), 'hex')
    and code_row.revoked_at is null
    and code_row.claimed_at is null
    and (code_row.expires_at is null or code_row.expires_at > v_now);

  if v_current_user_id is null
    or v_target_user_id is null
    or v_current_user_id <> v_target_user_id
  then
    return api_private.claim_recovery_code_before_self_claim_guard(
      p_auth_user_id,
      p_code_hash_hex
    );
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:recovery:target:' || v_target_user_id::text,
    0
  ));

  -- Match the historical claim lock order: target advisory, deterministic
  -- identity rows, then the recovery-code row.
  perform identity_row.id
  from private.user_identities as identity_row
  where identity_row.revoked_at is null
    and (
      identity_row.user_id = v_target_user_id
      or identity_row.auth_user_id = p_auth_user_id
    )
  order by identity_row.user_id::text, identity_row.auth_user_id::text
  for update;

  select identity_row.user_id, coalesce(auth_user.is_anonymous, false)
  into v_current_user_id, v_is_anonymous
  from private.user_identities as identity_row
  join auth.users as auth_user
    on auth_user.id = identity_row.auth_user_id
   and auth_user.deleted_at is null
  where identity_row.auth_user_id = p_auth_user_id
    and identity_row.revoked_at is null;

  select code_row.id, code_row.user_id
  into v_code_id, v_target_user_id
  from private.recovery_codes as code_row
  where code_row.code_hash = decode(lower(p_code_hash_hex), 'hex')
    and code_row.revoked_at is null
    and code_row.claimed_at is null
    and (code_row.expires_at is null or code_row.expires_at > v_now)
  for update;

  if v_current_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  if not v_is_anonymous then
    return jsonb_build_object('status', 'not_anonymous');
  end if;
  if v_code_id is null or v_current_user_id <> v_target_user_id then
    return api_private.claim_recovery_code_before_self_claim_guard(
      p_auth_user_id,
      p_code_hash_hex
    );
  end if;
  if exists (
    select 1
    from public.acquisitions as acquisition_row
    where acquisition_row.user_id = v_current_user_id
  ) then
    return jsonb_build_object('status', 'not_empty');
  end if;

  insert into private.recovery_claim_limits (
    auth_user_id,
    window_started_at,
    failed_attempts,
    locked_until,
    updated_at
  ) values (
    p_auth_user_id,
    v_now,
    0,
    null,
    v_now
  ) on conflict (auth_user_id) do nothing;

  select limit_row.*
  into v_limit
  from private.recovery_claim_limits as limit_row
  where limit_row.auth_user_id = p_auth_user_id
  for update;

  if v_limit.locked_until is not null and v_limit.locked_until > v_now then
    return jsonb_build_object(
      'status', 'rate_limited',
      'locked_minutes', greatest(
        1,
        ceil(extract(epoch from (v_limit.locked_until - v_now)) / 60)::integer
      )
    );
  end if;

  update private.recovery_codes
  set claimed_at = v_now,
      claimed_by_auth_user_id = p_auth_user_id
  where id = v_code_id
    and revoked_at is null
    and claimed_at is null;
  if not found then
    raise exception 'recovery code was consumed concurrently'
      using errcode = '40001';
  end if;

  delete from private.recovery_claim_limits
  where auth_user_id = p_auth_user_id;

  return jsonb_build_object('status', 'restored');
end;
$$;

-- The original claim function already takes the target advisory and then the
-- complete identity set FOR UPDATE in deterministic order. Copy the minimum-
-- age attestation only after that lock point, when the replacement binding is
-- inserted, so no wrapper-level SHARE lock can invert the order.
create or replace function private.copy_minimum_age_on_recovery_rebind()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_user_id uuid;
begin
  if current_setting('danyeodam.recovery_age_merge_auth', true)
      is distinct from new.auth_user_id::text
  then
    return new;
  end if;

  select identity_row.user_id
  into v_source_user_id
  from private.user_identities as identity_row
  where identity_row.auth_user_id = new.auth_user_id
    and identity_row.id <> new.id
    and identity_row.revoked_at is not null
  order by identity_row.revoked_at desc, identity_row.id desc
  limit 1;

  if v_source_user_id is not null
    and private.user_has_current_minimum_age_attestation(v_source_user_id)
  then
    insert into private.minimum_age_attestations (
      user_id,
      minimum_age_passed,
      version
    ) values (
      new.user_id,
      true,
      '18plus-v1'
    ) on conflict (user_id) do nothing;

    -- The old logical user can remain temporarily when another unclaimed
    -- recovery code or cleanup metadata still references it. The attestation
    -- nevertheless follows the successful active binding exactly once.
    if v_source_user_id <> new.user_id then
      delete from private.minimum_age_attestations
      where user_id = v_source_user_id;
    end if;
  end if;

  if v_source_user_id is not null and v_source_user_id <> new.user_id then
    -- The original recovery claim already holds the source identity row FOR
    -- UPDATE, which serializes every active-identity write. Take the standard
    -- owner lock before deleting zero-acquisition location state so no
    -- correction/withdrawal worker can outlive this successful rebind.
    perform pg_advisory_xact_lock(hashtextextended(
      'danyeodam:suspend-owner:' || v_source_user_id::text,
      0
    ));

    delete from private.data_erasure_jobs
    where user_id = v_source_user_id;

    delete from private.location_correction_requests
    where user_id = v_source_user_id;

    delete from private.location_disclosure_accesses
    where user_id = v_source_user_id;

    perform tombstone_row.attempt_key_fingerprint
    from private.location_attempt_tombstones as tombstone_row
    where tombstone_row.owner_fingerprint =
      private.location_attempt_owner_fingerprint(v_source_user_id)
    order by tombstone_row.attempt_key_fingerprint
    for update;

    -- The auth identity is now bound to the recovered target. Move every
    -- already-minimized tombstone, including rows whose fact/acquisition was
    -- erased by an earlier correction or withdrawal, without recovering the
    -- raw request key.
    insert into private.location_attempt_tombstones (
      owner_fingerprint,
      attempt_key_fingerprint,
      expires_at
    )
    select
      private.location_attempt_owner_fingerprint(new.user_id),
      tombstone_row.attempt_key_fingerprint,
      tombstone_row.expires_at
    from private.location_attempt_tombstones as tombstone_row
    where tombstone_row.owner_fingerprint =
      private.location_attempt_owner_fingerprint(v_source_user_id)
      and v_source_user_id <> new.user_id
    on conflict (owner_fingerprint, attempt_key_fingerprint) do update
    set expires_at = greatest(
      private.location_attempt_tombstones.expires_at,
      excluded.expires_at
    );

    -- Live facts may not yet have a tombstone. Create a bounded target marker
    -- before minimizing the source data.
    insert into private.location_attempt_tombstones (
      owner_fingerprint,
      attempt_key_fingerprint,
      expires_at
    )
    select distinct
      private.location_attempt_owner_fingerprint(new.user_id),
      private.location_attempt_key_fingerprint(fact_row.idempotency_key),
      clock_timestamp() + interval '6 months'
    from private.location_use_facts as fact_row
    where fact_row.user_id = v_source_user_id
    on conflict (owner_fingerprint, attempt_key_fingerprint) do update
    set expires_at = greatest(
      private.location_attempt_tombstones.expires_at,
      excluded.expires_at
    );

    delete from private.location_attempt_tombstones as tombstone_row
    where tombstone_row.owner_fingerprint =
      private.location_attempt_owner_fingerprint(v_source_user_id)
      and v_source_user_id <> new.user_id;

    delete from analytics.events as event_row
    where event_row.user_id = v_source_user_id
      and (
        event_row.location_use_fact_id in (
          select fact_row.id
          from private.location_use_facts as fact_row
          where fact_row.user_id = v_source_user_id
        )
        or (
          event_row.source = 'server'
          and event_row.event_name = 'acquire_fail'
        )
      );

    delete from private.location_use_facts
    where user_id = v_source_user_id;

    delete from private.location_consents
    where user_id = v_source_user_id;

    delete from private.policy_acceptances as acceptance_row
    using private.policy_documents as document_row
    where acceptance_row.user_id = v_source_user_id
      and document_row.id = acceptance_row.policy_document_id
      and document_row.policy_type = 'location_terms';
  end if;
  return new;
end;
$$;

create trigger user_identities_copy_minimum_age_on_recovery_rebind
after insert on private.user_identities
for each row execute function private.copy_minimum_age_on_recovery_rebind();

create or replace function api_private.claim_recovery_code(
  p_auth_user_id uuid,
  p_code_hash_hex text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_auth_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  -- Do not take an identity SHARE lock before the original claim function's
  -- deterministic FOR UPDATE lock set. The auth advisory serializes same-
  -- claimant claims and attestation without changing cross-claim row order.
  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:minimum-age-auth:' || p_auth_user_id::text,
    0
  ));

  perform set_config(
    'danyeodam.recovery_age_merge_auth',
    p_auth_user_id::text,
    true
  );

  v_result := api_private.claim_recovery_code_before_minimum_age_merge(
    p_auth_user_id,
    p_code_hash_hex
  );

  perform set_config('danyeodam.recovery_age_merge_auth', 'disabled', true);

  return v_result;
end;
$$;

create or replace function api_private.get_minimum_age_attestation(
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
  v_attested_at timestamptz;
begin
  v_user_id := private.active_user_id_for_auth(p_auth_user_id);
  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  select attestation_row.attested_at
  into v_attested_at
  from private.minimum_age_attestations as attestation_row
  where attestation_row.user_id = v_user_id
    and attestation_row.minimum_age_passed
    and attestation_row.version = '18plus-v1';

  if v_attested_at is null then
    return jsonb_build_object('status', 'missing');
  end if;
  return jsonb_build_object(
    'status', 'attested',
    'minimum_age_passed', true,
    'version', '18plus-v1',
    'attested_at', v_attested_at
  );
end;
$$;

-- Field-attempt/card-start client events have no exact idempotency/fact/card
-- correlation and could be reinserted offline after erasure. Stage 0 derives
-- attempt metrics from server location-use facts instead; keep only the two
-- non-location client events in this transport.
alter function api_private.ingest_client_events(uuid, boolean, jsonb)
  rename to ingest_client_events_before_location_compliance;

revoke all on function api_private.ingest_client_events_before_location_compliance(
  uuid, boolean, jsonb
) from public, anon, authenticated, service_role;

create or replace function api_private.ingest_client_events(
  p_auth_user_id uuid,
  p_public_gate_open boolean,
  p_events jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_events is not null
    and jsonb_typeof(p_events) = 'array'
    and exists (
      select 1
      from jsonb_array_elements(p_events) as input_row(value)
      where input_row.value ->> 'event_name' in (
        'acquire_attempt',
        'personal_card_started'
      )
    )
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  return api_private.ingest_client_events_before_location_compliance(
    p_auth_user_id,
    p_public_gate_open,
    p_events
  );
end;
$$;

-- -------------------------------------------------------------------------
-- Location consent lifecycle. Location acceptance is deliberately separate
-- from the two-policy UGC acceptance payload.
-- -------------------------------------------------------------------------

create or replace function private.current_location_policy_requirement()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select jsonb_build_object(
        'type', document_row.policy_type,
        'version', document_row.version
      )
      from private.policy_documents as document_row
      where document_row.policy_type = 'location_terms'
        and document_row.is_current
        and document_row.effective_at <= statement_timestamp()
        and private.policy_document_is_complete(document_row.id)
      limit 1
    ),
    '{}'::jsonb
  )
$$;

create or replace function private.user_has_current_location_acceptance(
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
    from private.location_consents as consent_row
    join private.policy_acceptances as acceptance_row
      on acceptance_row.id = consent_row.policy_acceptance_id
     and acceptance_row.user_id = consent_row.user_id
    join private.policy_documents as document_row
      on document_row.id = acceptance_row.policy_document_id
    join private.policy_document_locales as locale_row
      on locale_row.policy_document_id = acceptance_row.policy_document_id
     and locale_row.locale = acceptance_row.accepted_locale
     and locale_row.sha256 = acceptance_row.accepted_sha256
    where consent_row.user_id = p_user_id
      and document_row.policy_type = 'location_terms'
      and document_row.is_current
      and document_row.effective_at <= statement_timestamp()
      and private.policy_document_is_complete(document_row.id)
  )
$$;

create or replace function private.user_has_current_location_consent(
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.user_has_current_location_acceptance(p_user_id)
    and exists (
      select 1
      from private.location_consents as consent_row
      where consent_row.user_id = p_user_id
        and consent_row.state = 'active'
    )
$$;

create or replace function private.location_access_error(
  p_user_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_state private.location_consent_state;
begin
  if not private.user_has_current_minimum_age_attestation(p_user_id) then
    return 'MINIMUM_AGE_ATTESTATION_REQUIRED';
  end if;

  if exists (
    select 1
    from private.data_erasure_jobs as job_row
    where job_row.user_id = p_user_id
      and job_row.scope = 'location_withdrawal'
      and job_row.state <> 'completed'
  ) then
    return 'LOCATION_WITHDRAWAL_PENDING';
  end if;

  select consent_row.state
  into v_state
  from private.location_consents as consent_row
  where consent_row.user_id = p_user_id;

  if v_state is null then
    return 'LOCATION_CONSENT_REQUIRED';
  end if;
  if v_state = 'paused' then
    return 'LOCATION_USE_PAUSED';
  end if;
  if v_state = 'withdrawal_pending' then
    return 'LOCATION_WITHDRAWAL_PENDING';
  end if;
  if not private.user_has_current_location_consent(p_user_id) then
    return 'LOCATION_CONSENT_REQUIRED';
  end if;
  return null;
end;
$$;

create or replace function api_private.get_location_consent(
  p_auth_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_consent record;
begin
  v_user_id := private.active_user_id_for_auth(p_auth_user_id);
  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  select
    consent_row.state,
    consent_row.consented_at,
    consent_row.updated_at,
    consent_row.withdrawal_requested_at,
    document_row.version,
    acceptance_row.accepted_locale
  into v_consent
  from private.location_consents as consent_row
  join private.policy_acceptances as acceptance_row
    on acceptance_row.id = consent_row.policy_acceptance_id
   and acceptance_row.user_id = consent_row.user_id
  join private.policy_documents as document_row
    on document_row.id = acceptance_row.policy_document_id
   and document_row.policy_type = 'location_terms'
  where consent_row.user_id = v_user_id;

  if not found then
    return jsonb_build_object(
      'status', 'missing',
      'required', private.current_location_policy_requirement()
    );
  end if;

  return jsonb_build_object(
    'status', 'found',
    'consent', jsonb_build_object(
      'state', v_consent.state,
      'policy_version', v_consent.version,
      'locale', v_consent.accepted_locale,
      'consented_at', v_consent.consented_at,
      'updated_at', v_consent.updated_at,
      'withdrawal_requested_at', v_consent.withdrawal_requested_at,
      'is_current', private.user_has_current_location_acceptance(v_user_id)
    )
  );
end;
$$;

create or replace function api_private.accept_location_consent(
  p_auth_user_id uuid,
  p_acceptance jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_document_id uuid;
  v_locale public.content_locale;
  v_sha256 bytea;
  v_acceptance_id uuid;
  v_existing_state private.location_consent_state;
  v_now timestamptz := clock_timestamp();
begin
  v_user_id := private.lock_active_user_id_for_auth(p_auth_user_id);
  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  if not private.user_has_current_minimum_age_attestation(v_user_id) then
    return jsonb_build_object('status', 'minimum_age_attestation_required');
  end if;

  if p_acceptance is null
    or jsonb_typeof(p_acceptance) <> 'object'
    or p_acceptance - array['version', 'locale']::text[] <> '{}'::jsonb
    or jsonb_typeof(p_acceptance -> 'version') <> 'string'
    or jsonb_typeof(p_acceptance -> 'locale') <> 'string'
    or p_acceptance ->> 'locale' not in ('ko', 'en', 'ja', 'zh-Hans', 'zh-Hant', 'vi')
  then
    return jsonb_build_object('status', 'invalid');
  end if;

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
    from private.data_erasure_jobs as job_row
    where job_row.user_id = v_user_id
      and job_row.scope = 'location_withdrawal'
      and job_row.state <> 'completed'
  ) then
    return jsonb_build_object('status', 'location_withdrawal_pending');
  end if;

  select document_row.id, locale_row.locale, locale_row.sha256
  into v_document_id, v_locale, v_sha256
  from private.policy_documents as document_row
  join private.policy_document_locales as locale_row
    on locale_row.policy_document_id = document_row.id
   and locale_row.locale::text = p_acceptance ->> 'locale'
  where document_row.policy_type = 'location_terms'
    and document_row.version = p_acceptance ->> 'version'
    and document_row.is_current
    and document_row.effective_at <= statement_timestamp()
    and private.policy_document_is_complete(document_row.id)
  for share of document_row;

  if v_document_id is null then
    return jsonb_build_object(
      'status', 'location_consent_required',
      'required', private.current_location_policy_requirement()
    );
  end if;

  select consent_row.state
  into v_existing_state
  from private.location_consents as consent_row
  where consent_row.user_id = v_user_id
  for update;

  if v_existing_state = 'withdrawal_pending' then
    return jsonb_build_object('status', 'location_withdrawal_pending');
  end if;

  insert into private.policy_acceptances (
    user_id,
    policy_document_id,
    accepted_locale,
    accepted_sha256
  ) values (
    v_user_id,
    v_document_id,
    v_locale,
    v_sha256
  )
  on conflict (user_id, policy_document_id) do nothing
  returning id into v_acceptance_id;

  if v_acceptance_id is null then
    select acceptance_row.id
    into v_acceptance_id
    from private.policy_acceptances as acceptance_row
    where acceptance_row.user_id = v_user_id
      and acceptance_row.policy_document_id = v_document_id
      and acceptance_row.accepted_locale = v_locale
      and acceptance_row.accepted_sha256 = v_sha256;
  end if;

  if v_acceptance_id is null then
    return jsonb_build_object(
      'status', 'location_consent_required',
      'required', private.current_location_policy_requirement()
    );
  end if;

  insert into private.location_consents (
    user_id,
    state,
    policy_acceptance_id,
    consented_at,
    updated_at
  ) values (
    v_user_id,
    'active',
    v_acceptance_id,
    v_now,
    v_now
  )
  on conflict (user_id) do update
  set state = case
        when private.location_consents.state = 'paused'
          then 'paused'::private.location_consent_state
        else 'active'::private.location_consent_state
      end,
      policy_acceptance_id = excluded.policy_acceptance_id,
      consented_at = excluded.consented_at,
      updated_at = excluded.updated_at,
      withdrawal_requested_at = null
  where private.location_consents.state <> 'withdrawal_pending';

  -- Accepting a rotated policy is not an implicit resume action. Only the
  -- explicit PATCH state=active path may lift a user-selected pause.
  if v_existing_state = 'paused' then
    return jsonb_build_object('status', 'paused');
  end if;

  if not private.user_has_current_location_consent(v_user_id) then
    return jsonb_build_object(
      'status', 'location_consent_required',
      'required', private.current_location_policy_requirement()
    );
  end if;
  return jsonb_build_object('status', 'active');
end;
$$;

create or replace function api_private.change_location_consent_state(
  p_auth_user_id uuid,
  p_state text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_consent private.location_consents%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  v_user_id := private.lock_active_user_id_for_auth(p_auth_user_id);
  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  if p_state not in ('active', 'paused') then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_state = 'active'
    and not private.user_has_current_minimum_age_attestation(v_user_id)
  then
    return jsonb_build_object('status', 'minimum_age_attestation_required');
  end if;

  if p_state = 'active' then
    perform pg_advisory_xact_lock_shared(hashtextextended(
      'danyeodam:policy-current-set',
      0
    ));
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_user_id::text,
    0
  ));

  select consent_row.*
  into v_consent
  from private.location_consents as consent_row
  where consent_row.user_id = v_user_id
  for update;

  if not found then
    return jsonb_build_object(
      'status', 'location_consent_required',
      'required', private.current_location_policy_requirement()
    );
  end if;
  if v_consent.state = 'withdrawal_pending' then
    return jsonb_build_object('status', 'location_withdrawal_pending');
  end if;
  if p_state = 'active' and not private.user_has_current_location_acceptance(v_user_id) then
    return jsonb_build_object(
      'status', 'location_consent_required',
      'required', private.current_location_policy_requirement()
    );
  end if;

  update private.location_consents
  set state = p_state::private.location_consent_state,
      updated_at = v_now
  where user_id = v_user_id;

  return jsonb_build_object('status', p_state);
end;
$$;

-- -------------------------------------------------------------------------
-- Field-derived photo/share invariant and withdrawal serialization
-- -------------------------------------------------------------------------

-- Existing field shares predate the new age/location boundary. Rotate every
-- pending or active secret fail-closed instead of letting a future publication
-- gate revive an unconsented legacy share. The aggregate NOTICE is deployment
-- evidence only and contains no user or object identifier.
alter table public.personal_cards
  drop constraint personal_cards_share_state_consistent,
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
          and share_reason_code in (
            'LEGACY_SLUG_ROTATION_REQUIRED',
            'LOCATION_RECONSENT_REQUIRED'
          )
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

do $$
declare
  v_privatized_count integer;
begin
  update public.personal_cards as card_row
  set share_state = 'private',
      share_slug = null,
      shared_at = null,
      share_submitted_at = null,
      share_terms_acceptance_id = null,
      share_community_acceptance_id = null,
      share_resubmission_required = true,
      share_reason_code = 'LOCATION_RECONSENT_REQUIRED',
      share_reviewed_at = null,
      share_reviewed_by = null,
      share_reviewed_by_redacted_at = null
  from public.acquisitions as acquisition_row
  where card_row.acquisition_id = acquisition_row.id
    and card_row.user_id = acquisition_row.user_id
    and acquisition_row.acquisition_type = 'field'
    and card_row.share_state in ('pending', 'active');
  get diagnostics v_privatized_count = row_count;

  if exists (
    select 1
    from public.personal_cards as card_row
    join public.acquisitions as acquisition_row
      on acquisition_row.id = card_row.acquisition_id
     and acquisition_row.user_id = card_row.user_id
    where acquisition_row.acquisition_type = 'field'
      and card_row.share_state in ('pending', 'active')
  ) then
    raise exception 'field share privacy cutover left a public candidate'
      using errcode = '23514';
  end if;

  raise notice 'location compliance cutover privatized % field share(s)',
    v_privatized_count;
end;
$$;

create or replace function private.location_access_code_to_rpc_status(
  p_code text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_code
    when 'MINIMUM_AGE_ATTESTATION_REQUIRED' then 'minimum_age_attestation_required'
    when 'LOCATION_CONSENT_REQUIRED' then 'location_consent_required'
    when 'LOCATION_USE_PAUSED' then 'location_use_paused'
    when 'LOCATION_WITHDRAWAL_PENDING' then 'location_withdrawal_pending'
    else 'unauthorized'
  end
$$;

create or replace function private.lock_user_adult_location_access(
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_access_error text;
begin
  perform pg_advisory_xact_lock_shared(hashtextextended(
    'danyeodam:policy-current-set',
    0
  ));

  perform attestation_row.user_id
  from private.minimum_age_attestations as attestation_row
  where attestation_row.user_id = p_user_id
    and attestation_row.minimum_age_passed
    and attestation_row.version = '18plus-v1'
  for share of attestation_row;
  if not found then
    return jsonb_build_object(
      'status', 'error',
      'code', 'MINIMUM_AGE_ATTESTATION_REQUIRED'
    );
  end if;

  perform consent_row.user_id
  from private.location_consents as consent_row
  where consent_row.user_id = p_user_id
  for share of consent_row;

  v_access_error := private.location_access_error(p_user_id);
  if v_access_error is not null then
    return jsonb_build_object('status', 'error', 'code', v_access_error);
  end if;
  return jsonb_build_object('status', 'active');
end;
$$;

create or replace function private.field_acquisition_has_pending_correction(
  p_user_id uuid,
  p_acquisition_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.acquisitions as acquisition_row
    join private.location_correction_requests as request_row
      on request_row.user_id = acquisition_row.user_id
     and (
       request_row.field_acquisition_id = acquisition_row.id
       or request_row.location_use_fact_id in (
         select fact_row.id
         from private.location_use_facts as fact_row
         where fact_row.user_id = acquisition_row.user_id
           and fact_row.idempotency_key = acquisition_row.idempotency_key
           and fact_row.spot_id = acquisition_row.spot_id
           and fact_row.purpose = 'field_acquisition'
       )
     )
    where acquisition_row.id = p_acquisition_id
      and acquisition_row.user_id = p_user_id
      and acquisition_row.acquisition_type = 'field'
      and request_row.status = 'approved_pending_correction'
  )
$$;

create or replace function private.enforce_field_object_ledger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.acquisitions as acquisition_row
    where acquisition_row.id = new.field_acquisition_id
      and acquisition_row.user_id = new.user_id
      and acquisition_row.acquisition_type = 'field'
  ) then
    raise exception 'object ledger requires an owned field acquisition'
      using errcode = '23514';
  end if;
  if not exists (
    select 1
    from private.personal_card_temp_uploads as upload_row
    where upload_row.id = new.upload_id
      and upload_row.user_id = new.user_id
      and (
        (
          new.bucket = 'personal-card-temp'
          and upload_row.temp_path = new.object_path
          and new.final_delete_not_before >=
            upload_row.signed_url_expires_at + interval '10 minutes'
        )
        or (
          new.bucket = 'personal-cards'
          and new.object_path =
            new.user_id::text || '/' || new.processing_token::text || '.webp'
          and upload_row.processing_token = new.processing_token
          and upload_row.processing_permanent_path = new.object_path
          and new.final_delete_not_before >=
            upload_row.processing_expires_at + interval '10 minutes'
        )
      )
  ) then
    raise exception 'object ledger requires an exact owned upload path'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger personal_card_field_object_ledger_owned
before insert or update of
  user_id, field_acquisition_id, upload_id, processing_token,
  bucket, object_path, final_delete_not_before
on private.personal_card_field_object_ledger
for each row execute function private.enforce_field_object_ledger();

-- A request may have entered the pre-cutover promotion function before this
-- migration committed and resume afterwards with that historical function
-- body. Its processing-row UPDATE is therefore the last DB-owned point at
-- which both Storage paths can be made durable. This trigger deliberately
-- takes no advisory/owner locks: the historical body already holds the temp
-- row, while withdrawal uses owner -> temp-row order. The insert is fully
-- idempotent with the current wrapper's explicit registration.
create or replace function private.ensure_field_promotion_object_ledger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if new.promoted_at is not null
    or new.processing_token is null
    or new.processing_expires_at is null
    or new.processing_acquisition_id is null
    or new.processing_permanent_path is null
  then
    return new;
  end if;

  select acquisition_row.user_id
  into v_user_id
  from public.acquisitions as acquisition_row
  where acquisition_row.id = new.processing_acquisition_id
    and acquisition_row.user_id = new.user_id
    and acquisition_row.acquisition_type = 'field';

  if v_user_id is null then
    return new;
  end if;

  insert into private.personal_card_field_object_ledger (
    user_id,
    field_acquisition_id,
    upload_id,
    processing_token,
    bucket,
    object_path,
    final_delete_not_before,
    next_attempt_at
  )
  select
    new.user_id,
    new.processing_acquisition_id,
    new.id,
    new.processing_token,
    path_row.bucket,
    path_row.object_path,
    path_row.final_delete_not_before,
    path_row.initial_next_attempt_at
  from (
    values
      (
        'personal-card-temp'::text,
        new.temp_path,
        new.signed_url_expires_at + interval '10 minutes',
        new.promotion_expires_at
      ),
      (
        'personal-cards'::text,
        new.processing_permanent_path,
        new.processing_expires_at + interval '10 minutes',
        clock_timestamp()
      )
  ) as path_row(
    bucket,
    object_path,
    final_delete_not_before,
    initial_next_attempt_at
  )
  on conflict (object_path) do update
  set processing_token = excluded.processing_token,
      next_attempt_at = least(
        private.personal_card_field_object_ledger.next_attempt_at,
        excluded.next_attempt_at
      )
  where private.personal_card_field_object_ledger.bucket = 'personal-card-temp'
    and private.personal_card_field_object_ledger.user_id = excluded.user_id
    and private.personal_card_field_object_ledger.field_acquisition_id =
      excluded.field_acquisition_id
    and private.personal_card_field_object_ledger.upload_id = excluded.upload_id
    and private.personal_card_field_object_ledger.state = 'active';

  if (
    select count(*)
    from private.personal_card_field_object_ledger as ledger_row
    where ledger_row.user_id = new.user_id
      and ledger_row.field_acquisition_id = new.processing_acquisition_id
      and ledger_row.upload_id = new.id
      and ledger_row.processing_token = new.processing_token
      and ledger_row.state = 'active'
      and (
        (
          ledger_row.bucket = 'personal-card-temp'
          and ledger_row.object_path = new.temp_path
        )
        or (
          ledger_row.bucket = 'personal-cards'
          and ledger_row.object_path = new.processing_permanent_path
        )
      )
  ) <> 2 then
    raise exception 'historical field promotion ledger registration mismatch'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger personal_card_temp_uploads_field_ledger_compatibility
after update of
  processing_token, processing_expires_at, processing_acquisition_id,
  processing_permanent_path
on private.personal_card_temp_uploads
for each row execute function private.ensure_field_promotion_object_ledger();

-- Post-cutover field acquisitions are legal only when the current
-- context->commit flow has already created the exact pending decision fact.
-- This is an AFTER trigger so base FK/unique/check errors retain their
-- canonical SQLSTATE. A queued historical commit has no such fact and rolls
-- back before it can write its nullable terminal event.
create or replace function private.enforce_field_acquisition_location_fact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fact private.location_use_facts%rowtype;
begin
  if new.acquisition_type <> 'field' then
    return new;
  end if;

  select fact_row.*
  into v_fact
  from private.location_use_facts as fact_row
  where fact_row.user_id = new.user_id
    and fact_row.idempotency_key = new.idempotency_key
    and fact_row.purpose = 'field_acquisition'
  for update;

  if v_fact.id is null
    or v_fact.spot_id <> new.spot_id
    or v_fact.outcome <> 'pending'
    or v_fact.decided_at is not null
    or v_fact.terminal_failure_code is not null
    or v_fact.terminal_failure_details <> '{}'::jsonb
    or private.location_attempt_is_tombstoned(
      new.user_id,
      new.idempotency_key
    )
    or exists (
      select 1
      from private.location_correction_requests as request_row
      where request_row.user_id = new.user_id
        and request_row.location_use_fact_id = v_fact.id
        and request_row.status = 'approved_pending_correction'
    )
  then
    raise exception 'field acquisition requires one exact pending location fact'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger acquisitions_field_location_fact_compatibility
after insert on public.acquisitions
for each row execute function private.enforce_field_acquisition_location_fact();

-- The historical commit writes acquire_success without the new FK. Fill it
-- from the exact acquisition timestamp and pre-existing fact before CHECK
-- constraints run, then make the terminal transition in the same statement.
-- The current wrapper is idempotent with this trigger and re-verifies the
-- exact single event before returning.
create or replace function private.correlate_server_acquire_success()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fact private.location_use_facts%rowtype;
begin
  if new.event_name <> 'acquire_success'
    or new.source <> 'server'
  then
    return new;
  end if;

  select fact_row.*
  into v_fact
  from public.acquisitions as acquisition_row
  join private.location_use_facts as fact_row
    on fact_row.user_id = acquisition_row.user_id
   and fact_row.idempotency_key = acquisition_row.idempotency_key
   and fact_row.spot_id = acquisition_row.spot_id
   and fact_row.purpose = 'field_acquisition'
  where acquisition_row.user_id = new.user_id
    and acquisition_row.spot_id = new.spot_id
    and acquisition_row.acquisition_type = 'field'
    and acquisition_row.acquired_at = new.occurred_at
    and (
      new.location_use_fact_id is null
      or fact_row.id = new.location_use_fact_id
    )
  for update of fact_row;

  if v_fact.id is null
    or v_fact.outcome not in ('pending', 'passed')
    or exists (
      select 1
      from private.location_correction_requests as request_row
      where request_row.user_id = v_fact.user_id
        and request_row.location_use_fact_id = v_fact.id
        and request_row.status = 'approved_pending_correction'
    )
  then
    raise exception 'server acquire success requires one exact location fact'
      using errcode = '23514';
  end if;

  new.location_use_fact_id := v_fact.id;
  update private.location_use_facts as fact_row
  set outcome = 'passed',
      decided_at = coalesce(fact_row.decided_at, new.occurred_at),
      terminal_failure_code = null,
      terminal_failure_details = '{}'::jsonb
  where fact_row.id = v_fact.id
    and fact_row.outcome = 'pending';

  return new;
end;
$$;

create trigger analytics_events_acquire_success_compatibility
before insert or update of
  user_id, event_name, source, occurred_at, spot_id, location_use_fact_id
on analytics.events
for each row execute function private.correlate_server_acquire_success();

create or replace function private.enforce_field_personal_card_location_access()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_acquisition_type public.acquisition_type;
begin
  select acquisition_row.acquisition_type
  into v_acquisition_type
  from public.acquisitions as acquisition_row
  where acquisition_row.id = new.acquisition_id
    and acquisition_row.user_id = new.user_id;

  if v_acquisition_type = 'field'
    and (
      tg_op = 'INSERT'
      or (
        tg_op = 'UPDATE'
        and new.share_state in ('pending', 'active')
        and new.share_state is distinct from old.share_state
      )
    )
  then
    perform pg_advisory_xact_lock_shared(hashtextextended(
      'danyeodam:policy-current-set',
      0
    ));

    if (
      not private.user_has_current_minimum_age_attestation(new.user_id)
      or not private.user_has_current_location_consent(new.user_id)
      or private.field_acquisition_has_pending_correction(
        new.user_id,
        new.acquisition_id
      )
    ) then
      raise exception 'field personal-card derivatives require adult active current location consent'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger personal_cards_field_location_access
before insert or update of share_state on public.personal_cards
for each row execute function private.enforce_field_personal_card_location_access();

alter function api_private.begin_personal_card_promotion(
  uuid, boolean, uuid, text, text, uuid
) rename to begin_personal_card_promotion_after_location_compliance;
alter function api_private.complete_personal_card_promotion(
  uuid, uuid, uuid, uuid, text, text
) rename to complete_personal_card_promotion_after_location_compliance;
alter function api_private.create_personal_card_share(
  uuid, boolean, boolean, uuid, text
) rename to create_personal_card_share_after_location_compliance;
alter function api_private.revoke_personal_card_share(
  uuid, uuid
) rename to revoke_personal_card_share_after_location_compliance;
alter function api_private.moderate_personal_card_share(
  uuid, uuid, uuid, text, text, text, boolean
) rename to moderate_personal_card_share_after_location_compliance;

revoke all on function api_private.begin_personal_card_promotion_after_location_compliance(
  uuid, boolean, uuid, text, text, uuid
) from public, anon, authenticated, service_role;
revoke all on function api_private.complete_personal_card_promotion_after_location_compliance(
  uuid, uuid, uuid, uuid, text, text
) from public, anon, authenticated, service_role;
revoke all on function api_private.create_personal_card_share_after_location_compliance(
  uuid, boolean, boolean, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function api_private.revoke_personal_card_share_after_location_compliance(
  uuid, uuid
) from public, anon, authenticated, service_role;
revoke all on function api_private.moderate_personal_card_share_after_location_compliance(
  uuid, uuid, uuid, text, text, text, boolean
) from public, anon, authenticated, service_role;

create or replace function private.lock_field_derivative_access(
  p_auth_user_id uuid,
  p_acquisition_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_type public.acquisition_type;
  v_access jsonb;
begin
  v_user_id := private.lock_active_user_id_for_auth(p_auth_user_id);
  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  select acquisition_row.acquisition_type
  into v_type
  from public.acquisitions as acquisition_row
  where acquisition_row.id = p_acquisition_id
    and acquisition_row.user_id = v_user_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- The wrapped UGC RPC also reads the current policy set for retro/gift.
  -- Acquire the shared policy lock before owner serialization for every type;
  -- only the age/location checks below remain field-specific.
  perform pg_advisory_xact_lock_shared(hashtextextended(
    'danyeodam:policy-current-set',
    0
  ));

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_user_id::text,
    0
  ));

  if v_type = 'field' then
    if private.field_acquisition_has_pending_correction(v_user_id, p_acquisition_id) then
      return jsonb_build_object('status', 'location_correction_pending');
    end if;
    v_access := private.lock_user_adult_location_access(v_user_id);
    if v_access ->> 'status' <> 'active' then
      return jsonb_build_object(
        'status',
        private.location_access_code_to_rpc_status(v_access ->> 'code')
      );
    end if;
  end if;

  return jsonb_build_object('status', 'active', 'acquisition_type', v_type);
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
  v_access jsonb;
  v_result jsonb;
begin
  v_user_id := private.lock_active_user_id_for_auth(p_auth_user_id);
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

  v_access := private.lock_field_derivative_access(p_auth_user_id, p_acquisition_id);
  if v_access ->> 'status' <> 'active' then
    return v_access;
  end if;

  if v_access ->> 'acquisition_type' = 'field' and exists (
    select 1
    from private.personal_card_field_object_ledger as ledger_row
    where ledger_row.bucket = 'personal-card-temp'
      and ledger_row.object_path = p_temp_path
      and (
        ledger_row.user_id <> v_user_id
        or ledger_row.field_acquisition_id <> p_acquisition_id
        or ledger_row.state <> 'active'
      )
  ) then
    return jsonb_build_object('status', 'validation_failed');
  end if;

  v_result := api_private.begin_personal_card_promotion_after_location_compliance(
    p_auth_user_id,
    p_public_gate_open,
    p_acquisition_id,
    p_temp_path,
    p_caption,
    p_processing_token
  );

  if v_access ->> 'acquisition_type' = 'field'
    and v_result ->> 'status' = 'ready'
  then
    insert into private.personal_card_field_object_ledger (
      user_id,
      field_acquisition_id,
      upload_id,
      processing_token,
      bucket,
      object_path,
      final_delete_not_before,
      next_attempt_at
    )
    select
      v_user_id,
      p_acquisition_id,
      upload_row.id,
      p_processing_token,
      path_row.bucket,
      path_row.object_path,
      path_row.final_delete_not_before,
      path_row.initial_next_attempt_at
    from private.personal_card_temp_uploads as upload_row
    cross join lateral (
      values
        (
          'personal-card-temp'::text,
          upload_row.temp_path,
          upload_row.signed_url_expires_at + interval '10 minutes',
          upload_row.promotion_expires_at
        ),
        (
          'personal-cards'::text,
          v_result ->> 'permanent_path',
          upload_row.processing_expires_at + interval '10 minutes',
          clock_timestamp()
        )
    ) as path_row(
      bucket,
      object_path,
      final_delete_not_before,
      initial_next_attempt_at
    )
    where upload_row.id = (v_result ->> 'upload_id')::uuid
      and upload_row.user_id = v_user_id
      and upload_row.temp_path = v_result ->> 'temp_path'
    on conflict (object_path) do update
    set processing_token = excluded.processing_token,
        next_attempt_at = least(
          private.personal_card_field_object_ledger.next_attempt_at,
          excluded.next_attempt_at
        )
    where private.personal_card_field_object_ledger.bucket = 'personal-card-temp'
      and private.personal_card_field_object_ledger.user_id = excluded.user_id
      and private.personal_card_field_object_ledger.field_acquisition_id =
        excluded.field_acquisition_id
      and private.personal_card_field_object_ledger.upload_id = excluded.upload_id
      and private.personal_card_field_object_ledger.state = 'active';

    if (
      select count(*)
      from private.personal_card_field_object_ledger as ledger_row
      where ledger_row.user_id = v_user_id
        and ledger_row.field_acquisition_id = p_acquisition_id
        and ledger_row.upload_id = (v_result ->> 'upload_id')::uuid
        and ledger_row.processing_token = p_processing_token
        and ledger_row.state = 'active'
        and (
          (
            ledger_row.bucket = 'personal-card-temp'
            and ledger_row.object_path = v_result ->> 'temp_path'
          )
          or (
            ledger_row.bucket = 'personal-cards'
            and ledger_row.object_path = v_result ->> 'permanent_path'
          )
        )
    ) <> 2 then
      raise exception 'field object ledger registration mismatch'
        using errcode = '23514';
    end if;
  end if;

  return v_result;
end;
$$;

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
  v_access jsonb;
  v_result jsonb;
  v_ledger_state text;
begin
  v_access := private.lock_field_derivative_access(p_auth_user_id, p_acquisition_id);
  if v_access ->> 'status' <> 'active' then
    return v_access;
  end if;

  v_user_id := private.active_user_id_for_auth(p_auth_user_id);
  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  if v_access ->> 'acquisition_type' = 'field' then
    select ledger_row.state
    into v_ledger_state
    from private.personal_card_field_object_ledger as ledger_row
    where ledger_row.user_id = v_user_id
      and ledger_row.field_acquisition_id = p_acquisition_id
      and ledger_row.processing_token = p_processing_token
      and ledger_row.bucket = 'personal-cards'
      and ledger_row.object_path = p_permanent_path
    for update;

    if found and v_ledger_state <> 'active' then
      return jsonb_build_object('status', 'stale');
    end if;
    if not found and not exists (
      select 1
      from public.personal_cards as card_row
      where card_row.user_id = v_user_id
        and card_row.acquisition_id = p_acquisition_id
        and card_row.photo_path = p_permanent_path
    ) then
      return jsonb_build_object('status', 'stale');
    end if;
  end if;

  v_result := api_private.complete_personal_card_promotion_after_location_compliance(
    p_auth_user_id,
    p_upload_id,
    p_processing_token,
    p_acquisition_id,
    p_permanent_path,
    p_caption
  );

  if v_access ->> 'acquisition_type' = 'field'
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
      raise exception 'completed card does not reference the exact permanent object'
        using errcode = '23514';
    end if;

    delete from private.personal_card_field_object_ledger as ledger_row
    where ledger_row.user_id = v_user_id
      and ledger_row.field_acquisition_id = p_acquisition_id
      and ledger_row.processing_token = p_processing_token
      and ledger_row.state = 'active';
  end if;

  if v_result ->> 'status' = 'created' then
    update analytics.events as event_row
    set personal_card_id = (v_result ->> 'personal_card_id')::uuid
    where event_row.id = (
      select candidate.id
      from analytics.events as candidate
      join public.personal_cards as card_row
        on card_row.id = (v_result ->> 'personal_card_id')::uuid
       and card_row.user_id = candidate.user_id
      where candidate.event_name = 'personal_card_created'
        and candidate.personal_card_id is null
      order by candidate.id desc
      limit 1
    );
  end if;
  return v_result;
end;
$$;

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
  v_acquisition_id uuid;
  v_existing_share_slug text;
  v_access jsonb;
  v_result jsonb;
begin
  v_user_id := private.lock_active_user_id_for_auth(p_auth_user_id);
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
  select card_row.acquisition_id
  into v_acquisition_id
  from public.personal_cards as card_row
  where card_row.id = p_personal_card_id
    and card_row.user_id = v_user_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  v_access := private.lock_field_derivative_access(p_auth_user_id, v_acquisition_id);
  if v_access ->> 'status' <> 'active' then
    return v_access;
  end if;

  -- The inner UGC function emits share_created only for the initial
  -- null-to-slug transition. Policy-version resubmissions also return pending,
  -- so capture that transition under the same owner/card lock instead of
  -- guessing from the response status.
  select card_row.share_slug
  into v_existing_share_slug
  from public.personal_cards as card_row
  where card_row.id = p_personal_card_id
    and card_row.user_id = v_user_id
  for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  v_result := api_private.create_personal_card_share_after_location_compliance(
    p_auth_user_id,
    p_public_gate_open,
    p_public_share_creation_open,
    p_personal_card_id,
    p_share_slug
  );
  if v_result ->> 'status' = 'pending'
    and v_existing_share_slug is null
  then
    update analytics.events as event_row
    set personal_card_id = p_personal_card_id
    where event_row.id = (
      select candidate.id
      from analytics.events as candidate
      where candidate.user_id = v_user_id
        and candidate.event_name = 'share_created'
        and candidate.personal_card_id is null
      order by candidate.id desc
      limit 1
    );
  end if;
  return v_result;
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
  v_result jsonb;
begin
  v_user_id := private.lock_active_user_id_for_auth(p_auth_user_id);
  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_user_id::text,
    0
  ));

  v_result := api_private.revoke_personal_card_share_after_location_compliance(
    p_auth_user_id,
    p_personal_card_id
  );
  if v_result ->> 'status' = 'revoked' then
    update analytics.events as event_row
    set personal_card_id = p_personal_card_id
    where event_row.id = (
      select candidate.id
      from analytics.events as candidate
      where candidate.user_id = v_user_id
        and candidate.event_name = 'share_revoked'
        and candidate.personal_card_id is null
      order by candidate.id desc
      limit 1
    );
  end if;
  return v_result;
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
  v_owner_user_id uuid;
  v_acquisition_type public.acquisition_type;
  v_access jsonb;
begin
  if p_admin_auth_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  if not exists (
    select 1
    from private.user_identities as identity_row
    join auth.users as auth_user
      on auth_user.id = identity_row.auth_user_id
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

  if p_action in ('approve', 'reinstate') then
    select card_row.user_id, acquisition_row.acquisition_type
    into v_owner_user_id, v_acquisition_type
    from public.personal_cards as card_row
    join public.acquisitions as acquisition_row
      on acquisition_row.id = card_row.acquisition_id
     and acquisition_row.user_id = card_row.user_id
    where card_row.id = p_personal_card_id;

    if v_owner_user_id is not null and v_acquisition_type = 'field' then
      perform pg_advisory_xact_lock_shared(hashtextextended(
        'danyeodam:policy-current-set',
        0
      ));
      if p_client_action_id is null then
        return jsonb_build_object('status', 'invalid');
      end if;
      -- The historical moderation implementation acquires this key before
      -- the owner key.  Pre-acquire it in that same order because the
      -- location wrapper must inspect the owner before delegating; otherwise
      -- approve/reinstate could deadlock with suspend_owner using the same
      -- logical action.
      perform pg_advisory_xact_lock(hashtextextended(
        'danyeodam:moderation:'
          || p_admin_auth_user_id::text || ':' || p_client_action_id::text,
        0
      ));
      perform pg_advisory_xact_lock(hashtextextended(
        'danyeodam:suspend-owner:' || v_owner_user_id::text,
        0
      ));
      if private.field_acquisition_has_pending_correction(
        v_owner_user_id,
        (
          select card_row.acquisition_id
          from public.personal_cards as card_row
          where card_row.id = p_personal_card_id
        )
      ) then
        return jsonb_build_object('status', 'location_correction_pending');
      end if;
      v_access := private.lock_user_adult_location_access(v_owner_user_id);
      if v_access ->> 'status' <> 'active' then
        return jsonb_build_object(
          'status',
          private.location_access_code_to_rpc_status(v_access ->> 'code')
        );
      end if;
    end if;
  end if;

  return api_private.moderate_personal_card_share_after_location_compliance(
    p_admin_auth_user_id,
    p_personal_card_id,
    p_client_action_id,
    p_action,
    p_reason_code,
    p_note,
    p_public_share_publication_open
  );
end;
$$;

-- -------------------------------------------------------------------------
-- Adult + consent protected acquisition boundary
-- -------------------------------------------------------------------------

create or replace function private.lock_adult_location_access(
  p_auth_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_access_error text;
begin
  perform pg_advisory_xact_lock_shared(hashtextextended(
    'danyeodam:policy-current-set',
    0
  ));

  select identity_row.user_id
  into v_user_id
  from private.user_identities as identity_row
  join auth.users as auth_user on auth_user.id = identity_row.auth_user_id
  where identity_row.auth_user_id = p_auth_user_id
    and identity_row.revoked_at is null
    and auth_user.deleted_at is null
  for share of identity_row;

  if v_user_id is null then
    return jsonb_build_object('status', 'error', 'code', 'UNAUTHORIZED');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_user_id::text,
    0
  ));

  perform attestation_row.user_id
  from private.minimum_age_attestations as attestation_row
  where attestation_row.user_id = v_user_id
    and attestation_row.minimum_age_passed
    and attestation_row.version = '18plus-v1'
  for share of attestation_row;

  if not found then
    return jsonb_build_object(
      'status', 'error',
      'code', 'MINIMUM_AGE_ATTESTATION_REQUIRED'
    );
  end if;

  perform consent_row.user_id
  from private.location_consents as consent_row
  where consent_row.user_id = v_user_id
  for share of consent_row;

  v_access_error := private.location_access_error(v_user_id);
  if v_access_error is not null then
    return jsonb_build_object('status', 'error', 'code', v_access_error);
  end if;

  return jsonb_build_object('status', 'active', 'user_id', v_user_id);
end;
$$;

alter function api_private.acquire_context(uuid, uuid, uuid, boolean)
  rename to acquire_context_after_location_compliance;
alter function api_private.acquire_commit(uuid, uuid, uuid, boolean, timestamptz)
  rename to acquire_commit_after_location_compliance;
alter function api_private.record_acquire_failure(uuid, uuid, text)
  rename to record_acquire_failure_after_location_compliance;

revoke all on function api_private.acquire_context_after_location_compliance(
  uuid, uuid, uuid, boolean
) from public, anon, authenticated, service_role;
revoke all on function api_private.acquire_commit_after_location_compliance(
  uuid, uuid, uuid, boolean, timestamptz
) from public, anon, authenticated, service_role;
revoke all on function api_private.record_acquire_failure_after_location_compliance(
  uuid, uuid, text
) from public, anon, authenticated, service_role;

create or replace function api_private.acquire_context(
  p_auth_user_id uuid,
  p_spot_id uuid,
  p_idempotency_key uuid,
  p_public_gate_open boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_access jsonb;
  v_user_id uuid;
  v_fact private.location_use_facts%rowtype;
  v_existing public.acquisitions%rowtype;
  v_result jsonb;
  v_terminal_event_count integer;
begin
  if p_spot_id is null or p_idempotency_key is null then
    return jsonb_build_object('status', 'error', 'code', 'NOT_FOUND');
  end if;

  v_access := private.lock_adult_location_access(p_auth_user_id);
  if v_access ->> 'status' <> 'active' then
    return v_access;
  end if;
  v_user_id := (v_access ->> 'user_id')::uuid;

  if not exists (
    select 1
    from public.spots as spot_row
    where spot_row.id = p_spot_id
  ) then
    return jsonb_build_object('status', 'error', 'code', 'NOT_FOUND');
  end if;

  -- Every correction/erasure path uses owner -> acquisition -> fact. Follow
  -- that order here as well, including retention-aged replays.
  select acquisition_row.*
  into v_existing
  from public.acquisitions as acquisition_row
  where acquisition_row.user_id = v_user_id
    and acquisition_row.idempotency_key = p_idempotency_key
  for update;

  select fact_row.*
  into v_fact
  from private.location_use_facts as fact_row
  where fact_row.user_id = v_user_id
    and fact_row.idempotency_key = p_idempotency_key
    and fact_row.purpose = 'field_acquisition'
  for update;

  if v_existing.id is not null then
    if v_existing.spot_id <> p_spot_id
      or v_existing.acquisition_type <> 'field'
    then
      return jsonb_build_object(
        'status', 'error',
        'code', 'IDEMPOTENCY_CONFLICT'
      );
    end if;

    if exists (
      select 1
      from private.location_correction_requests as request_row
      where request_row.user_id = v_user_id
        and request_row.status = 'approved_pending_correction'
        and (
          request_row.field_acquisition_id = v_existing.id
          or (
            v_fact.id is not null
            and request_row.location_use_fact_id = v_fact.id
          )
        )
    ) then
      return jsonb_build_object(
        'status', 'error',
        'code', 'LOCATION_CORRECTION_PENDING'
      );
    end if;

    if v_fact.id is not null then
      if v_fact.spot_id <> p_spot_id or v_fact.outcome <> 'passed' then
        raise exception 'field acquisition and location fact terminal state disagree'
          using errcode = '23514';
      end if;
      select count(*)::integer
      into v_terminal_event_count
      from analytics.events as event_row
      where event_row.location_use_fact_id = v_fact.id
        and event_row.event_name = 'acquire_success';
      if v_terminal_event_count <> 1 then
        raise exception 'acquire replay event correlation failed'
          using errcode = '23514';
      end if;
    end if;

    -- A missing fact is the expected six-month retention case. Replaying the
    -- collection item does not create or re-date location-use data.
    return private.acquire_result(v_existing.id, 'replay');
  end if;

  if v_fact.id is null then
    if private.location_attempt_is_tombstoned(v_user_id, p_idempotency_key) then
      return jsonb_build_object(
        'status', 'error',
        'code', 'IDEMPOTENCY_CONFLICT'
      );
    end if;
    insert into private.location_use_facts (
      user_id,
      idempotency_key,
      spot_id,
      purpose
    ) values (
      v_user_id,
      p_idempotency_key,
      p_spot_id,
      'field_acquisition'
    )
    on conflict (user_id, idempotency_key, purpose) do update
    set spot_id = private.location_use_facts.spot_id
    where private.location_use_facts.spot_id = excluded.spot_id
    returning * into v_fact;
  elsif v_fact.spot_id <> p_spot_id then
    return jsonb_build_object(
      'status', 'error',
      'code', 'IDEMPOTENCY_CONFLICT'
    );
  end if;

  if v_fact.id is null then
    return jsonb_build_object(
      'status', 'error',
      'code', 'IDEMPOTENCY_CONFLICT'
    );
  end if;

  if exists (
    select 1
    from private.location_correction_requests as request_row
    where request_row.location_use_fact_id = v_fact.id
      and request_row.user_id = v_user_id
      and request_row.status = 'approved_pending_correction'
  ) then
    return jsonb_build_object(
      'status', 'error',
      'code', 'LOCATION_CORRECTION_PENDING'
    );
  end if;

  if v_fact.outcome = 'failed' then
    return jsonb_build_object(
      'status', 'error',
      'code', v_fact.terminal_failure_code,
      'details', v_fact.terminal_failure_details
    );
  end if;

  v_result := api_private.acquire_context_after_location_compliance(
    p_auth_user_id,
    p_spot_id,
    p_idempotency_key,
    p_public_gate_open
  );

  if v_result ->> 'status' = 'replay' then
    if not exists (
      select 1
      from analytics.events as event_row
      where event_row.location_use_fact_id = v_fact.id
    ) then
      update analytics.events as event_row
      set location_use_fact_id = v_fact.id
      where event_row.id = (
        select candidate.id
        from analytics.events as candidate
        join public.acquisitions as acquisition_row
          on acquisition_row.user_id = v_user_id
         and acquisition_row.idempotency_key = p_idempotency_key
         and acquisition_row.spot_id = p_spot_id
         and acquisition_row.acquisition_type = 'field'
         and acquisition_row.acquired_at = candidate.occurred_at
        where candidate.user_id = v_user_id
          and candidate.event_name = 'acquire_success'
          and candidate.spot_id = p_spot_id
          and candidate.location_use_fact_id is null
        order by candidate.id desc
        limit 1
      );
    end if;

    select count(*)::integer
    into v_terminal_event_count
    from analytics.events as event_row
    where event_row.location_use_fact_id = v_fact.id
      and event_row.event_name = 'acquire_success';
    if v_terminal_event_count <> 1 then
      raise exception 'acquire replay event correlation failed'
        using errcode = '23514';
    end if;

    update private.location_use_facts
    set outcome = 'passed',
        decided_at = clock_timestamp()
    where id = v_fact.id
      and outcome = 'pending';
  end if;

  return v_result;
end;
$$;

create or replace function api_private.acquire_commit(
  p_auth_user_id uuid,
  p_spot_id uuid,
  p_idempotency_key uuid,
  p_public_gate_open boolean,
  p_expected_spot_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_access jsonb;
  v_user_id uuid;
  v_fact private.location_use_facts%rowtype;
  v_existing public.acquisitions%rowtype;
  v_result jsonb;
  v_terminal_event_count integer;
begin
  v_access := private.lock_adult_location_access(p_auth_user_id);
  if v_access ->> 'status' <> 'active' then
    return v_access;
  end if;
  v_user_id := (v_access ->> 'user_id')::uuid;

  select acquisition_row.*
  into v_existing
  from public.acquisitions as acquisition_row
  where acquisition_row.user_id = v_user_id
    and acquisition_row.idempotency_key = p_idempotency_key
  for update;

  select fact_row.*
  into v_fact
  from private.location_use_facts as fact_row
  where fact_row.user_id = v_user_id
    and fact_row.idempotency_key = p_idempotency_key
    and fact_row.purpose = 'field_acquisition'
  for update;

  if v_existing.id is not null then
    if v_existing.spot_id <> p_spot_id
      or v_existing.acquisition_type <> 'field'
    then
      return jsonb_build_object(
        'status', 'error',
        'code', 'IDEMPOTENCY_CONFLICT'
      );
    end if;

    if exists (
      select 1
      from private.location_correction_requests as request_row
      where request_row.user_id = v_user_id
        and request_row.status = 'approved_pending_correction'
        and (
          request_row.field_acquisition_id = v_existing.id
          or (
            v_fact.id is not null
            and request_row.location_use_fact_id = v_fact.id
          )
        )
    ) then
      return jsonb_build_object(
        'status', 'error',
        'code', 'LOCATION_CORRECTION_PENDING'
      );
    end if;

    if v_fact.id is not null then
      if v_fact.spot_id <> p_spot_id or v_fact.outcome <> 'passed' then
        raise exception 'field acquisition and location fact terminal state disagree'
          using errcode = '23514';
      end if;
      select count(*)::integer
      into v_terminal_event_count
      from analytics.events as event_row
      where event_row.location_use_fact_id = v_fact.id
        and event_row.event_name = 'acquire_success';
      if v_terminal_event_count <> 1 then
        raise exception 'acquire replay event correlation failed'
          using errcode = '23514';
      end if;
    end if;
    return private.acquire_result(v_existing.id, 'replay');
  end if;

  if v_fact.id is null then
    if private.location_attempt_is_tombstoned(v_user_id, p_idempotency_key) then
      return jsonb_build_object(
        'status', 'error',
        'code', 'IDEMPOTENCY_CONFLICT'
      );
    end if;
    return jsonb_build_object(
      'status', 'error',
      'code', 'IDEMPOTENCY_CONFLICT'
    );
  end if;
  if v_fact.spot_id <> p_spot_id then
    return jsonb_build_object(
      'status', 'error',
      'code', 'IDEMPOTENCY_CONFLICT'
    );
  end if;

  if exists (
    select 1
    from private.location_correction_requests as request_row
    where request_row.location_use_fact_id = v_fact.id
      and request_row.user_id = v_user_id
      and request_row.status = 'approved_pending_correction'
  ) then
    return jsonb_build_object(
      'status', 'error',
      'code', 'LOCATION_CORRECTION_PENDING'
    );
  end if;

  if v_fact.outcome = 'failed' then
    return jsonb_build_object(
      'status', 'error',
      'code', v_fact.terminal_failure_code,
      'details', v_fact.terminal_failure_details
    );
  end if;

  v_result := api_private.acquire_commit_after_location_compliance(
    p_auth_user_id,
    p_spot_id,
    p_idempotency_key,
    p_public_gate_open,
    p_expected_spot_updated_at
  );

  if v_result ->> 'status' in ('created', 'replay') then
    if not exists (
      select 1
      from analytics.events as event_row
      where event_row.location_use_fact_id = v_fact.id
    ) then
      update analytics.events as event_row
      set location_use_fact_id = v_fact.id
      where event_row.id = (
        select candidate.id
        from analytics.events as candidate
        join public.acquisitions as acquisition_row
          on acquisition_row.user_id = v_user_id
         and acquisition_row.idempotency_key = p_idempotency_key
         and acquisition_row.spot_id = p_spot_id
         and acquisition_row.acquisition_type = 'field'
         and acquisition_row.acquired_at = candidate.occurred_at
        where candidate.user_id = v_user_id
          and candidate.event_name = 'acquire_success'
          and candidate.spot_id = p_spot_id
          and candidate.location_use_fact_id is null
        order by candidate.id desc
        limit 1
      );
    end if;

    select count(*)::integer
    into v_terminal_event_count
    from analytics.events as event_row
    where event_row.location_use_fact_id = v_fact.id
      and event_row.event_name = 'acquire_success';
    if v_terminal_event_count <> 1 then
      raise exception 'acquire success event correlation failed'
        using errcode = '23514';
    end if;

    update private.location_use_facts
    set outcome = 'passed',
        decided_at = clock_timestamp()
    where id = v_fact.id
      and outcome = 'pending';
  end if;

  return v_result;
end;
$$;

create or replace function api_private.record_acquire_failure(
  p_auth_user_id uuid,
  p_spot_id uuid,
  p_idempotency_key uuid,
  p_code text,
  p_details jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_access jsonb;
  v_user_id uuid;
  v_fact private.location_use_facts%rowtype;
  v_existing public.acquisitions%rowtype;
begin
  if p_code is null or p_code not in (
    'OUT_OF_RANGE',
    'LOW_ACCURACY',
    'ALREADY_ACQUIRED_TODAY',
    'SPOT_NOT_OPEN',
    'GATE_CLOSED'
  ) then
    raise exception 'unsupported acquire failure code'
      using errcode = '22023';
  end if;
  if p_details is null
    or jsonb_typeof(p_details) <> 'object'
    or (
      p_code = 'LOW_ACCURACY'
      and p_details <> '{"retry":true}'::jsonb
    )
    or (
      p_code = 'OUT_OF_RANGE'
      and (
        p_details - 'distance_band' <> '{}'::jsonb
        or jsonb_typeof(p_details -> 'distance_band') is distinct from 'string'
        or p_details ->> 'distance_band' not in ('near', 'far')
      )
    )
    or (
      p_code in (
        'ALREADY_ACQUIRED_TODAY',
        'SPOT_NOT_OPEN',
        'GATE_CLOSED'
      )
      and p_details <> '{}'::jsonb
    )
  then
    raise exception 'unsupported acquire failure details'
      using errcode = '22023';
  end if;
  if p_idempotency_key is null then
    return jsonb_build_object(
      'status', 'error',
      'code', 'IDEMPOTENCY_CONFLICT'
    );
  end if;

  v_access := private.lock_adult_location_access(p_auth_user_id);
  if v_access ->> 'status' <> 'active' then
    return v_access;
  end if;
  v_user_id := (v_access ->> 'user_id')::uuid;

  select acquisition_row.*
  into v_existing
  from public.acquisitions as acquisition_row
  where acquisition_row.user_id = v_user_id
    and acquisition_row.idempotency_key = p_idempotency_key
  for update;

  select fact_row.*
  into v_fact
  from private.location_use_facts as fact_row
  where fact_row.user_id = v_user_id
    and fact_row.idempotency_key = p_idempotency_key
    and fact_row.purpose = 'field_acquisition'
  for update;

  if v_existing.id is not null then
    if v_existing.spot_id <> p_spot_id
      or v_existing.acquisition_type <> 'field'
    then
      return jsonb_build_object(
        'status', 'error',
        'code', 'IDEMPOTENCY_CONFLICT'
      );
    end if;
    if exists (
      select 1
      from private.location_correction_requests as request_row
      where request_row.user_id = v_user_id
        and request_row.status = 'approved_pending_correction'
        and (
          request_row.field_acquisition_id = v_existing.id
          or (
            v_fact.id is not null
            and request_row.location_use_fact_id = v_fact.id
          )
        )
    ) then
      return jsonb_build_object(
        'status', 'error',
        'code', 'LOCATION_CORRECTION_PENDING'
      );
    end if;
    if v_fact.id is not null
      and (v_fact.spot_id <> p_spot_id or v_fact.outcome <> 'passed')
    then
      raise exception 'field acquisition and location fact terminal state disagree'
        using errcode = '23514';
    end if;
    return private.acquire_result(v_existing.id, 'replay');
  end if;

  if v_fact.id is null then
    if private.location_attempt_is_tombstoned(v_user_id, p_idempotency_key) then
      return jsonb_build_object(
        'status', 'error',
        'code', 'IDEMPOTENCY_CONFLICT'
      );
    end if;
    return jsonb_build_object(
      'status', 'error',
      'code', 'IDEMPOTENCY_CONFLICT'
    );
  end if;
  if v_fact.spot_id <> p_spot_id then
    return jsonb_build_object(
      'status', 'error',
      'code', 'IDEMPOTENCY_CONFLICT'
    );
  end if;

  if exists (
    select 1
    from private.location_correction_requests as request_row
    where request_row.location_use_fact_id = v_fact.id
      and request_row.user_id = v_user_id
      and request_row.status = 'approved_pending_correction'
  ) then
    return jsonb_build_object(
      'status', 'error',
      'code', 'LOCATION_CORRECTION_PENDING'
    );
  end if;

  if v_fact.outcome = 'failed' then
    return jsonb_build_object(
      'status', 'failed',
      'code', v_fact.terminal_failure_code,
      'details', v_fact.terminal_failure_details
    );
  end if;

  if v_fact.outcome = 'passed' then
    raise exception 'passed location fact has no field acquisition'
      using errcode = '23514';
  end if;

  -- The terminal state wins before any public failure can be returned. Event
  -- correlation is in this same transaction, so either both commit or neither.
  update private.location_use_facts
  set outcome = 'failed',
      decided_at = clock_timestamp(),
      terminal_failure_code = p_code,
      terminal_failure_details = p_details
  where id = v_fact.id
    and outcome = 'pending';
  if not found then
    raise exception 'location fact terminal transition lost its row lock'
      using errcode = '40001';
  end if;

  insert into analytics.events (
    user_id,
    event_name,
    source,
    occurred_at,
    spot_id,
    properties,
    location_use_fact_id
  ) values (
    v_user_id,
    'acquire_fail',
    'server',
    clock_timestamp(),
    p_spot_id,
    jsonb_build_object('code', p_code),
    v_fact.id
  );

  return jsonb_build_object(
    'status', 'failed',
    'code', p_code,
    'details', p_details
  );
end;
$$;

-- -------------------------------------------------------------------------
-- User disclosure and correction rights
-- -------------------------------------------------------------------------

create or replace function api_private.list_location_use_facts(
  p_auth_user_id uuid,
  p_limit integer,
  p_before_collected_at timestamptz,
  p_before_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_items jsonb;
  v_count integer;
begin
  -- Listing writes the bounded disclosure audit below, so serialize it with a
  -- recovery claim exactly like the other identity-bound mutations.
  v_user_id := private.lock_active_user_id_for_auth(p_auth_user_id);
  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_user_id::text,
    0
  ));
  if p_limit is null or p_limit not between 1 and 100
    or ((p_before_collected_at is null) <> (p_before_id is null))
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', page_row.id,
        'idempotency_key', page_row.idempotency_key,
        'spot_id', page_row.spot_id,
        'purpose', page_row.purpose,
        'collected_at', page_row.collected_at,
        'decided_at', page_row.decided_at,
        'outcome', page_row.outcome,
        'failure', case
          when page_row.outcome = 'failed' then jsonb_build_object(
            'code', page_row.terminal_failure_code,
            'details', page_row.terminal_failure_details
          )
          else 'null'::jsonb
        end
      )
      order by page_row.collected_at desc, page_row.id desc
    ),
    '[]'::jsonb
  ), count(*)::integer
  into v_items, v_count
  from (
    select fact_row.*
    from private.location_use_facts as fact_row
    where fact_row.user_id = v_user_id
      and (
        p_before_collected_at is null
        or (fact_row.collected_at, fact_row.id)
          < (p_before_collected_at, p_before_id)
      )
    order by fact_row.collected_at desc, fact_row.id desc
    limit p_limit
  ) as page_row;

  -- If withdrawal finish won the owner lock, its facts are already gone and
  -- no new user-linked zero-row audit is created. If this read won, finish
  -- waits and deletes this audit in the same full-withdrawal cleanup.
  if v_count > 0 then
    insert into private.location_disclosure_accesses (
      user_id,
      disclosed_count
    ) values (
      v_user_id,
      v_count
    );
  end if;

  return jsonb_build_object('status', 'ready', 'items', v_items);
end;
$$;

create or replace function api_private.list_location_correction_subjects(
  p_auth_user_id uuid,
  p_limit integer,
  p_before_acquired_on_kst date,
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
  v_count integer;
begin
  v_user_id := private.lock_active_user_id_for_auth(p_auth_user_id);
  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  if p_limit is null or p_limit not between 1 and 100
    or ((p_before_acquired_on_kst is null) <> (p_before_id is null))
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_user_id::text,
    0
  ));

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'field_acquisition_id', page_row.id,
      'spot_id', page_row.spot_id,
      'acquired_on_kst', page_row.acquired_on_kst
    ) order by page_row.acquired_on_kst desc, page_row.id desc
  ), '[]'::jsonb), count(*)::integer
  into v_items, v_count
  from (
    select acquisition_row.*
    from public.acquisitions as acquisition_row
    where acquisition_row.user_id = v_user_id
      and acquisition_row.acquisition_type = 'field'
      and (
        p_before_acquired_on_kst is null
        or (acquisition_row.acquired_on_kst, acquisition_row.id)
          < (p_before_acquired_on_kst, p_before_id)
      )
    order by acquisition_row.acquired_on_kst desc, acquisition_row.id desc
    limit p_limit
  ) as page_row;

  if v_count > 0 then
    insert into private.location_disclosure_accesses (
      user_id,
      disclosed_count
    ) values (
      v_user_id,
      v_count
    );
  end if;

  return jsonb_build_object('status', 'ready', 'items', v_items);
end;
$$;

create or replace function api_private.create_location_correction_request(
  p_auth_user_id uuid,
  p_location_use_fact_id bigint,
  p_field_acquisition_id uuid,
  p_client_request_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_existing private.location_correction_requests%rowtype;
  v_fact private.location_use_facts%rowtype;
  v_fact_id bigint;
  v_acquisition_id uuid;
  v_id uuid;
  v_request_fingerprint bytea;
begin
  v_user_id := private.lock_active_user_id_for_auth(p_auth_user_id);
  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  if num_nonnulls(p_location_use_fact_id, p_field_acquisition_id) <> 1
    or p_client_request_id is null
    or p_reason not in ('not_my_visit', 'wrong_spot', 'incorrect_outcome', 'other')
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  v_request_fingerprint := extensions.digest(
    'danyeodam:location-correction:v1:' ||
      case
        when p_location_use_fact_id is not null
          then 'fact:' || p_location_use_fact_id::text
        else 'field-acquisition:' || p_field_acquisition_id::text
      end ||
      ':reason:' || p_reason,
    'sha256'
  );

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_user_id::text,
    0
  ));
  if exists (
    select 1
    from private.data_erasure_jobs as job_row
    where job_row.user_id = v_user_id
      and job_row.scope = 'location_withdrawal'
      and job_row.state <> 'completed'
  ) then
    return jsonb_build_object('status', 'location_withdrawal_pending');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:location-correction:' || v_user_id::text || ':' ||
      p_client_request_id::text,
    0
  ));

  select request_row.*
  into v_existing
  from private.location_correction_requests as request_row
  where request_row.user_id = v_user_id
    and request_row.client_request_id = p_client_request_id;

  if found then
    if v_existing.request_fingerprint = v_request_fingerprint then
      return jsonb_build_object(
        'status', 'duplicate',
        'correction_request_id', v_existing.id
      );
    end if;
    return jsonb_build_object('status', 'idempotency_conflict');
  end if;

  if p_location_use_fact_id is not null then
    -- Discover the matching field acquisition without a lock, then take the
    -- canonical acquisition->fact lock order used by the acquisition input.
    select fact_row.*
    into v_fact
    from private.location_use_facts as fact_row
    where fact_row.id = p_location_use_fact_id
      and fact_row.user_id = v_user_id;
    if not found then
      return jsonb_build_object('status', 'not_found');
    end if;

    select acquisition_row.id
    into v_acquisition_id
    from public.acquisitions as acquisition_row
    where acquisition_row.user_id = v_fact.user_id
      and acquisition_row.idempotency_key = v_fact.idempotency_key
      and acquisition_row.spot_id = v_fact.spot_id
      and acquisition_row.acquisition_type = 'field'
    for update;

    select fact_row.id
    into v_fact_id
    from private.location_use_facts as fact_row
    where fact_row.id = p_location_use_fact_id
      and fact_row.user_id = v_user_id
    for update;
    if not found then
      return jsonb_build_object('status', 'not_found');
    end if;
  else
    -- A surviving collection item remains individually correctable after its
    -- six-month location fact is purged. Only owner-bound field acquisitions
    -- are valid subjects; retro and gift records remain outside this workflow.
    select acquisition_row.id
    into v_acquisition_id
    from public.acquisitions as acquisition_row
    where acquisition_row.id = p_field_acquisition_id
      and acquisition_row.user_id = v_user_id
      and acquisition_row.acquisition_type = 'field'
    for update;
    if not found then
      return jsonb_build_object('status', 'not_found');
    end if;

    select fact_row.id
    into v_fact_id
    from private.location_use_facts as fact_row
    join public.acquisitions as acquisition_row
      on acquisition_row.id = v_acquisition_id
     and acquisition_row.user_id = fact_row.user_id
     and acquisition_row.idempotency_key = fact_row.idempotency_key
     and acquisition_row.spot_id = fact_row.spot_id
     and acquisition_row.acquisition_type = 'field'
    where fact_row.user_id = v_user_id
      and fact_row.purpose = 'field_acquisition'
    for update of fact_row;
  end if;

  select request_row.*
  into v_existing
  from private.location_correction_requests as request_row
  where request_row.user_id = v_user_id
    and (
      (v_fact_id is not null and request_row.location_use_fact_id = v_fact_id)
      or (
        v_acquisition_id is not null
        and request_row.field_acquisition_id = v_acquisition_id
      )
    )
    and request_row.status in ('open', 'approved_pending_correction')
  order by request_row.requested_at, request_row.id
  limit 1;
  if found then
    return jsonb_build_object(
      'status', 'duplicate',
      'correction_request_id', v_existing.id
    );
  end if;

  insert into private.location_correction_requests (
    user_id,
    location_use_fact_id,
    field_acquisition_id,
    client_request_id,
    request_fingerprint,
    reason
  ) values (
    v_user_id,
    p_location_use_fact_id,
    p_field_acquisition_id,
    p_client_request_id,
    v_request_fingerprint,
    p_reason::private.location_correction_reason
  )
  returning id into v_id;

  return jsonb_build_object(
    'status', 'created',
    'correction_request_id', v_id
  );
end;
$$;

create or replace function api_private.list_own_location_corrections(
  p_auth_user_id uuid,
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_items jsonb;
begin
  v_user_id := private.active_user_id_for_auth(p_auth_user_id);
  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    return jsonb_build_object('status', 'invalid');
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', page_row.id,
      'location_use_fact_id', page_row.location_use_fact_id,
      'field_acquisition_id', page_row.field_acquisition_id,
      'reason', page_row.reason,
      'status', page_row.status,
      'requested_at', page_row.requested_at,
      'resolved_at', page_row.resolved_at
    ) order by page_row.requested_at desc, page_row.id desc
  ), '[]'::jsonb)
  into v_items
  from (
    select request_row.*
    from private.location_correction_requests as request_row
    where request_row.user_id = v_user_id
    order by request_row.requested_at desc, request_row.id desc
    limit p_limit
  ) as page_row;

  return jsonb_build_object('status', 'ready', 'items', v_items);
end;
$$;

create or replace function api_private.list_location_corrections_admin(
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
  perform identity_row.user_id
  from private.user_identities as identity_row
  join private.admin_members as admin_row
    on admin_row.auth_user_id = identity_row.auth_user_id
   and admin_row.revoked_at is null
  join auth.users as auth_user
    on auth_user.id = identity_row.auth_user_id
   and auth_user.deleted_at is null
  where identity_row.auth_user_id = p_admin_auth_user_id
    and identity_row.revoked_at is null
  for share of identity_row, admin_row;
  if not found then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if p_status not in (
    'open',
    'approved_pending_correction',
    'corrected',
    'rejected'
  )
    or p_limit is null
    or p_limit not between 1 and 100
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', page_row.id,
      'user_id', page_row.user_id,
      'location_use_fact_id', page_row.location_use_fact_id,
      'field_acquisition_id', page_row.field_acquisition_id,
      'reason', page_row.reason,
      'status', page_row.status,
      'requested_at', page_row.requested_at,
      'resolved_at', page_row.resolved_at
    ) order by page_row.requested_at, page_row.id
  ), '[]'::jsonb)
  into v_items
  from (
    select request_row.*
    from private.location_correction_requests as request_row
    where request_row.status::text = p_status
    order by request_row.requested_at, request_row.id
    limit p_limit
  ) as page_row;

  return jsonb_build_object('status', 'ready', 'items', v_items);
end;
$$;

create or replace function api_private.resolve_location_correction_admin(
  p_admin_auth_user_id uuid,
  p_correction_request_id uuid,
  p_resolution text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request private.location_correction_requests%rowtype;
  v_fact private.location_use_facts%rowtype;
  v_acquisition public.acquisitions%rowtype;
  v_job_id uuid;
  v_user_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  perform identity_row.user_id
  from private.user_identities as identity_row
  join private.admin_members as admin_row
    on admin_row.auth_user_id = identity_row.auth_user_id
   and admin_row.revoked_at is null
  join auth.users as auth_user
    on auth_user.id = identity_row.auth_user_id
   and auth_user.deleted_at is null
  where identity_row.auth_user_id = p_admin_auth_user_id
    and identity_row.revoked_at is null
  for share of identity_row, admin_row;
  if not found then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if p_correction_request_id is null
    or p_resolution not in ('accepted', 'rejected')
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  select request_row.user_id
  into v_user_id
  from private.location_correction_requests as request_row
  where request_row.id = p_correction_request_id;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_user_id::text,
    0
  ));

  select request_row.*
  into v_request
  from private.location_correction_requests as request_row
  where request_row.id = p_correction_request_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_request.status = 'rejected' and p_resolution = 'rejected' then
    return jsonb_build_object('status', 'duplicate');
  end if;
  if v_request.status in ('approved_pending_correction', 'corrected')
    and p_resolution = 'accepted'
  then
    select job_row.id
    into v_job_id
    from private.data_erasure_jobs as job_row
    where job_row.correction_request_id = v_request.id
    limit 1;
    return jsonb_build_object(
      'status', case
        when v_request.status = 'corrected' then 'corrected'
        else 'correction_pending'
      end,
      'erasure_job_id', v_job_id
    );
  end if;
  if v_request.status <> 'open' then
    return jsonb_build_object('status', 'conflict');
  end if;

  if p_resolution = 'rejected' then
    update private.location_correction_requests
    set status = 'rejected',
        resolved_at = v_now,
        resolved_by_auth_user_id = p_admin_auth_user_id
    where id = p_correction_request_id;
    return jsonb_build_object('status', 'rejected');
  end if;

  if exists (
    select 1
    from private.data_erasure_jobs as job_row
    where job_row.user_id = v_request.user_id
      and job_row.scope = 'location_withdrawal'
      and job_row.state <> 'completed'
  ) then
    return jsonb_build_object('status', 'location_withdrawal_pending');
  end if;

  if v_request.location_use_fact_id is not null then
    -- Discover first, then take acquisition->fact row locks under the owner
    -- advisory. Failed facts simply have no acquisition to lock.
    select fact_row.*
    into v_fact
    from private.location_use_facts as fact_row
    where fact_row.id = v_request.location_use_fact_id
      and fact_row.user_id = v_request.user_id;

    if not found then
      return jsonb_build_object('status', 'conflict');
    end if;

    select acquisition_row.*
    into v_acquisition
    from public.acquisitions as acquisition_row
    where acquisition_row.user_id = v_fact.user_id
      and acquisition_row.idempotency_key = v_fact.idempotency_key
      and acquisition_row.spot_id = v_fact.spot_id
      and acquisition_row.acquisition_type = 'field'
    for update;

    select fact_row.*
    into v_fact
    from private.location_use_facts as fact_row
    where fact_row.id = v_request.location_use_fact_id
      and fact_row.user_id = v_request.user_id
    for update;

    if not found or v_fact.outcome = 'pending' then
      return jsonb_build_object('status', 'conflict');
    end if;
  else
    select acquisition_row.*
    into v_acquisition
    from public.acquisitions as acquisition_row
    where acquisition_row.id = v_request.field_acquisition_id
      and acquisition_row.user_id = v_request.user_id
      and acquisition_row.acquisition_type = 'field'
    for update;

    if not found then
      return jsonb_build_object('status', 'conflict');
    end if;

    -- Before the six-month purge the same acquisition may still have a live
    -- fact. Lock it too so approval blocks commit/failure replay and erases
    -- the exact terminal event; after purge this SELECT simply finds nothing.
    select fact_row.*
    into v_fact
    from private.location_use_facts as fact_row
    where fact_row.user_id = v_acquisition.user_id
      and fact_row.idempotency_key = v_acquisition.idempotency_key
      and fact_row.spot_id = v_acquisition.spot_id
      and fact_row.purpose = 'field_acquisition'
    for update;

    if v_fact.id is not null and v_fact.outcome = 'pending' then
      return jsonb_build_object('status', 'conflict');
    end if;
  end if;

  insert into private.location_attempt_tombstones (
    owner_fingerprint,
    attempt_key_fingerprint,
    expires_at
  ) values (
    private.location_attempt_owner_fingerprint(v_request.user_id),
    private.location_attempt_key_fingerprint(
      coalesce(v_acquisition.idempotency_key, v_fact.idempotency_key)
    ),
    v_now + interval '6 months'
  )
  on conflict (owner_fingerprint, attempt_key_fingerprint) do update
  set expires_at = greatest(
    private.location_attempt_tombstones.expires_at,
    excluded.expires_at
  );

  insert into private.data_erasure_jobs (
    user_id,
    scope,
    correction_request_id,
    state,
    requested_at,
    next_attempt_at
  ) values (
    v_request.user_id,
    'location_correction',
    v_request.id,
    'pending',
    v_now,
    v_now
  )
  returning id into v_job_id;

  if v_acquisition.id is not null then
    insert into private.data_erasure_manifest (
      job_id,
      bucket,
      object_path,
      final_delete_after
    )
    select distinct on (path_row.bucket, path_row.object_path)
      v_job_id,
      path_row.bucket,
      path_row.object_path,
      path_row.final_delete_after
    from (
      select
        'personal-cards'::text as bucket,
        card_row.photo_path as object_path,
        v_now + interval '10 minutes' as final_delete_after
      from public.personal_cards as card_row
      where card_row.user_id = v_request.user_id
        and card_row.acquisition_id = v_acquisition.id

      union all

      select
        'personal-card-temp',
        upload_row.temp_path,
        greatest(
          upload_row.signed_url_expires_at + interval '10 minutes',
          v_now + interval '2 hours 10 minutes'
        )
      from private.personal_card_temp_uploads as upload_row
      where upload_row.user_id = v_request.user_id
        and upload_row.processing_acquisition_id = v_acquisition.id
        and upload_row.cleanup_completed_at is null

      union all

      select
        'personal-cards',
        upload_row.processing_permanent_path,
        v_now + interval '10 minutes'
      from private.personal_card_temp_uploads as upload_row
      where upload_row.user_id = v_request.user_id
        and upload_row.processing_acquisition_id = v_acquisition.id
        and upload_row.processing_permanent_path is not null

      union all

      select
        'personal-cards',
        upload_row.permanent_path,
        v_now + interval '10 minutes'
      from private.personal_card_temp_uploads as upload_row
      where upload_row.user_id = v_request.user_id
        and upload_row.processing_acquisition_id = v_acquisition.id
        and upload_row.permanent_path is not null

      union all

      select
        ledger_row.bucket,
        ledger_row.object_path,
        greatest(
          ledger_row.final_delete_not_before,
          coalesce(ledger_row.final_delete_after, v_now + interval '10 minutes'),
          v_now + interval '10 minutes'
        )
      from private.personal_card_field_object_ledger as ledger_row
      where ledger_row.user_id = v_request.user_id
        and ledger_row.field_acquisition_id = v_acquisition.id
    ) as path_row
    where path_row.object_path is not null
    order by path_row.bucket, path_row.object_path, path_row.final_delete_after desc
    on conflict (job_id, bucket, object_path) do nothing;

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
        share_reviewed_by_redacted_at = null
    where user_id = v_request.user_id
      and acquisition_id = v_acquisition.id;
  end if;

  update private.location_correction_requests
  set status = 'approved_pending_correction',
      resolved_by_auth_user_id = p_admin_auth_user_id
  where id = p_correction_request_id;

  return jsonb_build_object(
    'status', 'correction_pending',
    'erasure_job_id', v_job_id
  );
end;
$$;

-- -------------------------------------------------------------------------
-- Withdrawal, generic erasure manifest, and retention maintenance
-- -------------------------------------------------------------------------

create or replace function api_private.request_location_withdrawal(
  p_auth_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_job_id uuid;
  v_has_data boolean;
  v_now timestamptz := clock_timestamp();
begin
  v_user_id := private.lock_active_user_id_for_auth(p_auth_user_id);
  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_user_id::text,
    0
  ));

  select job_row.id
  into v_job_id
  from private.data_erasure_jobs as job_row
  where job_row.user_id = v_user_id
    and job_row.scope = 'location_withdrawal'
    and job_row.state <> 'completed'
  limit 1;

  if v_job_id is not null then
    return jsonb_build_object(
      'status', 'location_withdrawal_pending',
      'erasure_job_id', v_job_id
    );
  end if;

  perform 1
  from private.location_consents as consent_row
  where consent_row.user_id = v_user_id
  for update;

  if not found then
    select
      exists (
        select 1 from private.location_use_facts where user_id = v_user_id
      )
      or exists (
        select 1 from private.location_disclosure_accesses where user_id = v_user_id
      )
      or exists (
        select 1 from private.location_correction_requests where user_id = v_user_id
      )
      or exists (
        select 1
        from public.acquisitions
        where user_id = v_user_id and acquisition_type = 'field'
      )
    into v_has_data;

    if not v_has_data then
      return jsonb_build_object('status', 'withdrawn');
    end if;
  else
    update private.location_consents
    set state = 'withdrawal_pending',
        updated_at = v_now,
        withdrawal_requested_at = v_now
    where user_id = v_user_id;
  end if;

  insert into private.location_attempt_tombstones (
    owner_fingerprint,
    attempt_key_fingerprint,
    expires_at
  )
  select distinct
    private.location_attempt_owner_fingerprint(v_user_id),
    private.location_attempt_key_fingerprint(attempt_row.idempotency_key),
    v_now + interval '6 months'
  from (
    select acquisition_row.idempotency_key
    from public.acquisitions as acquisition_row
    where acquisition_row.user_id = v_user_id
      and acquisition_row.acquisition_type = 'field'
    union
    select fact_row.idempotency_key
    from private.location_use_facts as fact_row
    where fact_row.user_id = v_user_id
      and fact_row.purpose = 'field_acquisition'
  ) as attempt_row
  on conflict (owner_fingerprint, attempt_key_fingerprint) do update
  set expires_at = greatest(
    private.location_attempt_tombstones.expires_at,
    excluded.expires_at
  );

  insert into private.data_erasure_jobs (
    user_id,
    scope,
    state,
    requested_at,
    next_attempt_at
  ) values (
    v_user_id,
    'location_withdrawal',
    'pending',
    v_now,
    v_now
  )
  returning id into v_job_id;

  -- Freeze every relevant Storage path before changing or deleting the rows
  -- that currently own those paths. This worker is deliberately scoped to
  -- location withdrawal. Account deletion requires its own FK, receipt, and
  -- UGC-redaction design before it can reuse the manifest shape.
  insert into private.data_erasure_manifest (
    job_id,
    bucket,
    object_path,
    final_delete_after
  )
  select distinct on (path_row.bucket, path_row.object_path)
    v_job_id,
    path_row.bucket,
    path_row.object_path,
    path_row.final_delete_after
  from (
    select
      'personal-cards'::text as bucket,
      card_row.photo_path as object_path,
      v_now + interval '10 minutes' as final_delete_after
    from public.personal_cards as card_row
    join public.acquisitions as acquisition_row
      on acquisition_row.id = card_row.acquisition_id
     and acquisition_row.user_id = card_row.user_id
    where card_row.user_id = v_user_id
      and acquisition_row.acquisition_type = 'field'

    union all

    select
      'personal-card-temp',
      upload_row.temp_path,
      greatest(
        upload_row.signed_url_expires_at + interval '10 minutes',
        v_now + interval '2 hours 10 minutes'
      )
    from private.personal_card_temp_uploads as upload_row
    join public.acquisitions as acquisition_row
      on acquisition_row.id = upload_row.processing_acquisition_id
     and acquisition_row.user_id = upload_row.user_id
    where upload_row.user_id = v_user_id
      and acquisition_row.acquisition_type = 'field'
      and upload_row.cleanup_completed_at is null

    union all

    select
      'personal-cards',
      upload_row.processing_permanent_path,
      v_now + interval '10 minutes'
    from private.personal_card_temp_uploads as upload_row
    join public.acquisitions as acquisition_row
      on acquisition_row.id = upload_row.processing_acquisition_id
     and acquisition_row.user_id = upload_row.user_id
    where upload_row.user_id = v_user_id
      and acquisition_row.acquisition_type = 'field'
      and upload_row.processing_permanent_path is not null

    union all

    select
      'personal-cards',
      upload_row.permanent_path,
      v_now + interval '10 minutes'
    from private.personal_card_temp_uploads as upload_row
    join public.acquisitions as acquisition_row
      on acquisition_row.id = upload_row.processing_acquisition_id
     and acquisition_row.user_id = upload_row.user_id
    where upload_row.user_id = v_user_id
      and acquisition_row.acquisition_type = 'field'
      and upload_row.permanent_path is not null

    union all

    select
      ledger_row.bucket,
      ledger_row.object_path,
      greatest(
        ledger_row.final_delete_not_before,
        coalesce(ledger_row.final_delete_after, v_now + interval '10 minutes'),
        v_now + interval '10 minutes'
      )
    from private.personal_card_field_object_ledger as ledger_row
    where ledger_row.user_id = v_user_id
  ) as path_row
  where path_row.object_path is not null
  order by path_row.bucket, path_row.object_path, path_row.final_delete_after desc
  on conflict (job_id, bucket, object_path) do nothing;

  -- A full withdrawal supersedes any targeted correction. Copy every pending
  -- path first, then remove the narrower jobs while the owner lock prevents a
  -- promotion/share approval from racing the snapshot.
  insert into private.data_erasure_manifest (
    job_id,
    bucket,
    object_path,
    final_delete_after
  )
  select
    v_job_id,
    item_row.bucket,
    item_row.object_path,
    item_row.final_delete_after
  from private.data_erasure_jobs as correction_job
  join private.data_erasure_manifest as item_row
    on item_row.job_id = correction_job.id
  where correction_job.user_id = v_user_id
    and correction_job.scope = 'location_correction'
    and correction_job.state <> 'completed'
    and item_row.deleted_at is null
  on conflict (job_id, bucket, object_path) do update
  set final_delete_after = greatest(
    private.data_erasure_manifest.final_delete_after,
    excluded.final_delete_after
  );

  delete from private.data_erasure_jobs as correction_job
  where correction_job.user_id = v_user_id
    and correction_job.scope = 'location_correction';

  -- Secret-link material becomes unreachable in the same transaction as the
  -- withdrawal state, before the asynchronous object deletion begins.
  update public.personal_cards as card_row
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
      share_reviewed_by_redacted_at = null
  from public.acquisitions as acquisition_row
  where card_row.acquisition_id = acquisition_row.id
    and card_row.user_id = v_user_id
    and acquisition_row.acquisition_type = 'field'
    and card_row.share_state in ('pending', 'active');

  return jsonb_build_object(
    'status', 'location_withdrawal_pending',
    'erasure_job_id', v_job_id
  );
end;
$$;

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

  -- Candidate discovery is only a hint. The owner advisory lock is acquired
  -- before the authoritative ledger row lock so promotion completion,
  -- correction, withdrawal, and cleanup share one serialization boundary.
  for v_candidate in
    select ledger_row.id, ledger_row.user_id
    from private.personal_card_field_object_ledger as ledger_row
    where ledger_row.next_attempt_at <= v_now
      and (
        ledger_row.lease_token is null
        or ledger_row.lease_expires_at <= v_now
      )
    order by ledger_row.user_id, ledger_row.id
    limit p_limit * 4
  loop
    exit when jsonb_array_length(v_items) >= p_limit;

    perform pg_advisory_xact_lock(hashtextextended(
      'danyeodam:suspend-owner:' || v_candidate.user_id::text,
      0
    ));

    select ledger_row.*
    into v_ledger
    from private.personal_card_field_object_ledger as ledger_row
    where ledger_row.id = v_candidate.id
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

    -- A successfully committed exact card is authoritative and needs no
    -- Storage deletion. This is also a safe self-heal for a response lost
    -- after the completion transaction committed.
    if v_ledger.state = 'active'
      and v_ledger.bucket = 'personal-cards'
      and exists (
      select 1
      from public.personal_cards as card_row
      where card_row.user_id = v_ledger.user_id
        and card_row.acquisition_id = v_ledger.field_acquisition_id
        and card_row.photo_path = v_ledger.object_path
    ) then
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

    -- A location erasure manifest owns both deletion passes once it snapshots
    -- this path. The standalone reconciler must not remove that ledger row
    -- before finish_data_erasure_job reaches its database phase.
    if exists (
      select 1
      from private.data_erasure_manifest as item_row
      join private.data_erasure_jobs as job_row on job_row.id = item_row.job_id
      where job_row.state <> 'completed'
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

create or replace function api_private.record_personal_card_field_object_cleanup_result(
  p_worker_token uuid,
  p_ledger_id bigint,
  p_deleted boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_ledger private.personal_card_field_object_ledger%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_worker_token is null or p_ledger_id is null or p_deleted is null then
    return jsonb_build_object('status', 'forbidden');
  end if;

  select ledger_row.user_id
  into v_user_id
  from private.personal_card_field_object_ledger as ledger_row
  where ledger_row.id = p_ledger_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_user_id::text,
    0
  ));

  select ledger_row.*
  into v_ledger
  from private.personal_card_field_object_ledger as ledger_row
  where ledger_row.id = p_ledger_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_ledger.lease_token is distinct from p_worker_token
    or v_ledger.lease_expires_at <= v_now
  then
    return jsonb_build_object('status', 'forbidden');
  end if;

  if not p_deleted then
    update private.personal_card_field_object_ledger
    set next_attempt_at = v_now + interval '5 minutes',
        lease_token = null,
        lease_expires_at = null
    where id = v_ledger.id;
    return jsonb_build_object('status', 'recorded');
  end if;

  if v_ledger.first_deleted_at is null then
    update private.personal_card_field_object_ledger
    set first_deleted_at = v_now,
        final_delete_after = greatest(
          v_ledger.final_delete_after,
          v_ledger.final_delete_not_before,
          v_now + interval '10 minutes'
        ),
        next_attempt_at = greatest(
          v_ledger.final_delete_after,
          v_ledger.final_delete_not_before,
          v_now + interval '10 minutes'
        ),
        lease_token = null,
        lease_expires_at = null
    where id = v_ledger.id;
    return jsonb_build_object('status', 'recorded');
  end if;

  if greatest(
    v_ledger.final_delete_after,
    v_ledger.final_delete_not_before
  ) > v_now then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if v_ledger.bucket = 'personal-cards' and exists (
    select 1
    from public.personal_cards as card_row
    where card_row.user_id = v_ledger.user_id
      and card_row.acquisition_id = v_ledger.field_acquisition_id
      and card_row.photo_path = v_ledger.object_path
  ) then
    update private.personal_card_field_object_ledger
    set lease_token = null,
        lease_expires_at = null,
        next_attempt_at = v_now + interval '5 minutes'
    where id = v_ledger.id;
    return jsonb_build_object('status', 'referenced');
  end if;

  delete from private.personal_card_field_object_ledger
  where id = v_ledger.id;
  return jsonb_build_object('status', 'completed');
end;
$$;

create or replace function api_private.claim_data_erasure_jobs(
  p_worker_token uuid,
  p_limit integer,
  p_item_limit integer default 4
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_jobs jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if p_worker_token is null
    or p_limit is null
    or p_limit not between 1 and 2
    or p_item_limit is null
    or p_item_limit not between 1 and 4
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  with claimed as (
    select job_row.id
    from private.data_erasure_jobs as job_row
    where job_row.state <> 'completed'
      and job_row.next_attempt_at <= v_now
      and (
        job_row.lease_token is null
        or job_row.lease_expires_at <= v_now
      )
    order by job_row.requested_at, job_row.id
    for update skip locked
    limit p_limit
  ), updated as (
    update private.data_erasure_jobs as job_row
    set state = case
          when exists (
            select 1
            from private.data_erasure_manifest as item_row
            where item_row.job_id = job_row.id
              and item_row.deleted_at is null
          ) then 'storage_pending'::private.data_erasure_state
          else 'database_pending'::private.data_erasure_state
        end,
        attempt_count = job_row.attempt_count + 1,
        lease_token = p_worker_token,
        lease_expires_at = v_now + interval '5 minutes'
    from claimed
    where job_row.id = claimed.id
    returning job_row.*
  ), eligible_items as (
    select
      item_row.*,
      job_row.requested_at as job_requested_at,
      row_number() over (
        partition by item_row.job_id
        order by item_row.id
      ) as offer_round
    from updated as job_row
    join private.data_erasure_manifest as item_row
      on item_row.job_id = job_row.id
    where item_row.deleted_at is null
      and (
        item_row.first_deleted_at is null
        or item_row.final_delete_after <= v_now
      )
  ), offered_items as (
    select eligible.*
    from eligible_items as eligible
    order by
      eligible.offer_round,
      eligible.job_requested_at,
      eligible.job_id,
      eligible.id
    limit p_item_limit
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', job_row.id,
      'scope', job_row.scope,
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', item_row.id,
          'bucket', item_row.bucket,
          'object_path', item_row.object_path,
          'phase', case
            when item_row.first_deleted_at is null then 'first'
            else 'final'
          end
        ) order by item_row.id)
        from offered_items as item_row
        where item_row.job_id = job_row.id
      ), '[]'::jsonb)
    ) order by job_row.requested_at, job_row.id
  ), '[]'::jsonb)
  into v_jobs
  from updated as job_row;

  return jsonb_build_object('status', 'ready', 'jobs', v_jobs);
end;
$$;

create or replace function api_private.record_data_erasure_item_result(
  p_worker_token uuid,
  p_job_id uuid,
  p_item_id bigint,
  p_deleted boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  if p_worker_token is null
    or p_job_id is null
    or p_item_id is null
    or p_deleted is null
    or not exists (
      select 1
      from private.data_erasure_jobs as job_row
      where job_row.id = p_job_id
        and job_row.lease_token = p_worker_token
        and job_row.lease_expires_at > v_now
    )
  then
    return jsonb_build_object('status', 'forbidden');
  end if;

  update private.data_erasure_manifest as item_row
  set attempt_count = item_row.attempt_count + 1,
      last_attempt_at = v_now,
      final_delete_after = case
        when p_deleted and item_row.first_deleted_at is null
          then greatest(item_row.final_delete_after, v_now + interval '10 minutes')
        else item_row.final_delete_after
      end,
      first_deleted_at = case
        when p_deleted and item_row.first_deleted_at is null then v_now
        else item_row.first_deleted_at
      end,
      deleted_at = case
        when p_deleted
          and item_row.first_deleted_at is not null
          and item_row.final_delete_after <= v_now
        then v_now
        else item_row.deleted_at
      end
  where item_row.id = p_item_id
    and item_row.job_id = p_job_id
    and item_row.deleted_at is null;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  return jsonb_build_object('status', 'recorded');
end;
$$;

create or replace function api_private.finish_data_erasure_job(
  p_worker_token uuid,
  p_job_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job private.data_erasure_jobs%rowtype;
  v_user_id uuid;
  v_correction private.location_correction_requests%rowtype;
  v_fact private.location_use_facts%rowtype;
  v_acquisition public.acquisitions%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  select job_row.user_id
  into v_user_id
  from private.data_erasure_jobs as job_row
  where job_row.id = p_job_id;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_user_id::text,
    0
  ));

  select job_row.*
  into v_job
  from private.data_erasure_jobs as job_row
  where job_row.id = p_job_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_job.state = 'completed' then
    return jsonb_build_object('status', 'completed');
  end if;
  if v_job.lease_token is distinct from p_worker_token
    or v_job.lease_expires_at <= v_now
  then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if exists (
    select 1
    from private.data_erasure_manifest as item_row
    where item_row.job_id = v_job.id
      and item_row.deleted_at is null
  ) then
    update private.data_erasure_jobs
    set state = 'storage_pending',
        next_attempt_at = coalesce((
          select min(
            case
              when item_row.first_deleted_at is null then v_now + interval '5 minutes'
              when item_row.final_delete_after <= v_now then v_now + interval '5 minutes'
              else item_row.final_delete_after
            end
          )
          from private.data_erasure_manifest as item_row
          where item_row.job_id = v_job.id
            and item_row.deleted_at is null
        ), v_now + interval '5 minutes'),
        lease_token = null,
        lease_expires_at = null
    where id = v_job.id;
    return jsonb_build_object('status', 'retry');
  end if;

  if v_job.scope = 'location_withdrawal' then
    -- Rebase anti-replay retention on actual completion, not request time.
    -- A Storage outage may keep this job pending for longer than six months.
    insert into private.location_attempt_tombstones (
      owner_fingerprint,
      attempt_key_fingerprint,
      expires_at
    )
    select distinct
      private.location_attempt_owner_fingerprint(v_job.user_id),
      private.location_attempt_key_fingerprint(attempt_row.idempotency_key),
      v_now + interval '6 months'
    from (
      select acquisition_row.idempotency_key
      from public.acquisitions as acquisition_row
      where acquisition_row.user_id = v_job.user_id
        and acquisition_row.acquisition_type = 'field'
      union
      select fact_row.idempotency_key
      from private.location_use_facts as fact_row
      where fact_row.user_id = v_job.user_id
        and fact_row.purpose = 'field_acquisition'
    ) as attempt_row
    on conflict (owner_fingerprint, attempt_key_fingerprint) do update
    set expires_at = greatest(
      private.location_attempt_tombstones.expires_at,
      excluded.expires_at
    );

    -- Full withdrawal supersedes all targeted corrections. Remove their jobs
    -- and requests before deleting either possible FK subject.
    delete from private.data_erasure_jobs
    where user_id = v_job.user_id
      and scope = 'location_correction';

    delete from private.location_correction_requests
    where user_id = v_job.user_id;

    -- Correlated card events can be erased exactly. Do this before deleting the
    -- field cards so the FK correlation remains available. Legacy nullable
    -- card events are deliberately not guessed: deleting them by user alone
    -- would erase unrelated retro/gift history.
    delete from analytics.events as event_row
    where event_row.personal_card_id in (
      select card_row.id
      from public.personal_cards as card_row
      join public.acquisitions as acquisition_row
        on acquisition_row.id = card_row.acquisition_id
       and acquisition_row.user_id = card_row.user_id
      where card_row.user_id = v_job.user_id
        and acquisition_row.acquisition_type = 'field'
    );

    -- Every path in this ledger was included in the completed two-pass
    -- manifest above. Remove the restrictive ownership rows only now, before
    -- deleting their upload/acquisition parents.
    delete from private.personal_card_field_object_ledger
    where user_id = v_job.user_id;

    delete from private.personal_card_temp_uploads as upload_row
    where upload_row.user_id = v_job.user_id
      and (
        exists (
          select 1
          from public.acquisitions as acquisition_row
          where acquisition_row.id = upload_row.processing_acquisition_id
            and acquisition_row.user_id = v_job.user_id
            and acquisition_row.acquisition_type = 'field'
        )
        or exists (
          select 1
          from private.data_erasure_manifest as item_row
          where item_row.job_id = v_job.id
            and item_row.bucket = 'personal-card-temp'
            and item_row.object_path = upload_row.temp_path
            and item_row.deleted_at is not null
        )
      );

    delete from public.personal_cards as card_row
    using public.acquisitions as acquisition_row
    where card_row.acquisition_id = acquisition_row.id
      and card_row.user_id = v_job.user_id
      and acquisition_row.user_id = v_job.user_id
      and acquisition_row.acquisition_type = 'field';

    delete from analytics.events as event_row
    using public.acquisitions as acquisition_row
    where event_row.user_id = v_job.user_id
      and event_row.event_name = 'acquire_success'
      and acquisition_row.user_id = v_job.user_id
      and acquisition_row.acquisition_type = 'field'
      and event_row.spot_id = acquisition_row.spot_id
      and event_row.occurred_at = acquisition_row.acquired_at;

    -- Attempts/failures predate a durable acquisition correlation, but are
    -- themselves location-decision telemetry. Discovery/revisit activity is
    -- not location consent data and must survive withdrawal.
    delete from analytics.events as event_row
    where event_row.user_id = v_job.user_id
      and event_row.event_name::text in ('acquire_attempt', 'acquire_fail');

    delete from private.location_use_facts
    where user_id = v_job.user_id;

    delete from private.location_disclosure_accesses
    where user_id = v_job.user_id;

    delete from public.acquisitions
    where user_id = v_job.user_id
      and acquisition_type = 'field';

    delete from private.location_consents
    where user_id = v_job.user_id;

    delete from private.policy_acceptances as acceptance_row
    using private.policy_documents as document_row
    where acceptance_row.policy_document_id = document_row.id
      and acceptance_row.user_id = v_job.user_id
      and document_row.policy_type = 'location_terms';
  elsif v_job.scope = 'location_correction' then
    select request_row.*
    into v_correction
    from private.location_correction_requests as request_row
    where request_row.id = v_job.correction_request_id
      and request_row.user_id = v_job.user_id
    for update;

    if not found then
      return jsonb_build_object('status', 'unsupported_scope');
    end if;

    if v_correction.location_use_fact_id is not null then
      -- Snapshot only to discover the matching acquisition. The canonical
      -- row locks are acquired below in acquisition->fact order.
      select fact_row.*
      into v_fact
      from private.location_use_facts as fact_row
      where fact_row.id = v_correction.location_use_fact_id
        and fact_row.user_id = v_job.user_id;

      if not found then
        return jsonb_build_object('status', 'unsupported_scope');
      end if;
    end if;

    if v_correction.field_acquisition_id is not null then
      select acquisition_row.*
      into v_acquisition
      from public.acquisitions as acquisition_row
      where acquisition_row.id = v_correction.field_acquisition_id
        and acquisition_row.user_id = v_job.user_id
        and acquisition_row.acquisition_type = 'field'
      for update;

      if v_acquisition.id is not null then
        select fact_row.*
        into v_fact
        from private.location_use_facts as fact_row
        where fact_row.user_id = v_acquisition.user_id
          and fact_row.idempotency_key = v_acquisition.idempotency_key
          and fact_row.spot_id = v_acquisition.spot_id
          and fact_row.purpose = 'field_acquisition'
        for update;
      end if;
      if v_acquisition.id is null then
        return jsonb_build_object('status', 'unsupported_scope');
      end if;
    elsif v_fact.id is not null then
      select acquisition_row.*
      into v_acquisition
      from public.acquisitions as acquisition_row
      where acquisition_row.user_id = v_fact.user_id
        and acquisition_row.idempotency_key = v_fact.idempotency_key
        and acquisition_row.spot_id = v_fact.spot_id
        and acquisition_row.acquisition_type = 'field'
      for update;

      select fact_row.*
      into v_fact
      from private.location_use_facts as fact_row
      where fact_row.id = v_correction.location_use_fact_id
        and fact_row.user_id = v_job.user_id
      for update;
      if not found then
        return jsonb_build_object('status', 'unsupported_scope');
      end if;
    end if;

    insert into private.location_attempt_tombstones (
      owner_fingerprint,
      attempt_key_fingerprint,
      expires_at
    ) values (
      private.location_attempt_owner_fingerprint(v_job.user_id),
      private.location_attempt_key_fingerprint(
        coalesce(v_acquisition.idempotency_key, v_fact.idempotency_key)
      ),
      v_now + interval '6 months'
    )
    on conflict (owner_fingerprint, attempt_key_fingerprint) do update
    set expires_at = greatest(
      private.location_attempt_tombstones.expires_at,
      excluded.expires_at
    );

    -- Mark the request corrected only after its canonical subject is locked
    -- and the anti-replay tombstone has been durably refreshed. The SET NULL
    -- subject deletion below is atomic with this transition.
    update private.location_correction_requests
    set status = 'corrected',
        resolved_at = v_now
    where id = v_correction.id
      and status = 'approved_pending_correction';
    if not found then
      return jsonb_build_object('status', 'unsupported_scope');
    end if;

    if v_fact.id is not null then
      delete from analytics.events as event_row
      where event_row.user_id = v_job.user_id
        and event_row.location_use_fact_id = v_fact.id;
    end if;

    if v_acquisition.id is not null then
      delete from private.personal_card_field_object_ledger
      where user_id = v_job.user_id
        and field_acquisition_id = v_acquisition.id;

      delete from private.personal_card_temp_uploads as upload_row
      where upload_row.user_id = v_job.user_id
        and (
          upload_row.processing_acquisition_id = v_acquisition.id
          or exists (
            select 1
            from private.data_erasure_manifest as item_row
            where item_row.job_id = v_job.id
              and item_row.bucket = 'personal-card-temp'
              and item_row.object_path = upload_row.temp_path
              and item_row.deleted_at is not null
          )
        );

      delete from analytics.events as event_row
      where event_row.user_id = v_job.user_id
        and (
          (
            event_row.location_use_fact_id is null
            and event_row.spot_id = v_acquisition.spot_id
            and event_row.event_name = 'acquire_success'
            and event_row.occurred_at = v_acquisition.acquired_at
          )
          or event_row.personal_card_id in (
            select card_row.id
            from public.personal_cards as card_row
            where card_row.user_id = v_job.user_id
              and card_row.acquisition_id = v_acquisition.id
          )
        );

      delete from public.personal_cards
      where user_id = v_job.user_id
        and acquisition_id = v_acquisition.id;

      delete from public.acquisitions
      where id = v_acquisition.id
        and user_id = v_job.user_id
        and acquisition_type = 'field';
    end if;

    if v_fact.id is not null then
      delete from private.location_use_facts
      where id = v_fact.id
        and user_id = v_job.user_id;
    end if;

  else
    return jsonb_build_object('status', 'unsupported_scope');
  end if;

  -- Object paths embed the subject UUID and are execution data, not a receipt.
  -- Once both deletion phases and the database cleanup succeed, retain only
  -- the bounded job receipt and remove every identifying manifest path now.
  delete from private.data_erasure_manifest
  where job_id = v_job.id;

  update private.data_erasure_jobs
  set state = 'completed',
      completed_at = v_now,
      lease_token = null,
      lease_expires_at = null,
      next_attempt_at = v_now
  where id = v_job.id;

  return jsonb_build_object('status', 'completed');
end;
$$;

create or replace function api_private.purge_expired_location_compliance_records(
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_facts_deleted integer;
  v_disclosures_deleted integer;
  v_corrections_deleted integer;
  v_receipts_deleted integer;
  v_tombstones_deleted integer;
  v_fact_candidate record;
begin
  if p_limit is null or p_limit not between 1 and 10000 then
    return jsonb_build_object('status', 'invalid');
  end if;

  v_facts_deleted := 0;
  for v_fact_candidate in
    select fact_row.id, fact_row.user_id
    from private.location_use_facts as fact_row
    where fact_row.collected_at < clock_timestamp() - interval '6 months'
      and not exists (
        select 1
        from private.location_correction_requests as request_row
        where request_row.location_use_fact_id = fact_row.id
          and request_row.status in ('open', 'approved_pending_correction')
      )
      and not exists (
        select 1
        from private.data_erasure_jobs as job_row
        where job_row.user_id = fact_row.user_id
          and job_row.scope = 'location_withdrawal'
          and job_row.state <> 'completed'
      )
    -- Every retention worker observes owners in the same order. The actual
    -- fact DELETE happens only after the canonical owner advisory lock, so a
    -- concurrent withdrawal/correction either completes its snapshot first or
    -- sees the already-purged normal-retention state afterward.
    order by fact_row.user_id::text, fact_row.collected_at, fact_row.id
    limit p_limit
  loop
    if not pg_try_advisory_xact_lock(hashtextextended(
      'danyeodam:suspend-owner:' || v_fact_candidate.user_id::text,
      0
    )) then
      continue;
    end if;

    delete from private.location_use_facts as fact_row
    where fact_row.id = v_fact_candidate.id
      and fact_row.user_id = v_fact_candidate.user_id
      and fact_row.collected_at < clock_timestamp() - interval '6 months'
      and not exists (
        select 1
        from private.location_correction_requests as request_row
        where request_row.location_use_fact_id = fact_row.id
          and request_row.status in ('open', 'approved_pending_correction')
      )
      and not exists (
        select 1
        from private.data_erasure_jobs as job_row
        where job_row.user_id = fact_row.user_id
          and job_row.scope = 'location_withdrawal'
          and job_row.state <> 'completed'
      );

    if found then
      v_facts_deleted := v_facts_deleted + 1;
    end if;
  end loop;

  with candidates as (
    select access_row.id
    from private.location_disclosure_accesses as access_row
    where access_row.accessed_at < clock_timestamp() - interval '6 months'
    order by access_row.accessed_at, access_row.id
    for update skip locked
    limit p_limit
  ), deleted as (
    delete from private.location_disclosure_accesses as access_row
    using candidates
    where access_row.id = candidates.id
    returning access_row.id
  )
  select count(*)::integer into v_disclosures_deleted from deleted;

  with candidates as (
    select job_row.id
    from private.data_erasure_jobs as job_row
    where job_row.state = 'completed'
      and job_row.completed_at < clock_timestamp() - interval '30 days'
    order by job_row.completed_at, job_row.id
    for update skip locked
    limit p_limit
  ), deleted as (
    delete from private.data_erasure_jobs as job_row
    using candidates
    where job_row.id = candidates.id
    returning job_row.id
  )
  select count(*)::integer into v_receipts_deleted from deleted;

  with candidates as (
    select request_row.id
    from private.location_correction_requests as request_row
    where request_row.status <> 'open'
      and request_row.resolved_at < clock_timestamp() - interval '6 months'
    order by request_row.resolved_at, request_row.id
    for update skip locked
    limit p_limit
  ), deleted as (
    delete from private.location_correction_requests as request_row
    using candidates
    where request_row.id = candidates.id
    returning request_row.id
  )
  select count(*)::integer into v_corrections_deleted from deleted;

  with candidates as (
    select
      tombstone_row.owner_fingerprint,
      tombstone_row.attempt_key_fingerprint
    from private.location_attempt_tombstones as tombstone_row
    where tombstone_row.expires_at <= clock_timestamp()
    order by
      tombstone_row.expires_at,
      tombstone_row.owner_fingerprint,
      tombstone_row.attempt_key_fingerprint
    for update skip locked
    limit p_limit
  ), deleted as (
    delete from private.location_attempt_tombstones as tombstone_row
    using candidates
    where tombstone_row.owner_fingerprint = candidates.owner_fingerprint
      and tombstone_row.attempt_key_fingerprint =
        candidates.attempt_key_fingerprint
    returning tombstone_row.owner_fingerprint
  )
  select count(*)::integer into v_tombstones_deleted from deleted;

  return jsonb_build_object(
    'status', 'purged',
    'facts_deleted', v_facts_deleted,
    'disclosures_deleted', v_disclosures_deleted,
    'resolved_corrections_deleted', v_corrections_deleted,
    'completed_erasure_receipts_deleted', v_receipts_deleted,
    'attempt_tombstones_deleted', v_tombstones_deleted
  );
end;
$$;

create or replace function api_private.get_location_compliance_backlog()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'status', 'ready',
    'pending_jobs', count(*)::integer,
    'overdue_jobs', count(*) filter (
      where job_row.requested_at < statement_timestamp() - interval '24 hours'
    )::integer,
    'high_attempt_jobs', count(*) filter (
      where job_row.attempt_count >= 12
    )::integer,
    'max_attempt_count', coalesce(max(job_row.attempt_count), 0)::integer,
    'oldest_requested_at', min(job_row.requested_at),
    'open_corrections', (
      select count(*)::integer
      from private.location_correction_requests as request_row
      where request_row.status = 'open'
    ),
    'overdue_open_corrections', (
      select count(*)::integer
      from private.location_correction_requests as request_row
      where request_row.status = 'open'
        and request_row.requested_at < statement_timestamp() - interval '24 hours'
    ),
    'oldest_open_requested_at', (
      select min(request_row.requested_at)
      from private.location_correction_requests as request_row
      where request_row.status = 'open'
    ),
    'pending_object_reconciliations', (
      select count(*)::integer
      from private.personal_card_field_object_ledger as ledger_row
    ),
    'overdue_object_reconciliations', (
      select count(*)::integer
      from private.personal_card_field_object_ledger as ledger_row
      where case
          when ledger_row.first_deleted_at is null
            then ledger_row.next_attempt_at
          else greatest(
            ledger_row.next_attempt_at,
            ledger_row.final_delete_not_before,
            ledger_row.final_delete_after
          )
        end < statement_timestamp() - interval '1 hour'
        and (
          ledger_row.lease_token is null
          or ledger_row.lease_expires_at <= statement_timestamp()
        )
        and not exists (
          select 1
          from private.personal_card_temp_uploads as upload_row
          where upload_row.id = ledger_row.upload_id
            and upload_row.user_id = ledger_row.user_id
            and upload_row.processing_acquisition_id = ledger_row.field_acquisition_id
            and upload_row.processing_token = ledger_row.processing_token
            and upload_row.promoted_at is null
            and upload_row.processing_expires_at > statement_timestamp()
        )
        and not exists (
          select 1
          from private.data_erasure_manifest as item_row
          join private.data_erasure_jobs as job_row on job_row.id = item_row.job_id
          where job_row.state <> 'completed'
            and item_row.bucket = ledger_row.bucket
            and item_row.object_path = ledger_row.object_path
        )
    ),
    'high_attempt_object_reconciliations', (
      select count(*)::integer
      from private.personal_card_field_object_ledger as ledger_row
      where ledger_row.attempt_count >= 12
    )
  )
  from private.data_erasure_jobs as job_row
  where job_row.state <> 'completed'
$$;

-- -------------------------------------------------------------------------
-- Function ACLs
-- -------------------------------------------------------------------------

revoke all on function private.active_user_id_for_auth(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.lock_active_user_id_for_auth(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.user_has_current_minimum_age_attestation(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.location_attempt_owner_fingerprint(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.location_attempt_key_fingerprint(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.location_attempt_is_tombstoned(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.adult_active_user_id_for_auth(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.current_location_policy_requirement()
  from public, anon, authenticated, service_role;
revoke all on function private.user_has_current_location_consent(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.user_has_current_location_acceptance(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.location_access_error(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.lock_adult_location_access(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.location_access_code_to_rpc_status(text)
  from public, anon, authenticated, service_role;
revoke all on function private.lock_user_adult_location_access(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.enforce_field_personal_card_location_access()
  from public, anon, authenticated, service_role;
revoke all on function private.field_acquisition_has_pending_correction(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.enforce_field_object_ledger()
  from public, anon, authenticated, service_role;
revoke all on function private.ensure_field_promotion_object_ledger()
  from public, anon, authenticated, service_role;
revoke all on function private.enforce_field_acquisition_location_fact()
  from public, anon, authenticated, service_role;
revoke all on function private.correlate_server_acquire_success()
  from public, anon, authenticated, service_role;
revoke all on function private.copy_minimum_age_on_recovery_rebind()
  from public, anon, authenticated, service_role;
revoke all on function private.lock_field_derivative_access(uuid, uuid)
  from public, anon, authenticated, service_role;

revoke all on function api_private.has_active_adult_identity(uuid)
  from public, anon, authenticated;
revoke all on function api_private.has_active_service_identity(uuid)
  from public, anon, authenticated;
revoke all on function api_private.record_minimum_age_attestation(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function api_private.get_minimum_age_attestation(uuid)
  from public, anon, authenticated;
revoke all on function api_private.claim_recovery_code(uuid, text)
  from public, anon, authenticated;
revoke all on function api_private.ingest_client_events(uuid, boolean, jsonb)
  from public, anon, authenticated;
revoke all on function api_private.get_location_consent(uuid)
  from public, anon, authenticated;
revoke all on function api_private.accept_location_consent(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function api_private.change_location_consent_state(uuid, text)
  from public, anon, authenticated;
revoke all on function api_private.request_location_withdrawal(uuid)
  from public, anon, authenticated;
revoke all on function api_private.begin_personal_card_promotion(
  uuid, boolean, uuid, text, text, uuid
) from public, anon, authenticated;
revoke all on function api_private.complete_personal_card_promotion(
  uuid, uuid, uuid, uuid, text, text
) from public, anon, authenticated;
revoke all on function api_private.create_personal_card_share(
  uuid, boolean, boolean, uuid, text
) from public, anon, authenticated;
revoke all on function api_private.revoke_personal_card_share(uuid, uuid)
  from public, anon, authenticated;
revoke all on function api_private.moderate_personal_card_share(
  uuid, uuid, uuid, text, text, text, boolean
) from public, anon, authenticated;
revoke all on function api_private.acquire_context(uuid, uuid, uuid, boolean)
  from public, anon, authenticated;
revoke all on function api_private.acquire_commit(
  uuid, uuid, uuid, boolean, timestamptz
) from public, anon, authenticated;
revoke all on function api_private.record_acquire_failure(uuid, uuid, uuid, text, jsonb)
  from public, anon, authenticated;
revoke all on function api_private.list_location_use_facts(
  uuid, integer, timestamptz, bigint
) from public, anon, authenticated;
revoke all on function api_private.list_location_correction_subjects(
  uuid, integer, date, uuid
) from public, anon, authenticated, service_role;
revoke all on function api_private.create_location_correction_request(
  uuid, bigint, uuid, uuid, text
) from public, anon, authenticated;
revoke all on function api_private.list_own_location_corrections(uuid, integer)
  from public, anon, authenticated;
revoke all on function api_private.list_location_corrections_admin(uuid, text, integer)
  from public, anon, authenticated;
revoke all on function api_private.resolve_location_correction_admin(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function api_private.claim_personal_card_field_object_cleanup(uuid, integer)
  from public, anon, authenticated, service_role;
revoke all on function api_private.record_personal_card_field_object_cleanup_result(
  uuid, bigint, boolean
) from public, anon, authenticated, service_role;
revoke all on function api_private.claim_data_erasure_jobs(uuid, integer, integer)
  from public, anon, authenticated;
revoke all on function api_private.record_data_erasure_item_result(
  uuid, uuid, bigint, boolean
) from public, anon, authenticated;
revoke all on function api_private.finish_data_erasure_job(uuid, uuid)
  from public, anon, authenticated;
revoke all on function api_private.purge_expired_location_compliance_records(integer)
  from public, anon, authenticated;
revoke all on function api_private.get_location_compliance_backlog()
  from public, anon, authenticated;

grant execute on function api_private.has_active_adult_identity(uuid)
  to service_role;
grant execute on function api_private.has_active_service_identity(uuid)
  to service_role;
grant execute on function api_private.record_minimum_age_attestation(uuid, jsonb)
  to service_role;
grant execute on function api_private.get_minimum_age_attestation(uuid)
  to service_role;
grant execute on function api_private.claim_recovery_code(uuid, text)
  to service_role;
grant execute on function api_private.ingest_client_events(uuid, boolean, jsonb)
  to service_role;
grant execute on function api_private.get_location_consent(uuid)
  to service_role;
grant execute on function api_private.accept_location_consent(uuid, jsonb)
  to service_role;
grant execute on function api_private.change_location_consent_state(uuid, text)
  to service_role;
grant execute on function api_private.request_location_withdrawal(uuid)
  to service_role;
grant execute on function api_private.begin_personal_card_promotion(
  uuid, boolean, uuid, text, text, uuid
) to service_role;
grant execute on function api_private.complete_personal_card_promotion(
  uuid, uuid, uuid, uuid, text, text
) to service_role;
grant execute on function api_private.create_personal_card_share(
  uuid, boolean, boolean, uuid, text
) to service_role;
grant execute on function api_private.revoke_personal_card_share(uuid, uuid)
  to service_role;
grant execute on function api_private.moderate_personal_card_share(
  uuid, uuid, uuid, text, text, text, boolean
) to service_role;
grant execute on function api_private.acquire_context(uuid, uuid, uuid, boolean)
  to service_role;
grant execute on function api_private.acquire_commit(
  uuid, uuid, uuid, boolean, timestamptz
) to service_role;
grant execute on function api_private.record_acquire_failure(uuid, uuid, uuid, text, jsonb)
  to service_role;
grant execute on function api_private.list_location_use_facts(
  uuid, integer, timestamptz, bigint
) to service_role;
grant execute on function api_private.list_location_correction_subjects(
  uuid, integer, date, uuid
) to service_role;
grant execute on function api_private.create_location_correction_request(
  uuid, bigint, uuid, uuid, text
) to service_role;
grant execute on function api_private.list_own_location_corrections(uuid, integer)
  to service_role;
grant execute on function api_private.list_location_corrections_admin(uuid, text, integer)
  to service_role;
grant execute on function api_private.resolve_location_correction_admin(uuid, uuid, text)
  to service_role;
grant execute on function api_private.claim_personal_card_field_object_cleanup(uuid, integer)
  to service_role;
grant execute on function api_private.record_personal_card_field_object_cleanup_result(
  uuid, bigint, boolean
) to service_role;
grant execute on function api_private.claim_data_erasure_jobs(uuid, integer, integer)
  to service_role;
grant execute on function api_private.record_data_erasure_item_result(
  uuid, uuid, bigint, boolean
) to service_role;
grant execute on function api_private.finish_data_erasure_job(uuid, uuid)
  to service_role;
grant execute on function api_private.purge_expired_location_compliance_records(integer)
  to service_role;
grant execute on function api_private.get_location_compliance_backlog()
  to service_role;

commit;
