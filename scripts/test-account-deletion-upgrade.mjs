import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import process from "node:process";

import pg from "pg";

const { Client } = pg;
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const migrationFiles = readdirSync(
  new URL("../supabase/migrations", import.meta.url),
)
  .filter((filename) => /^\d+_.+[.]sql$/u.test(filename))
  .sort();
const accountMigrationIndex = migrationFiles.findIndex((filename) =>
  filename.endsWith("_account_deletion_state_machine_v4.sql"),
);
if (accountMigrationIndex < 1) {
  throw new Error("account deletion migration or its predecessor is missing");
}
const preAccountMigration = migrationFiles[accountMigrationIndex - 1];
if (!preAccountMigration.endsWith("_location_compliance_backend.sql")) {
  throw new Error(
    `expected location compliance immediately before account deletion, received ${preAccountMigration}`,
  );
}
const accountMigration = migrationFiles[accountMigrationIndex];
const correctionPaginationMigration = migrationFiles.find((filename) =>
  filename.endsWith("_location_correction_pagination.sql"),
);
if (correctionPaginationMigration === undefined) {
  throw new Error("location-correction pagination migration is missing");
}
const quotaMigration = migrationFiles.find((filename) =>
  filename.endsWith("_personal_card_upload_quota.sql"),
);
if (quotaMigration === undefined) {
  throw new Error("personal-card upload quota migration is missing");
}
const authenticatedRateMigration = migrationFiles.find((filename) =>
  filename.endsWith("_authenticated_api_rate_limits.sql"),
);
if (authenticatedRateMigration === undefined) {
  throw new Error("authenticated API rate-limit migration is missing");
}
const photoIdempotencySchemaMigration = migrationFiles.find((filename) =>
  filename.endsWith("_personal_card_photo_idempotency_schema.sql"),
);
const photoIdempotencyRpcsMigration = migrationFiles.find((filename) =>
  filename.endsWith("_personal_card_photo_idempotency_rpcs.sql"),
);
if (
  photoIdempotencySchemaMigration === undefined
  || photoIdempotencyRpcsMigration === undefined
) {
  throw new Error("personal-card photo idempotency migrations are missing");
}

function migrationVersion(filename) {
  return filename.split("_", 1)[0];
}

function runSupabase(arguments_) {
  execFileSync(npx, ["supabase", ...arguments_], {
    encoding: "utf8",
    stdio: "inherit",
  });
}

