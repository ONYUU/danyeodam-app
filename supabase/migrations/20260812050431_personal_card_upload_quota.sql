-- API contract v0.4.0: database-enforced personal-card upload and storage
-- quotas. This migration is deliberately after account deletion v4 so its
-- owner serialization and app_users cascade apply to the new quota state.

begin;

-- Freeze Storage metadata for the exact legacy byte-accounting snapshot. The
-- prior account migration's lock ended at its commit and cannot protect this
-- separate forward migration.
lock table storage.objects in share row exclusive mode;
lock table private.personal_card_temp_uploads in share row exclusive mode;

create table private.personal_card_upload_rate_states (
  user_id uuid primary key
    references public.app_users(id) on delete cascade,
  issued_at timestamptz[] not null default '{}'::timestamptz[],
  updated_at timestamptz not null default clock_timestamp(),
  constraint personal_card_upload_rate_states_bounded check (
    cardinality(issued_at) <= 20
  )
);

alter table private.personal_card_upload_rate_states enable row level security;
alter table private.personal_card_upload_rate_states force row level security;

revoke all on table private.personal_card_upload_rate_states
  from public, anon, authenticated, service_role;

comment on table private.personal_card_upload_rate_states is
  'Bounded rolling timestamps for the 10/hour and 20/24-hour signed upload URL limits.';

-- Preserve the rolling window across cutover. Keep the newest twenty exact
-- successful reservations; if historical volume exceeded the new contract,
-- that conservatively holds the account at the daily limit until timestamps
-- naturally age out.
insert into private.personal_card_upload_rate_states (
  user_id,
  issued_at,
  updated_at
)
select
  user_row.user_id,
  array_agg(user_row.issued_at order by user_row.issued_at),
  clock_timestamp()
from (
  select
    upload_row.user_id,
    upload_row.issued_at,
    row_number() over (
      partition by upload_row.user_id
      order by upload_row.issued_at desc, upload_row.id desc
    ) as recency
  from private.personal_card_temp_uploads as upload_row
  where upload_row.issued_at > clock_timestamp() - interval '24 hours'
) as user_row
where user_row.recency <= 20
group by user_row.user_id;

create index personal_card_temp_uploads_active_quota_idx
  on private.personal_card_temp_uploads(user_id)
  where cleanup_completed_at is null;

alter table private.personal_card_temp_uploads
  add column quota_issued_at timestamptz,
  add constraint personal_card_temp_uploads_quota_issue_time check (
    quota_issued_at is null
    or (
      quota_issued_at >= issued_at
      and quota_issued_at < signed_url_expires_at
    )
  );

alter table public.personal_cards
  add column photo_size_bytes bigint;

-- Existing objects predate application-level byte accounting. Import their
-- exact Storage metadata instead of assuming that an older encoder respected
-- the new five-MiB output limit. Missing, malformed, oversized, or over-quota
-- legacy state blocks the cutover for explicit operator remediation.
update public.personal_cards as card_row
set photo_size_bytes = (object_row.metadata ->> 'size')::bigint
from storage.objects as object_row
where object_row.bucket_id = 'personal-cards'
  and object_row.name = card_row.photo_path
  and object_row.metadata ->> 'size' ~ '^[1-9][0-9]{0,17}$';

