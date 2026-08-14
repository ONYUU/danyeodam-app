begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

-- Server-only schema -----------------------------------------------------

select is(
  (
    select count(*)::bigint
    from pg_class as relation_row
    join pg_namespace as schema_row
      on schema_row.oid = relation_row.relnamespace
    where schema_row.nspname = 'private'
      and relation_row.relname in (
        'account_deletion_jobs',
        'account_deletion_storage_manifest',
        'account_deletion_auth_manifest',
        'account_deletion_rate_limits',
        'account_deletion_storage_tombstone_key',
        'account_deletion_storage_prefix_tombstones',
        'personal_card_storage_object_tombstones',
        'account_deletion_admin_actions',
        'personal_card_permanent_object_ledger'
      )
      and relation_row.relrowsecurity
      and relation_row.relforcerowsecurity
  ),
  9::bigint,
  'all account-deletion and permanent-cleanup tables enable and force RLS'
);

select is(
  (
    select count(*)::bigint
    from information_schema.role_table_grants as grant_row
    where grant_row.table_schema = 'private'
      and grant_row.table_name in (
        'account_deletion_jobs',
        'account_deletion_storage_manifest',
        'account_deletion_auth_manifest',
        'account_deletion_rate_limits',
        'account_deletion_storage_tombstone_key',
        'account_deletion_storage_prefix_tombstones',
        'personal_card_storage_object_tombstones',
        'account_deletion_admin_actions',
        'personal_card_permanent_object_ledger'
      )
      and grant_row.grantee in ('anon', 'authenticated', 'service_role')
  ),
  0::bigint,
  'Data API roles have no direct deletion-table privileges'
);

