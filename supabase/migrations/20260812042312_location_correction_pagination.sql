-- Remove the bounded, first-page-only overload before exposing the keyset
-- contract. Keeping both signatures would let a stale server silently truncate
-- a user's privacy-rights history at 100 rows.
drop function if exists api_private.list_own_location_corrections(uuid, integer);

create or replace function api_private.list_own_location_corrections(
  p_auth_user_id uuid,
  p_limit integer,
  p_before_requested_at timestamptz,
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
begin
  -- This is a privacy-rights read: it requires only a current active identity,
  -- never participant access, minimum-age attestation, or current consent.
  -- Hold the binding row while resolving the logical owner so recovery cannot
  -- rebind this Auth UID midway through the page read.
  v_user_id := private.lock_active_user_id_for_auth(p_auth_user_id);
  if v_user_id is null then
    return jsonb_build_object('status', 'unauthorized');
  end if;
  if p_limit is null or p_limit not between 1 and 100
    or ((p_before_requested_at is null) <> (p_before_id is null))
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- Serialize with owner suspension/withdrawal cleanup after the canonical
  -- identity-row lock. The existing user/requested_at/id index serves this
  -- descending keyset page without an offset scan.
  perform pg_advisory_xact_lock(hashtextextended(
    'danyeodam:suspend-owner:' || v_user_id::text,
    0
  ));

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
      and (
        p_before_requested_at is null
        or (request_row.requested_at, request_row.id)
          < (p_before_requested_at, p_before_id)
      )
    order by request_row.requested_at desc, request_row.id desc
    limit p_limit
  ) as page_row;

  return jsonb_build_object('status', 'ready', 'items', v_items);
end;
$$;

revoke all on function api_private.list_own_location_corrections(
  uuid, integer, timestamptz, uuid
) from public, anon, authenticated, service_role;

grant execute on function api_private.list_own_location_corrections(
  uuid, integer, timestamptz, uuid
) to service_role;
