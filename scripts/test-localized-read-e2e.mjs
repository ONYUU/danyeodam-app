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
const appPort = 31_119;
const appUrl = `http://127.0.0.1:${appPort}`;
const publicAppOrigin = "https://app.e2e.danyeodam.invalid";
const requestTimeoutMs = 15_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fetchWithTimeout(input, init = {}) {
  return fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(requestTimeoutMs) });
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
    if (match !== null) environment[match[1]] = match[2];
  }
  for (const key of ["ANON_KEY", "API_URL", "DB_URL", "SERVICE_ROLE_KEY"]) {
    assert(typeof environment[key] === "string" && environment[key].length > 0, `${key} missing`);
  }
  return environment;
}

function hasExited(server) {
  return server.exitCode !== null || server.signalCode !== null;
}

async function waitForApplication(server) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (hasExited(server)) throw new Error("Next.js exited before readiness");
    try {
      const response = await fetchWithTimeout(`${appUrl}/api/spots`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status > 0) return;
    } catch {
      // Socket is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Next.js did not become ready within 20 seconds");
}

async function stopApplication(server) {
  if (hasExited(server)) return;
  server.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    server.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  if (!hasExited(server)) server.kill("SIGKILL");
}

async function requestJson(path, init = {}) {
  const response = await fetchWithTimeout(`${appUrl}${path}`, init);
  return { response, payload: await response.json().catch(() => undefined) };
}

const local = readLocalSupabaseEnvironment();
const database = new Client({ connectionString: local.DB_URL });
const ownerClient = createClient(local.API_URL, local.ANON_KEY, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  global: { fetch: fetchWithTimeout },
});
const otherClient = createClient(local.API_URL, local.ANON_KEY, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  global: { fetch: fetchWithTimeout },
});
const serviceClient = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  global: { fetch: fetchWithTimeout },
});

let server;
let databaseConnected = false;
let ownerAuthUserId;
let otherAuthUserId;
let ownerAppUserId;
let otherAppUserId;
let fieldFixture;
let giftFixture;
let photoPath;
let policyFixture;

