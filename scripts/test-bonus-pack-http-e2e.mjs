import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";

import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  createLocalizedSpotCardFixture,
} from "./lib/localized-fixture.mjs";
import {
  createPolicyFixture,
  retirePolicyFixture,
} from "./lib/policy-fixture.mjs";

const { Client } = pg;
const appPort = Number.parseInt(
  process.env.DANYEODAM_BONUS_PACK_E2E_PORT ?? "31122",
  10,
);
assertPort(appPort);
const appUrl = `http://127.0.0.1:${appPort}`;
const requestTimeoutMs = 15_000;
const syntheticCommonAsset = Buffer.from(
  "synthetic-common-webp-bonus-http-e2e",
  "utf8",
);
const syntheticSpecialAsset = Buffer.from(
  "synthetic-special-webp-bonus-http-e2e",
  "utf8",
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("DANYEODAM_BONUS_PACK_E2E_PORT must be a valid TCP port");
  }
}

function readLocalSupabaseEnvironment() {
  assert(
    process.env.DANYEODAM_BONUS_PACK_E2E_ALLOW_DISPOSABLE === "true",
    "bonus-pack HTTP E2E publishes immutable synthetic pool, policy, card, and Storage fixtures; set DANYEODAM_BONUS_PACK_E2E_ALLOW_DISPOSABLE=true only for a disposable stack, and the caller must run `corepack npm run db:stop` afterward",
  );
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
    assert(
      typeof environment[key] === "string" && environment[key].length > 0,
      `${key} missing`,
    );
  }
  const apiUrl = new URL(environment.API_URL);
  const databaseUrl = new URL(environment.DB_URL);
  assert(
    ["127.0.0.1", "localhost"].includes(apiUrl.hostname)
      && ["127.0.0.1", "localhost"].includes(databaseUrl.hostname),
    "bonus-pack HTTP E2E requires a disposable loopback Supabase stack",
  );
  const ports = [Number(apiUrl.port), Number(databaseUrl.port)];
  const isolated563xx = ports.length === 2 && ports.every(
    (port) => port >= 56_300 && port <= 56_399,
  );
  assert(
    isolated563xx,
    "bonus-pack HTTP E2E requires both API and DB on isolated 563xx ports; 553xx is always refused",
  );
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
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (hasExited(server)) {
      throw new Error(`Next.js exited before readiness\n${readOutput()}`);
    }
    try {
      const response = await fetch(`${appUrl}/api/me/bonus-packs`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 401) return;
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
  if (!hasExited(server)) {
    throw new Error("Next.js did not stop after SIGTERM and SIGKILL");
  }
}

async function captureCleanupError(errors, label, operation) {
  try {
    await operation();
  } catch (error) {
    errors.push(new Error(`Bonus pack HTTP E2E cleanup failed: ${label}`, {
      cause: error,
    }));
  }
}

async function restorePolicyCurrentState(database, fixture) {
  if (fixture.previousDocumentIds.length === 4) {
    await retirePolicyFixture(database, fixture);
  } else if (fixture.previousDocumentIds.length === 0) {
    await database.query("begin");
    try {
      await database.query(
        `select pg_advisory_xact_lock(hashtextextended(
           'danyeodam:policy-current-set', 0
         ))`,
      );
      await database.query(
        "select set_config('danyeodam.policy_current_switch_context', 'enabled', true)",
      );
      await database.query(
        `update private.policy_documents
         set is_current = false
         where id = any($1::uuid[]) and is_current`,
        [fixture.documentIds],
      );
      await database.query(
        "select set_config('danyeodam.policy_current_switch_context', 'disabled', true)",
      );
      await database.query("commit");
    } catch (error) {
      await database.query("rollback").catch((rollbackError) => {
        throw new AggregateError(
          [error, rollbackError],
          "Policy current-state cleanup and rollback both failed",
        );
      });
      throw error;
    }
  } else {
    throw new Error(
      `Cannot restore incomplete previous current policy set (${fixture.previousDocumentIds.length})`,
    );
  }

  const current = await database.query(
    `select id
     from private.policy_documents
     where is_current
     order by id`,
  );
  assert(
    JSON.stringify(current.rows.map((row) => row.id))
      === JSON.stringify(fixture.previousDocumentIds),
    "previous current policy state was not restored exactly",
  );
}

