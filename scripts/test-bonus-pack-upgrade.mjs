import { execFileSync } from "node:child_process";
import process from "node:process";

import pg from "pg";

const { Client } = pg;
const executable = process.platform === "win32" ? "npx.cmd" : "npx";

function supabase(...args) {
  execFileSync(executable, ["supabase", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
}

function localDatabaseUrl() {
  const output = execFileSync(
    executable,
    ["supabase", "status", "-o", "env"],
    { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const line = output.split(/\r?\n/u).find((candidate) => candidate.startsWith('DB_URL="'));
  if (line === undefined) throw new Error("DB_URL missing from local Supabase status");
  return line.slice('DB_URL="'.length, -1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let database;
let shouldRestoreLatest = false;

try {
  // Stop immediately before bonus-pack v1, then preserve a valid historical
  // acquisition. Replica mode is used only to represent a legacy row whose
  // old write path predated current location/card-snapshot triggers.
  supabase(
    "db", "reset", "--local", "--yes", "--no-seed",
    "--version", "20260813053632",
  );
  shouldRestoreLatest = true;
  database = new Client({ connectionString: localDatabaseUrl() });
  await database.connect();
  await database.query("set statement_timeout = '20s'");
  await database.query("set session_replication_role = replica");
  await database.query(`
    insert into public.app_users (id)
    values ('f1000000-0000-4000-8000-000000000001');

    insert into public.regions (code, country_code, sort_order)
    values ('bonus-upgrade', 'KR', 999);

    insert into public.spots (
      id, slug, region, name_ko, name_en, status,
      latitude, longitude, radius_m, accuracy_threshold_m, sort_order
    ) values (
      'f2000000-0000-4000-8000-000000000001',
      'bonus-upgrade-spot', 'bonus-upgrade', '업그레이드', 'Upgrade',
      'draft', 37.5, 126.9, 150, 200, 1
    );

    insert into public.cards (
      id, spot_id, code, kind, title_ko, title_en,
      sketch_path, color_hex, is_published, published_at
    ) values
    (
      'f3000000-0000-4000-8000-000000000001',
      'f2000000-0000-4000-8000-000000000001',
      'bonus-upgrade-common', 'region', '일반', 'Common',
      'tests/upgrade-common.webp', '#AA7777', false, null
    ),
    (
      'f3000000-0000-4000-8000-000000000002',
      'f2000000-0000-4000-8000-000000000001',
      'bonus-upgrade-special', 'special', '특별', 'Special',
      'tests/upgrade-special.webp', '#8866AA', true, now()
    );

    insert into storage.buckets (
      id, name, public, file_size_limit, allowed_mime_types
    ) values (
      'special-card-assets', 'special-card-assets', true, 10485760,
      array['image/png', 'image/jpeg', 'image/webp']
    ) on conflict (id) do update set public = true;

    insert into public.acquisitions (
      id, user_id, spot_id, card_id, acquisition_type, verification_result,
      idempotency_key, field_sequence, acquired_at
    ) values (
      'f4000000-0000-4000-8000-000000000001',
      'f1000000-0000-4000-8000-000000000001',
      'f2000000-0000-4000-8000-000000000001',
      'f3000000-0000-4000-8000-000000000001',
      'field', 'passed',
      'f5000000-0000-4000-8000-000000000001',
      1,
      '2026-08-13T03:00:00Z'
    );
  `);
  await database.query("set session_replication_role = origin");
  await database.end();
  database = undefined;

  // A published historical special without its private original must fail the
  // cutover atomically. This deliberately exercises a real preflight failure,
  // then proves every table/function rename/history write rolled back.
  let preflightFailed = false;
  try {
    supabase("migration", "up", "--local", "--yes");
  } catch {
    preflightFailed = true;
  }
  assert(preflightFailed, "incompatible published special unexpectedly passed preflight");

  database = new Client({ connectionString: localDatabaseUrl() });
  await database.connect();
  const rollback = await database.query(`
    select
      not exists (
        select 1
        from supabase_migrations.schema_migrations
        where version = '20260814164513'
      ) as migration_not_recorded,
      to_regclass('private.bonus_packs') is null as ledger_rolled_back,
      to_regprocedure(
        'api_private.acquire_commit_v05(uuid,uuid,uuid,boolean,timestamptz,uuid,text)'
      ) is null as v05_rolled_back,
      to_regprocedure(
        'api_private.acquire_context_before_bonus_pack(uuid,uuid,uuid,boolean)'
      ) is null as context_rename_rolled_back,
      to_regprocedure(
        'api_private.acquire_context(uuid,uuid,uuid,boolean)'
      ) is not null as original_context_preserved,
      exists (
        select 1 from storage.buckets
        where id = 'special-card-assets' and public
      ) as public_bucket_state_rolled_back,
      not exists (
        select 1 from storage.objects
        where bucket_id = 'special-card-assets'
          and name = 'tests/upgrade-special.webp'
      ) as missing_object_still_absent,
      exists (
        select 1
        from public.acquisitions
        where id = 'f4000000-0000-4000-8000-000000000001'
      ) as legacy_acquisition_preserved
  `);
  const rollbackRow = rollback.rows[0];
  assert(rollbackRow.migration_not_recorded, "failed preflight wrote migration history");
  assert(rollbackRow.ledger_rolled_back, "failed preflight left the bonus ledger");
  assert(rollbackRow.v05_rolled_back, "failed preflight left the v0.5 wrapper");
  assert(rollbackRow.context_rename_rolled_back, "failed preflight left a renamed context function");
  assert(rollbackRow.original_context_preserved, "failed preflight lost the original context function");
  assert(rollbackRow.public_bucket_state_rolled_back, "failed preflight leaked the private-bucket update");
  assert(rollbackRow.missing_object_still_absent, "failed preflight invented the missing special object");
  assert(rollbackRow.legacy_acquisition_preserved, "failed preflight changed legacy acquisitions");

  // Remediate the exact preflight defect in the same historical chain, then
  // retry the unmodified migration.
  await database.query(`
    insert into storage.objects (bucket_id, name, owner, version)
    values (
      'special-card-assets', 'tests/upgrade-special.webp', null,
      'bonus-upgrade-special-v1'
    );
  `);
  await database.end();
  database = undefined;

  supabase("migration", "up", "--local", "--yes");

  database = new Client({ connectionString: localDatabaseUrl() });
  await database.connect();
  const result = await database.query(`
    select
      exists (
        select 1
        from supabase_migrations.schema_migrations
        where version = '20260814164513'
      ) as migration_recorded,
      to_regclass('private.bonus_packs') is not null as ledger_exists,
      (
        select count(*) from private.bonus_packs
      ) = 0 as no_backfill,
      exists (
        select 1
        from public.acquisitions
        where id = 'f4000000-0000-4000-8000-000000000001'
      ) as acquisition_preserved,
      api_private.get_published_card_asset(
        'f3000000-0000-4000-8000-000000000001'
      ) = 'tests/upgrade-common.webp' as ordinary_asset_preserved,
      api_private.get_published_card_asset(
        'f3000000-0000-4000-8000-000000000002'
      ) is null as public_special_closed,
      (
        select not bucket_row.public
        from storage.buckets as bucket_row
        where bucket_row.id = 'special-card-assets'
      ) as special_bucket_private,
      private.special_card_asset_is_private(
        'tests/upgrade-special.webp'
      ) as special_object_preserved,
      to_regprocedure(
        'api_private.acquire_commit_v05(uuid,uuid,uuid,boolean,timestamptz,uuid,text)'
      ) is not null as v05_exists
  `);
  const row = result.rows[0];
  assert(row.migration_recorded, "bonus migration history was not recorded");
  assert(row.ledger_exists, "bonus ledger was not created");
  assert(row.no_backfill, "historical acquisitions were backfilled into bonus packs");
  assert(row.acquisition_preserved, "historical acquisition was modified or removed");
  assert(row.ordinary_asset_preserved, "ordinary acquired asset behavior regressed");
  assert(row.public_special_closed, "special art remained public after upgrade");
  assert(row.special_bucket_private, "special-card-assets bucket is not private");
  assert(row.special_object_preserved, "private special object was not preserved");
  assert(row.v05_exists, "v0.5 acquire commit RPC is missing after upgrade");
  await database.end();
  database = undefined;

  // A second migration-up must be a no-op selected by history, not a replay
  // of the wrapper renames.
  supabase("migration", "up", "--local", "--yes");
} finally {
  if (database !== undefined) await database.end().catch(() => {});
  if (shouldRestoreLatest) {
    try {
      supabase("db", "reset", "--local", "--yes", "--no-seed");
    } catch {
      // Preserve the original failure. The next CI job always starts from a
      // fresh local stack and will report reset failure independently.
    }
  }
}
