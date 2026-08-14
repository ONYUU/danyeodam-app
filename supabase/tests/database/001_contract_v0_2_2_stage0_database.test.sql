begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

-- Schema, event enum, and privilege boundaries ---------------------------

select has_schema('api_private', 'server-only Data API schema exists');
select has_table(
  'private',
  'personal_card_temp_uploads',
  'temp upload metadata is private'
);

select set_eq(
  $$
    select unnest(enum_range(null::analytics.event_name))::text
  $$,
  $$
    values
      ('spot_view'::text),
      ('acquire_attempt'::text),
      ('personal_card_started'::text),
      ('physical_interest_view'::text),
      ('landing_view'::text),
      ('share_view'::text),
      ('acquire_success'::text),
      ('acquire_fail'::text),
      ('personal_card_created'::text),
      ('share_created'::text),
      ('share_revoked'::text),
      ('physical_interest'::text),
      ('retro_granted'::text),
      ('revisit'::text)
  $$,
  'event enum exactly matches API-CONTRACT v0.2.2'
);

select ok(
  (
    select column_row.is_nullable = 'YES'
    from information_schema.columns as column_row
    where column_row.table_schema = 'analytics'
      and column_row.table_name = 'events'
      and column_row.column_name = 'user_id'
  ),
  'analytics user_id permits the two unauthenticated server events'
);

select is(
  (
    select count(*)::bigint
    from pg_constraint as constraint_row
    where constraint_row.conrelid = 'analytics.events'::regclass
      and constraint_row.conname in (
        'analytics_events_identity_boundary',
        'analytics_events_spot_boundary',
        'analytics_events_properties_allowlist',
        'analytics_events_no_location_keys'
      )
  ),
  4::bigint,
  'analytics identity, source, properties, and recursive privacy constraints exist'
);

select ok(
  (
    select relation_row.relrowsecurity and relation_row.relforcerowsecurity
    from pg_class as relation_row
    where relation_row.oid = 'private.personal_card_temp_uploads'::regclass
  ),
  'temp upload metadata enables and forces RLS'
);

select ok(
  has_schema_privilege('service_role', 'api_private', 'USAGE'),
  'service role can use api_private'
);
select ok(
  not has_schema_privilege('anon', 'api_private', 'USAGE'),
  'anon cannot use api_private'
);
select ok(
  not has_schema_privilege('authenticated', 'api_private', 'USAGE'),
  'authenticated cannot use api_private'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname in (
        'acquire_context',
        'acquire_commit',
        'record_acquire_failure',
        'get_published_card_asset'
      )
  ),
  4::bigint,
  'all four server RPCs exist'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname in (
        'acquire_context',
        'acquire_commit',
        'record_acquire_failure',
        'get_published_card_asset'
      )
      and has_function_privilege('service_role', function_row.oid, 'EXECUTE')
  ),
  4::bigint,
  'service role can execute every server RPC'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    cross join unnest(array['anon', 'authenticated']) as browser_role(role_name)
    where schema_row.nspname = 'api_private'
      and function_row.proname in (
        'acquire_context',
        'acquire_commit',
        'record_acquire_failure',
        'get_published_card_asset'
      )
      and has_function_privilege(
        browser_role.role_name,
        function_row.oid,
        'EXECUTE'
      )
  ),
  0::bigint,
  'browser roles cannot execute any server RPC'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname in (
        'acquire_context',
        'acquire_commit',
        'record_acquire_failure',
        'get_published_card_asset'
      )
      and function_row.prosecdef
      and coalesce(function_row.proconfig, array[]::text[])
        @> array['search_path=""']::text[]
  ),
  4::bigint,
  'all server RPCs are SECURITY DEFINER with an empty search_path'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    cross join lateral unnest(
      coalesce(function_row.proargnames, array[]::text[])
    ) as argument_name
    where schema_row.nspname = 'api_private'
      and lower(argument_name) in (
        'lat',
        'latitude',
        'lng',
        'longitude',
        'accuracy',
        'coordinates'
      )
  ),
  0::bigint,
  'server RPC signatures cannot accept device coordinates or accuracy'
);

select is(
  (
    select count(*)::bigint
    from information_schema.columns as column_row
    where column_row.table_schema in ('public', 'private', 'analytics')
      and not (
        column_row.table_schema = 'public'
        and column_row.table_name = 'spots'
      )
      and lower(column_row.column_name) in (
        'lat',
        'latitude',
        'lng',
        'longitude',
        'accuracy',
        'coordinates'
      )
  ),
  0::bigint,
  'no product table stores device coordinates or accuracy'
);

