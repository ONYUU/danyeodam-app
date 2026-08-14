import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import process from "node:process";

import pg from "pg";

import { createLocalizedSpotCardFixture } from "./lib/localized-fixture.mjs";
import { createPolicyFixture, retirePolicyFixture } from "./lib/policy-fixture.mjs";

const { Client } = pg;
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const policyTypeMigration = readdirSync(
  new URL("../supabase/migrations", import.meta.url),
).find((filename) => filename.endsWith("_add_location_terms_policy_type.sql"));
if (policyTypeMigration === undefined) {
  throw new Error("location policy-type migration is missing");
}
const policyTypeMigrationVersion = policyTypeMigration.split("_", 1)[0];

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
  policyTypeMigrationVersion,
]);

const databaseUrl = readLocalDatabaseUrl();
const authUserId = randomUUID();
const acquisitionId = randomUUID();
const uploadId = randomUUID();
const processingToken = randomUUID();
const historicalUploadId = randomUUID();
const historicalProcessingToken = randomUUID();
const historicalAcquireAuthUserId = randomUUID();
const historicalAcquireKey = randomUUID();
const historicalAcquireFailKey = randomUUID();
const spotId = randomUUID();
const cardId = randomUUID();
const fixtureSuffix = randomUUID().replaceAll("-", "").slice(0, 12);
let database = new Client({ connectionString: databaseUrl });
let policyFixture;