select ok(
  has_function_privilege(
    'service_role',
    'api_private.claim_personal_card_storage_cleanup(uuid,integer)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'api_private.record_personal_card_storage_cleanup_result(uuid,text,uuid,bigint,text,boolean)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'api_private.get_personal_card_storage_cleanup_backlog()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'api_private.claim_personal_card_storage_cleanup(uuid,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'api_private.claim_personal_card_storage_cleanup(uuid,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'api_private.claim_personal_card_field_object_cleanup_before_exact_tombstone(uuid,integer)',
    'EXECUTE'
  ),
  'only service-role cleanup wrappers expose the unified and field queues'
);

select ok(
  exists (
    select 1
    from pg_trigger as trigger_row
    where trigger_row.tgrelid = 'private.data_erasure_manifest'::regclass
      and trigger_row.tgname = 'data_erasure_manifest_tombstone_object'
      and not trigger_row.tgisinternal
  )
  and exists (
    select 1
    from pg_trigger as trigger_row
    where trigger_row.tgrelid =
      'private.personal_card_field_object_ledger'::regclass
      and trigger_row.tgname = 'personal_card_field_ledger_claim_tombstone'
      and not trigger_row.tgisinternal
  ),
  'location manifests and legacy field claims install exact-path tombstones'
);

select is(
  (
    select count(*)::bigint
    from pg_proc as function_row
    join pg_namespace as schema_row
      on schema_row.oid = function_row.pronamespace
    where schema_row.nspname = 'api_private'
      and function_row.proname in (
        'request_account_deletion',
        'request_account_deletion_by_recovery',
        'consume_account_deletion_public_rate_limit',
        'get_account_deletion_status_candidate',
        'claim_account_deletion_jobs',
        'register_account_deletion_storage_paths',
        'record_account_deletion_storage_result',
        'mark_account_deletion_auth_removed',
        'advance_account_deletion_job',
        'fail_account_deletion_job',
        'get_account_deletion_backlog',
        'get_account_deletion_backlog_admin',
        'list_account_deletion_jobs_admin',
        'retry_account_deletion_job_admin'
      )
      and function_row.prosecdef
      and coalesce(function_row.proconfig, array[]::text[])
        @> array['search_path=""']::text[]
      and has_function_privilege('service_role', function_row.oid, 'EXECUTE')
      and not has_function_privilege('anon', function_row.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', function_row.oid, 'EXECUTE')
      and not exists (
        select 1
        from information_schema.routine_privileges as privilege_row
        where privilege_row.specific_schema = 'api_private'
          and privilege_row.routine_name = function_row.proname
          and privilege_row.grantee = 'PUBLIC'
          and privilege_row.privilege_type = 'EXECUTE'
      )
  ),
  14::bigint,
  'every account-deletion RPC is hardened and service-role-only'
);

select is(
  (
    select count(*)::bigint
    from information_schema.columns as column_row
    where column_row.table_schema = 'private'
      and column_row.table_name like 'account_deletion%'
      and lower(column_row.column_name) in (
        'email', 'status_token', 'recovery_code', 'ip', 'user_agent'
      )
  ),
  0::bigint,
  'no deletion table stores plaintext status/recovery tokens or contact data'
);

select is(
  (
    select count(*)::bigint
    from pg_constraint as constraint_row
    where constraint_row.conrelid =
      'private.account_deletion_admin_actions'::regclass
      and constraint_row.contype = 'f'
      and constraint_row.confdeltype = 'c'
  ),
  2::bigint,
  'administrator retry audits expire only with the request receipt or administrator account'
);

-- Full deletion fixture -------------------------------------------------

insert into auth.users (
  id, created_at, updated_at, is_anonymous, raw_user_meta_data
) values
  (
    'e0000000-0000-4000-8000-000000000001',
    now(), now(), false, '{}'::jsonb
  ),
  (
    'e0000000-0000-4000-8000-000000000002',
    now(), now(), true, '{}'::jsonb
  ),
  (
    'e0000000-0000-4000-8000-000000000003',
    now(), now(), true, '{}'::jsonb
  );

create temp table test_account_deletion_users (
  role text primary key,
  user_id uuid not null
) on commit drop;

insert into test_account_deletion_users (role, user_id)
select 'subject', identity_row.user_id
from private.user_identities as identity_row
where identity_row.auth_user_id =
  'e0000000-0000-4000-8000-000000000001'::uuid
  and identity_row.revoked_at is null
union all
select 'historical_generated', identity_row.user_id
from private.user_identities as identity_row
where identity_row.auth_user_id =
  'e0000000-0000-4000-8000-000000000002'::uuid
  and identity_row.revoked_at is null
union all
select 'moved_owner', identity_row.user_id
from private.user_identities as identity_row
where identity_row.auth_user_id =
  'e0000000-0000-4000-8000-000000000003'::uuid
  and identity_row.revoked_at is null;

-- Historical Auth 2 belongs only to the subject and must be deleted.
update private.user_identities
set revoked_at = clock_timestamp()
where auth_user_id = 'e0000000-0000-4000-8000-000000000002'::uuid
  and revoked_at is null;

insert into private.user_identities (
  auth_user_id, user_id, bound_at, revoked_at
)
select
  'e0000000-0000-4000-8000-000000000002',
  fixture.user_id,
  now() - interval '3 days',
  now() - interval '2 days'
from test_account_deletion_users as fixture
where fixture.role = 'subject';

-- Auth 3 once belonged to the subject but is currently bound to another
-- logical user. The account deletion Auth manifest must not capture it.
insert into private.user_identities (
  auth_user_id, user_id, bound_at, revoked_at
)
select
  'e0000000-0000-4000-8000-000000000003',
  fixture.user_id,
  now() - interval '4 days',
  now() - interval '3 days'
from test_account_deletion_users as fixture
where fixture.role = 'subject';

insert into private.participant_access (user_id, access_kind)
select user_id, 'internal_tester'
from test_account_deletion_users
where role = 'subject';

insert into private.policy_documents (
  id, policy_type, version, effective_at, published_at, is_current
)
values
  (
    'e7000000-0000-4000-8000-000000000001',
    'terms_of_use', 'account-delete-v1', now() - interval '1 minute', now(), false
  ),
  (
    'e7000000-0000-4000-8000-000000000002',
    'privacy_policy', 'account-delete-v1', now() - interval '1 minute', now(), false
  ),
  (
    'e7000000-0000-4000-8000-000000000003',
    'community_guidelines', 'account-delete-v1', now() - interval '1 minute', now(), false
  ),
  (
    'e7000000-0000-4000-8000-000000000004',
    'location_terms', 'account-delete-v1', now() - interval '1 minute', now(), false
  );

insert into private.policy_document_locales (
  policy_document_id, locale, document_url, sha256
)
select
  policy_row.id,
  locale_row.locale,
  'https://policies.test/account-delete/' || policy_row.id::text || '/'
    || locale_row.locale::text,
  extensions.digest(policy_row.id::text || ':' || locale_row.locale::text, 'sha256')
from private.policy_documents as policy_row
cross join unnest(enum_range(null::public.content_locale)) as locale_row(locale)
where policy_row.version = 'account-delete-v1';

select is(
  api_private.set_current_policy_documents(array[
    'e7000000-0000-4000-8000-000000000001'::uuid,
    'e7000000-0000-4000-8000-000000000002'::uuid,
    'e7000000-0000-4000-8000-000000000003'::uuid,
    'e7000000-0000-4000-8000-000000000004'::uuid
  ]),
  '{"status":"switched"}'::jsonb,
  'the deletion fixture installs a complete current policy set'
);

select is(
  api_private.record_minimum_age_attestation(
    'e0000000-0000-4000-8000-000000000001',
    '{"minimum_age_passed":true,"version":"18plus-v1"}'::jsonb
  ),
  '{"status":"attested"}'::jsonb,
  'the field deletion fixture records the required adult attestation'
);

select is(
  api_private.accept_location_consent(
    'e0000000-0000-4000-8000-000000000001',
    '{"version":"account-delete-v1","locale":"ko"}'::jsonb
  ),
  '{"status":"active"}'::jsonb,
  'the field deletion fixture records current location consent'
);

select is(
  api_private.accept_current_policies(
    'e0000000-0000-4000-8000-000000000001',
    jsonb_build_array(
      jsonb_build_object(
        'type', 'terms_of_use', 'version', 'account-delete-v1', 'locale', 'ko'
      ),
      jsonb_build_object(
        'type', 'community_guidelines', 'version', 'account-delete-v1', 'locale', 'ko'
      )
    )
  ),
  '{"status":"accepted"}'::jsonb,
  'the pending-share deletion fixture records immutable policy snapshots'
);

insert into private.recovery_codes (user_id, code_hash)
select user_id, decode(repeat('c1', 32), 'hex')
from test_account_deletion_users
where role = 'subject';

insert into private.participant_invite_codes (
  code_hash, redeemed_at, redeemed_by_user_id
)
select decode(repeat('d1', 32), 'hex'), now(), user_id
from test_account_deletion_users
where role = 'subject';

insert into public.regions (code, country_code, sort_order)
values ('account-delete-test', 'KR', 0);

insert into public.spots (
  id, slug, region, name_ko, name_en, status, latitude, longitude
) values (
  'e1000000-0000-4000-8000-000000000001',
  'account-deletion-test',
  'account-delete-test',
  '삭제 테스트',
  'Deletion test',
  'draft',
  37.5,
  127.0
);

insert into public.cards (
  id, spot_id, code, kind, title_ko, title_en, sketch_path, color_hex
) values (
  'e2000000-0000-4000-8000-000000000001',
  'e1000000-0000-4000-8000-000000000001',
  'account-deletion-card',
  'special',
  '삭제 테스트 카드',
  'Deletion test card',
  'cards/account-deletion-test.webp',
  '#204030'
);

insert into public.card_translations (
  card_id, locale, title, status, approved_at, approved_by
)
select
  'e2000000-0000-4000-8000-000000000001'::uuid,
  locale_name::public.content_locale,
  'Deletion test ' || locale_name,
  'approved',
  now(),
  'e0000000-0000-4000-8000-000000000001'::uuid
from unnest(array['ko', 'en', 'ja', 'zh-Hans', 'zh-Hant', 'vi'])
  as locale_name;

update public.cards
set is_published = true,
    published_at = now()
where id = 'e2000000-0000-4000-8000-000000000001'::uuid;

insert into private.location_use_facts (
  user_id, idempotency_key, spot_id, purpose
)
select
  user_id,
  'e4000000-0000-4000-8000-000000000001',
  'e1000000-0000-4000-8000-000000000001',
  'field_acquisition'
from test_account_deletion_users
where role = 'subject';

insert into public.acquisitions (
  id, user_id, spot_id, card_id, acquisition_type,
  verification_result, idempotency_key, field_sequence
)
select
  'e3000000-0000-4000-8000-000000000001',
  user_id,
  'e1000000-0000-4000-8000-000000000001',
  'e2000000-0000-4000-8000-000000000001',
  'field',
  'passed',
  'e4000000-0000-4000-8000-000000000001',
  1
from test_account_deletion_users
where role = 'subject';

update private.location_use_facts
set outcome = 'passed', decided_at = clock_timestamp()
where idempotency_key = 'e4000000-0000-4000-8000-000000000001'::uuid;

insert into private.personal_card_temp_uploads (
  id,
  user_id,
  temp_path,
  declared_content_type,
  declared_size_bytes,
  issued_at,
  promotion_expires_at,
  signed_url_expires_at,
  processing_token,
  processing_started_at,
  processing_expires_at,
  processing_acquisition_id,
  processing_permanent_path,
  processing_caption
)
select
  'e6000000-0000-4000-8000-000000000001',
  user_id,
  user_id::text || '/e6000000-0000-4000-8000-000000000001.jpg',
  'image/jpeg',
  1024,
  now() - interval '1 minute',
  now() + interval '9 minutes',
  now() + interval '1 hour 59 minutes',
  'e6100000-0000-4000-8000-000000000001',
  now(),
  now() + interval '5 minutes',
  'e3000000-0000-4000-8000-000000000001',
  user_id::text || '/e6100000-0000-4000-8000-000000000001.webp',
  '삭제 예정'
from test_account_deletion_users
where role = 'subject';

-- Exercise the pre-cutover UPDATE compatibility trigger that registers both
-- field Storage paths before the account-deletion migration transfers them.
update private.personal_card_temp_uploads
set processing_token = processing_token
where id = 'e6000000-0000-4000-8000-000000000001'::uuid;

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
  share_community_acceptance_id
)
select
  'e5000000-0000-4000-8000-000000000001',
  user_id,
  'e3000000-0000-4000-8000-000000000001',
  user_id::text || '/e6100000-0000-4000-8000-000000000001.webp',
  'deleted caption',
  'PendingDeletionShareSecret12',
  now(),
  'pending',
  now(),
  private.user_current_policy_acceptance_id(user_id, 'terms_of_use'),
  private.user_current_policy_acceptance_id(user_id, 'community_guidelines')
from test_account_deletion_users
where role = 'subject';

insert into private.content_reports (
  id,
  client_report_id,
  personal_card_id,
  owner_user_id,
  share_secret_hash,
  target,
  reason
)
select
  'e5100000-0000-4000-8000-000000000001',
  'e5200000-0000-4000-8000-000000000001',
  'e5000000-0000-4000-8000-000000000001',
  user_id,
  decode(repeat('a5', 32), 'hex'),
  'content',
  'spam'
from test_account_deletion_users
where role = 'subject';

insert into private.moderation_actions (
  admin_auth_user_id,
  client_action_id,
  personal_card_id,
  owner_user_id,
  action,
  previous_state,
  resulting_state,
  reason_code,
  note
)
select
  'e0000000-0000-4000-8000-000000000001',
  'e5300000-0000-4000-8000-000000000001',
  'e5000000-0000-4000-8000-000000000001',
  user_id,
  'take_down',
  'pending',
  'taken_down',
  'ACCOUNT_DELETE_TEST',
  'immutable audit fixture'
from test_account_deletion_users
where role = 'subject';

insert into private.data_erasure_jobs (
  id, user_id, scope, state, requested_at, next_attempt_at
)
select
  'e6200000-0000-4000-8000-000000000001',
  user_id,
  'location_withdrawal',
  'storage_pending',
  now(),
  now()
from test_account_deletion_users
where role = 'subject';

insert into private.data_erasure_manifest (
  job_id, bucket, object_path, final_delete_after
)
select
  'e6200000-0000-4000-8000-000000000001',
  'personal-cards',
  user_id::text || '/e6100000-0000-4000-8000-000000000001.webp',
  now() + interval '3 hours'
from test_account_deletion_users
where role = 'subject';

select is(
  (
    select count(*)::bigint
    from private.personal_card_storage_object_tombstones as tombstone_row
    join test_account_deletion_users as fixture
      on fixture.role = 'subject'
     and tombstone_row.object_hash = private.personal_card_storage_object_hash(
       'personal-cards',
       fixture.user_id::text || '/e6100000-0000-4000-8000-000000000001.webp'
     )
  ),
  1::bigint,
  'location erasure snapshots close each exact path before external deletion'
);

select throws_ok(
  format(
    $sql$
      insert into storage.objects (bucket_id, name, owner, version)
      values ('personal-cards', %L, null, 'late-location-erasure-upload')
    $sql$,
    (
      select user_id::text || '/e6100000-0000-4000-8000-000000000001.webp'
      from test_account_deletion_users
      where role = 'subject'
    )
  ),
  '23514',
  'cleaned personal-card Storage object is closed',
  'a location-erasure path cannot be recreated after its snapshot commits'
);

select throws_ok(
  format(
    $sql$
      insert into private.personal_card_permanent_object_ledger (
        user_id, processing_token, object_path, origin, reserved_bytes,
        final_delete_not_before, next_attempt_at
      ) values (
        %L, 'e6100000-0000-4000-8000-000000000001', %L,
        'legacy_orphan', 5242880, clock_timestamp(), clock_timestamp()
      )
    $sql$,
    (select user_id from test_account_deletion_users where role = 'subject'),
    (select user_id::text from test_account_deletion_users where role = 'subject')
      || '/e6100000-0000-4000-8000-000000000001.webp'
  ),
  '23514',
  'personal-card object cannot have field and generic ledger owners',
  'field and generic reconcilers can never own the same permanent path'
);

insert into private.personal_card_permanent_object_ledger (
  user_id, processing_token, object_path, origin, reserved_bytes,
  final_delete_not_before, next_attempt_at
)
select
  user_id,
  'e6110000-0000-4000-8000-000000000001',
  user_id::text || '/e6110000-0000-4000-8000-000000000001.webp',
  'legacy_orphan',
  2048,
  now() + interval '45 minutes',
  now()
from test_account_deletion_users
where role = 'subject';

select is(
  api_private.request_account_deletion(
    'e0000000-0000-4000-8000-000000000001',
    'e7000000-0000-4000-8000-000000000001',
    repeat('a1', 32)
  ) ->> 'status',
  'accepted',
  'active user can request deletion without an age attestation'
);

select throws_ok(
  $$
    update private.moderation_actions
    set note = 'attempted audit rewrite'
    where client_action_id =
      'e5300000-0000-4000-8000-000000000001'
  $$,
  '23514',
  'moderation actions are append-only',
  'account deletion does not permit ordinary moderation audit rewrites'
);

select throws_ok(
  $$
    delete from private.moderation_actions
    where client_action_id =
      'e5300000-0000-4000-8000-000000000001'
  $$,
  '23514',
  'moderation actions are append-only',
  'account deletion keeps moderation audit deletion forbidden'
);

select is(
  (
    select count(*)::bigint
    from private.user_identities as identity_row
    join test_account_deletion_users as fixture
      on fixture.user_id = identity_row.user_id
     and fixture.role = 'subject'
    where identity_row.revoked_at is null
  ),
  0::bigint,
  'request atomically revokes every active service identity'
);

select is(
  (
    select count(*)::bigint
    from public.personal_cards as card_row
    join test_account_deletion_users as fixture
      on fixture.user_id = card_row.user_id
     and fixture.role = 'subject'
    where card_row.share_slug is not null
       or card_row.share_state <> 'private'
  ),
  0::bigint,
  'request atomically makes every owned share private and secretless'
);

select is(
  (
    select count(*)::bigint
    from private.account_deletion_auth_manifest
    where request_id = 'e7000000-0000-4000-8000-000000000001'
  ),
  2::bigint,
  'Auth manifest includes current and unbound historical UIDs only'
);

select ok(
  not exists (
    select 1
    from private.account_deletion_auth_manifest
    where request_id = 'e7000000-0000-4000-8000-000000000001'
      and auth_user_id = 'e0000000-0000-4000-8000-000000000003'
  ),
  'an Auth UID currently rebound to another logical user is never deleted'
);

select ok(
  exists (
    select 1
    from private.account_deletion_storage_manifest as item_row
    where item_row.request_id = 'e7000000-0000-4000-8000-000000000001'
      and item_row.bucket = 'personal-cards'
      and item_row.final_delete_after >= now() + interval '2 hours 50 minutes'
  ),
  'account manifest supersedes location and field-ledger deletion windows'
);

select ok(
  exists (
    select 1
    from private.account_deletion_storage_manifest as item_row
    join test_account_deletion_users as fixture
      on fixture.role = 'subject'
    where item_row.request_id = 'e7000000-0000-4000-8000-000000000001'
      and item_row.bucket = 'personal-cards'
      and item_row.object_path = fixture.user_id::text
        || '/e6110000-0000-4000-8000-000000000001.webp'
      and item_row.final_delete_after >= now() + interval '35 minutes'
  )
  and not exists (
    select 1
    from private.personal_card_permanent_object_ledger as ledger_row
    join test_account_deletion_users as fixture
      on fixture.role = 'subject'
     and fixture.user_id = ledger_row.user_id
  )
  and not exists (
    select 1
    from private.personal_card_field_object_ledger as ledger_row
    join test_account_deletion_users as fixture
      on fixture.role = 'subject'
     and fixture.user_id = ledger_row.user_id
  ),
  'account deletion atomically transfers both reconciliation ledgers to its manifest'
);

select is(
  (
    select count(*)::bigint
    from private.data_erasure_jobs
    where id = 'e6200000-0000-4000-8000-000000000001'
  ),
  0::bigint,
  'account request supersedes the existing location erasure state machine'
);

select is(
  (
    select count(*)::bigint
    from private.account_deletion_storage_prefix_tombstones as tombstone_row
    join test_account_deletion_users as fixture
      on fixture.role = 'subject'
     and tombstone_row.prefix_hash = extensions.hmac(
       convert_to(
         'danyeodam:account-delete-storage-prefix:v1:' || fixture.user_id::text,
         'UTF8'
       ),
       (
         select key_row.secret
         from private.account_deletion_storage_tombstone_key as key_row
         where key_row.singleton
       ),
       'sha256'
     )
  ),
  1::bigint,
  'request records one irreversible digest-only Storage prefix tombstone'
);

select throws_ok(
  format(
    $sql$
      insert into storage.objects (bucket_id, name, owner, version)
      values ('personal-card-temp', %L, null, 'late-account-upload')
    $sql$,
    (
      select fixture.user_id::text
        || '/e1000000-0000-4000-8000-000000000098.webp'
      from test_account_deletion_users as fixture
      where fixture.role = 'subject'
    )
  ),
  '23514',
  'account-deleted Storage prefix is closed',
  'late signed-upload completion cannot commit Storage metadata after deletion starts'
);

select throws_ok(
  format(
    $sql$
      insert into storage.objects (bucket_id, name, owner, version)
      values ('personal-cards', %L, null, 'late-account-upload-uppercase')
    $sql$,
    (
      select upper(fixture.user_id::text)
        || '/e1000000-0000-4000-8000-000000000097.webp'
      from test_account_deletion_users as fixture
      where fixture.role = 'subject'
    )
  ),
  '23514',
  'personal-card Storage objects require a canonical user UUID prefix',
  'UUID case changes cannot create an unscannable Storage prefix'
);

select throws_ok(
  $$
    insert into storage.objects (bucket_id, name, owner, version)
    values ('personal-card-temp', 'not-a-user/path.webp', null, 'malformed-prefix')
  $$,
  '23514',
  'personal-card Storage objects require a canonical user UUID prefix',
  'personal-card Storage paths cannot use non-user prefixes'
);

select throws_ok(
  $$
    insert into storage.objects (bucket_id, name, owner, version)
    values (
      'personal-cards',
      'e0000000-0000-4000-8000-000000000002/../nested.webp',
      null,
      'nested-prefix'
    )
  $$,
  '23514',
  'personal-card Storage objects require a canonical user UUID prefix',
  'personal-card Storage paths cannot contain nested or dot segments'
);

select lives_ok(
  $$
    insert into storage.objects (bucket_id, name, owner, version)
    values (
      'personal-card-temp',
      'e0000000-0000-4000-8000-000000000002/e1000000-0000-4000-8000-000000000099.webp',
      null,
      'active-canonical-path'
    )
  $$,
  'an active non-tombstoned account keeps the canonical flat Storage path'
);

select throws_ok(
  $$
    update storage.objects
    set bucket_id = 'unprotected-bucket'
    where bucket_id = 'personal-card-temp'
      and name = 'e0000000-0000-4000-8000-000000000002/e1000000-0000-4000-8000-000000000099.webp'
  $$,
  '23514',
  'personal-card Storage object ownership is immutable',
  'a protected object cannot escape deletion by moving to another bucket'
);

select throws_ok(
  $$
    update storage.objects
    set name = 'e0000000-0000-4000-8000-000000000003/e1000000-0000-4000-8000-000000000099.webp'
    where bucket_id = 'personal-card-temp'
      and name = 'e0000000-0000-4000-8000-000000000002/e1000000-0000-4000-8000-000000000099.webp'
  $$,
  '23514',
  'personal-card Storage object ownership is immutable',
  'a protected object cannot escape deletion by moving to another owner prefix'
);

select is(
  api_private.request_account_deletion(
    'e0000000-0000-4000-8000-000000000001',
    'e7000000-0000-4000-8000-000000000001',
    repeat('a1', 32)
  ) ->> 'status',
  'accepted',
  'same request and token retry remains idempotent after identity revocation'
);

select is(
  api_private.request_account_deletion(
    'e0000000-0000-4000-8000-000000000001',
    'e7000000-0000-4000-8000-000000000001',
    repeat('b2', 32)
  ) ->> 'status',
  'idempotency_conflict',
  'same request with another status token is rejected'
);

select is(
  api_private.get_account_deletion_status_candidate(
    'e7000000-0000-4000-8000-000000000001'
  ) ->> 'status_token_hash',
  repeat('a1', 32),
  'public status candidate exposes only the token digest'
);

-- Bounded two-pass worker -----------------------------------------------

create temp table test_account_deletion_claim (
  result jsonb not null
) on commit drop;

insert into test_account_deletion_claim
select api_private.claim_account_deletion_jobs(
  'e8000000-0000-4000-8000-000000000001', 1, 4
);

select is(
  (select result -> 'jobs' -> 0 ->> 'phase' from test_account_deletion_claim),
  'storage_initial',
  'worker begins with the first Storage pass'
);

select ok(
  (
    select bool_and(
      api_private.record_account_deletion_storage_result(
        'e7000000-0000-4000-8000-000000000001',
        'e8000000-0000-4000-8000-000000000001',
        (item.value ->> 'id')::bigint,
        item.value ->> 'pass',
        true
      ) ->> 'status' = 'recorded'
    )
    from test_account_deletion_claim as claim_row
    cross join lateral jsonb_array_elements(
      claim_row.result -> 'jobs' -> 0 -> 'storage_items'
    ) as item(value)
  ),
  'first-pass Storage results are recorded under the live lease'
);

select is(
  api_private.advance_account_deletion_job(
    'e7000000-0000-4000-8000-000000000001',
    'e8000000-0000-4000-8000-000000000001',
    'storage_initial',
    false
  ) ->> 'status',
  'retry',
  'a prefix scan is mandatory after processing offered manifest items'
);

update private.account_deletion_jobs
set next_attempt_at = clock_timestamp()
where id = 'e7000000-0000-4000-8000-000000000001';

truncate test_account_deletion_claim;
insert into test_account_deletion_claim
select api_private.claim_account_deletion_jobs(
  'e8000000-0000-4000-8000-000000000001', 1, 4
);

select is(
  api_private.advance_account_deletion_job(
    'e7000000-0000-4000-8000-000000000001',
    'e8000000-0000-4000-8000-000000000001',
    'storage_initial',
    true
  ) ->> 'status',
  'advanced',
  'an empty owned-prefix scan advances to the final Storage pass'
);

-- Advance test time without sleeping.
update private.account_deletion_storage_manifest
set first_deleted_at = case
      when first_deleted_at is null then null
      else clock_timestamp() - interval '2 seconds'
    end,
    final_delete_after = clock_timestamp() - interval '1 second'
where request_id = 'e7000000-0000-4000-8000-000000000001';
update private.account_deletion_jobs
set next_attempt_at = clock_timestamp()
where id = 'e7000000-0000-4000-8000-000000000001';

truncate test_account_deletion_claim;
insert into test_account_deletion_claim
select api_private.claim_account_deletion_jobs(
  'e8000000-0000-4000-8000-000000000001', 1, 4
);

select is(
  (select result -> 'jobs' -> 0 ->> 'phase' from test_account_deletion_claim),
  'storage_final',
  'worker leases a separate final Storage pass'
);

select ok(
  (
    select bool_and(
      api_private.record_account_deletion_storage_result(
        'e7000000-0000-4000-8000-000000000001',
        'e8000000-0000-4000-8000-000000000001',
        (item.value ->> 'id')::bigint,
        item.value ->> 'pass',
        true
      ) ->> 'status' = 'recorded'
    )
    from test_account_deletion_claim as claim_row
    cross join lateral jsonb_array_elements(
      claim_row.result -> 'jobs' -> 0 -> 'storage_items'
    ) as item(value)
  ),
  'final-pass Storage results are independently recorded'
);

select is(
  api_private.advance_account_deletion_job(
    'e7000000-0000-4000-8000-000000000001',
    'e8000000-0000-4000-8000-000000000001',
    'storage_final',
    false
  ) ->> 'status',
  'retry',
  'final manifest processing still requires an empty prefix scan'
);

update private.account_deletion_jobs
set next_attempt_at = clock_timestamp()
where id = 'e7000000-0000-4000-8000-000000000001';

truncate test_account_deletion_claim;
insert into test_account_deletion_claim
select api_private.claim_account_deletion_jobs(
  'e8000000-0000-4000-8000-000000000001', 1, 4
);
select is(
  api_private.advance_account_deletion_job(
    'e7000000-0000-4000-8000-000000000001',
    'e8000000-0000-4000-8000-000000000001',
    'storage_final',
    true
  ) ->> 'status',
  'retry',
  'the first empty final scan starts a late-upload quarantine'
);

select ok(
  (
    select
      job_row.phase = 'storage_final'
      and job_row.final_storage_empty_at is not null
      and job_row.next_attempt_at >= job_row.final_storage_empty_at + interval '70 minutes'
    from private.account_deletion_jobs as job_row
    where job_row.id = 'e7000000-0000-4000-8000-000000000001'
  ),
  'database deletion remains blocked through the configured upload timeout'
);

-- Simulate the platform-enforced write timeout having elapsed, then require
-- one more durable empty listing before destructive DB cleanup.
update private.account_deletion_jobs
set final_storage_empty_at = clock_timestamp() - interval '71 minutes',
    next_attempt_at = clock_timestamp()
where id = 'e7000000-0000-4000-8000-000000000001';

truncate test_account_deletion_claim;
insert into test_account_deletion_claim
select api_private.claim_account_deletion_jobs(
  'e8000000-0000-4000-8000-000000000001', 1, 4
);
select is(
  api_private.advance_account_deletion_job(
    'e7000000-0000-4000-8000-000000000001',
    'e8000000-0000-4000-8000-000000000001',
    'storage_final',
    true
  ) ->> 'status',
  'advanced',
  'a second empty scan after quarantine unlocks the database phase'
);

truncate test_account_deletion_claim;
insert into test_account_deletion_claim
select api_private.claim_account_deletion_jobs(
  'e8000000-0000-4000-8000-000000000001', 1, 4
);
select is(
  (select result -> 'jobs' -> 0 ->> 'phase' from test_account_deletion_claim),
  'database',
  'database hard deletion is separately leased'
);

select is(
  api_private.advance_account_deletion_job(
    'e7000000-0000-4000-8000-000000000001',
    'e8000000-0000-4000-8000-000000000001',
    'database',
    false
  ) ->> 'status',
  'advanced',
  'database hard deletion advances to Auth only after Storage completion'
);

select is(
  (
    select count(*)::bigint
    from public.app_users as app_user
    join test_account_deletion_users as fixture
      on fixture.user_id = app_user.id
     and fixture.role = 'subject'
  ),
  0::bigint,
  'logical user and all owner-bound product data are hard-deleted'
);

select ok(
  (
    select
      report_row.personal_card_id is null
      and report_row.personal_card_redacted_at is not null
      and report_row.owner_user_id is null
      and report_row.owner_redacted_at is not null
      and report_row.share_secret_hash is null
      and report_row.share_secret_redacted_at is not null
    from private.content_reports as report_row
    where report_row.id = 'e5100000-0000-4000-8000-000000000001'
  ),
  'retained UGC report audit is de-identified before owned content disappears'
);

select ok(
  (
    select
      invite_row.redeemed_at is not null
      and invite_row.redeemed_by_user_id is null
      and invite_row.redeemed_by_redacted_at is not null
    from private.participant_invite_codes as invite_row
    where invite_row.code_hash = decode(repeat('d1', 32), 'hex')
  ),
  'invite redemption remains used but no longer identifies the deleted user'
);

truncate test_account_deletion_claim;
insert into test_account_deletion_claim
select api_private.claim_account_deletion_jobs(
  'e8000000-0000-4000-8000-000000000001', 1, 4
);
select is(
  (select result -> 'jobs' -> 0 ->> 'phase' from test_account_deletion_claim),
  'auth',
  'Auth deletion remains retryable after the product transaction commits'
);

delete from auth.users
where id in (
  'e0000000-0000-4000-8000-000000000001',
  'e0000000-0000-4000-8000-000000000002'
);

select is(
  (
    select count(*)::bigint
    from public.card_translations as translation_row
    where translation_row.card_id =
      'e2000000-0000-4000-8000-000000000001'
      and translation_row.approved_by is null
      and translation_row.approved_by_redacted_at is not null
  ),
  6::bigint,
  'Auth hard deletion retains approved content with a redacted audit marker'
);

select ok(
  (
    select
      action_row.admin_auth_user_id is null
      and action_row.admin_redacted_at is not null
      and action_row.personal_card_id is null
      and action_row.personal_card_redacted_at is not null
      and action_row.owner_user_id is null
      and action_row.owner_redacted_at is not null
    from private.moderation_actions as action_row
    where action_row.client_action_id =
      'e5300000-0000-4000-8000-000000000001'
  ),
  'UGC moderation audit retains no deleted Auth, card, or owner UUID'
);

select ok(
  (
    select bool_and(
      api_private.mark_account_deletion_auth_removed(
        'e7000000-0000-4000-8000-000000000001',
        'e8000000-0000-4000-8000-000000000001',
        identity.value::text::uuid
      ) ->> 'status' in ('removed', 'not_found')
    )
    from test_account_deletion_claim as claim_row
    cross join lateral jsonb_array_elements_text(
      claim_row.result -> 'jobs' -> 0 -> 'auth_user_ids'
    ) as identity(value)
  ),
  'every offered Auth UID is removed from the durable manifest'
);

select is(
  api_private.advance_account_deletion_job(
    'e7000000-0000-4000-8000-000000000001',
    'e8000000-0000-4000-8000-000000000001',
    'auth',
    false
  ) ->> 'status',
  'advanced',
  'empty Auth manifest advances to finalization'
);

truncate test_account_deletion_claim;
insert into test_account_deletion_claim
select api_private.claim_account_deletion_jobs(
  'e8000000-0000-4000-8000-000000000001', 1, 4
);
select is(
  api_private.advance_account_deletion_job(
    'e7000000-0000-4000-8000-000000000001',
    'e8000000-0000-4000-8000-000000000001',
    'finalize',
    false
  ) ->> 'status',
  'completed',
  'finalizer creates a 30-day nonidentifying receipt'
);

select ok(
  (
    select
      job_row.status = 'completed'
      and job_row.phase = 'done'
      and job_row.user_id is null
      and job_row.storage_prefix is null
      and job_row.result_code = 'DELETED'
      and job_row.receipt_expires_at = job_row.completed_at + interval '30 days'
    from private.account_deletion_jobs as job_row
    where job_row.id = 'e7000000-0000-4000-8000-000000000001'
  ),
  'receipt has no logical-user, Storage-path, or Auth-UID linkage'
);

select is(
  (
    select count(*)::bigint
    from private.account_deletion_storage_manifest
    where request_id = 'e7000000-0000-4000-8000-000000000001'
  ) + (
    select count(*)::bigint
    from private.account_deletion_auth_manifest
    where request_id = 'e7000000-0000-4000-8000-000000000001'
  ),
  0::bigint,
  'completed receipt retains neither external-system manifest'
);

select is(
  (
    select count(*)::bigint
    from private.account_deletion_storage_prefix_tombstones
  ),
  1::bigint,
  'a key-protected unlinked anti-recreation digest outlives the public receipt'
);

select ok(
  exists (
    select 1 from auth.users
    where id = 'e0000000-0000-4000-8000-000000000003'
  ),
  'Auth UID rebound to another logical user survives subject deletion'
);

-- Unlimited retry and aggregate alert boundary --------------------------

insert into auth.users (
  id, created_at, updated_at, is_anonymous, raw_user_meta_data
) values (
  'e9000000-0000-4000-8000-000000000001',
  now(), now(), true, '{}'::jsonb
);

select is(
  api_private.request_account_deletion(
    'e9000000-0000-4000-8000-000000000001',
    'e9100000-0000-4000-8000-000000000001',
    repeat('f1', 32)
  ) ->> 'status',
  'accepted',
  'retry fixture deletion is accepted'
);

select is(
  api_private.claim_account_deletion_jobs(
    'e9200000-0000-4000-8000-000000000001', 1, 4
  ) ->> 'status',
  'ready',
  'retry fixture is leased'
);

update private.account_deletion_jobs
set requested_at = transaction_timestamp() - interval '2 days',
    complete_by = transaction_timestamp() - interval '1 day',
    attempt_count = 999,
    consecutive_failure_count = 999
where id = 'e9100000-0000-4000-8000-000000000001';

select is(
  api_private.fail_account_deletion_job(
    'e9100000-0000-4000-8000-000000000001',
    'e9200000-0000-4000-8000-000000000001',
    'STORAGE_DELETE_FAILED'
  ) ->> 'status',
  'retrying',
  'overdue high-attempt deletion remains retryable without a terminal state'
);

select ok(
  (
    select
      job_row.status = 'pending'
      and job_row.attempt_count = 999
      and job_row.next_attempt_at is not null
    from private.account_deletion_jobs as job_row
    where job_row.id = 'e9100000-0000-4000-8000-000000000001'
  ),
  'failure schedules another capped-backoff attempt instead of giving up'
);

select ok(
  (
    select
      (backlog.result ->> 'overdue_jobs')::integer >= 1
      and (backlog.result ->> 'high_attempt_jobs')::integer >= 1
      and (backlog.result ->> 'retrying_jobs')::integer >= 1
    from (select api_private.get_account_deletion_backlog() as result) as backlog
  ),
  'aggregate backlog exposes the overdue/high-attempt alert signal only'
);

-- A crashed worker may leave an old job with a very old historical
-- next_attempt_at but a lease that only just expired. The effective due time,
-- not that stale pending timestamp, decides fairness against newer requests.
with fixture_time as (
  select transaction_timestamp() as observed_at
)
insert into private.account_deletion_jobs (
  id,
  status_token_hash,
  status,
  phase,
  requested_at,
  complete_by,
  next_attempt_at,
  lease_token,
  lease_expires_at
)
select
  'e9300000-0000-4000-8000-000000000001'::uuid,
  decode(repeat('a3', 32), 'hex'),
  'processing',
  'storage_initial',
  fixture_time.observed_at - interval '2 days',
  fixture_time.observed_at - interval '1 day',
  fixture_time.observed_at - interval '2 days',
  'e9300000-0000-4000-8000-000000000002'::uuid,
  fixture_time.observed_at - interval '1 second'
from fixture_time
union all
select
  'e9400000-0000-4000-8000-000000000001'::uuid,
  decode(repeat('b4', 32), 'hex'),
  'pending',
  'storage_initial',
  fixture_time.observed_at - interval '1 hour',
  fixture_time.observed_at + interval '23 hours',
  fixture_time.observed_at - interval '2 seconds',
  null::uuid,
  null
from fixture_time;

select is(
  api_private.claim_account_deletion_jobs(
    'e9500000-0000-4000-8000-000000000001', 1, 4
  ) -> 'jobs' -> 0 ->> 'id',
  'e9400000-0000-4000-8000-000000000001',
  'an expired poison lease cannot starve an earlier-effective newer pending job'
);

delete from private.account_deletion_jobs
where id in (
  'e9300000-0000-4000-8000-000000000001',
  'e9400000-0000-4000-8000-000000000001'
);

-- Admin inspection and retry -------------------------------------------

insert into auth.users (
  id, created_at, updated_at, is_anonymous, raw_user_meta_data
) values
  (
    'ea000000-0000-4000-8000-000000000001',
    now(), now(), false, '{}'::jsonb
  ),
  (
    'eb000000-0000-4000-8000-000000000001',
    now(), now(), false, '{}'::jsonb
  ),
  (
    'ec000000-0000-4000-8000-000000000001',
    now(), now(), false, '{}'::jsonb
  );

insert into private.admin_members (auth_user_id)
values
  ('ea000000-0000-4000-8000-000000000001'),
  ('eb000000-0000-4000-8000-000000000001');

update private.user_identities
set revoked_at = clock_timestamp()
where auth_user_id = 'eb000000-0000-4000-8000-000000000001'
  and revoked_at is null;

select is(
  api_private.list_account_deletion_jobs_admin(
    'ec000000-0000-4000-8000-000000000001', 'active', 50
  ) ->> 'status',
  'forbidden',
  'an active service identity without current admin membership cannot inspect deletions'
);

select is(
  api_private.list_account_deletion_jobs_admin(
    'eb000000-0000-4000-8000-000000000001', 'active', 50
  ) ->> 'status',
  'forbidden',
  'admin membership without an active service identity cannot inspect deletions'
);

select is(
  api_private.list_account_deletion_jobs_admin(
    'ea000000-0000-4000-8000-000000000001', 'active', 101
  ) ->> 'status',
  'invalid',
  'admin deletion inspection rejects limits above 100'
);

select is(
  api_private.list_account_deletion_jobs_admin(
    'ea000000-0000-4000-8000-000000000001', 'unknown', 50
  ) ->> 'status',
  'invalid',
  'admin deletion inspection rejects unknown status filters'
);

create temp table test_account_deletion_admin_list (
  result jsonb not null
) on commit drop;

insert into test_account_deletion_admin_list
select api_private.list_account_deletion_jobs_admin(
  'ea000000-0000-4000-8000-000000000001', 'all', 100
);

select is(
  (select result ->> 'status' from test_account_deletion_admin_list),
  'ready',
  'an active administrator can inspect the bounded deletion queue'
);

select ok(
  (
    select jsonb_array_length(result -> 'items') between 1 and 100
    from test_account_deletion_admin_list
  ),
  'admin deletion inspection returns at most 100 items'
);

select ok(
  not exists (
    select 1
    from test_account_deletion_admin_list as list_row
    cross join lateral jsonb_array_elements(list_row.result -> 'items') as item(value)
    cross join lateral jsonb_object_keys(item.value) as item_key(key)
    where item_key.key not in (
      'id',
      'status',
      'phase',
      'last_error_code',
      'last_error_at',
      'attempt_count',
      'consecutive_failure_count',
      'requested_at',
      'complete_by',
      'next_attempt_at',
      'lease_state',
      'lease_expires_at',
      'database_deleted_at',
      'completed_at',
      'updated_at'
    )
  ),
  'admin inspection exposes only opaque request IDs and operational fields'
);

create temp table test_account_deletion_admin_retry_before
on commit drop
as
select
  job_row.user_id,
  job_row.attempt_count,
  job_row.consecutive_failure_count,
  job_row.last_error_code,
  user_row.deletion_requested_at
from private.account_deletion_jobs as job_row
join public.app_users as user_row on user_row.id = job_row.user_id
where job_row.id = 'e9100000-0000-4000-8000-000000000001';

select is(
  api_private.retry_account_deletion_job_admin(
    'ea000000-0000-4000-8000-000000000001',
    'e9100000-0000-4000-8000-000000000001',
    'ee000000-0000-4000-8000-000000000001',
    'TRANSIENT_FAILURE',
    'Storage delete retry reviewed'
  ) ->> 'status',
  'retry_scheduled',
  'administrator can schedule an active deletion for immediate retry'
);

select ok(
  (
    select
      job_row.status = 'pending'
      and job_row.next_attempt_at <= clock_timestamp()
      and job_row.lease_token is null
      and job_row.lease_expires_at is null
      and job_row.attempt_count = before_row.attempt_count
      and job_row.consecutive_failure_count = before_row.consecutive_failure_count
      and job_row.last_error_code = before_row.last_error_code
      and user_row.deletion_requested_at = before_row.deletion_requested_at
      and not exists (
        select 1
        from private.user_identities as identity_row
        where identity_row.user_id = job_row.user_id
          and identity_row.revoked_at is null
      )
      and not exists (
        select 1
        from private.participant_access as access_row
        where access_row.user_id = job_row.user_id
          and access_row.revoked_at is null
      )
    from private.account_deletion_jobs as job_row
    join public.app_users as user_row on user_row.id = job_row.user_id
    cross join test_account_deletion_admin_retry_before as before_row
    where job_row.id = 'e9100000-0000-4000-8000-000000000001'
  ),
  'manual retry preserves failure evidence and never restores identity or access'
);

select ok(
  (
    select
      action_row.admin_auth_user_id =
        'ea000000-0000-4000-8000-000000000001'
      and action_row.request_id =
        'e9100000-0000-4000-8000-000000000001'
      and action_row.client_action_id =
        'ee000000-0000-4000-8000-000000000001'
      and action_row.action = 'retry'
      and action_row.reason_code = 'TRANSIENT_FAILURE'
      and action_row.note = 'Storage delete retry reviewed'
      and action_row.result_status = 'retry_scheduled'
      and action_row.created_at is not null
    from private.account_deletion_admin_actions as action_row
    where action_row.admin_auth_user_id =
      'ea000000-0000-4000-8000-000000000001'
      and action_row.client_action_id =
        'ee000000-0000-4000-8000-000000000001'
  ),
  'manual retry records the canonical bounded administrator action audit'
);

select throws_ok(
  $$
    update private.account_deletion_admin_actions
    set note = 'attempted audit rewrite'
    where client_action_id =
      'ee000000-0000-4000-8000-000000000001'
  $$,
  '23514',
  'account deletion administrator actions are append-only',
  'account deletion administrator actions cannot be rewritten'
);

select throws_ok(
  $$
    delete from private.account_deletion_admin_actions
    where client_action_id =
      'ee000000-0000-4000-8000-000000000001'
  $$,
  '23514',
  'account deletion administrator actions are append-only',
  'account deletion administrator actions cannot be manually deleted'
);

create temp table test_account_deletion_admin_retry_once
on commit drop
as
select next_attempt_at, updated_at
from private.account_deletion_jobs
where id = 'e9100000-0000-4000-8000-000000000001';

select is(
  api_private.retry_account_deletion_job_admin(
    'ea000000-0000-4000-8000-000000000001',
    'e9100000-0000-4000-8000-000000000001',
    'ee000000-0000-4000-8000-000000000001',
    'TRANSIENT_FAILURE',
    'Storage delete retry reviewed'
  ) ->> 'status',
  'duplicate',
  'the exact client action replay returns duplicate'
);

select ok(
  (
    select
      job_row.next_attempt_at = retry_row.next_attempt_at
      and job_row.updated_at = retry_row.updated_at
    from private.account_deletion_jobs as job_row
    cross join test_account_deletion_admin_retry_once as retry_row
    where job_row.id = 'e9100000-0000-4000-8000-000000000001'
  ),
  'a repeated due retry is an idempotent no-op'
);

select is(
  api_private.retry_account_deletion_job_admin(
    'ea000000-0000-4000-8000-000000000001',
    'e9100000-0000-4000-8000-000000000001',
    'ee000000-0000-4000-8000-000000000001',
    'TRANSIENT_FAILURE',
    'different note'
  ) ->> 'status',
  'idempotency_conflict',
  'reusing a client action ID with a different payload is rejected'
);

select is(
  (
    select count(*)::bigint
    from private.account_deletion_admin_actions
    where admin_auth_user_id =
      'ea000000-0000-4000-8000-000000000001'
      and client_action_id =
        'ee000000-0000-4000-8000-000000000001'
  ),
  1::bigint,
  'duplicate and conflicting replays never append a second audit row'
);

select is(
  api_private.retry_account_deletion_job_admin(
    'ea000000-0000-4000-8000-000000000001',
    'e7000000-0000-4000-8000-000000000001',
    'ee000000-0000-4000-8000-000000000002',
    'MANUAL_REVIEW',
    'Confirmed completed receipt'
  ) ->> 'status',
  'completed',
  'retrying a completed receipt returns a safe completed status'
);

delete from private.account_deletion_jobs
where id = 'e7000000-0000-4000-8000-000000000001';

select is(
  (
    select count(*)::bigint
    from private.account_deletion_admin_actions
    where client_action_id =
      'ee000000-0000-4000-8000-000000000002'
  ),
  0::bigint,
  'completed receipt retention cleanup cascades its bounded administrator audit'
);

select is(
  api_private.retry_account_deletion_job_admin(
    'ea000000-0000-4000-8000-000000000001',
    'ed000000-0000-4000-8000-000000000001',
    'ee000000-0000-4000-8000-000000000003',
    'OVERDUE',
    'Unknown receipt review'
  ) ->> 'status',
  'not_found',
  'retrying an unknown opaque request returns a safe not-found status'
);

select is(
  api_private.retry_account_deletion_job_admin(
    'ea000000-0000-4000-8000-000000000001',
    null::uuid,
    'ee000000-0000-4000-8000-000000000004',
    'OVERDUE',
    'Invalid request review'
  ) ->> 'status',
  'invalid',
  'retrying a null request returns a safe invalid status'
);

select is(
  api_private.retry_account_deletion_job_admin(
    'ea000000-0000-4000-8000-000000000001',
    'e9100000-0000-4000-8000-000000000001',
    'ee000000-0000-4000-8000-000000000005',
    'UNBOUNDED_REASON',
    'Invalid reason review'
  ) ->> 'status',
  'invalid',
  'retrying with an unbounded reason code returns invalid'
);

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
)
select
  'ea000000-0000-4000-8000-000000000001',
  'e9100000-0000-4000-8000-000000000001',
  ('ee000000-0000-4000-8000-'
    || lpad((series_row.value + 100)::text, 12, '0'))::uuid,
  'retry',
  'WORKER_STALLED',
  'Bounded retry fixture ' || series_row.value::text,
  'retry_scheduled',
  clock_timestamp(),
  clock_timestamp()