async function fetchWithTimeout(input, init = {}) {
  return fetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(requestTimeoutMs),
  });
}

async function requestJson(path, init = {}) {
  const response = await fetchWithTimeout(`${appUrl}${path}`, init);
  const text = await response.text();
  return {
    response,
    payload: text === "" ? undefined : JSON.parse(text),
  };
}

async function assertStorageDenied(response, message) {
  assert(
    [400, 401, 403, 404].includes(response.status),
    `${message}: ${response.status}`,
  );
  const contentType = response.headers.get("content-type") ?? "";
  assert(!contentType.startsWith("image/"), `${message}: returned image content`);
  assert(response.headers.get("location") === null, `${message}: redirected`);
  const body = Buffer.from(await response.arrayBuffer());
  assert(!body.equals(syntheticSpecialAsset), `${message}: returned special bytes`);

  if (response.status === 400) {
    assert(
      contentType.toLowerCase().includes("json"),
      `${message}: 400 response was not a JSON error`,
    );
    let payload;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch (error) {
      throw new Error(`${message}: 400 response contained invalid JSON`, {
        cause: error,
      });
    }
    assert(
      payload !== null && typeof payload === "object" && !Array.isArray(payload),
      `${message}: 400 response was not an error object`,
    );
    const descriptor = Object.values(payload)
      .filter((value) => typeof value === "string" || typeof value === "number")
      .join(" ")
      .toLowerCase();
    assert(
      /bad.?request|not.?found|unauthori[sz]ed|forbidden|denied|invalid|missing|no.?such/u
        .test(descriptor),
      `${message}: 400 JSON did not identify a safe denial error`,
    );
    assert(
      !Object.hasOwn(payload, "data")
        && !Object.hasOwn(payload, "signedURL")
        && !Object.hasOwn(payload, "signedUrl")
        && !Object.hasOwn(payload, "url"),
      `${message}: 400 JSON included an object access payload`,
    );
  }
}

const forbiddenPublicKeys = new Set([
  "accuracy_threshold_m",
  "asset_path",
  "bucket",
  "bucket_id",
  "common_rate_basis_points",
  "field_sequence",
  "guarantee_after_commons",
  "guarantee_applied",
  "issued_on_kst",
  "object_path",
  "odds",
  "pool_id",
  "pool_version_id",
  "probability",
  "random_value",
  "rarity_roll",
  "result",
  "result_card_id",
  "result_rarity",
  "selection_roll",
  "sketch_path",
  "storage_path",
  "threshold",
]);

function normalizePublicKey(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
}

function isForbiddenPublicKey(key) {
  const normalized = normalizePublicKey(key);
  return forbiddenPublicKeys.has(normalized)
    || normalized.includes("threshold")
    || normalized.includes("probability")
    || normalized === "roll"
    || normalized.endsWith("_roll")
    || normalized === "odds"
    || normalized.endsWith("_odds");
}

function assertNoInternalPublicFields(value, context) {
  if (Array.isArray(value)) {
    for (const item of value) assertNoInternalPublicFields(item, context);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    assert(
      !isForbiddenPublicKey(key),
      `${context} leaked internal public field ${key}`,
    );
    assertNoInternalPublicFields(nested, context);
  }
}

function assertSerializedValueAbsent(value, forbidden, context) {
  const serialized = JSON.stringify(value);
  assert(
    typeof serialized === "string" && !serialized.includes(forbidden),
    `${context} leaked synthetic special result data`,
  );
}