try {
  await database.connect();
  await database.query("set statement_timeout = '15s'");
  await database.query(
    `insert into auth.users (
       id, created_at, updated_at, is_anonymous, raw_user_meta_data
     ) values ($1::uuid, now(), now(), true, '{}'::jsonb)`,
    [authUserId],
  );
  const identity = await database.query(
    `select user_id
     from private.user_identities
     where auth_user_id = $1::uuid and revoked_at is null`,
    [authUserId],
  );
  assert(identity.rowCount === 1, "upgrade fixture did not create one active identity");
  const userId = identity.rows[0].user_id;

  await createLocalizedSpotCardFixture(database, {
    approvalAuthUserId: authUserId,
    cardCode: `location-upgrade-${fixtureSuffix}`,
    cardId,
    cardTitle: "Location upgrade card",
    regionCode: `location-upgrade-${fixtureSuffix}`,
    spotId,
    spotName: "Location upgrade spot",
    spotSlug: `location-upgrade-${fixtureSuffix}`,
  });
  await database.query(
    `insert into public.acquisitions (
       id, user_id, spot_id, card_id, acquisition_type, verification_result,
       idempotency_key, field_sequence
     ) values (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'field', 'passed', $5::uuid, 1
     )`,
    [acquisitionId, userId, spotId, cardId, randomUUID()],
  );
  await database.query(
    `insert into analytics.events (
       user_id, event_name, source, occurred_at, spot_id, properties
     )
     select
       acquisition_row.user_id,
       'acquire_success',
       'server',
       acquisition_row.acquired_at,
       acquisition_row.spot_id,
       jsonb_build_object('spot_id', acquisition_row.spot_id::text)
     from public.acquisitions as acquisition_row
     cross join generate_series(1, 2)
     where acquisition_row.id = $1::uuid`,
    [acquisitionId],
  );
  await database.query(
    `with fixture_time as (
       select clock_timestamp() as issued_at
     )
     insert into private.personal_card_temp_uploads (
       id, user_id, temp_path, declared_content_type, declared_size_bytes,
       issued_at, promotion_expires_at, signed_url_expires_at,
       processing_token, processing_started_at, processing_expires_at,
       processing_acquisition_id, processing_permanent_path, processing_caption
     )
     select
       $1::uuid, $2::uuid,
       $2::uuid::text || '/' || $1::uuid::text || '.jpg', 'image/jpeg', 128,
       fixture_time.issued_at,
       fixture_time.issued_at + interval '10 minutes',
       fixture_time.issued_at + interval '2 hours',
       $3::uuid, fixture_time.issued_at + interval '1 second',
       fixture_time.issued_at + interval '9 minutes',
       $4::uuid,
       $2::uuid::text || '/' || $3::uuid::text || '.webp', 'upgrade in-flight'
     from fixture_time`,
    [uploadId, userId, processingToken, acquisitionId],
  );
  await database.end();

  runSupabase(["migration", "up", "--local"]);

  database = new Client({ connectionString: databaseUrl });
  await database.connect();
  await database.query("set statement_timeout = '15s'");
  const ledger = await database.query(
    `select
       ledger_row.bucket,
       ledger_row.object_path,
       ledger_row.final_delete_not_before,
       upload_row.issued_at,
       upload_row.promotion_expires_at,
       upload_row.signed_url_expires_at,
       upload_row.processing_expires_at
     from private.personal_card_field_object_ledger as ledger_row
     join private.personal_card_temp_uploads as upload_row
       on upload_row.id = ledger_row.upload_id
     where ledger_row.user_id = $1::uuid
       and ledger_row.field_acquisition_id = $2::uuid
       and ledger_row.processing_token = $3::uuid
     order by ledger_row.bucket`,
    [userId, acquisitionId, processingToken],
  );
  assert(ledger.rowCount === 2, "upgrade did not backfill exactly two object bindings");
  const permanent = ledger.rows.find((row) => row.bucket === "personal-cards");
  const temporary = ledger.rows.find((row) => row.bucket === "personal-card-temp");
  assert(permanent !== undefined, "upgrade missed the in-flight permanent path");
  assert(temporary !== undefined, "upgrade missed the signed temporary path");
  assert(
    permanent.object_path === `${userId}/${processingToken}.webp`,
    "upgrade changed the permanent path binding",
  );
  assert(
    temporary.object_path === `${userId}/${uploadId}.jpg`,
    "upgrade changed the temporary path binding",
  );
  assert(
    new Date(permanent.final_delete_not_before).getTime()
      >= new Date(permanent.processing_expires_at).getTime() + 10 * 60 * 1000,
    "upgrade permanent final boundary is earlier than processing expiry plus grace",
  );
  assert(
    new Date(temporary.final_delete_not_before).getTime()
      >= new Date(temporary.signed_url_expires_at).getTime() + 10 * 60 * 1000,
    "upgrade temp final boundary is earlier than signed URL expiry plus grace",
  );
  const source = await database.query(
    `select count(*)::integer as count
     from private.personal_card_temp_uploads
     where id = $1::uuid
       and processing_token = $2::uuid
       and processing_acquisition_id = $3::uuid
       and promoted_at is null`,
    [uploadId, processingToken, acquisitionId],
  );
  assert(source.rows[0]?.count === 1, "upgrade lost the source in-flight processing lease");
  const correlatedLegacySuccess = await database.query(
    `select
       count(*)::integer as correlated_count
     from analytics.events as event_row
     join private.location_use_facts as fact_row
       on fact_row.id = event_row.location_use_fact_id
     join public.acquisitions as acquisition_row
       on acquisition_row.user_id = fact_row.user_id
      and acquisition_row.idempotency_key = fact_row.idempotency_key
      and acquisition_row.spot_id = fact_row.spot_id
      and acquisition_row.acquired_at = event_row.occurred_at
     where acquisition_row.id = $1::uuid
       and event_row.event_name = 'acquire_success'
       and event_row.source = 'server'
       and event_row.user_id = acquisition_row.user_id
       and event_row.spot_id = acquisition_row.spot_id
       and event_row.occurred_at = acquisition_row.acquired_at`,
    [acquisitionId],
  );
  assert(
    correlatedLegacySuccess.rows[0]?.correlated_count === 1,
    "upgrade did not retain exactly one correlated legacy acquire success",
  );
  const uncorrelatedLegacySuccess = await database.query(
    `select count(*)::integer as count
     from analytics.events
     where source = 'server'
       and event_name = 'acquire_success'
       and location_use_fact_id is null`,
  );
  assert(
    uncorrelatedLegacySuccess.rows[0]?.count === 0,
    "upgrade retained an uncorrelated legacy acquire success",
  );

  await database.query(
    `insert into auth.users (
       id, created_at, updated_at, is_anonymous, raw_user_meta_data
     ) values ($1::uuid, now(), now(), true, '{}'::jsonb)`,
    [historicalAcquireAuthUserId],
  );
  const historicalIdentity = await database.query(
    `select user_id
     from private.user_identities
     where auth_user_id = $1::uuid and revoked_at is null`,
    [historicalAcquireAuthUserId],
  );
  assert(
    historicalIdentity.rowCount === 1,
    "historical acquire fixture did not create one active identity",
  );
  const historicalAcquireUserId = historicalIdentity.rows[0].user_id;
  await database.query(
    `insert into private.participant_access (user_id, access_kind)
     values ($1::uuid, 'internal_tester'), ($2::uuid, 'internal_tester')`,
    [userId, historicalAcquireUserId],
  );
  policyFixture = await createPolicyFixture(database, {
    authUserIds: [authUserId, historicalAcquireAuthUserId],
  });
  await database.query(
    `insert into private.card_counters (card_id, last_sequence)
     values ($1::uuid, 1)
     on conflict (card_id) do update
     set last_sequence = greatest(private.card_counters.last_sequence, 1)`,
    [cardId],
  );

  await database.query(
    `with fixture_time as (
       select clock_timestamp() as issued_at
     )
     insert into private.personal_card_temp_uploads (
       id, user_id, temp_path, declared_content_type, declared_size_bytes,
       issued_at, promotion_expires_at, signed_url_expires_at
     )
     select
       $1::uuid, $2::uuid,
       $2::uuid::text || '/' || $1::uuid::text || '.jpg', 'image/jpeg', 256,
       fixture_time.issued_at,
       fixture_time.issued_at + interval '10 minutes',
       fixture_time.issued_at + interval '2 hours'
     from fixture_time`,
    [historicalUploadId, userId],
  );
  const historicalBegin = await database.query(
    `select api_private.begin_personal_card_promotion_after_location_compliance(
       $1::uuid, false, $2::uuid, $3::text, 'upgrade historical begin', $4::uuid
     ) as result`,
    [
      authUserId,
      acquisitionId,
      `${userId}/${historicalUploadId}.jpg`,
      historicalProcessingToken,
    ],
  );
  assert(
    historicalBegin.rows[0]?.result?.status === "ready",
    "historical begin did not reach the compatibility trigger",
  );
  const historicalBeginLedger = await database.query(
    `select
       count(*)::integer as count,
       bool_and(
         case ledger_row.bucket
           when 'personal-card-temp' then
             ledger_row.object_path = upload_row.temp_path
             and ledger_row.final_delete_not_before =
               upload_row.signed_url_expires_at + interval '10 minutes'
           when 'personal-cards' then
             ledger_row.object_path =
               upload_row.user_id::text || '/' || upload_row.processing_token::text || '.webp'
             and ledger_row.final_delete_not_before =
               upload_row.processing_expires_at + interval '10 minutes'
           else false
         end
       ) as exact_bounds,
       bool_and(
         ledger_row.user_id = upload_row.user_id
         and ledger_row.field_acquisition_id = upload_row.processing_acquisition_id
         and ledger_row.processing_token = upload_row.processing_token
         and ledger_row.state = 'active'
       ) as exact_owner_state
     from private.personal_card_field_object_ledger as ledger_row
     join private.personal_card_temp_uploads as upload_row
       on upload_row.id = ledger_row.upload_id
     where ledger_row.upload_id = $1::uuid
       and ledger_row.field_acquisition_id = $2::uuid
       and ledger_row.processing_token = $3::uuid`,
    [historicalUploadId, acquisitionId, historicalProcessingToken],
  );
  assert(
    historicalBeginLedger.rows[0]?.count === 2
      && historicalBeginLedger.rows[0]?.exact_bounds === true
      && historicalBeginLedger.rows[0]?.exact_owner_state === true,
    "historical begin did not durably register two exact object paths",
  );
  const historicalBeginReplay = await database.query(
    `select api_private.begin_personal_card_promotion_after_location_compliance(
       $1::uuid, false, $2::uuid, $3::text, 'upgrade historical begin', $4::uuid
     ) as result`,
    [
      authUserId,
      acquisitionId,
      `${userId}/${historicalUploadId}.jpg`,
      historicalProcessingToken,
    ],
  );
  assert(
    historicalBeginReplay.rows[0]?.result?.status === "ready",
    "historical begin same-token replay was not deterministic",
  );
  const historicalBeginReplayCount = await database.query(
    `select count(*)::integer as count
     from private.personal_card_field_object_ledger
     where upload_id = $1::uuid and processing_token = $2::uuid`,
    [historicalUploadId, historicalProcessingToken],
  );
  assert(
    historicalBeginReplayCount.rows[0]?.count === 2,
    "historical begin replay duplicated object ledger rows",
  );

  const cardCounterBeforeFailure = await database.query(
    `select last_sequence from private.card_counters where card_id = $1::uuid`,
    [cardId],
  );
  assert(cardCounterBeforeFailure.rowCount === 1, "upgrade card counter fixture is missing");
  const successEventsBeforeFailure = await database.query(
    `select count(*)::integer as count
     from analytics.events
     where user_id = $1::uuid and event_name = 'acquire_success'`,
    [historicalAcquireUserId],
  );
  await expectDatabaseError(
    database.query(
      `select api_private.acquire_commit_after_location_compliance(
         $1::uuid, $2::uuid, $3::uuid, false,
         (select updated_at from public.spots where id = $2::uuid)
       ) as result`,
      [historicalAcquireAuthUserId, spotId, historicalAcquireFailKey],
    ),
    {
      code: "23514",
      message: "field acquisition requires one exact pending location fact",
    },
  );
  const failedHistoricalAcquire = await database.query(
    `select
       (select count(*)::integer
        from public.acquisitions
        where user_id = $1::uuid and idempotency_key = $2::uuid) as acquisitions,
       (select count(*)::integer
        from private.location_use_facts
        where user_id = $1::uuid and idempotency_key = $2::uuid) as facts,
       (select count(*)::integer
        from analytics.events
        where user_id = $1::uuid and event_name = 'acquire_success') as events,
       (select last_sequence
        from private.card_counters
        where card_id = $3::uuid) as last_sequence`,
    [historicalAcquireUserId, historicalAcquireFailKey, cardId],
  );
  assert(
    failedHistoricalAcquire.rows[0]?.acquisitions === 0
      && failedHistoricalAcquire.rows[0]?.facts === 0
      && failedHistoricalAcquire.rows[0]?.events
        === successEventsBeforeFailure.rows[0]?.count
      && failedHistoricalAcquire.rows[0]?.last_sequence
        === cardCounterBeforeFailure.rows[0]?.last_sequence,
    "historical acquire without context left a partial fact, counter, acquisition, or event",
  );

  await database.query(
    `insert into private.location_use_facts (
       user_id, idempotency_key, spot_id, purpose
     ) values ($1::uuid, $2::uuid, $3::uuid, 'field_acquisition')`,
    [historicalAcquireUserId, historicalAcquireKey, spotId],
  );
  const historicalAcquire = await database.query(
    `select api_private.acquire_commit_after_location_compliance(
       $1::uuid, $2::uuid, $3::uuid, false,
       (select updated_at from public.spots where id = $2::uuid)
     ) as result`,
    [historicalAcquireAuthUserId, spotId, historicalAcquireKey],
  );
  assert(
    historicalAcquire.rows[0]?.result?.status === "created",
    "historical acquire with an exact pending fact was not completed",
  );
  const historicalAcquirePostcondition = await database.query(
    `select
       fact_row.outcome,
       count(distinct acquisition_row.id)::integer as acquisition_count,
       count(distinct event_row.id)::integer as event_count,
       count(*) filter (
         where event_row.location_use_fact_id is null
       )::integer as null_event_count
     from private.location_use_facts as fact_row
     left join public.acquisitions as acquisition_row
       on acquisition_row.user_id = fact_row.user_id
      and acquisition_row.idempotency_key = fact_row.idempotency_key
      and acquisition_row.spot_id = fact_row.spot_id
      and acquisition_row.acquisition_type = 'field'
     left join analytics.events as event_row
       on event_row.location_use_fact_id = fact_row.id
      and event_row.event_name = 'acquire_success'
      and event_row.source = 'server'
      and event_row.user_id = acquisition_row.user_id
      and event_row.spot_id = acquisition_row.spot_id
      and event_row.occurred_at = acquisition_row.acquired_at
     where fact_row.user_id = $1::uuid
       and fact_row.idempotency_key = $2::uuid
       and fact_row.purpose = 'field_acquisition'
     group by fact_row.outcome`,
    [historicalAcquireUserId, historicalAcquireKey],
  );
  assert(
    historicalAcquirePostcondition.rowCount === 1
      && historicalAcquirePostcondition.rows[0].outcome === "passed"
      && historicalAcquirePostcondition.rows[0].acquisition_count === 1
      && historicalAcquirePostcondition.rows[0].event_count === 1
      && historicalAcquirePostcondition.rows[0].null_event_count === 0,
    "historical acquire did not end with one passed fact and one exact event",
  );
  const historicalAcquireReplay = await database.query(
    `select api_private.acquire_commit_after_location_compliance(
       $1::uuid, $2::uuid, $3::uuid, false,
       (select updated_at from public.spots where id = $2::uuid)
     ) as result`,
    [historicalAcquireAuthUserId, spotId, historicalAcquireKey],
  );
  assert(
    historicalAcquireReplay.rows[0]?.result?.status === "replay",
    "historical acquire same-key replay was not deterministic",
  );
  const historicalAcquireReplayCounts = await database.query(
    `select
       (select count(*)::integer
        from private.location_use_facts
        where user_id = $1::uuid and idempotency_key = $2::uuid) as facts,
       (select count(*)::integer
        from public.acquisitions
        where user_id = $1::uuid and idempotency_key = $2::uuid) as acquisitions,
       (select count(*)::integer
        from analytics.events as event_row
        join private.location_use_facts as fact_row
          on fact_row.id = event_row.location_use_fact_id
        where fact_row.user_id = $1::uuid
          and fact_row.idempotency_key = $2::uuid
          and event_row.event_name = 'acquire_success') as events,
       (select count(*)::integer
        from analytics.events
        where source = 'server'
          and event_name = 'acquire_success'
          and location_use_fact_id is null) as uncorrelated_events`,
    [historicalAcquireUserId, historicalAcquireKey],
  );
  assert(
    historicalAcquireReplayCounts.rows[0]?.facts === 1
      && historicalAcquireReplayCounts.rows[0]?.acquisitions === 1
      && historicalAcquireReplayCounts.rows[0]?.events === 1
      && historicalAcquireReplayCounts.rows[0]?.uncorrelated_events === 0,
    "historical acquire replay changed exact fact, acquisition, or event cardinality",
  );

  console.log(
    "Location compliance upgrade: backfill and historical-writer compatibility passed",
  );
} finally {
  if (policyFixture !== undefined) {
    await retirePolicyFixture(database, policyFixture).catch(() => undefined);
  }
  await database.end().catch(() => undefined);
}