do $legacy_personal_card_quota_preflight$
begin
  -- Account v4 imports legacy/orphan ledgers before this migration, but a
  -- reservation is not evidence of physical bytes. Require exact metadata for
  -- every protected permanent object, including field and generic orphans, so
  -- neither the per-object nor owner-wide physical quota can be undercounted.
  if exists (
    select 1
    from storage.objects as object_row
    where object_row.bucket_id = 'personal-cards'
      and (
        coalesce(object_row.metadata ->> 'size', '') !~ '^[1-9][0-9]{0,17}$'
        or case
          when object_row.metadata ->> 'size' ~ '^[1-9][0-9]{0,17}$'
            then (object_row.metadata ->> 'size')::numeric > 5242880
          else true
        end
      )
  ) then
    raise exception 'legacy personal-card Storage object lacks exact quota-safe byte metadata'
      using errcode = '23514';
  end if;

  if exists (
    select split_part(object_row.name, '/', 1)::uuid
    from storage.objects as object_row
    where object_row.bucket_id = 'personal-cards'
    group by split_part(object_row.name, '/', 1)::uuid
    having sum((object_row.metadata ->> 'size')::numeric) > 524288000
  ) then
    raise exception 'legacy personal-card Storage owner exceeds the physical account quota'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.personal_cards as card_row
    where card_row.photo_size_bytes is null
      or card_row.photo_size_bytes > 5242880
  ) then
    raise exception 'legacy personal-card Storage metadata violates the five-MiB quota'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.personal_cards as card_row
    group by card_row.user_id
    having count(*) > 200
      or sum(card_row.photo_size_bytes) > 524288000
  ) then
    raise exception 'legacy personal-card owner exceeds the account quota'
      using errcode = '23514';
  end if;

  if exists (
    select owner_usage.user_id
    from (
      select card_row.user_id, sum(card_row.photo_size_bytes)::numeric as bytes
      from public.personal_cards as card_row
      group by card_row.user_id
      union all
      select ledger_row.user_id, sum(ledger_row.reserved_bytes)::numeric
      from private.personal_card_permanent_object_ledger as ledger_row
      group by ledger_row.user_id
      union all
      select ledger_row.user_id, count(*)::numeric * 5242880
      from private.personal_card_field_object_ledger as ledger_row
      where ledger_row.bucket = 'personal-cards'
      group by ledger_row.user_id
    ) as owner_usage
    group by owner_usage.user_id
    having sum(owner_usage.bytes) > 524288000
  ) then
    raise exception 'legacy personal-card objects exceed the physical account quota'
      using errcode = '23514';
  end if;

  if exists (
    select owner_count.user_id
    from (
      select ledger_row.user_id, count(*)::bigint as object_count
      from private.personal_card_permanent_object_ledger as ledger_row
      group by ledger_row.user_id
      union all
      select ledger_row.user_id, count(*)::bigint
      from private.personal_card_field_object_ledger as ledger_row
      where ledger_row.bucket = 'personal-cards'
      group by ledger_row.user_id
    ) as owner_count
    group by owner_count.user_id
    having sum(owner_count.object_count) > 20
  ) then
    raise exception 'legacy personal-card promotion backlog exceeds the hard cap'
      using errcode = '23514';
  end if;
end;
$legacy_personal_card_quota_preflight$;

alter table public.personal_cards
  alter column photo_size_bytes set default 5242880,
  alter column photo_size_bytes set not null,
  add constraint personal_cards_photo_size_bytes_valid check (
    photo_size_bytes between 1 and 5242880
  );

comment on column public.personal_cards.photo_size_bytes is
  'Exact server-derived WebP byte length, including Storage-metadata backfill for legacy rows.';

create or replace function private.prepare_personal_card_storage_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_size_context text;
  v_card_count bigint;
  v_total_bytes numeric;
  v_pending_bytes numeric;
begin
  -- Only the size-aware completion wrapper establishes this transaction-local
  -- value. Historical trusted inserts are charged the full 5 MiB so missing
  -- legacy metadata can never undercount storage.
  v_size_context := current_setting(
    'danyeodam.personal_card_photo_size_bytes',
    true
  );
  if v_size_context ~ '^[1-9][0-9]{0,6}$'
    and v_size_context::bigint <= 5242880
  then
    new.photo_size_bytes := v_size_context::bigint;
  else
    new.photo_size_bytes := 5242880;
  end if;

  -- This runs before the row is written, preserving the canonical owner-lock
  -- order and preventing a row-lock/advisory-lock inversion with deletion.
  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || new.user_id::text,
    0
  ));

  select
    count(*),
    coalesce(sum(card_row.photo_size_bytes), 0)
  into v_card_count, v_total_bytes
  from public.personal_cards as card_row
  where card_row.user_id = new.user_id;

  select coalesce(sum(pending_row.bytes), 0)
  into v_pending_bytes
  from (
    select ledger_row.reserved_bytes::numeric as bytes
    from private.personal_card_permanent_object_ledger as ledger_row
    where ledger_row.user_id = new.user_id
      and ledger_row.object_path <> new.photo_path
    union all
    select 5242880::numeric
    from private.personal_card_field_object_ledger as ledger_row
    where ledger_row.user_id = new.user_id
      and ledger_row.bucket = 'personal-cards'
      and ledger_row.object_path <> new.photo_path
  ) as pending_row;

  if v_card_count >= 200 then
    raise exception 'personal-card count quota exceeded'
      using errcode = '23514';
  end if;

  if v_total_bytes + v_pending_bytes + new.photo_size_bytes > 524288000 then
    raise exception 'personal-card storage quota exceeded'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function private.prepare_personal_card_storage_quota()
  from public, anon, authenticated, service_role;

