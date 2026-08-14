import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import process from "node:process";

import pg from "pg";

import {
  createLocalizedSpotCardFixture,
  retireLocalizedSpotCardFixture,
} from "./lib/localized-fixture.mjs";
import { createPolicyFixture, retirePolicyFixture } from "./lib/policy-fixture.mjs";

const { Client } = pg;

function readLocalDatabaseUrl() {
  if (process.env.DANYEODAM_DB_URL !== undefined) {
    return process.env.DANYEODAM_DB_URL;
  }
  const output = execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["supabase", "status", "-o", "env"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const line = output
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith('DB_URL="'));
  if (line === undefined) {
    throw new Error("DB_URL missing from local Supabase status");
  }
  return line.slice('DB_URL="'.length, -1);
}

const databaseUrl = readLocalDatabaseUrl();

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function connect() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query("set statement_timeout = '10s'");
  return client;
}

async function waitForLock(observer, processId, label) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const result = await observer.query(
      `select wait_event_type, wait_event
       from pg_stat_activity
       where pid = $1`,
      [processId],
    );
    if (result.rows[0]?.wait_event_type === "Lock") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} did not reach the expected lock wait`);
}

async function createAuthUser(client, authUserId, isAnonymous = true) {
  await client.query(
    `insert into auth.users (
       id, created_at, updated_at, is_anonymous, raw_user_meta_data
     ) values ($1, now(), now(), $2, '{}'::jsonb)`,
    [authUserId, isAnonymous],
  );
  const identity = await client.query(
    `select user_id
     from private.user_identities
     where auth_user_id = $1 and revoked_at is null`,
    [authUserId],
  );
  assert(identity.rowCount === 1, "auth trigger did not create one active identity");
  return identity.rows[0].user_id;
}

async function makeReusableEmailCredential(client, authUserId, email, passwordHash) {
  await client.query(
    `update auth.users
     set email = $2,
         encrypted_password = $3,
         email_confirmed_at = clock_timestamp(),
         is_anonymous = false,
         is_sso_user = false,
         role = 'authenticated',
         aud = 'authenticated',
         is_super_admin = false,
         banned_until = null,
         raw_app_meta_data = jsonb_build_object(
           'provider', 'email',
           'providers', jsonb_build_array('email')
         ),
         raw_user_meta_data = '{}'::jsonb
     where id = $1`,
    [authUserId, email, passwordHash],
  );
  await client.query(
    `insert into auth.identities (
       id, user_id, provider_id, identity_data, provider,
       last_sign_in_at, created_at, updated_at
     ) values (
       gen_random_uuid(), $1::uuid, $1::text,
       jsonb_build_object(
         'sub', $1::text,
         'email', $2::text,
         'email_verified', true
       ),
       'email', clock_timestamp(), clock_timestamp(), clock_timestamp()
     )`,
    [authUserId, email],
  );
}

function resultStatus(queryResult) {
  return queryResult.rows[0]?.result?.status;
}

function captureQuery(promise) {
  return promise.then(
    (result) => ({ result, error: undefined }),
    (error) => ({ result: undefined, error }),
  );
}

function assertStatus(queryResult, expectedStatus, label) {
  assert(
    resultStatus(queryResult) === expectedStatus,
    `${label}: ${JSON.stringify(queryResult.rows[0]?.result)}`,
  );
}

async function createPolicyDocumentSet(client, version) {
  const documents = [
    { id: randomUUID(), type: "terms_of_use" },
    { id: randomUUID(), type: "privacy_policy" },
    { id: randomUUID(), type: "community_guidelines" },
    { id: randomUUID(), type: "location_terms" },
  ];
  for (const document of documents) {
    await client.query(
      `insert into private.policy_documents (
         id, policy_type, version, effective_at, published_at, is_current
       ) values ($1, $2, $3, now() - interval '1 minute', now(), false)`,
      [document.id, document.type, version],
    );
    await client.query(
      `insert into private.policy_document_locales (
         policy_document_id, locale, document_url, sha256
       )
       select $1::uuid, locale_row.locale,
         'https://policies.test/' || $1::uuid::text || '/' || locale_row.locale::text,
         extensions.digest($1::uuid::text || ':' || locale_row.locale::text, 'sha256')
       from unnest(enum_range(null::public.content_locale)) as locale_row(locale)`,
      [document.id],
    );
  }
  return documents;
}

async function recordAdultAttestation(client, authUserId) {
  const result = await client.query(
    `select api_private.record_minimum_age_attestation(
       $1, '{"minimum_age_passed":true,"version":"18plus-v1"}'::jsonb
     ) as result`,
    [authUserId],
  );
  assertStatus(result, "attested", "minimum-age attestation fixture failed");
}

async function acceptCurrentUgcPolicies(client, authUserId, version) {
  const result = await client.query(
    `select api_private.accept_current_policies(
       $1,
       jsonb_build_array(
         jsonb_build_object(
           'type', 'terms_of_use', 'version', $2::text, 'locale', 'ko'
         ),
         jsonb_build_object(
           'type', 'community_guidelines', 'version', $2::text, 'locale', 'ko'
         )
       )
     ) as result`,
    [authUserId, version],
  );
  assertStatus(result, "accepted", "UGC policy acceptance fixture failed");
}

let nextFieldSequence = 1_000;

async function createDirectFieldAcquisition(
  client,
  { userId, spotId, cardId, aged = false },
) {
  const idempotencyKey = randomUUID();
  const fieldSequence = nextFieldSequence;
  nextFieldSequence += 1;
  await client.query(
    `insert into private.location_use_facts (
       user_id, idempotency_key, spot_id, purpose, collected_at
     ) values (
       $1::uuid, $2::uuid, $3::uuid, 'field_acquisition',
       case when $4::boolean then now() - interval '7 months' else now() end
     )
     returning collected_at`,
    [userId, idempotencyKey, spotId, aged],
  );
  const result = await client.query(
    `insert into public.acquisitions (
       user_id, spot_id, card_id, acquisition_type, verification_result,
       idempotency_key, field_sequence, acquired_at
     )
     select
       $1::uuid, $2::uuid, $3::uuid, 'field', 'passed',
       $4::uuid, $5::bigint, fact_row.collected_at
     from private.location_use_facts as fact_row
     where fact_row.user_id = $1::uuid
       and fact_row.idempotency_key = $4::uuid
       and fact_row.purpose = 'field_acquisition'
     returning id, acquired_at`,
    [userId, spotId, cardId, idempotencyKey, fieldSequence],
  );
  if (aged) {
    await client.query(
      `delete from private.location_use_facts
       where user_id = $1::uuid
         and idempotency_key = $2::uuid
         and purpose = 'field_acquisition'`,
      [userId, idempotencyKey],
    );
  } else {
    await client.query(
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
       where acquisition_row.id = $1::uuid`,
      [result.rows[0].id],
    );
  }
  return { id: result.rows[0].id, idempotencyKey };
}

async function createCorrectionRequest(
  client,
  { authUserId, locationUseFactId = null, fieldAcquisitionId = null },
) {
  const result = await client.query(
    `select api_private.create_location_correction_request(
       $1, $2, $3, $4, 'wrong_spot'
     ) as result`,
    [authUserId, locationUseFactId, fieldAcquisitionId, randomUUID()],
  );
  assertStatus(result, "created", "location-correction request fixture failed");
  return result.rows[0].result.correction_request_id;
}

async function approveCorrection(client, adminAuthUserId, correctionRequestId) {
  const result = await client.query(
    `select api_private.resolve_location_correction_admin(
       $1, $2, 'accepted'
     ) as result`,
    [adminAuthUserId, correctionRequestId],
  );
  assertStatus(result, "correction_pending", "location-correction approval failed");
  return result.rows[0].result.erasure_job_id;
}

async function leaseErasureJob(client, workerToken, erasureJobId) {
  await client.query(
    `update private.data_erasure_jobs
     set requested_at = clock_timestamp() - interval '100 years',
         next_attempt_at = clock_timestamp() - interval '1 second'
     where id = $1`,
    [erasureJobId],
  );
  const claimed = await client.query(
    `select api_private.claim_data_erasure_jobs($1, 2, 4) as result`,
    [workerToken],
  );
  assertStatus(claimed, "ready", "data-erasure job claim failed");
  assert(
    claimed.rows[0].result.jobs.some((job) => job.id === erasureJobId),
    `target erasure job was not leased: ${erasureJobId}`,
  );
}

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const ids = {
  inviteA: randomUUID(),
  inviteB: randomUUID(),
  issueTarget: randomUUID(),
  issueClaimant: randomUUID(),
  acquireTarget: randomUUID(),
  acquireClaimant: randomUUID(),
  retroAdmin: randomUUID(),
  retroClaimant: randomUUID(),
  blockViewer: randomUUID(),
  blockOwnerA: randomUUID(),
  blockOwnerB: randomUUID(),
  reviewerRace: randomUUID(),
  reviewerTargetRace: randomUUID(),
  reviewerTargetClaimant: randomUUID(),
  reviewerCurrentTarget: randomUUID(),
  reviewerCurrentClaimant: randomUUID(),
  reviewerLinkFirst: randomUUID(),
  reviewerDesignationFirst: randomUUID(),
  consentWithdrawalFirst: randomUUID(),
  consentAcceptanceFirst: randomUUID(),
  purgeWithdrawalRace: randomUUID(),
  approvalVsContext: randomUUID(),
  approvalVsCommit: randomUUID(),
  approvalVsFailure: randomUUID(),
  finishVsContext: randomUUID(),
  finishVsCommit: randomUUID(),
  finishVsFailure: randomUUID(),
  sameClaimTarget: randomUUID(),
  sameClaimClaimant: randomUUID(),
  ageFirstTarget: randomUUID(),
  ageFirstClaimant: randomUUID(),
  claimFirstTarget: randomUUID(),
  claimFirstClaimant: randomUUID(),
  locationRecoveryTarget: randomUUID(),
  locationRecoveryClaimant: randomUUID(),
  rateRecoveryTarget: randomUUID(),
  rateRecoveryClaimant: randomUUID(),
  crossRecoveryA: randomUUID(),
  crossRecoveryB: randomUUID(),
  giftDerivativeOwner: randomUUID(),
  retroDerivativeOwner: randomUUID(),
  ledgerOwner: randomUUID(),
  photoIdempotency: randomUUID(),
  photoDeletionModeration: randomUUID(),
  deletionRecoveryTarget: randomUUID(),
  deletionRecoveryClaimant: randomUUID(),
  deletionInviteTarget: randomUUID(),
  deletionUploadTarget: randomUUID(),
  deletionPromotionTarget: randomUUID(),
  deletionShareTarget: randomUUID(),
  deletionModerationTarget: randomUUID(),
  deletionLocationTarget: randomUUID(),
  deletionFairnessPoison: randomUUID(),
  deletionFairnessNew: randomUUID(),
  spotOne: randomUUID(),
  spotTwo: randomUUID(),
  spotRace: randomUUID(),
  cardOne: randomUUID(),
  cardTwo: randomUUID(),
  cardRace: randomUUID(),
  blockPersonalCardA: randomUUID(),
  blockPersonalCardB: randomUUID(),
  moderationFieldCard: randomUUID(),
  photoDeletionCardFirst: randomUUID(),
  photoModerationCardFirst: randomUUID(),
  photoDeletionReportFirst: randomUUID(),
  photoModerationReportFirst: randomUUID(),
  suspendPersonalCardA: randomUUID(),
  giftDerivativeCard: randomUUID(),
  retroDerivativeCard: randomUUID(),
};
const fixtureAuthUserIds = [
  ids.inviteA,
  ids.inviteB,
  ids.issueTarget,
  ids.issueClaimant,
  ids.acquireTarget,
  ids.acquireClaimant,
  ids.retroAdmin,
  ids.retroClaimant,
  ids.blockViewer,
  ids.blockOwnerA,
  ids.blockOwnerB,
  ids.reviewerRace,
  ids.reviewerTargetRace,
  ids.reviewerTargetClaimant,
  ids.reviewerCurrentTarget,
  ids.reviewerCurrentClaimant,
  ids.reviewerLinkFirst,
  ids.reviewerDesignationFirst,
  ids.consentWithdrawalFirst,
  ids.consentAcceptanceFirst,
  ids.purgeWithdrawalRace,
  ids.approvalVsContext,
  ids.approvalVsCommit,
  ids.approvalVsFailure,
  ids.finishVsContext,
  ids.finishVsCommit,
  ids.finishVsFailure,
  ids.sameClaimTarget,
  ids.sameClaimClaimant,
  ids.ageFirstTarget,
  ids.ageFirstClaimant,
  ids.claimFirstTarget,
  ids.claimFirstClaimant,
  ids.locationRecoveryTarget,
  ids.locationRecoveryClaimant,
  ids.rateRecoveryTarget,
  ids.rateRecoveryClaimant,
  ids.crossRecoveryA,
  ids.crossRecoveryB,
  ids.giftDerivativeOwner,
  ids.retroDerivativeOwner,
  ids.ledgerOwner,
  ids.photoIdempotency,
  ids.photoDeletionModeration,
  ids.deletionRecoveryTarget,
  ids.deletionRecoveryClaimant,
  ids.deletionInviteTarget,
  ids.deletionUploadTarget,
  ids.deletionPromotionTarget,
  ids.deletionShareTarget,
  ids.deletionModerationTarget,
  ids.deletionLocationTarget,
  ids.deletionFairnessPoison,
  ids.deletionFairnessNew,
];
const logicalUserIds = [];
const logicalUserByAuth = new Map();
const locationAttemptTombstones = [];
const transientPolicyDocumentIds = [];
const inviteHash = digest(`invite-${randomUUID()}`);
const oldIssueRecoveryHash = digest(`recovery-old-${randomUUID()}`);
const newIssueRecoveryHash = digest(`recovery-new-${randomUUID()}`);
const acquireRecoveryHash = digest(`recovery-acquire-${randomUUID()}`);
const reviewerRaceRecoveryHash = digest(`recovery-reviewer-race-${randomUUID()}`);
const reviewerTargetRecoveryHash = digest(`recovery-reviewer-target-${randomUUID()}`);
const reviewerCurrentRecoveryHash = digest(`recovery-reviewer-current-${randomUUID()}`);
const sameClaimRecoveryHash = digest(`recovery-same-claim-${randomUUID()}`);
const ageFirstRecoveryHash = digest(`recovery-age-first-${randomUUID()}`);
const claimFirstRecoveryHash = digest(`recovery-claim-first-${randomUUID()}`);
const locationRecoveryHash = digest(`recovery-location-${randomUUID()}`);
const rateRecoveryHash = digest(`recovery-rate-${randomUUID()}`);
const crossRecoveryHashA = digest(`recovery-cross-a-${randomUUID()}`);
const crossRecoveryHashB = digest(`recovery-cross-b-${randomUUID()}`);
const deletionRecoveryHash = digest(`recovery-account-delete-${randomUUID()}`);
const deletionInviteHash = digest(`invite-account-delete-${randomUUID()}`);
const accountDeletionRequestIds = [];

const clients = [];

function deletionRequestId() {
  const requestId = randomUUID();
  accountDeletionRequestIds.push(requestId);
  return requestId;
}

function deletionTokenHash() {
  return digest(`account-deletion-status-${randomUUID()}`);
}