from generate_series(1, 29) as series_row(value);

select is(
  api_private.retry_account_deletion_job_admin(
    'ea000000-0000-4000-8000-000000000001',
    'e9100000-0000-4000-8000-000000000001',
    'ee000000-0000-4000-8000-000000000099',
    'WORKER_STALLED',
    'Thirty first action in the rolling minute'
  ) ->> 'status',
  'rate_limited',
  'administrator retry mutations are limited to thirty actions per minute'
);

-- Non-field permanent reconciliation -----------------------------------

insert into auth.users (
  id, created_at, updated_at, is_anonymous, raw_user_meta_data
) values (
  'ef000000-0000-4000-8000-000000000001',
  now(), now(), true, '{}'::jsonb
);

create temp table generic_cleanup_fixture (
  user_id uuid primary key,
  object_path text not null,
  ledger_id bigint,
  first_claim jsonb,
  final_claim jsonb
) on commit drop;

insert into generic_cleanup_fixture (user_id, object_path)
select
  identity_row.user_id,
  identity_row.user_id::text
    || '/ef100000-0000-4000-8000-000000000001.webp'
from private.user_identities as identity_row
where identity_row.auth_user_id =
  'ef000000-0000-4000-8000-000000000001'
  and identity_row.revoked_at is null;

insert into storage.objects (bucket_id, name, owner, version, metadata)
select
  'personal-cards',
  fixture.object_path,
  null,
  'generic-cleanup-first-object',
  '{"size":2048}'::jsonb