create trigger personal_cards_prepare_storage_quota
before insert on public.personal_cards
for each row execute function private.prepare_personal_card_storage_quota();

create or replace function private.reject_personal_card_size_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.photo_size_bytes is distinct from old.photo_size_bytes
    or new.user_id is distinct from old.user_id
  then
    raise exception 'personal-card owner and byte accounting are immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.reject_personal_card_size_mutation()
  from public, anon, authenticated, service_role;

create trigger personal_cards_immutable_storage_accounting
before update of user_id, photo_size_bytes on public.personal_cards
for each row execute function private.reject_personal_card_size_mutation();

alter function api_private.issue_personal_card_temp_upload(
  uuid, boolean, text, bigint
) rename to issue_personal_card_temp_upload_before_quota;

revoke all on function api_private.issue_personal_card_temp_upload_before_quota(
  uuid, boolean, text, bigint
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
  v_result jsonb;
  v_upload_id uuid;
  v_now timestamptz;
  v_issued_at timestamptz[];
  v_hour_count integer;
  v_day_count integer;
  v_hour_oldest timestamptz;
  v_day_oldest timestamptz;
  v_hour_retry integer := 0;
  v_day_retry integer := 0;
  v_retry_after integer;
  v_active_temp_count bigint;
  v_card_count bigint;
  v_total_bytes numeric;
  v_outstanding_permanent_objects bigint;
  v_pending_bytes numeric;
begin
  v_user_id := private.lock_active_user_id_for_auth(p_auth_user_id);
  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  -- Match the established policy -> owner lock order used by personal-card
  -- writes, and serialize against account deletion before the wrapped insert.
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
    from public.app_users as user_row
    where user_row.id = v_user_id
      and user_row.deletion_requested_at is not null
  ) then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  select coalesce(sum(outstanding_row.object_count), 0)
  into v_outstanding_permanent_objects
  from (
    select count(*)::bigint as object_count
    from private.personal_card_field_object_ledger as ledger_row
    where ledger_row.user_id = v_user_id
      and ledger_row.bucket = 'personal-cards'
    union all
    select count(*)::bigint
    from private.personal_card_permanent_object_ledger as ledger_row
    where ledger_row.user_id = v_user_id
  ) as outstanding_row;

  if v_outstanding_permanent_objects >= 20 then
    return jsonb_build_object(
      'status', 'quota_exceeded',
      'reason', 'permanent_object_backlog'
    );
  end if;

  v_result := api_private.issue_personal_card_temp_upload_before_quota(
    p_auth_user_id,
    p_public_gate_open,
    p_declared_content_type,
    p_declared_size_bytes
  );

  if v_result ->> 'status' <> 'issued' then
    return v_result;
  end if;

  v_upload_id := (v_result ->> 'upload_id')::uuid;
  v_now := clock_timestamp();

  select count(*)
  into v_active_temp_count
  from private.personal_card_temp_uploads as upload_row
  where upload_row.user_id = v_user_id
    and upload_row.cleanup_completed_at is null;

  if v_active_temp_count > 3 then
    delete from private.personal_card_temp_uploads
    where id = v_upload_id
      and user_id = v_user_id;
    return jsonb_build_object(
      'status', 'quota_exceeded',
      'reason', 'active_temp_uploads'
    );
  end if;

  select
    count(*),
    coalesce(sum(coalesce(card_row.photo_size_bytes, 5242880)), 0)
  into v_card_count, v_total_bytes
  from public.personal_cards as card_row
  where card_row.user_id = v_user_id;

  select coalesce(sum(pending_row.bytes), 0)
  into v_pending_bytes
  from (
    select ledger_row.reserved_bytes::numeric as bytes
    from private.personal_card_permanent_object_ledger as ledger_row
    where ledger_row.user_id = v_user_id
    union all
    select 5242880::numeric
    from private.personal_card_field_object_ledger as ledger_row
    where ledger_row.user_id = v_user_id
      and ledger_row.bucket = 'personal-cards'
  ) as pending_row;

  if v_card_count >= 200
    or v_total_bytes + v_pending_bytes >= 524288000
  then
    delete from private.personal_card_temp_uploads
    where id = v_upload_id
      and user_id = v_user_id;
    return jsonb_build_object(
      'status', 'quota_exceeded',
      'reason', case
        when v_card_count >= 200 then 'card_count'
        else 'storage_bytes'
      end
    );
  end if;

  select state_row.issued_at
  into v_issued_at
  from private.personal_card_upload_rate_states as state_row
  where state_row.user_id = v_user_id
  for update;

  if not found then
    v_issued_at := '{}'::timestamptz[];
  end if;

  select coalesce(
    array_agg(issue_row.issue_time order by issue_row.issue_time),
    '{}'::timestamptz[]
  )
  into v_issued_at
  from unnest(v_issued_at) as issue_row(issue_time)
  where issue_row.issue_time > v_now - interval '24 hours';

  select
    count(*) filter (
      where issue_row.issue_time > v_now - interval '1 hour'
    ),
    count(*),
    min(issue_row.issue_time) filter (
      where issue_row.issue_time > v_now - interval '1 hour'
    ),
    min(issue_row.issue_time)
  into v_hour_count, v_day_count, v_hour_oldest, v_day_oldest
  from unnest(v_issued_at) as issue_row(issue_time);

  if v_hour_count >= 10 then
    v_hour_retry := greatest(
      1,
      ceil(extract(epoch from (
        v_hour_oldest + interval '1 hour' - v_now
      )))::integer
    );
  end if;
  if v_day_count >= 20 then
    v_day_retry := greatest(
      1,
      ceil(extract(epoch from (
        v_day_oldest + interval '24 hours' - v_now
      )))::integer
    );
  end if;

  if v_hour_retry > 0 or v_day_retry > 0 then
    v_retry_after := greatest(v_hour_retry, v_day_retry);
    delete from private.personal_card_temp_uploads
    where id = v_upload_id
      and user_id = v_user_id;

    update private.personal_card_upload_rate_states
    set issued_at = v_issued_at,
        updated_at = v_now
    where user_id = v_user_id;

    return jsonb_build_object(
      'status', 'rate_limited',
      'retry_after_seconds', v_retry_after
    );
  end if;

  v_issued_at := array_append(v_issued_at, v_now);
  insert into private.personal_card_upload_rate_states (
    user_id,
    issued_at,
    updated_at
  ) values (
    v_user_id,
    v_issued_at,
    v_now
  )
  on conflict (user_id) do update
  set issued_at = excluded.issued_at,
      updated_at = excluded.updated_at;

  update private.personal_card_temp_uploads
  set quota_issued_at = v_now
  where id = v_upload_id
    and user_id = v_user_id;

  if not found then
    raise exception 'issued upload reservation disappeared'
      using errcode = '40001';
  end if;

  return v_result || jsonb_build_object('quota_issued_at', v_now);
