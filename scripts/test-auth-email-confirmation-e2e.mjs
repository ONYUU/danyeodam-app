import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";

import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { createPolicyFixture, retirePolicyFixture } from "./lib/policy-fixture.mjs";

const { Client } = pg;
const appPort = Number.parseInt(process.env.DANYEODAM_AUTH_E2E_PORT ?? "31118", 10);
assertPort(appPort);
const appUrl = `http://127.0.0.1:${appPort}`;
const requestTimeoutMs = 5_000;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("DANYEODAM_AUTH_E2E_PORT must be a valid TCP port");
  }
}

function assertReviewerAuthConfiguration() {
  const config = readFileSync(
    new URL("../supabase/config.toml", import.meta.url),
    "utf8",
  );
  const sections = new Map();
  let currentSection;
  for (const rawLine of config.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+#.*$/u, "").trim();
    const sectionMatch = /^\[([^\]]+)\]$/u.exec(line);
    if (sectionMatch !== null) {
      currentSection = sectionMatch[1];
      if (!sections.has(currentSection)) {
        sections.set(currentSection, new Map());
      }
      continue;
    }
    const settingMatch = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/u.exec(line);
    if (currentSection !== undefined && settingMatch !== null) {
      sections.get(currentSection).set(settingMatch[1], settingMatch[2]);
    }
  }
  const assertDisabled = (section, setting = "enabled") => {
    assert(
      sections.get(section)?.get(setting) !== "true",
      `${section}.${setting} must not enable an alternate reviewer credential path`,
    );
  };
  assert(
    /^enable_manual_linking = false$/mu.test(config),
    "Supabase manual identity linking must remain disabled",
  );
  assert(
    /^secure_password_change = true$/mu.test(config),
    "Supabase secure password change must remain enabled",
  );
  assert(
    sections.get("auth.sms")?.get("enable_signup") === "false",
    "phone sign-up must remain disabled",
  );
  assertDisabled("auth.passkey");
  assertDisabled("auth.mfa.totp", "enroll_enabled");
  assertDisabled("auth.mfa.totp", "verify_enabled");
  assertDisabled("auth.mfa.phone", "enroll_enabled");
  assertDisabled("auth.mfa.phone", "verify_enabled");
  assertDisabled("auth.mfa.web_authn", "enroll_enabled");
  assertDisabled("auth.mfa.web_authn", "verify_enabled");
  for (const section of [
    "auth.sms.twilio",
    "auth.external.apple",
    "auth.web3.solana",
    "auth.third_party.firebase",
    "auth.third_party.auth0",
    "auth.third_party.aws_cognito",
    "auth.third_party.clerk",
    "auth.oauth_server",
  ]) {
    assertDisabled(section);
  }
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
  for (const key of ["ANON_KEY", "API_URL", "DB_URL", "MAILPIT_URL", "SERVICE_ROLE_KEY"]) {
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

function collectServerOutput(server) {
  let output = "";
  const append = (chunk) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-16_384);
  };
  server.stdout?.on("data", append);
  server.stderr?.on("data", append);
  return () => output;
}

