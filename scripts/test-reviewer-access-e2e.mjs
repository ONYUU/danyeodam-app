import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import process from "node:process";

import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  createLocalizedSpotCardFixture,
  retireLocalizedSpotCardFixture,
} from "./lib/localized-fixture.mjs";
import { createPolicyFixture, retirePolicyFixture } from "./lib/policy-fixture.mjs";

const { Client } = pg;

function localStatus() {
  const output = execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["supabase", "status", "-o", "env"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const values = new Map();
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/^([A-Z0-9_]+)="(.*)"$/u);
    if (match !== null) values.set(match[1], match[2]);
  }
  for (const key of ["API_URL", "ANON_KEY", "SERVICE_ROLE_KEY", "DB_URL"]) {
    if (!values.has(key)) throw new Error(`${key} missing from local Supabase status`);
  }
  return values;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function jwtPayload(token) {
  const encoded = token.split(".")[1];
  if (encoded === undefined) throw new Error("JWT payload missing");
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}

async function waitForServer(origin) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/me/access`);
      if (response.status === 401) return;
    } catch {
      // Server has not bound the loopback socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("reviewer E2E server did not become ready");
}

const status = localStatus();
const apiUrl = status.get("API_URL");
const service = createClient(apiUrl, status.get("SERVICE_ROLE_KEY"), {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
});
const anon = createClient(apiUrl, status.get("ANON_KEY"), {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
});
const database = new Client({ connectionString: status.get("DB_URL") });
await database.connect();

const suffix = randomUUID().replaceAll("-", "");
const email = (label) => `${label}-${suffix}@example.test`;
const password = () => `${randomBytes(24).toString("base64url")}Aa1!`;
const adminCredential = { email: email("reviewer-admin"), password: password() };
const reviewerCredential = { email: email("store-reviewer"), password: password() };
const contentFixtures = [];
let policyFixture;
let adminAuthUserId;
let adminUserId;
let reviewerAuthUserId;
let reviewerUserId;
let server;

try {
  const adminCreated = await service.auth.admin.createUser({
    ...adminCredential,
    email_confirm: true,
  });
  if (adminCreated.error !== null || adminCreated.data.user === null) {
    throw new Error("Admin Auth fixture creation failed");
  }
  adminAuthUserId = adminCreated.data.user.id;

  const reviewerCreated = await service.auth.admin.createUser({
    ...reviewerCredential,
    email_confirm: true,
  });
  if (reviewerCreated.error !== null || reviewerCreated.data.user === null) {
    throw new Error("Reviewer Auth fixture creation failed");
  }
  reviewerAuthUserId = reviewerCreated.data.user.id;

  adminUserId = (
    await database.query(
      `select user_id
       from private.user_identities
       where auth_user_id = $1 and revoked_at is null`,
      [adminAuthUserId],
    )
  ).rows[0]?.user_id;
  assert(adminUserId !== undefined, "Admin logical user binding was not created");

  reviewerUserId = (
    await database.query(
      `select user_id
       from private.user_identities
       where auth_user_id = $1 and revoked_at is null`,
      [reviewerAuthUserId],
    )
  ).rows[0]?.user_id;
  assert(reviewerUserId !== undefined, "Reviewer logical user binding was not created");
  const credentialCheck = await database.query(
    `select
       private.reviewer_auth_credential_is_valid($1) as valid,
       auth_user.deleted_at is null as active,
       auth_user.is_anonymous is false as non_anonymous,
       auth_user.is_sso_user is false as non_sso,
       auth_user.role as auth_role,
       auth_user.aud as auth_aud,
       coalesce(auth_user.is_super_admin, false) as is_super_admin,
       auth_user.banned_until,
       auth_user.instance_id::text as instance_id,
       auth_user.email_confirmed_at is not null as confirmed,
       auth_user.last_sign_in_at is null as never_signed_in,
       nullif(auth_user.encrypted_password, '') is not null as has_password,
       auth_user.raw_app_meta_data ->> 'provider' = 'email' as email_provider,
       auth_user.raw_app_meta_data -> 'providers' = '["email"]'::jsonb as email_only,
       auth_user.raw_app_meta_data =
         '{"provider":"email","providers":["email"]}'::jsonb as app_metadata_exact,
       auth_user.raw_user_meta_data = '{}'::jsonb as user_metadata_empty,
       (select array_agg(key_name order by key_name)
        from jsonb_object_keys(auth_user.raw_app_meta_data) as key_name) as app_metadata_keys,
       (select array_agg(key_name order by key_name)
        from jsonb_object_keys(auth_user.raw_user_meta_data) as key_name) as user_metadata_keys,
       auth_user.raw_user_meta_data ->> 'email_verified' as user_metadata_email_verified,
       (
         select count(*) from auth.identities as identity_row
         where identity_row.user_id = auth_user.id
       ) as identity_count,
       (
         select identity_row.provider = 'email'
         from auth.identities as identity_row where identity_row.user_id = auth_user.id
       ) as identity_email_provider,
       (
         select identity_row.provider_id = auth_user.id::text
         from auth.identities as identity_row where identity_row.user_id = auth_user.id
       ) as identity_provider_id_matches,
       (
         select identity_row.identity_data ->> 'sub' = auth_user.id::text
         from auth.identities as identity_row where identity_row.user_id = auth_user.id
       ) as identity_sub_matches,
       (
         select lower(identity_row.identity_data ->> 'email') = lower(auth_user.email)
         from auth.identities as identity_row where identity_row.user_id = auth_user.id
       ) as identity_email_matches,
       (
         select identity_row.identity_data -> 'email_verified' = 'true'::jsonb
         from auth.identities as identity_row where identity_row.user_id = auth_user.id
       ) as identity_email_verified,
       (
         select identity_row.identity_data ? 'email_verified'
         from auth.identities as identity_row where identity_row.user_id = auth_user.id
       ) as identity_has_verified_key,
       (
         select jsonb_typeof(identity_row.identity_data -> 'email_verified')
         from auth.identities as identity_row where identity_row.user_id = auth_user.id
       ) as identity_verified_type,
       (
         select identity_row.identity_data ->> 'email_verified'
         from auth.identities as identity_row where identity_row.user_id = auth_user.id
       ) as identity_verified_value,
       (
         select bool_and(
           identity_row.provider = 'email'
           and identity_row.provider_id = auth_user.id::text
           and identity_row.identity_data ->> 'sub' = auth_user.id::text
           and lower(identity_row.identity_data ->> 'email') = lower(auth_user.email)
           and identity_row.identity_data -> 'email_verified' = 'true'::jsonb
         )
         from auth.identities as identity_row
         where identity_row.user_id = auth_user.id
       ) as identity_exact
     from auth.users as auth_user
     where auth_user.id = $2`,
    [reviewerUserId, reviewerAuthUserId],
  );
  assert(
    credentialCheck.rows[0]?.valid,
    `Admin API reviewer credential invariant failed: ${JSON.stringify(credentialCheck.rows[0])}`,
  );
  assert(
    credentialCheck.rows[0]?.never_signed_in,
    `Admin API reviewer credential was signed in before provision: ${JSON.stringify(credentialCheck.rows[0])}`,
  );
  assert(
    credentialCheck.rows[0]?.auth_role === "authenticated"
      && credentialCheck.rows[0]?.auth_aud === "authenticated"
      && credentialCheck.rows[0]?.is_super_admin === false
      && credentialCheck.rows[0]?.banned_until === null,
    `Admin API reviewer authorization fields were not exact: ${JSON.stringify(credentialCheck.rows[0])}`,
  );
  assert(
    credentialCheck.rows[0]?.instance_id === "00000000-0000-0000-0000-000000000000",
    `Local GoTrue reviewer instance_id shape changed: ${JSON.stringify(credentialCheck.rows[0])}`,
  );
  await database.query(
    "insert into private.admin_members (auth_user_id) values ($1)",
    [adminAuthUserId],
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
    const fixture = await createLocalizedSpotCardFixture(database, {
      approvalAuthUserId: adminAuthUserId,
      cardCode: `reviewer-e2e-${suffix}-${index + 1}`,
      cardId: randomUUID(),
      cardTitle: `Reviewer E2E ${index + 1}`,
      colorHex: "#355F55",
      latitude: 37.50 + index * 0.001,
      longitude: 126.90 + index * 0.001,
      regionCode: `reviewer-e2e-${suffix}-${index + 1}`,
      sketchPath: `reviewer-e2e/${index + 1}.webp`,
      spotId: randomUUID(),
      spotName: `Reviewer E2E ${index + 1}`,
      spotSlug: slug,
    });
    contentFixtures.push(fixture);
  }
  policyFixture = await createPolicyFixture(database, { authUserIds: [] });

  const port = 57_000 + Math.floor(Math.random() * 900);
  const origin = `http://127.0.0.1:${port}`;
  server = spawn(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NEXT_PUBLIC_SUPABASE_URL: apiUrl,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: status.get("ANON_KEY"),
        SUPABASE_SERVICE_ROLE_KEY: status.get("SERVICE_ROLE_KEY"),
        AUTH_EMAIL_REDIRECT_TO: `${origin}/auth/callback`,
      },
      stdio: "ignore",
    },
  );
  await waitForServer(origin);

  const signIn = await anon.auth.signInWithPassword(adminCredential);
  if (signIn.error !== null || signIn.data.session === null) {
    throw new Error("Admin password sign-in fixture failed");
  }
  const authorization = `Bearer ${signIn.data.session.access_token}`;
  const action = () => randomUUID();
  const adminRateAttempts = async () => Number((
    await database.query(
      `select coalesce(cardinality(window_row.attempted_at), 0) as attempts
       from private.rate_limit_windows as window_row
       where window_row.user_id = $1
         and window_row.purpose = 'admin_mutation'`,
      [adminUserId],
    )
  ).rows[0]?.attempts ?? 0);

  const provisionRateBefore = await adminRateAttempts();
  const provision = await fetch(`${origin}/api/admin/reviewer-access`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({
      app_user_id: reviewerUserId,
      store_platform: "app_store",
      fixture_version: `e2e-${suffix}`,
      client_action_id: action(),
    }),
  });
  const provisionBody = await provision.json();
  assert(
    provision.status === 201,
    `reviewer provision failed with ${provision.status}: ${JSON.stringify(provisionBody)}`,
  );
  assert(provisionBody.reviewer_access?.retro_count === 6, "provision omitted six retros");
  assert(
    await adminRateAttempts() - provisionRateBefore === 1,
    "one provision HTTP attempt did not consume exactly one admin rate slot",
  );
  assert(
    !/password|example\.test|photo_path|share_slug/u.test(JSON.stringify(provisionBody)),
    "reviewer provision response exposed a credential or internal object path",
  );

  const resetRateBefore = await adminRateAttempts();
  const reset = await fetch(
    `${origin}/api/admin/reviewer-access/${reviewerUserId}/reset`,
    {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ client_action_id: action() }),
    },
  );
  const resetBody = await reset.json();
  assert(reset.status === 200, `reviewer reset failed with ${reset.status}`);
  assert(
    await adminRateAttempts() - resetRateBefore === 1,
    "one reset HTTP attempt did not consume exactly one admin rate slot",
  );
  assert(
    resetBody.reviewer_access?.fixture_hash === provisionBody.reviewer_access.fixture_hash,
    "reset changed deterministic fixture hash",
  );

  const revokeRateBefore = await adminRateAttempts();
  const revoke = await fetch(`${origin}/api/admin/reviewer-access/${reviewerUserId}`, {
    method: "DELETE",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ client_action_id: action() }),
  });
  assert(revoke.status === 200, `reviewer revoke failed with ${revoke.status}`);
  assert(
    await adminRateAttempts() - revokeRateBefore === 1,
    "one revoke HTTP attempt did not consume exactly one admin rate slot",
  );

  const reviewerSignIn = await anon.auth.signInWithPassword(reviewerCredential);
  if (reviewerSignIn.error !== null || reviewerSignIn.data.session === null) {
    throw new Error("Reviewer password sign-in canary failed");
  }
  const reviewerClaims = jwtPayload(reviewerSignIn.data.session.access_token);
  assert(
    reviewerSignIn.data.user?.role === "authenticated"
      && reviewerClaims.role === "authenticated"
      && reviewerClaims.aud === "authenticated",
    `Reviewer password session minted unexpected authorization claims: ${JSON.stringify({
      userRole: reviewerSignIn.data.user?.role,
      jwtRole: reviewerClaims.role,
      jwtAud: reviewerClaims.aud,
    })}`,
  );
  const projection = await fetch(`${origin}/api/me/access`, {
    headers: { authorization: `Bearer ${reviewerSignIn.data.session.access_token}` },
  });
  assert(projection.status === 401, "revoked reviewer token retained protected API access");

  const reviewerDeleted = await service.auth.admin.deleteUser(reviewerAuthUserId, false);
  assert(
    reviewerDeleted.error === null,
    "revoked reviewer Auth hard deletion failed",
  );
  reviewerAuthUserId = undefined;

  console.log("Reviewer access HTTP E2E: provision/reset/revoke/Auth delete passed");
} finally {
  if (server !== undefined) {
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
  }
  if (reviewerUserId !== undefined) {
    await database.query("delete from public.app_users where id = $1", [reviewerUserId])
      .catch(() => undefined);
  }
  if (adminAuthUserId !== undefined) {
    const adminUserId = (
      await database.query(
        "select user_id from private.user_identities where auth_user_id = $1 limit 1",
        [adminAuthUserId],
      ).catch(() => ({ rows: [] }))
    ).rows[0]?.user_id;
    if (adminUserId !== undefined) {
      await database.query("delete from public.app_users where id = $1", [adminUserId])
        .catch(() => undefined);
    }
  }
  if (policyFixture !== undefined) {
    await retirePolicyFixture(database, policyFixture).catch(() => undefined);
  }
  for (const fixture of contentFixtures.reverse()) {
    await retireLocalizedSpotCardFixture(database, fixture).catch(() => undefined);
  }
  for (const authUserId of [reviewerAuthUserId, adminAuthUserId]) {
    if (authUserId !== undefined) {
      await service.auth.admin.deleteUser(authUserId, false).catch(() => undefined);
    }
  }
  await database.end();
}