function assertSealedProjection(pack, context) {
  assert(pack?.status === "sealed", `${context} did not return a sealed pack`);
  const keys = Object.keys(pack).sort();
  assert(
    JSON.stringify(keys)
      === JSON.stringify(["date_kst", "id", "issued_at", "status"]),
    `${context} returned fields outside the sealed public projection: ${keys.join(",")}`,
  );
  assert(
    typeof pack.id === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(pack.id),
    `${context} returned an invalid sealed pack id`,
  );
  assert(
    typeof pack.issued_at === "string"
      && Number.isFinite(Date.parse(pack.issued_at)),
    `${context} returned an invalid sealed issued_at`,
  );
  const dateKst = typeof pack.date_kst === "string" ? pack.date_kst : "";
  const parsedDateKst = new Date(`${dateKst}T00:00:00.000Z`);
  assert(
    /^\d{4}-\d{2}-\d{2}$/u.test(dateKst)
      && Number.isFinite(parsedDateKst.getTime())
      && parsedDateKst.toISOString().slice(0, 10) === dateKst,
    `${context} returned an invalid sealed date_kst`,
  );
  for (const forbidden of [
    "card",
    "rarity",
    "result",
    "guarantee_applied",
    "rarity_roll",
    "selection_roll",
  ]) {
    assert(
      !Object.hasOwn(pack, forbidden),
      `${context} leaked sealed field ${forbidden}`,
    );
  }
}

async function createHistoricalCommonStreak(database, input) {
  await database.query("begin");
  try {
    for (let offset = 4; offset >= 1; offset -= 1) {
      const acquisitionId = randomUUID();
      const attemptKey = randomUUID();
      const packId = randomUUID();
      const sequence = 5 - offset;
      await database.query(
        `insert into private.location_use_facts (
           user_id, idempotency_key, spot_id, purpose, collected_at,
           outcome, terminal_failure_details
         ) values (
           $1, $2, $3, 'field_acquisition',
           (((clock_timestamp() at time zone 'Asia/Seoul')::date - $4::integer)::timestamp
             + interval '12 hours') at time zone 'Asia/Seoul',
           'pending', '{}'::jsonb
         )`,
        [input.userId, attemptKey, input.spotId, offset],
      );
      await database.query(
        `insert into public.acquisitions (
           id, user_id, spot_id, card_id, acquisition_type,
           verification_result, idempotency_key, field_sequence, acquired_at
         )
         select $1, $2, $3, $4, 'field', 'passed', $5, $6,
                fact_row.collected_at
         from private.location_use_facts as fact_row
         where fact_row.user_id = $2 and fact_row.idempotency_key = $5`,
        [
          acquisitionId,
          input.userId,
          input.spotId,
          input.commonCardId,
          attemptKey,
          sequence,
        ],
      );
      await database.query(
        `insert into private.bonus_packs (
           id, user_id, issuance_kind, issued_on_kst, pool_version_id,
           result_card_id, result_rarity, rarity_roll, selection_roll,
           guarantee_applied, state, issued_at
         ) values (
           $1, $2, 'field_daily',
           (clock_timestamp() at time zone 'Asia/Seoul')::date - $3::integer,
           $4, $5, 'common', 0, 0, false, 'sealed',
           ((((clock_timestamp() at time zone 'Asia/Seoul')::date - $3::integer)::timestamp
             + interval '12 hours') at time zone 'Asia/Seoul')
         )`,
        [packId, input.userId, offset, input.poolId, input.commonCardId],
      );
      await database.query(
        `insert into private.bonus_pack_qualifiers (
           pack_id, acquisition_id, user_id, is_issuing_qualifier
         ) values ($1, $2, $3, true)`,
        [packId, acquisitionId, input.userId],
      );
    }
    await database.query(
      `insert into private.card_counters (card_id, last_sequence)
       values ($1, 4)
       on conflict (card_id) do update
       set last_sequence = excluded.last_sequence`,
      [input.commonCardId],
    );
    await database.query("commit");
  } catch (error) {
    await database.query("rollback");
    throw error;
  }
}

const local = readLocalSupabaseEnvironment();
const database = new Client({ connectionString: local.DB_URL });
const serviceClient = createAuthClient(local.API_URL, local.SERVICE_ROLE_KEY);
const ownerClient = createAuthClient(local.API_URL, local.ANON_KEY);
const otherClient = createAuthClient(local.API_URL, local.ANON_KEY);