end;
$$;

revoke all on function api_private.issue_personal_card_temp_upload(
  uuid, boolean, text, bigint
) from public, anon, authenticated;
grant execute on function api_private.issue_personal_card_temp_upload(
  uuid, boolean, text, bigint
) to service_role;

-- Creating the signed Storage token happens after the issuing transaction.
-- If that external call fails before a URL reaches the caller, cancel only
-- the exact untouched reservation and refund exactly one matching rolling
-- timestamp. Account deletion and promotion share the same owner lock, so a
-- concurrently claimed/deleted row is never revived or partially refunded.
create or replace function api_private.cancel_personal_card_temp_upload_issue(
  p_upload_id uuid,
  p_quota_issued_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_upload private.personal_card_temp_uploads%rowtype;
  v_issued_at timestamptz[];
  v_refund_position integer;
  v_refunded timestamptz[];
begin
  if p_upload_id is null or p_quota_issued_at is null then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- Resolve the owner without a row lock, take the canonical owner advisory,
  -- then re-read and lock the exact reservation.
  select upload_row.user_id
  into v_user_id
  from private.personal_card_temp_uploads as upload_row
  where upload_row.id = p_upload_id;

  if not found then return jsonb_build_object('status', 'not_found'); end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_user_id::text,
    0
  ));

  select upload_row.*
  into v_upload
  from private.personal_card_temp_uploads as upload_row
  where upload_row.id = p_upload_id
    and upload_row.user_id = v_user_id
  for update;

  if not found then return jsonb_build_object('status', 'not_found'); end if;

  if v_upload.quota_issued_at is distinct from p_quota_issued_at
    or v_upload.processing_token is not null
    or v_upload.processing_started_at is not null
    or v_upload.processing_expires_at is not null
    or v_upload.processing_acquisition_id is not null
    or v_upload.processing_permanent_path is not null
    or v_upload.processing_caption is not null
    or v_upload.promoted_at is not null
    or v_upload.permanent_path is not null
    or v_upload.temp_deleted_at is not null
    or v_upload.expiry_cleanup_started_at is not null
    or v_upload.cleanup_started_at is not null
    or v_upload.cleanup_completed_at is not null
  then
    return jsonb_build_object('status', 'stale');
  end if;

  select state_row.issued_at
  into v_issued_at
  from private.personal_card_upload_rate_states as state_row
  where state_row.user_id = v_user_id
  for update;

  if not found then return jsonb_build_object('status', 'stale'); end if;

  v_refund_position := array_position(v_issued_at, p_quota_issued_at);
  if v_refund_position is null then
    return jsonb_build_object('status', 'stale');
  end if;

  v_refunded := coalesce(
    v_issued_at[1:v_refund_position - 1],
    '{}'::timestamptz[]
  ) || coalesce(
    v_issued_at[v_refund_position + 1:cardinality(v_issued_at)],
    '{}'::timestamptz[]
  );

  if cardinality(v_refunded) <> cardinality(v_issued_at) - 1 then
    raise exception 'upload issuance refund cardinality mismatch'
      using errcode = '23514';
  end if;

  update private.personal_card_upload_rate_states
  set issued_at = v_refunded,
      updated_at = clock_timestamp()
  where user_id = v_user_id;

  delete from private.personal_card_temp_uploads
  where id = p_upload_id
    and user_id = v_user_id
    and quota_issued_at = p_quota_issued_at;

  if not found then
    raise exception 'upload issuance cancellation lost its reservation'
      using errcode = '40001';
  end if;

  return jsonb_build_object('status', 'cancelled');