select ok(
  (
    select
      not public
      and file_size_limit = 10485760
      and allowed_mime_types @>
        array['image/png', 'image/jpeg', 'image/webp']::text[]
    from storage.buckets
    where id = 'personal-card-temp'
  ),
  'personal-card-temp is private and constrained'
);

select ok(
  (
    select
      public
      and file_size_limit = 10485760
      and allowed_mime_types @>
        array['image/png', 'image/jpeg', 'image/webp']::text[]
    from storage.buckets
    where id = 'card-assets'
  ),
  'card-assets is public content storage with constrained uploads'
);

select is(
  (
    select count(*)::bigint
    from pg_policies as policy_row
    where policy_row.schemaname = 'storage'
      and policy_row.tablename = 'objects'
      and policy_row.cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
      and (
        coalesce(policy_row.qual, '') like '%personal-card-temp%'
        or coalesce(policy_row.with_check, '') like '%personal-card-temp%'
        or coalesce(policy_row.qual, '') like '%card-assets%'
        or coalesce(policy_row.with_check, '') like '%card-assets%'
      )
  ),
  0::bigint,
  'no browser write policy exists for temp or card content buckets'
);

-- Fixtures ----------------------------------------------------------------

insert into auth.users (id, created_at, updated_at, is_anonymous)
values
  ('41000000-0000-4000-8000-000000000001', now(), now(), true),
  ('41000000-0000-4000-8000-000000000002', now(), now(), true),
  ('41000000-0000-4000-8000-000000000003', now(), now(), true),
  ('41000000-0000-4000-8000-000000000004', now(), now(), true);

insert into private.policy_documents (
  id, policy_type, version, effective_at, published_at, is_current
)
values
  ('41100000-0000-4000-8000-000000000001', 'terms_of_use', 'acquire-1', now() - interval '1 day', now(), false),
  ('41100000-0000-4000-8000-000000000002', 'privacy_policy', 'acquire-1', now() - interval '1 day', now(), false),
  ('41100000-0000-4000-8000-000000000003', 'community_guidelines', 'acquire-1', now() - interval '1 day', now(), false),
  ('41100000-0000-4000-8000-000000000004', 'location_terms', 'acquire-1', now() - interval '1 day', now(), false);

insert into private.policy_document_locales (
  policy_document_id, locale, document_url, sha256
)
select
  policy_row.id,
  locale_row.locale,
  'https://policies.test/acquire/' || policy_row.id::text || '/' || locale_row.locale::text,
  extensions.digest(policy_row.id::text || ':' || locale_row.locale::text, 'sha256')
from private.policy_documents as policy_row
cross join unnest(enum_range(null::public.content_locale)) as locale_row(locale)
where policy_row.version = 'acquire-1';

select api_private.set_current_policy_documents(array[
  '41100000-0000-4000-8000-000000000001'::uuid,
  '41100000-0000-4000-8000-000000000002'::uuid,
  '41100000-0000-4000-8000-000000000003'::uuid,
  '41100000-0000-4000-8000-000000000004'::uuid
]);

insert into private.minimum_age_attestations (
  user_id, minimum_age_passed, version
)
select identity_row.user_id, true, '18plus-v1'
from private.user_identities as identity_row
where identity_row.auth_user_id between
  '41000000-0000-4000-8000-000000000001'::uuid and
  '41000000-0000-4000-8000-000000000004'::uuid;

select api_private.accept_location_consent(
  fixture.auth_user_id,
  jsonb_build_object('version', 'acquire-1', 'locale', 'ko')
)
from (
  values
    ('41000000-0000-4000-8000-000000000001'::uuid),
    ('41000000-0000-4000-8000-000000000002'::uuid),
    ('41000000-0000-4000-8000-000000000003'::uuid),
    ('41000000-0000-4000-8000-000000000004'::uuid)
) as fixture(auth_user_id);

insert into private.participant_access (user_id, access_kind)
select identity_row.user_id, 'internal_tester'
from private.user_identities as identity_row
where identity_row.auth_user_id in (
  '41000000-0000-4000-8000-000000000001',
  '41000000-0000-4000-8000-000000000002',
  '41000000-0000-4000-8000-000000000003'
)
  and identity_row.revoked_at is null;

insert into public.regions (code, country_code, sort_order)
values ('seoul', 'KR', 1), ('busan', 'KR', 2);

insert into public.region_translations (
  region_code, locale, name, status, approved_at, approved_by
)
select
  region_row.code,
  locale_row.locale,
  initcap(region_row.code),
  'approved',
  now(),
  '41000000-0000-4000-8000-000000000001'