async function waitForApplication(server, readServerOutput) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(
        `Next.js exited before becoming ready (${server.exitCode})\n${readServerOutput()}`,
      );
    }
    try {
      const response = await fetch(`${appUrl}/api/auth/link-email`, {
        method: "POST",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (response.status > 0) {
        return;
      }
    } catch {
      // The server socket is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Next.js did not become ready within 20 seconds\n${readServerOutput()}`);
}

async function stopApplication(server) {
  if (server.exitCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (server.exitCode === null) {
    server.kill("SIGKILL");
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
}

async function waitForMailpitMessage(mailpitUrl, recipient) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${mailpitUrl}/api/v1/messages?limit=100`, {
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    assert(response.ok, `Mailpit message listing failed (${response.status})`);
    const payload = await response.json();
    const message = payload.messages?.find(
      (candidate) => Array.isArray(candidate.To)
        && candidate.To.some((address) => address.Address === recipient),
    );
    if (typeof message?.ID === "string") {
      return message.ID;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("confirmation email did not arrive in Mailpit within 15 seconds");
}

async function readConfirmationUrl(mailpitUrl, messageId, apiUrl) {
  const response = await fetch(`${mailpitUrl}/api/v1/message/${encodeURIComponent(messageId)}`, {
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  assert(response.ok, `Mailpit message read failed (${response.status})`);
  const message = await response.json();
  assert(typeof message.Text === "string", "Mailpit confirmation email text missing");
  const match = /https?:\/\/[^\s)]+\/auth\/v1\/verify\?[^\s)]+/u.exec(message.Text);
  assert(match !== null, "confirmation link missing from Mailpit email");

  const confirmationUrl = new URL(match[0]);
  const expectedApiUrl = new URL(apiUrl);
  assert(confirmationUrl.origin === expectedApiUrl.origin, "confirmation link has unexpected origin");
  assert(confirmationUrl.pathname === "/auth/v1/verify", "confirmation link has unexpected path");
  assert(confirmationUrl.searchParams.get("type") === "email_change", "confirmation link type mismatch");
  assert((confirmationUrl.searchParams.get("token")?.length ?? 0) > 0, "confirmation token missing");
  return confirmationUrl;
}

async function readAuthRow(database, authUserId) {
  const result = await database.query(
    `select is_anonymous, email, email_confirmed_at, email_change,
       encrypted_password
     from auth.users
     where id = $1`,
    [authUserId],
  );
  assert(result.rowCount === 1, "Auth user row missing");
  return result.rows[0];
}

async function updateAuthUser(apiUrl, anonKey, accessToken, attributes) {
  return fetch(`${apiUrl}/auth/v1/user`, {
    method: "PUT",
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(attributes),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
}

async function readAuthMutationFailure(response, label, expectedMessage) {
  const body = await response.text();
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`${label} returned a non-JSON error body (${response.status})`);
  }
  const errorCode = payload.code ?? payload.error_code;
  const errorMessage = payload.message ?? payload.msg;
  assert(response.status === 500, `${label} status mismatch (${response.status})`);
  assert(errorCode === "23514", `${label} error code mismatch (${String(errorCode)})`);
  assert(
    errorMessage === expectedMessage,
    `${label} error message mismatch (${String(errorMessage)})`,
  );
  assert(!body.includes("reviewer"), `${label} exposed reviewer classification`);
  return { errorCode, errorMessage };
}

async function readGuardDenialCount(database) {
  const result = await database.query(
    `select last_value::text as last_value, is_called
     from private.reviewer_auth_guard_denials`,
  );
  assert(result.rowCount === 1, "reviewer Auth denial sequence missing");
  return result.rows[0].is_called ? BigInt(result.rows[0].last_value) : 0n;
}

function readJwtPayload(token) {
  const payload = token.split(".")[1];
  assert(typeof payload === "string", "JWT payload missing");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

async function readAccessProjection(accessToken) {
  const response = await fetch(`${appUrl}/api/me/access`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const payload = await response.json();
  return { response, payload };
}

assertReviewerAuthConfiguration();
const local = readLocalSupabaseEnvironment();
const database = new Client({ connectionString: local.DB_URL });
const anonymousClient = createAuthClient(local.API_URL, local.ANON_KEY);
const serviceClient = createAuthClient(local.API_URL, local.SERVICE_ROLE_KEY);
const testEmail = `auth-confirmation-${randomUUID()}@example.test`;
const flowId = randomUUID();
const codeVerifier = randomBytes(32).toString("base64url");
const codeChallenge = createHash("sha256")
  .update(codeVerifier, "ascii")
  .digest("base64url");
const reviewerPassword = `Dd-${randomBytes(18).toString("base64url")}!7a`;
const forbiddenReviewerPassword = `Dd-${randomBytes(18).toString("base64url")}!9b`;
const forbiddenReviewerEmail = `reviewer-mutation-${randomUUID()}@example.test`;

let authUserId;
let appUserId;
let authUserHardDeleted = false;
let policyFixture;
let server;
let databaseConnected = false;
let readServerOutput = () => "";
let primaryError;

try {
  await database.connect();
  databaseConnected = true;
  await database.query("set statement_timeout = '10s'");

  const { data: signInData, error: signInError } = await anonymousClient.auth.signInAnonymously();
  assert(signInError === null, `anonymous sign-in failed: ${signInError?.message ?? "unknown"}`);
  assert(signInData.session !== null && signInData.user !== null, "anonymous session missing");
  assert(signInData.user.is_anonymous === true, "new user is not anonymous");
  assert(readJwtPayload(signInData.session.access_token).is_anonymous === true, "anonymous JWT claim missing");
  authUserId = signInData.user.id;

  policyFixture = await createPolicyFixture(database, { authUserIds: [authUserId] });

  const appEnvironment = {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: local.API_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: local.ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: local.SERVICE_ROLE_KEY,
    PUBLIC_RECRUIT_GATE: "false",
    AUTH_EMAIL_REDIRECT_TO: "http://127.0.0.1:3000/auth/callback",
    CRON_SECRET: "local-auth-confirmation-e2e-secret-value-0001",
    LOCATION_COMPLIANCE_CURSOR_SECRET:
      "local-auth-confirmation-location-cursor-secret-0001",
  };
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
      env: appEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  readServerOutput = collectServerOutput(server);
  await waitForApplication(server, readServerOutput);

  const requestResponse = await fetch(`${appUrl}/api/auth/link-email`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${signInData.session.access_token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      email: testEmail,
      flow_id: flowId,
      code_challenge: codeChallenge,
      code_challenge_method: "s256",
    }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  assert(requestResponse.status === 204, `link-email did not return 204 (${requestResponse.status})`);
  assert(await requestResponse.text() === "", "link-email 204 response must have an empty body");

  const { data: pendingData, error: pendingError } = await anonymousClient.auth.getUser(
    signInData.session.access_token,
  );
  assert(pendingError === null && pendingData.user !== null, "pending Auth user lookup failed");
  assert(pendingData.user.is_anonymous === true, "204 incorrectly completed anonymous conversion");
  assert(!pendingData.user.email, "unconfirmed email became the active email after 204");
  assert(pendingData.user.new_email === testEmail, "pending email was not recorded after 204");
  assert(!pendingData.user.email_confirmed_at, "email was confirmed before ownership verification");

  const pendingRow = await readAuthRow(database, authUserId);
  assert(pendingRow.is_anonymous === true, "database user stopped being anonymous before confirmation");
  assert(!pendingRow.email, "database active email changed before confirmation");
  assert(pendingRow.email_confirmed_at === null, "database email confirmation was set before confirmation");
  assert(pendingRow.email_change === testEmail, "database pending email mismatch");

  await database.query(
    `update auth.users
     set raw_user_meta_data = '{"role":"store_reviewer","is_store_reviewer":true}'::jsonb
     where id = $1`,
    [authUserId],
  );

  const messageId = await waitForMailpitMessage(local.MAILPIT_URL, testEmail);
  const confirmationUrl = await readConfirmationUrl(
    local.MAILPIT_URL,
    messageId,
    local.API_URL,
  );
  const confirmationResponse = await fetch(confirmationUrl, {
    redirect: "manual",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  assert(
    confirmationResponse.status >= 300 && confirmationResponse.status < 400,
    `email confirmation did not redirect (${confirmationResponse.status})`,
  );
  const callbackLocation = confirmationResponse.headers.get("location");
  assert(callbackLocation !== null, "email confirmation callback location missing");
  const callbackUrl = new URL(callbackLocation);
  assert(callbackUrl.origin === "http://127.0.0.1:3000", "unexpected callback origin");
  assert(callbackUrl.pathname === "/auth/callback", "unexpected callback path");
  assert(callbackUrl.searchParams.get("sb_flow_id") === flowId, "callback flow id mismatch");
  const authCode = callbackUrl.searchParams.get("code");
  assert(typeof authCode === "string" && authCode.length > 0, "PKCE auth code missing");

  const exchangeResponse = await fetch(`${local.API_URL}/auth/v1/token?grant_type=pkce`, {
    method: "POST",
    headers: {
      apikey: local.ANON_KEY,
      authorization: `Bearer ${local.ANON_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      auth_code: authCode,
      code_verifier: codeVerifier,
    }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  assert(exchangeResponse.ok, `PKCE code exchange failed (${exchangeResponse.status})`);
  const exchangePayload = await exchangeResponse.json();
  assert(exchangePayload.user?.id === authUserId, "PKCE exchange changed the Auth user");
  assert(exchangePayload.user?.is_anonymous === false, "PKCE exchange returned an anonymous user");
  assert(
    readJwtPayload(exchangePayload.access_token).is_anonymous === false,
    "PKCE exchange returned a JWT with the anonymous claim",
  );

  // Complete the ordinary email/password credential before reviewer
  // designation. This direct GoTrue update is the standard-user regression
  // and must remain available with secure password change enabled.
  const standardPasswordResponse = await updateAuthUser(
    local.API_URL,
    local.ANON_KEY,
    exchangePayload.access_token,
    { password: reviewerPassword },
  );
  assert(
    standardPasswordResponse.ok,
    `standard password update failed (${standardPasswordResponse.status})`,
  );
  const linkedCredentialRow = await readAuthRow(database, authUserId);
  assert(
    linkedCredentialRow.encrypted_password.length > 0,
    "standard password update did not persist a credential hash",
  );
  const reviewerPasswordHash = linkedCredentialRow.encrypted_password;

  const standardAccess = await readAccessProjection(exchangePayload.access_token);
  assert(standardAccess.response.status === 200, "standard access projection failed");
  assert(standardAccess.payload.participant === false, "metadata forged participant access");
  assert(standardAccess.payload.access_type === "standard", "metadata forged reviewer access");
  assert(
    standardAccess.payload.field_acquisition_requires_location === true,
    "standard access projection relaxed field location",
  );
  assert(standardAccess.payload.fixture_version === null, "standard access exposed a fixture version");

  const identityResult = await database.query(
    `select user_id
     from private.user_identities
     where auth_user_id = $1
       and revoked_at is null`,
    [authUserId],
  );
  assert(identityResult.rowCount === 1, "active logical user binding missing");
  appUserId = identityResult.rows[0].user_id;
  const forgedReviewerCredential = await database.query(
    "select private.reviewer_auth_credential_is_valid($1) as valid",
    [appUserId],
  );
  assert(
    forgedReviewerCredential.rows[0]?.valid === false,
    "forged user metadata satisfied the reviewer credential invariant",
  );
  await database.query(
    `update auth.users
     set raw_user_meta_data = '{"email_verified":true}'::jsonb
     where id = $1`,
    [authUserId],
  );
  const restoredReviewerCredential = await database.query(
    "select private.reviewer_auth_credential_is_valid($1) as valid",
    [appUserId],
  );
  assert(
    restoredReviewerCredential.rows[0]?.valid === true,
    "supported GoTrue user metadata did not restore the reviewer credential invariant",
  );
  await database.query(
    `insert into private.participant_access (user_id, access_kind)
     values ($1, 'store_reviewer')`,
    [appUserId],
  );
  await database.query(
    `insert into private.reviewer_accounts (
       user_id,
       store_platform,
       fixture_version
     ) values ($1, 'app_store', 'e2e-2026.08.1')`,
    [appUserId],
  );

  const reviewerAccess = await readAccessProjection(exchangePayload.access_token);
  assert(reviewerAccess.response.status === 200, "reviewer access projection failed");
  assert(reviewerAccess.payload.participant === true, "reviewer participant membership missing");
  assert(
    reviewerAccess.payload.access_type === "store_reviewer",
    "active DB reviewer membership was not projected",
  );
  assert(
    reviewerAccess.payload.field_acquisition_requires_location === true,
    "reviewer projection relaxed field location",
  );
  assert(
    reviewerAccess.payload.fixture_version === "e2e-2026.08.1",
    "reviewer fixture version mismatch",
  );

  // Exercise the DB boundaries behind automatic OAuth linking and MFA
  // enrollment directly. Production keeps those providers disabled as a
  // second layer, but the reusable reviewer invariant must not depend on the
  // remote toggle alone.
  const auxiliaryDenialCountBefore = await readGuardDenialCount(database);
  let directIdentityMutationError;
  try {
    await database.query(
      `insert into auth.identities (
         id, user_id, provider_id, identity_data, provider,
         last_sign_in_at, created_at, updated_at
       ) values (
         $1, $2, 'e2e-forbidden-oauth',
         jsonb_build_object('sub', 'e2e-forbidden-oauth'),
         'github', clock_timestamp(), clock_timestamp(), clock_timestamp()
       )`,
      [randomUUID(), authUserId],
    );
  } catch (error) {
    directIdentityMutationError = error;
  }
  assert(
    directIdentityMutationError?.code === "23514"
      && directIdentityMutationError?.message === "credential identity mutation is forbidden",
    "direct reviewer Auth identity mutation did not reach the DB guard",
  );

  let directFactorMutationError;
  try {
    await database.query(
      `insert into auth.mfa_factors (
         id, user_id, friendly_name, factor_type, status,
         created_at, updated_at, secret
       ) values (
         $1, $2, 'e2e forbidden reviewer factor', 'totp', 'unverified',
         clock_timestamp(), clock_timestamp(), 'e2e-redacted-factor-secret'
       )`,
      [randomUUID(), authUserId],
    );
  } catch (error) {
    directFactorMutationError = error;
  }
  assert(
    directFactorMutationError?.code === "23514"
      && directFactorMutationError?.message
        === "auxiliary credential mutation is forbidden",
    "direct reviewer MFA factor mutation did not reach the DB guard",
  );
  const auxiliaryDenialCountAfter = await readGuardDenialCount(database);
  assert(
    auxiliaryDenialCountAfter - auxiliaryDenialCountBefore === 2n,
    "identity/factor DB guard denial count mismatch",
  );

  // Reviewer password sign-in and token refresh change only volatile Auth
  // state and therefore must continue to work under the database trigger.
  const reviewerPasswordClient = createAuthClient(local.API_URL, local.ANON_KEY);
  const { data: reviewerSignIn, error: reviewerSignInError } =
    await reviewerPasswordClient.auth.signInWithPassword({
      email: testEmail,
      password: reviewerPassword,
    });
  assert(
    reviewerSignInError === null && reviewerSignIn.session !== null,
    `reviewer password sign-in failed: ${reviewerSignInError?.message ?? "unknown"}`,
  );
  assert(
    reviewerSignIn.user?.id === authUserId,
    "reviewer password sign-in resolved a different Auth user",
  );
  const { data: reviewerRefresh, error: reviewerRefreshError } =
    await reviewerPasswordClient.auth.refreshSession({
      refresh_token: reviewerSignIn.session.refresh_token,
    });
  assert(
    reviewerRefreshError === null && reviewerRefresh.session !== null,
    `reviewer refresh failed: ${reviewerRefreshError?.message ?? "unknown"}`,
  );

  // The public GoTrue URL and anon key are intentionally available to the
  // app. A reviewer JWT must still be unable to bypass the Next.js route and
  // call PUT /auth/v1/user for either email or password mutation.
  const denialCountBefore = await readGuardDenialCount(database);
  const reviewerEmailMutation = await updateAuthUser(
    local.API_URL,
    local.ANON_KEY,
    reviewerRefresh.session.access_token,
    { email: forbiddenReviewerEmail },
  );
  assert(
    !reviewerEmailMutation.ok,
    "direct reviewer GoTrue email mutation unexpectedly succeeded",
  );
  await readAuthMutationFailure(
    reviewerEmailMutation,
    "direct reviewer email mutation",
    "credential mutation is forbidden",
  );
  const reviewerPasswordMutation = await updateAuthUser(
    local.API_URL,
    local.ANON_KEY,
    reviewerRefresh.session.access_token,
    { password: forbiddenReviewerPassword },
  );
  assert(
    !reviewerPasswordMutation.ok,
    "direct reviewer GoTrue password mutation unexpectedly succeeded",
  );
  await readAuthMutationFailure(
    reviewerPasswordMutation,
    "direct reviewer password mutation",
    "credential mutation is forbidden",
  );
  const denialCountAfter = await readGuardDenialCount(database);
  assert(
    denialCountAfter - denialCountBefore === 2n,
    `GoTrue failures did not reach the DB trigger exactly twice (${denialCountBefore} -> ${denialCountAfter})`,
  );
  const guardedCredentialRow = await readAuthRow(database, authUserId);
  assert(guardedCredentialRow.email === testEmail, "reviewer email changed behind the guard");
  assert(!guardedCredentialRow.email_change, "reviewer pending email escaped the guard");
  assert(
    guardedCredentialRow.encrypted_password === reviewerPasswordHash,
    "reviewer password hash changed behind the guard",
  );

  const { data: reviewerRepeatSignIn, error: reviewerRepeatSignInError } =
    await reviewerPasswordClient.auth.signInWithPassword({
      email: testEmail,
      password: reviewerPassword,
    });
  assert(
    reviewerRepeatSignInError === null && reviewerRepeatSignIn.session !== null,
    "original reviewer password stopped working after blocked mutation",
  );

  await database.query(
    `update private.reviewer_accounts
     set revoked_at = now()
     where user_id = $1`,
    [appUserId],
  );
  const revokedReviewerAccess = await readAccessProjection(exchangePayload.access_token);
  assert(revokedReviewerAccess.response.status === 200, "revoked reviewer projection failed");
  assert(
    revokedReviewerAccess.payload.access_type === "standard",
    "revoked reviewer membership remained privileged",
  );
  assert(
    revokedReviewerAccess.payload.fixture_version === null,
    "revoked reviewer membership exposed a fixture version",
  );

  const { data: confirmedData, error: confirmedError } = await anonymousClient.auth.getUser(
    reviewerRepeatSignIn.session.access_token,
  );
  assert(confirmedError === null && confirmedData.user !== null, "confirmed Auth user lookup failed");
  assert(confirmedData.user.is_anonymous === false, "confirmed user remained anonymous");
  assert(confirmedData.user.email === testEmail, "confirmed email did not become active");
  assert(Boolean(confirmedData.user.email_confirmed_at), "confirmed user has no confirmation timestamp");
  assert(
    confirmedData.user.identities?.some((identity) => identity.provider === "email") === true,
    "confirmed user has no email identity",
  );

  const confirmedRow = await readAuthRow(database, authUserId);
  assert(confirmedRow.is_anonymous === false, "database user remained anonymous after confirmation");
  assert(confirmedRow.email === testEmail, "database active email mismatch after confirmation");
  assert(confirmedRow.email_confirmed_at !== null, "database confirmation timestamp missing");
  assert(!confirmedRow.email_change, "database pending email was not cleared after confirmation");

  const repeatResponse = await fetch(`${appUrl}/api/auth/link-email`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${reviewerRepeatSignIn.session.access_token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      email: `repeat-${testEmail}`,
      flow_id: randomUUID(),
      code_challenge: createHash("sha256")
        .update(randomBytes(32).toString("base64url"), "ascii")
        .digest("base64url"),
      code_challenge_method: "s256",
    }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const repeatPayload = await repeatResponse.json();
  assert(repeatResponse.status === 403, "confirmed user was allowed to repeat anonymous link-email flow");
  assert(repeatPayload.error?.code === "FORBIDDEN", "repeat link-email error code mismatch");

  await database.query(
    `update private.user_identities
     set revoked_at = now()
     where auth_user_id = $1
       and revoked_at is null`,
    [authUserId],
  );
  const revokedIdentityAccess = await readAccessProjection(exchangePayload.access_token);
  assert(revokedIdentityAccess.response.status === 401, "revoked identity was not blocked");
  assert(
    revokedIdentityAccess.payload.error?.code === "UNAUTHORIZED",
    "revoked identity error code mismatch",
  );

  // Exercise GoTrue's real deletion order while reviewer history and the
  // revoked service binding still exist. Soft deletion updates auth.users,
  // then obfuscates auth.identities; hard deletion removes both.
  const { error: softDeleteError } = await serviceClient.auth.admin.deleteUser(
    authUserId,
    true,
  );
  assert(softDeleteError === null, `reviewer Auth soft deletion failed: ${softDeleteError?.message}`);
  const softDeletedState = await database.query(
    `select
       auth_user.deleted_at,
       auth_identity.id as identity_id,
       auth_identity.provider_id,
       auth_identity.identity_data
     from auth.users as auth_user
     left join auth.identities as auth_identity
       on auth_identity.user_id = auth_user.id
     where auth_user.id = $1`,
    [authUserId],
  );
  assert(softDeletedState.rowCount === 1, "soft-deleted reviewer Auth row missing");
  assert(softDeletedState.rows[0].deleted_at !== null, "reviewer Auth user was not soft deleted");
  assert(
    softDeletedState.rows[0].identity_id !== null,
    "reviewer email identity disappeared instead of following GoTrue soft-delete redaction",
  );
  assert(
    softDeletedState.rows[0].provider_id !== authUserId,
    "reviewer email identity provider binding was not obfuscated on soft delete",
  );
  assert(
    Object.keys(softDeletedState.rows[0].identity_data ?? {}).length === 0,
    "reviewer email identity data was not redacted on soft delete",
  );

  const { error: hardDeleteError } = await serviceClient.auth.admin.deleteUser(
    authUserId,
    false,
  );
  assert(hardDeleteError === null, `reviewer Auth hard deletion failed: ${hardDeleteError?.message}`);
  authUserHardDeleted = true;
  const hardDeletedState = await database.query(
    `select
       (select count(*)::integer from auth.users where id = $1) as auth_users,
       (select count(*)::integer from auth.identities where user_id = $1) as auth_identities`,
    [authUserId],
  );
  assert(
    hardDeletedState.rows[0].auth_users === 0
      && hardDeletedState.rows[0].auth_identities === 0,
    "reviewer Auth hard deletion left user or identity rows",
  );

  process.stdout.write(
    "Auth/reviewer E2E: S256 flow, exact reviewer identity, sign-in/refresh, direct GoTrue DB-trigger blocking, binding revocation, and soft/hard deletion passed\n",
  );
} catch (error) {
  primaryError = error;
  const serverOutput = readServerOutput();
  if (serverOutput.length > 0) {
    process.stderr.write(`\nNext.js output:\n${serverOutput}\n`);
  }
  throw error;
} finally {
  let cleanupError;
  if (server !== undefined) {
    try {
      await stopApplication(server);
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (databaseConnected) {
    if (policyFixture !== undefined) {
      try {
        await retirePolicyFixture(database, policyFixture);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    try {
      if (appUserId !== undefined) {
        await database.query("delete from public.app_users where id = $1", [appUserId]);
      }
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      await database.end();
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (authUserId !== undefined && !authUserHardDeleted) {
    try {
      const { error } = await serviceClient.auth.admin.deleteUser(authUserId);
      if (error !== null) {
        throw error;
      }
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (cleanupError !== undefined) {
    if (primaryError === undefined) {
      throw cleanupError;
    }
    process.stderr.write(`Cleanup error: ${String(cleanupError)}\n`);
  }
}
