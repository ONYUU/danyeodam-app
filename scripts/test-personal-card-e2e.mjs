import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";

import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import sharp from "sharp";

import {
  createLocalizedSpotCardFixture,
  retireLocalizedSpotCardFixture,
} from "./lib/localized-fixture.mjs";
import { createPolicyFixture, retirePolicyFixture } from "./lib/policy-fixture.mjs";

const { Client } = pg;
const appPort = 31_117;
const appUrl = `http://127.0.0.1:${appPort}`;
const requestTimeoutMs = 15_000;
const readinessRequestTimeoutMs = 1_000;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function fetchWithTimeout(input, init = {}, timeoutMs = requestTimeoutMs) {
  return fetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  });
}

function hasChildExited(server) {
  return server.exitCode !== null || server.signalCode !== null;
}

function waitForChildExit(server, timeoutMs) {
  if (hasChildExited(server)) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let timer;
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    server.once("exit", onExit);
    timer = setTimeout(() => {
      server.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
  });
}

function readLocalSupabaseEnvironment() {
  const output = execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["supabase", "status", "-o", "env"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const environment = {};
  for (const line of output.split(/\r?\n/u)) {
    const match = /^([A-Z0-9_]+)="(.*)"$/u.exec(line.trim());
    if (match !== null) {
      environment[match[1]] = match[2];
    }
  }
  for (const key of ["ANON_KEY", "API_URL", "DB_URL", "SERVICE_ROLE_KEY"]) {
    assert(typeof environment[key] === "string" && environment[key].length > 0, `${key} missing`);
  }
  return environment;
}

async function waitForApplication(server) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (hasChildExited(server)) {
      throw new Error(`Next.js exited before becoming ready (${server.exitCode})`);
    }
    try {
      const response = await fetchWithTimeout(
        `${appUrl}/api/personal-cards/upload-url`,
        { method: "POST" },
        readinessRequestTimeoutMs,
      );
      if (response.status > 0) {
        return;
      }
    } catch {
      // The server socket is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Next.js did not become ready within 20 seconds");
}

async function requestJson(path, init) {
  const response = await fetchWithTimeout(`${appUrl}${path}`, init);
  const payload = await response.json().catch(() => undefined);
  return { response, payload };
}

async function stopApplication(server) {
  if (hasChildExited(server)) {
    return;
  }
  server.kill("SIGTERM");
  if (await waitForChildExit(server, 5_000)) {
    return;
  }

  server.kill("SIGKILL");
  if (!(await waitForChildExit(server, 5_000))) {
    throw new Error("Next.js did not exit after SIGKILL");
  }
}

const local = readLocalSupabaseEnvironment();
const database = new Client({ connectionString: local.DB_URL });
const anonymousClient = createClient(local.API_URL, local.ANON_KEY, {
  auth: {
    autoRefreshToken: false,
    detectSessionInUrl: false,
    persistSession: false,
  },
  global: { fetch: fetchWithTimeout },
});
const serviceClient = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    detectSessionInUrl: false,
    persistSession: false,
  },
  global: { fetch: fetchWithTimeout },
});

let authUserId;
let appUserId;
let spotId;
let cardId;
let acquisitionId;
let permanentPath;
let tempPath;
let server;
let policyFixture;
let databaseConnected = false;