from public.regions as region_row
cross join unnest(enum_range(null::public.content_locale))
  as locale_row(locale)
where region_row.code in ('seoul', 'busan');

insert into public.spots (
  id,
  slug,
  region,
  name_ko,
  name_en,
  status,
  latitude,
  longitude,
  radius_m,
  accuracy_threshold_m,
  updated_at
)
values
  (
    '42000000-0000-4000-8000-000000000001',
    'contract-open-one',
    'seoul',
    '계약 공개 1',
    'Contract Open One',
    'draft',
    37.5700,
    126.9800,
    180,
    250,
    '2026-08-08 00:00:01+00'
  ),
  (
    '42000000-0000-4000-8000-000000000002',
    'contract-open-far',
    'busan',
    '계약 공개 먼 스팟',
    'Contract Open Far',
    'draft',
    35.1796,
    129.0756,
    180,
    250,
    '2026-08-08 00:00:02+00'
  ),
  (
    '42000000-0000-4000-8000-000000000003',
    'contract-paused',
    'seoul',
    '계약 중지',
    'Contract Paused',
    'paused',
    37.5800,
    126.9900,
    180,
    250,
    '2026-08-08 00:00:03+00'
  ),
  (
    '42000000-0000-4000-8000-000000000004',
    'contract-open-no-asset',
    'seoul',
    '자산 없음',
    'Open Without Asset',
    'draft',
    37.5900,
    127.0000,
    180,
    250,
    '2026-08-08 00:00:04+00'
  );

insert into public.spot_translations (
  spot_id, locale, name, status, approved_at, approved_by
)
select
  spot_row.id,
  locale_row.locale,
  case
    when locale_row.locale = 'ko' then spot_row.name_ko
    else spot_row.name_en
  end,
  'approved',
  now(),
  '41000000-0000-4000-8000-000000000001'
from public.spots as spot_row
cross join unnest(enum_range(null::public.content_locale))
  as locale_row(locale)
where spot_row.id between
  '42000000-0000-4000-8000-000000000001'::uuid and
  '42000000-0000-4000-8000-000000000004'::uuid;

insert into public.cards (
  id,
  spot_id,
  code,
  title_ko,
  title_en,
  sketch_path,
  color_hex,
  is_published,
  published_at
)
values
  (
    '43000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    'contract-card-one',
    '계약 카드 1',
    'Contract Card One',
    'region/contract-card-one.webp',
    '#112233',
    false,
    null
  ),
  (
    '43000000-0000-4000-8000-000000000002',
    '42000000-0000-4000-8000-000000000002',
    'contract-card-far',
    '계약 먼 카드',
    'Contract Card Far',
    'region/contract-card-far.webp',
    '#223344',
    false,
    null
  ),
  (
    '43000000-0000-4000-8000-000000000003',
    '42000000-0000-4000-8000-000000000003',
    'contract-card-paused',
    '계약 중지 카드',
    'Contract Card Paused',
    'region/contract-card-paused.webp',
    '#334455',
    false,
    null
  ),
  (
    '43000000-0000-4000-8000-000000000004',
    '42000000-0000-4000-8000-000000000004',
    'contract-card-no-asset',
    '자산 없는 카드',
    'Card Without Asset',
    null,
    '#445566',
    false,
    null
  );

insert into public.card_translations (
  card_id, locale, title, status, approved_at, approved_by
)
select
  card_row.id,
  locale_row.locale,
  case
    when locale_row.locale = 'ko' then card_row.title_ko
    else card_row.title_en
  end,
  'approved',
  now(),
  '41000000-0000-4000-8000-000000000001'
from public.cards as card_row
cross join unnest(enum_range(null::public.content_locale))
  as locale_row(locale)
where card_row.id between
  '43000000-0000-4000-8000-000000000001'::uuid and
  '43000000-0000-4000-8000-000000000004'::uuid;

update public.cards
set is_published = true,
    published_at = now()
where id in (
  '43000000-0000-4000-8000-000000000001',
  '43000000-0000-4000-8000-000000000002',
  '43000000-0000-4000-8000-000000000003'
);

update public.spots
set status = case
  when id in (
    '42000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000002'
  ) then 'open'::public.spot_status
  when id = '42000000-0000-4000-8000-000000000003'
    then 'paused'::public.spot_status
  else 'draft'::public.spot_status
end
where id between
  '42000000-0000-4000-8000-000000000001'::uuid and
  '42000000-0000-4000-8000-000000000004'::uuid;

-- Preserve the fixture's explicit config versions after the status transition
-- so acquire_commit stale-context assertions remain deterministic.
alter table public.spots disable trigger spots_set_updated_at;

