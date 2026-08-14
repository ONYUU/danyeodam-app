import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";

import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  createLocalizedSpotCardFixture,
  retireLocalizedSpotCardFixture,
} from "./lib/localized-fixture.mjs";
import { createPolicyFixture, retirePolicyFixture } from "./lib/policy-fixture.mjs";

const { Client } = pg;
const appPort = Number.parseInt(process.env.DANYEODAM_LOCATION_E2E_PORT ?? "31120", 10);
const appUrl = `http://127.0.0.1:${appPort}`;
const publicAppOrigin = "https://app.e2e.danyeodam.invalid";
const requestTimeoutMs = 15_000;
const cursorSecret = "location-compliance-e2e-cursor-secret-value-0001";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function localEnvironment() {
  const output = execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["supabase", "status", "-o", "env"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const environment = {};
  for (const line of output.split(/\r?\n/u)) {
    const match = /^([A-Z0-9_]+)="(.*)"$/u.exec(line.trim());
    if (match !== null) environment[match[1]] = match[2];
  }
  for (const key of ["ANON_KEY", "API_URL", "DB_URL", "SERVICE_ROLE_KEY"]) {
    assert(typeof environment[key] === "string" && environment[key].length > 0, `${key} missing`);
  }
  return environment;
}

function authClient(url, key) {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
}

function hasExited(server) {
  return server.exitCode !== null || server.signalCode !== null;
}

async function waitForApplication(server, readOutput) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (hasExited(server)) throw new Error(`Next.js exited before readiness\n${readOutput()}`);
    try {
      const response = await fetch(`${appUrl}/api/me/location-consent`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status > 0) return;
    } catch {
      // Socket not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Next.js readiness timeout\n${readOutput()}`);
}

async function stopApplication(server) {
  if (server === undefined || hasExited(server)) return;
  server.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (!hasExited(server)) server.kill("SIGKILL");
}

async function request(path, { token, method = "GET", body } = {}) {
  const headers = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${appUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const text = await response.text();
  return {
    response,
    payload: text === "" ? undefined : JSON.parse(text),
  };
}

const local = localEnvironment();
const database = new Client({ connectionString: local.DB_URL });
const clientA = authClient(local.API_URL, local.ANON_KEY);
const clientB = authClient(local.API_URL, local.ANON_KEY);

let server;
let databaseConnected = false;
let policyFixture;
let spotFixture;
let authUserA;
let authUserB;
let appUserA;
let appUserB;
let staleAttemptKey;
let legacyAttemptKey;

try {
  await database.connect();
  databaseConnected = true;
  await database.query("set statement_timeout = '10s'");

  const [signedA, signedB] = await Promise.all([
    clientA.auth.signInAnonymously(),
    clientB.auth.signInAnonymously(),
  ]);
  assert(signedA.error === null && signedA.data.session !== null, "user A auth failed");
  assert(signedB.error === null && signedB.data.session !== null, "user B auth failed");
  authUserA = signedA.data.user?.id;
  authUserB = signedB.data.user?.id;
  assert(authUserA !== undefined && authUserB !== undefined, "auth users missing");
  const tokenA = signedA.data.session.access_token;
  const tokenB = signedB.data.session.access_token;

  const identities = await database.query(
    `select auth_user_id, user_id
     from private.user_identities
     where auth_user_id = any($1::uuid[]) and revoked_at is null`,
    [[authUserA, authUserB]],
  );
  appUserA = identities.rows.find((row) => row.auth_user_id === authUserA)?.user_id;
  appUserB = identities.rows.find((row) => row.auth_user_id === authUserB)?.user_id;
  assert(appUserA !== undefined && appUserB !== undefined, "logical users missing");

  policyFixture = await createPolicyFixture(database, { authUserIds: [] });
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  spotFixture = await createLocalizedSpotCardFixture(database, {
    approvalAuthUserId: authUserA,
    cardCode: `location-e2e-${suffix}`,
    cardTitle: "Location compliance E2E",
    latitude: 37.5,
    longitude: 127.0,
    regionCode: `location-e2e-${suffix}`,
    spotName: "Location compliance E2E",
    spotSlug: `location-e2e-${suffix}`,
  });
  await database.query(
    `insert into private.card_counters (card_id, last_sequence)
     values ($1, 1)`,
    [spotFixture.cardId],
  );
  await database.query(
    `insert into private.participant_access (user_id, access_kind)
     values ($1, 'internal_tester')`,
    [appUserA],
  );

  // Pre-cutover/no-age data remains discoverable and individually correctable.
  legacyAttemptKey = randomUUID();
  await database.query(
    `insert into private.location_use_facts (
       user_id, idempotency_key, spot_id, purpose, collected_at
     ) values (
       $1, $2, $3, 'field_acquisition', now() - interval '7 months'
     )`,
    [appUserB, legacyAttemptKey, spotFixture.spotId],
  );
  const legacyAcquisition = await database.query(
    `insert into public.acquisitions (
       user_id, spot_id, card_id, acquisition_type, verification_result,
       idempotency_key, field_sequence, acquired_at
     ) values ($1, $2, $3, 'field', 'passed', $4, 900, now() - interval '7 months')
     returning id`,
    [appUserB, spotFixture.spotId, spotFixture.cardId, legacyAttemptKey],
  );
  await database.query(
    `delete from private.location_use_facts
     where user_id = $1
       and idempotency_key = $2
       and purpose = 'field_acquisition'`,
    [appUserB, legacyAttemptKey],
  );

  let output = "";
  server = spawn(process.execPath, [
    "node_modules/next/dist/bin/next",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(appPort),
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: local.API_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: local.ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: local.SERVICE_ROLE_KEY,
      PUBLIC_RECRUIT_GATE: "false",
      PUBLIC_SHARE_CREATION: "false",
      PUBLIC_SHARE_PUBLICATION: "false",
      PUBLIC_APP_URL: publicAppOrigin,
      AUTH_EMAIL_REDIRECT_TO: "http://127.0.0.1:3000/auth/callback",
      COLLECTION_CURSOR_SECRET: "location-e2e-collection-cursor-secret-value-0001",
      LOCATION_COMPLIANCE_CURSOR_SECRET: cursorSecret,
      ABUSE_HMAC_SECRET: "location-e2e-abuse-secret-value-000000000001",
      CRON_SECRET: "location-e2e-cron-secret-value-0000000000001",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (chunk) => { output = `${output}${chunk.toString("utf8")}`.slice(-16_384); };
  server.stdout?.on("data", append);
  server.stderr?.on("data", append);
  await waitForApplication(server, () => output);

  const noAgeSubjects = await request(
    "/api/me/location-correction-subjects?limit=1",
    { token: tokenB },
  );
  assert(noAgeSubjects.response.status === 200, "no-age subject listing was blocked");
  assert(
    noAgeSubjects.payload?.items?.[0]?.field_acquisition_id === legacyAcquisition.rows[0].id,
    "legacy acquisition subject was not discoverable",
  );
  assert(
    JSON.stringify(noAgeSubjects.payload).includes("acquired_at") === false,
    "exact subject timestamp leaked",
  );
  const noAgeCursorPayload = JSON.parse(Buffer.from(
    noAgeSubjects.payload.next_cursor.split(".")[0],
    "base64url",
  ).toString("utf8"));
  assert(
    noAgeCursorPayload.acquired_on_kst === noAgeSubjects.payload.items[0].acquired_on_kst
      && noAgeCursorPayload.acquisition_id === legacyAcquisition.rows[0].id
      && !("acquired_at" in noAgeCursorPayload),
    "subject cursor exposed more than the disclosed KST date and acquisition id",
  );

  const noAgeCorrectionKey = randomUUID();
  const noAgeCorrection = await request("/api/me/location-corrections", {
    token: tokenB,
    method: "POST",
    body: {
      field_acquisition_id: legacyAcquisition.rows[0].id,
      client_request_id: noAgeCorrectionKey,
      reason: "not_my_visit",
    },
  });
  assert(noAgeCorrection.response.status === 201, "no-age correction right was blocked");

  const gatedCollection = await request("/api/me/collection", { token: tokenA });
  assert(
    gatedCollection.response.status === 428
      && gatedCollection.payload?.error?.code === "MINIMUM_AGE_ATTESTATION_REQUIRED",
    "consumer collection did not remain adult-gated",
  );

  for (const invalidAge of [
    { minimum_age_passed: false, version: "18plus-v1" },
    { minimum_age_passed: true, version: "18plus-v1", age: 18 },
  ]) {
    const invalid = await request("/api/me/minimum-age-attestation", {
      token: tokenA,
      method: "POST",
      body: invalidAge,
    });
    assert(invalid.response.status === 400, "expanded/false age payload was accepted");
  }
  const attested = await request("/api/me/minimum-age-attestation", {
    token: tokenA,
    method: "POST",
    body: { minimum_age_passed: true, version: "18plus-v1" },
  });
  assert(attested.response.status === 204, "minimum-age attestation did not return 204");
  const ageStatus = await request("/api/me/minimum-age-attestation", { token: tokenA });
  assert(
    ageStatus.response.status === 200
      && ageStatus.payload?.attestation?.minimum_age_passed === true
      && ageStatus.payload?.attestation?.version === "18plus-v1",
    "minimum-age status projection mismatch",
  );

  const missingConsent = await request("/api/me/location-consent", { token: tokenA });
  assert(missingConsent.response.status === 200 && missingConsent.payload?.status === "missing", "missing consent projection failed");
  const acceptedConsent = await request("/api/me/location-consent", {
    token: tokenA,
    method: "POST",
    body: { version: policyFixture.version, locale: "ko" },
  });
  assert(acceptedConsent.response.status === 204, "location consent failed");

  const paused = await request("/api/me/location-consent", {
    token: tokenA,
    method: "PATCH",
    body: { state: "paused" },
  });
  assert(paused.response.status === 204, "location pause failed");
  const pausedAcquire = await request("/api/acquire", {
    token: tokenA,
    method: "POST",
    body: {
      spot_id: spotFixture.spotId,
      lat: 37.5,
      lng: 127.0,
      accuracy: 20,
      idempotency_key: randomUUID(),
    },
  });
  assert(
    pausedAcquire.response.status === 403
      && pausedAcquire.payload?.error?.code === "LOCATION_USE_PAUSED",
    "paused acquisition did not fail closed",
  );
  const resumed = await request("/api/me/location-consent", {
    token: tokenA,
    method: "PATCH",
    body: { state: "active" },
  });
  assert(resumed.response.status === 204, "location resume failed");

  staleAttemptKey = randomUUID();
  const acquired = await request("/api/acquire", {
    token: tokenA,
    method: "POST",
    body: {
      spot_id: spotFixture.spotId,
      lat: 37.5,
      lng: 127.0,
      accuracy: 20,
      idempotency_key: staleAttemptKey,
    },
  });
  assert(acquired.response.status === 201, `field acquisition failed: ${JSON.stringify(acquired.payload)}`);
  const acquisitionId = acquired.payload?.acquisition?.id;
  assert(typeof acquisitionId === "string", "acquisition id missing");

  const facts = await request("/api/me/location-use-facts?limit=1", { token: tokenA });
  assert(facts.response.status === 200 && facts.payload?.items?.length === 1, "location fact disclosure failed");
  assert(
    facts.payload.items[0].outcome === "passed" && facts.payload.items[0].failure === null,
    "passed fact disclosure did not expose the canonical null failure payload",
  );
  const subjects = await request("/api/me/location-correction-subjects?limit=1", { token: tokenA });
  assert(subjects.response.status === 200 && typeof subjects.payload?.next_cursor === "string", "subject cursor missing");
  const crossUserCursor = await request(
    `/api/me/location-correction-subjects?limit=1&cursor=${encodeURIComponent(subjects.payload.next_cursor)}`,
    { token: tokenB },
  );
  assert(crossUserCursor.response.status === 400, "cross-user subject cursor was accepted");

  await database.query(
    `update private.location_use_facts
     set collected_at = now() - interval '7 months',
         decided_at = now() - interval '7 months'
     where user_id = $1 and idempotency_key = $2`,
    [appUserA, staleAttemptKey],
  );
  const purged = await database.query(
    "select api_private.purge_expired_location_compliance_records(100) as result",
  );
  assert(purged.rows[0]?.result?.facts_deleted >= 1, "aged fact was not purged");
  const afterPurge = await request("/api/me/location-use-facts", { token: tokenA });
  assert(afterPurge.response.status === 200 && afterPurge.payload?.items?.length === 0, "purged fact remained visible");

  const correctionKey = randomUUID();
  const correction = await request("/api/me/location-corrections", {
    token: tokenA,
    method: "POST",
    body: {
      field_acquisition_id: acquisitionId,
      client_request_id: correctionKey,
      reason: "wrong_spot",
    },
  });
  assert(correction.response.status === 201, "aged acquisition correction failed");
  const duplicate = await request("/api/me/location-corrections", {
    token: tokenA,
    method: "POST",
    body: {
      field_acquisition_id: acquisitionId,
      client_request_id: correctionKey,
      reason: "wrong_spot",
    },
  });
  assert(
    duplicate.response.status === 200
      && duplicate.payload?.correction_request_id === correction.payload?.correction_request_id,
    "correction retry was not idempotent",
  );
  const changedRetry = await request("/api/me/location-corrections", {
    token: tokenA,
    method: "POST",
    body: {
      field_acquisition_id: acquisitionId,
      client_request_id: correctionKey,
      reason: "other",
    },
  });
  assert(changedRetry.response.status === 409, "changed correction retry was accepted");

  const withdrawal = await request("/api/me/location-consent", {
    token: tokenA,
    method: "DELETE",
  });
  assert(withdrawal.response.status === 202, "location withdrawal did not enter processing");
  const blockedAfterWithdrawal = await request("/api/acquire", {
    token: tokenA,
    method: "POST",
    body: {
      spot_id: spotFixture.spotId,
      lat: 37.5,
      lng: 127.0,
      accuracy: 20,
      idempotency_key: randomUUID(),
    },
  });
  assert(
    blockedAfterWithdrawal.response.status === 409
      && blockedAfterWithdrawal.payload?.error?.code === "LOCATION_WITHDRAWAL_PENDING",
    "withdrawal did not immediately block acquisition",
  );

  const forbiddenColumns = await database.query(
    `select count(*)::integer as count
     from information_schema.columns
     where table_schema = 'private'
       and table_name in ('minimum_age_attestations', 'location_use_facts')
       and column_name ~ '(dob|birth|age$|latitude|longitude|accuracy|distance|raw_ip|request)'`,
  );
  assert(forbiddenColumns.rows[0].count === 0, "forbidden age/location schema column found");

  console.log("Location compliance API E2E: 18 boundaries passed");
} finally {
  await stopApplication(server).catch(() => undefined);
  if (databaseConnected) {
    if (staleAttemptKey !== undefined && appUserA !== undefined) {
      await database.query(
        `delete from private.location_attempt_tombstones
         where owner_fingerprint = private.location_attempt_owner_fingerprint($1)
           and attempt_key_fingerprint = private.location_attempt_key_fingerprint($2)`,
        [appUserA, staleAttemptKey],
      ).catch(() => undefined);
    }
    if (legacyAttemptKey !== undefined && appUserB !== undefined) {
      await database.query(
        `delete from private.location_attempt_tombstones
         where owner_fingerprint = private.location_attempt_owner_fingerprint($1)
           and attempt_key_fingerprint = private.location_attempt_key_fingerprint($2)`,
        [appUserB, legacyAttemptKey],
      ).catch(() => undefined);
    }
    await database.query(
      "delete from public.app_users where id = any($1::uuid[])",
      [[appUserA, appUserB].filter(Boolean)],
    ).catch(() => undefined);
    if (policyFixture !== undefined) {
      await retirePolicyFixture(database, policyFixture).catch(() => undefined);
    }
    if (spotFixture !== undefined) {
      await retireLocalizedSpotCardFixture(database, spotFixture).catch(() => undefined);
    }
    await database.query(
      "delete from auth.users where id = any($1::uuid[])",
      [[authUserA, authUserB].filter(Boolean)],
    ).catch(() => undefined);
    await database.end().catch(() => undefined);
  }
}