let databaseConnected = false;
let server;
let serverOutput = "";
let policyFixture;
let testError;
let testCompleted = false;
const authUserIds = [];
const appUserIds = [];

try {
  await database.connect();
  databaseConnected = true;
  await database.query("set statement_timeout = '10s'");

  const ownerAuth = await ownerClient.auth.signInAnonymously();
  assert(
    ownerAuth.error === null && ownerAuth.data.session !== null,
    "synthetic owner Auth sign-in failed",
  );
  const ownerAuthUserId = ownerAuth.data.user?.id;
  assert(ownerAuthUserId !== undefined, "synthetic owner Auth user missing");
  authUserIds.push(ownerAuthUserId);

  const otherAuth = await otherClient.auth.signInAnonymously();
  assert(
    otherAuth.error === null && otherAuth.data.session !== null,
    "synthetic non-owner Auth sign-in failed",
  );
  const otherAuthUserId = otherAuth.data.user?.id;
  assert(otherAuthUserId !== undefined, "synthetic non-owner Auth user missing");
  authUserIds.push(otherAuthUserId);

  const identities = await database.query(
    `select auth_user_id, user_id
     from private.user_identities
     where auth_user_id = any($1::uuid[]) and revoked_at is null`,
    [[ownerAuthUserId, otherAuthUserId]],
  );
  const ownerUserId = identities.rows.find(
    (row) => row.auth_user_id === ownerAuthUserId,
  )?.user_id;
  const otherUserId = identities.rows.find(
    (row) => row.auth_user_id === otherAuthUserId,
  )?.user_id;
  assert(
    ownerUserId !== undefined && otherUserId !== undefined,
    "synthetic logical user bindings missing",
  );
  appUserIds.push(ownerUserId, otherUserId);

  policyFixture = await createPolicyFixture(database, {
    authUserIds: [ownerAuthUserId, otherAuthUserId],
  });

  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const regionCode = `bonus-http-${suffix}`;
  const commonPath = `bonus-http/${suffix}/common.webp`;
  const specialPath = `bonus-http/${suffix}/special.webp`;
  const common = await createLocalizedSpotCardFixture(database, {
    approvalAuthUserId: ownerAuthUserId,
    cardCode: `bonus-http-common-${suffix}`,
    cardTitle: "Synthetic Common",
    colorHex: "#445566",
    latitude: 37.5,
    longitude: 127,
    regionCode,
    regionName: "Synthetic Bonus Region",
    sketchPath: commonPath,
    spotName: "Synthetic Bonus Spot",
    spotSlug: `bonus-http-${suffix}`,
  });
  const commonUpload = await serviceClient.storage
    .from("card-assets")
    .upload(commonPath, syntheticCommonAsset, {
      contentType: "image/webp",
      upsert: false,
    });
  assert(commonUpload.error === null, "synthetic common asset upload failed");

  const specialCardId = randomUUID();
  await database.query(
    `insert into public.cards (
       id, spot_id, code, kind, title_ko, title_en, sketch_path,
       color_hex, is_published, published_at
     ) values (
       $1, $2, $3, 'special', '합성 특별', 'Synthetic Special', $4,
       '#AA8844', false, null
     )`,
    [specialCardId, common.spotId, `bonus-http-special-${suffix}`, specialPath],
  );
  await database.query(
    `insert into public.card_translations (
       card_id, locale, title, status, approved_at, approved_by
     )
     select $1, locale_row.locale,
            'Synthetic Special ' || locale_row.locale::text,
            'approved', now(), $2
     from unnest(enum_range(null::public.content_locale)) as locale_row(locale)`,
    [specialCardId, ownerAuthUserId],
  );
  const specialUpload = await serviceClient.storage
    .from("special-card-assets")
    .upload(specialPath, syntheticSpecialAsset, {
      contentType: "image/webp",
      upsert: false,
    });
  assert(specialUpload.error === null, "synthetic special asset upload failed");
  await database.query(
    `update public.cards
     set is_published = true, published_at = clock_timestamp()
     where id = $1`,
    [specialCardId],
  );

  // Published pools, their card snapshots, special Storage objects, and policy
  // publications are immutable audit fixtures. The possible cleanup below
  // restores current policy selection and removes users, but only destroying
  // this acknowledged disposable stack removes every synthetic residue.
  const poolId = randomUUID();
  await database.query(
    `insert into private.bonus_pack_pool_versions (
       id, region_code, version_code
     ) values ($1, $2, $3)`,
    [poolId, regionCode, `http-${suffix}`],
  );
  await database.query(
    `insert into private.bonus_pack_pool_cards (
       pool_version_id, card_id, rarity, sort_order
     ) values
       ($1, $2, 'common', 1),
       ($1, $3, 'special', 1)`,
    [poolId, common.cardId, specialCardId],
  );
  await database.query(
    `update private.bonus_pack_pool_versions
     set published_at = clock_timestamp()
     where id = $1`,
    [poolId],
  );
  await createHistoricalCommonStreak(database, {
    userId: ownerUserId,
    spotId: common.spotId,
    commonCardId: common.cardId,
    poolId,
  });

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
      PUBLIC_RECRUIT_GATE: "true",
      PUBLIC_SHARE_CREATION: "false",
      PUBLIC_SHARE_PUBLICATION: "false",
      BONUS_PACK_ISSUANCE_SCOPE: "public",
      BONUS_PACK_CURSOR_SECRET: "bonus-pack-http-e2e-cursor-secret-value-0001",
      COLLECTION_CURSOR_SECRET: "bonus-pack-http-e2e-collection-secret-0001",
      LOCATION_COMPLIANCE_CURSOR_SECRET:
        "bonus-pack-http-e2e-location-secret-value-0001",
      ABUSE_HMAC_SECRET: "bonus-pack-http-e2e-abuse-secret-value-0001",
      AUTH_EMAIL_REDIRECT_TO: `${appUrl}/auth/callback`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const appendServerOutput = (chunk) => {
    serverOutput = `${serverOutput}${chunk.toString("utf8")}`.slice(-16_384);
  };
  server.stdout?.on("data", appendServerOutput);
  server.stderr?.on("data", appendServerOutput);
  await waitForApplication(server, () => serverOutput);

  const ownerAuthorization = `Bearer ${ownerAuth.data.session.access_token}`;
  const otherAuthorization = `Bearer ${otherAuth.data.session.access_token}`;
  const acquireKey = randomUUID();
  const acquireBody = JSON.stringify({
    spot_id: common.spotId,
    lat: 37.5,
    lng: 127,
    accuracy: 5,
    idempotency_key: acquireKey,
  });
  const acquire = await requestJson("/api/acquire", {
    method: "POST",
    headers: {
      authorization: ownerAuthorization,
      "content-type": "application/json",
    },
    body: acquireBody,
  });
  assert(
    acquire.response.status === 201,
    `bonus-pack acquire failed (${acquire.response.status})`,
  );
  const pack = acquire.payload?.bonus_pack;
  assert(typeof pack?.id === "string", "acquire omitted the sealed pack ID");
  assertSealedProjection(pack, "acquire");
  assertNoInternalPublicFields(acquire.payload, "acquire");
  assertSerializedValueAbsent(acquire.payload, specialCardId, "acquire");
  assertSerializedValueAbsent(acquire.payload, specialPath, "acquire");

  const acquireReplay = await requestJson("/api/acquire", {
    method: "POST",
    headers: {
      authorization: ownerAuthorization,
      "content-type": "application/json",
    },
    body: acquireBody,
  });
  assert(acquireReplay.response.status === 200, "acquire replay did not return 200");
  assert(
    acquireReplay.payload?.bonus_pack?.id === pack.id,
    "acquire replay changed the pack ID",
  );
  assertSealedProjection(acquireReplay.payload.bonus_pack, "acquire replay");
  assertNoInternalPublicFields(acquireReplay.payload, "acquire replay");
  assertSerializedValueAbsent(
    acquireReplay.payload,
    specialCardId,
    "acquire replay",
  );
  assertSerializedValueAbsent(acquireReplay.payload, specialPath, "acquire replay");

  const sealedList = await requestJson("/api/me/bonus-packs?limit=1", {
    headers: { authorization: ownerAuthorization },
  });
  assert(sealedList.response.status === 200, "sealed pack list did not return 200");
  assert(sealedList.payload?.items?.[0]?.id === pack.id, "sealed list omitted newest pack");
  assertSealedProjection(sealedList.payload.items[0], "sealed list");
  assert(sealedList.payload.sealed_count === 5, "account-wide sealed count is not five");
  assertNoInternalPublicFields(sealedList.payload, "sealed list");
  assertSerializedValueAbsent(sealedList.payload, specialCardId, "sealed list");
  assertSerializedValueAbsent(sealedList.payload, specialPath, "sealed list");

  const sealedDetail = await requestJson(`/api/me/bonus-packs/${pack.id}`, {
    headers: { authorization: ownerAuthorization },
  });
  assert(sealedDetail.response.status === 200, "sealed detail did not return 200");
  assertSealedProjection(sealedDetail.payload?.bonus_pack, "sealed detail");
  assertNoInternalPublicFields(sealedDetail.payload, "sealed detail");
  assertSerializedValueAbsent(sealedDetail.payload, specialCardId, "sealed detail");
  assertSerializedValueAbsent(sealedDetail.payload, specialPath, "sealed detail");

  const inventoryBefore = await requestJson("/api/me/card-inventory?limit=100", {
    headers: { authorization: ownerAuthorization },
  });
  assert(inventoryBefore.response.status === 200, "pre-open inventory failed");
  assertNoInternalPublicFields(inventoryBefore.payload, "pre-open inventory");
  assertSerializedValueAbsent(
    inventoryBefore.payload,
    specialCardId,
    "pre-open inventory",
  );
  assertSerializedValueAbsent(
    inventoryBefore.payload,
    specialPath,
    "pre-open inventory",
  );
  assert(
    !inventoryBefore.payload.items.some((item) => item.card.id === specialCardId),
    "sealed special appeared in inventory",
  );
  const commonBefore = inventoryBefore.payload.items.find(
    (item) => item.card.id === common.cardId,
  );
  assert(commonBefore?.quantity === 5, "pre-open common quantity is not five");

  const ownerAssetBefore = await fetchWithTimeout(
    `${appUrl}/api/me/special-card-assets/${specialCardId}`,
    { headers: { authorization: ownerAuthorization } },
  );
  assert(ownerAssetBefore.status === 404, "sealed owner accessed special art");
  const publicCardAsset = await fetchWithTimeout(
    `${appUrl}/api/card-assets/${specialCardId}`,
  );
  assert(publicCardAsset.status === 404, "special art leaked through public card route");
  const publicStorage = await fetchWithTimeout(
    `${local.API_URL}/storage/v1/object/public/special-card-assets/${specialPath}`,
    { headers: { apikey: local.ANON_KEY } },
  );
  await assertStorageDenied(
    publicStorage,
    "public Storage special read was not denied",
  );
  const directStorageBefore = await fetchWithTimeout(
    `${local.API_URL}/storage/v1/object/authenticated/special-card-assets/${specialPath}`,
    {
      headers: {
        apikey: local.ANON_KEY,
        authorization: ownerAuthorization,
      },
    },
  );
  await assertStorageDenied(
    directStorageBefore,
    "authenticated sealed Storage read was not denied",
  );

  const openRequestId = randomUUID();
  const opened = await requestJson(`/api/me/bonus-packs/${pack.id}/open`, {
    method: "POST",
    headers: {
      authorization: ownerAuthorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({ client_request_id: openRequestId }),
  });
  assert(opened.response.status === 200, "bonus pack open did not return 200");
  const openedPack = opened.payload?.bonus_pack;
  assert(openedPack?.status === "opened", "pack did not enter opened state");
  assertNoInternalPublicFields(opened.payload, "opened pack");
  assertSerializedValueAbsent(opened.payload, specialPath, "opened pack");
  assert(
    openedPack.card?.id === specialCardId
      && openedPack.card.rarity === "special",
    "guaranteed fifth pack did not reveal the synthetic special",
  );
  assert(
    openedPack.card.image_url
      === `/api/me/special-card-assets/${specialCardId}`,
    "special projection did not use the protected asset route",
  );
  for (const forbidden of [
    "guarantee_applied",
    "rarity_roll",
    "selection_roll",
  ]) {
    assert(
      !Object.hasOwn(openedPack, forbidden),
      `opened response leaked ${forbidden}`,
    );
  }

  const openReplay = await requestJson(`/api/me/bonus-packs/${pack.id}/open`, {
    method: "POST",
    headers: {
      authorization: ownerAuthorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({ client_request_id: openRequestId }),
  });
  assert(openReplay.response.status === 200, "same open request did not replay");
  assert(
    JSON.stringify(openReplay.payload?.bonus_pack) === JSON.stringify(openedPack),
    "same open request changed the reveal projection",
  );
  assertNoInternalPublicFields(openReplay.payload, "open replay");
  assertSerializedValueAbsent(openReplay.payload, specialPath, "open replay");
  const openNewRequest = await requestJson(
    `/api/me/bonus-packs/${pack.id}/open`,
    {
      method: "POST",
      headers: {
        authorization: ownerAuthorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ client_request_id: randomUUID() }),
    },
  );
  assert(openNewRequest.response.status === 200, "opened pack rejected a new request ID");
  assert(
    openNewRequest.payload?.bonus_pack?.card?.id === specialCardId,
    "new open request changed the fixed result",
  );
  assertNoInternalPublicFields(openNewRequest.payload, "new open request");
  assertSerializedValueAbsent(
    openNewRequest.payload,
    specialPath,
    "new open request",
  );

  const inventoryAfter = await requestJson("/api/me/card-inventory?limit=100", {
    headers: { authorization: ownerAuthorization },
  });
  assert(inventoryAfter.response.status === 200, "post-open inventory failed");
  assertNoInternalPublicFields(inventoryAfter.payload, "post-open inventory");
  assertSerializedValueAbsent(
    inventoryAfter.payload,
    specialPath,
    "post-open inventory",
  );
  const specialAfter = inventoryAfter.payload.items.find(
    (item) => item.card.id === specialCardId,
  );
  const commonAfter = inventoryAfter.payload.items.find(
    (item) => item.card.id === common.cardId,
  );
  assert(
    specialAfter?.quantity === 1 && specialAfter.card.rarity === "special",
    "opened special did not enter quantity inventory",
  );
  assert(commonAfter?.quantity === 5, "bonus result inflated common field quantity");

  const ownerAsset = await fetchWithTimeout(
    `${appUrl}${openedPack.card.image_url}`,
    { headers: { authorization: ownerAuthorization } },
  );
  const ownerAssetBytes = Buffer.from(await ownerAsset.arrayBuffer());
  assert(ownerAsset.status === 200, "opened owner could not fetch special art");
  assert(
    ownerAsset.headers.get("cache-control") === "private, no-store",
    "special art cache policy is not private, no-store",
  );
  assert(
    ownerAsset.headers.get("content-type") === "image/webp",
    "special art content type is not image/webp",
  );
  assert(
    ownerAsset.headers.get("x-content-type-options") === "nosniff",
    "special art response omitted nosniff",
  );
  assert(ownerAsset.headers.get("location") === null, "special art redirected to Storage");
  assert(
    ownerAssetBytes.equals(syntheticSpecialAsset),
    "special art bytes differ from the synthetic fixture",
  );

  const otherAsset = await fetchWithTimeout(
    `${appUrl}${openedPack.card.image_url}`,
    { headers: { authorization: otherAuthorization } },
  );
  assert(otherAsset.status === 404, "non-owner accessed opened special art");
  const unauthenticatedAsset = await fetchWithTimeout(
    `${appUrl}${openedPack.card.image_url}`,
  );
  assert(unauthenticatedAsset.status === 401, "unauthenticated special art was not 401");
  const directStorageAfter = await fetchWithTimeout(
    `${local.API_URL}/storage/v1/object/authenticated/special-card-assets/${specialPath}`,
    {
      headers: {
        apikey: local.ANON_KEY,
        authorization: ownerAuthorization,
      },
    },
  );
  await assertStorageDenied(
    directStorageAfter,
    "authenticated opened Storage read was not denied",
  );
  const otherDetail = await requestJson(`/api/me/bonus-packs/${pack.id}`, {
    headers: { authorization: otherAuthorization },
  });
  assert(otherDetail.response.status === 404, "non-owner pack detail was not hidden");

  const invariant = await database.query(
    `select
       pack_row.guarantee_applied,
       pack_row.result_rarity,
       pack_row.state,
       (
         select count(*)::integer
         from private.bonus_pack_open_requests
         where pack_id = pack_row.id
       ) as open_requests,
       (
         select count(*)::integer
         from public.acquisitions
         where user_id = $2 and acquisition_type = 'field'
       ) as field_count
     from private.bonus_packs as pack_row
     where pack_row.id = $1`,
    [pack.id, ownerUserId],
  );
  const state = invariant.rows[0];
  assert(
    state?.guarantee_applied
      && state.result_rarity === "special"
      && state.state === "opened",
    "stored bonus-pack result invariant mismatch",
  );
  assert(state.open_requests === 1, "open idempotency ledger grew beyond one row");
  assert(state.field_count === 5, "bonus pack inflated the field acquisition ledger");

  const openedList = await requestJson("/api/me/bonus-packs?limit=1", {
    headers: { authorization: ownerAuthorization },
  });
  assert(
    openedList.response.status === 200
      && openedList.payload?.items?.[0]?.status === "opened",
    "opened pack list projection missing",
  );
  assertNoInternalPublicFields(openedList.payload, "opened pack list");
  assertSerializedValueAbsent(openedList.payload, specialPath, "opened pack list");
  assert(openedList.payload.sealed_count === 4, "sealed count did not decrement to four");

  testCompleted = true;
} catch (error) {
  testError = error;
  if (serverOutput !== "") {
    console.error(`Next.js output before failure:\n${serverOutput}`);
  }
} finally {
  const cleanupErrors = [];
  await captureCleanupError(
    cleanupErrors,
    "stop Next.js",
    async () => stopApplication(server),
  );

  if (databaseConnected && policyFixture !== undefined) {
    await captureCleanupError(
      cleanupErrors,
      "restore previous current policy documents",
      async () => restorePolicyCurrentState(database, policyFixture),
    );
  }
  if (databaseConnected && appUserIds.length > 0) {
    await captureCleanupError(cleanupErrors, "delete app users", async () => {
      await database.query(
        `delete from public.app_users where id = any($1::uuid[])`,
        [appUserIds],
      );
    });
  }
  if (databaseConnected && authUserIds.length > 0) {
    await captureCleanupError(cleanupErrors, "delete Auth users", async () => {
      await database.query(
        `delete from auth.users where id = any($1::uuid[])`,
        [authUserIds],
      );
    });
  }
  if (databaseConnected) {
    await captureCleanupError(cleanupErrors, "close database client", async () => {
      await database.end();
    });
  }

  const errors = [
    ...(testError === undefined ? [] : [testError]),
    ...cleanupErrors,
  ];
  if (!testCompleted && testError === undefined) {
    errors.unshift(new Error("bonus-pack HTTP E2E ended without a result"));
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      testError !== undefined
        ? "Bonus pack HTTP E2E failed; cleanup results are attached"
        : cleanupErrors.length > 0
          ? "Bonus pack HTTP E2E cleanup failed"
          : "Bonus pack HTTP E2E ended without a result",
    );
  }
  console.log(
    "Bonus pack HTTP E2E passed; immutable synthetic pool, policy, card, and Storage residues remain by design, so the caller must run `corepack npm run db:stop`",
  );
}