update public.spots
set updated_at = case id
  when '42000000-0000-4000-8000-000000000001'
    then '2026-08-08 00:00:01+00'::timestamptz
  when '42000000-0000-4000-8000-000000000002'
    then '2026-08-08 00:00:02+00'::timestamptz
  when '42000000-0000-4000-8000-000000000003'
    then '2026-08-08 00:00:03+00'::timestamptz
  else '2026-08-08 00:00:04+00'::timestamptz
end
where id between
  '42000000-0000-4000-8000-000000000001'::uuid and
  '42000000-0000-4000-8000-000000000004'::uuid;

alter table public.spots enable trigger spots_set_updated_at;

-- Temp upload metadata constraints ---------------------------------------

insert into private.personal_card_temp_uploads (
  id,
  user_id,
  temp_path,
  declared_content_type,
  declared_size_bytes
)
select
  '44000000-0000-4000-8000-000000000001',
  identity_row.user_id,
  identity_row.user_id::text ||
    '/44000000-0000-4000-8000-000000000001.webp',
  'image/webp',
  4096
from private.user_identities as identity_row
where identity_row.auth_user_id =
  '41000000-0000-4000-8000-000000000001'
  and identity_row.revoked_at is null;

select is(
  (
    select promotion_expires_at - issued_at
    from private.personal_card_temp_uploads
    where id = '44000000-0000-4000-8000-000000000001'
  ),
  interval '10 minutes',
  'temp upload promotion expires exactly ten minutes after issue'
);

select is(
  (
    select signed_url_expires_at - issued_at
    from private.personal_card_temp_uploads
    where id = '44000000-0000-4000-8000-000000000001'
  ),
  interval '2 hours',
  'signed upload URL expires exactly two hours after issue'
);

select throws_ok(
  $sql$
    update private.personal_card_temp_uploads
    set temp_deleted_at = issued_at + interval '30 minutes',
        cleanup_completed_at = issued_at + interval '1 hour'
    where id = '44000000-0000-4000-8000-000000000001'
  $sql$,
  '23514',
  null,
  'final cleanup cannot be marked complete while a signed URL can re-upload'
);

select ok(
  (
    select
      index_relation.relname = 'personal_card_temp_uploads_cleanup_idx'
      and pg_get_indexdef(index_row.indexrelid)
        like '%(signed_url_expires_at)%'
      and pg_get_expr(index_row.indpred, index_row.indrelid)
        like '%cleanup_completed_at IS NULL%'
    from pg_index as index_row
    join pg_class as index_relation
      on index_relation.oid = index_row.indexrelid
    join pg_namespace as schema_row
      on schema_row.oid = index_relation.relnamespace
    where schema_row.nspname = 'private'
      and index_relation.relname =
        'personal_card_temp_uploads_cleanup_idx'
  ),
  'cleanup queue is indexed by signed URL expiry, not promotion expiry'
);

select throws_ok(
  $sql$
    insert into private.personal_card_temp_uploads (
      id,
      user_id,
      temp_path,
      declared_content_type,
      declared_size_bytes
    )
    select
      '44000000-0000-4000-8000-000000000002',
      identity_row.user_id,
      'attacker/44000000-0000-4000-8000-000000000002.jpg',
      'image/jpeg',
      4096
    from private.user_identities as identity_row
    where identity_row.auth_user_id =
      '41000000-0000-4000-8000-000000000001'
      and identity_row.revoked_at is null
  $sql$,
  '23514',
  null,
  'temp path cannot escape the logical owner and upload id'
);

select throws_ok(
  $sql$
    insert into public.cards (
      spot_id,
      code,
      title_ko,
      title_en,
      sketch_path,
      color_hex
    )
    values (
      '42000000-0000-4000-8000-000000000001',
      'unsafe-card-path',
      '위험 경로',
      'Unsafe Path',
      '../secret.webp',
      '#556677'
    )
  $sql$,
  '23514',
  null,
  'card asset paths cannot traverse directories'
);

-- Context, gate, active binding, and card asset behavior -----------------

select is(
  api_private.acquire_context_unrated(
    '41000000-0000-4000-8000-000000000004',
    '42000000-0000-4000-8000-000000000001',
    '45000000-0000-4000-8000-000000000004',
    false
  ) ->> 'code',
  'GATE_CLOSED',
  'closed gate rejects an unqualified user before acquisition checks'
);

select is(
  api_private.acquire_context_unrated(
    '41000000-0000-4000-8000-000000000004',
    '42000000-0000-4000-8000-000000000001',
    '45000000-0000-4000-8000-000000000004',
    true
  ) ->> 'status',
  'ready',
  'open public gate permits an otherwise active user'
);