end;
$$;

revoke all on function api_private.cancel_personal_card_temp_upload_issue(
  uuid, timestamptz
) from public, anon, authenticated;
grant execute on function api_private.cancel_personal_card_temp_upload_issue(
  uuid, timestamptz
) to service_role;

alter function api_private.begin_personal_card_promotion(
  uuid, boolean, uuid, text, text, uuid
) rename to begin_personal_card_promotion_before_storage_quota;

revoke all on function api_private.begin_personal_card_promotion_before_storage_quota(
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
  v_card_bytes numeric;
  v_pending_bytes numeric;
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
    select coalesce(sum(card_row.photo_size_bytes), 0)
    into v_card_bytes
    from public.personal_cards as card_row
    where card_row.user_id = v_user_id;

    select coalesce(sum(pending_row.bytes), 0)
    into v_pending_bytes
    from (
      select ledger_row.reserved_bytes::numeric as bytes
      from private.personal_card_permanent_object_ledger as ledger_row
      where ledger_row.user_id = v_user_id
        and ledger_row.object_path <> v_permanent_path
      union all
      select 5242880::numeric
      from private.personal_card_field_object_ledger as ledger_row
      where ledger_row.user_id = v_user_id
        and ledger_row.bucket = 'personal-cards'
        and ledger_row.object_path <> v_permanent_path
    ) as pending_row;

    if v_card_bytes + v_pending_bytes + 5242880 > 524288000 then
      return jsonb_build_object(
        'status', 'quota_exceeded',
        'reason', 'storage_bytes'
      );
    end if;
  end if;

  return api_private.begin_personal_card_promotion_before_storage_quota(
    p_auth_user_id,
    p_public_gate_open,
    p_acquisition_id,
    p_temp_path,
    p_caption,
    p_processing_token
  );
end;
$$;

alter function api_private.complete_personal_card_promotion(
  uuid, uuid, uuid, uuid, text, text
) rename to complete_personal_card_promotion_before_storage_quota;

revoke all on function api_private.complete_personal_card_promotion_before_storage_quota(
  uuid, uuid, uuid, uuid, text, text
) from public, anon, authenticated, service_role;

create or replace function api_private.complete_personal_card_promotion_with_size(
  p_auth_user_id uuid,
  p_upload_id uuid,
  p_processing_token uuid,
  p_acquisition_id uuid,
  p_permanent_path text,
  p_caption text,
  p_photo_size_bytes bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_card_count bigint;
  v_total_bytes numeric;
  v_pending_bytes numeric;
  v_result jsonb;
  v_previous_size_context text;
begin
  if p_photo_size_bytes is null
    or p_photo_size_bytes < 1
    or p_photo_size_bytes > 5242880
  then
    return jsonb_build_object(
      'status', 'quota_exceeded',
      'reason', 'derived_file_size'
    );
  end if;

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

  if exists (
    select 1
    from public.app_users as user_row
    where user_row.id = v_user_id
      and user_row.deletion_requested_at is not null
  ) then
    return jsonb_build_object('status', 'unauthorized');
  end if;

  -- An idempotent completion retry remains available at the ceiling.
  if not exists (
    select 1
    from public.personal_cards as card_row
    where card_row.user_id = v_user_id
      and card_row.acquisition_id = p_acquisition_id
  ) then
    select
      count(*),
      coalesce(sum(coalesce(card_row.photo_size_bytes, 5242880)), 0)
    into v_card_count, v_total_bytes
    from public.personal_cards as card_row
    where card_row.user_id = v_user_id;

    select coalesce(sum(pending_row.bytes), 0)
    into v_pending_bytes
    from (
      select ledger_row.reserved_bytes::numeric as bytes
      from private.personal_card_permanent_object_ledger as ledger_row
      where ledger_row.user_id = v_user_id
        and ledger_row.object_path <> p_permanent_path
      union all
      select 5242880::numeric
      from private.personal_card_field_object_ledger as ledger_row
      where ledger_row.user_id = v_user_id
        and ledger_row.bucket = 'personal-cards'
        and ledger_row.object_path <> p_permanent_path
    ) as pending_row;

    if v_card_count >= 200 then
      return jsonb_build_object(
        'status', 'quota_exceeded',
        'reason', 'card_count'
      );
    end if;
    if v_total_bytes + v_pending_bytes + p_photo_size_bytes > 524288000 then
      return jsonb_build_object(
        'status', 'quota_exceeded',
        'reason', 'storage_bytes'
      );
    end if;
  end if;

  v_previous_size_context := current_setting(
    'danyeodam.personal_card_photo_size_bytes',
    true
  );
  perform set_config(
    'danyeodam.personal_card_photo_size_bytes',
    p_photo_size_bytes::text,
    true
  );

  begin
    v_result := api_private.complete_personal_card_promotion_before_storage_quota(
      p_auth_user_id,
      p_upload_id,
      p_processing_token,
      p_acquisition_id,
      p_permanent_path,
      p_caption
    );
  exception when others then
    perform set_config(
      'danyeodam.personal_card_photo_size_bytes',
      coalesce(v_previous_size_context, ''),
      true
    );
    raise;
  end;

  perform set_config(
    'danyeodam.personal_card_photo_size_bytes',
    coalesce(v_previous_size_context, ''),
    true
  );

  return v_result;
end;
$$;

-- The historical six-argument completion cannot prove the derived object's
-- byte length. Fail closed after cutover; old application writers must be
-- quiesced and drained before this migration, and all new calls use the
-- size-aware seven-argument boundary.
create or replace function api_private.complete_personal_card_promotion(
  p_auth_user_id uuid,
  p_upload_id uuid,
  p_processing_token uuid,
  p_acquisition_id uuid,
  p_permanent_path text,
  p_caption text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'status', 'validation_failed',
    'reason', 'exact_derived_size_required'
  )
$$;

revoke all on function api_private.complete_personal_card_promotion_with_size(
  uuid, uuid, uuid, uuid, text, text, bigint
) from public, anon, authenticated;
revoke all on function api_private.begin_personal_card_promotion(
  uuid, boolean, uuid, text, text, uuid
) from public, anon, authenticated, service_role;
revoke all on function api_private.complete_personal_card_promotion(
  uuid, uuid, uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function api_private.complete_personal_card_promotion_with_size(
  uuid, uuid, uuid, uuid, text, text, bigint
) to service_role;
grant execute on function api_private.begin_personal_card_promotion(
  uuid, boolean, uuid, text, text, uuid
) to service_role;

commit;
