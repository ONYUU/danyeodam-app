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

function supabaseMustFail(...args) {
  try {
    execFileSync(executable, ["supabase", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return `${String(error.stdout ?? "")}\n${String(error.stderr ?? "")}`;
  }
  throw new Error(`Supabase command unexpectedly passed: ${args.join(" ")}`);
}

let database;
try {
  // The original credential-lockdown migration must also be wholly atomic.
  // Start immediately before it with one invalid active reviewer, prove the
  // migration leaves neither early objects nor history, then remediate and
  // apply the exact same migration chain successfully.
  supabase(
    "db", "reset", "--local", "--yes", "--no-seed",
    "--version", "20260811194524",
  );
  database = new Client({ connectionString: localDatabaseUrl() });
  await database.connect();
  const earlyAuthUserId = "d7000000-0000-4000-8000-000000000001";
  await database.query(
    `insert into auth.users (
       id, created_at, updated_at, email, encrypted_password,
       email_confirmed_at, is_anonymous, is_sso_user,
       role, aud, is_super_admin, banned_until,
       raw_app_meta_data, raw_user_meta_data
     ) values (
       $1, now(), now(), 'reviewer-early-cutover@example.test',
       'reviewer-early-cutover-hash', now(), true, false,
       'authenticated', 'authenticated', false, null,
       '{"provider":"email","providers":["email"]}', '{}'
     )`,
    [earlyAuthUserId],
  );
  await database.query(
    `insert into auth.identities (
       id, user_id, provider_id, identity_data, provider,
       last_sign_in_at, created_at, updated_at
     ) values (
       'd7010000-0000-4000-8000-000000000001', $1::uuid, $1::uuid::text,
       jsonb_build_object(
         'sub', $1::text,
         'email', 'reviewer-early-cutover@example.test',
         'email_verified', true
       ),
       'email', now(), now(), now()
     )`,
    [earlyAuthUserId],
  );
  const earlyBinding = await database.query(
    `select user_id from private.user_identities
     where auth_user_id = $1 and revoked_at is null`,
    [earlyAuthUserId],
  );
  assert(earlyBinding.rowCount === 1, "early cutover reviewer has no active binding");
  const earlyUserId = earlyBinding.rows[0].user_id;
  await database.query(
    `insert into private.reviewer_accounts (
       user_id, store_platform, fixture_version
     ) values ($1, 'app_store', 'early-cutover-reviewer')`,
    [earlyUserId],
  );
  await database.end();
  database = undefined;

  const failedEarlyCutover = supabaseMustFail("migration", "up", "--local", "--yes");
  assert(
    failedEarlyCutover.includes("active reviewer credential cutover validation failed"),
    "invalid active reviewer did not fail the original credential cutover",
  );
  assert(
    !failedEarlyCutover.includes(earlyAuthUserId)
      && !failedEarlyCutover.includes(String(earlyUserId))
      && !failedEarlyCutover.includes("reviewer-early-cutover@example.test"),
    "original credential cutover error exposed a reviewer identifier",
  );

  database = new Client({ connectionString: localDatabaseUrl() });
  await database.connect();
  const earlyRollback = await database.query(
    `select
       to_regclass('private.reviewer_auth_guard_denials') is null
         as sequence_absent,
       to_regprocedure(
         'private.reviewer_auth_has_no_auxiliary_credentials(uuid)'
       ) is null as helper_absent,
       to_regprocedure(
         'private.assert_reviewer_auth_credential_cutover()'
       ) is null as assertion_absent,
       not exists (
         select 1 from supabase_migrations.schema_migrations
         where version = '20260811203000'
       ) as history_absent`,
  );
  assert(earlyRollback.rows[0].sequence_absent, "failed original cutover left its sequence");
  assert(earlyRollback.rows[0].helper_absent, "failed original cutover left its helper");
  assert(earlyRollback.rows[0].assertion_absent, "failed original cutover left its assertion");
  assert(earlyRollback.rows[0].history_absent, "failed original cutover recorded history");
  await database.query(
    `update auth.users
     set is_anonymous = false,
         role = 'authenticated',
         aud = 'authenticated',
         is_super_admin = false,
         banned_until = null
     where id = $1`,
    [earlyAuthUserId],
  );
  await database.end();
  database = undefined;

  supabase("migration", "up", "--local", "--yes");
  database = new Client({ connectionString: localDatabaseUrl() });
  await database.connect();
  const earlyApplied = await database.query(
    `select
       to_regclass('private.reviewer_auth_guard_denials') is not null
         as has_sequence,
       to_regprocedure(
         'private.assert_reviewer_auth_credential_cutover()'
       ) is not null as has_assertion,
       exists (
         select 1 from supabase_migrations.schema_migrations
         where version = '20260811203000'
       ) as recorded`,
  );
  assert(earlyApplied.rows[0].has_sequence, "repaired original cutover omitted sequence");
  assert(earlyApplied.rows[0].has_assertion, "repaired original cutover omitted assertion");
  assert(earlyApplied.rows[0].recorded, "repaired original cutover omitted history");
  await database.end();
  database = undefined;

  // Represents a prelaunch environment whose schema history already contains
  // every version before the reviewer lifecycle forward migration.
  supabase(
    "db", "reset", "--local", "--yes", "--no-seed",
    "--version", "20260812115130",
  );
  database = new Client({ connectionString: localDatabaseUrl() });
  await database.connect();
  const before = await database.query(
    "select to_regclass('private.reviewer_fixture_items') is null as absent",
  );
  assert(before.rows[0].absent, "reviewer lifecycle unexpectedly existed before upgrade");

  // The previous cutover accepted raw_user_meta_data. Seed an active legacy
  // reviewer that is valid under that definition but invalid under the
  // stricter Admin createUser shape introduced by the pending migration.
  const legacyAuthUserId = "d7100000-0000-4000-8000-000000000001";
  await database.query(
    `insert into auth.users (
       id, created_at, updated_at, email, encrypted_password,
       email_confirmed_at, is_anonymous, is_sso_user,
       role, aud, is_super_admin, banned_until,
       raw_app_meta_data, raw_user_meta_data
     ) values (
       $1, now(), now(), 'reviewer-upgrade@example.test',
       'reviewer-upgrade-test-hash', now(), false, false,
       'authenticated', 'authenticated', false, null,
       '{"provider":"email","providers":["email"]}',
       '{"display_name":"legacy-user-metadata"}'
     )`,
    [legacyAuthUserId],
  );
  await database.query(
    `insert into auth.identities (
       id, user_id, provider_id, identity_data, provider,
       last_sign_in_at, created_at, updated_at
     ) values (
       'd7110000-0000-4000-8000-000000000001', $1::uuid, $1::uuid::text,
       jsonb_build_object(
         'sub', $1::text,
         'email', 'reviewer-upgrade@example.test',
         'email_verified', true
       ),
       'email', now(), now(), now()
     )`,
    [legacyAuthUserId],
  );
  const legacyBinding = await database.query(
    `select user_id
     from private.user_identities
     where auth_user_id = $1 and revoked_at is null`,
    [legacyAuthUserId],
  );
  assert(legacyBinding.rowCount === 1, "legacy reviewer has no active logical binding");
  const legacyUserId = legacyBinding.rows[0].user_id;
  await database.query(
    `insert into private.reviewer_accounts (
       user_id, store_platform, fixture_version
     ) values ($1, 'app_store', 'legacy-upgrade-reviewer')`,
    [legacyUserId],
  );
  const oldInvariant = await database.query(
    "select private.reviewer_auth_credential_is_valid($1) as valid",
    [legacyUserId],
  );
  assert(oldInvariant.rows[0].valid, "legacy reviewer did not satisfy the prior invariant");

  // schema_migrations stores statement text, not a checksum. Change only the
  // throwaway local history payload to prove pending migration selection is by
  // already-applied version and does not replay the six prelaunch wrappers.
  await database.query(
    `update supabase_migrations.schema_migrations
     set statements = array['-- simulated prelaunch applied statement history']
     where version = any($1::text[])`,
    [[
      "20260811203000",
      "20260811203200",
      "20260812023250",
      "20260812050431",
      "20260812115129",
      "20260812115130",
    ]],
  );
  await database.end();
  database = undefined;

  const failedUpgrade = supabaseMustFail("migration", "up", "--local", "--yes");
  assert(
    failedUpgrade.includes("active reviewer credential cutover validation failed"),
    "invalid active reviewer did not fail the stricter cutover without identifiers",
  );
  assert(
    !failedUpgrade.includes(legacyAuthUserId)
      && !failedUpgrade.includes(String(legacyUserId))
      && !failedUpgrade.includes("reviewer-upgrade@example.test"),
    "invalid reviewer cutover error exposed a credential identifier",
  );

  database = new Client({ connectionString: localDatabaseUrl() });
  await database.connect();
  const rolledBack = await database.query(
    `select
       to_regclass('private.reviewer_fixture_items') is null as inventory_absent,
       not exists (
         select 1 from supabase_migrations.schema_migrations
         where version = '20260813053632'
       ) as history_absent,
       to_regclass('private.reviewer_access_actions') is null as actions_absent,
       not exists (
         select 1 from pg_trigger
         where tgrelid = 'auth.users'::regclass
           and tgname = 'auth_users_guard_reviewer_user_metadata'
           and not tgisinternal
       ) as metadata_guard_absent,
       private.reviewer_auth_credential_is_valid($1) as prior_invariant_restored`,
    [legacyUserId],
  );
  assert(rolledBack.rows[0].inventory_absent, "failed cutover left fixture inventory behind");
  assert(rolledBack.rows[0].history_absent, "failed cutover recorded migration history");
  assert(rolledBack.rows[0].actions_absent, "failed cutover left lifecycle audit schema behind");
  assert(rolledBack.rows[0].metadata_guard_absent, "failed cutover left metadata guard behind");
  assert(
    rolledBack.rows[0].prior_invariant_restored,
    "failed cutover did not roll back the stricter credential function",
  );

  // Repair the throwaway legacy row through the state that the old guard
  // explicitly permits, then prove the same forward migration can succeed.
  await database.query(
    `update auth.users
     set raw_user_meta_data = '{}',
         role = 'authenticated',
         aud = 'authenticated',
         is_super_admin = false,
         banned_until = null
     where id = $1`,
    [legacyAuthUserId],
  );
  await database.end();
  database = undefined;

  supabase("migration", "up", "--local", "--yes");
  database = new Client({ connectionString: localDatabaseUrl() });
  await database.connect();
  const after = await database.query(
    `select
       to_regclass('private.reviewer_fixture_items') is not null as has_inventory,
       to_regprocedure(
         'api_private.provision_reviewer_access(uuid,uuid,text,text,uuid,bigint,text)'
       ) is not null as has_provision,
       exists (
         select 1 from supabase_migrations.schema_migrations
         where version = '20260813053632'
       ) as recorded`,
  );
  assert(after.rows[0].has_inventory, "upgrade did not install fixture inventory");
  assert(after.rows[0].has_provision, "upgrade did not install provision RPC");
  assert(after.rows[0].recorded, "upgrade history did not record reviewer migration");
  console.log(
    "Reviewer fixture upgrade: invalid active reviewer rollback and repaired forward migration passed",
  );
} finally {
  if (database !== undefined) await database.end().catch(() => undefined);
  // Leave the shared local project at the full fresh schema for subsequent
  // pgTAP, HTTP E2E, lint, and advisor gates.
  supabase("db", "reset", "--local", "--yes");
}