select is(
  api_private.acquire_context_unrated(
    '41000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    '45000000-0000-4000-8000-000000000001',
    false
  ) ->> 'status',
  'ready',
  'qualified user receives a ready context'
);

select ok(
  (
    api_private.acquire_context_unrated(
      '41000000-0000-4000-8000-000000000001',
      '42000000-0000-4000-8000-000000000001',
      '45000000-0000-4000-8000-000000000001',
      false
    ) #>> '{spot,radius_m}'
  )::integer = 180
  and (
    api_private.acquire_context_unrated(
      '41000000-0000-4000-8000-000000000001',
      '42000000-0000-4000-8000-000000000001',
      '45000000-0000-4000-8000-000000000001',
      false
    ) #>> '{spot,accuracy_threshold_m}'
  )::integer = 250,
  'ready context contains only the server-side POI decision thresholds'
);

select ok(
  not (
    api_private.acquire_context_unrated(
      '41000000-0000-4000-8000-000000000001',
      '42000000-0000-4000-8000-000000000001',
      '45000000-0000-4000-8000-000000000001',
      false
    ) ? 'field_sequence'
  ),
  'ready context does not expose a sequence number'
);

select is(
  api_private.acquire_context_unrated(
    '41000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000003',
    '45000000-0000-4000-8000-000000000003',
    false
  ) ->> 'code',
  'SPOT_NOT_OPEN',
  'paused spot cannot produce a context'
);

select is(
  api_private.acquire_context_unrated(
    '41000000-0000-4000-8000-000000000001',
    '42999999-9999-4999-8999-999999999999',
    '45000000-0000-4000-8000-000000000099',
    false
  ) ->> 'code',
  'NOT_FOUND',
  'unknown spot is distinguished from a closed spot'
);

select is(
  api_private.acquire_context_unrated(
    '41000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000004',
    '45000000-0000-4000-8000-000000000005',
    false
  ) ->> 'code',
  'SPOT_NOT_OPEN',
  'open spot without a published asset is not acquirable'
);

select is(
  api_private.get_published_card_asset(
    '43000000-0000-4000-8000-000000000001'
  ),
  'region/contract-card-one.webp',
  'server resolves an open published card asset'
);

select is(
  api_private.get_published_card_asset(
    '43000000-0000-4000-8000-000000000003'
  ),
  null::text,
  'server does not resolve a paused spot card asset'
);

-- Atomic acquire, replay, conflict, KST, and sequence behavior ------------

select is(
  api_private.acquire_commit_unrated(
    '41000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    '45000000-0000-4000-8000-000000000001',
    false,
    '2026-08-08 00:00:01+00'
  ) ->> 'status',
  'created',
  'first valid field acquisition is created'
);

create temporary table first_acquire_response on commit drop as
select private.acquire_result(acquisition_row.id, 'created') as payload
from public.acquisitions as acquisition_row
join private.user_identities as identity_row
  on identity_row.user_id = acquisition_row.user_id
where identity_row.auth_user_id =
  '41000000-0000-4000-8000-000000000001'
  and identity_row.revoked_at is null
  and acquisition_row.idempotency_key =
    '45000000-0000-4000-8000-000000000001';

select is(
  api_private.acquire_context_unrated(
    '41000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    '45000000-0000-4000-8000-000000000001',
    false
  ) ->> 'status',
  'replay',
  'context replays the first successful logical attempt'
);

select ok(
  not (
    api_private.acquire_commit_unrated(
      '41000000-0000-4000-8000-000000000001',
      '42000000-0000-4000-8000-000000000001',
      '45000000-0000-4000-8000-000000000001',
      false,
      '2026-08-08 00:00:01+00'
    ) #> '{acquisition}' ? 'field_sequence'
  ),
  'replay payload never exposes field_sequence'
);

select is(
  api_private.acquire_commit_unrated(
    '41000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000002',
    '45000000-0000-4000-8000-000000000001',
    false,
    '2026-08-08 00:00:02+00'
  ) ->> 'code',
  'IDEMPOTENCY_CONFLICT',
  'successful key cannot be rebound to another spot'
);

do $fixture$
begin
  perform api_private.acquire_context_unrated(
    '41000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    '45000000-0000-4000-8000-000000000011',
    false
  );
end;
$fixture$;

select is(
  api_private.acquire_commit_unrated(
    '41000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    '45000000-0000-4000-8000-000000000011',
    false,
    '2026-08-08 00:00:01+00'
  ) ->> 'code',
  'ALREADY_ACQUIRED_TODAY',
  'same user and spot cannot acquire twice on the current KST day'
);