from generic_cleanup_fixture as fixture;

insert into private.personal_card_permanent_object_ledger (
  user_id, processing_token, object_path, origin, reserved_bytes,
  final_delete_not_before, next_attempt_at
)
select
  fixture.user_id,
  'ef100000-0000-4000-8000-000000000001',
  fixture.object_path,
  'legacy_orphan',
  2048,
  now() - interval '1 day',
  now() - interval '2 days'
from generic_cleanup_fixture as fixture;

update generic_cleanup_fixture
set ledger_id = (
  select ledger_row.id
  from private.personal_card_permanent_object_ledger as ledger_row
  where ledger_row.object_path = generic_cleanup_fixture.object_path
);

update generic_cleanup_fixture
set first_claim = api_private.claim_personal_card_storage_cleanup(
  'ef200000-0000-4000-8000-000000000001', 1
);

select is(
  (select first_claim #>> '{item,phase}' from generic_cleanup_fixture),
  'first',
  'an abandoned non-field permanent object is offered for its first pass'
);

-- This is a metadata-only pgTAP fixture with no backend object. Scope the
-- Supabase Storage direct-delete escape hatch to the test transaction.
set local storage.allow_delete_query = 'true';

delete from storage.objects as object_row
using generic_cleanup_fixture as fixture
where object_row.bucket_id = 'personal-cards'
  and object_row.name = fixture.object_path;

select is(
  api_private.record_personal_card_storage_cleanup_result(
    'ef200000-0000-4000-8000-000000000001',
    'permanent',
    null::uuid,
    (select ledger_id from generic_cleanup_fixture),
    'first',
    true
  ) ->> 'status',
  'recorded',
  'a successful first delete retains the ledger for a later final pass'
);

select throws_ok(
  format(
    $sql$
      insert into storage.objects (bucket_id, name, owner, version)
      values ('personal-cards', %L, null, 'late-generic-upload')
    $sql$,
    (select object_path from generic_cleanup_fixture)
  ),
  '23514',
  'cleaned personal-card Storage object is closed',
  'the claim-time exact tombstone blocks a late permanent metadata commit'
);

update private.personal_card_permanent_object_ledger as ledger_row
set first_deleted_at = now() - interval '20 minutes',
    final_delete_after = now() - interval '10 minutes',
    next_attempt_at = now() - interval '10 minutes'
from generic_cleanup_fixture as fixture
where ledger_row.id = fixture.ledger_id;

update generic_cleanup_fixture
set final_claim = api_private.claim_personal_card_storage_cleanup(
  'ef200000-0000-4000-8000-000000000002', 1
);

select is(
  (select final_claim #>> '{item,phase}' from generic_cleanup_fixture),
  'final',
  'the same permanent path reaches a separate final cleanup pass'
);

select is(
  api_private.record_personal_card_storage_cleanup_result(
    'ef200000-0000-4000-8000-000000000002',
    'permanent',
    null::uuid,
    (select ledger_id from generic_cleanup_fixture),
    'final',
    true
  ) ->> 'status',
  'completed',
  'only exact successful final deletion removes the permanent ledger row'
);

select is(
  (
    select count(*)::bigint
    from private.personal_card_permanent_object_ledger as ledger_row
    where ledger_row.id = (select ledger_id from generic_cleanup_fixture)
  ),
  0::bigint,
  'the two-pass non-field worker leaves no standalone ledger residue'
);

select * from finish();
rollback;
