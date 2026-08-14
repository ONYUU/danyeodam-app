import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import process from "node:process";

import pg from "pg";

import {
  createLocalizedSpotCardFixture,
  retireLocalizedSpotCardFixture,
} from "./lib/localized-fixture.mjs";
import { createPolicyFixture, retirePolicyFixture } from "./lib/policy-fixture.mjs";

const { Client } = pg;

function databaseUrl() {
  if (process.env.DANYEODAM_DB_URL !== undefined) return process.env.DANYEODAM_DB_URL;
  const output = execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["supabase", "status", "-o", "env"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const line = output.split(/\r?\n/u).find((candidate) => candidate.startsWith('DB_URL="'));
  if (line === undefined) throw new Error("DB_URL missing from local Supabase status");
  return line.slice('DB_URL="'.length, -1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function connect() {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  await client.query("set statement_timeout = '10s'");
  return client;
}

async function waitForBlock(observer, blockedPid, blockerPid, label) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const result = await observer.query(
      "select $2::integer = any(pg_blocking_pids($1)) as blocked",
      [blockedPid, blockerPid],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} did not reach expected lock wait`);
}

async function waitForAnyLock(observer, blockedPid, label) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const result = await observer.query(
      `select wait_event_type from pg_stat_activity where pid = $1`,
      [blockedPid],
    );
    if (result.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} did not reach expected lock wait`);
}

const admin = await connect();
const blocker = await connect();
const resetClient = await connect();
const revokeClient = await connect();
const metadataClient = await connect();
const ageClient = await connect();

const adminAuthUserId = randomUUID();
const reviewerAuthUserId = randomUUID();
const metadataAuthUserId = randomUUID();
const contentFixtures = [];
let policyFixture;
let reviewerUserId;
let metadataUserId;
let inviteHash;

try {
  for (const [authUserId, label] of [
    [adminAuthUserId, "admin"],
    [reviewerAuthUserId, "reviewer"],
    [metadataAuthUserId, "metadata-reviewer"],
  ]) {
    await admin.query(
      `insert into auth.users (
         id, created_at, updated_at, email, encrypted_password,
         email_confirmed_at, is_anonymous, is_sso_user,
         role, aud, is_super_admin, banned_until,
         raw_app_meta_data, raw_user_meta_data
       ) values (
         $1, now(), now(), $2, $3, now(), false, false,
         'authenticated', 'authenticated', false, null,
         '{"provider":"email","providers":["email"]}', '{}'
       )`,
      [authUserId, `${label}-${authUserId}@example.test`, `${label}-test-hash`],
    );
    await admin.query(
      `insert into auth.identities (
         id, user_id, provider_id, identity_data, provider,
         last_sign_in_at, created_at, updated_at
       ) values (
         gen_random_uuid(), $1::uuid, $1::uuid::text,
         jsonb_build_object(
           'sub', $1::uuid::text,
           'email', $2::text,
           'email_verified', true
         ),
         'email', now(), now(), now()
       )`,
      [authUserId, `${label}-${authUserId}@example.test`],
    );
  }
  reviewerUserId = (
    await admin.query(
      `select user_id from private.user_identities
       where auth_user_id = $1 and revoked_at is null`,
      [reviewerAuthUserId],
    )
  ).rows[0].user_id;
  metadataUserId = (
    await admin.query(
      `select user_id from private.user_identities
       where auth_user_id = $1 and revoked_at is null`,
      [metadataAuthUserId],
    )
  ).rows[0].user_id;
  await admin.query(
    "insert into private.admin_members (auth_user_id) values ($1)",
    [adminAuthUserId],
  );

  // Designation holds target advisory + auth.users until commit. A raw user
  // metadata update that starts behind it must fail closed, never become a
  // post-designation custom value through an MVCC/row-lock race.
  await blocker.query("begin");
  await blocker.query(
    `insert into private.reviewer_accounts (
       user_id, store_platform, fixture_version, granted_by_auth_user_id
     ) values ($1, 'play_store', 'metadata-race-v1', $2)`,
    [metadataUserId, adminAuthUserId],
  );
  const metadataMutationPromise = metadataClient.query(
    `update auth.users
     set raw_user_meta_data = '{"display_name":"forbidden"}'::jsonb
     where id = $1`,
    [metadataAuthUserId],
  ).then(
    (result) => ({ result }),
    (error) => ({ error }),
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  await blocker.query("commit");
  const metadataMutation = await metadataMutationPromise;
  assert(
    metadataMutation.error?.code === "23514",
    "designation-first race allowed reviewer user metadata mutation",
  );
  const slugs = [
    "seoul-cheongjin-lol-park-nearby-exterior",
    "seoul-gwanghwamun-square",
    "seoul-ddp-history-park",
    "seoul-hongdae-red-road-r1",
    "seoul-seokchon-lake-park",
    "seoul-olympic-park",
  ];
  for (const [index, slug] of slugs.entries()) {
    const fixture = await createLocalizedSpotCardFixture(admin, {
      approvalAuthUserId: adminAuthUserId,
      cardCode: `reviewer-concurrency-${adminAuthUserId}-${index + 1}`,
      cardId: randomUUID(),
      cardTitle: `Reviewer Concurrency ${index + 1}`,
      colorHex: "#355F55",
      latitude: 37.50 + index * 0.001,
      longitude: 126.90 + index * 0.001,
      regionCode: `reviewer-concurrency-${adminAuthUserId}-${index + 1}`,
      sketchPath: `reviewer-concurrency/${index + 1}.webp`,
      spotId: randomUUID(),
      spotName: `Reviewer Concurrency ${index + 1}`,
      spotSlug: slug,
    });
    contentFixtures.push(fixture);
  }
  policyFixture = await createPolicyFixture(admin, { authUserIds: [] });

  // Provision prepare owns the same target advisory as invite redemption.
  // An invite that starts while prepare is uncommitted must wait, then see
  // reviewer history and fail without consuming the code or opening access.
  const provisionActionId = randomUUID();
  inviteHash = randomBytes(32).toString("hex");
  await admin.query(
    `insert into private.participant_invite_codes (code_hash)
     values (decode($1, 'hex'))`,
    [inviteHash],
  );
  await blocker.query("begin");
  const prepared = await blocker.query(
    `select api_private.provision_reviewer_access(
       $1, $2, 'app_store', 'concurrency-v1', $3, 1234, repeat('a', 64)
     ) as result`,
    [adminAuthUserId, reviewerUserId, provisionActionId],
  );
  assert(
    prepared.rows[0]?.result?.status === "prepared",
    "reviewer concurrency provision did not prepare",
  );
  const invitePromise = metadataClient.query(
    `select api_private.redeem_participant_invite($1, $2) as result`,
    [reviewerAuthUserId, inviteHash],
  );
  await waitForBlock(admin, metadataClient.processID, blocker.processID, "reviewer invite");
  await blocker.query("commit");
  const invite = await invitePromise;
  assert(
    invite.rows[0]?.result?.status === "not_found",
    "invite redemption crossed reviewer provision prepare",
  );
  const inviteBoundary = await admin.query(
    `select
       not exists (
         select 1 from private.participant_access where user_id = $1
       ) as access_closed,
       exists (
         select 1 from private.participant_invite_codes
         where code_hash = decode($2, 'hex') and redeemed_at is null
       ) as invite_unconsumed`,
    [reviewerUserId, inviteHash],
  );
  assert(inviteBoundary.rows[0].access_closed, "blocked invite opened reviewer access");
  assert(inviteBoundary.rows[0].invite_unconsumed, "blocked invite was consumed");
  const photoObjectId = prepared.rows[0].result.photo_object_id;

  // Completion is not rate-counted twice, but it still locks and revalidates
  // the exact admin authorization. A membership revoke that commits while the
  // continuation waits must make completion fail closed and remain retryable.
  await blocker.query("begin");
  await blocker.query(
    `update private.admin_members
     set revoked_at = clock_timestamp()
     where auth_user_id = $1`,
    [adminAuthUserId],
  );
  const revokedAdminCompletePromise = resetClient.query(
    `select api_private.complete_reviewer_access_fixture(
       $1, $2, $3, $4, 1234, repeat('a', 64)
     ) as result`,
    [adminAuthUserId, reviewerUserId, provisionActionId, photoObjectId],
  );
  await waitForBlock(
    admin,
    resetClient.processID,
    blocker.processID,
    "reviewer completion behind admin revoke",
  );
  await blocker.query("commit");
  const revokedAdminComplete = await revokedAdminCompletePromise;
  assert(
    revokedAdminComplete.rows[0]?.result?.status === "forbidden",
    "admin revoke crossed a prepared reviewer completion",
  );
  const revokedAdminBoundary = await admin.query(
    `select
       not exists (
         select 1 from private.participant_access where user_id = $1
       ) as access_closed,
       exists (
         select 1 from private.reviewer_access_actions
         where client_action_id = $2 and completed_result_json is null
       ) as action_retryable`,
    [reviewerUserId, provisionActionId],
  );
  assert(revokedAdminBoundary.rows[0].access_closed, "revoked admin opened access");
  assert(revokedAdminBoundary.rows[0].action_retryable, "revoked admin consumed action");
  await admin.query(
    `update private.admin_members
     set revoked_at = null
     where auth_user_id = $1`,
    [adminAuthUserId],
  );

  // Writer-first: a real-user minimum-age mutation committed after prepare
  // must make provision completion fail closed without opening membership.
  await ageClient.query("begin");
  const writerFirst = await ageClient.query(
    `select api_private.record_minimum_age_attestation(
       $1,
       '{"minimum_age_passed":true,"version":"18plus-v1"}'::jsonb
     ) as result`,
    [reviewerAuthUserId],
  );
  assert(
    writerFirst.rows[0]?.result?.status === "attested",
    "writer-first minimum-age mutation did not stage",
  );
  const contaminatedCompletePromise = resetClient.query(
    `select api_private.complete_reviewer_access_fixture(
       $1, $2, $3, $4, 1234, repeat('a', 64)
     ) as result`,
    [adminAuthUserId, reviewerUserId, provisionActionId, photoObjectId],
  );
  await waitForBlock(
    admin,
    resetClient.processID,
    ageClient.processID,
    "provision complete behind minimum age",
  );
  await ageClient.query("commit");
  const contaminatedComplete = await contaminatedCompletePromise;
  assert(
    contaminatedComplete.rows[0]?.result?.status === "fixture_conflict",
    "writer-first minimum-age mutation crossed pristine completion",
  );
  const writerFirstBoundary = await admin.query(
    `select
       not exists (
         select 1 from private.participant_access where user_id = $1
       ) as access_closed,
       not exists (
         select 1 from private.reviewer_fixture_items
         where user_id = $1 and revoked_at is null
       ) as fixture_empty,
       exists (
         select 1 from private.reviewer_access_actions
         where client_action_id = $2 and completed_result_json is null
       ) as action_retryable`,
    [reviewerUserId, provisionActionId],
  );
  assert(writerFirstBoundary.rows[0].access_closed, "pristine conflict opened access");
  assert(writerFirstBoundary.rows[0].fixture_empty, "pristine conflict installed fixture items");
  assert(writerFirstBoundary.rows[0].action_retryable, "pristine conflict consumed action");
  await admin.query(
    "delete from private.minimum_age_attestations where user_id = $1",
    [reviewerUserId],
  );

  // Complete-first: hold complete after its identity row lock but before its
  // owner lock. The user mutation must block on the same identity, then resume
  // only after the fully-applied reviewer fixture commits.
  await blocker.query("begin");
  await blocker.query(
    `select pg_advisory_xact_lock(hashtextextended(
       'danyeodam:suspend-owner:' || $1::text,
       0
     ))`,
    [reviewerUserId],
  );
  const completePromise = resetClient.query(
    `select api_private.complete_reviewer_access_fixture(
       $1, $2, $3, $4, 1234, repeat('a', 64)
     ) as result`,
    [adminAuthUserId, reviewerUserId, provisionActionId, photoObjectId],
  );
  await waitForBlock(admin, resetClient.processID, blocker.processID, "provision complete");
  const completeFirstAgePromise = ageClient.query(
    `select api_private.record_minimum_age_attestation(
       $1,
       '{"minimum_age_passed":true,"version":"18plus-v1"}'::jsonb
     ) as result`,
    [reviewerAuthUserId],
  );
  await waitForBlock(admin, ageClient.processID, resetClient.processID, "minimum age after complete");
  await blocker.query("commit");
  const completed = await completePromise;
  const completeFirstAge = await completeFirstAgePromise;
  assert(
    completed.rows[0]?.result?.status === "applied",
    "reviewer fixture did not complete after blocked invite",
  );
  assert(
    completeFirstAge.rows[0]?.result?.status === "attested",
    "minimum-age writer did not resume after complete committed",
  );

  await blocker.query("begin");
  await blocker.query(
    `select pg_advisory_xact_lock(hashtextextended(
       'danyeodam:recovery:target:' || $1::text,
       0
     ))`,
    [reviewerUserId],
  );

  const resetActionId = randomUUID();
  const revokeActionId = randomUUID();
  const resetPromise = resetClient.query(
    `select api_private.reset_reviewer_access(
       $1, $2, $3, 1234, repeat('a', 64)
     ) as result`,
    [adminAuthUserId, reviewerUserId, resetActionId],
  );
  await waitForBlock(admin, resetClient.processID, blocker.processID, "reset");

  const revokePromise = revokeClient.query(
    "select api_private.revoke_reviewer_access($1, $2, $3) as result",
    [adminAuthUserId, reviewerUserId, revokeActionId],
  );
  // Same-admin rate accounting is serialized before the target lock, so the
  // revoke may wait directly on reset while reset waits on the target blocker.
  await waitForAnyLock(admin, revokeClient.processID, "revoke");
  await blocker.query("commit");

  const [reset, revoke] = await Promise.all([resetPromise, revokePromise]);
  const statuses = [reset.rows[0].result.status, revoke.rows[0].result.status];
  assert(
    (
      statuses.includes("prepared") && statuses.includes("revoked")
    ) || (
      statuses.includes("not_found") && statuses.includes("revoked")
    ),
    `reset/revoke race did not serialize fail closed: ${JSON.stringify(statuses)}`,
  );

  const activeReviewer = await admin.query(
    `select exists (
       select 1 from private.reviewer_accounts
       where user_id = $1 and revoked_at is null
     ) as active`,
    [reviewerUserId],
  );
  assert(!activeReviewer.rows[0].active, "serialized revoke left active reviewer state");

  console.log(
    "Reviewer fixture concurrency: metadata/invite/admin/minimum-age/reset/revoke serialization passed",
  );
} finally {
  await blocker.query("rollback").catch(() => undefined);
  await ageClient.query("rollback").catch(() => undefined);
  if (inviteHash !== undefined) {
    await admin.query(
      "delete from private.participant_invite_codes where code_hash = decode($1, 'hex')",
      [inviteHash],
    ).catch(() => undefined);
  }
  if (reviewerUserId !== undefined) {
    await admin.query(
      `update private.reviewer_access_actions
       set completed_result_json = jsonb_build_object('status', 'applied')
       where target_fingerprint = private.reviewer_lifecycle_target_fingerprint($1)
         and completed_result_json is null`,
      [reviewerUserId],
    ).catch(() => undefined);
    await admin.query("delete from public.app_users where id = $1", [reviewerUserId])
      .catch(() => undefined);
  }
  if (metadataUserId !== undefined) {
    await admin.query("delete from public.app_users where id = $1", [metadataUserId])
      .catch(() => undefined);
  }
  for (const fixture of contentFixtures.reverse()) {
    await retireLocalizedSpotCardFixture(admin, fixture).catch(() => undefined);
  }
  if (policyFixture !== undefined) {
    await retirePolicyFixture(admin, policyFixture).catch(() => undefined);
  }
  await admin.query("delete from auth.users where id = any($1::uuid[])", [
    [adminAuthUserId, reviewerAuthUserId, metadataAuthUserId],
  ]).catch(() => undefined);
  await Promise.all([admin, blocker, resetClient, revokeClient, metadataClient, ageClient].map(
    (client) => client.end().catch(() => undefined),
  ));
}