select is(
  (
    select counter_row.last_sequence
    from private.card_counters as counter_row
    where counter_row.card_id =
      '43000000-0000-4000-8000-000000000001'
  ),
  1::bigint,
  'daily-limit failure does not consume a card sequence'
);

do $fixture$
begin
  perform api_private.acquire_context_unrated(
    '41000000-0000-4000-8000-000000000002',
    '42000000-0000-4000-8000-000000000001',
    '45000000-0000-4000-8000-000000000002',
    false
  );
end;
$fixture$;

select is(
  api_private.acquire_commit_unrated(
    '41000000-0000-4000-8000-000000000002',
    '42000000-0000-4000-8000-000000000001',
    '45000000-0000-4000-8000-000000000002',
    false,
    '2026-08-08 00:00:01+00'
  ) ->> 'status',
  'created',
  'another qualified user can acquire the same card'
);

select results_eq(
  $$
    select acquisition_row.field_sequence
    from public.acquisitions as acquisition_row
    where acquisition_row.card_id =
      '43000000-0000-4000-8000-000000000001'
    order by acquisition_row.field_sequence
  $$,
  $$ values (1::bigint), (2::bigint) $$,
  'committed field sequence has no gap after a rejected attempt'
);

select is(
  (
    select count(*)::bigint
    from analytics.events as event_row
    where event_row.event_name = 'acquire_success'
      and event_row.spot_id =
        '42000000-0000-4000-8000-000000000001'
  ),
  2::bigint,
  'each newly committed acquisition creates one server success fact'
);

select throws_ok(
  $sql$
    update public.cards
    set title_ko = '기존 획득 응답을 변경하는 제목'
    where id = '43000000-0000-4000-8000-000000000001'
  $sql$,
  '23514',
  'acquired card response metadata is immutable; create a new card version',
  'acquired card response metadata requires a new card version'
);

update public.spots
set status = 'paused'
where id = '42000000-0000-4000-8000-000000000001';

update public.cards
set is_published = false
where id = '43000000-0000-4000-8000-000000000001';

select is(
  (
    api_private.acquire_commit_unrated(
      '41000000-0000-4000-8000-000000000001',
      '42000000-0000-4000-8000-000000000001',
      '45000000-0000-4000-8000-000000000001',
      false,
      '2026-08-08 00:00:01+00'
    ) - 'status'
  ),
  (
    select response_row.payload - 'status'
    from first_acquire_response as response_row
  ),
  'replay reproduces the first acquisition and card payload after retirement'
);

select is(
  api_private.get_published_card_asset(
    '43000000-0000-4000-8000-000000000001'
  ),
  'region/contract-card-one.webp',
  'an acquired card asset remains retrievable after pause and unpublish'
);

select ok(
  not exists (
    select 1
    from public.acquisitions as acquisition_row
    where acquisition_row.acquired_on_kst <>
      (acquisition_row.acquired_at at time zone 'Asia/Seoul')::date
      and acquisition_row.card_id in (
        '43000000-0000-4000-8000-000000000001',
        '43000000-0000-4000-8000-000000000002'
      )
  ),
  'RPC acquisitions derive their calendar day in Asia/Seoul'
);

do $fixture$
begin
  perform api_private.acquire_context_unrated(
    '41000000-0000-4000-8000-000000000003',
    '42000000-0000-4000-8000-000000000002',
    '45000000-0000-4000-8000-000000000013',
    false
  );
end;
$fixture$;

select is(
  api_private.acquire_commit_unrated(
    '41000000-0000-4000-8000-000000000003',
    '42000000-0000-4000-8000-000000000002',
    '45000000-0000-4000-8000-000000000013',
    false,
    '2026-08-07 23:59:59+00'
  ) ->> 'code',
  'SPOT_CONFIG_CHANGED',
  'commit rejects a stale spot decision context'
);

select is(
  (
    select count(*)::bigint
    from public.acquisitions as acquisition_row
    join private.user_identities as identity_row
      on identity_row.user_id = acquisition_row.user_id
    where identity_row.auth_user_id =
      '41000000-0000-4000-8000-000000000003'
  ),
  0::bigint,
  'stale context cannot create an acquisition'
);

do $fixture$
begin
  perform api_private.acquire_context_unrated(
    '41000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000002',
    '45000000-0000-4000-8000-000000000012',
    false
  );
end;
$fixture$;