try {
  await database.connect();
  databaseConnected = true;
  await database.query("set statement_timeout = '10s'");

  const { data: authData, error: authError } = await anonymousClient.auth.signInAnonymously();
  assert(authError === null, "anonymous sign-in failed");
  assert(authData.session !== null && authData.user !== null, "anonymous session missing");
  authUserId = authData.user.id;

  const identity = await database.query(
    `select user_id
     from private.user_identities
     where auth_user_id = $1 and revoked_at is null`,
    [authUserId],
  );
  assert(identity.rowCount === 1, "active logical identity missing");
  appUserId = identity.rows[0].user_id;
  policyFixture = await createPolicyFixture(database, { authUserIds: [authUserId] });

  const fixtureSuffix = randomUUID().replaceAll("-", "").slice(0, 16);
  ({ spotId, cardId } = await createLocalizedSpotCardFixture(database, {
    approvalAuthUserId: authUserId,
    cardCode: `personal-card-e2e-${fixtureSuffix}`,
    cardTitle: "개인카드 E2E",
    regionCode: `personal-card-e2e-${fixtureSuffix}`,
    regionName: "개인카드 E2E 지역",
    spotName: "개인카드 E2E",
    spotSlug: `personal-card-e2e-${fixtureSuffix}`,
  }));
  await database.query(
    `insert into private.card_counters (card_id, last_sequence) values ($1, 1)`,
    [cardId],
  );
  await database.query(
    `insert into private.participant_access (user_id, access_kind)
     values ($1, 'internal_tester')`,
    [appUserId],
  );
  const acquisitionAttemptKey = randomUUID();
  await database.query(
    `insert into private.location_use_facts (
       user_id, idempotency_key, spot_id, purpose
     ) values ($1::uuid, $2::uuid, $3::uuid, 'field_acquisition')`,
    [appUserId, acquisitionAttemptKey, spotId],
  );
  const acquisition = await database.query(
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
    [appUserId, spotId, cardId, acquisitionAttemptKey],
  );
  acquisitionId = acquisition.rows[0].id;
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
     where acquisition_row.id = $1::uuid`,
    [acquisitionId],
  );

  server = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(appPort),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NEXT_PUBLIC_SUPABASE_URL: local.API_URL,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: local.ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: local.SERVICE_ROLE_KEY,
        PUBLIC_RECRUIT_GATE: "false",
        AUTH_EMAIL_REDIRECT_TO: "http://127.0.0.1:3000/auth/callback",
        CRON_SECRET: "local-personal-card-e2e-secret-value-0001",
        LOCATION_COMPLIANCE_CURSOR_SECRET:
          "local-personal-card-location-cursor-secret-0001",
      },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  await waitForApplication(server);

  const jpeg = await sharp({
    create: {
      width: 2_400,
      height: 1_600,
      channels: 3,
      background: { r: 35, g: 105, b: 180 },
    },
  })
    .withMetadata({
      orientation: 6,
      exif: { IFD0: { Artist: "Danyeodam E2E" } },
    })
    .jpeg({ quality: 88 })
    .toBuffer();

  const authorization = `Bearer ${authData.session.access_token}`;
  const uploadClientRequestId = randomUUID();
  const uploadIssue = await requestJson("/api/personal-cards/upload-url", {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      content_type: "image/jpeg",
      size: jpeg.byteLength,
      client_request_id: uploadClientRequestId,
    }),
  });
  assert(uploadIssue.response.status === 200, "upload URL issuance did not return 200");
  assert(typeof uploadIssue.payload?.upload_url === "string", "upload URL missing");
  assert(typeof uploadIssue.payload?.temp_path === "string", "temporary path missing");
  tempPath = uploadIssue.payload.temp_path;

  const uploadReplay = await requestJson("/api/personal-cards/upload-url", {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      content_type: "image/jpeg",
      size: jpeg.byteLength,
      client_request_id: uploadClientRequestId,
    }),
  });
  assert(uploadReplay.response.status === 200, "upload URL replay did not return 200");
  assert(uploadReplay.payload?.temp_path === tempPath, "upload replay changed temp path");
  assert(typeof uploadReplay.payload?.upload_url === "string", "replayed upload URL missing");

  const uploadResponse = await fetchWithTimeout(uploadReplay.payload.upload_url, {
    method: "PUT",
    headers: {
      apikey: local.ANON_KEY,
      authorization,
      "cache-control": "max-age=3600",
      "content-type": "image/jpeg",
      "x-upsert": "false",
    },
    body: jpeg,
  });
  assert(uploadResponse.ok, `signed upload failed (${uploadResponse.status})`);

  const promotion = await requestJson("/api/personal-cards", {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      acquisition_id: acquisitionId,
      temp_path: tempPath,
      caption: "현장 기억",
    }),
  });
  assert(promotion.response.status === 201, "personal-card promotion did not return 201");
  assert(typeof promotion.payload?.personal_card?.id === "string", "personal card id missing");
  assert(promotion.payload.personal_card.share_slug === null, "new card must not be shared");

  const persisted = await database.query(
    `select card.photo_path, card.caption,
            count(event.id)::int as event_count
     from public.personal_cards as card
     left join analytics.events as event
       on event.user_id = card.user_id
      and event.event_name = 'personal_card_created'
     where card.id = $1
     group by card.id`,
    [promotion.payload.personal_card.id],
  );
  assert(persisted.rowCount === 1, "personal card was not persisted");
  assert(persisted.rows[0].caption === "현장 기억", "caption was not persisted");
  assert(persisted.rows[0].event_count === 1, "personal_card_created event missing");
  permanentPath = persisted.rows[0].photo_path;

  const { data: permanentObject, error: permanentError } = await serviceClient
    .storage
    .from("personal-cards")
    .download(permanentPath);
  assert(permanentError === null && permanentObject !== null, "derived image missing");
  const derived = Buffer.from(await permanentObject.arrayBuffer());
  const metadata = await sharp(derived).metadata();
  assert(metadata.format === "webp", "derived image is not WebP");
  assert((metadata.width ?? 0) <= 2_048 && (metadata.height ?? 0) <= 2_048, "derived image too large");
  assert(metadata.exif === undefined, "derived image retained EXIF metadata");

  const { data: temporaryObject, error: temporaryError } = await serviceClient
    .storage
    .from("personal-card-temp")
    .download(tempPath);
  assert(temporaryObject === null && temporaryError !== null, "temporary source was not deleted");

  const uploadState = await database.query(
    `select promoted_at is not null as promoted,
            temp_deleted_at is not null as temp_deleted,
            permanent_path
     from private.personal_card_temp_uploads
     where temp_path = $1`,
    [tempPath],
  );
  assert(uploadState.rowCount === 1, "temporary upload metadata missing");
  assert(uploadState.rows[0].promoted === true, "promotion timestamp missing");
  assert(uploadState.rows[0].temp_deleted === true, "temporary deletion timestamp missing");
  assert(uploadState.rows[0].permanent_path === permanentPath, "permanent path mismatch");

  process.stdout.write("Personal-card E2E: signed upload, derivation, persistence, and cleanup passed\n");
} finally {
  if (server !== undefined) {
    await stopApplication(server);
  }
  if (permanentPath !== undefined) {
    await serviceClient.storage.from("personal-cards").remove([permanentPath]);
  }
  if (tempPath !== undefined) {
    await serviceClient.storage.from("personal-card-temp").remove([tempPath]);
  }
  if (databaseConnected) {
    if (policyFixture !== undefined) {
      await retirePolicyFixture(database, policyFixture).catch(() => undefined);
    }
    if (appUserId !== undefined) {
      await database.query("delete from public.app_users where id = $1", [appUserId]);
    }
    if (cardId !== undefined && spotId !== undefined) {
      await retireLocalizedSpotCardFixture(database, { cardId, spotId });
    }
    await database.end();
  }
  if (authUserId !== undefined) {
    await serviceClient.auth.admin.deleteUser(authUserId);
  }
}