try {
  await database.connect();
  databaseConnected = true;
  await database.query("set statement_timeout = '10s'");

  const ownerAuth = await ownerClient.auth.signInAnonymously();
  const otherAuth = await otherClient.auth.signInAnonymously();
  assert(ownerAuth.error === null && ownerAuth.data.session !== null, "owner auth failed");
  assert(otherAuth.error === null && otherAuth.data.session !== null, "other auth failed");
  ownerAuthUserId = ownerAuth.data.user?.id;
  otherAuthUserId = otherAuth.data.user?.id;
  assert(ownerAuthUserId !== undefined && otherAuthUserId !== undefined, "auth users missing");

  const identities = await database.query(
    `select auth_user_id, user_id
     from private.user_identities
     where auth_user_id = any($1::uuid[]) and revoked_at is null`,
    [[ownerAuthUserId, otherAuthUserId]],
  );
  ownerAppUserId = identities.rows.find((row) => row.auth_user_id === ownerAuthUserId)?.user_id;
  otherAppUserId = identities.rows.find((row) => row.auth_user_id === otherAuthUserId)?.user_id;
  assert(ownerAppUserId !== undefined && otherAppUserId !== undefined, "app users missing");

  policyFixture = await createPolicyFixture(database, {
    authUserIds: [ownerAuthUserId, otherAuthUserId],
  });

  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  fieldFixture = await createLocalizedSpotCardFixture(database, {
    approvalAuthUserId: ownerAuthUserId,
    cardCode: `localized-field-${suffix}`,
    cardTitle: "현장 카드",
    colorHex: "#335577",
    regionCode: `localized-field-${suffix}`,
    regionName: "현장 지역",
    sketchPath: "e2e/localized-field.webp",
    spotName: "현장 스팟",
    spotSlug: `localized-field-${suffix}`,
  });
  giftFixture = await createLocalizedSpotCardFixture(database, {
    approvalAuthUserId: ownerAuthUserId,
    cardCode: `localized-gift-${suffix}`,
    cardTitle: "선물 카드",
    colorHex: "#775533",
    regionCode: `localized-gift-${suffix}`,
    regionName: "선물 지역",
    sketchPath: "e2e/localized-gift.webp",
    spotName: "선물 스팟",
    spotSlug: `localized-gift-${suffix}`,
  });

  const fieldAttemptKey = randomUUID();
  const fieldAcquiredAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  await database.query(
    `insert into private.location_use_facts (
       user_id, idempotency_key, spot_id, purpose, collected_at
     ) values (
       $1::uuid, $2::uuid, $3::uuid, 'field_acquisition', $4::timestamptz
     )`,
    [ownerAppUserId, fieldAttemptKey, fieldFixture.spotId, fieldAcquiredAt],
  );
  const fieldAcquisition = await database.query(
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
    [ownerAppUserId, fieldFixture.spotId, fieldFixture.cardId, fieldAttemptKey],
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
     where acquisition_row.id = $1::uuid`,
    [fieldAcquisition.rows[0].id],
  );
  await database.query(
    "insert into private.card_counters (card_id, last_sequence) values ($1, 1)",
    [fieldFixture.cardId],
  );
  await database.query(
    `insert into public.acquisitions (
       user_id, spot_id, card_id, acquisition_type, verification_result,
       idempotency_key, field_sequence, acquired_at
     ) values ($1, $2, $3, 'gift', 'not_applicable', $4, null, now() - interval '1 day')`,
    [ownerAppUserId, giftFixture.spotId, giftFixture.cardId, randomUUID()],
  );

  const personalCardId = randomUUID();
  photoPath = `${ownerAppUserId}/${personalCardId}.webp`;
  await database.query(
    `insert into public.personal_cards (
       id, user_id, acquisition_id, photo_path, caption
     ) values ($1, $2, $3, $4, '소유 사진')`,
    [personalCardId, ownerAppUserId, fieldAcquisition.rows[0].id, photoPath],
  );
  const photo = await sharp({
    create: { width: 16, height: 16, channels: 3, background: "#335577" },
  }).webp().toBuffer();
  const upload = await serviceClient.storage.from("personal-cards").upload(photoPath, photo, {
    contentType: "image/webp",
    upsert: false,
  });
  assert(upload.error === null, "private photo fixture upload failed");

  const pendingSlug = randomUUID().replaceAll("-", "");
  const pending = await database.query(
    `select api_private.create_personal_card_share($1, true, true, $2, $3) as result`,
    [ownerAuthUserId, personalCardId, pendingSlug],
  );
  assert(pending.rows[0]?.result?.status === "pending", "pending share fixture failed");

  server = spawn(process.execPath, [
    "node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(appPort),
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
      COLLECTION_CURSOR_SECRET: "localized-read-e2e-cursor-secret-value-0001",
      ABUSE_HMAC_SECRET: "localized-read-e2e-abuse-secret-value-0001",
      LOCATION_COMPLIANCE_CURSOR_SECRET:
        "localized-read-location-cursor-secret-value-0001",
      AUTH_EMAIL_REDIRECT_TO: "http://127.0.0.1:3000/auth/callback",
      CRON_SECRET: "localized-read-e2e-cron-secret-value-0001",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  await waitForApplication(server);

  const spots = await requestJson("/api/spots");
  assert(spots.response.status === 200, "spots did not return 200");
  assert(
    spots.response.headers.get("cache-control") === "public, max-age=0, must-revalidate",
    "spots cache policy mismatch",
  );
  assert(typeof spots.payload?.content_version === "string", "spots content version missing");
  const etag = spots.response.headers.get("etag");
  assert(etag !== null, "spots ETag missing");
  const fieldSpot = spots.payload?.spots?.find((spot) => spot.id === fieldFixture.spotId);
  assert(fieldSpot?.card?.sketch_url === `/api/card-assets/${fieldFixture.cardId}`, "safe card URL missing");
  for (const locale of ["ko", "en", "ja", "zh-Hans", "zh-Hant", "vi"]) {
    assert(typeof fieldSpot?.name?.[locale] === "string", `spots ${locale} missing`);
  }
  for (const forbidden of ["radius_m", "accuracy_threshold_m", "sort_order", "sketch_path"]) {
    assert(!JSON.stringify(spots.payload).includes(`\"${forbidden}\"`), `spots exposed ${forbidden}`);
  }
  const notModified = await fetchWithTimeout(`${appUrl}/api/spots`, {
    headers: { "if-none-match": `W/${etag}` },
  });
  assert(notModified.status === 304, "matching spots ETag did not return 304");

  const ownerAuthorization = `Bearer ${ownerAuth.data.session.access_token}`;
  const otherAuthorization = `Bearer ${otherAuth.data.session.access_token}`;
  const pageOne = await requestJson("/api/me/collection?limit=1", {
    headers: { authorization: ownerAuthorization },
  });
  assert(pageOne.response.status === 200, "collection page one failed");
  assert(pageOne.payload?.stats?.total_acquisitions === 2, "total acquisition stats mismatch");
  assert(pageOne.payload?.stats?.spots_visited === 1, "gift was counted as a visited spot");
  assert(pageOne.payload?.stats?.personal_cards === 1, "personal-card stats mismatch");
  assert(pageOne.payload?.page?.has_more === true, "collection cursor missing");
  const cursor = pageOne.payload.page.next_cursor;
  const pageTwo = await requestJson(`/api/me/collection?limit=1&cursor=${encodeURIComponent(cursor)}`, {
    headers: { authorization: ownerAuthorization },
  });
  assert(pageTwo.response.status === 200, "collection page two failed");
  assert(pageTwo.payload?.items?.[0]?.acquisition?.type === "field", "field page missing");
  assert(
    pageTwo.payload?.items?.[0]?.personal_card?.photo_url === `/api/personal-cards/${personalCardId}/photo`,
    "owned photo proxy URL missing",
  );
  assert(!JSON.stringify(pageTwo.payload).includes("photo_path"), "collection exposed photo path");

  const malformedCursor = await requestJson("/api/me/collection?cursor=malformed", {
    headers: { authorization: ownerAuthorization },
  });
  assert(malformedCursor.response.status === 400, "malformed cursor did not return 400");
  const crossUserCursor = await requestJson(
    `/api/me/collection?limit=1&cursor=${encodeURIComponent(cursor)}`,
    { headers: { authorization: otherAuthorization } },
  );
  assert(crossUserCursor.response.status === 400, "cross-user cursor did not return 400");

  const ownerPhoto = await fetchWithTimeout(`${appUrl}/api/personal-cards/${personalCardId}/photo`, {
    headers: { authorization: ownerAuthorization },
  });
  assert(ownerPhoto.status === 200 && ownerPhoto.headers.get("content-type") === "image/webp", "owner photo failed");
  assert(
    ownerPhoto.headers.get("cache-control") === "private, no-store",
    "owner photo cache policy mismatch",
  );
  const otherPhoto = await fetchWithTimeout(`${appUrl}/api/personal-cards/${personalCardId}/photo`, {
    headers: { authorization: otherAuthorization },
  });
  assert(otherPhoto.status === 404, "non-owner photo did not collapse to 404");
  assert((await fetchWithTimeout(`${appUrl}/api/personal-cards/${personalCardId}/photo`)).status === 401, "unauthenticated photo did not return 401");

  const fixedBody = JSON.stringify({ share_secret: pendingSlug });
  const closedResolve = await fetchWithTimeout(`${appUrl}/api/public-share/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: fixedBody,
  });
  assert(closedResolve.status === 404, "pending share became public");
  const closedPhoto = await fetchWithTimeout(`${appUrl}/api/public-share/photo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: fixedBody,
  });
  assert(closedPhoto.status === 404, "pending share photo became public");
  const invalidJwt = await fetchWithTimeout(`${appUrl}/api/public-share/resolve`, {
    method: "POST",
    headers: { authorization: "Bearer invalid.jwt.value", "content-type": "application/json" },
    body: fixedBody,
  });
  assert(invalidJwt.status === 404, "closed publication did not precede optional JWT validation");
  const invalidPhotoJwt = await fetchWithTimeout(`${appUrl}/api/public-share/photo`, {
    method: "POST",
    headers: { authorization: "Bearer invalid.jwt.value", "content-type": "application/json" },
    body: fixedBody,
  });
  assert(invalidPhotoJwt.status === 404, "closed photo publication did not precede JWT validation");
  const legacyPath = await fetchWithTimeout(`${appUrl}/api/share/LegacyShareSecret0000001`, {
    redirect: "manual",
  });
  assert(legacyPath.status === 404 && !legacyPath.redirected, "legacy share path did not stay 404");

  await requestJson("/api/me/collection?limit=1", { headers: { authorization: ownerAuthorization } });
  const revisit = await database.query(
    `select count(*)::int as count
     from analytics.events
     where user_id = $1 and event_name = 'revisit'`,
    [ownerAppUserId],
  );
  assert(revisit.rows[0].count === 1, "revisit was not deduplicated by KST day");

  process.stdout.write("Localized read E2E: ETag, cursor, stats, revisit, photo ownership, and closed sharing passed\n");
} finally {
  if (server !== undefined) await stopApplication(server);
  if (photoPath !== undefined) await serviceClient.storage.from("personal-cards").remove([photoPath]);
  if (databaseConnected) {
    for (const appUserId of [ownerAppUserId, otherAppUserId]) {
      if (appUserId !== undefined) {
        await database.query("delete from public.app_users where id = $1", [appUserId]).catch(() => undefined);
      }
    }
    if (giftFixture !== undefined) {
      await retireLocalizedSpotCardFixture(database, giftFixture).catch(() => undefined);
    }
    if (fieldFixture !== undefined) {
      await retireLocalizedSpotCardFixture(database, fieldFixture).catch(() => undefined);
    }
    if (policyFixture !== undefined) {
      await retirePolicyFixture(database, policyFixture).catch(() => undefined);
    }
    await database.end();
  }
  for (const authUserId of [ownerAuthUserId, otherAuthUserId]) {
    if (authUserId !== undefined) await serviceClient.auth.admin.deleteUser(authUserId);
  }
}