select is(
  api_private.acquire_commit_unrated(
    '41000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000002',
    '45000000-0000-4000-8000-000000000012',
    false,
    '2026-08-08 00:00:02+00'
  ) ->> 'status',
  'created',
  'same user may acquire a different spot on the same KST day'
);

select ok(
  (
    select acquisition_row.implausible_transition
    from public.acquisitions as acquisition_row
    where acquisition_row.user_id = (
      select identity_row.user_id
      from private.user_identities as identity_row
      where identity_row.auth_user_id =
        '41000000-0000-4000-8000-000000000001'
        and identity_row.revoked_at is null
    )
      and acquisition_row.spot_id =
        '42000000-0000-4000-8000-000000000002'
  ),
  'far POI-to-POI jump creates only the derived diagnostic flag'
);

select ok(
  pg_get_functiondef(
    'api_private.acquire_commit_after_location_compliance(uuid,uuid,uuid,boolean,timestamptz)'::regprocedure
  ) like '%pg_advisory_xact_lock%'
  and pg_get_functiondef(
    'api_private.acquire_commit_after_location_compliance(uuid,uuid,uuid,boolean,timestamptz)'::regprocedure
  ) like '%exception%unique_violation%',
  'commit function includes transaction locks and rollback reconciliation'
);

-- Server failure event writer --------------------------------------------

select ok(
  to_regprocedure(
    'api_private.record_acquire_failure(uuid,uuid,uuid,text,jsonb,uuid)'
  ) is not null,
  'server exposes the terminal acquisition failure transition'
);

select ok(
  pg_get_functiondef(
    'api_private.record_acquire_failure_unrated(uuid,uuid,uuid,text,jsonb)'::regprocedure
  ) like '%location_use_fact_id%',
  'failure transition correlates the terminal event to one exact fact'
);

select throws_ok(
  $sql$
    select api_private.record_acquire_failure_unrated(
      '41000000-0000-4000-8000-000000000001',
      '42000000-0000-4000-8000-000000000001',
      '45000000-0000-4000-8000-000000000091',
      'INTERNAL',
      '{}'::jsonb
    )
  $sql$,
  '22023',
  'unsupported acquire failure code',
  'failure writer rejects codes outside the five-value contract'
);

update private.user_identities
set revoked_at = now()
where auth_user_id = '41000000-0000-4000-8000-000000000004'
  and revoked_at is null;

select is(
  api_private.acquire_context_unrated(
    '41000000-0000-4000-8000-000000000004',
    '42000000-0000-4000-8000-000000000001',
    '45000000-0000-4000-8000-000000000014',
    true
  ) ->> 'code',
  'UNAUTHORIZED',
  'revoked service binding is rejected even while the JWT may remain valid'
);

-- Strict event/source/user/client-id/property boundaries -----------------

insert into analytics.events (
  user_id,
  event_name,
  source,
  occurred_at,
  spot_id,
  properties
)
values (
  null,
  'landing_view',
  'server',
  now(),
  null,
  '{"ref":"direct"}'
);

select throws_ok(
  $sql$
    insert into analytics.events (
      user_id,
      event_name,
      source,
      occurred_at,
      properties
    )
    values (
      null,
      'share_view',
      'server',
      now(),
      '{}'::jsonb
    )
  $sql$,
  '23514',
  null,
  'share_view requires a resolved personal-card id'
);

select throws_ok(
  $sql$
    insert into analytics.events (
      user_id,
      event_name,
      source,
      occurred_at,
      properties
    )
    select
      identity_row.user_id,
      'landing_view',
      'server',
      now(),
      '{"ref":"direct"}'
    from private.user_identities as identity_row
    where identity_row.auth_user_id =
      '41000000-0000-4000-8000-000000000001'
      and identity_row.revoked_at is null
  $sql$,
  '23514',
  null,
  'landing_view cannot carry a user id'
);

insert into analytics.events (
  client_event_id,
  user_id,
  event_name,
  source,
  occurred_at,
  spot_id,
  properties
)
select
  '46000000-0000-4000-8000-000000000001',
  identity_row.user_id,
  'spot_view',
  'client',
  now(),
  '42000000-0000-4000-8000-000000000001',
  '{"spot_id":"42000000-0000-4000-8000-000000000001"}'
from private.user_identities as identity_row
where identity_row.auth_user_id =
  '41000000-0000-4000-8000-000000000001'
  and identity_row.revoked_at is null;