function readLocalDatabaseUrl() {
  if (process.env.DANYEODAM_DB_URL !== undefined) return process.env.DANYEODAM_DB_URL;
  const output = execFileSync(npx, ["supabase", "status", "-o", "env"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const line = output
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith('DB_URL="'));
  if (line === undefined) throw new Error("DB_URL missing from local Supabase status");
  return line.slice('DB_URL="'.length, -1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectDatabaseError(promise, { code, message }) {
  try {
    await promise;
  } catch (error) {
    assert(error?.code === code, `expected SQLSTATE ${code}, received ${error?.code}`);
    assert(
      error?.message === message,
      `expected database error "${message}", received "${error?.message}"`,
    );
    return;
  }
  throw new Error(`expected database error "${message}"`);
}

runSupabase([
  "db",
  "reset",
  "--local",
  "--yes",
  "--no-seed",
  "--version",
  migrationVersion(preAccountMigration),
]);

const databaseUrl = readLocalDatabaseUrl();
const ownerAuthUserId = randomUUID();
const deletedActorAuthUserId = randomUUID();
const spotId = randomUUID();
const catalogCardId = randomUUID();
const acquisitionId = randomUUID();
const acquisitionIdempotencyKey = randomUUID();
const personalCardId = randomUUID();
const liveAcquisitionId = randomUUID();
const liveAcquisitionIdempotencyKey = randomUUID();
const livePersonalCardId = randomUUID();
const historicalTempUploadId = randomUUID();
const reportId = randomUUID();
const reportClientId = randomUUID();
const suspensionId = randomUUID();
const moderationActionId = randomUUID();
const moderationClientId = randomUUID();
const locationAttemptKey = randomUUID();
const correctionId = randomUUID();
const correctionClientId = randomUUID();
const inviteId = randomUUID();
const fixtureSuffix = randomUUID().replaceAll("-", "").slice(0, 12);
let database = new Client({ connectionString: databaseUrl });
let ownerUserId;

try {
  await database.connect();
  await database.query("set statement_timeout = '15s'");
  await database.query("begin");
  try {
    await database.query(
      `insert into auth.users (
         id, created_at, updated_at, is_anonymous, raw_user_meta_data
       ) values
         ($1::uuid, now(), now(), false, '{}'::jsonb),
         ($2::uuid, now(), now(), false, '{}'::jsonb)`,
      [ownerAuthUserId, deletedActorAuthUserId],
    );
    const ownerIdentity = await database.query(
      `select user_id
       from private.user_identities
       where auth_user_id = $1::uuid and revoked_at is null`,
      [ownerAuthUserId],
    );
    assert(ownerIdentity.rowCount === 1, "upgrade owner has no exact active identity");
    ownerUserId = ownerIdentity.rows[0].user_id;

    const regionCode = `account-upgrade-${fixtureSuffix}`;
    await database.query(
      `insert into public.regions (code, country_code, sort_order)
       values ($1, 'KR', 0)`,
      [regionCode],
    );
    await database.query(
      `insert into public.spots (
         id, slug, region, name_ko, name_en, status, latitude, longitude
       ) values ($1::uuid, $2, $3, '계정 삭제 업그레이드',
                 'Account deletion upgrade', 'draft', 37.5, 127.0)`,
      [spotId, `account-upgrade-${fixtureSuffix}`, regionCode],
    );
    // This harness isolates account-deletion upgrades. Published special-card
    // cutover and private-asset remediation are covered by the dedicated bonus
    // pack upgrade harness, so use a non-special catalog fixture here.
    await database.query(
      `insert into public.cards (
         id, spot_id, code, kind, title_ko, title_en, sketch_path, color_hex
       ) values ($1::uuid, $2::uuid, $3, 'limited',
                 '계정 삭제 업그레이드 카드', 'Account deletion upgrade card',
                 'cards/account-upgrade.webp', '#204030')`,
      [catalogCardId, spotId, `account-upgrade-${fixtureSuffix}`],
    );
    await database.query(
      `insert into public.card_translations (
         card_id, locale, title, status, approved_at, approved_by
       )
       select $1::uuid, locale_row.locale,
              'Account deletion upgrade ' || locale_row.locale::text,
              'approved', now(), $2::uuid
       from unnest(enum_range(null::public.content_locale))
         as locale_row(locale)`,
      [catalogCardId, ownerAuthUserId],
    );
    await database.query(
      `update public.cards
       set is_published = true,
           published_at = now()
       where id = $1::uuid`,
      [catalogCardId],
    );
    await database.query(
      `insert into public.acquisitions (
         id, user_id, spot_id, card_id, acquisition_type,
         verification_result, idempotency_key
       ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid,
                 'retro', 'manual', $5::uuid)`,
      [
        acquisitionId,
        ownerUserId,
        spotId,
        catalogCardId,
        acquisitionIdempotencyKey,
      ],
    );
    await database.query(
      `insert into private.retro_grants (
         acquisition_id, admin_auth_user_id, reason_code, note
       ) values ($1::uuid, $2::uuid, 'ACCOUNT_UPGRADE_FIXTURE',
                 'upgrade-path fixture')`,
      [acquisitionId, ownerAuthUserId],
    );
    await database.query(
      `insert into public.personal_cards (
         id, user_id, acquisition_id, photo_path, caption
       ) values ($1::uuid, $2::uuid, $3::uuid, $4, 'upgrade fixture')`,
      [
        personalCardId,
        ownerUserId,
        acquisitionId,
        `${ownerUserId}/${personalCardId}.webp`,
      ],
    );
    await database.query(
      `insert into storage.objects (
         bucket_id, name, owner, version, metadata
       ) values (
         'personal-cards', $1, $2::uuid, $3, jsonb_build_object('size', 1234)
       )`,
      [
        `${ownerUserId}/${personalCardId}.webp`,
        ownerAuthUserId,
        `account-upgrade-${fixtureSuffix}`,
      ],
    );
    await database.query(
      `insert into private.personal_card_temp_uploads (
         id, user_id, temp_path, declared_content_type, declared_size_bytes,
         issued_at, promotion_expires_at, signed_url_expires_at
       )
       select
         $1::uuid, $2::uuid, $2::uuid::text || '/' || $1::uuid::text || '.jpg',
         'image/jpeg', 2048,
         fixture_time.issued_at,
         fixture_time.issued_at + interval '10 minutes',
         fixture_time.issued_at + interval '2 hours'
       from (select clock_timestamp() as issued_at) as fixture_time`,
      [historicalTempUploadId, ownerUserId],
    );
    await database.query(
      `insert into public.acquisitions (
         id, user_id, spot_id, card_id, acquisition_type,
         verification_result, idempotency_key
       ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid,
                 'gift', 'not_applicable', $5::uuid)`,
      [
        liveAcquisitionId,
        ownerUserId,
        spotId,
        catalogCardId,
        liveAcquisitionIdempotencyKey,
      ],
    );
    await database.query(
      `insert into public.personal_cards (
         id, user_id, acquisition_id, photo_path, caption
       ) values ($1::uuid, $2::uuid, $3::uuid, $4, 'live quota fixture')`,
      [
        livePersonalCardId,
        ownerUserId,
        liveAcquisitionId,
        `${ownerUserId}/${livePersonalCardId}.webp`,
      ],
    );
    await database.query(
      `insert into storage.objects (
         bucket_id, name, owner, version, metadata
       ) values (
         'personal-cards', $1, $2::uuid, $3, jsonb_build_object('size', 1234)
       )`,
      [
        `${ownerUserId}/${livePersonalCardId}.webp`,
        ownerAuthUserId,
        `account-upgrade-live-${fixtureSuffix}`,
      ],
    );
    await database.query(
      `insert into private.content_reports (
         id, client_report_id, personal_card_id, owner_user_id,
         share_secret_hash, target, reason, status, created_at,
         resolved_at, resolved_by_auth_user_id, resolution_code
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         decode(repeat('a5', 32), 'hex'), 'content', 'spam', 'resolved',
         now() - interval '3 hours', now() - interval '2 hours',
         $5::uuid, 'ACCOUNT_UPGRADE_FIXTURE'
       )`,
      [reportId, reportClientId, personalCardId, ownerUserId, deletedActorAuthUserId],
    );
    await database.query(
      `insert into private.share_owner_suspensions (
         id, user_id, suspended_at, suspended_by_auth_user_id,
         reason_code, note, lifted_at, lifted_by_auth_user_id
       ) values (
         $1::uuid, $2::uuid, now() - interval '5 hours', $3::uuid,
         'ACCOUNT_UPGRADE_FIXTURE', 'upgrade-path fixture',
         now() - interval '4 hours', $3::uuid
       )`,
      [suspensionId, ownerUserId, deletedActorAuthUserId],
    );
    await database.query(
      `insert into private.moderation_actions (
         id, admin_auth_user_id, client_action_id, personal_card_id,
         report_id, owner_user_id, suspension_id, action,
         previous_state, resulting_state, reason_code, note
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         $5::uuid, $6::uuid, $7::uuid, 'take_down',
         'active', 'taken_down', 'ACCOUNT_UPGRADE_FIXTURE',
         'immutable upgrade-path fixture'
       )`,
      [
        moderationActionId,
        deletedActorAuthUserId,
        moderationClientId,
        personalCardId,
        reportId,
        ownerUserId,
        suspensionId,
      ],
    );
    const locationFact = await database.query(
      `insert into private.location_use_facts (
         user_id, idempotency_key, spot_id, purpose, collected_at,
         decided_at, outcome, terminal_failure_code, terminal_failure_details
       ) values (
         $1::uuid, $2::uuid, $3::uuid, 'field_acquisition',
         now() - interval '7 hours', now() - interval '6 hours', 'failed',
         'OUT_OF_RANGE', '{"distance_band":"near"}'::jsonb
       ) returning id`,
      [ownerUserId, locationAttemptKey, spotId],
    );
    assert(locationFact.rowCount === 1, "upgrade location fact was not created");
    await database.query(
      `insert into private.location_correction_requests (
         id, user_id, location_use_fact_id, client_request_id,
         request_fingerprint, reason, status, requested_at,
         resolved_at, resolved_by_auth_user_id
       ) values (
         $1::uuid, $2::uuid, $3::bigint, $4::uuid,
         decode(repeat('b6', 32), 'hex'), 'other', 'rejected',
         now() - interval '5 hours', now() - interval '4 hours', $5::uuid
       )`,
      [
        correctionId,
        ownerUserId,
        locationFact.rows[0].id,
        correctionClientId,
        deletedActorAuthUserId,
      ],
    );
    await database.query(
      `insert into private.participant_invite_codes (
         id, code_hash, issued_at, redeemed_at, redeemed_by_user_id, note
       ) values (
         $1::uuid, decode(repeat('c7', 32), 'hex'),
         now() - interval '8 hours', now() - interval '7 hours',
         $2::uuid, 'upgrade-path fixture'
       )`,
      [inviteId, ownerUserId],
    );

    const removedCard = await database.query(
      "delete from public.personal_cards where id = $1::uuid",
      [personalCardId],
    );
    assert(removedCard.rowCount === 1, "historical personal card was not deleted");
    const removedActor = await database.query(
      "delete from auth.users where id = $1::uuid",
      [deletedActorAuthUserId],
    );
    assert(removedActor.rowCount === 1, "historical Auth actor was not deleted");

    const precondition = await database.query(
      `select
         to_regclass('private.account_deletion_jobs') is null as account_absent,
         report_row.personal_card_id is null as report_card_orphaned,
         report_row.share_secret_hash = decode(repeat('a5', 32), 'hex')
           as report_hash_retained,
         report_row.resolved_by_auth_user_id = $1::uuid as report_actor_retained,
         action_row.personal_card_id = $2::uuid as action_card_retained,
         action_row.admin_auth_user_id = $1::uuid as action_actor_retained,
         correction_row.resolved_by_auth_user_id = $1::uuid
           as correction_actor_retained,
         suspension_row.suspended_by_auth_user_id = $1::uuid
           and suspension_row.lifted_by_auth_user_id = $1::uuid
           as suspension_actors_retained,
         not exists (
           select 1 from auth.users where id = $1::uuid
         ) as actor_absent
       from private.content_reports as report_row
       join private.moderation_actions as action_row
         on action_row.id = $3::uuid
       join private.location_correction_requests as correction_row
         on correction_row.id = $4::uuid
       join private.share_owner_suspensions as suspension_row
         on suspension_row.id = $5::uuid
       where report_row.id = $6::uuid`,
      [
        deletedActorAuthUserId,
        personalCardId,
        moderationActionId,
        correctionId,
        suspensionId,
        reportId,
      ],
    );
    assert(precondition.rowCount === 1, "historical orphan precondition is missing");
    assert(
      Object.values(precondition.rows[0]).every((value) => value === true),
      "historical orphan precondition was not exact",
    );
    await database.query("commit");
  } catch (error) {
    await database.query("rollback");
    throw error;
  }
  await database.end();

  runSupabase(["migration", "up", "--local"]);

  database = new Client({ connectionString: databaseUrl });
  await database.connect();
  await database.query("set statement_timeout = '15s'");

  const migrationHistory = await database.query(
    `select count(*)::integer as count
     from supabase_migrations.schema_migrations
     where version = any($1::text[])`,
    [[
      migrationVersion(accountMigration),
      migrationVersion(correctionPaginationMigration),
      migrationVersion(quotaMigration),
      migrationVersion(authenticatedRateMigration),
      migrationVersion(photoIdempotencySchemaMigration),
      migrationVersion(photoIdempotencyRpcsMigration),
    ]],
  );
  assert(
    migrationHistory.rows[0]?.count === 6,
    "the six compliance migrations are not all recorded",
  );
  const newSchema = await database.query(
    `select
       to_regclass('private.account_deletion_jobs') is not null as jobs_present,
       to_regclass('private.account_deletion_storage_prefix_tombstones') is not null
         as tombstones_present,
       to_regprocedure(
         'api_private.list_own_location_corrections(uuid,integer,timestamp with time zone,uuid)'
       ) is not null as correction_pagination_present,
       to_regclass('private.rate_limit_windows') is not null as rate_windows_present,
       to_regclass('private.personal_card_deletion_requests') is not null
         as personal_card_deletion_receipts_present,
       to_regprocedure(
         'api_private.issue_personal_card_temp_upload(uuid,boolean,text,bigint,uuid)'
       ) is not null as idempotent_photo_issue_present,
       exists (
         select 1
         from information_schema.columns
         where table_schema = 'public'
           and table_name = 'personal_cards'
           and column_name = 'photo_size_bytes'
           and is_nullable = 'NO'
       ) as quota_column_present`,
  );
  assert(
    newSchema.rowCount === 1
      && Object.values(newSchema.rows[0]).every((value) => value === true),
    "the integrated compliance schema is incomplete",
  );
  const legacyUploadIdempotency = await database.query(
    `select
       client_request_id = id as key_backfilled,
       signed_url_last_issued_at = issued_at as issue_time_backfilled,
       signed_url_expires_at = signed_url_last_issued_at + interval '2 hours'
         as signed_window_exact,
       signed_url_reissue_count = 0 as retry_count_zero
     from private.personal_card_temp_uploads
     where id = $1::uuid`,
    [historicalTempUploadId],
  );
  assert(
    legacyUploadIdempotency.rowCount === 1
      && Object.values(legacyUploadIdempotency.rows[0]).every((value) => value === true),
    "historical temp upload did not receive an exact idempotency backfill",
  );
  const legacyCardAccounting = await database.query(
    `select photo_size_bytes
     from public.personal_cards
     where id = $1::uuid`,
    [livePersonalCardId],
  );
  assert(
    legacyCardAccounting.rowCount === 1
      && Number(legacyCardAccounting.rows[0].photo_size_bytes) === 1234,
    "legacy personal-card byte accounting was not imported from Storage metadata",
  );
  const historicalOrphanPath = `${ownerUserId}/${personalCardId}.webp`;
  const importedLegacyOrphan = await database.query(
    `select origin, reserved_bytes
     from private.personal_card_permanent_object_ledger
     where user_id = $1::uuid
       and object_path = $2`,
    [ownerUserId, historicalOrphanPath],
  );
  assert(
    importedLegacyOrphan.rowCount === 1
      && importedLegacyOrphan.rows[0].origin === "legacy_orphan"
      && Number(importedLegacyOrphan.rows[0].reserved_bytes) === 1234,
    "historical Storage orphan was not imported into the durable cleanup ledger",
  );

  const report = await database.query(
    `select
       personal_card_id,
       personal_card_redacted_at,
       owner_user_id,
       owner_redacted_at,
       share_secret_hash,
       share_secret_redacted_at,
       resolved_by_auth_user_id,
       resolved_by_redacted_at,
       status,
       resolution_code
     from private.content_reports
     where id = $1::uuid`,
    [reportId],
  );
  const reportRow = report.rows[0];
  assert(
    report.rowCount === 1
      && reportRow.personal_card_id === null
      && reportRow.personal_card_redacted_at !== null
      && reportRow.owner_user_id === ownerUserId
      && reportRow.owner_redacted_at === null
      && reportRow.share_secret_hash === null
      && reportRow.share_secret_redacted_at !== null
      && reportRow.resolved_by_auth_user_id === null
      && reportRow.resolved_by_redacted_at !== null
      && reportRow.status === "resolved"
      && reportRow.resolution_code === "ACCOUNT_UPGRADE_FIXTURE",
    "historical report identifiers were not narrowly redacted",
  );

  const moderation = await database.query(
    `select
       admin_auth_user_id,
       admin_redacted_at,
       personal_card_id,
       personal_card_redacted_at,
       owner_user_id,
       owner_redacted_at,
       suspension_id,
       suspension_redacted_at,
       report_id,
       action,
       reason_code,
       note
     from private.moderation_actions
     where id = $1::uuid`,
    [moderationActionId],
  );
  const moderationRow = moderation.rows[0];
  assert(
    moderation.rowCount === 1
      && moderationRow.admin_auth_user_id === null
      && moderationRow.admin_redacted_at !== null
      && moderationRow.personal_card_id === null
      && moderationRow.personal_card_redacted_at !== null
      && moderationRow.owner_user_id === ownerUserId
      && moderationRow.owner_redacted_at === null
      && moderationRow.suspension_id === suspensionId
      && moderationRow.suspension_redacted_at === null
      && moderationRow.report_id === reportId
      && moderationRow.action === "take_down"
      && moderationRow.reason_code === "ACCOUNT_UPGRADE_FIXTURE"
      && moderationRow.note === "immutable upgrade-path fixture",
    "historical moderation identifiers were not narrowly redacted",
  );

  const actorMarkers = await database.query(
    `select
       correction_row.resolved_by_auth_user_id is null
         and correction_row.resolved_by_redacted_at is not null
         and correction_row.status = 'rejected' as correction_redacted,
       suspension_row.suspended_by_auth_user_id is null
         and suspension_row.suspended_by_redacted_at is not null
         and suspension_row.lifted_by_auth_user_id is null
         and suspension_row.lifted_by_redacted_at is not null
         and suspension_row.reason_code = 'ACCOUNT_UPGRADE_FIXTURE'
         as suspension_redacted
     from private.location_correction_requests as correction_row
     join private.share_owner_suspensions as suspension_row
       on suspension_row.id = $1::uuid
     where correction_row.id = $2::uuid`,
    [suspensionId, correctionId],
  );
  assert(
    actorMarkers.rowCount === 1
      && actorMarkers.rows[0].correction_redacted === true
      && actorMarkers.rows[0].suspension_redacted === true,
    "historically deleted Auth actors were not redacted from all audit rows",
  );
  const rawActorReferences = await database.query(
    `select (
       (select count(*) from private.content_reports
        where resolved_by_auth_user_id = $1::uuid)
       + (select count(*) from private.moderation_actions
          where admin_auth_user_id = $1::uuid)
       + (select count(*) from private.location_correction_requests
          where resolved_by_auth_user_id = $1::uuid)
       + (select count(*) from private.share_owner_suspensions
          where suspended_by_auth_user_id = $1::uuid
             or lifted_by_auth_user_id = $1::uuid)
     )::integer as count`,
    [deletedActorAuthUserId],
  );
  assert(
    rawActorReferences.rows[0]?.count === 0,
    "a deleted Auth actor UUID survived the upgrade backfill",
  );

  // This upgrade harness next performs a direct logical-user DELETE only to
  // exercise the retained-audit redaction triggers. The production account
  // deletion state machine would transfer this durable orphan to its Storage
  // manifest and complete both deletion passes first. Reproduce that finished
  // prerequisite explicitly so the ledger's intentional ON DELETE RESTRICT
  // cannot be bypassed or mistaken for an upgrade failure.
  await database.query("begin");
  try {
    // These rows were inserted directly as metadata-only upgrade fixtures, so
    // there are no backend objects for the Storage API to remove. Scope the
    // local-only metadata cleanup escape hatch to this transaction.
    await database.query("set local storage.allow_delete_query = 'true'");
    const removedFixtureObjects = await database.query(
      `delete from storage.objects
       where bucket_id = 'personal-cards'
         and name = any($1::text[])
       returning name`,
      [[historicalOrphanPath, `${ownerUserId}/${livePersonalCardId}.webp`]],
    );
    assert(
      removedFixtureObjects.rowCount === 2,
      "upgrade fixture Storage objects were not removed before direct owner deletion",
    );
    const removedLegacyLedger = await database.query(
      `delete from private.personal_card_permanent_object_ledger
       where user_id = $1::uuid
         and object_path = $2
         and origin = 'legacy_orphan'
       returning id`,
      [ownerUserId, historicalOrphanPath],
    );
    assert(
      removedLegacyLedger.rowCount === 1,
      "durable legacy-orphan ledger was not cleared after fixture Storage deletion",
    );
    await database.query("commit");
  } catch (error) {
    await database.query("rollback");
    throw error;
  }

  const removedOwner = await database.query(
    "delete from public.app_users where id = $1::uuid",
    [ownerUserId],
  );
  assert(removedOwner.rowCount === 1, "logical owner was not deleted after upgrade");

  const retainedAudit = await database.query(
    `select
       report_row.personal_card_id is null
         and report_row.personal_card_redacted_at is not null
         and report_row.owner_user_id is null
         and report_row.owner_redacted_at is not null
         and report_row.share_secret_hash is null
         and report_row.share_secret_redacted_at is not null
         and report_row.resolved_by_auth_user_id is null
         and report_row.resolved_by_redacted_at is not null
         as report_deidentified,
       action_row.admin_auth_user_id is null
         and action_row.admin_redacted_at is not null
         and action_row.personal_card_id is null
         and action_row.personal_card_redacted_at is not null
         and action_row.owner_user_id is null
         and action_row.owner_redacted_at is not null
         and action_row.suspension_id is null
         and action_row.suspension_redacted_at is not null
         and action_row.report_id = $1::uuid
         as moderation_deidentified,
       invite_row.redeemed_at is not null
         and invite_row.redeemed_by_user_id is null
         and invite_row.redeemed_by_redacted_at is not null
         and invite_row.code_hash = decode(repeat('c7', 32), 'hex')
         as invite_deidentified
     from private.content_reports as report_row
     join private.moderation_actions as action_row on action_row.id = $2::uuid
     join private.participant_invite_codes as invite_row on invite_row.id = $3::uuid
     where report_row.id = $1::uuid`,
    [reportId, moderationActionId, inviteId],
  );
  assert(
    retainedAudit.rowCount === 1
      && Object.values(retainedAudit.rows[0]).every((value) => value === true),
    "post-upgrade logical-user deletion retained a raw owner identifier",
  );
  await expectDatabaseError(
    database.query(
      `update private.moderation_actions
       set note = 'attempted rewrite'
       where id = $1::uuid`,
      [moderationActionId],
    ),
    {
      code: "23514",
      message: "moderation actions are append-only",
    },
  );

  console.log(
    "Account deletion upgrade: redaction, photo idempotency backfill, and history passed",
  );
} finally {
  await database.end().catch(() => undefined);
}
