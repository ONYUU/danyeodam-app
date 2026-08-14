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
const appPort = 31_118;
const appUrl = `http://127.0.0.1:${appPort}`;
const publicAppOrigin = "https://app.e2e.danyeodam.invalid";
const requestTimeoutMs = 15_000;
const readinessRequestTimeoutMs = 1_000;
const fixedPublicSharePaths = new Set([
  "/api/public-share/age-attestation",
  "/api/public-share/block",
  "/api/public-share/photo",
  "/api/public-share/report",
  "/api/public-share/resolve",
]);
const observedPublicRequestUrls = [];
let applicationOutput = "";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function fetchWithTimeout(input, init = {}, timeoutMs = requestTimeoutMs) {
  const requestUrl = new URL(input instanceof Request ? input.url : input);
  if (requestUrl.origin === appUrl && requestUrl.pathname.startsWith("/api/public-share/")) {
    observedPublicRequestUrls.push(requestUrl);
  }
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
        `${appUrl}/share`,
        {},
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

async function requestJson(path, init) {
  const response = await fetchWithTimeout(`${appUrl}${path}`, init);
  const payload = await response.json().catch(() => undefined);
  return { response, payload };
}

async function issueAgeCookie() {
  const response = await fetchWithTimeout(`${appUrl}/api/public-share/age-attestation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pass: true, version: "dob-18-v1" }),
  });
  assert(response.status === 204, "age attestation did not return 204");
  const setCookie = response.headers.get("set-cookie");
  assert(setCookie !== null, "age attestation cookie missing");
  assert(setCookie.includes("HttpOnly"), "age cookie is not HttpOnly");
  assert(setCookie.includes("Secure"), "age cookie is not Secure");
  assert(setCookie.includes("SameSite=Strict"), "age cookie is not SameSite Strict");
  return setCookie.split(";", 1)[0];
}

function publicShareJson(path, shareSecret, init = {}) {
  const { headers = {}, payload = {}, ...requestInit } = init;
  return requestJson(path, {
    ...requestInit,
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ share_secret: shareSecret, ...payload }),
  });
}

const local = readLocalSupabaseEnvironment();
const database = new Client({ connectionString: local.DB_URL });
const anonymousClient = createClient(local.API_URL, local.ANON_KEY, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  global: { fetch: fetchWithTimeout },
});
const adminAuthClient = createClient(local.API_URL, local.ANON_KEY, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  global: { fetch: fetchWithTimeout },
});
const serviceClient = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  global: { fetch: fetchWithTimeout },
});

async function startApplication(publicSharePublicationOpen) {
  const application = spawn(
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
        PUBLIC_SHARE_CREATION: "false",
        PUBLIC_SHARE_PUBLICATION: publicSharePublicationOpen ? "true" : "false",
        PUBLIC_APP_URL: publicAppOrigin,
        AUTH_EMAIL_REDIRECT_TO: "http://127.0.0.1:3000/auth/callback",
        CRON_SECRET: "local-share-retro-e2e-secret-value-0001",
        ABUSE_HMAC_SECRET: "local-share-retro-e2e-abuse-secret-0001",
        COLLECTION_CURSOR_SECRET: "local-share-retro-e2e-cursor-secret-0001",
        LOCATION_COMPLIANCE_CURSOR_SECRET:
          "local-share-retro-location-cursor-secret-0001",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  application.stdout?.on("data", (chunk) => { applicationOutput += chunk.toString(); });
  application.stderr?.on("data", (chunk) => { applicationOutput += chunk.toString(); });
  await waitForApplication(application);
  return application;
}

let databaseConnected = false;
let server;
let participantAuthUserId;
let participantAppUserId;
let adminAuthUserId;
let adminAppUserId;
let spotId;
let cardId;
let photoPath;
let shareSlug;
let policyFixture;

try {
  await database.connect();
  databaseConnected = true;
  await database.query("set statement_timeout = '10s'");

  const { data: participantAuth, error: participantError } =
    await anonymousClient.auth.signInAnonymously();
  assert(participantError === null && participantAuth.session !== null, "participant auth failed");
  assert(participantAuth.user !== null, "participant user missing");
  participantAuthUserId = participantAuth.user.id;

  const { data: adminAuth, error: adminError } =
    await adminAuthClient.auth.signInAnonymously();
  assert(adminError === null && adminAuth.session !== null, "admin auth failed");
  assert(adminAuth.user !== null, "admin user missing");
  adminAuthUserId = adminAuth.user.id;

  const identities = await database.query(
    `select auth_user_id, user_id
     from private.user_identities
     where auth_user_id = any($1::uuid[]) and revoked_at is null`,
    [[participantAuthUserId, adminAuthUserId]],
  );
  participantAppUserId = identities.rows.find(
    (row) => row.auth_user_id === participantAuthUserId,
  )?.user_id;
  adminAppUserId = identities.rows.find(
    (row) => row.auth_user_id === adminAuthUserId,
  )?.user_id;
  assert(participantAppUserId !== undefined && adminAppUserId !== undefined, "identities missing");

  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  ({ spotId, cardId } = await createLocalizedSpotCardFixture(database, {
    approvalAuthUserId: participantAuthUserId,
    cardCode: `share-retro-e2e-${suffix}`,
    cardTitle: "공유 E2E 카드",
    colorHex: "#234567",
    regionCode: `share-retro-e2e-${suffix}`,
    regionName: "공유 E2E 지역",
    sketchPath: "e2e/share.webp",
    spotName: "공유 E2E",
    spotSlug: `share-retro-e2e-${suffix}`,
  }));
  await database.query(
    `insert into private.card_counters (card_id, last_sequence) values ($1, 1)`,
    [cardId],
  );
  await database.query(
    `insert into private.participant_access (user_id, access_kind)
     values ($1, 'internal_tester')`,
    [participantAppUserId],
  );
  await database.query(
    `insert into private.admin_members (auth_user_id)
     values ($1)`,
    [adminAuthUserId],
  );
  policyFixture = await createPolicyFixture(database, {
    authUserIds: [participantAuthUserId, adminAuthUserId],
  });
  const acquisitionAttemptKey = randomUUID();
  await database.query(
    `insert into private.location_use_facts (
       user_id, idempotency_key, spot_id, purpose
     ) values ($1::uuid, $2::uuid, $3::uuid, 'field_acquisition')`,
    [participantAppUserId, acquisitionAttemptKey, spotId],
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
    [participantAppUserId, spotId, cardId, acquisitionAttemptKey],
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
    [acquisition.rows[0].id],
  );
  const personalCardId = randomUUID();
  photoPath = `${participantAppUserId}/${personalCardId}.webp`;
  await database.query(
    `insert into public.personal_cards (
       id, user_id, acquisition_id, photo_path, caption
     ) values ($1, $2, $3, $4, '공유 기억')`,
    [personalCardId, participantAppUserId, acquisition.rows[0].id, photoPath],
  );
  const photo = await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 3,
      background: { r: 30, g: 120, b: 80 },
    },
  }).webp().toBuffer();
  const { error: photoUploadError } = await serviceClient
    .storage
    .from("personal-cards")
    .upload(photoPath, photo, { contentType: "image/webp", upsert: false });
  assert(photoUploadError === null, "share photo fixture upload failed");

  shareSlug = randomUUID().replaceAll("-", "");
  const pendingShare = await database.query(
    `select api_private.create_personal_card_share($1, false, true, $2, $3) as result`,
    [participantAuthUserId, personalCardId, shareSlug],
  );
  assert(pendingShare.rows[0]?.result?.status === "pending", "pending share fixture failed");

  server = await startApplication(false);

  const participantAuthorization = `Bearer ${participantAuth.session.access_token}`;
  const adminAuthorization = `Bearer ${adminAuth.session.access_token}`;

  const legacySecret = "LegacyShareSecret0000001";
  const legacyShell = await fetchWithTimeout(`${appUrl}/share/${legacySecret}`, {
    redirect: "manual",
  });
  assert(legacyShell.status === 404 && !legacyShell.redirected, "legacy share URL did not stay 404");
  const legacyPath = await fetchWithTimeout(`${appUrl}/api/share/${legacySecret}`, {
    redirect: "manual",
  });
  assert(legacyPath.status === 404 && !legacyPath.redirected, "legacy secret path did not stay 404");
  assert(
    (await fetchWithTimeout(`${appUrl}/api/share/${legacySecret}/photo`, { redirect: "manual" }))
      .status === 404,
    "legacy photo path did not stay 404",
  );
  const pendingPublic = await publicShareJson(
    "/api/public-share/resolve",
    shareSlug,
  );
  assert(
    pendingPublic.response.status === 404,
    `closed publication exposed pending share: ${pendingPublic.response.status} ${JSON.stringify(pendingPublic.payload)}`,
  );
  const moderationQueue = await requestJson("/api/admin/moderation/shares?status=pending", {
    headers: { authorization: adminAuthorization },
  });
  assert(moderationQueue.response.status === 200, "moderation queue failed");
  assert(
    moderationQueue.payload?.items?.some((item) => item.id === personalCardId),
    "pending card missing from moderation queue",
  );
  assert(!JSON.stringify(moderationQueue.payload).includes(shareSlug), "moderation queue exposed slug");
  const closedApproval = await requestJson(
    `/api/admin/moderation/shares/${personalCardId}/actions`,
    {
      method: "POST",
      headers: { authorization: adminAuthorization, "content-type": "application/json" },
      body: JSON.stringify({
        action: "approve",
        client_action_id: randomUUID(),
        reason_code: "POLICY_OK",
        note: "E2E closed publication",
      }),
    },
  );
  assert(closedApproval.response.status === 403, "closed publication approved a share");
  assert(
    closedApproval.payload?.error?.details?.gate === "share_publication",
    "closed approval did not identify the publication gate",
  );

  await stopApplication(server);
  server = await startApplication(true);

  const approval = await requestJson(
    `/api/admin/moderation/shares/${personalCardId}/actions`,
    {
      method: "POST",
      headers: { authorization: adminAuthorization, "content-type": "application/json" },
      body: JSON.stringify({
        action: "approve",
        client_action_id: randomUUID(),
        reason_code: "POLICY_OK",
        note: "E2E manual approval",
      }),
    },
  );
  assert(approval.response.status === 200, "manual share approval failed");
  assert(approval.payload?.moderation?.share_state === "active", "share did not become active");

  const existingShare = await requestJson(`/api/personal-cards/${personalCardId}/share`, {
    method: "POST",
    headers: { authorization: participantAuthorization },
  });
  assert(existingShare.response.status === 200, "existing active share did not return 200");
  assert(existingShare.payload?.share?.slug === shareSlug, "existing share slug mismatch");
  assert(existingShare.payload?.share?.status === "active", "existing share status mismatch");
  assert(
    existingShare.payload?.share?.url === `${publicAppOrigin}/share#${shareSlug}`,
    "owner share URL did not use a fragment",
  );

  const shellResponse = await fetchWithTimeout(`${appUrl}/share#${shareSlug}`);
  const shellHtml = await shellResponse.text();
  assert(shellResponse.status === 200, "fixed share shell did not render");
  assert(!shellHtml.includes(shareSlug), "share shell reflected the secret into HTML");
  assert(shellResponse.headers.get("referrer-policy") === "no-referrer", "share shell referrer policy missing");
  assert(
    shellResponse.headers.get("x-robots-tag")?.includes("noindex") === true,
    "share shell noindex header missing",
  );
  assert(
    shellResponse.headers.get("content-security-policy")?.includes("'strict-dynamic'") === true,
    "share shell strict CSP missing",
  );

  const missingAge = await publicShareJson("/api/public-share/resolve", shareSlug);
  assert(missingAge.response.status === 428, "missing age attestation did not return 428");
  assert(
    missingAge.payload?.error?.code === "AGE_ATTESTATION_REQUIRED",
    "missing age attestation returned the wrong code",
  );
  const ageCookie = await issueAgeCookie();
  const publicShare = await publicShareJson("/api/public-share/resolve", shareSlug, {
    headers: { cookie: ageCookie },
  });
  assert(publicShare.response.status === 200, "public share did not return 200");
  assert(
    publicShare.response.headers.get("cache-control") === "private, no-store, max-age=0",
    "public share JSON cache policy mismatch",
  );
  assert(publicShare.payload?.date_kst !== undefined, "share date missing");
  for (const locale of ["ko", "en", "ja", "zh-Hans", "zh-Hant", "vi"]) {
    assert(typeof publicShare.payload?.spot?.name?.[locale] === "string", `share ${locale} missing`);
  }
  assert(publicShare.payload?.caption === "공유 기억", "share caption missing");
  assert(publicShare.payload?.photo_available === true, "photo availability missing");
  assert(
    JSON.stringify(Object.keys(publicShare.payload).sort())
      === JSON.stringify(["caption", "date_kst", "photo_available", "spot"]),
    "public share projection contained an unexpected field",
  );
  for (const forbidden of [
    "photo_path",
    "acquired_at",
    "field_sequence",
    "latitude",
    "longitude",
  ]) {
    assert(
      !JSON.stringify(publicShare.payload).includes(`\"${forbidden}\"`),
      `public share exposed ${forbidden}`,
    );
  }

  const publicPhoto = await fetchWithTimeout(`${appUrl}/api/public-share/photo`, {
    method: "POST",
    headers: { cookie: ageCookie, "content-type": "application/json" },
    body: JSON.stringify({ share_secret: shareSlug }),
  });
  assert(publicPhoto.status === 200, "public photo did not return 200");
  assert(publicPhoto.headers.get("content-type") === "image/webp", "public photo MIME mismatch");
  assert(
    publicPhoto.headers.get("cache-control") === "private, no-store, max-age=0",
    "public photo cache policy mismatch",
  );
  assert((await publicPhoto.arrayBuffer()).byteLength > 0, "public photo was empty");

  await stopApplication(server);
  server = await startApplication(false);

  const closedResolve = await publicShareJson("/api/public-share/resolve", shareSlug);
  assert(closedResolve.response.status === 404, "closed publication exposed active JSON");
  const closedPhoto = await publicShareJson("/api/public-share/photo", shareSlug);
  assert(closedPhoto.response.status === 404, "closed publication exposed active photo");
  const closedInvalidAuth = await publicShareJson("/api/public-share/resolve", shareSlug, {
    headers: { authorization: "Bearer invalid" },
  });
  assert(
    closedInvalidAuth.response.status === 404,
    "closed publication leaked through authentication precedence",
  );
  const closedReport = await publicShareJson("/api/public-share/report", shareSlug, {
    payload: {
      client_report_id: randomUUID(),
      target: "content",
      reason: "privacy",
    },
  });
  assert(closedReport.response.status === 404, "closed publication accepted a report");
  const closedBlock = await publicShareJson("/api/public-share/block", shareSlug, {
    payload: { client_action_id: randomUUID() },
  });
  assert(
    closedBlock.response.status === 404,
    "closed publication leaked through block authentication precedence",
  );

  await stopApplication(server);
  server = await startApplication(true);
  const bearerOnlyBlock = await publicShareJson("/api/public-share/block", shareSlug, {
    headers: { authorization: adminAuthorization },
    payload: { client_action_id: randomUUID() },
  });
  assert(
    bearerOnlyBlock.response.status === 204,
    "adult bearer block incorrectly required the web age cookie",
  );
  const reopenedAgeCookie = await issueAgeCookie();

  const blockedJson = await publicShareJson("/api/public-share/resolve", shareSlug, {
    headers: { authorization: adminAuthorization, cookie: reopenedAgeCookie },
  });
  assert(blockedJson.response.status === 404, "blocked owner JSON still resolved for viewer");
  const blockedPhoto = await publicShareJson("/api/public-share/photo", shareSlug, {
    headers: { authorization: adminAuthorization, cookie: reopenedAgeCookie },
  });
  assert(blockedPhoto.response.status === 404, "blocked owner photo still resolved for viewer");
  assert(
    (await publicShareJson("/api/public-share/resolve", shareSlug, {
      headers: { cookie: reopenedAgeCookie },
    })).response.status === 200,
    "authenticated block unexpectedly hid the share from anonymous web",
  );

  const blockList = await requestJson("/api/me/blocks", {
    headers: { authorization: adminAuthorization },
  });
  assert(blockList.response.status === 200, "opaque block list failed");
  assert(blockList.payload?.page?.has_more === false, "single block list has an extra page");
  assert(blockList.payload?.page?.next_cursor === null, "terminal block cursor was not null");
  const blockId = blockList.payload?.blocks?.[0]?.id;
  assert(typeof blockId === "string", "opaque block id missing");
  assert(!JSON.stringify(blockList.payload).includes(shareSlug), "block list exposed share slug");
  assert(
    !JSON.stringify(blockList.payload).includes(participantAppUserId),
    "block list exposed owner logical user id",
  );

  const unblockOwner = await fetchWithTimeout(`${appUrl}/api/me/blocks/${blockId}`, {
    method: "DELETE",
    headers: { authorization: adminAuthorization, "content-type": "application/json" },
    body: JSON.stringify({ client_action_id: randomUUID() }),
  });
  assert(unblockOwner.status === 204, "opaque unblock did not return 204");
  const unblockedJson = await publicShareJson("/api/public-share/resolve", shareSlug, {
    headers: { authorization: adminAuthorization, cookie: reopenedAgeCookie },
  });
  assert(unblockedJson.response.status === 200, "unblocked owner JSON did not resolve");

  const reportId = randomUUID();
  const report = await publicShareJson("/api/public-share/report", shareSlug, {
    headers: {
      cookie: reopenedAgeCookie,
      "x-vercel-id": "icn1::e2e",
      "x-forwarded-for": "203.0.113.10",
    },
    payload: {
      client_report_id: reportId,
      target: "content",
      reason: "privacy",
      comment: "E2E report",
    },
  });
  assert(report.response.status === 202, "public report did not return 202");
  const reportQueue = await requestJson("/api/admin/moderation/reports?status=open", {
    headers: { authorization: adminAuthorization },
  });
  assert(reportQueue.response.status === 200, "report queue failed");
  const queuedReport = reportQueue.payload?.items?.find(
    (item) => item.id === report.payload?.report?.id,
  );
  assert(queuedReport !== undefined, "submitted report missing from queue");
  assert(!JSON.stringify(reportQueue.payload).includes(shareSlug), "report queue exposed slug");
  const dismissed = await requestJson(
    `/api/admin/moderation/reports/${queuedReport.id}/actions`,
    {
      method: "POST",
      headers: { authorization: adminAuthorization, "content-type": "application/json" },
      body: JSON.stringify({
        action: "dismiss",
        client_action_id: randomUUID(),
        reason_code: "NO_VIOLATION",
        note: "E2E dismissal",
      }),
    },
  );
  assert(dismissed.response.status === 200, "report dismissal failed");

  const shareViewPrivacy = await database.query(
    `select personal_card_id, properties
     from analytics.events
     where event_name = 'share_view'`,
  );
  assert(shareViewPrivacy.rowCount === 3, "successful share view events missing");
  assert(
    shareViewPrivacy.rows.every((row) => row.personal_card_id === personalCardId),
    "a share view did not reference the resolved personal card",
  );
  assert(
    shareViewPrivacy.rows.every((row) => JSON.stringify(row.properties) === "{}"),
    "a share view retained raw slug properties",
  );

  const landing = await fetchWithTimeout(`${appUrl}/?ref=sns`);
  assert(landing.status === 200, "landing page did not render");

  const retroBody = JSON.stringify({
    app_user_id: participantAppUserId,
    spot_id: spotId,
    note: "E2E 소급",
  });
  const retroCreated = await requestJson("/api/admin/retro-grants", {
    method: "POST",
    headers: { authorization: adminAuthorization, "content-type": "application/json" },
    body: retroBody,
  });
  assert(retroCreated.response.status === 201, "retro grant did not return 201");
  assert(retroCreated.payload?.acquisition?.type === "retro", "retro acquisition missing");
  const retroReplayed = await requestJson("/api/admin/retro-grants", {
    method: "POST",
    headers: { authorization: adminAuthorization, "content-type": "application/json" },
    body: retroBody,
  });
  assert(retroReplayed.response.status === 200, "retro replay did not return 200");
  assert(
    retroReplayed.payload?.acquisition?.id === retroCreated.payload.acquisition.id,
    "retro replay changed the acquisition",
  );

  const shareRevoked = await fetchWithTimeout(`${appUrl}/api/personal-cards/${personalCardId}/share`, {
    method: "DELETE",
    headers: { authorization: participantAuthorization },
  });
  assert(shareRevoked.status === 204, "share revocation did not return 204");

  const creationClosed = await requestJson(`/api/personal-cards/${personalCardId}/share`, {
    method: "POST",
    headers: { authorization: participantAuthorization },
  });
  assert(creationClosed.response.status === 403, "closed share creation did not return 403");
  assert(
    creationClosed.payload?.error?.details?.gate === "share_creation",
    "closed share creation did not identify its gate",
  );

  await database.query(
    "delete from private.participant_access where user_id = $1",
    [participantAppUserId],
  );
  const shareRevokedAgain = await fetchWithTimeout(`${appUrl}/api/personal-cards/${personalCardId}/share`, {
    method: "DELETE",
    headers: { authorization: participantAuthorization },
  });
  assert(shareRevokedAgain.status === 204, "repeat share revocation was not idempotent");
  assert(
    (await publicShareJson("/api/public-share/resolve", shareSlug, {
      headers: { cookie: reopenedAgeCookie },
    })).response.status === 404,
    "revoked share still resolved",
  );
  assert(
    (await publicShareJson("/api/public-share/photo", shareSlug, {
      headers: { cookie: reopenedAgeCookie },
    })).response.status === 404,
    "revoked photo still resolved",
  );

  const eventCounts = await database.query(
    `select event_name::text, count(*)::int as count
     from analytics.events
     where event_name in (
       'landing_view', 'share_view', 'share_revoked', 'retro_granted'
     )
     group by event_name`,
  );
  const counts = Object.fromEntries(eventCounts.rows.map((row) => [row.event_name, row.count]));
  for (const eventName of [
    "landing_view",
    "share_view",
    "share_revoked",
    "retro_granted",
  ]) {
    const expected = eventName === "share_view" ? 3 : 1;
    assert(counts[eventName] === expected, `${eventName} event count mismatch`);
  }

  assert(!applicationOutput.includes(shareSlug), "application logs retained the share secret");
  assert(observedPublicRequestUrls.length > 0, "fixed public-share routes were not exercised");
  for (const requestUrl of observedPublicRequestUrls) {
    assert(fixedPublicSharePaths.has(requestUrl.pathname), `unexpected public-share URL: ${requestUrl.pathname}`);
    assert(requestUrl.search === "", "public-share request used a query string");
    assert(requestUrl.hash === "", "public-share request used a fragment");
    assert(!requestUrl.pathname.includes(shareSlug), "public-share request path retained the secret");
  }

  process.stdout.write("Share/retro E2E: fragment transport, age gate, projection, revoke, audit, and events passed\n");
} finally {
  if (server !== undefined) {
    await stopApplication(server);
  }
  if (photoPath !== undefined) {
    await serviceClient.storage.from("personal-cards").remove([photoPath]);
  }
  if (databaseConnected) {
    for (const userId of [participantAppUserId, adminAppUserId]) {
      if (userId !== undefined) {
        await database.query("delete from public.app_users where id = $1", [userId]);
      }
    }
    if (cardId !== undefined && spotId !== undefined) {
      await retireLocalizedSpotCardFixture(database, { cardId, spotId });
    }
    if (policyFixture !== undefined) {
      await retirePolicyFixture(database, policyFixture).catch(() => undefined);
    }
    await database.end();
  }
  for (const authUserId of [participantAuthUserId, adminAuthUserId]) {
    if (authUserId !== undefined) {
      await serviceClient.auth.admin.deleteUser(authUserId);
    }
  }
}