select throws_ok(
  $sql$
    insert into analytics.events (
      client_event_id,
      user_id,
      event_name,
      source,
      occurred_at,
      spot_id,
      properties
    )
    select
      '46000000-0000-4000-8000-000000000001',
      identity_row.user_id,
      'spot_view',
      'client',
      now(),
      '42000000-0000-4000-8000-000000000001',
      '{"spot_id":"42000000-0000-4000-8000-000000000001"}'
    from private.user_identities as identity_row
    where identity_row.auth_user_id =
      '41000000-0000-4000-8000-000000000001'
      and identity_row.revoked_at is null
  $sql$,
  '23505',
  null,
  'client event id deduplicates per logical user'
);

select throws_ok(
  $sql$
    insert into analytics.events (
      user_id,
      event_name,
      source,
      occurred_at,
      spot_id,
      properties
    )
    select
      identity_row.user_id,
      'acquire_attempt',
      'client',
      now(),
      '42000000-0000-4000-8000-000000000001',
      '{"spot_id":"42000000-0000-4000-8000-000000000001"}'
    from private.user_identities as identity_row
    where identity_row.auth_user_id =
      '41000000-0000-4000-8000-000000000001'
      and identity_row.revoked_at is null
  $sql$,
  '23514',
  null,
  'client-created event requires client_event_id'
);

select throws_ok(
  $sql$
    insert into analytics.events (
      client_event_id,
      user_id,
      event_name,
      source,
      occurred_at,
      spot_id,
      properties
    )
    select
      '46000000-0000-4000-8000-000000000002',
      identity_row.user_id,
      'acquire_success',
      'client',
      now(),
      '42000000-0000-4000-8000-000000000001',
      '{"spot_id":"42000000-0000-4000-8000-000000000001"}'
    from private.user_identities as identity_row
    where identity_row.auth_user_id =
      '41000000-0000-4000-8000-000000000001'
      and identity_row.revoked_at is null
  $sql$,
  '23514',
  null,
  'client cannot forge a server success fact'
);

select throws_ok(
  $sql$
    insert into analytics.events (
      client_event_id,
      user_id,
      event_name,
      source,
      occurred_at,
      spot_id,
      properties
    )
    select
      '46000000-0000-4000-8000-000000000003',
      identity_row.user_id,
      'personal_card_started',
      'client',
      now(),
      '42000000-0000-4000-8000-000000000001',
      '{"spot_id":"42000000-0000-4000-8000-000000000001","extra":true}'
    from private.user_identities as identity_row
    where identity_row.auth_user_id =
      '41000000-0000-4000-8000-000000000001'
      and identity_row.revoked_at is null
  $sql$,
  '23514',
  null,
  'event properties reject keys outside the exact allowlist'
);

select throws_ok(
  $sql$
    insert into analytics.events (
      user_id,
      event_name,
      source,
      occurred_at,
      properties
    )
    select
      identity_row.user_id,
      'acquire_fail',
      'server',
      now(),
      '{"code":"INTERNAL"}'
    from private.user_identities as identity_row
    where identity_row.auth_user_id =
      '41000000-0000-4000-8000-000000000001'
      and identity_row.revoked_at is null
  $sql$,
  '23514',
  null,
  'acquire_fail rejects codes outside the five-value enum'
);

select throws_ok(
  $sql$
    insert into analytics.events (
      client_event_id,
      user_id,
      event_name,
      source,
      occurred_at,
      spot_id,
      properties
    )
    select
      '46000000-0000-4000-8000-000000000004',
      identity_row.user_id,
      'spot_view',
      'client',
      now(),
      '42000000-0000-4000-8000-000000000001',
      '{"spot_id":"42000000-0000-4000-8000-000000000001","nested":{"Accuracy":5}}'
    from private.user_identities as identity_row
    where identity_row.auth_user_id =
      '41000000-0000-4000-8000-000000000001'
      and identity_row.revoked_at is null
  $sql$,
  '23514',
  null,
  'recursive location-key denial remains active'
);

select lives_ok(
  $sql$
    insert into analytics.events (
      client_event_id,
      user_id,
      event_name,
      source,
      occurred_at,
      properties
    )
    select
      '46000000-0000-4000-8000-000000000005',
      identity_row.user_id,
      'physical_interest_view',
      'client',
      now(),
      '{}'
    from private.user_identities as identity_row
    where identity_row.auth_user_id =
      '41000000-0000-4000-8000-000000000001'
      and identity_row.revoked_at is null
  $sql$,
  'empty props are valid for physical_interest_view'
);

select throws_ok(
  $sql$
    insert into analytics.events (
      user_id,
      event_name,
      source,
      occurred_at,
      properties
    )
    values (
      null,
      'share_created',
      'server',
      now(),
      '{}'
    )
  $sql$,
  '23514',
  null,
  'authenticated server facts require user_id'
);

select * from finish();
rollback;