async function queueWaitsForTransaction(observer, processId, blockerProcessId, label) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const blocked = await observer.query(
      `select $2::integer = any(pg_blocking_pids($1)) as blocked_by_transaction`,
      [processId, blockerProcessId],
    );
    if (blocked.rows[0]?.blocked_by_transaction) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} did not queue behind the deletion transaction`);
}

async function closeScenarioClients(...scenarioClients) {
  let firstError;
  for (const client of scenarioClients) {
    try {
      await client.end();
    } catch (error) {
      firstError ??= error;
    } finally {
      const trackedIndex = clients.indexOf(client);
      if (trackedIndex !== -1) {
        clients.splice(trackedIndex, 1);
      }
    }
  }
  if (firstError !== undefined) {
    throw firstError;
  }
}

let addedScenarioCount = 0;
let blocker;
let policyFixture;
let reviewerRaceUserId;
let reviewerTargetRaceUserId;
let reviewerCurrentTargetUserId;
let reviewerCurrentClaimantUserId;
let reviewerLinkFirstUserId;
let reviewerDesignationFirstUserId;

try {
  const admin = await connect();
  clients.push(admin);

  for (const authUserId of fixtureAuthUserIds) {
    const logicalUserId = await createAuthUser(admin, authUserId);
    logicalUserIds.push(logicalUserId);
    logicalUserByAuth.set(authUserId, logicalUserId);
  }

  await createLocalizedSpotCardFixture(admin, {
    approvalAuthUserId: ids.retroAdmin,
    cardCode: `concurrency-${suffix}-one`,
    cardId: ids.cardOne,
    cardTitle: "동시성 카드 1",
    colorHex: "#112233",
    regionCode: `concurrency-${suffix}-one`,
    sketchPath: "tests/one.webp",
    spotId: ids.spotOne,
    spotName: "동시성 1",
    spotSlug: `concurrency-${suffix}-one`,
  });
  await createLocalizedSpotCardFixture(admin, {
    approvalAuthUserId: ids.retroAdmin,
    cardCode: `concurrency-${suffix}-two`,
    cardId: ids.cardTwo,
    cardTitle: "동시성 카드 2",
    colorHex: "#445566",
    latitude: 37.6,
    longitude: 127.1,
    regionCode: `concurrency-${suffix}-two`,
    sketchPath: "tests/two.webp",
    spotId: ids.spotTwo,
    spotName: "동시성 2",
    spotSlug: `concurrency-${suffix}-two`,
  });
  await createLocalizedSpotCardFixture(admin, {
    approvalAuthUserId: ids.retroAdmin,
    cardCode: `concurrency-${suffix}-race`,
    cardId: ids.cardRace,
    cardTitle: "동시성 스냅샷 카드",
    colorHex: "#667788",
    latitude: 37.7,
    longitude: 127.2,
    regionCode: `concurrency-${suffix}-race`,
    sketchPath: "tests/race.webp",
    spotId: ids.spotRace,
    spotName: "동시성 스냅샷",
    spotSlug: `concurrency-${suffix}-race`,
  });

  const issueTargetUserId = logicalUserByAuth.get(ids.issueTarget);
  const acquireTargetUserId = logicalUserByAuth.get(ids.acquireTarget);
  const acquireClaimantUserId = logicalUserByAuth.get(ids.acquireClaimant);
  const retroClaimantUserId = logicalUserByAuth.get(ids.retroClaimant);
  const blockViewerUserId = logicalUserByAuth.get(ids.blockViewer);
  const blockOwnerAUserId = logicalUserByAuth.get(ids.blockOwnerA);
  const blockOwnerBUserId = logicalUserByAuth.get(ids.blockOwnerB);
  reviewerRaceUserId = logicalUserByAuth.get(ids.reviewerRace);
  reviewerTargetRaceUserId = logicalUserByAuth.get(ids.reviewerTargetRace);
  reviewerCurrentTargetUserId = logicalUserByAuth.get(ids.reviewerCurrentTarget);
  reviewerCurrentClaimantUserId = logicalUserByAuth.get(ids.reviewerCurrentClaimant);
  reviewerLinkFirstUserId = logicalUserByAuth.get(ids.reviewerLinkFirst);
  reviewerDesignationFirstUserId = logicalUserByAuth.get(ids.reviewerDesignationFirst);
  policyFixture = await createPolicyFixture(admin, {
    authUserIds: [
      ids.issueTarget,
      ids.acquireClaimant,
      ids.blockOwnerA,
      ids.blockOwnerB,
      ids.approvalVsContext,
      ids.approvalVsCommit,
      ids.approvalVsFailure,
      ids.finishVsContext,
      ids.finishVsCommit,
      ids.finishVsFailure,
      ids.locationRecoveryClaimant,
      ids.rateRecoveryClaimant,
      ids.giftDerivativeOwner,
      ids.retroDerivativeOwner,
      ids.ledgerOwner,
      ids.photoIdempotency,
    ],
  });

  for (const [authUserId, label] of [
    [ids.reviewerRace, "issue-race"],
    [ids.reviewerTargetRace, "target-race"],
    [ids.reviewerCurrentTarget, "current-target"],
    [ids.reviewerDesignationFirst, "designation-first"],
  ]) {
    await makeReusableEmailCredential(
      admin,
      authUserId,
      `${label}-${suffix}@example.test`,
      `test-hash-${label}-${suffix}`,
    );
  }
  const reviewerCredentialFixtures = await admin.query(
    `select bool_and(
       private.reviewer_auth_credential_is_valid(identity_row.user_id)
     ) as exact
     from private.user_identities as identity_row
     where identity_row.auth_user_id = any($1::uuid[])
       and identity_row.revoked_at is null`,
    [[
      ids.reviewerRace,
      ids.reviewerTargetRace,
      ids.reviewerCurrentTarget,
      ids.reviewerDesignationFirst,
    ]],
  );
  assert(
    reviewerCredentialFixtures.rows[0]?.exact,
    "reviewer concurrency fixtures do not satisfy the exact Auth invariant",
  );

  const ledgerOwnerUserId = logicalUserByAuth.get(ids.ledgerOwner);
  const photoDeletionModerationUserId = logicalUserByAuth.get(
    ids.photoDeletionModeration,
  );
  const ledgerAcquisition = await createDirectFieldAcquisition(admin, {
    userId: ledgerOwnerUserId,
    spotId: ids.spotRace,
    cardId: ids.cardRace,
  });

  await recordAdultAttestation(admin, ids.consentWithdrawalFirst);
  await recordAdultAttestation(admin, ids.consentAcceptanceFirst);

  await admin.query(
    `insert into private.admin_members (auth_user_id)
     values ($1)`,
    [ids.retroAdmin],
  );
  const suspendAcquisition = await admin.query(
    `insert into public.acquisitions (
       user_id, spot_id, card_id, acquisition_type, verification_result,
       idempotency_key
     ) values ($1, $2, $3, 'gift', 'not_applicable', $4)
     returning id`,
    [blockOwnerAUserId, ids.spotTwo, ids.cardTwo, randomUUID()],
  );
  await admin.query(
    `insert into public.personal_cards (
       id, user_id, acquisition_id, photo_path, caption
     ) values ($1, $2, $3, $4, 'suspension race')`,
    [
      ids.suspendPersonalCardA,
      blockOwnerAUserId,
      suspendAcquisition.rows[0].id,
      `${blockOwnerAUserId}/${ids.suspendPersonalCardA}.webp`,
    ],
  );
  await admin.query(
    `insert into private.participant_access (user_id, access_kind)
     values ($1, 'internal_tester'), ($2, 'internal_tester')`,
    [blockOwnerAUserId, blockOwnerBUserId],
  );

  const giftDerivativeOwnerUserId = logicalUserByAuth.get(ids.giftDerivativeOwner);
  const retroDerivativeOwnerUserId = logicalUserByAuth.get(ids.retroDerivativeOwner);
  const deletionUserByAuth = new Map(
    [
      ids.deletionRecoveryTarget,
      ids.deletionRecoveryClaimant,
      ids.deletionInviteTarget,
      ids.deletionUploadTarget,
      ids.deletionPromotionTarget,
      ids.deletionShareTarget,
      ids.deletionModerationTarget,
      ids.deletionLocationTarget,
      ids.deletionFairnessPoison,
      ids.deletionFairnessNew,
    ].map((authUserId) => [authUserId, logicalUserByAuth.get(authUserId)]),
  );

  for (const authUserId of [
    ids.deletionRecoveryTarget,
    ids.deletionPromotionTarget,
    ids.deletionShareTarget,
    ids.deletionModerationTarget,
  ]) {
    await admin.query(
      `insert into public.acquisitions (
         user_id, spot_id, card_id, acquisition_type, verification_result,
         idempotency_key
       ) values ($1, $2, $3, 'gift', 'not_applicable', $4)`,
      [deletionUserByAuth.get(authUserId), ids.spotOne, ids.cardOne, randomUUID()],
    );
  }
  await admin.query(
    `insert into private.recovery_codes (user_id, code_hash, expires_at)
     values ($1, decode($2, 'hex'), clock_timestamp() + interval '1 hour')`,
    [deletionUserByAuth.get(ids.deletionRecoveryTarget), deletionRecoveryHash],
  );
  await admin.query(
    `insert into private.participant_invite_codes (code_hash)
     values (decode($1, 'hex'))`,
    [deletionInviteHash],
  );
  await admin.query(
    `insert into private.participant_access (user_id, access_kind)
     values ($1, 'internal_tester'), ($2, 'internal_tester'), ($3, 'internal_tester')`,
    [
      deletionUserByAuth.get(ids.deletionPromotionTarget),
      deletionUserByAuth.get(ids.deletionShareTarget),
      deletionUserByAuth.get(ids.deletionModerationTarget),
    ],
  );
  for (const authUserId of [
    ids.deletionUploadTarget,
    ids.deletionPromotionTarget,
    ids.deletionShareTarget,
  ]) {
    await acceptCurrentUgcPolicies(admin, authUserId, policyFixture.version);
  }
  await recordAdultAttestation(admin, ids.deletionLocationTarget);
  const deletionLocationConsent = await admin.query(
    `select api_private.accept_location_consent(
       $1, jsonb_build_object('version', $2::text, 'locale', 'ko')
     ) as result`,
    [ids.deletionLocationTarget, policyFixture.version],
  );
  assertStatus(
    deletionLocationConsent,
    "active",
    "account deletion/location consent fixture failed",
  );

  const promotionAcquisition = await admin.query(
    `select id
     from public.acquisitions
     where user_id = $1
     order by acquired_at, id
     limit 1`,
    [deletionUserByAuth.get(ids.deletionPromotionTarget)],
  );
  const deletionPromotionUploadId = randomUUID();
  const deletionPromotionTempPath =
    `${deletionUserByAuth.get(ids.deletionPromotionTarget)}/${deletionPromotionUploadId}.jpg`;
  await admin.query(
    `insert into private.personal_card_temp_uploads (
       id, user_id, temp_path, declared_content_type, declared_size_bytes,
       issued_at, promotion_expires_at, signed_url_expires_at, quota_issued_at
     )
     select
       $1, $2, $3, 'image/jpeg', 1024,
       fixture_time.issued_at,
       fixture_time.issued_at + interval '10 minutes',
       fixture_time.issued_at + interval '2 hours',
       fixture_time.issued_at
     from (select clock_timestamp() as issued_at) as fixture_time`,
    [
      deletionPromotionUploadId,
      deletionUserByAuth.get(ids.deletionPromotionTarget),
      deletionPromotionTempPath,
    ],
  );

  const shareAcquisition = await admin.query(
    `select id
     from public.acquisitions
     where user_id = $1
     order by acquired_at, id
     limit 1`,
    [deletionUserByAuth.get(ids.deletionShareTarget)],
  );
  const deletionShareCardId = randomUUID();
  await admin.query(
    `insert into public.personal_cards (
       id, user_id, acquisition_id, photo_path, photo_size_bytes, caption
     ) values ($1, $2, $3, $4, 1, 'account deletion share race')`,
    [
      deletionShareCardId,
      deletionUserByAuth.get(ids.deletionShareTarget),
      shareAcquisition.rows[0].id,
      `${deletionUserByAuth.get(ids.deletionShareTarget)}/${deletionShareCardId}.webp`,
    ],
  );

  const moderationAcquisition = await admin.query(
    `select id
     from public.acquisitions
     where user_id = $1
     order by acquired_at, id
     limit 1`,
    [deletionUserByAuth.get(ids.deletionModerationTarget)],
  );
  const deletionModerationCardId = randomUUID();
  await admin.query(
    `insert into public.personal_cards (
       id, user_id, acquisition_id, photo_path, photo_size_bytes, caption,
       share_slug, shared_at, share_state, share_submitted_at,
       share_resubmission_required
     ) values (
       $1, $2, $3, $4, 1, 'account deletion moderation race',
       $5, clock_timestamp(), 'pending', clock_timestamp(), true
     )`,
    [
      deletionModerationCardId,
      deletionUserByAuth.get(ids.deletionModerationTarget),
      moderationAcquisition.rows[0].id,
      `${deletionUserByAuth.get(ids.deletionModerationTarget)}/${deletionModerationCardId}.webp`,
      randomUUID().replaceAll("-", ""),
    ],
  );

  const giftDerivativeAcquisition = await admin.query(
    `insert into public.acquisitions (
       user_id, spot_id, card_id, acquisition_type, verification_result,
       idempotency_key
     ) values ($1, $2, $3, 'gift', 'not_applicable', $4)
     returning id, user_id`,
    [
      giftDerivativeOwnerUserId,
      ids.spotOne,
      ids.cardOne,
      randomUUID(),
    ],
  );
  const retroDerivativeGrant = await admin.query(
    `select api_private.grant_retro_acquisition($1, $2, $3, $4) as result`,
    [
      ids.retroAdmin,
      retroDerivativeOwnerUserId,
      ids.spotTwo,
      "retro derivative policy race",
    ],
  );
  assert(
    resultStatus(retroDerivativeGrant) === "created",
    "retro derivative fixture did not create an audited acquisition",
  );
  const derivativeAcquisitionByOwner = new Map([
    [giftDerivativeOwnerUserId, giftDerivativeAcquisition.rows[0].id],
    [
      retroDerivativeOwnerUserId,
      retroDerivativeGrant.rows[0].result.acquisition.id,
    ],
  ]);
  await admin.query(
    `insert into public.personal_cards (
       id, user_id, acquisition_id, photo_path, caption
     ) values
       ($1, $3, $5, $7, 'gift derivative policy race'),
       ($2, $4, $6, $8, 'retro derivative policy race')`,
    [
      ids.giftDerivativeCard,
      ids.retroDerivativeCard,
      giftDerivativeOwnerUserId,
      retroDerivativeOwnerUserId,
      derivativeAcquisitionByOwner.get(giftDerivativeOwnerUserId),
      derivativeAcquisitionByOwner.get(retroDerivativeOwnerUserId),
      `${giftDerivativeOwnerUserId}/${ids.giftDerivativeCard}.webp`,
      `${retroDerivativeOwnerUserId}/${ids.retroDerivativeCard}.webp`,
    ],
  );
  await admin.query(
    `insert into private.participant_access (user_id, access_kind)
     values ($1, 'internal_tester'), ($2, 'internal_tester')`,
    [giftDerivativeOwnerUserId, retroDerivativeOwnerUserId],
  );

  const blockShareSlugA = randomUUID().replaceAll("-", "");
  const blockShareSlugB = randomUUID().replaceAll("-", "");
  const blockAcquisitions = await admin.query(
    `insert into public.acquisitions (
       user_id, spot_id, card_id, acquisition_type, verification_result,
       idempotency_key
     ) values
       ($1, $3, $4, 'gift', 'not_applicable', $5),
       ($2, $6, $7, 'gift', 'not_applicable', $8)
     returning id, user_id`,
    [
      blockOwnerAUserId,
      blockOwnerBUserId,
      ids.spotOne,
      ids.cardOne,
      randomUUID(),
      ids.spotTwo,
      ids.cardTwo,
      randomUUID(),
    ],
  );
  const acquisitionByOwner = new Map(
    blockAcquisitions.rows.map((row) => [row.user_id, row.id]),
  );
  await admin.query(
    `insert into public.personal_cards (
       id, user_id, acquisition_id, photo_path, caption
     ) values
       ($1, $3, $5, $7, 'block owner A'),
       ($2, $4, $6, $8, 'block owner B')`,
    [
      ids.blockPersonalCardA,
      ids.blockPersonalCardB,
      blockOwnerAUserId,
      blockOwnerBUserId,
      acquisitionByOwner.get(blockOwnerAUserId),
      acquisitionByOwner.get(blockOwnerBUserId),
      `${blockOwnerAUserId}/${ids.blockPersonalCardA}.webp`,
      `${blockOwnerBUserId}/${ids.blockPersonalCardB}.webp`,
    ],
  );
  for (const [authUserId, personalCardId, shareSlug] of [
    [ids.blockOwnerA, ids.blockPersonalCardA, blockShareSlugA],
    [ids.blockOwnerB, ids.blockPersonalCardB, blockShareSlugB],
  ]) {
    const pending = await admin.query(
      `select api_private.create_personal_card_share($1, false, true, $2, $3) as result`,
      [authUserId, personalCardId, shareSlug],
    );
    assert(
      resultStatus(pending) === "pending",
      `block target share submission failed: ${JSON.stringify(pending.rows[0]?.result)}`,
    );
    const approved = await admin.query(
      `select api_private.moderate_personal_card_share(
         $1, $2, $3, 'approve', 'POLICY_OK', 'concurrency block target', true
       ) as result`,
      [ids.retroAdmin, personalCardId, randomUUID()],
    );
    assert(
      resultStatus(approved) === "applied",
      `block target share approval failed: ${JSON.stringify(approved.rows[0]?.result)}`,
    );
  }

  const moderationFieldAcquisition = await createDirectFieldAcquisition(admin, {
    userId: blockOwnerAUserId,
    spotId: ids.spotRace,
    cardId: ids.cardRace,
  });
  await admin.query(
    `insert into public.personal_cards (
       id, user_id, acquisition_id, photo_path, caption
     ) values ($1, $2, $3, $4, 'moderation lock-order race')`,
    [
      ids.moderationFieldCard,
      blockOwnerAUserId,
      moderationFieldAcquisition.id,
      `${blockOwnerAUserId}/${ids.moderationFieldCard}.webp`,
    ],
  );
  const moderationFieldPending = await admin.query(
    `select api_private.create_personal_card_share(
       $1, false, true, $2, $3
     ) as result`,
    [
      ids.blockOwnerA,
      ids.moderationFieldCard,
      randomUUID().replaceAll("-", ""),
    ],
  );
  assertStatus(
    moderationFieldPending,
    "pending",
    "field moderation lock-order fixture submission failed",
  );

  const photoDeletionRaceAcquisitions = await admin.query(
    `insert into public.acquisitions (
       user_id, spot_id, card_id, acquisition_type, verification_result,
       idempotency_key
     ) values
       ($1, $2, $3, 'gift', 'not_applicable', $4),
       ($1, $5, $6, 'gift', 'not_applicable', $7)
     returning id, card_id`,
    [
      photoDeletionModerationUserId,
      ids.spotOne,
      ids.cardOne,
      randomUUID(),
      ids.spotTwo,
      ids.cardTwo,
      randomUUID(),
    ],
  );
  const photoDeletionRaceAcquisitionByCard = new Map(
    photoDeletionRaceAcquisitions.rows.map((row) => [row.card_id, row.id]),
  );
  await admin.query(
    `insert into public.personal_cards (
       id, user_id, acquisition_id, photo_path, photo_size_bytes, caption,
       share_slug, shared_at, share_state, share_submitted_at,
       share_resubmission_required
     ) values
       ($1, $3, $4, $6, 1024, 'delete transaction first',
        $8, clock_timestamp(), 'pending', clock_timestamp(), true),
       ($2, $3, $5, $7, 1024, 'moderation transaction first',
        $9, clock_timestamp(), 'pending', clock_timestamp(), true)`,
    [
      ids.photoDeletionCardFirst,
      ids.photoModerationCardFirst,
      photoDeletionModerationUserId,
      photoDeletionRaceAcquisitionByCard.get(ids.cardOne),
      photoDeletionRaceAcquisitionByCard.get(ids.cardTwo),
      `${photoDeletionModerationUserId}/${ids.photoDeletionCardFirst}.webp`,
      `${photoDeletionModerationUserId}/${ids.photoModerationCardFirst}.webp`,
      randomUUID().replaceAll("-", ""),
      randomUUID().replaceAll("-", ""),
    ],
  );
  await admin.query(
    `insert into private.content_reports (
       id, client_report_id, personal_card_id, owner_user_id,
       share_secret_hash, target, reason
     ) values
       ($1, $5, $3, $7, decode(repeat('a1', 32), 'hex'), 'content', 'spam'),
       ($2, $6, $4, $7, decode(repeat('b2', 32), 'hex'), 'content', 'spam')`,
    [
      ids.photoDeletionReportFirst,
      ids.photoModerationReportFirst,
      ids.photoDeletionCardFirst,
      ids.photoModerationCardFirst,
      randomUUID(),
      randomUUID(),
      photoDeletionModerationUserId,
    ],
  );

  const existingIssueAttemptKey = randomUUID();
  const existingAcquireAttemptKey = randomUUID();
  await admin.query(
    `insert into private.location_use_facts (
       user_id, idempotency_key, spot_id, purpose
     ) values
       ($1, $4, $3, 'field_acquisition'),
       ($2, $5, $3, 'field_acquisition')`,
    [
      issueTargetUserId,
      acquireTargetUserId,
      ids.spotOne,
      existingIssueAttemptKey,
      existingAcquireAttemptKey,
    ],
  );
  await admin.query(
    `insert into public.acquisitions (
       user_id, spot_id, card_id, acquisition_type, verification_result,
       idempotency_key, field_sequence, acquired_at
     ) values
       ($1, $3, $4, 'field', 'passed', $5, 1, now()),
       ($2, $3, $4, 'field', 'passed', $6, 2, now())`,
    [
      issueTargetUserId,
      acquireTargetUserId,
      ids.spotOne,
      ids.cardOne,
      existingIssueAttemptKey,
      existingAcquireAttemptKey,
    ],
  );
  await admin.query(
    `delete from private.location_use_facts
     where (user_id, idempotency_key) in (($1, $3), ($2, $4))`,
    [
      issueTargetUserId,
      acquireTargetUserId,
      existingIssueAttemptKey,
      existingAcquireAttemptKey,
    ],
  );
  await admin.query(
    `insert into public.acquisitions (
       user_id, spot_id, card_id, acquisition_type, verification_result,
       idempotency_key, field_sequence, acquired_at
     ) values ($1, $2, $3, 'gift', 'not_applicable', $4, null, now())`,
    [reviewerRaceUserId, ids.spotOne, ids.cardOne, randomUUID()],
  );
  await admin.query(
    `insert into private.card_counters (card_id, last_sequence)
     values ($1, 2), ($2, 0)
     on conflict (card_id) do update set last_sequence = excluded.last_sequence`,
    [ids.cardOne, ids.cardTwo],
  );
  await admin.query(
    `insert into private.participant_invite_codes (code_hash)
     values (decode($1, 'hex'))`,
    [inviteHash],
  );

  for (const [authUserId, codeHash] of [
    [ids.issueTarget, oldIssueRecoveryHash],
    [ids.acquireTarget, acquireRecoveryHash],
  ]) {
    const issued = await admin.query(
      `select api_private.issue_recovery_code($1, $2) as result`,
      [authUserId, codeHash],
    );
    assert(resultStatus(issued) === "issued", "recovery fixture issuance failed");
  }
  await admin.query(
    `insert into private.recovery_codes (
       user_id, code_hash, expires_at
     ) values
       ($1, decode($3, 'hex'), clock_timestamp() + interval '1 hour'),
       ($2, decode($4, 'hex'), clock_timestamp() + interval '1 hour')`,
    [
      reviewerTargetRaceUserId,
      reviewerCurrentTargetUserId,
      reviewerTargetRecoveryHash,
      reviewerCurrentRecoveryHash,
    ],
  );

  for (const targetAuthUserId of [
    ids.sameClaimTarget,
    ids.ageFirstTarget,
    ids.claimFirstTarget,
    ids.locationRecoveryTarget,
  ]) {
    await admin.query(
      `insert into public.acquisitions (
         user_id, spot_id, card_id, acquisition_type, verification_result,
         idempotency_key
       ) values ($1, $2, $3, 'gift', 'not_applicable', $4)`,
      [
        logicalUserByAuth.get(targetAuthUserId),
        ids.spotOne,
        ids.cardOne,
        randomUUID(),
      ],
    );
  }
  await admin.query(
    `insert into private.recovery_codes (user_id, code_hash, expires_at)
     values ($1, decode($2, 'hex'), clock_timestamp() + interval '1 hour')`,
    [logicalUserByAuth.get(ids.rateRecoveryTarget), rateRecoveryHash],
  );
  for (const [targetAuthUserId, codeHash] of [
    [ids.sameClaimTarget, sameClaimRecoveryHash],
    [ids.ageFirstTarget, ageFirstRecoveryHash],
    [ids.claimFirstTarget, claimFirstRecoveryHash],
    [ids.locationRecoveryTarget, locationRecoveryHash],
  ]) {
    const issued = await admin.query(
      `select api_private.issue_recovery_code($1, $2) as result`,
      [targetAuthUserId, codeHash],
    );
    assertStatus(issued, "issued", "age/recovery concurrency fixture issuance failed");
  }

  const crossRecoveryAUserId = logicalUserByAuth.get(ids.crossRecoveryA);
  const crossRecoveryBUserId = logicalUserByAuth.get(ids.crossRecoveryB);
  await admin.query(
    `insert into private.recovery_codes (user_id, code_hash)
     values
       ($1, decode($3, 'hex')),
       ($2, decode($4, 'hex'))`,
    [crossRecoveryAUserId, crossRecoveryBUserId, crossRecoveryHashA, crossRecoveryHashB],
  );
  await recordAdultAttestation(admin, ids.crossRecoveryA);

  // One invite digest can be consumed by exactly one of two concurrent users.
  const inviteClientA = await connect();
  const inviteClientB = await connect();
  clients.push(inviteClientA, inviteClientB);
  const inviteResults = await Promise.all([
    inviteClientA.query(
      `select api_private.redeem_participant_invite($1, $2) as result`,
      [ids.inviteA, inviteHash],
    ),
    inviteClientB.query(
      `select api_private.redeem_participant_invite($1, $2) as result`,
      [ids.inviteB, inviteHash],
    ),
  ]);
  const inviteStatuses = inviteResults.map(resultStatus).sort();
  assert(
    JSON.stringify(inviteStatuses) === JSON.stringify(["not_found", "redeemed"]),
    `one-use invite race returned ${JSON.stringify(inviteStatuses)}`,
  );
  await closeScenarioClients(inviteClientA, inviteClientB);

  // Recovery issue owns the per-target advisory lock before its identity row.
  // A claim waits behind it and must observe the old code as revoked, not deadlock.
  blocker = await connect();
  const issueClient = await connect();
  const claimClient = await connect();
  clients.push(blocker, issueClient, claimClient);
  await blocker.query("begin");
  await blocker.query(
    `select id from private.user_identities
     where auth_user_id = $1 and revoked_at is null
     for update`,
    [ids.issueTarget],
  );
  const issuePromise = issueClient.query(
    `select api_private.issue_recovery_code($1, $2) as result`,
    [ids.issueTarget, newIssueRecoveryHash],
  );
  await waitForLock(admin, issueClient.processID, "recovery issue");
  const claimBehindIssuePromise = claimClient.query(
    `select api_private.claim_recovery_code($1, $2) as result`,
    [ids.issueClaimant, oldIssueRecoveryHash],
  );
  await waitForLock(admin, claimClient.processID, "claim behind issue");
  await blocker.query("commit");
  const [issueResult, claimBehindIssueResult] = await Promise.all([
    issuePromise,
    claimBehindIssuePromise,
  ]);
  assert(resultStatus(issueResult) === "issued", "serialized recovery reissue did not succeed");
  assert(
    resultStatus(claimBehindIssueResult) === "not_found",
    "claim did not recheck the code after serialized reissue",
  );
  await closeScenarioClients(issueClient, claimClient);

  // Reviewer designation and recovery issue share the same per-target lock.
  // Even in the hard ordering where issue already owns that lock while the
  // reviewer transaction has written an uncommitted history marker, the
  // reviewer trigger must revoke any code issued immediately before it.
  await blocker.query("begin");
  await blocker.query(
    `select id from private.user_identities
     where auth_user_id = $1 and revoked_at is null
     for update`,
    [ids.reviewerRace],
  );
  const reviewerIssueClient = await connect();
  const reviewerDesignationClient = await connect();
  clients.push(reviewerIssueClient, reviewerDesignationClient);
  const reviewerIssuePromise = reviewerIssueClient.query(
    `select api_private.issue_recovery_code($1, $2) as result`,
    [ids.reviewerRace, reviewerRaceRecoveryHash],
  );
  await waitForLock(admin, reviewerIssueClient.processID, "reviewer-race recovery issue");
  const reviewerDesignationPromise = reviewerDesignationClient.query(
    `insert into private.reviewer_accounts (
       user_id, store_platform, fixture_version
     ) values ($1, 'app_store', $2)`,
    [reviewerRaceUserId, `concurrency-${suffix}`],
  );
  await waitForLock(
    admin,
    reviewerDesignationClient.processID,
    "reviewer designation behind recovery issue",
  );
  await blocker.query("commit");
  const [reviewerIssueResult] = await Promise.all([
    reviewerIssuePromise,
    reviewerDesignationPromise,
  ]);
  assert(
    ["issued", "reviewer_forbidden"].includes(resultStatus(reviewerIssueResult)),
    "reviewer race returned an unexpected recovery status",
  );
  const reviewerRaceActiveCodes = await admin.query(
    `select count(*)::integer as count
     from private.recovery_codes
     where user_id = $1 and revoked_at is null and claimed_at is null`,
    [reviewerRaceUserId],
  );
  assert(
    reviewerRaceActiveCodes.rows[0].count === 0,
    "reviewer designation race left an active recovery code",
  );
  await closeScenarioClients(reviewerIssueClient, reviewerDesignationClient);

  // Claim and designation of the recovery target share the target advisory.
  // Queue claim first: after it rebinds the target to the anonymous claimant,
  // designation must recheck the active Auth credential and fail.
  await blocker.query("begin");
  await blocker.query(
    `select pg_advisory_xact_lock(hashtextextended(
       'danyeodam:recovery:target:' || $1::text,
       0
     ))`,
    [reviewerTargetRaceUserId],
  );
  const reviewerTargetClaimClient = await connect();
  const reviewerTargetDesignationClient = await connect();
  clients.push(reviewerTargetClaimClient, reviewerTargetDesignationClient);
  const reviewerTargetClaimPromise = reviewerTargetClaimClient.query(
    `select api_private.claim_recovery_code($1, $2) as result`,
    [ids.reviewerTargetClaimant, reviewerTargetRecoveryHash],
  );
  await waitForLock(
    admin,
    reviewerTargetClaimClient.processID,
    "reviewer target claim",
  );
  const reviewerTargetDesignationPromise = captureQuery(
    reviewerTargetDesignationClient.query(
      `insert into private.reviewer_accounts (
         user_id, store_platform, fixture_version
       ) values ($1, 'play_store', $2)`,
      [reviewerTargetRaceUserId, `target-race-${suffix}`],
    ),
  );
  await waitForLock(
    admin,
    reviewerTargetDesignationClient.processID,
    "reviewer designation behind target claim",
  );
  await blocker.query("commit");
  const [reviewerTargetClaim, reviewerTargetDesignation] = await Promise.all([
    reviewerTargetClaimPromise,
    reviewerTargetDesignationPromise,
  ]);
  assert(
    resultStatus(reviewerTargetClaim) === "restored",
    "reviewer target race claim did not restore",
  );
  assert(
    reviewerTargetDesignation.error?.code === "23514",
    "reviewer target was designated after claim rebound it to anonymous Auth",
  );
  const reviewerTargetHistory = await admin.query(
    `select count(*)::integer as count
     from private.reviewer_user_history where user_id = $1`,
    [reviewerTargetRaceUserId],
  );
  assert(
    reviewerTargetHistory.rows[0].count === 0,
    "failed target designation persisted reviewer history",
  );
  await closeScenarioClients(reviewerTargetClaimClient, reviewerTargetDesignationClient);

  // Claim uses a different advisory for its ordinary target, so exercise the
  // claimant/current side through the shared identity row. Hold the code row
  // only after claim has locked both identities, then queue designation on the
  // disposable claimant logical user. Claim deletes that user; designation
  // must wake, find no live credential, and fail before writing history.
  await blocker.query("begin");
  await blocker.query(
    `select id
     from private.recovery_codes
     where code_hash = decode($1, 'hex')
     for update`,
    [reviewerCurrentRecoveryHash],
  );
  const reviewerCurrentClaimClient = await connect();
  const reviewerCurrentDesignationClient = await connect();
  clients.push(reviewerCurrentClaimClient, reviewerCurrentDesignationClient);
  const reviewerCurrentClaimPromise = reviewerCurrentClaimClient.query(
    `select api_private.claim_recovery_code($1, $2) as result`,
    [ids.reviewerCurrentClaimant, reviewerCurrentRecoveryHash],
  );
  await waitForLock(
    admin,
    reviewerCurrentClaimClient.processID,
    "reviewer current-side claim",
  );
  const reviewerCurrentDesignationPromise = captureQuery(
    reviewerCurrentDesignationClient.query(
      `insert into private.reviewer_accounts (
         user_id, store_platform, fixture_version
       ) values ($1, 'app_store', $2)`,
      [reviewerCurrentClaimantUserId, `current-race-${suffix}`],
    ),
  );
  await waitForLock(
    admin,
    reviewerCurrentDesignationClient.processID,
    "reviewer designation behind current-side claim",
  );
  await blocker.query("commit");
  const [reviewerCurrentClaim, reviewerCurrentDesignation] = await Promise.all([
    reviewerCurrentClaimPromise,
    reviewerCurrentDesignationPromise,
  ]);
  assert(
    resultStatus(reviewerCurrentClaim) === "restored",
    "reviewer current-side race claim did not restore",
  );
  assert(
    reviewerCurrentDesignation.error?.code === "23514",
    "disposable claimant was designated during recovery claim",
  );
  const reviewerCurrentResidue = await admin.query(
    `select
       exists (
         select 1 from public.app_users where id = $1
       ) as app_user_exists,
       exists (
         select 1 from private.reviewer_user_history where user_id = $1
       ) as history_exists`,
    [reviewerCurrentClaimantUserId],
  );
  assert(
    !reviewerCurrentResidue.rows[0].app_user_exists
      && !reviewerCurrentResidue.rows[0].history_exists,
    "claimant race left app-user or reviewer-history residue",
  );
  await closeScenarioClients(reviewerCurrentClaimClient, reviewerCurrentDesignationClient);

  // Link-first ordering: the Auth credential update already owns auth.users
  // and the non-blocking target advisory before reviewer designation starts.
  // Designation waits, then accepts the committed non-anonymous credential.
  const reviewerLinkClient = await connect();
  const reviewerLinkDesignationClient = await connect();
  clients.push(reviewerLinkClient, reviewerLinkDesignationClient);
  await reviewerLinkClient.query("begin");
  await reviewerLinkClient.query(
    `update auth.users
     set email = $2,
         encrypted_password = $3,
         email_confirmed_at = clock_timestamp(),
         is_anonymous = false,
         is_sso_user = false,
         role = 'authenticated',
         aud = 'authenticated',
         is_super_admin = false,
         banned_until = null,
         raw_app_meta_data = jsonb_build_object(
           'provider', 'email',
           'providers', jsonb_build_array('email')
         ),
         raw_user_meta_data = '{}'::jsonb
     where id = $1`,
    [
      ids.reviewerLinkFirst,
      `link-first-${suffix}@example.test`,
      `link-first-hash-${suffix}`,
    ],
  );
  await reviewerLinkClient.query(
    `insert into auth.identities (
       id, user_id, provider_id, identity_data, provider,
       last_sign_in_at, created_at, updated_at
     ) values (
       gen_random_uuid(), $1::uuid, $1::text,
       jsonb_build_object(
         'sub', $1::text,
         'email', $2::text,
         'email_verified', true
       ),
       'email', clock_timestamp(), clock_timestamp(), clock_timestamp()
     )`,
    [ids.reviewerLinkFirst, `link-first-${suffix}@example.test`],
  );
  const reviewerLinkDesignationPromise = reviewerLinkDesignationClient.query(
    `insert into private.reviewer_accounts (
       user_id, store_platform, fixture_version
     ) values ($1, 'app_store', $2)`,
    [reviewerLinkFirstUserId, `link-first-${suffix}`],
  );
  await waitForLock(
    admin,
    reviewerLinkDesignationClient.processID,
    "reviewer designation behind completed Auth link",
  );
  await reviewerLinkClient.query("commit");
  await reviewerLinkDesignationPromise;
  await closeScenarioClients(reviewerLinkClient, reviewerLinkDesignationClient);

  // Designation-first ordering: reviewer owns advisory -> identity -> Auth.
  // The concurrent credential update waits on Auth, then observes history and
  // must fail instead of mutating the reusable store credential.
  const reviewerFirstDesignationClient = await connect();
  const reviewerFirstAuthUpdateClient = await connect();
  const reviewerFirstIdentityClient = await connect();
  clients.push(
    reviewerFirstDesignationClient,
    reviewerFirstAuthUpdateClient,
    reviewerFirstIdentityClient,
  );
  await reviewerFirstDesignationClient.query("begin");
  await reviewerFirstDesignationClient.query(
    `insert into private.reviewer_accounts (
       user_id, store_platform, fixture_version
     ) values ($1, 'play_store', $2)`,
    [reviewerDesignationFirstUserId, `designation-first-${suffix}`],
  );
  const reviewerFirstIdentityPromise = captureQuery(
    reviewerFirstIdentityClient.query(
      `insert into auth.identities (
         id, user_id, provider_id, identity_data, provider,
         last_sign_in_at, created_at, updated_at
       ) values (
         gen_random_uuid(), $1, $2,
         jsonb_build_object('sub', $2::text),
         'github', clock_timestamp(), clock_timestamp(), clock_timestamp()
       )`,
      [ids.reviewerDesignationFirst, `forbidden-github-${suffix}`],
    ),
  );
  const reviewerFirstAuthUpdatePromise = captureQuery(
    reviewerFirstAuthUpdateClient.query(
      `update auth.users
       set email_change = $2,
           email_change_token_new = $3,
           encrypted_password = $4
       where id = $1`,
      [
        ids.reviewerDesignationFirst,
        `forbidden-${suffix}@example.test`,
        `forbidden-token-${suffix}`,
        `forbidden-hash-${suffix}`,
      ],
    ),
  );
  await waitForLock(
    admin,
    reviewerFirstAuthUpdateClient.processID,
    "Auth mutation behind reviewer designation",
  );
  const reviewerFirstIdentity = await reviewerFirstIdentityPromise;
  assert(
    reviewerFirstIdentity.error?.code === "23514",
    "designation-first race allowed an automatic provider identity",
  );
  await reviewerFirstDesignationClient.query("commit");
  const reviewerFirstAuthUpdate = await reviewerFirstAuthUpdatePromise;
  assert(
    reviewerFirstAuthUpdate.error?.code === "23514",
    "designation-first race allowed a reviewer credential mutation",
  );
  const reviewerFirstCredential = await admin.query(
    `select email, email_change, encrypted_password
     from auth.users where id = $1`,
    [ids.reviewerDesignationFirst],
  );
  assert(
    reviewerFirstCredential.rows[0].email === `designation-first-${suffix}@example.test`
      && !reviewerFirstCredential.rows[0].email_change
      && reviewerFirstCredential.rows[0].encrypted_password
        === `test-hash-designation-first-${suffix}`,
    "failed designation-first Auth mutation changed credential state",
  );
  await closeScenarioClients(
    reviewerFirstDesignationClient,
    reviewerFirstAuthUpdateClient,
    reviewerFirstIdentityClient,
  );

  // Keep acquire_commit blocked at its counter write after it has taken an
  // identity FOR SHARE lock. Claim must wait, then recheck and reject the now
  // non-empty disposable user instead of rebinding/deleting it.
  const acquireRaceKey = randomUUID();
  const acquireContext = await admin.query(
    `select api_private.acquire_context_unrated($1, $2, $3, true) as result`,
    [ids.acquireClaimant, ids.spotTwo, acquireRaceKey],
  );
  assertStatus(acquireContext, "ready", "acquire race context fixture failed");
  await blocker.query("begin");
  await blocker.query(
    `select card_id from private.card_counters where card_id = $1 for update`,
    [ids.cardTwo],
  );
  const acquireClient = await connect();
  const claimClientTwo = await connect();
  clients.push(acquireClient, claimClientTwo);
  const spotTimestamp = await admin.query(
    `select updated_at::text as updated_at from public.spots where id = $1`,
    [ids.spotTwo],
  );
  const acquirePromise = acquireClient.query(
    `select api_private.acquire_commit_unrated($1, $2, $3, true, $4) as result`,
    [
      ids.acquireClaimant,
      ids.spotTwo,
      acquireRaceKey,
      spotTimestamp.rows[0].updated_at,
    ],
  );
  await waitForLock(admin, acquireClient.processID, "acquire commit");
  const claimBehindAcquirePromise = claimClientTwo.query(
    `select api_private.claim_recovery_code($1, $2) as result`,
    [ids.acquireClaimant, acquireRecoveryHash],
  );
  await waitForLock(admin, claimClientTwo.processID, "claim behind acquire");
  await blocker.query("commit");
  const [acquireResult, claimBehindAcquireResult] = await Promise.all([
    acquirePromise,
    claimBehindAcquirePromise,
  ]);
  assert(resultStatus(acquireResult) === "created", "blocked acquire did not commit");
  assert(
    resultStatus(claimBehindAcquireResult) === "not_empty",
    "claim did not recheck acquisitions after waiting for acquire",
  );
  const acquisitionOwner = await admin.query(
    `select user_id from public.acquisitions
     where user_id = $1 and spot_id = $2`,
    [acquireClaimantUserId, ids.spotTwo],
  );
  assert(acquisitionOwner.rowCount === 1, "concurrent acquire was attached to the wrong user");
  await closeScenarioClients(acquireClient, claimClientTwo);

  // A retro grant takes the target identity FOR SHARE before it can write.
  // Recovery claim must wait for that write and then recheck the claimant's
  // acquisitions instead of rebinding or deleting the newly non-empty user.
  await blocker.query("begin");
  await blocker.query(
    `select pg_advisory_xact_lock(
       hashtextextended(
         'danyeodam:retro:' || $1::text || ':' || $2::text,
         0
       )
     )`,
    [retroClaimantUserId, ids.spotTwo],
  );
  const retroClient = await connect();
  const claimClientThree = await connect();
  clients.push(retroClient, claimClientThree);
  const retroPromise = retroClient.query(
    `select api_private.grant_retro_acquisition($1, $2, $3, $4) as result`,
    [ids.retroAdmin, retroClaimantUserId, ids.spotTwo, "concurrency-test"],
  );
  await waitForLock(admin, retroClient.processID, "retro grant");
  const claimBehindRetroPromise = claimClientThree.query(
    `select api_private.claim_recovery_code($1, $2) as result`,
    [ids.retroClaimant, acquireRecoveryHash],
  );
  await waitForLock(admin, claimClientThree.processID, "claim behind retro grant");
  await blocker.query("commit");
  const [retroResult, claimBehindRetroResult] = await Promise.all([
    retroPromise,
    claimBehindRetroPromise,
  ]);
  assert(resultStatus(retroResult) === "created", "blocked retro grant did not commit");
  assert(
    resultStatus(claimBehindRetroResult) === "not_empty",
    "claim did not recheck acquisitions after waiting for retro grant",
  );
  const retroAudit = await admin.query(
    `select acquisition_row.user_id
     from public.acquisitions as acquisition_row
     join private.retro_grants as grant_row
       on grant_row.acquisition_id = acquisition_row.id
     where acquisition_row.user_id = $1
       and acquisition_row.spot_id = $2
       and acquisition_row.acquisition_type = 'retro'`,
    [retroClaimantUserId, ids.spotTwo],
  );
  assert(retroAudit.rowCount === 1, "concurrent retro grant lost its audit record");
  await closeScenarioClients(retroClient, claimClientThree);

  // A worker whose lease expired must never share the winner's permanent
  // Storage path. Completion and cleanup both serialize on the upload row, so
  // stale compensation can authorize only the old token path.
  const personalAcquisition = await admin.query(
    `select id
     from public.acquisitions
     where user_id = $1 and spot_id = $2`,
    [issueTargetUserId, ids.spotOne],
  );
  assert(personalAcquisition.rowCount === 1, "personal-card acquisition fixture missing");
  const personalAcquisitionId = personalAcquisition.rows[0].id;
  const issuedUpload = await admin.query(
    `select api_private.issue_personal_card_temp_upload(
       $1, true, 'image/jpeg', 128
     ) as result`,
    [ids.issueTarget],
  );
  assert(resultStatus(issuedUpload) === "issued", "personal-card upload issuance failed");
  const promotionUploadId = issuedUpload.rows[0].result.upload_id;
  const promotionTempPath = issuedUpload.rows[0].result.temp_path;
  const staleToken = randomUUID();
  const winnerToken = randomUUID();
  const staleBegin = await admin.query(
    `select api_private.begin_personal_card_promotion(
       $1, true, $2, $3, 'stale worker', $4
     ) as result`,
    [ids.issueTarget, personalAcquisitionId, promotionTempPath, staleToken],
  );
  assert(resultStatus(staleBegin) === "ready", "stale worker lease fixture failed");
  const stalePath = staleBegin.rows[0].result.permanent_path;
  await admin.query(
    `update private.personal_card_temp_uploads
     set processing_expires_at = processing_started_at + interval '1 microsecond'
     where id = $1`,
    [promotionUploadId],
  );
  const winnerBegin = await admin.query(
    `select api_private.begin_personal_card_promotion(
       $1, true, $2, $3, 'winner worker', $4
     ) as result`,
    [ids.issueTarget, personalAcquisitionId, promotionTempPath, winnerToken],
  );
  assert(resultStatus(winnerBegin) === "ready", "winner lease takeover failed");
  const winnerPath = winnerBegin.rows[0].result.permanent_path;
  assert(stalePath !== winnerPath, "lease takeover reused the stale permanent path");
  assert(
    stalePath === `${issueTargetUserId}/${staleToken}.webp`,
    "stale worker path is not processing-token-owned",
  );
  assert(
    winnerPath === `${issueTargetUserId}/${winnerToken}.webp`,
    "winner path is not processing-token-owned",
  );

  await blocker.query("begin");
  await blocker.query(
    `select id from public.acquisitions where id = $1 for update`,
    [personalAcquisitionId],
  );
  const winnerClient = await connect();
  const staleClient = await connect();
  clients.push(winnerClient, staleClient);
  const winnerCompletionPromise = winnerClient.query(
    `select api_private.complete_personal_card_promotion_with_size_unbound(
       $1, $2, $3, $4, $5, 'winner worker', $6
     ) as result`,
    [
      ids.issueTarget,
      promotionUploadId,
      winnerToken,
      personalAcquisitionId,
      winnerPath,
      1,
    ],
  );
  await waitForLock(admin, winnerClient.processID, "personal-card winner completion");
  const staleCompletionPromise = staleClient.query(
    `select api_private.complete_personal_card_promotion_with_size_unbound(
       $1, $2, $3, $4, $5, 'stale worker', $6
     ) as result`,
    [
      ids.issueTarget,
      promotionUploadId,
      staleToken,
      personalAcquisitionId,
      stalePath,
      1,
    ],
  );
  await waitForLock(admin, staleClient.processID, "personal-card stale completion");
  await blocker.query("commit");
  const [winnerCompletion, staleCompletion] = await Promise.all([
    winnerCompletionPromise,
    staleCompletionPromise,
  ]);
  assert(resultStatus(winnerCompletion) === "created", "winner promotion did not commit");
  assert(resultStatus(staleCompletion) === "stale", "expired worker was not rejected as stale");

  const staleReference = await admin.query(
    `select api_private.confirm_personal_card_permanent_unreferenced(
       $1, $2, $3
     ) as result`,
    [promotionUploadId, staleToken, stalePath],
  );
  assert(
    resultStatus(staleReference) === "unreferenced",
    "stale worker object was not confirmed as independently unreferenced",
  );
  const winnerReference = await admin.query(
    `select api_private.confirm_personal_card_permanent_unreferenced(
       $1, $2, $3
     ) as result`,
    [promotionUploadId, winnerToken, winnerPath],
  );
  assert(
    resultStatus(winnerReference) === "referenced",
    "winner object was incorrectly authorized for compensation",
  );
  const persistedWinner = await admin.query(
    `select card.photo_path, upload.permanent_path
     from public.personal_cards as card
     join private.personal_card_temp_uploads as upload
       on upload.id = $1
     where card.acquisition_id = $2`,
    [promotionUploadId, personalAcquisitionId],
  );
  assert(persistedWinner.rowCount === 1, "winner card reference was lost");
  assert(
    persistedWinner.rows[0].photo_path === winnerPath
      && persistedWinner.rows[0].permanent_path === winnerPath,
    "stale compensation altered the winner reference",
  );
  await closeScenarioClients(winnerClient, staleClient);

  // Releasing an uncommitted field promotion preserves two durable object
  // bindings. Before the ten-minute promotion window expires, standalone
  // reconciliation may claim only the old permanent path; a queued new-token
  // begin must still reuse the same temp path successfully.
  const retryUpload = await admin.query(
    `select api_private.issue_personal_card_temp_upload(
       $1, true, 'image/jpeg', 128
     ) as result`,
    [ids.ledgerOwner],
  );
  assertStatus(retryUpload, "issued", "ledger retry upload issuance failed");
  const retryUploadId = retryUpload.rows[0].result.upload_id;
  const retryTempPath = retryUpload.rows[0].result.temp_path;
  const firstRetryToken = randomUUID();
  const firstRetryBegin = await admin.query(
    `select api_private.begin_personal_card_promotion(
       $1, true, $2, $3, 'ledger retry', $4
     ) as result`,
    [ids.ledgerOwner, ledgerAcquisition.id, retryTempPath, firstRetryToken],
  );
  assertStatus(firstRetryBegin, "ready", "first ledger retry begin failed");
  const firstRetryPath = firstRetryBegin.rows[0].result.permanent_path;
  const firstRelease = await admin.query(
    `select api_private.release_personal_card_promotion($1, $2) as result`,
    [retryUploadId, firstRetryToken],
  );
  assertStatus(firstRelease, "updated", "first ledger retry release failed");

  await blocker.query("begin");
  await blocker.query(
    `select pg_advisory_xact_lock(hashtextextended(
       'danyeodam:suspend-owner:' || $1::text,
       0
     ))`,
    [ledgerOwnerUserId],
  );
  const retryCleanupClient = await connect();
  const retryBeginClient = await connect();
  clients.push(retryCleanupClient, retryBeginClient);
  const retryCleanupWorker = randomUUID();
  const retryCleanupPromise = retryCleanupClient.query(
    `select api_private.claim_personal_card_field_object_cleanup($1, 4) as result`,
    [retryCleanupWorker],
  );
  await waitForLock(admin, retryCleanupClient.processID, "field object cleanup before temp retry");
  const secondRetryToken = randomUUID();
  const secondRetryBeginPromise = retryBeginClient.query(
    `select api_private.begin_personal_card_promotion(
       $1, true, $2, $3, 'ledger retry', $4
     ) as result`,
    [ids.ledgerOwner, ledgerAcquisition.id, retryTempPath, secondRetryToken],
  );
  await waitForLock(admin, retryBeginClient.processID, "same-temp retry behind cleanup claim");
  await blocker.query("commit");
  const [retryCleanup, secondRetryBegin] = await Promise.all([
    retryCleanupPromise,
    secondRetryBeginPromise,
  ]);
  assertStatus(retryCleanup, "ready", "field object cleanup claim failed");
  assert(
    retryCleanup.rows[0].result.items.some(
      (item) => item.object_path === firstRetryPath && item.bucket === "personal-cards",
    ),
    "cleanup did not claim the abandoned permanent path",
  );
  assert(
    !retryCleanup.rows[0].result.items.some(
      (item) => item.object_path === retryTempPath,
    ),
    "cleanup claimed temp before the promotion retry window expired",
  );
  assertStatus(secondRetryBegin, "ready", "same-temp new-token retry was blocked");
  const secondRelease = await admin.query(
    `select api_private.release_personal_card_promotion($1, $2) as result`,
    [retryUploadId, secondRetryToken],
  );
  assertStatus(secondRelease, "updated", "second ledger retry release failed");

  await admin.query(
    `update private.personal_card_temp_uploads as upload_row
     set issued_at = fixture_time.issued_at,
         promotion_expires_at = fixture_time.issued_at + interval '10 minutes',
         signed_url_last_issued_at = fixture_time.issued_at,
         signed_url_expires_at = fixture_time.issued_at + interval '2 hours',
         quota_issued_at = fixture_time.issued_at
     from (select clock_timestamp() - interval '3 hours' as issued_at) as fixture_time
     where upload_row.id = $1`,
    [retryUploadId],
  );
  await admin.query(
    `update private.personal_card_field_object_ledger
     set next_attempt_at = clock_timestamp() - interval '1 second'
     where upload_id = $1 and bucket = 'personal-card-temp'`,
    [retryUploadId],
  );
  const expiredTempClaim = await admin.query(
    `select api_private.claim_personal_card_field_object_cleanup($1, 4) as result`,
    [randomUUID()],
  );
  assert(
    expiredTempClaim.rows[0].result.items.some(
      (item) => item.object_path === retryTempPath && item.bucket === "personal-card-temp",
    ),
    "temp object was not claimable after the promotion retry window expired",
  );
  addedScenarioCount += 1;
  await closeScenarioClients(retryCleanupClient, retryBeginClient);

  // Once reconciliation wins the owner lock and marks the exact permanent
  // object cleanup_pending, a queued completion must fail closed instead of
  // creating a card that could be deleted by the external cleanup pass.
  const cleanupRaceUpload = await admin.query(
    `select api_private.issue_personal_card_temp_upload(
       $1, true, 'image/jpeg', 128
     ) as result`,
    [ids.ledgerOwner],
  );
  assertStatus(cleanupRaceUpload, "issued", "cleanup/complete upload issuance failed");
  const cleanupRaceUploadId = cleanupRaceUpload.rows[0].result.upload_id;
  const cleanupRaceTempPath = cleanupRaceUpload.rows[0].result.temp_path;
  const cleanupRaceToken = randomUUID();
  const cleanupRaceBegin = await admin.query(
    `select api_private.begin_personal_card_promotion(
       $1, true, $2, $3, 'cleanup complete race', $4
     ) as result`,
    [
      ids.ledgerOwner,
      ledgerAcquisition.id,
      cleanupRaceTempPath,
      cleanupRaceToken,
    ],
  );
  assertStatus(cleanupRaceBegin, "ready", "cleanup/complete begin failed");
  const cleanupRacePath = cleanupRaceBegin.rows[0].result.permanent_path;
  await admin.query(
    `update private.personal_card_temp_uploads
     set processing_expires_at = processing_started_at + interval '1 microsecond'
     where id = $1`,
    [cleanupRaceUploadId],
  );

  await blocker.query("begin");
  await blocker.query(
    `select pg_advisory_xact_lock(hashtextextended(
       'danyeodam:suspend-owner:' || $1::text,
       0
     ))`,
    [ledgerOwnerUserId],
  );
  const cleanupRaceClient = await connect();
  const completeBehindCleanupClient = await connect();
  clients.push(cleanupRaceClient, completeBehindCleanupClient);
  const cleanupRacePromise = cleanupRaceClient.query(
    `select api_private.claim_personal_card_field_object_cleanup($1, 4) as result`,
    [randomUUID()],
  );
  await waitForLock(admin, cleanupRaceClient.processID, "object cleanup owner serialization");
  const completeBehindCleanupPromise = completeBehindCleanupClient.query(
    `select api_private.complete_personal_card_promotion_with_size_unbound(
       $1, $2, $3, $4, $5, 'cleanup complete race', $6
     ) as result`,
    [
      ids.ledgerOwner,
      cleanupRaceUploadId,
      cleanupRaceToken,
      ledgerAcquisition.id,
      cleanupRacePath,
      1,
    ],
  );
  await waitForLock(
    admin,
    completeBehindCleanupClient.processID,
    "completion behind object cleanup",
  );
  await blocker.query("commit");
  const [cleanupRaceClaim, completeBehindCleanup] = await Promise.all([
    cleanupRacePromise,
    completeBehindCleanupPromise,
  ]);
  assert(
    cleanupRaceClaim.rows[0].result.items.some(
      (item) => item.object_path === cleanupRacePath,
    ),
    "cleanup/complete race did not claim the exact permanent path",
  );
  assertStatus(completeBehindCleanup, "stale", "completion bypassed cleanup_pending");
  const cleanupRaceCard = await admin.query(
    `select count(*)::integer as count
     from public.personal_cards
     where user_id = $1 and acquisition_id = $2`,
    [ledgerOwnerUserId, ledgerAcquisition.id],
  );
  assert(cleanupRaceCard.rows[0].count === 0, "cleanup race created a personal card");
  addedScenarioCount += 1;
  await closeScenarioClients(cleanupRaceClient, completeBehindCleanupClient);

  // A field begin that has registered an upload lease but has not yet
  // committed must serialize with full withdrawal on the same owner key.
  // Once begin commits, withdrawal snapshots both paths and preserves the
  // permanent path through processing expiry plus the final ten-minute grace.
  const inflightWithdrawalUpload = await admin.query(
    `select api_private.issue_personal_card_temp_upload(
       $1, true, 'image/jpeg', 128
     ) as result`,
    [ids.ledgerOwner],
  );
  assertStatus(
    inflightWithdrawalUpload,
    "issued",
    "in-flight withdrawal upload issuance failed",
  );
  const inflightWithdrawalUploadId = inflightWithdrawalUpload.rows[0].result.upload_id;
  const inflightWithdrawalTempPath = inflightWithdrawalUpload.rows[0].result.temp_path;
  const inflightWithdrawalToken = randomUUID();
  const inflightBeginClient = await connect();
  const withdrawalBehindBeginClient = await connect();
  clients.push(inflightBeginClient, withdrawalBehindBeginClient);
  await inflightBeginClient.query("begin");
  const inflightBegin = await inflightBeginClient.query(
    `select api_private.begin_personal_card_promotion(
       $1, true, $2, $3, 'in-flight withdrawal', $4
     ) as result`,
    [
      ids.ledgerOwner,
      ledgerAcquisition.id,
      inflightWithdrawalTempPath,
      inflightWithdrawalToken,
    ],
  );
  assertStatus(inflightBegin, "ready", "in-flight withdrawal begin failed");
  const inflightWithdrawalPermanentPath = inflightBegin.rows[0].result.permanent_path;
  const withdrawalBehindBeginPromise = withdrawalBehindBeginClient.query(
    `select api_private.request_location_withdrawal($1) as result`,
    [ids.ledgerOwner],
  );
  await waitForLock(
    admin,
    withdrawalBehindBeginClient.processID,
    "withdrawal behind an in-flight field begin",
  );
  await inflightBeginClient.query("commit");
  const withdrawalBehindBegin = await withdrawalBehindBeginPromise;
  assertStatus(
    withdrawalBehindBegin,
    "location_withdrawal_pending",
    "withdrawal behind an in-flight field begin failed",
  );
  const inFlightManifest = await admin.query(
    `select
       item.bucket,
       item.object_path,
       item.final_delete_after,
       upload.processing_expires_at,
       upload.signed_url_expires_at
     from private.data_erasure_jobs as job
     join private.data_erasure_manifest as item on item.job_id = job.id
     join private.personal_card_temp_uploads as upload on upload.id = $2
     where job.user_id = $1
       and job.scope = 'location_withdrawal'
       and job.state <> 'completed'
       and item.object_path in ($3, $4)`,
    [
      ledgerOwnerUserId,
      inflightWithdrawalUploadId,
      inflightWithdrawalTempPath,
      inflightWithdrawalPermanentPath,
    ],
  );
  assert(inFlightManifest.rowCount === 2, "withdrawal missed an in-flight object path");
  const inFlightPermanentItem = inFlightManifest.rows.find(
    (item) => item.bucket === "personal-cards",
  );
  const inFlightTempItem = inFlightManifest.rows.find(
    (item) => item.bucket === "personal-card-temp",
  );
  assert(
    inFlightPermanentItem !== undefined
      && new Date(inFlightPermanentItem.final_delete_after).getTime()
        >= new Date(inFlightPermanentItem.processing_expires_at).getTime() + 10 * 60 * 1000,
    "withdrawal permanent final boundary preceded the in-flight upload lease grace",
  );
  assert(
    inFlightTempItem !== undefined
      && new Date(inFlightTempItem.final_delete_after).getTime()
        >= new Date(inFlightTempItem.signed_url_expires_at).getTime() + 10 * 60 * 1000,
    "withdrawal temp final boundary preceded the signed-upload grace",
  );
  addedScenarioCount += 1;
  await closeScenarioClients(inflightBeginClient, withdrawalBehindBeginClient);

  // A first acquisition holds the card row FOR SHARE. A concurrent update to
  // image/color/identity must wait, then fail after seeing that acquisition;
  // FOR KEY SHARE would be too weak for non-key updates such as color_hex.
  const snapshotAcquisitionClient = await connect();
  const snapshotUpdateClient = await connect();
  clients.push(snapshotAcquisitionClient, snapshotUpdateClient);
  await snapshotAcquisitionClient.query("begin");
  const snapshotAttemptKey = randomUUID();
  await snapshotAcquisitionClient.query(
     `insert into private.location_use_facts (
       user_id, idempotency_key, spot_id, purpose
     ) values ($1::uuid, $2::uuid, $3::uuid, 'field_acquisition')`,
    [logicalUserByAuth.get(ids.inviteB), snapshotAttemptKey, ids.spotRace],
  );
  const snapshotAcquisition = await snapshotAcquisitionClient.query(
     `insert into public.acquisitions (
       user_id, spot_id, card_id, acquisition_type, verification_result,
       idempotency_key, field_sequence, acquired_at
     )
     select
       $1::uuid, $2::uuid, $3::uuid, 'field', 'passed', $4::uuid, 1,
       fact_row.collected_at
     from private.location_use_facts as fact_row
     where fact_row.user_id = $1::uuid
       and fact_row.idempotency_key = $4::uuid
       and fact_row.purpose = 'field_acquisition'
     returning id`,
    [logicalUserByAuth.get(ids.inviteB), ids.spotRace, ids.cardRace, snapshotAttemptKey],
  );
  await snapshotAcquisitionClient.query(
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
       where acquisition_row.id = $1::uuid`,
      [snapshotAcquisition.rows[0].id],
    );
  const snapshotUpdatePromise = snapshotUpdateClient.query(
    "update public.cards set color_hex = '#8899AA' where id = $1",
    [ids.cardRace],
  );
  await waitForLock(admin, snapshotUpdateClient.processID, "acquired card snapshot update");
  await snapshotAcquisitionClient.query("commit");
  let snapshotUpdateError;
  try {
    await snapshotUpdatePromise;
  } catch (error) {
    snapshotUpdateError = error;
  }
  assert(
    snapshotUpdateError?.code === "23514",
    "concurrent acquired-card snapshot mutation was not rejected",
  );
  await closeScenarioClients(snapshotAcquisitionClient, snapshotUpdateClient);

  // A collection read holds the active identity FOR SHARE until its
  // transaction ends. Recovery claim must wait rather than revoke the
  // binding while a protected read is being assembled.
  const collectionClient = await connect();
  const claimClientFour = await connect();
  clients.push(collectionClient, claimClientFour);
  await collectionClient.query("begin");
  const collectionResult = await collectionClient.query(
    `select api_private.get_user_collection($1, 1, null, null) as result`,
    [ids.issueTarget],
  );
  assert(resultStatus(collectionResult) === "ready", "collection fixture read failed");
  const claimBehindCollectionPromise = claimClientFour.query(
    `select api_private.claim_recovery_code($1, $2) as result`,
    [ids.issueClaimant, newIssueRecoveryHash],
  );
  await waitForLock(admin, claimClientFour.processID, "claim behind collection");
  await collectionClient.query("commit");
  const claimBehindCollection = await claimBehindCollectionPromise;
  assert(
    resultStatus(claimBehindCollection) === "restored",
    "claim did not serialize behind collection read",
  );
  await closeScenarioClients(collectionClient, claimClientFour);

  // Two claims by the same disposable auth user serialize on its age/auth
  // advisory. The winner rebinds once; the waiter re-evaluates the recovered
  // non-empty logical user instead of consuming the code twice.
  const sameClaimClientA = await connect();
  const sameClaimClientB = await connect();
  clients.push(sameClaimClientA, sameClaimClientB);
  await sameClaimClientA.query("begin");
  const sameClaimWinner = await sameClaimClientA.query(
    `select api_private.claim_recovery_code($1, $2) as result`,
    [ids.sameClaimClaimant, sameClaimRecoveryHash],
  );
  assertStatus(sameClaimWinner, "restored", "same-claim first recovery failed");
  const sameClaimWaiterPromise = sameClaimClientB.query(
    `select api_private.claim_recovery_code($1, $2) as result`,
    [ids.sameClaimClaimant, sameClaimRecoveryHash],
  );
  await waitForLock(admin, sameClaimClientB.processID, "same-claim recovery waiter");
  await sameClaimClientA.query("commit");
  const sameClaimWaiter = await sameClaimWaiterPromise;
  assertStatus(
    sameClaimWaiter,
    "not_empty",
    "same-claim recovery did not recheck the rebound logical user",
  );
  const sameClaimBinding = await admin.query(
    `select user_id
     from private.user_identities
     where auth_user_id = $1 and revoked_at is null`,
    [ids.sameClaimClaimant],
  );
  assert(
    sameClaimBinding.rowCount === 1
      && sameClaimBinding.rows[0].user_id
        === logicalUserByAuth.get(ids.sameClaimTarget),
    "same-claim recovery did not leave one target binding",
  );
  addedScenarioCount += 1;
  await closeScenarioClients(sameClaimClientA, sameClaimClientB);

  // Attestation first: keep its transaction open on the claimant-scoped
  // advisory, prove recovery waits, then verify the rebind trigger moves the
  // boolean-only attestation to the recovered logical user exactly once.
  const ageFirstAttestationClient = await connect();
  const ageFirstClaimClient = await connect();
  clients.push(ageFirstAttestationClient, ageFirstClaimClient);
  const ageFirstSourceUserId = logicalUserByAuth.get(ids.ageFirstClaimant);
  const ageFirstTargetUserId = logicalUserByAuth.get(ids.ageFirstTarget);
  await ageFirstAttestationClient.query("begin");
  const ageFirstAttestation = await ageFirstAttestationClient.query(
    `select api_private.record_minimum_age_attestation(
       $1, '{"minimum_age_passed":true,"version":"18plus-v1"}'::jsonb
     ) as result`,
    [ids.ageFirstClaimant],
  );
  assertStatus(ageFirstAttestation, "attested", "age-first attestation failed");
  const claimBehindAgePromise = ageFirstClaimClient.query(
    `select api_private.claim_recovery_code($1, $2) as result`,
    [ids.ageFirstClaimant, ageFirstRecoveryHash],
  );
  await waitForLock(admin, ageFirstClaimClient.processID, "claim behind age attestation");
  await ageFirstAttestationClient.query("commit");
  const claimBehindAge = await claimBehindAgePromise;
  assertStatus(claimBehindAge, "restored", "claim behind age attestation failed");
  const ageFirstRows = await admin.query(
    `select user_id
     from private.minimum_age_attestations
     where user_id = any($1::uuid[])
     order by user_id`,
    [[ageFirstSourceUserId, ageFirstTargetUserId]],
  );
  assert(
    ageFirstRows.rowCount === 1
      && ageFirstRows.rows[0].user_id === ageFirstTargetUserId,
    "age-first recovery did not move exactly one attestation to the target",
  );
  addedScenarioCount += 1;
  await closeScenarioClients(ageFirstAttestationClient, ageFirstClaimClient);

  // Recovery first: hold the successful rebind transaction so a concurrent
  // attestation waits on the same auth advisory, then resolves the new active
  // target instead of writing to the disposable source.
  const claimFirstClaimClient = await connect();
  const claimFirstAttestationClient = await connect();
  clients.push(claimFirstClaimClient, claimFirstAttestationClient);
  const claimFirstSourceUserId = logicalUserByAuth.get(ids.claimFirstClaimant);
  const claimFirstTargetUserId = logicalUserByAuth.get(ids.claimFirstTarget);
  await claimFirstClaimClient.query("begin");
  const claimFirstClaim = await claimFirstClaimClient.query(
    `select api_private.claim_recovery_code($1, $2) as result`,
    [ids.claimFirstClaimant, claimFirstRecoveryHash],
  );
  assertStatus(claimFirstClaim, "restored", "claim-first recovery failed");
  const ageBehindClaimPromise = claimFirstAttestationClient.query(
    `select api_private.record_minimum_age_attestation(
       $1, '{"minimum_age_passed":true,"version":"18plus-v1"}'::jsonb
     ) as result`,
    [ids.claimFirstClaimant],
  );
  await waitForLock(
    admin,
    claimFirstAttestationClient.processID,
    "age attestation behind recovery claim",
  );
  await claimFirstClaimClient.query("commit");
  const ageBehindClaim = await ageBehindClaimPromise;
  assertStatus(ageBehindClaim, "attested", "attestation behind recovery failed");
  const claimFirstRows = await admin.query(
    `select user_id
     from private.minimum_age_attestations
     where user_id = any($1::uuid[])
     order by user_id`,
    [[claimFirstSourceUserId, claimFirstTargetUserId]],
  );
  assert(
    claimFirstRows.rowCount === 1
      && claimFirstRows.rows[0].user_id === claimFirstTargetUserId,
    "claim-first attestation did not land exactly once on the recovered target",
  );
  addedScenarioCount += 1;
  await closeScenarioClients(claimFirstClaimClient, claimFirstAttestationClient);

  // A location terminal write that already holds the source active identity
  // completes first. Recovery then takes the identity UPDATE lock, removes
  // the zero-acquisition source fact/event/consent under the owner lock, and
  // leaves only a target-scoped anti-replay digest.
  const locationRecoverySourceUserId = logicalUserByAuth.get(ids.locationRecoveryClaimant);
  const locationRecoveryTargetUserId = logicalUserByAuth.get(ids.locationRecoveryTarget);
  const locationRecoveryAttemptKey = randomUUID();
  const locationRecoveryMinimizedKey = randomUUID();
  await admin.query(
    `insert into private.location_attempt_tombstones (
       owner_fingerprint, attempt_key_fingerprint, expires_at
     ) values (
       private.location_attempt_owner_fingerprint($1),
       private.location_attempt_key_fingerprint($2),
       clock_timestamp() + interval '6 months'
     )`,
    [locationRecoverySourceUserId, locationRecoveryMinimizedKey],
  );
  const locationRecoveryContext = await admin.query(
    `select api_private.acquire_context_unrated($1, $2, $3, true) as result`,
    [ids.locationRecoveryClaimant, ids.spotOne, locationRecoveryAttemptKey],
  );
  assertStatus(
    locationRecoveryContext,
    "ready",
    "location/recovery pending fact fixture failed",
  );
  const locationWriteClient = await connect();
  const recoveryBehindLocationClient = await connect();
  clients.push(locationWriteClient, recoveryBehindLocationClient);
  await locationWriteClient.query("begin");
  const locationFailure = await locationWriteClient.query(
    `select api_private.record_acquire_failure_unrated(
       $1, $2, $3, 'LOW_ACCURACY', '{"retry":true}'::jsonb
     ) as result`,
    [ids.locationRecoveryClaimant, ids.spotOne, locationRecoveryAttemptKey],
  );
  assertStatus(locationFailure, "failed", "location/recovery failure write failed");
  const recoveryBehindLocationPromise = recoveryBehindLocationClient.query(
    `select api_private.claim_recovery_code($1, $2) as result`,
    [ids.locationRecoveryClaimant, locationRecoveryHash],
  );
  await waitForLock(
    admin,
    recoveryBehindLocationClient.processID,
    "recovery behind source location write",
  );
  await locationWriteClient.query("commit");
  const recoveryBehindLocation = await recoveryBehindLocationPromise;
  assertStatus(
    recoveryBehindLocation,
    "restored",
    "recovery behind source location write failed",
  );
  const locationRecoveryResidual = await admin.query(
    `select
       (
         select count(*)::integer
         from private.location_use_facts
         where user_id = any($1::uuid[])
       ) as fact_count,
       (
         select count(*)::integer
         from analytics.events
         where user_id = any($1::uuid[])
           and event_name = 'acquire_fail'
       ) as event_count,
       (
         select count(*)::integer
         from private.location_consents
         where user_id = $2
       ) as source_consent_count,
       private.location_attempt_is_tombstoned($3, $4) as target_tombstoned,
       private.location_attempt_is_tombstoned($2, $5) as source_minimized_tombstoned,
       private.location_attempt_is_tombstoned($3, $5) as target_minimized_tombstoned`,
    [
      [locationRecoverySourceUserId, locationRecoveryTargetUserId],
      locationRecoverySourceUserId,
      locationRecoveryTargetUserId,
      locationRecoveryAttemptKey,
      locationRecoveryMinimizedKey,
    ],
  );
  assert(
    locationRecoveryResidual.rows[0].fact_count === 0
      && locationRecoveryResidual.rows[0].event_count === 0
      && locationRecoveryResidual.rows[0].source_consent_count === 0
      && locationRecoveryResidual.rows[0].target_tombstoned
      && !locationRecoveryResidual.rows[0].source_minimized_tombstoned
      && locationRecoveryResidual.rows[0].target_minimized_tombstoned,
    "recovery left source location state or failed to preserve target anti-replay",
  );
  locationAttemptTombstones.push({
    userId: locationRecoveryTargetUserId,
    idempotencyKey: locationRecoveryAttemptKey,
  });
  locationAttemptTombstones.push({
    userId: locationRecoveryTargetUserId,
    idempotencyKey: locationRecoveryMinimizedKey,
  });
  addedScenarioCount += 1;
  await closeScenarioClients(locationWriteClient, recoveryBehindLocationClient);

  // Cross A<->B recovery claims both reach the deterministic identity-row
  // lock set before release. Exactly one rebind can win; the loser is
  // unauthorized after recheck. The single source attestation follows the
  // surviving active logical user without duplication.
  await blocker.query("begin");
  await blocker.query(
    `select identity_row.id
     from private.user_identities as identity_row
     where identity_row.user_id = any($1::uuid[])
       and identity_row.revoked_at is null
     order by identity_row.user_id::text, identity_row.auth_user_id::text
     limit 1
     for update`,
    [[crossRecoveryAUserId, crossRecoveryBUserId]],
  );
  const crossClaimClientA = await connect();
  const crossClaimClientB = await connect();
  clients.push(crossClaimClientA, crossClaimClientB);
  const crossClaimPromiseA = crossClaimClientA.query(
    `select api_private.claim_recovery_code($1, $2) as result`,
    [ids.crossRecoveryA, crossRecoveryHashB],
  );
  const crossClaimPromiseB = crossClaimClientB.query(
    `select api_private.claim_recovery_code($1, $2) as result`,
    [ids.crossRecoveryB, crossRecoveryHashA],
  );
  await waitForLock(admin, crossClaimClientA.processID, "cross recovery A");
  await waitForLock(admin, crossClaimClientB.processID, "cross recovery B");
  await blocker.query("commit");
  const crossClaimStatuses = (await Promise.all([
    crossClaimPromiseA,
    crossClaimPromiseB,
  ])).map(resultStatus).sort();
  assert(
    JSON.stringify(crossClaimStatuses)
      === JSON.stringify(["restored", "unauthorized"]),
    `cross recovery returned ${JSON.stringify(crossClaimStatuses)}`,
  );
  const crossActiveBindings = await admin.query(
    `select user_id
     from private.user_identities
     where auth_user_id = any($1::uuid[])
       and revoked_at is null`,
    [[ids.crossRecoveryA, ids.crossRecoveryB]],
  );
  assert(crossActiveBindings.rowCount === 1, "cross recovery left duplicate active bindings");
  const crossAgeRows = await admin.query(
    `select user_id
     from private.minimum_age_attestations
     where user_id = any($1::uuid[])`,
    [[crossRecoveryAUserId, crossRecoveryBUserId]],
  );
  assert(
    crossAgeRows.rowCount === 1
      && crossAgeRows.rows[0].user_id === crossActiveBindings.rows[0].user_id,
    "cross recovery duplicated or lost the surviving age attestation",
  );
  addedScenarioCount += 1;
  await closeScenarioClients(crossClaimClientA, crossClaimClientB);

  // Withdrawal first with no consent row: legacy field data forces an
  // erasure job. A later acceptance must wait on the owner advisory and then
  // fail closed instead of inserting the formerly absent consent row.
  const withdrawalFirstUserId = logicalUserByAuth.get(ids.consentWithdrawalFirst);
  const withdrawalFirstAcquisition = await createDirectFieldAcquisition(admin, {
    userId: withdrawalFirstUserId,
    spotId: ids.spotOne,
    cardId: ids.cardOne,
    aged: true,
  });
  locationAttemptTombstones.push({
    userId: withdrawalFirstUserId,
    idempotencyKey: withdrawalFirstAcquisition.idempotencyKey,
  });
  const withdrawalFirstClient = await connect();
  const acceptanceBehindWithdrawalClient = await connect();
  clients.push(withdrawalFirstClient, acceptanceBehindWithdrawalClient);
  await withdrawalFirstClient.query("begin");
  const withdrawalFirst = await withdrawalFirstClient.query(
    `select api_private.request_location_withdrawal($1) as result`,
    [ids.consentWithdrawalFirst],
  );
  assertStatus(
    withdrawalFirst,
    "location_withdrawal_pending",
    "absent-row withdrawal fixture failed",
  );
  const acceptanceBehindWithdrawalPromise = acceptanceBehindWithdrawalClient.query(
    `select api_private.accept_location_consent(
       $1, jsonb_build_object('version', $2::text, 'locale', 'ko')
     ) as result`,
    [ids.consentWithdrawalFirst, policyFixture.version],
  );
  await waitForLock(
    admin,
    acceptanceBehindWithdrawalClient.processID,
    "acceptance behind absent-row withdrawal",
  );
  await withdrawalFirstClient.query("commit");
  const acceptanceBehindWithdrawal = await acceptanceBehindWithdrawalPromise;
  assertStatus(
    acceptanceBehindWithdrawal,
    "location_withdrawal_pending",
    "acceptance inserted behind absent-row withdrawal",
  );
  const withdrawalFirstConsent = await admin.query(
    `select count(*)::integer as count
     from private.location_consents
     where user_id = $1`,
    [withdrawalFirstUserId],
  );
  assert(
    withdrawalFirstConsent.rows[0].count === 0,
    "withdrawal-first race created a location-consent row",
  );
  addedScenarioCount += 1;
  await closeScenarioClients(withdrawalFirstClient, acceptanceBehindWithdrawalClient);

  // Acceptance first from the same absent-row state: hold the accepted row
  // uncommitted, prove withdrawal queues on the owner key, and require the
  // final state to become withdrawal_pending after the acceptance commits.
  const acceptanceFirstUserId = logicalUserByAuth.get(ids.consentAcceptanceFirst);
  const acceptanceFirstClient = await connect();
  const withdrawalBehindAcceptanceClient = await connect();
  clients.push(acceptanceFirstClient, withdrawalBehindAcceptanceClient);
  await acceptanceFirstClient.query("begin");
  const acceptanceFirst = await acceptanceFirstClient.query(
    `select api_private.accept_location_consent(
       $1, jsonb_build_object('version', $2::text, 'locale', 'ko')
     ) as result`,
    [ids.consentAcceptanceFirst, policyFixture.version],
  );
  assertStatus(acceptanceFirst, "active", "absent-row acceptance fixture failed");
  const withdrawalBehindAcceptancePromise = withdrawalBehindAcceptanceClient.query(
    `select api_private.request_location_withdrawal($1) as result`,
    [ids.consentAcceptanceFirst],
  );
  await waitForLock(
    admin,
    withdrawalBehindAcceptanceClient.processID,
    "withdrawal behind absent-row acceptance",
  );
  await acceptanceFirstClient.query("commit");
  const withdrawalBehindAcceptance = await withdrawalBehindAcceptancePromise;
  assertStatus(
    withdrawalBehindAcceptance,
    "location_withdrawal_pending",
    "withdrawal behind absent-row acceptance failed",
  );
  const acceptanceFirstConsent = await admin.query(
    `select state::text as state
     from private.location_consents
     where user_id = $1`,
    [acceptanceFirstUserId],
  );
  assert(
    acceptanceFirstConsent.rows[0]?.state === "withdrawal_pending",
    "acceptance-first race did not converge on withdrawal_pending",
  );
  addedScenarioCount += 1;
  await closeScenarioClients(acceptanceFirstClient, withdrawalBehindAcceptanceClient);

  // A six-month-old failed-only fact is still part of a full-withdrawal
  // snapshot. Hold the request transaction after it has taken the owner key
  // but before its job is visible. Retention uses a non-blocking attempt on
  // that same key, so it must return without deleting the fact; after commit,
  // the visible pending job continues to exclude the row from retention.
  const purgeWithdrawalUserId = logicalUserByAuth.get(ids.purgeWithdrawalRace);
  const purgeWithdrawalAttemptKey = randomUUID();
  const purgeWithdrawalFact = await admin.query(
    `insert into private.location_use_facts (
       user_id, idempotency_key, spot_id, purpose, collected_at, decided_at,
       outcome, terminal_failure_code, terminal_failure_details
     ) values (
       $1, $2, $3, 'field_acquisition',
       now() - interval '7 months 1 minute', now() - interval '7 months',
       'failed', 'LOW_ACCURACY', '{"retry":true}'::jsonb
     )
     returning id, decided_at`,
    [purgeWithdrawalUserId, purgeWithdrawalAttemptKey, ids.spotOne],
  );
  await admin.query(
    `insert into analytics.events (
       user_id, event_name, source, occurred_at, spot_id, properties,
       location_use_fact_id
     ) values (
       $1, 'acquire_fail', 'server', $2, $3,
       '{"code":"LOW_ACCURACY"}'::jsonb, $4
     )`,
    [
      purgeWithdrawalUserId,
      purgeWithdrawalFact.rows[0].decided_at,
      ids.spotOne,
      purgeWithdrawalFact.rows[0].id,
    ],
  );
  const purgeWithdrawalClient = await connect();
  const purgeDuringWithdrawalClient = await connect();
  clients.push(purgeWithdrawalClient, purgeDuringWithdrawalClient);
  await purgeWithdrawalClient.query("begin");
  const purgeWithdrawal = await purgeWithdrawalClient.query(
    `select api_private.request_location_withdrawal($1) as result`,
    [ids.purgeWithdrawalRace],
  );
  assertStatus(
    purgeWithdrawal,
    "location_withdrawal_pending",
    "failed-only withdrawal fixture failed",
  );
  const purgeDuringWithdrawal = await purgeDuringWithdrawalClient.query(
    `select api_private.purge_expired_location_compliance_records(10000) as result`,
  );
  assertStatus(
    purgeDuringWithdrawal,
    "purged",
    "retention purge did not return while withdrawal held the owner key",
  );
  const factDuringWithdrawal = await admin.query(
    `select count(*)::integer as count
     from private.location_use_facts
     where id = $1`,
    [purgeWithdrawalFact.rows[0].id],
  );
  assert(
    factDuringWithdrawal.rows[0].count === 1,
    "retention purge deleted an uncommitted withdrawal snapshot fact",
  );
  await purgeWithdrawalClient.query("commit");
  const purgeAfterWithdrawal = await purgeDuringWithdrawalClient.query(
    `select api_private.purge_expired_location_compliance_records(10000) as result`,
  );
  assertStatus(
    purgeAfterWithdrawal,
    "purged",
    "post-withdrawal retention purge failed",
  );
  const factAfterWithdrawal = await admin.query(
    `select count(*)::integer as count
     from private.location_use_facts
     where id = $1`,
    [purgeWithdrawalFact.rows[0].id],
  );
  assert(
    factAfterWithdrawal.rows[0].count === 1,
    "visible withdrawal job did not keep the failed-only fact",
  );
  locationAttemptTombstones.push({
    userId: purgeWithdrawalUserId,
    idempotencyKey: purgeWithdrawalAttemptKey,
  });
  addedScenarioCount += 1;
  await closeScenarioClients(purgeWithdrawalClient, purgeDuringWithdrawalClient);

  const spotOneTimestamp = await admin.query(
    `select updated_at::text as updated_at
     from public.spots
     where id = $1`,
    [ids.spotOne],
  );

  // Approval first vs aged acquire_context replay. The approved correction
  // commits its tombstone and pending state before the waiter rechecks; no new
  // location fact may be recreated for the retention-aged acquisition.
  const approvalContextUserId = logicalUserByAuth.get(ids.approvalVsContext);
  const approvalContextAcquisition = await createDirectFieldAcquisition(admin, {
    userId: approvalContextUserId,
    spotId: ids.spotOne,
    cardId: ids.cardOne,
    aged: true,
  });
  const approvalContextRequestId = await createCorrectionRequest(admin, {
    authUserId: ids.approvalVsContext,
    fieldAcquisitionId: approvalContextAcquisition.id,
  });
  const approvalContextAdminClient = await connect();
  const contextBehindApprovalClient = await connect();
  clients.push(approvalContextAdminClient, contextBehindApprovalClient);
  await approvalContextAdminClient.query("begin");
  const approvalBeforeContext = await approvalContextAdminClient.query(
    `select api_private.resolve_location_correction_admin(
       $1, $2, 'accepted'
     ) as result`,
    [ids.retroAdmin, approvalContextRequestId],
  );
  assertStatus(
    approvalBeforeContext,
    "correction_pending",
    "correction approval before context failed",
  );
  const contextBehindApprovalPromise = contextBehindApprovalClient.query(
    `select api_private.acquire_context_unrated($1, $2, $3, true) as result`,
    [ids.approvalVsContext, ids.spotOne, approvalContextAcquisition.idempotencyKey],
  );
  await waitForLock(
    admin,
    contextBehindApprovalClient.processID,
    "aged acquire context behind correction approval",
  );
  await approvalContextAdminClient.query("commit");
  const contextBehindApproval = await contextBehindApprovalPromise;
  assert(
    resultStatus(contextBehindApproval) === "error"
      && contextBehindApproval.rows[0].result.code === "LOCATION_CORRECTION_PENDING",
    `context behind approval returned ${JSON.stringify(contextBehindApproval.rows[0]?.result)}`,
  );
  const approvalContextFactCount = await admin.query(
    `select count(*)::integer as count
     from private.location_use_facts
     where user_id = $1 and idempotency_key = $2`,
    [approvalContextUserId, approvalContextAcquisition.idempotencyKey],
  );
  assert(
    approvalContextFactCount.rows[0].count === 0,
    "aged context replay recreated a location-use fact behind approval",
  );
  locationAttemptTombstones.push({
    userId: approvalContextUserId,
    idempotencyKey: approvalContextAcquisition.idempotencyKey,
  });
  addedScenarioCount += 1;
  await closeScenarioClients(approvalContextAdminClient, contextBehindApprovalClient);

  // Approval first vs aged acquire_commit replay follows the same owner ->
  // acquisition -> fact order and must return the pending-correction terminal
  // status rather than replaying the collection item.
  const approvalCommitUserId = logicalUserByAuth.get(ids.approvalVsCommit);
  const approvalCommitAcquisition = await createDirectFieldAcquisition(admin, {
    userId: approvalCommitUserId,
    spotId: ids.spotOne,
    cardId: ids.cardOne,
    aged: true,
  });
  const approvalCommitRequestId = await createCorrectionRequest(admin, {
    authUserId: ids.approvalVsCommit,
    fieldAcquisitionId: approvalCommitAcquisition.id,
  });
  const approvalCommitAdminClient = await connect();
  const commitBehindApprovalClient = await connect();
  clients.push(approvalCommitAdminClient, commitBehindApprovalClient);
  await approvalCommitAdminClient.query("begin");
  const approvalBeforeCommit = await approvalCommitAdminClient.query(
    `select api_private.resolve_location_correction_admin(
       $1, $2, 'accepted'
     ) as result`,
    [ids.retroAdmin, approvalCommitRequestId],
  );
  assertStatus(
    approvalBeforeCommit,
    "correction_pending",
    "correction approval before commit failed",
  );
  const commitBehindApprovalPromise = commitBehindApprovalClient.query(
    `select api_private.acquire_commit_unrated($1, $2, $3, true, $4) as result`,
    [
      ids.approvalVsCommit,
      ids.spotOne,
      approvalCommitAcquisition.idempotencyKey,
      spotOneTimestamp.rows[0].updated_at,
    ],
  );
  await waitForLock(
    admin,
    commitBehindApprovalClient.processID,
    "aged acquire commit behind correction approval",
  );
  await approvalCommitAdminClient.query("commit");
  const commitBehindApproval = await commitBehindApprovalPromise;
  assert(
    resultStatus(commitBehindApproval) === "error"
      && commitBehindApproval.rows[0].result.code === "LOCATION_CORRECTION_PENDING",
    `commit behind approval returned ${JSON.stringify(commitBehindApproval.rows[0]?.result)}`,
  );
  locationAttemptTombstones.push({
    userId: approvalCommitUserId,
    idempotencyKey: approvalCommitAcquisition.idempotencyKey,
  });
  addedScenarioCount += 1;
  await closeScenarioClients(approvalCommitAdminClient, commitBehindApprovalClient);

  // Failure first vs approval exercises the other serialization direction.
  // The terminal failure remains atomic, then approval re-reads the now-final
  // fact and is allowed to create the targeted correction job.
  const approvalFailureUserId = logicalUserByAuth.get(ids.approvalVsFailure);
  const approvalFailureAttemptKey = randomUUID();
  const approvalFailureContext = await admin.query(
    `select api_private.acquire_context_unrated($1, $2, $3, true) as result`,
    [ids.approvalVsFailure, ids.spotOne, approvalFailureAttemptKey],
  );
  assertStatus(approvalFailureContext, "ready", "approval/failure context fixture failed");
  const approvalFailureFact = await admin.query(
    `select id
     from private.location_use_facts
     where user_id = $1 and idempotency_key = $2`,
    [approvalFailureUserId, approvalFailureAttemptKey],
  );
  assert(approvalFailureFact.rowCount === 1, "approval/failure fact fixture missing");
  const approvalFailureRequestId = await createCorrectionRequest(admin, {
    authUserId: ids.approvalVsFailure,
    locationUseFactId: approvalFailureFact.rows[0].id,
  });
  const failureBeforeApprovalClient = await connect();
  const approvalBehindFailureClient = await connect();
  clients.push(failureBeforeApprovalClient, approvalBehindFailureClient);
  await failureBeforeApprovalClient.query("begin");
  const failureBeforeApproval = await failureBeforeApprovalClient.query(
    `select api_private.record_acquire_failure_unrated(
       $1, $2, $3, 'OUT_OF_RANGE', '{"distance_band":"near"}'::jsonb
     ) as result`,
    [ids.approvalVsFailure, ids.spotOne, approvalFailureAttemptKey],
  );
  assertStatus(failureBeforeApproval, "failed", "terminal failure fixture failed");
  const approvalBehindFailurePromise = approvalBehindFailureClient.query(
    `select api_private.resolve_location_correction_admin(
       $1, $2, 'accepted'
     ) as result`,
    [ids.retroAdmin, approvalFailureRequestId],
  );
  await waitForLock(
    admin,
    approvalBehindFailureClient.processID,
    "correction approval behind terminal failure",
  );
  await failureBeforeApprovalClient.query("commit");
  const approvalBehindFailure = await approvalBehindFailurePromise;
  assertStatus(
    approvalBehindFailure,
    "correction_pending",
    "approval did not re-read terminal failure",
  );
  locationAttemptTombstones.push({
    userId: approvalFailureUserId,
    idempotencyKey: approvalFailureAttemptKey,
  });
  addedScenarioCount += 1;
  await closeScenarioClients(failureBeforeApprovalClient, approvalBehindFailureClient);

  // Finish first vs each acquisition terminal RPC. Direct retention-aged
  // acquisitions cover context/commit replay without a live fact; the failure
  // case covers a correlated terminal fact. Completion deletes the exact
  // subject and commits a tombstone before each waiter resumes.
  for (const finishRace of [
    { authUserId: ids.finishVsContext, operation: "context", factBacked: false },
    { authUserId: ids.finishVsCommit, operation: "commit", factBacked: false },
    { authUserId: ids.finishVsFailure, operation: "failure", factBacked: true },
  ]) {
    const finishUserId = logicalUserByAuth.get(finishRace.authUserId);
    let finishAttemptKey;
    let correctionRequestId;
    if (finishRace.factBacked) {
      finishAttemptKey = randomUUID();
      const context = await admin.query(
        `select api_private.acquire_context_unrated($1, $2, $3, true) as result`,
        [finishRace.authUserId, ids.spotOne, finishAttemptKey],
      );
      assertStatus(context, "ready", "finish/failure context fixture failed");
      const failure = await admin.query(
        `select api_private.record_acquire_failure_unrated(
           $1, $2, $3, 'LOW_ACCURACY', '{"retry":true}'::jsonb
         ) as result`,
        [finishRace.authUserId, ids.spotOne, finishAttemptKey],
      );
      assertStatus(failure, "failed", "finish/failure terminal fixture failed");
      const fact = await admin.query(
        `select id
         from private.location_use_facts
         where user_id = $1 and idempotency_key = $2`,
        [finishUserId, finishAttemptKey],
      );
      assert(fact.rowCount === 1, "finish/failure fact fixture missing");
      correctionRequestId = await createCorrectionRequest(admin, {
        authUserId: finishRace.authUserId,
        locationUseFactId: fact.rows[0].id,
      });
    } else {
      const acquisition = await createDirectFieldAcquisition(admin, {
        userId: finishUserId,
        spotId: ids.spotOne,
        cardId: ids.cardOne,
        aged: true,
      });
      finishAttemptKey = acquisition.idempotencyKey;
      correctionRequestId = await createCorrectionRequest(admin, {
        authUserId: finishRace.authUserId,
        fieldAcquisitionId: acquisition.id,
      });
    }

    const erasureJobId = await approveCorrection(
      admin,
      ids.retroAdmin,
      correctionRequestId,
    );
    const workerToken = randomUUID();
    await leaseErasureJob(admin, workerToken, erasureJobId);
    const finishClient = await connect();
    const acquireBehindFinishClient = await connect();
    clients.push(finishClient, acquireBehindFinishClient);
    await finishClient.query("begin");
    const finished = await finishClient.query(
      `select api_private.finish_data_erasure_job($1, $2) as result`,
      [workerToken, erasureJobId],
    );
    assertStatus(finished, "completed", `${finishRace.operation} correction finish failed`);

    let acquireBehindFinishPromise;
    if (finishRace.operation === "context") {
      acquireBehindFinishPromise = acquireBehindFinishClient.query(
        `select api_private.acquire_context_unrated($1, $2, $3, true) as result`,
        [finishRace.authUserId, ids.spotOne, finishAttemptKey],
      );
    } else if (finishRace.operation === "commit") {
      acquireBehindFinishPromise = acquireBehindFinishClient.query(
        `select api_private.acquire_commit_unrated($1, $2, $3, true, $4) as result`,
        [
          finishRace.authUserId,
          ids.spotOne,
          finishAttemptKey,
          spotOneTimestamp.rows[0].updated_at,
        ],
      );
    } else {
      acquireBehindFinishPromise = acquireBehindFinishClient.query(
        `select api_private.record_acquire_failure_unrated(
           $1, $2, $3, 'OUT_OF_RANGE', '{"distance_band":"far"}'::jsonb
         ) as result`,
        [finishRace.authUserId, ids.spotOne, finishAttemptKey],
      );
    }
    await waitForLock(
      admin,
      acquireBehindFinishClient.processID,
      `${finishRace.operation} behind correction finish`,
    );
    await finishClient.query("commit");
    const acquireBehindFinish = await acquireBehindFinishPromise;
    assert(
      resultStatus(acquireBehindFinish) === "error"
        && acquireBehindFinish.rows[0].result.code === "IDEMPOTENCY_CONFLICT",
      `${finishRace.operation} behind finish returned ${JSON.stringify(acquireBehindFinish.rows[0]?.result)}`,
    );
    const erasedSubjectCounts = await admin.query(
      `select
         (select count(*)::integer
          from public.acquisitions
          where user_id = $1 and idempotency_key = $2) as acquisitions,
         (select count(*)::integer
          from private.location_use_facts
          where user_id = $1 and idempotency_key = $2) as facts`,
      [finishUserId, finishAttemptKey],
    );
    assert(
      erasedSubjectCounts.rows[0].acquisitions === 0
        && erasedSubjectCounts.rows[0].facts === 0,
      `${finishRace.operation} finish left correction subject rows`,
    );
    locationAttemptTombstones.push({
      userId: finishUserId,
      idempotencyKey: finishAttemptKey,
    });
    addedScenarioCount += 1;
    await closeScenarioClients(finishClient, acquireBehindFinishClient);
  }

  // The location wrapper must use the historical moderation order before it
  // reaches the field owner: admin identity -> policy -> moderation action ->
  // owner. Hold the owner externally so approve/reinstate demonstrably retain
  // the shared action key while suspend_owner with that same key waits. After
  // release, the derivative wins and the second payload is an idempotency
  // conflict instead of forming an owner <-> moderation advisory deadlock.
  for (const derivativeAction of ["approve", "reinstate"]) {
    if (derivativeAction === "reinstate") {
      const takeDown = await admin.query(
        `select api_private.moderate_personal_card_share(
           $1, $2, $3, 'take_down', 'TEST_RESET',
           'prepare reinstate lock-order race', true
         ) as result`,
        [ids.retroAdmin, ids.moderationFieldCard, randomUUID()],
      );
      assertStatus(takeDown, "applied", "reinstate lock-order fixture failed");
    }

    const sharedClientActionId = randomUUID();
    await blocker.query("begin");
    await blocker.query(
      `select pg_advisory_xact_lock(hashtextextended(
         'danyeodam:suspend-owner:' || $1::text,
         0
       ))`,
      [blockOwnerAUserId],
    );
    const derivativeModerationClient = await connect();
    const suspensionWithSameActionClient = await connect();
    clients.push(derivativeModerationClient, suspensionWithSameActionClient);
    const derivativeModerationPromise = derivativeModerationClient.query(
      `select api_private.moderate_personal_card_share(
         $1, $2, $3, $4, 'POLICY_OK', $5, true
       ) as result`,
      [
        ids.retroAdmin,
        ids.moderationFieldCard,
        sharedClientActionId,
        derivativeAction,
        `${derivativeAction} before same-action suspension`,
      ],
    );
    await waitForLock(
      admin,
      derivativeModerationClient.processID,
      `${derivativeAction} behind owner lock`,
    );
    const suspensionWithSameActionPromise = suspensionWithSameActionClient.query(
      `select api_private.moderate_personal_card_share(
         $1, $2, $3, 'suspend_owner', 'REPEAT_ABUSE',
         'same-action suspension must serialize', true
       ) as result`,
      [ids.retroAdmin, ids.moderationFieldCard, sharedClientActionId],
    );
    await waitForLock(
      admin,
      suspensionWithSameActionClient.processID,
      `${derivativeAction} same-action suspension behind moderation key`,
    );
    await blocker.query("commit");
    const [derivativeModeration, suspensionWithSameAction] = await Promise.all([
      derivativeModerationPromise,
      suspensionWithSameActionPromise,
    ]);
    assertStatus(
      derivativeModeration,
      "applied",
      `${derivativeAction} did not win the canonical lock order`,
    );
    assertStatus(
      suspensionWithSameAction,
      "idempotency_conflict",
      `${derivativeAction} same-action suspension did not replay safely`,
    );
    const derivativeState = await admin.query(
      `select share_state::text as share_state
       from public.personal_cards
       where id = $1`,
      [ids.moderationFieldCard],
    );
    const expectedDerivativeState = derivativeAction === "approve" ? "active" : "pending";
    assert(
      derivativeState.rows[0]?.share_state === expectedDerivativeState,
      `${derivativeAction} lock-order race left ${JSON.stringify(derivativeState.rows[0])}`,
    );
    addedScenarioCount += 1;
    await closeScenarioClients(derivativeModerationClient, suspensionWithSameActionClient);
  }

  // The rate limit is per blocker, not per target pair. Hold the shared rate
  // key so both distinct-target requests demonstrably queue on the same lock;
  // after release exactly one can consume the twentieth slot.
  const preloadedBlock = await admin.query(
    `insert into private.user_blocks (blocker_user_id, blocked_user_id)
     values ($1, $2)
     returning id`,
    [blockViewerUserId, blockOwnerAUserId],
  );
  await admin.query(
    `insert into private.user_block_actions (
       blocker_user_id, blocked_user_id, block_id, client_action_id,
       action, share_secret_hash, created_at
     )
     select $1, $2, $3, gen_random_uuid(), 'block',
       extensions.digest($4, 'sha256'), clock_timestamp()
     from generate_series(1, 19)`,
    [blockViewerUserId, blockOwnerAUserId, preloadedBlock.rows[0].id, blockShareSlugA],
  );
  await blocker.query("begin");
  await blocker.query(
    `select pg_advisory_xact_lock(hashtextextended(
       'danyeodam:user-block-rate:' || $1::text,
       0
     ))`,
    [blockViewerUserId],
  );
  const blockClientA = await connect();
  const blockClientB = await connect();
  clients.push(blockClientA, blockClientB);
  const blockPromiseA = blockClientA.query(
    `select api_private.create_user_block($1, $2, $3, true) as result`,
    [ids.blockViewer, blockShareSlugA, randomUUID()],
  );
  const blockPromiseB = blockClientB.query(
    `select api_private.create_user_block($1, $2, $3, true) as result`,
    [ids.blockViewer, blockShareSlugB, randomUUID()],
  );
  await waitForLock(admin, blockClientA.processID, "first cross-owner block rate check");
  await waitForLock(admin, blockClientB.processID, "second cross-owner block rate check");
  await blocker.query("commit");
  const blockRaceStatuses = (await Promise.all([blockPromiseA, blockPromiseB]))
    .map(resultStatus)
    .sort();
  assert(
    JSON.stringify(blockRaceStatuses) === JSON.stringify(["blocked", "rate_limited"]),
    `cross-owner block rate race returned ${JSON.stringify(blockRaceStatuses)}`,
  );
  const blockActionCount = await admin.query(
    `select count(*)::integer as count
     from private.user_block_actions
     where blocker_user_id = $1
       and action = 'block'
       and created_at > clock_timestamp() - interval '1 hour'`,
    [blockViewerUserId],
  );
  assert(blockActionCount.rows[0].count === 20, "block rate race exceeded twenty actions");
  await closeScenarioClients(blockClientA, blockClientB);

  // Authenticated collection reads for one logical owner share a canonical
  // advisory key. With 59 slots preloaded, two real domain wrappers must queue
  // and converge to one completed read plus one denial.
  await admin.query(
    `insert into private.rate_limit_windows (
       user_id, purpose, attempted_at, updated_at
     ) values (
       $1,
       'collection_read',
       array(
         select clock_timestamp() - (attempt_number * interval '10 milliseconds')
         from generate_series(1, 59) as attempt_row(attempt_number)
       ),
       clock_timestamp()
     )
     on conflict (user_id, purpose) do update
     set attempted_at = excluded.attempted_at,
         updated_at = excluded.updated_at`,
    [blockViewerUserId],
  );
  await blocker.query("begin");
  await blocker.query(
    `select pg_advisory_xact_lock(hashtextextended(
       'danyeodam:authenticated-api-rate:' || $1::text,
       0
     ))`,
    [blockViewerUserId],
  );
  const authenticatedRateClientA = await connect();
  const authenticatedRateClientB = await connect();
  clients.push(authenticatedRateClientA, authenticatedRateClientB);
  const authenticatedRatePromiseA = authenticatedRateClientA.query(
    `select api_private.get_user_collection($1, 1, null, null) as result`,
    [ids.blockViewer],
  );
  const authenticatedRatePromiseB = authenticatedRateClientB.query(
    `select api_private.get_user_collection($1, 1, null, null) as result`,
    [ids.blockViewer],
  );
  await waitForLock(
    admin,
    authenticatedRateClientA.processID,
    "first authenticated API rate consumption",
  );
  await waitForLock(
    admin,
    authenticatedRateClientB.processID,
    "second authenticated API rate consumption",
  );
  await blocker.query("commit");
  const authenticatedRateStatuses = (await Promise.all([
    authenticatedRatePromiseA,
    authenticatedRatePromiseB,
  ])).map(resultStatus).sort();
  assert(
    JSON.stringify(authenticatedRateStatuses)
      === JSON.stringify(["rate_limited", "ready"]),
    `authenticated API rate race returned ${JSON.stringify(authenticatedRateStatuses)}`,
  );
  const authenticatedRateCount = await admin.query(
    `select cardinality(attempted_at)::integer as count
     from private.rate_limit_windows
     where user_id = $1 and purpose = 'collection_read'`,
    [blockViewerUserId],
  );
  assert(
    authenticatedRateCount.rows[0]?.count === 60,
    "authenticated API rate race exceeded sixty attempts",
  );
  addedScenarioCount += 1;
  await closeScenarioClients(authenticatedRateClientA, authenticatedRateClientB);

  // Exploit schedule: context consumes against source owner A, recovery then
  // rebinds the same Auth UID to owner B, and the terminal continuation tries
  // to write. The expected-owner continuation must reject without consuming
  // B capacity or creating B location facts/events.
  const rateRecoverySourceUserId = logicalUserByAuth.get(ids.rateRecoveryClaimant);
  const rateRecoveryTargetUserId = logicalUserByAuth.get(ids.rateRecoveryTarget);
  const rateRecoveryAttemptKey = randomUUID();
  const rateContextClient = await connect();
  const rateRecoveryClient = await connect();
  clients.push(rateContextClient, rateRecoveryClient);
  const rateContext = await rateContextClient.query(
    `select api_private.acquire_context($1, $2, $3, true) as result`,
    [ids.rateRecoveryClaimant, ids.spotOne, rateRecoveryAttemptKey],
  );
  assertStatus(rateContext, "ready", "rate/recovery context failed");
  assert(
    rateContext.rows[0].result.user_id === rateRecoverySourceUserId,
    "rate/recovery context returned the wrong source owner",
  );
  const rateRecovery = await rateRecoveryClient.query(
    `select api_private.claim_recovery_code($1, $2) as result`,
    [ids.rateRecoveryClaimant, rateRecoveryHash],
  );
  assertStatus(rateRecovery, "restored", "rate/recovery rebind failed");
  const continuationAfterRecovery = await rateContextClient.query(
    `select api_private.record_acquire_failure(
       $1, $2, $3, 'LOW_ACCURACY', '{"retry":true}'::jsonb, $4
     ) as result`,
    [
      ids.rateRecoveryClaimant,
      ids.spotOne,
      rateRecoveryAttemptKey,
      rateRecoverySourceUserId,
    ],
  );
  assert(
    resultStatus(continuationAfterRecovery) === "error"
      && continuationAfterRecovery.rows[0].result.code === "UNAUTHORIZED",
    "continuation crossed a recovery owner boundary",
  );
  const rateRecoveryResidual = await admin.query(
    `select
       (select count(*)::integer
        from private.location_use_facts
        where user_id = $1 and idempotency_key = $2) as facts,
       (select count(*)::integer
        from analytics.events
        where user_id = $1
          and event_name = 'acquire_fail'
          and spot_id = $3) as events,
       (select count(*)::integer
        from private.rate_limit_windows
        where user_id = $1 and purpose = 'acquire') as rate_windows,
       (select user_id
        from private.user_identities
        where auth_user_id = $4 and revoked_at is null) as active_user_id`,
    [
      rateRecoveryTargetUserId,
      rateRecoveryAttemptKey,
      ids.spotOne,
      ids.rateRecoveryClaimant,
    ],
  );
  assert(
    rateRecoveryResidual.rows[0]?.facts === 0
      && rateRecoveryResidual.rows[0]?.events === 0
      && rateRecoveryResidual.rows[0]?.rate_windows === 0
      && rateRecoveryResidual.rows[0]?.active_user_id === rateRecoveryTargetUserId,
    "rate/recovery continuation mutated or charged the recovered target",
  );
  addedScenarioCount += 1;
  await closeScenarioClients(rateContextClient, rateRecoveryClient);

  // Share submission and owner suspension serialize on the same logical-user
  // key. A suspension request queued first must commit before the later share
  // request rechecks active suspension state.
  await blocker.query("begin");
  await blocker.query(
    `select pg_advisory_xact_lock(hashtextextended(
       'danyeodam:suspend-owner:' || $1::text,
       0
     ))`,
    [blockOwnerAUserId],
  );
  const suspensionClient = await connect();
  const shareBehindSuspensionClient = await connect();
  clients.push(suspensionClient, shareBehindSuspensionClient);
  const suspensionPromise = suspensionClient.query(
    `select api_private.moderate_personal_card_share(
       $1, $2, $3, 'suspend_owner', 'REPEAT_ABUSE',
       'concurrency suspension', true
     ) as result`,
    [ids.retroAdmin, ids.blockPersonalCardA, randomUUID()],
  );
  await waitForLock(admin, suspensionClient.processID, "owner suspension");
  const shareBehindSuspensionPromise = shareBehindSuspensionClient.query(
    `select api_private.create_personal_card_share(
       $1, false, true, $2, $3
     ) as result`,
    [ids.blockOwnerA, ids.suspendPersonalCardA, randomUUID().replaceAll("-", "")],
  );
  await waitForLock(
    admin,
    shareBehindSuspensionClient.processID,
    "share behind owner suspension",
  );
  await blocker.query("commit");
  const [suspensionResult, shareBehindSuspensionResult] = await Promise.all([
    suspensionPromise,
    shareBehindSuspensionPromise,
  ]);
  assert(resultStatus(suspensionResult) === "applied", "owner suspension did not commit");
  assert(
    resultStatus(shareBehindSuspensionResult) === "account_suspended",
    `share did not recheck suspension: ${JSON.stringify(shareBehindSuspensionResult.rows[0]?.result)}`,
  );
  const racedShare = await admin.query(
    `select share_state::text as share_state, share_slug
     from public.personal_cards where id = $1`,
    [ids.suspendPersonalCardA],
  );
  assert(
    racedShare.rows[0]?.share_state === "private" && racedShare.rows[0]?.share_slug === null,
    "suspension race left a newly submitted secret behind",
  );
  await closeScenarioClients(suspensionClient, shareBehindSuspensionClient);

  // Reporting and suspension use owner advisory -> card lock. Queue
  // suspension first, then prove the report waits and fails closed after the
  // owner becomes suspended instead of inserting against hidden content.
  await blocker.query("begin");
  await blocker.query(
    `select pg_advisory_xact_lock(hashtextextended(
       'danyeodam:suspend-owner:' || $1::text,
       0
     ))`,
    [blockOwnerBUserId],
  );
  const reportSuspensionClient = await connect();
  const reportBehindSuspensionClient = await connect();
  clients.push(reportSuspensionClient, reportBehindSuspensionClient);
  const reportSuspensionPromise = reportSuspensionClient.query(
    `select api_private.moderate_personal_card_share(
       $1, $2, $3, 'suspend_owner', 'REPEAT_ABUSE',
       'suspend before concurrent report', true
     ) as result`,
    [ids.retroAdmin, ids.blockPersonalCardB, randomUUID()],
  );
  await waitForLock(admin, reportSuspensionClient.processID, "suspension before report");
  const racedReportId = randomUUID();
  const reportBehindSuspensionPromise = reportBehindSuspensionClient.query(
    `select api_private.create_content_report(
       $1, $2, 'content', 'spam', 'concurrency report', $3, true
     ) as result`,
    [blockShareSlugB, racedReportId, digest(`report-rate-${randomUUID()}`)],
  );
  await waitForLock(
    admin,
    reportBehindSuspensionClient.processID,
    "report behind owner suspension",
  );
  await blocker.query("commit");
  const [reportSuspension, reportBehindSuspension] = await Promise.all([
    reportSuspensionPromise,
    reportBehindSuspensionPromise,
  ]);
  assert(resultStatus(reportSuspension) === "applied", "report owner suspension failed");
  assert(
    resultStatus(reportBehindSuspension) === "not_found",
    `report did not fail closed after suspension: ${JSON.stringify(reportBehindSuspension.rows[0]?.result)}`,
  );
  const racedReportCount = await admin.query(
    `select count(*)::integer as count
     from private.content_reports where client_report_id = $1`,
    [racedReportId],
  );
  assert(racedReportCount.rows[0].count === 0, "suspension race persisted a hidden-content report");
  await closeScenarioClients(reportSuspensionClient, reportBehindSuspensionClient);

  // Lift the fixture suspension, then leave the share pending with the old
  // accepted set for the policy-publication/approval race below.
  const reportOwnerSuspension = await admin.query(
    `select id
     from private.share_owner_suspensions
     where user_id = $1 and lifted_at is null`,
    [blockOwnerBUserId],
  );
  assert(reportOwnerSuspension.rowCount === 1, "report race suspension fixture missing");
  const reportOwnerUnsuspend = await admin.query(
    `select api_private.moderate_share_owner_suspension(
       $1, $2, $3, 'unsuspend_owner', 'TEST_RESET',
       'reset owner for policy race'
     ) as result`,
    [ids.retroAdmin, reportOwnerSuspension.rows[0].id, randomUUID()],
  );
  assert(resultStatus(reportOwnerUnsuspend) === "applied", "report race unsuspend failed");
  const policyRaceReinstate = await admin.query(
    `select api_private.moderate_personal_card_share(
       $1, $2, $3, 'reinstate', 'POLICY_UPDATE',
       'prepare policy approval race', true
     ) as result`,
    [ids.retroAdmin, ids.blockPersonalCardB, randomUUID()],
  );
  assert(resultStatus(policyRaceReinstate) === "applied", "policy race reinstate failed");
  const policyRaceResubmit = await admin.query(
    `select api_private.create_personal_card_share(
       $1, false, true, $2, null
     ) as result`,
    [ids.blockOwnerB, ids.blockPersonalCardB],
  );
  assert(resultStatus(policyRaceResubmit) === "pending", "policy race resubmission failed");

  // A current-policy switch holds the exclusive publication key until commit.
  // Acceptance and approval both wait on the shared key, then evaluate only
  // the committed replacement IDs. The stale review must remain pending.
  const replacementVersion = `concurrency-${randomUUID()}`;
  const replacementDocuments = await createPolicyDocumentSet(admin, replacementVersion);
  transientPolicyDocumentIds.push(...replacementDocuments.map((document) => document.id));
  const switchClient = await connect();
  const acceptanceClient = await connect();
  const approvalClient = await connect();
  clients.push(switchClient, acceptanceClient, approvalClient);
  await switchClient.query("begin");
  const switched = await switchClient.query(
    `select api_private.set_current_policy_documents($1::uuid[]) as result`,
    [replacementDocuments.map((document) => document.id)],
  );
  assert(resultStatus(switched) === "switched", "replacement policy switch failed");
  const staleApprovalPromise = approvalClient.query(
    `select api_private.moderate_personal_card_share(
       $1, $2, $3, 'approve', 'POLICY_OK',
       'approval behind policy publication', true
     ) as result`,
    [ids.retroAdmin, ids.blockPersonalCardB, randomUUID()],
  );
  const oldAcceptancePromise = acceptanceClient.query(
    `select api_private.accept_current_policies($1, $2::jsonb) as result`,
    [
      ids.blockViewer,
      JSON.stringify([
        { type: "terms_of_use", version: policyFixture.version, locale: "ko" },
        { type: "community_guidelines", version: policyFixture.version, locale: "ko" },
      ]),
    ],
  );
  await waitForLock(admin, approvalClient.processID, "share approval behind publication");
  await waitForLock(admin, acceptanceClient.processID, "policy acceptance behind publication");
  await switchClient.query("commit");
  const [staleApproval, oldAcceptance] = await Promise.all([
    staleApprovalPromise,
    oldAcceptancePromise,
  ]);
  assert(
    resultStatus(staleApproval) === "conflict"
      && staleApproval.rows[0]?.result?.reason === "policy_resubmission_required",
    `stale approval race returned ${JSON.stringify(staleApproval.rows[0]?.result)}`,
  );
  const staleApprovalCard = await admin.query(
    `select card.share_state::text as share_state,
       card.share_resubmission_required,
       terms_document.version as terms_version,
       community_document.version as community_version
     from public.personal_cards as card
     join private.policy_acceptances as terms_acceptance
       on terms_acceptance.id = card.share_terms_acceptance_id
     join private.policy_documents as terms_document
       on terms_document.id = terms_acceptance.policy_document_id
     join private.policy_acceptances as community_acceptance
       on community_acceptance.id = card.share_community_acceptance_id
     join private.policy_documents as community_document
       on community_document.id = community_acceptance.policy_document_id
     where card.id = $1`,
    [ids.blockPersonalCardB],
  );
  assert(
    staleApprovalCard.rows[0]?.share_state === "pending"
      && !staleApprovalCard.rows[0]?.share_resubmission_required
      && staleApprovalCard.rows[0]?.terms_version === policyFixture.version
      && staleApprovalCard.rows[0]?.community_version === policyFixture.version,
    "policy switch race activated or normalized the stale review",
  );
  assert(resultStatus(oldAcceptance) === "policy_required", "stale policy race was accepted");
  const requiredVersions = oldAcceptance.rows[0].result.required
    .map((requirement) => requirement.version);
  assert(
    requiredVersions.length === 2
      && requiredVersions.every((version) => version === replacementVersion),
    "policy race did not return freshly recomputed requirements",
  );
  const staleAcceptanceCount = await admin.query(
    `select count(*)::integer as count
     from private.policy_acceptances
     where user_id = $1
       and policy_document_id = any($2::uuid[])`,
    [blockViewerUserId, policyFixture.documentIds],
  );
  assert(
    staleAcceptanceCount.rows[0].count === 0,
    "policy race persisted acceptance against the replaced current set",
  );
  await closeScenarioClients(switchClient, acceptanceClient, approvalClient);

  // Gift and retro derivatives use the same outer policy -> owner ordering as
  // field derivatives even though they do not need age/location checks. For
  // each type, hold policy publication exclusively and the owner key in a
  // second transaction. The derivative first waits for policy, then for the
  // owner, and finally re-evaluates only the newly committed policy set.
  let currentDerivativePolicyVersion = replacementVersion;
  for (const derivativeRace of [
    {
      acquisitionType: "gift",
      authUserId: ids.giftDerivativeOwner,
      personalCardId: ids.giftDerivativeCard,
    },
    {
      acquisitionType: "retro",
      authUserId: ids.retroDerivativeOwner,
      personalCardId: ids.retroDerivativeCard,
    },
  ]) {
    await acceptCurrentUgcPolicies(
      admin,
      derivativeRace.authUserId,
      currentDerivativePolicyVersion,
    );
    const nextPolicyVersion = `concurrency-${derivativeRace.acquisitionType}-${randomUUID()}`;
    const nextPolicyDocuments = await createPolicyDocumentSet(admin, nextPolicyVersion);
    transientPolicyDocumentIds.push(...nextPolicyDocuments.map((document) => document.id));

    const derivativeSwitchClient = await connect();
    const derivativeOwnerClient = await connect();
    const derivativeClient = await connect();
    clients.push(derivativeSwitchClient, derivativeOwnerClient, derivativeClient);
    await derivativeSwitchClient.query("begin");
    const derivativeSwitch = await derivativeSwitchClient.query(
      `select api_private.set_current_policy_documents($1::uuid[]) as result`,
      [nextPolicyDocuments.map((document) => document.id)],
    );
    assertStatus(
      derivativeSwitch,
      "switched",
      `${derivativeRace.acquisitionType} derivative policy switch failed`,
    );

    await derivativeOwnerClient.query("begin");
    const ownerPause = await derivativeOwnerClient.query(
      `select api_private.change_location_consent_state($1, 'paused') as result`,
      [derivativeRace.authUserId],
    );
    assertStatus(
      ownerPause,
      "paused",
      `${derivativeRace.acquisitionType} derivative owner-lock fixture failed`,
    );

    const derivativePromise = derivativeClient.query(
      `select api_private.create_personal_card_share(
         $1, false, true, $2, $3
       ) as result`,
      [
        derivativeRace.authUserId,
        derivativeRace.personalCardId,
        randomUUID().replaceAll("-", ""),
      ],
    );
    await waitForLock(
      admin,
      derivativeClient.processID,
      `${derivativeRace.acquisitionType} derivative behind policy publication`,
    );
    await derivativeSwitchClient.query("commit");
    await waitForLock(
      admin,
      derivativeClient.processID,
      `${derivativeRace.acquisitionType} derivative behind owner serialization`,
    );
    await derivativeOwnerClient.query("commit");
    const derivativeResult = await derivativePromise;
    assertStatus(
      derivativeResult,
      "policy_required",
      `${derivativeRace.acquisitionType} derivative did not recheck policy`,
    );
    assert(
      derivativeResult.rows[0].result.required.length === 2
        && derivativeResult.rows[0].result.required.every(
          (requirement) => requirement.version === nextPolicyVersion,
        ),
      `${derivativeRace.acquisitionType} derivative returned a mixed policy set`,
    );
    const derivativeCard = await admin.query(
      `select share_state::text as share_state, share_slug
       from public.personal_cards
       where id = $1`,
      [derivativeRace.personalCardId],
    );
    assert(
      derivativeCard.rows[0]?.share_state === "private"
        && derivativeCard.rows[0]?.share_slug === null,
      `${derivativeRace.acquisitionType} derivative mutated the card before policy acceptance`,
    );
    currentDerivativePolicyVersion = nextPolicyVersion;
    addedScenarioCount += 1;
    await closeScenarioClients(derivativeSwitchClient, derivativeOwnerClient, derivativeClient);
  }

  // Account deletion owns recovery-target -> owner serialization. Queue a
  // recovery claim behind an uncommitted deletion request: it must recheck
  // the revoked target code/identity and fail without rebinding the claimant.
  const deletionRecoveryRequestId = deletionRequestId();
  const deletionRecoveryClient = await connect();
  const deletionRecoveryClaimClient = await connect();
  clients.push(deletionRecoveryClient, deletionRecoveryClaimClient);
  await deletionRecoveryClient.query("begin");
  const deletionRecoveryRequest = await deletionRecoveryClient.query(
    `select api_private.request_account_deletion($1, $2, $3) as result`,
    [ids.deletionRecoveryTarget, deletionRecoveryRequestId, deletionTokenHash()],
  );
  assertStatus(
    deletionRecoveryRequest,
    "accepted",
    "account deletion/recovery fixture request failed",
  );
  const recoveryBehindDeletionPromise = deletionRecoveryClaimClient.query(
    `select api_private.claim_recovery_code($1, $2) as result`,
    [ids.deletionRecoveryClaimant, deletionRecoveryHash],
  );
  await queueWaitsForTransaction(
    admin,
    deletionRecoveryClaimClient.processID,
    deletionRecoveryClient.processID,
    "recovery claim behind account deletion",
  );
  await deletionRecoveryClient.query("commit");
  const recoveryBehindDeletion = await recoveryBehindDeletionPromise;
  assertStatus(
    recoveryBehindDeletion,
    "not_found",
    "recovery claim survived account deletion",
  );
  const claimantIdentityAfterDeletion = await admin.query(
    `select user_id
     from private.user_identities
     where auth_user_id = $1 and revoked_at is null`,
    [ids.deletionRecoveryClaimant],
  );
  assert(
    claimantIdentityAfterDeletion.rows[0]?.user_id
      === deletionUserByAuth.get(ids.deletionRecoveryClaimant),
    "failed recovery claim rebound the deletion target",
  );
  addedScenarioCount += 1;
  await closeScenarioClients(deletionRecoveryClient, deletionRecoveryClaimClient);

  // Invite redemption takes the active identity before writing membership.
  // A deletion queued first must revoke the binding, after which the invite
  // waiter returns unauthorized and the one-use code remains unconsumed.
  const deletionInviteRequestId = deletionRequestId();
  const deletionInviteClient = await connect();
  const inviteBehindDeletionClient = await connect();
  clients.push(deletionInviteClient, inviteBehindDeletionClient);
  await deletionInviteClient.query("begin");
  const deletionInviteRequest = await deletionInviteClient.query(
    `select api_private.request_account_deletion($1, $2, $3) as result`,
    [ids.deletionInviteTarget, deletionInviteRequestId, deletionTokenHash()],
  );
  assertStatus(deletionInviteRequest, "accepted", "account deletion/invite request failed");
  const inviteBehindDeletionPromise = inviteBehindDeletionClient.query(
    `select api_private.redeem_participant_invite($1, $2) as result`,
    [ids.deletionInviteTarget, deletionInviteHash],
  );
  await queueWaitsForTransaction(
    admin,
    inviteBehindDeletionClient.processID,
    deletionInviteClient.processID,
    "invite redemption behind account deletion",
  );
  await deletionInviteClient.query("commit");
  const inviteBehindDeletion = await inviteBehindDeletionPromise;
  assertStatus(inviteBehindDeletion, "unauthorized", "invite was redeemed after deletion");
  const deletionInviteState = await admin.query(
    `select redeemed_at
     from private.participant_invite_codes
     where code_hash = decode($1, 'hex')`,
    [deletionInviteHash],
  );
  assert(
    deletionInviteState.rows[0]?.redeemed_at === null,
    "account deletion race consumed an invite for a revoked identity",
  );
  addedScenarioCount += 1;
  await closeScenarioClients(deletionInviteClient, inviteBehindDeletionClient);

  // Upload issuance takes policy -> identity SHARE -> owner. Deletion already
  // owns identity/owner inside its open transaction, so issuance waits there
  // and must recheck to unauthorized without leaving quota/path state.
  const deletionUploadRequestId = deletionRequestId();
  const deletionUploadClient = await connect();
  const uploadBehindDeletionClient = await connect();
  clients.push(deletionUploadClient, uploadBehindDeletionClient);
  await deletionUploadClient.query("begin");
  const deletionUpload = await deletionUploadClient.query(
    `select api_private.request_account_deletion($1, $2, $3) as result`,
    [ids.deletionUploadTarget, deletionUploadRequestId, deletionTokenHash()],
  );
  assertStatus(deletionUpload, "accepted", "upload-race deletion request failed");
  const uploadBehindDeletionPromise = uploadBehindDeletionClient.query(
    `select api_private.issue_personal_card_temp_upload(
       $1, true, 'image/jpeg', 1024
     ) as result`,
    [ids.deletionUploadTarget],
  );
  await queueWaitsForTransaction(
    admin,
    uploadBehindDeletionClient.processID,
    deletionUploadClient.processID,
    "upload behind account deletion",
  );
  await deletionUploadClient.query("commit");
  const uploadBehindDeletion = await uploadBehindDeletionPromise;
  assertStatus(uploadBehindDeletion, "unauthorized", "upload was issued after deletion");
  const uploadResidue = await admin.query(
    `select
       (select count(*) from private.personal_card_temp_uploads where user_id = $1)::integer
         as upload_count,
       (select count(*) from private.personal_card_upload_rate_states where user_id = $1)::integer
         as rate_count`,
    [deletionUserByAuth.get(ids.deletionUploadTarget)],
  );
  assert(
    uploadResidue.rows[0].upload_count === 0 && uploadResidue.rows[0].rate_count === 0,
    "failed post-deletion upload left quota or path state",
  );
  addedScenarioCount += 1;
  await closeScenarioClients(deletionUploadClient, uploadBehindDeletionClient);

  // A promotion begin blocked behind an uncommitted deletion must wake after
  // identity revocation and leave neither processing fields nor a durable
  // permanent-object ledger entry.
  const deletionPromotionRequestId = deletionRequestId();
  const deletionPromotionClient = await connect();
  const promotionBehindDeletionClient = await connect();
  clients.push(deletionPromotionClient, promotionBehindDeletionClient);
  await deletionPromotionClient.query("begin");
  const deletionPromotionRequest = await deletionPromotionClient.query(
    `select api_private.request_account_deletion($1, $2, $3) as result`,
    [ids.deletionPromotionTarget, deletionPromotionRequestId, deletionTokenHash()],
  );
  assertStatus(
    deletionPromotionRequest,
    "accepted",
    "account deletion/promotion request failed",
  );
  const promotionBehindDeletionPromise = promotionBehindDeletionClient.query(
    `select api_private.begin_personal_card_promotion(
       $1, false, $2, $3, 'promotion behind deletion', $4
     ) as result`,
    [
      ids.deletionPromotionTarget,
      promotionAcquisition.rows[0].id,
      deletionPromotionTempPath,
      randomUUID(),
    ],
  );
  await queueWaitsForTransaction(
    admin,
    promotionBehindDeletionClient.processID,
    deletionPromotionClient.processID,
    "promotion begin behind account deletion",
  );
  await deletionPromotionClient.query("commit");
  const promotionBehindDeletion = await promotionBehindDeletionPromise;
  assertStatus(promotionBehindDeletion, "unauthorized", "promotion began after deletion");
  const promotionResidue = await admin.query(
    `select
       upload_row.processing_token,
       upload_row.processing_permanent_path,
       (select count(*)
        from private.personal_card_field_object_ledger as ledger_row
        where ledger_row.user_id = upload_row.user_id)::integer as field_ledger_count,
       (select count(*)
        from private.personal_card_permanent_object_ledger as ledger_row
        where ledger_row.user_id = upload_row.user_id)::integer as generic_ledger_count
     from private.personal_card_temp_uploads as upload_row
     where upload_row.id = $1`,
    [deletionPromotionUploadId],
  );
  assert(
    promotionResidue.rowCount === 1
      && promotionResidue.rows[0].processing_token === null
      && promotionResidue.rows[0].processing_permanent_path === null
      && promotionResidue.rows[0].field_ledger_count === 0
      && promotionResidue.rows[0].generic_ledger_count === 0,
    "failed post-deletion promotion mutated upload or ledger state",
  );
  addedScenarioCount += 1;
  await closeScenarioClients(deletionPromotionClient, promotionBehindDeletionClient);

  // A leased location-erasure worker resolves the owner before taking the
  // owner advisory. Account deletion wins that advisory and removes the old
  // location job; the waiter must recheck to not_found rather than deleting
  // data through a state machine that the account manifest superseded.
  const locationWorkerJobId = randomUUID();
  const locationWorkerToken = randomUUID();
  await admin.query(
    `insert into private.data_erasure_jobs (
       id, user_id, scope, state, attempt_count, next_attempt_at,
       lease_token, lease_expires_at
     ) values (
       $1, $2, 'location_withdrawal', 'database_pending', 1,
       clock_timestamp(), $3, clock_timestamp() + interval '5 minutes'
     )`,
    [
      locationWorkerJobId,
      deletionUserByAuth.get(ids.deletionLocationTarget),
      locationWorkerToken,
    ],
  );
  const deletionLocationRequestId = deletionRequestId();
  const deletionLocationClient = await connect();
  const locationWorkerClient = await connect();
  clients.push(deletionLocationClient, locationWorkerClient);
  await deletionLocationClient.query("begin");
  const deletionLocationRequest = await deletionLocationClient.query(
    `select api_private.request_account_deletion($1, $2, $3) as result`,
    [ids.deletionLocationTarget, deletionLocationRequestId, deletionTokenHash()],
  );
  assertStatus(
    deletionLocationRequest,
    "accepted",
    "account deletion/location-worker request failed",
  );
  const locationWorkerPromise = locationWorkerClient.query(
    `select api_private.finish_data_erasure_job($1, $2) as result`,
    [locationWorkerToken, locationWorkerJobId],
  );
  await queueWaitsForTransaction(
    admin,
    locationWorkerClient.processID,
    deletionLocationClient.processID,
    "location erasure worker behind account deletion",
  );
  await deletionLocationClient.query("commit");
  const locationWorkerResult = await locationWorkerPromise;
  assertStatus(
    locationWorkerResult,
    "not_found",
    "superseded location worker survived account deletion",
  );
  const supersededLocationState = await admin.query(
    `select
       (select count(*) from private.data_erasure_jobs where id = $1)::integer
         as job_count,
       (select count(*)
        from private.location_consents
        where user_id = $2 and state = 'active')::integer as active_consent_count`,
    [locationWorkerJobId, deletionUserByAuth.get(ids.deletionLocationTarget)],
  );
  assert(
    supersededLocationState.rows[0].job_count === 0
      && supersededLocationState.rows[0].active_consent_count === 1,
    "superseded location worker changed data after account deletion took ownership",
  );
  addedScenarioCount += 1;
  await closeScenarioClients(deletionLocationClient, locationWorkerClient);

  // Share submission serializes on the owner advisory; reject moderation
  // serializes on the card row that deletion made private. In both hard
  // orderings, deletion commits first and the waiter fails closed.
  for (const ownerRace of [
    {
      authUserId: ids.deletionShareTarget,
      label: "share submission",
      request: (client) => client.query(
        `select api_private.create_personal_card_share(
           $1, false, true, $2, $3
         ) as result`,
        [ids.deletionShareTarget, deletionShareCardId, randomUUID().replaceAll("-", "")],
      ),
      expected: "unauthorized",
      assertPost: async () => {
        const card = await admin.query(
          `select share_state::text as state, share_slug
           from public.personal_cards where id = $1`,
          [deletionShareCardId],
        );
        assert(
          card.rows[0]?.state === "private" && card.rows[0]?.share_slug === null,
          "share waiter recreated a public secret after deletion",
        );
      },
    },
    {
      authUserId: ids.deletionModerationTarget,
      label: "moderation",
      request: (client) => client.query(
        `select api_private.moderate_personal_card_share(
           $1, $2, $3, 'reject', 'DELETION_RACE',
           'moderation behind account deletion', true
         ) as result`,
        [ids.retroAdmin, deletionModerationCardId, randomUUID()],
      ),
      expected: "conflict",
      expectedReason: "invalid_transition",
      assertPost: async () => {
        const action = await admin.query(
          `select count(*)::integer as count
           from private.moderation_actions
           where personal_card_id = $1 and reason_code = 'DELETION_RACE'`,
          [deletionModerationCardId],
        );
        assert(action.rows[0].count === 0, "moderation audit targeted a deleted card");
      },
    },
  ]) {
    const requestId = deletionRequestId();
    const deletionClient = await connect();
    const waiterClient = await connect();
    clients.push(deletionClient, waiterClient);
    await deletionClient.query("begin");
    const deletion = await deletionClient.query(
      `select api_private.request_account_deletion($1, $2, $3) as result`,
      [ownerRace.authUserId, requestId, deletionTokenHash()],
    );
    assertStatus(deletion, "accepted", `${ownerRace.label} deletion fixture failed`);
    const waiterPromise = ownerRace.request(waiterClient);
    await queueWaitsForTransaction(
      admin,
      waiterClient.processID,
      deletionClient.processID,
      `${ownerRace.label} behind account deletion`,
    );
    await deletionClient.query("commit");
    const waiter = await waiterPromise;
    assertStatus(waiter, ownerRace.expected, `${ownerRace.label} survived account deletion`);
    if (ownerRace.expectedReason !== undefined) {
      assert(
        waiter.rows[0]?.result?.reason === ownerRace.expectedReason,
        `${ownerRace.label} returned the wrong closed reason: ${JSON.stringify(waiter.rows[0]?.result)}`,
      );
    }
    await ownerRace.assertPost();
    addedScenarioCount += 1;
    await closeScenarioClients(deletionClient, waiterClient);
  }

  // An expired processing poison job with the earliest retry timestamp must
  // not monopolize every claim. Claim it once, fail it with backoff, then a
  // newly pending account is selected on the next worker lease.
  const poisonRequestId = deletionRequestId();
  const freshRequestId = deletionRequestId();
  const poisonRequested = await admin.query(
    `select api_private.request_account_deletion($1, $2, $3) as result`,
    [ids.deletionFairnessPoison, poisonRequestId, deletionTokenHash()],
  );
  const freshRequested = await admin.query(
    `select api_private.request_account_deletion($1, $2, $3) as result`,
    [ids.deletionFairnessNew, freshRequestId, deletionTokenHash()],
  );
  assertStatus(poisonRequested, "accepted", "poison fairness deletion request failed");
  assertStatus(freshRequested, "accepted", "fresh fairness deletion request failed");
  await admin.query(
    `update private.account_deletion_jobs
     set next_attempt_at = clock_timestamp() + interval '1 hour',
         updated_at = clock_timestamp()
     where id = any($1::uuid[])
       and id not in ($2, $3)
       and status = 'pending'`,
    [accountDeletionRequestIds, poisonRequestId, freshRequestId],
  );
  await admin.query(
    `update private.account_deletion_jobs
     set status = 'processing',
         lease_token = $2,
         lease_expires_at = clock_timestamp() - interval '1 minute',
         next_attempt_at = clock_timestamp() - interval '2 hours',
         updated_at = clock_timestamp()
     where id = $1`,
    [poisonRequestId, randomUUID()],
  );
  const poisonLeaseToken = randomUUID();
  const poisonClaim = await admin.query(
    `select api_private.claim_account_deletion_jobs($1, 1, 4) as result`,
    [poisonLeaseToken],
  );
  assert(
    poisonClaim.rows[0]?.result?.jobs?.[0]?.id === poisonRequestId,
    "expired poison job was not reclaimed for the fairness fixture",
  );
  const poisonFailed = await admin.query(
    `select api_private.fail_account_deletion_job(
       $1, $2, 'STORAGE_LIST_FAILED'
     ) as result`,
    [poisonRequestId, poisonLeaseToken],
  );
  assertStatus(poisonFailed, "retrying", "poison job did not enter bounded backoff");
  const freshClaimToken = randomUUID();
  const freshClaim = await admin.query(
    `select api_private.claim_account_deletion_jobs($1, 1, 4) as result`,
    [freshClaimToken],
  );
  assert(
    freshClaim.rows[0]?.result?.jobs?.[0]?.id === freshRequestId,
    `poison job starved fresh pending deletion: ${JSON.stringify(freshClaim.rows[0]?.result)}`,
  );
  addedScenarioCount += 1;

  // Two sessions using the same logical upload request key serialize on the
  // owner boundary. The waiter reuses the committed reservation and does not
  // consume another active slot or rolling issuance.
  await acceptCurrentUgcPolicies(
    admin,
    ids.photoIdempotency,
    currentDerivativePolicyVersion,
  );
  const photoRequestKey = randomUUID();
  const photoIssueClient = await connect();
  const photoReplayClient = await connect();
  clients.push(photoIssueClient, photoReplayClient);
  await photoIssueClient.query("begin");
  const firstPhotoIssue = await photoIssueClient.query(
    `select api_private.issue_personal_card_temp_upload(
       $1, true, 'image/jpeg', 4096, $2
     ) as result`,
    [ids.photoIdempotency, photoRequestKey],
  );
  assertStatus(firstPhotoIssue, "issued", "first idempotent photo issue failed");
  assert(
    firstPhotoIssue.rows[0]?.result?.replayed === false,
    "first idempotent photo issue was mislabeled as replayed",
  );
  const replayPhotoPromise = photoReplayClient.query(
    `select api_private.issue_personal_card_temp_upload(
       $1, true, 'image/jpeg', 4096, $2
     ) as result`,
    [ids.photoIdempotency, photoRequestKey],
  );
  await waitForLock(
    admin,
    photoReplayClient.processID,
    "same-key personal-card upload replay",
  );
  await photoIssueClient.query("commit");
  const replayPhotoIssue = await replayPhotoPromise;
  assertStatus(replayPhotoIssue, "issued", "same-key photo replay failed");
  assert(
    replayPhotoIssue.rows[0]?.result?.replayed === true
      && replayPhotoIssue.rows[0]?.result?.upload_id
        === firstPhotoIssue.rows[0]?.result?.upload_id
      && replayPhotoIssue.rows[0]?.result?.temp_path
        === firstPhotoIssue.rows[0]?.result?.temp_path,
    `same-key upload created a second reservation: ${JSON.stringify(replayPhotoIssue.rows[0]?.result)}`,
  );
  const photoReservationState = await admin.query(
    `select
       (select count(*)::integer
        from private.personal_card_temp_uploads
        where user_id = $1 and client_request_id = $2) as reservation_count,
       (select cardinality(issued_at)::integer
        from private.personal_card_upload_rate_states
        where user_id = $1) as rolling_issue_count`,
    [logicalUserByAuth.get(ids.photoIdempotency), photoRequestKey],
  );
  assert(
    photoReservationState.rows[0]?.reservation_count === 1
      && photoReservationState.rows[0]?.rolling_issue_count === 1,
    `same-key upload double-charged quota: ${JSON.stringify(photoReservationState.rows[0])}`,
  );
  addedScenarioCount += 1;
  await closeScenarioClients(photoIssueClient, photoReplayClient);

  // Personal-card deletion and report moderation share owner -> card/report
  // serialization. Exercise both hard orderings with open transactions: no
  // 40P01 is permitted, and each waiter must re-read the committed state.
  const deleteFirstClient = await connect();
  const moderationBehindDeleteClient = await connect();
  clients.push(deleteFirstClient, moderationBehindDeleteClient);
  await deleteFirstClient.query("begin");
  const deleteFirstResult = await deleteFirstClient.query(
    `select api_private.request_personal_card_deletion($1, $2, $3) as result`,
    [ids.photoDeletionModeration, ids.photoDeletionCardFirst, randomUUID()],
  );
  assertStatus(deleteFirstResult, "accepted", "delete-first card request failed");
  const moderationBehindDeletePromise = moderationBehindDeleteClient.query(
    `select api_private.moderate_content_report(
       $1, $2, $3, 'take_down', 'DELETE_RACE', 'moderation behind card deletion'
     ) as result`,
    [ids.retroAdmin, ids.photoDeletionReportFirst, randomUUID()],
  );
  await queueWaitsForTransaction(
    admin,
    moderationBehindDeleteClient.processID,
    deleteFirstClient.processID,
    "report moderation behind personal-card deletion",
  );
  await deleteFirstClient.query("commit");
  const moderationBehindDeleteResult = await moderationBehindDeletePromise;
  assert(
    resultStatus(moderationBehindDeleteResult) === "conflict"
      && moderationBehindDeleteResult.rows[0]?.result?.reason === "content_unavailable",
    `moderation did not re-read deleted content: ${JSON.stringify(moderationBehindDeleteResult.rows[0]?.result)}`,
  );
  addedScenarioCount += 1;
  await closeScenarioClients(deleteFirstClient, moderationBehindDeleteClient);

  const moderationFirstClient = await connect();
  const deletionBehindModerationClient = await connect();
  clients.push(moderationFirstClient, deletionBehindModerationClient);
  await moderationFirstClient.query("begin");
  const moderationFirstResult = await moderationFirstClient.query(
    `select api_private.moderate_content_report(
       $1, $2, $3, 'take_down', 'DELETE_RACE', 'moderation before card deletion'
     ) as result`,
    [ids.retroAdmin, ids.photoModerationReportFirst, randomUUID()],
  );
  assertStatus(
    moderationFirstResult,
    "applied",
    "moderation-first card fixture failed",
  );
  const deletionBehindModerationPromise = deletionBehindModerationClient.query(
    `select api_private.request_personal_card_deletion($1, $2, $3) as result`,
    [ids.photoDeletionModeration, ids.photoModerationCardFirst, randomUUID()],
  );
  await queueWaitsForTransaction(
    admin,
    deletionBehindModerationClient.processID,
    moderationFirstClient.processID,
    "personal-card deletion behind report moderation",
  );
  await moderationFirstClient.query("commit");
  const deletionBehindModerationResult = await deletionBehindModerationPromise;
  assertStatus(
    deletionBehindModerationResult,
    "accepted",
    "deletion did not re-read moderated content",
  );
  const photoDeletionModerationState = await admin.query(
    `select
       (select count(*)::integer
        from public.personal_cards
        where id in ($1, $2)) as card_count,
       (select count(*)::integer
        from private.content_reports
        where id in ($3, $4)
          and personal_card_id is null
          and share_secret_hash is null) as redacted_report_count`,
    [
      ids.photoDeletionCardFirst,
      ids.photoModerationCardFirst,
      ids.photoDeletionReportFirst,
      ids.photoModerationReportFirst,
    ],
  );
  assert(
    photoDeletionModerationState.rows[0]?.card_count === 0
      && photoDeletionModerationState.rows[0]?.redacted_report_count === 2,
    `delete/moderation race left stale content: ${JSON.stringify(photoDeletionModerationState.rows[0])}`,
  );
  addedScenarioCount += 1;
  await closeScenarioClients(moderationFirstClient, deletionBehindModerationClient);

  assert(addedScenarioCount === 34, `expected 34 added scenarios, got ${addedScenarioCount}`);
  console.log("DB concurrency integration: 51 scenarios passed");
} finally {
  if (blocker !== undefined) {
    await blocker.query("rollback").catch(() => undefined);
  }

  const cleanup = clients[0];
  if (cleanup !== undefined) {
    if (policyFixture !== undefined) {
      await retirePolicyFixture(cleanup, policyFixture).catch(() => undefined);
    }
    await cleanup.query(
      `delete from private.participant_invite_codes
       where code_hash in (decode($1, 'hex'), decode($2, 'hex'))`,
      [inviteHash, deletionInviteHash],
    ).catch(() => undefined);
    for (const tombstone of locationAttemptTombstones) {
      await cleanup.query(
        `delete from private.location_attempt_tombstones
         where owner_fingerprint = private.location_attempt_owner_fingerprint($1)
           and attempt_key_fingerprint = private.location_attempt_key_fingerprint($2)`,
        [tombstone.userId, tombstone.idempotencyKey],
      ).catch(() => undefined);
    }
    await cleanup.query(
      `delete from private.personal_card_field_object_ledger
       where user_id = any($1::uuid[])`,
      [logicalUserIds],
    ).catch(() => undefined);
    await cleanup.query(
      `delete from private.personal_card_permanent_object_ledger
       where user_id = any($1::uuid[])`,
      [logicalUserIds],
    ).catch(() => undefined);
    if (accountDeletionRequestIds.length > 0) {
      await cleanup.query(
        `delete from private.account_deletion_jobs
         where id = any($1::uuid[])`,
        [accountDeletionRequestIds],
      ).catch(() => undefined);
    }
    await cleanup.query(
      `delete from private.account_deletion_storage_prefix_tombstones as tombstone_row
       where tombstone_row.prefix_hash in (
         select extensions.hmac(
           convert_to(
             'danyeodam:account-delete-storage-prefix:v1:' || owner_id::text,
             'UTF8'
           ),
           key_row.secret,
           'sha256'
         )
         from unnest($1::uuid[]) as owner_row(owner_id)
         cross join private.account_deletion_storage_tombstone_key as key_row
         where key_row.singleton
       )`,
      [logicalUserIds],
    ).catch(() => undefined);
    await cleanup.query(
      `delete from public.app_users where id = any($1::uuid[])`,
      [logicalUserIds],
    ).catch(() => undefined);
    await retireLocalizedSpotCardFixture(cleanup, {
      cardId: ids.cardOne,
      spotId: ids.spotOne,
    }).catch(() => undefined);
    await retireLocalizedSpotCardFixture(cleanup, {
      cardId: ids.cardTwo,
      spotId: ids.spotTwo,
    }).catch(() => undefined);
    await retireLocalizedSpotCardFixture(cleanup, {
      cardId: ids.cardRace,
      spotId: ids.spotRace,
    }).catch(() => undefined);
    await cleanup.query(
      `delete from auth.users where id = any($1::uuid[])`,
      [fixtureAuthUserIds],
    ).catch(() => undefined);
    if (transientPolicyDocumentIds.length > 0) {
      await cleanup.query(
        `delete from private.policy_documents
         where id = any($1::uuid[]) and not is_current`,
        [transientPolicyDocumentIds],
      ).catch(() => undefined);
    }
  }

  await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
}
