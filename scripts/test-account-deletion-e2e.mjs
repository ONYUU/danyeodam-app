import { execFileSync, spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import process from "node:process";

import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const { Client } = pg;
const appPort = Number.parseInt(
  process.env.DANYEODAM_ACCOUNT_DELETION_E2E_PORT ?? "31121",
  10,
);
assertPort(appPort);
const appUrl = `http://127.0.0.1:${appPort}`;
const requestTimeoutMs = 15_000;
const cronSecret = "account-deletion-e2e-cron-secret-value-0001";
const rateLimitSecret = "account-deletion-e2e-rate-limit-secret-0001";
const reviewerPassword = "Account-deletion-reviewer-e2e-2026!";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("DANYEODAM_ACCOUNT_DELETION_E2E_PORT must be a valid TCP port");
  }
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function scopedIpDigest(scope) {
  return createHmac("sha256", rateLimitSecret)
    .update(`danyeodam:${scope}:v1\n127.0.0.1`, "utf8")
    .digest("hex");
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

function createAuthClient(url, key) {
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

function hasExited(server) {
  return server.exitCode !== null || server.signalCode !== null;
}

async function waitForApplication(server, readOutput) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (hasExited(server)) {
      throw new Error(`Next.js exited before readiness\n${readOutput()}`);
    }
    try {
      const response = await fetch(`${appUrl}/account/delete`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status > 0) return;
    } catch {
      // The application socket is not ready yet.
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
  if (!hasExited(server)) {
    server.kill("SIGKILL");
    await Promise.race([
      new Promise((resolve) => server.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
}

async function request(path, { token, statusToken, method = "GET", body } = {}) {
  const headers = { "x-vercel-forwarded-for": "127.0.0.1" };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (statusToken !== undefined) headers["x-deletion-status-token"] = statusToken;
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

async function callMaintenance() {
  return request("/api/internal/maintenance/account-deletions", {
    method: "GET",
    token: cronSecret,
  });
}

async function completeDeletion(database, requestId, readOutput) {
  let quarantine;
  for (let pass = 0; pass < 8; pass += 1) {
    const maintenance = await callMaintenance();
    assert(
      maintenance.response.status === 200,
      `deletion maintenance pass failed (${maintenance.response.status})\n${readOutput()}`,
    );
    quarantine = await database.query(
      `select phase, status, final_storage_empty_at, next_attempt_at
       from private.account_deletion_jobs
       where id = $1`,
      [requestId],
    );
    assert(quarantine.rowCount === 1, "deletion job disappeared before completion");
    if (
      quarantine.rows[0].phase === "storage_final"
      && quarantine.rows[0].status === "pending"
      && quarantine.rows[0].final_storage_empty_at !== null
    ) break;

    // Preserve both Storage delete passes while accelerating only their
    // production delay in this isolated local fixture.
    await database.query(
      `update private.account_deletion_storage_manifest
       set final_delete_after = first_deleted_at
       where request_id = $1
         and first_deleted_at is not null
         and deleted_at is null`,
      [requestId],
    );
    await database.query(
      `update private.account_deletion_jobs
       set next_attempt_at = clock_timestamp() - interval '1 second'
       where id = $1 and status = 'pending'`,
      [requestId],
    );
  }
  assert(
    quarantine?.rows[0]?.phase === "storage_final"
      && quarantine.rows[0].status === "pending"
      && quarantine.rows[0].final_storage_empty_at !== null,
    `worker did not enter final Storage quarantine (${JSON.stringify(quarantine?.rows[0])})`,
  );

  // Production deliberately waits 70 minutes between empty final listings.
  // This local-only fixture moves the already-observed empty scan into the
  // past; it does not bypass either listing or any worker phase.
  await database.query(
    `update private.account_deletion_jobs
     set final_storage_empty_at = clock_timestamp() - interval '71 minutes',
         next_attempt_at = clock_timestamp() - interval '1 second'
     where id = $1
       and phase = 'storage_final'
       and final_storage_empty_at is not null`,
    [requestId],
  );

  const completionPass = await callMaintenance();
  assert(
    completionPass.response.status === 200,
    `completion maintenance pass failed (${completionPass.response.status})\n${readOutput()}`,
  );
  assert(completionPass.payload?.completed === 1, "worker did not finalize exactly one account");
}

function deletionBody(requestId, statusToken) {
  return {
    client_request_id: requestId,
    status_token: statusToken,
    confirmation: "DELETE_MY_ACCOUNT",
  };
}

const local = readLocalSupabaseEnvironment();
const database = new Client({ connectionString: local.DB_URL });
const serviceClient = createAuthClient(local.API_URL, local.SERVICE_ROLE_KEY);
const reviewerClient = createAuthClient(local.API_URL, local.ANON_KEY);
const recoveryClient = createAuthClient(local.API_URL, local.ANON_KEY);

let databaseConnected = false;
let server;
let serverOutput = "";
let reviewerStoragePath;
const authUserIds = [];
const appUserIds = [];
const deletionRequestIds = [];
let recoveryCodeHash;

try {
  await database.connect();
  databaseConnected = true;
  await database.query("set statement_timeout = '10s'");

  const reviewerEmail = `account-delete-reviewer-${randomUUID()}@example.test`;
  const reviewerCreated = await serviceClient.auth.admin.createUser({
    email: reviewerEmail,
    password: reviewerPassword,
    email_confirm: true,
  });
  assert(reviewerCreated.error === null, "local reviewer Auth user creation failed");
  assert(reviewerCreated.data.user !== null, "local reviewer Auth user missing");
  const reviewerAuthUserId = reviewerCreated.data.user.id;
  authUserIds.push(reviewerAuthUserId);

  const reviewerIdentity = await database.query(
    `select user_id
     from private.user_identities
     where auth_user_id = $1 and revoked_at is null`,
    [reviewerAuthUserId],
  );
  assert(reviewerIdentity.rowCount === 1, "reviewer logical identity missing");
  const reviewerAppUserId = reviewerIdentity.rows[0].user_id;
  appUserIds.push(reviewerAppUserId);
  // Local GoTrue admin.createUser({ email_confirm: true }) confirms the user
  // row but leaves the email identity's email_verified flag false. The real
  // PKCE confirmation path is covered by the auth E2E; normalize only this
  // local reviewer fixture before exercising deletion-only password access.
  const confirmedReviewerIdentity = await database.query(
    `update auth.identities
     set identity_data = jsonb_set(identity_data, '{email_verified}', 'true'::jsonb)
     where user_id = $1
       and provider = 'email'
       and provider_id = $1::text
     returning id`,
    [reviewerAuthUserId],
  );
  assert(
    confirmedReviewerIdentity.rowCount === 1,
    "local reviewer email identity normalization failed",
  );
  await database.query(
    `insert into private.participant_access (user_id, access_kind)
     values ($1, 'store_reviewer')`,
    [reviewerAppUserId],
  );
  await database.query(
    `insert into private.reviewer_accounts (
       user_id, store_platform, fixture_version
     ) values ($1, 'app_store', 'account-delete-e2e-v1')`,
    [reviewerAppUserId],
  );

  const wrongPassword = await reviewerClient.auth.signInWithPassword({
    email: reviewerEmail,
    password: `${reviewerPassword}-wrong`,
  });
  assert(wrongPassword.error !== null, "reviewer path accepted a wrong password");
  assert(wrongPassword.data.session === null, "wrong reviewer password returned a session");
  const reviewerSignIn = await reviewerClient.auth.signInWithPassword({
    email: reviewerEmail,
    password: reviewerPassword,
  });
  assert(reviewerSignIn.error === null, "reviewer password sign-in failed");
  assert(reviewerSignIn.data.session !== null, "reviewer password session missing");
  const reviewerAccessToken = reviewerSignIn.data.session.access_token;
  reviewerStoragePath = `${reviewerAppUserId}/${randomUUID()}.webp`;
  const reviewerStorageUpload = await serviceClient.storage
    .from("personal-cards")
    .upload(reviewerStoragePath, Buffer.from("account-deletion-e2e-object", "utf8"), {
      contentType: "image/webp",
      upsert: false,
    });
  assert(reviewerStorageUpload.error === null, "reviewer Storage fixture upload failed");

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
      AUTH_EMAIL_REDIRECT_TO: "http://127.0.0.1:3000/auth/callback",
      COLLECTION_CURSOR_SECRET: "account-deletion-e2e-collection-secret-0001",
      LOCATION_COMPLIANCE_CURSOR_SECRET:
        "account-deletion-e2e-location-cursor-secret-0001",
      ABUSE_HMAC_SECRET: "account-deletion-e2e-abuse-secret-value-0001",
      ACCOUNT_DELETION_RATE_LIMIT_SECRET: rateLimitSecret,
      ACCOUNT_DELETION_SUPPORT_URL: "https://support.example.test/account-deletion",
      PUBLIC_SUPPORT_URL: "https://support.example.test",
      ACCOUNT_DELETION_DEVELOPER_NAME: "DANYEODAM E2E Developer",
      CRON_SECRET: cronSecret,
      PUBLIC_APP_URL: "https://account-delete-e2e.example.test",
      VERCEL: "1",
      VERCEL_ENV: "preview",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const appendServerOutput = (chunk) => {
    serverOutput = `${serverOutput}${chunk.toString("utf8")}`.slice(-16_384);
  };
  server.stdout?.on("data", appendServerOutput);
  server.stderr?.on("data", appendServerOutput);
  await waitForApplication(server, () => serverOutput);

  const page = await fetch(`${appUrl}/account/delete`, {
    headers: { "accept-language": "en" },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const pageHtml = await page.text();
  assert(page.status === 200, "public deletion page did not render");
  assert(pageHtml.includes("DANYEODAM"), "public deletion page omitted the product identity");
  assert(
    pageHtml.includes("DANYEODAM E2E Developer")
      && pageHtml.includes("24")
      && pageHtml.includes("personal cards"),
    "public deletion page omitted developer, deadline, or deletion scope copy",
  );

  const reviewerRequestId = randomUUID();
  const reviewerStatusToken = randomBytes(32).toString("base64url");
  deletionRequestIds.push(reviewerRequestId);
  const reviewerDeletion = await request("/api/me/deletion-requests", {
    token: reviewerAccessToken,
    method: "POST",
    body: deletionBody(reviewerRequestId, reviewerStatusToken),
  });
  assert(reviewerDeletion.response.status === 202, "reviewer deletion request was not accepted");
  assert(
    reviewerDeletion.payload?.deletion_request?.id === reviewerRequestId
      && reviewerDeletion.payload?.deletion_request?.status === "pending",
    "reviewer deletion response mismatch",
  );

  const idempotentRetry = await request("/api/me/deletion-requests", {
    token: reviewerAccessToken,
    method: "POST",
    body: deletionBody(reviewerRequestId, reviewerStatusToken),
  });
  assert(idempotentRetry.response.status === 202, "exact deletion transport retry failed");
  const conflict = await request("/api/me/deletion-requests", {
    token: reviewerAccessToken,
    method: "POST",
    body: deletionBody(reviewerRequestId, randomBytes(32).toString("base64url")),
  });
  assert(
    conflict.response.status === 409
      && conflict.payload?.error?.code === "IDEMPOTENCY_CONFLICT",
    "status-token idempotency conflict was not enforced",
  );

  const revokedAccess = await request("/api/me/access", { token: reviewerAccessToken });
  assert(
    revokedAccess.response.status === 401
      && revokedAccess.payload?.error?.code === "UNAUTHORIZED",
    "deletion did not immediately revoke protected product access",
  );

  const wrongStatus = await request(
    `/api/account/deletion-requests/${reviewerRequestId}`,
    { statusToken: randomBytes(32).toString("base64url") },
  );
  assert(
    wrongStatus.response.status === 404 && wrongStatus.payload?.error?.code === "NOT_FOUND",
    "wrong deletion status token was not hidden as not found",
  );
  const reviewerPending = await request(
    `/api/account/deletion-requests/${reviewerRequestId}`,
    { statusToken: reviewerStatusToken },
  );
  assert(
    reviewerPending.response.status === 200
      && reviewerPending.payload?.status === "pending"
      && reviewerPending.payload?.reason_code === null
      && reviewerPending.payload?.support_url
        === "https://support.example.test/account-deletion",
    "valid reviewer status token did not return pending",
  );

  await completeDeletion(database, reviewerRequestId, () => serverOutput);
  const reviewerCompleted = await request(
    `/api/account/deletion-requests/${reviewerRequestId}`,
    { statusToken: reviewerStatusToken },
  );
  assert(
    reviewerCompleted.response.status === 200
      && reviewerCompleted.payload?.status === "completed"
      && reviewerCompleted.payload?.completed_at !== null,
    "reviewer deletion receipt did not become completed",
  );

  const reviewerRemoved = await database.query(
    `select
       exists(select 1 from auth.users where id = $1) as auth_exists,
       exists(select 1 from public.app_users where id = $2) as app_exists,
       exists(
         select 1
         from private.account_deletion_storage_manifest
         where request_id = $3
       ) as storage_manifest_exists`,
    [reviewerAuthUserId, reviewerAppUserId, reviewerRequestId],
  );
  assert(
    !reviewerRemoved.rows[0].auth_exists
      && !reviewerRemoved.rows[0].app_exists
      && !reviewerRemoved.rows[0].storage_manifest_exists,
    "completed reviewer deletion retained identifiable account state",
  );
  const reviewerStorageAfterDeletion = await serviceClient.storage
    .from("personal-cards")
    .list(reviewerAppUserId, { limit: 100 });
  assert(
    reviewerStorageAfterDeletion.error === null
      && Array.isArray(reviewerStorageAfterDeletion.data)
      && !reviewerStorageAfterDeletion.data.some(
        (object) => reviewerStoragePath.endsWith(`/${object.name}`),
      ),
    "completed deletion retained the real Storage object",
  );

  const recoverySignIn = await recoveryClient.auth.signInAnonymously();
  assert(recoverySignIn.error === null, "anonymous recovery fixture sign-in failed");
  assert(recoverySignIn.data.session !== null, "anonymous recovery session missing");
  assert(recoverySignIn.data.user !== null, "anonymous recovery Auth user missing");
  const recoveryAuthUserId = recoverySignIn.data.user.id;
  const recoveryAccessToken = recoverySignIn.data.session.access_token;
  authUserIds.push(recoveryAuthUserId);
  const recoveryIdentity = await database.query(
    `select user_id
     from private.user_identities
     where auth_user_id = $1 and revoked_at is null`,
    [recoveryAuthUserId],
  );
  assert(recoveryIdentity.rowCount === 1, "recovery logical identity missing");
  const recoveryAppUserId = recoveryIdentity.rows[0].user_id;
  appUserIds.push(recoveryAppUserId);

  const recoveryCode = randomBytes(32).toString("base64url");
  recoveryCodeHash = sha256(recoveryCode);
  await database.query(
    `insert into private.recovery_codes (user_id, code_hash, expires_at)
     values ($1, decode($2, 'hex'), clock_timestamp() + interval '1 hour')`,
    [recoveryAppUserId, recoveryCodeHash],
  );
  const recoveryRequestId = randomUUID();
  const recoveryStatusToken = randomBytes(32).toString("base64url");
  deletionRequestIds.push(recoveryRequestId);
  const recoveryDeletion = await request("/api/account/deletion-requests/recovery", {
    method: "POST",
    body: {
      ...deletionBody(recoveryRequestId, recoveryStatusToken),
      recovery_code: recoveryCode,
    },
  });
  assert(recoveryDeletion.response.status === 202, "recovery-code deletion was not accepted");
  assert(
    recoveryDeletion.payload?.deletion_request?.id === recoveryRequestId,
    "recovery-code deletion response mismatch",
  );
  const consumedRecoveryCode = await database.query(
    `select revoked_at, claimed_at
     from private.recovery_codes
     where user_id = $1 and code_hash = decode($2, 'hex')`,
    [recoveryAppUserId, recoveryCodeHash],
  );
  assert(
    consumedRecoveryCode.rowCount === 1
      && consumedRecoveryCode.rows[0].revoked_at !== null
      && consumedRecoveryCode.rows[0].claimed_at === null,
    "recovery deletion did not immediately consume the code without claiming the account",
  );
  const recoveryRevokedAccess = await request("/api/me/access", {
    token: recoveryAccessToken,
  });
  assert(
    recoveryRevokedAccess.response.status === 401
      && recoveryRevokedAccess.payload?.error?.code === "UNAUTHORIZED",
    "recovery deletion did not immediately revoke protected access",
  );
  const recoveryRetry = await request("/api/account/deletion-requests/recovery", {
    method: "POST",
    body: {
      ...deletionBody(recoveryRequestId, recoveryStatusToken),
      recovery_code: recoveryCode,
    },
  });
  assert(recoveryRetry.response.status === 202, "exact recovery deletion retry failed");

  const recoveryPending = await request(
    `/api/account/deletion-requests/${recoveryRequestId}`,
    { statusToken: recoveryStatusToken },
  );
  assert(
    recoveryPending.response.status === 200
      && recoveryPending.payload?.status === "pending",
    "valid recovery status token did not return pending",
  );
  await completeDeletion(database, recoveryRequestId, () => serverOutput);
  const recoveryCompleted = await request(
    `/api/account/deletion-requests/${recoveryRequestId}`,
    { statusToken: recoveryStatusToken },
  );
  assert(
    recoveryCompleted.response.status === 200
      && recoveryCompleted.payload?.status === "completed",
    "recovery deletion receipt did not become completed",
  );

  const completedReceipts = await database.query(
    `select count(*)::integer as count
     from private.account_deletion_jobs
     where id = any($1::uuid[])
       and status = 'completed'
       and phase = 'done'
       and user_id is null
       and storage_prefix is null
       and receipt_expires_at = completed_at + interval '30 days'`,
    [deletionRequestIds],
  );
  assert(completedReceipts.rows[0].count === 2, "sanitized 30-day receipts are incomplete");

  console.log("Account deletion E2E: 2 complete flows passed");
} finally {
  await stopApplication(server).catch(() => undefined);

  if (reviewerStoragePath !== undefined) {
    await serviceClient.storage
      .from("personal-cards")
      .remove([reviewerStoragePath])
      .catch(() => undefined);
  }

  if (databaseConnected) {
    if (deletionRequestIds.length > 0) {
      await database.query(
        `delete from private.account_deletion_jobs
         where id = any($1::uuid[])`,
        [deletionRequestIds],
      ).catch(() => undefined);
    }
    if (appUserIds.length > 0) {
      await database.query(
        `delete from public.app_users
         where id = any($1::uuid[])`,
        [appUserIds],
      ).catch(() => undefined);
    }
    if (authUserIds.length > 0) {
      await database.query(
        `delete from auth.users
         where id = any($1::uuid[])`,
        [authUserIds],
      ).catch(() => undefined);
    }
    if (appUserIds.length > 0) {
      await database.query(
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
        [appUserIds],
      ).catch(() => undefined);
    }
    await database.query(
      `delete from private.account_deletion_rate_limits
       where encode(subject_hash, 'hex') = any($1::text[])`,
      [[
        scopedIpDigest("account_deletion_recovery_ip"),
        scopedIpDigest("account_deletion_status_ip"),
        ...(recoveryCodeHash === undefined ? [] : [recoveryCodeHash]),
      ]],
    ).catch(() => undefined);
    await database.end().catch(() => undefined);
  }
}
