-- DANYEODAM Stage 0 two-phase temporary upload cleanup.
--
-- The first phase removes an unpromoted object after the ten-minute promotion
-- window. The final phase waits ten minutes beyond the two-hour signed URL
-- expiry before re-deleting the path, preventing clock/issuance races from
-- recreating an object after cleanup completes. Both phases only lease
-- database-owned paths; Storage objects are deleted through the Storage API by
-- the Node.js maintenance worker.

alter table private.personal_card_temp_uploads
  add column expiry_cleanup_started_at timestamptz;

alter table private.personal_card_temp_uploads
  add constraint personal_card_temp_uploads_expiry_cleanup_claim_state check (
    expiry_cleanup_started_at is null
    or (
      expiry_cleanup_started_at >= promotion_expires_at
      and expiry_cleanup_started_at < signed_url_expires_at
    )
  );

create index personal_card_temp_uploads_expiry_cleanup_claim_idx
  on private.personal_card_temp_uploads(
    promotion_expires_at,
    expiry_cleanup_started_at
  )
  where promoted_at is null and temp_deleted_at is null;

create or replace function api_private.list_personal_card_expiry_cleanup(
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 100);
  v_now timestamptz := clock_timestamp();
  v_results jsonb;
begin
  with candidates as (
    select upload_row.id
    from private.personal_card_temp_uploads as upload_row
    where upload_row.promotion_expires_at <= v_now
      -- After expiry plus the safety margin, the final cleanup phase takes
      -- ownership and re-deletes the path even when this phase succeeded.
      and upload_row.signed_url_expires_at > v_now
      and upload_row.promoted_at is null
      and upload_row.temp_deleted_at is null
      and (
        upload_row.expiry_cleanup_started_at is null
        or upload_row.expiry_cleanup_started_at <=
          v_now - interval '15 minutes'
      )
    order by upload_row.promotion_expires_at, upload_row.id
    for update skip locked
    limit v_limit
  ), claimed as (
    update private.personal_card_temp_uploads as upload_row
    set expiry_cleanup_started_at = v_now
    from candidates
    where upload_row.id = candidates.id
    returning upload_row.id, upload_row.temp_path
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'upload_id', claimed.id,
        'temp_path', claimed.temp_path
      )
      order by claimed.id
    ),
    '[]'::jsonb
  )
  into v_results
  from claimed;

  return v_results;
end;
$$;

-- Keep a safety margin after the nominal signed URL expiry. The Storage token
-- is issued outside the database transaction, so its actual validity window
-- may end slightly after signed_url_expires_at persisted by the database.
create or replace function api_private.list_personal_card_temp_cleanup(
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 100);
  v_now timestamptz := clock_timestamp();
  v_results jsonb;
begin
  with candidates as (
    select upload_row.id
    from private.personal_card_temp_uploads as upload_row
    where upload_row.signed_url_expires_at + interval '10 minutes' <= v_now
      and upload_row.cleanup_completed_at is null
      and (
        upload_row.cleanup_started_at is null
        or upload_row.cleanup_started_at <= v_now - interval '15 minutes'
      )
    order by upload_row.signed_url_expires_at, upload_row.id
    for update skip locked
    limit v_limit
  ), claimed as (
    update private.personal_card_temp_uploads as upload_row
    set cleanup_started_at = v_now
    from candidates
    where upload_row.id = candidates.id
    returning upload_row.id, upload_row.temp_path
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'upload_id', claimed.id,
        'temp_path', claimed.temp_path
      )
      order by claimed.id
    ),
    '[]'::jsonb
  )
  into v_results
  from claimed;

  return v_results;
end;
$$;

create or replace function api_private.complete_personal_card_temp_cleanup(
  p_upload_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_upload private.personal_card_temp_uploads%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  select upload_row.*
  into v_upload
  from private.personal_card_temp_uploads as upload_row
  where upload_row.id = p_upload_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_upload.cleanup_completed_at is not null then
    return jsonb_build_object('status', 'updated');
  end if;

  if v_upload.signed_url_expires_at + interval '10 minutes' > v_now
    or v_upload.cleanup_started_at is null
  then
    return jsonb_build_object('status', 'stale');
  end if;

  update private.personal_card_temp_uploads
  set temp_deleted_at = v_now,
      cleanup_completed_at = v_now
  where id = p_upload_id;

  return jsonb_build_object('status', 'updated');
end;
$$;

-- Browser roles cannot invoke the privileged queue. The server receives only
-- paths that were generated and persisted by the database.
revoke all on function api_private.list_personal_card_expiry_cleanup(integer)
  from public, anon, authenticated, service_role;

grant execute on function api_private.list_personal_card_expiry_cleanup(integer)
  to service_role;
