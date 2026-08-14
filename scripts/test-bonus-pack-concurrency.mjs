import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";

import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const { Client } = pg;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readLocalEnvironment() {
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

const local = readLocalEnvironment();

async function connect() {
  const client = new Client({ connectionString: local.DB_URL });
  await client.connect();
  await client.query("set statement_timeout = '12s'");
  return client;
}

async function waitForBlock(observer, blockedPid, blockerPid, label) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await observer.query(
      "select $2::integer = any(pg_blocking_pids($1)) as blocked",
      [blockedPid, blockerPid],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} did not reach the expected lock wait`);
}

function capture(promise) {
  return promise.then(
    (result) => ({ result, error: undefined }),
    (error) => ({ result: undefined, error }),
  );
}

const admin = await connect();
const first = await connect();
const second = await connect();
const observer = await connect();
const third = await connect();
const fourth = await connect();
const fifth = await connect();
const anonymousStorage = createClient(local.API_URL, local.ANON_KEY, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
});
const serviceStorage = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
});

const authUserId = randomUUID();
let appUserId;
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const baseRegion = `bonus-concurrency-${suffix}`;
const publishRegion = `bonus-publish-${suffix}`;
const baseSpotId = randomUUID();
const publishSpotId = randomUUID();
const kindRaceSpotId = randomUUID();
const reverseKindRaceSpotId = randomUUID();
const ordinaryRaceSpotId = randomUUID();
const commonCardId = randomUUID();
const specialCardId = randomUUID();
const publicRaceSpecialId = randomUUID();
const reverseRaceSpecialId = randomUUID();
const ordinaryRaceCardId = randomUUID();
const publishCommonCardId = randomUUID();
const publishSpecialCardId = randomUUID();
const kindRaceCardId = randomUUID();
const reverseKindRaceCardId = randomUUID();
const basePoolId = randomUUID();
const publishPoolId = randomUUID();
const historyAcquisitionIds = Array.from({ length: 4 }, () => randomUUID());
const historyPackIds = Array.from({ length: 4 }, () => randomUUID());
const midnightAcquisitionIds = [randomUUID(), randomUUID()];
const correctionAcquisitionIds = [randomUUID(), randomUUID()];
const v05AcquisitionKeys = [randomUUID(), randomUUID()];
const locationPolicyId = randomUUID();
const locationPolicyVersion = `bonus-concurrency-${suffix}`;
let createdLocationPolicy = false;
const privatePaths = {
  base: `bonus-concurrency/${suffix}/base-special.webp`,
  publicRace: `bonus-concurrency/${suffix}/public-race.webp`,
  reverseRace: `bonus-concurrency/${suffix}/reverse-race.webp`,
  ordinaryRace: `bonus-concurrency/${suffix}/ordinary-race.webp`,
  publish: `bonus-concurrency/${suffix}/publish-special.webp`,
  kindRace: `bonus-concurrency/${suffix}/kind-race-special.webp`,
  reverseKindRace: `bonus-concurrency/${suffix}/reverse-kind-race-special.webp`,
};
const reversePoolFixtures = ["entry", "card", "translation", "spot"].map((kind, index) => ({
  kind,
  region: `bonus-reverse-${kind}-${suffix}`,
  spotId: randomUUID(),
  commonCardId: randomUUID(),
  specialCardId: randomUUID(),
  poolId: randomUUID(),
  specialPath: `bonus-concurrency/${suffix}/reverse-${kind}-special.webp`,
  sortOrder: 980 + index,
}));
const allPrivatePaths = [
  ...Object.values(privatePaths),
  ...reversePoolFixtures.map((fixture) => fixture.specialPath),
];
let firstInTransaction = false;
let secondInTransaction = false;

async function uploadPrivateObject(path) {
  const payload = new TextEncoder().encode(`test-only-${path}`);
  const { error } = await serviceStorage.storage
    .from("special-card-assets")
    .upload(path, payload, { contentType: "image/webp", upsert: false });
  assert(error === null, `private Storage fixture upload failed: ${error?.message}`);
}

try {
  for (const path of [
    privatePaths.base,
    privatePaths.publicRace,
    privatePaths.reverseRace,
    privatePaths.publish,
    privatePaths.kindRace,
    privatePaths.reverseKindRace,
    ...reversePoolFixtures.map((fixture) => fixture.specialPath),
  ]) {
    await uploadPrivateObject(path);
  }

  const publicAttempt = await fetch(
    `${local.API_URL}/storage/v1/object/public/special-card-assets/${privatePaths.base}`,
    { signal: AbortSignal.timeout(5_000) },
  );
  assert(!publicAttempt.ok, "private special original was reachable through a public Storage URL");

  const anonymousDownload = await anonymousStorage.storage
    .from("special-card-assets")
    .download(privatePaths.base);
  assert(
    anonymousDownload.error !== null && anonymousDownload.data === null,
    "anonymous client directly downloaded a special original",
  );
  const serviceDownload = await serviceStorage.storage
    .from("special-card-assets")
    .download(privatePaths.base);
  assert(
    serviceDownload.error === null && serviceDownload.data !== null,
    `service role could not download private special fixture: ${serviceDownload.error?.message}`,
  );

  await admin.query(
    `insert into auth.users (id, created_at, updated_at, is_anonymous)
     values ($1, now(), now(), true)`,
    [authUserId],
  );
  appUserId = (
    await admin.query(
      `select user_id from private.user_identities
       where auth_user_id = $1 and revoked_at is null`,
      [authUserId],
    )
  ).rows[0]?.user_id;
  assert(appUserId !== undefined, "auth fixture did not create an active app identity");
  await admin.query(
    `insert into private.minimum_age_attestations (
       user_id, minimum_age_passed, version
     ) values ($1, true, '18plus-v1')`,
    [appUserId],
  );

  await admin.query("set session_replication_role = replica");
  try {
    await admin.query(
      `insert into public.regions (code, country_code, sort_order)
       values ($1, 'KR', 970), ($2, 'KR', 971)`,
      [baseRegion, publishRegion],
    );
    await admin.query(
      `insert into public.spots (
         id, slug, region, name_ko, name_en, status,
         latitude, longitude, radius_m, accuracy_threshold_m, sort_order
       ) values
       ($1, $2, $3, '보너스 경합', 'Bonus Race', 'open',
        37.51, 126.91, 150, 200, 1),
       ($4, $5, $6, '발행 경합', 'Publish Race', 'draft',
        37.52, 126.92, 150, 200, 1),
       ($7, $8, $3, '종류 경합', 'Kind Race', 'open',
        37.53, 126.93, 150, 200, 2),
       ($9, $10, $3, '역종류 경합', 'Reverse Kind Race', 'draft',
        37.54, 126.94, 150, 200, 3)`,
      [
        baseSpotId,
        `bonus-concurrency-${suffix}`,
        baseRegion,
        publishSpotId,
        `bonus-publish-${suffix}`,
        publishRegion,
        kindRaceSpotId,
        `bonus-kind-race-${suffix}`,
        reverseKindRaceSpotId,
        `bonus-reverse-kind-race-${suffix}`,
      ],
    );
    await admin.query(
      `insert into public.spots (
         id, slug, region, name_ko, name_en, status,
         latitude, longitude, radius_m, accuracy_threshold_m, sort_order
       ) values (
         $1, $2, $3, '일반 역경합', 'Ordinary Reverse Race', 'draft',
         37.55, 126.95, 150, 200, 4
       )`,
      [ordinaryRaceSpotId, `bonus-ordinary-race-${suffix}`, baseRegion],
    );
    await admin.query(
      `insert into public.cards (
         id, spot_id, code, kind, title_ko, title_en, sketch_path,
         color_hex, is_published, published_at
       ) values
       ($1, $10, $14, 'region', '일반', 'Common', $23, '#AA7777', true, now()),
       ($2, $10, $15, 'special', '특별', 'Special', $24, '#8866AA', true, now()),
       ($3, $10, $16, 'special', '공개 경합', 'Public Race', null, '#8866AB', false, null),
       ($4, $10, $17, 'special', '역방향 경합', 'Reverse Race', null, '#8866AC', false, null),
       ($5, $29, $18, 'region', '일반 경합', 'Ordinary Race', null, '#AA7778', false, null),
       ($6, $11, $19, 'region', '발행 일반', 'Publish Common', $25, '#AA7779', true, now()),
       ($7, $11, $20, 'special', '발행 특별', 'Publish Special', $26, '#8866AD', true, now()),
       ($8, $12, $21, 'region', '종류 경합', 'Kind Race', $27, '#AA7780', true, now()),
       ($9, $13, $22, 'region', '역종류 경합', 'Reverse Kind Race', $28, '#AA7781', true, now())`,
      [
        commonCardId,
        specialCardId,
        publicRaceSpecialId,
        reverseRaceSpecialId,
        ordinaryRaceCardId,
        publishCommonCardId,
        publishSpecialCardId,
        kindRaceCardId,
        reverseKindRaceCardId,
        baseSpotId,
        publishSpotId,
        kindRaceSpotId,
        reverseKindRaceSpotId,
        `bonus-common-${suffix}`,
        `bonus-special-${suffix}`,
        `bonus-public-race-${suffix}`,
        `bonus-reverse-race-${suffix}`,
        `bonus-ordinary-race-${suffix}`,
        `bonus-publish-common-${suffix}`,
        `bonus-publish-special-${suffix}`,
        `bonus-kind-race-${suffix}`,
        `bonus-reverse-kind-race-${suffix}`,
        `bonus-concurrency/${suffix}/common.webp`,
        privatePaths.base,
        `bonus-concurrency/${suffix}/publish-common.webp`,
        privatePaths.publish,
        `bonus-concurrency/${suffix}/kind-race-common.webp`,
        `bonus-concurrency/${suffix}/reverse-kind-race-common.webp`,
        ordinaryRaceSpotId,
      ],
    );
    await admin.query(
      `insert into public.card_translations (
         card_id, locale, title, status, approved_at, approved_by
       )
       select card_row.id, locale_row.locale, card_row.title_en,
         'approved', now(), $2
       from unnest($1::uuid[]) as card_row_id(id)
       join public.cards as card_row on card_row.id = card_row_id.id
       cross join unnest(enum_range(null::public.content_locale)) as locale_row(locale)`,
      [[
        commonCardId,
        specialCardId,
        publicRaceSpecialId,
        reverseRaceSpecialId,
        ordinaryRaceCardId,
        publishCommonCardId,
        publishSpecialCardId,
        kindRaceCardId,
        reverseKindRaceCardId,
      ], authUserId],
    );
    await admin.query(
      `insert into public.spot_translations (
         spot_id, locale, name, status, approved_at, approved_by
       )
       select spot_row.id, locale_row.locale, spot_row.name_en,
         'approved', now(), $2
       from unnest($1::uuid[]) as spot_row_id(id)
       join public.spots as spot_row on spot_row.id = spot_row_id.id
       cross join unnest(enum_range(null::public.content_locale)) as locale_row(locale)`,
      [[
        baseSpotId,
        publishSpotId,
        kindRaceSpotId,
        reverseKindRaceSpotId,
        ordinaryRaceSpotId,
      ], authUserId],
    );
    await admin.query(
      `insert into private.bonus_pack_pool_versions (
         id, region_code, version_code, published_at
       ) values
       ($1, $3, 'concurrency-v1', now()),
       ($2, $4, 'publish-race-v1', null)`,
      [basePoolId, publishPoolId, baseRegion, publishRegion],
    );
    await admin.query(
      `insert into private.bonus_pack_pool_cards (
         pool_version_id, card_id, rarity, sort_order
       ) values
       ($1, $3, 'common', 1), ($1, $4, 'special', 1),
       ($2, $5, 'common', 1), ($2, $6, 'special', 1)`,
      [
        basePoolId,
        publishPoolId,
        commonCardId,
        specialCardId,
        publishCommonCardId,
        publishSpecialCardId,
      ],
    );
    for (const fixture of reversePoolFixtures) {
      await admin.query(
        `insert into public.regions (code, country_code, sort_order)
         values ($1, 'KR', $2)`,
        [fixture.region, fixture.sortOrder],
      );
      await admin.query(
        `insert into public.spots (
           id, slug, region, name_ko, name_en, status,
           latitude, longitude, radius_m, accuracy_threshold_m, sort_order
         ) values (
           $1, $2, $3, $4, $4, 'draft',
           37.6, 126.8, 150, 200, 1
         )`,
        [
          fixture.spotId,
          `bonus-reverse-${fixture.kind}-${suffix}`,
          fixture.region,
          `Reverse ${fixture.kind}`,
        ],
      );
      await admin.query(
        `insert into public.cards (
           id, spot_id, code, kind, title_ko, title_en, sketch_path,
           color_hex, is_published, published_at
         ) values
         ($1, $3, $4, 'region', $6, $6, $7, '#AA7790', true, now()),
         ($2, $3, $5, 'special', $8, $8, $9, '#8866B0', true, now())`,
        [
          fixture.commonCardId,
          fixture.specialCardId,
          fixture.spotId,
          `bonus-reverse-${fixture.kind}-common-${suffix}`,
          `bonus-reverse-${fixture.kind}-special-${suffix}`,
          `Reverse ${fixture.kind} common`,
          `bonus-concurrency/${suffix}/reverse-${fixture.kind}-common.webp`,
          `Reverse ${fixture.kind} special`,
          fixture.specialPath,
        ],
      );
      await admin.query(
        `insert into public.card_translations (
           card_id, locale, title, status, approved_at, approved_by
         )
         select card_row.id, locale_row.locale, card_row.title_en,
           'approved', now(), $2
         from unnest($1::uuid[]) as card_row_id(id)
         join public.cards as card_row on card_row.id = card_row_id.id
         cross join unnest(enum_range(null::public.content_locale)) as locale_row(locale)`,
        [[fixture.commonCardId, fixture.specialCardId], authUserId],
      );
      await admin.query(
        `insert into private.bonus_pack_pool_versions (
           id, region_code, version_code
         ) values ($1, $2, $3)`,
        [fixture.poolId, fixture.region, `reverse-${fixture.kind}-v1`],
      );
      await admin.query(
        `insert into private.bonus_pack_pool_cards (
           pool_version_id, card_id, rarity, sort_order
         ) values ($1, $2, 'common', 1), ($1, $3, 'special', 1)`,
        [fixture.poolId, fixture.commonCardId, fixture.specialCardId],
      );
    }
    for (let index = 0; index < 4; index += 1) {
      const date = `2026-12-${20 + index}`;
      await admin.query(
        `insert into public.acquisitions (
           id, user_id, spot_id, card_id, acquisition_type,
           verification_result, idempotency_key, field_sequence, acquired_at
         ) values (
           $1, $2, $3, $4, 'field', 'passed', $5, $6,
           ($7::date::timestamp + interval '12 hours') at time zone 'Asia/Seoul'
         )`,
        [
          historyAcquisitionIds[index],
          appUserId,
          baseSpotId,
          commonCardId,
          randomUUID(),
          9_700 + index,
          date,
        ],
      );
      await admin.query(
        `insert into private.bonus_packs (
           id, user_id, issuance_kind, issued_on_kst, pool_version_id,
           result_card_id, result_rarity, rarity_roll, selection_roll,
           guarantee_applied, state, issued_at
         ) values (
           $1, $2, 'field_daily', $3, $4, $5, 'common', 1, 0,
           false, 'sealed',
           ($3::date::timestamp + interval '12 hours') at time zone 'Asia/Seoul'
         )`,
        [historyPackIds[index], appUserId, date, basePoolId, commonCardId],
      );
      await admin.query(
        `insert into private.bonus_pack_qualifiers (
           pack_id, acquisition_id, user_id, is_issuing_qualifier
         ) values ($1, $2, $3, true)`,
        [historyPackIds[index], historyAcquisitionIds[index], appUserId],
      );
    }
    for (const [index, date] of ["2026-12-31", "2027-01-01"].entries()) {
      await admin.query(
        `insert into public.acquisitions (
           id, user_id, spot_id, card_id, acquisition_type,
           verification_result, idempotency_key, field_sequence, acquired_at
         ) values (
           $1, $2, $3, $4, 'field', 'passed', $5, $6,
           ($7::date::timestamp + interval '12 hours') at time zone 'Asia/Seoul'
         )`,
        [
          midnightAcquisitionIds[index],
          appUserId,
          baseSpotId,
          commonCardId,
          randomUUID(),
          9_710 + index,
          date,
        ],
      );
    }
    for (const [index, acquisitionId] of correctionAcquisitionIds.entries()) {
      await admin.query(
        `insert into public.acquisitions (
           id, user_id, spot_id, card_id, acquisition_type,
           verification_result, idempotency_key, field_sequence, acquired_at
         ) values (
           $1, $2, $3, $4, 'field', 'passed', $5, $6,
           ('2027-01-10'::date::timestamp + interval '12 hours')
             at time zone 'Asia/Seoul'
             + ($6::bigint * interval '1 microsecond')
         )`,
        [
          acquisitionId,
          appUserId,
          index === 0 ? baseSpotId : kindRaceSpotId,
          index === 0 ? commonCardId : kindRaceCardId,
          randomUUID(),
          9_720 + index,
        ],
      );
    }
  } finally {
    await admin.query("set session_replication_role = origin");
  }

  let locationRequirement = (
    await admin.query("select private.current_location_policy_requirement() as requirement")
  ).rows[0]?.requirement;
  if (typeof locationRequirement?.version !== "string") {
    await admin.query("set session_replication_role = replica");
    try {
      await admin.query(
        `insert into private.policy_documents (
           id, policy_type, version, effective_at, published_at, is_current
         ) values ($1, 'location_terms', $2, now() - interval '1 minute', now(), true)`,
        [locationPolicyId, locationPolicyVersion],
      );
      await admin.query(
        `insert into private.policy_document_locales (
           policy_document_id, locale, document_url, sha256
         )
         select $1::uuid, locale_row.locale,
           'https://policies.test/' || $1::uuid::text || '/' || locale_row.locale::text,
           extensions.digest($1::uuid::text || ':' || locale_row.locale::text, 'sha256')
         from unnest(enum_range(null::public.content_locale)) as locale_row(locale)`,
        [locationPolicyId],
      );
      createdLocationPolicy = true;
    } finally {
      await admin.query("set session_replication_role = origin");
    }
    locationRequirement = (
      await admin.query("select private.current_location_policy_requirement() as requirement")
    ).rows[0]?.requirement;
  }
  assert(
    typeof locationRequirement?.version === "string",
    "current location policy fixture is missing",
  );
  const locationConsent = (
    await admin.query(
      `select api_private.accept_location_consent(
         $1, jsonb_build_object('version', $2::text, 'locale', 'ko')
       ) as result`,
      [authUserId, locationRequirement.version],
    )
  ).rows[0]?.result;
  assert(locationConsent?.status === "active", "location consent fixture was not activated");

  await admin.query(
    `insert into private.location_use_facts (
       user_id, idempotency_key, spot_id, purpose, collected_at,
       outcome, terminal_failure_details
     ) values
       ($1, $2, $4, 'field_acquisition', clock_timestamp(), 'pending', '{}'::jsonb),
       ($1, $3, $5, 'field_acquisition', clock_timestamp(), 'pending', '{}'::jsonb)`,
    [appUserId, v05AcquisitionKeys[0], v05AcquisitionKeys[1], baseSpotId, kindRaceSpotId],
  );

  // The existing suspend-owner lock serializes the entire v05 acquisition,
  // not only reward issuance. Two same-day places therefore preserve the
  // first visit/region and link the second visit without a second envelope.
  const v05SpotVersions = await admin.query(
    `select id, updated_at::text as updated_at from public.spots where id = any($1::uuid[])`,
    [[baseSpotId, kindRaceSpotId]],
  );
  const updatedAtBySpot = new Map(
    v05SpotVersions.rows.map((row) => [row.id, row.updated_at]),
  );
  await first.query("begin");
  firstInTransaction = true;
  const firstV05 = await first.query(
    `select api_private.acquire_commit_v05(
       $1, $2, $3, true, $4, $5, 'public'
     ) as result`,
    [
      authUserId,
      baseSpotId,
      v05AcquisitionKeys[0],
      updatedAtBySpot.get(baseSpotId),
      appUserId,
    ],
  );
  assert(
    firstV05.rows[0]?.result?.status === "created",
    `first v05 visit was not created: ${JSON.stringify(firstV05.rows[0]?.result)}`,
  );
  await second.query("begin");
  secondInTransaction = true;
  const secondV05Promise = capture(second.query(
    `select api_private.acquire_commit_v05(
       $1, $2, $3, true, $4, $5, 'public'
     ) as result`,
    [
      authUserId,
      kindRaceSpotId,
      v05AcquisitionKeys[1],
      updatedAtBySpot.get(kindRaceSpotId),
      appUserId,
    ],
  ));
  await waitForBlock(observer, second.processID, first.processID, "same-day v05 acquisition");
  await first.query("commit");
  firstInTransaction = false;
  const secondV05 = await secondV05Promise;
  assert(secondV05.error === undefined, `second v05 visit failed: ${secondV05.error?.message}`);
  await second.query("commit");
  secondInTransaction = false;
  assert(
    firstV05.rows[0].result.bonus_pack?.status === "sealed",
    "first same-day v05 visit did not receive the sealed envelope",
  );
  assert(
    secondV05.result.rows[0]?.result?.status === "created"
      && secondV05.result.rows[0].result.bonus_pack === undefined,
    "second same-day v05 visit received another immutable envelope",
  );
  const v05Invariant = await admin.query(
    `select
       count(*) = 1 as one_pack,
       (select count(*) from private.bonus_pack_qualifiers as qualifier_row
        join private.bonus_packs as pack_row on pack_row.id = qualifier_row.pack_id
        where pack_row.user_id = $1
          and pack_row.issued_on_kst = (clock_timestamp() at time zone 'Asia/Seoul')::date
       ) = 2 as two_qualifiers
     from private.bonus_packs
     where user_id = $1
       and issuance_kind = 'field_daily'
       and issued_on_kst = (clock_timestamp() at time zone 'Asia/Seoul')::date`,
    [appUserId],
  );
  assert(v05Invariant.rows[0].one_pack, "same-day v05 race created more than one pack");
  assert(v05Invariant.rows[0].two_qualifiers, "same-day v05 race lost qualifier linkage");

  const referencedRemoval = await serviceStorage.storage
    .from("special-card-assets")
    .remove([privatePaths.base]);
  assert(
    referencedRemoval.error !== null,
    "Storage API removed a special original referenced by a published card",
  );
  const referencedDownload = await serviceStorage.storage
    .from("special-card-assets")
    .download(privatePaths.base);
  assert(
    referencedDownload.error === null && referencedDownload.data !== null,
    "failed referenced-object deletion did not preserve the special original",
  );

  // A user-wide lock serializes two adjacent KST dates. Only the first call
  // may observe the four-common streak and mark its result as guaranteed.
  await first.query("begin");
  firstInTransaction = true;
  const firstIssue = await first.query(
    "select private.issue_field_daily_bonus_pack($1, $2, 'public') as pack_id",
    [appUserId, midnightAcquisitionIds[0]],
  );
  await second.query("begin");
  secondInTransaction = true;
  const secondIssuePromise = capture(second.query(
    "select private.issue_field_daily_bonus_pack($1, $2, 'public') as pack_id",
    [appUserId, midnightAcquisitionIds[1]],
  ));
  await waitForBlock(observer, second.processID, first.processID, "KST-midnight issuance");
  await first.query("commit");
  firstInTransaction = false;
  const secondIssue = await secondIssuePromise;
  assert(secondIssue.error === undefined, `second issuance failed: ${secondIssue.error?.message}`);
  await second.query("commit");
  secondInTransaction = false;
  const firstPackId = firstIssue.rows[0]?.pack_id;
  const secondPackId = secondIssue.result.rows[0]?.pack_id;
  assert(firstPackId !== null && secondPackId !== null, "midnight issuance did not create two packs");
  const midnightInvariant = await admin.query(
    `select count(*) = 2 as two_packs,
       count(*) filter (where guarantee_applied) = 1 as one_guarantee,
       count(*) filter (where result_rarity = 'special' and guarantee_applied) = 1
         as guarantee_is_special
     from private.bonus_packs where id = any($1::uuid[])`,
    [[firstPackId, secondPackId]],
  );
  assert(midnightInvariant.rows[0].two_packs, "adjacent KST dates did not create exactly two packs");
  assert(midnightInvariant.rows[0].one_guarantee, "KST-midnight race duplicated or lost pity guarantee");
  assert(midnightInvariant.rows[0].guarantee_is_special, "guaranteed pack was not special");

  // Different request UUIDs racing the same sealed pack reveal one fixed
  // outcome and create at most one idempotency-ledger row.
  await first.query("begin");
  firstInTransaction = true;
  const firstOpen = await first.query(
    "select api_private.open_bonus_pack($1, $2, $3) as result",
    [authUserId, firstPackId, randomUUID()],
  );
  await second.query("begin");
  secondInTransaction = true;
  const secondOpenPromise = capture(second.query(
    "select api_private.open_bonus_pack($1, $2, $3) as result",
    [authUserId, firstPackId, randomUUID()],
  ));
  await waitForBlock(observer, second.processID, first.processID, "concurrent pack open");
  await first.query("commit");
  firstInTransaction = false;
  const secondOpen = await secondOpenPromise;
  assert(secondOpen.error === undefined, `second open failed: ${secondOpen.error?.message}`);
  await second.query("commit");
  secondInTransaction = false;
  assert(firstOpen.rows[0]?.result?.status === "ready", "first concurrent open was not ready");
  assert(secondOpen.result.rows[0]?.result?.status === "ready", "second concurrent open was not ready");
  const openInvariant = await admin.query(
    `select state = 'opened' as opened,
       (select count(*) from private.bonus_pack_open_requests where pack_id = $1) = 1
         as one_request
     from private.bonus_packs where id = $1`,
    [firstPackId],
  );
  assert(openInvariant.rows[0].opened, "concurrent open did not reveal the pack");
  assert(openInvariant.rows[0].one_request, "concurrent open grew more than one request row");

  const correctionPackId = (
    await admin.query(
      "select private.issue_field_daily_bonus_pack($1, $2, 'public') as pack_id",
      [appUserId, correctionAcquisitionIds[0]],
    )
  ).rows[0]?.pack_id;
  const correctionReplayPackId = (
    await admin.query(
      "select private.issue_field_daily_bonus_pack($1, $2, 'public') as pack_id",
      [appUserId, correctionAcquisitionIds[1]],
    )
  ).rows[0]?.pack_id;
  assert(
    correctionPackId !== null && correctionReplayPackId === correctionPackId,
    "same-day correction fixture did not link two qualifiers to one pack",
  );

  // Concurrent correction deletes serialize on the pack. The issuer deletion
  // promotes the remaining qualifier before a second delete may remove it.
  await first.query("begin");
  firstInTransaction = true;
  await first.query("delete from public.acquisitions where id = $1", [correctionAcquisitionIds[0]]);
  await second.query("begin");
  secondInTransaction = true;
  const secondCorrectionDelete = capture(second.query(
    "delete from public.acquisitions where id = $1",
    [correctionAcquisitionIds[1]],
  ));
  await waitForBlock(observer, second.processID, first.processID, "qualifier correction promotion");
  await first.query("commit");
  firstInTransaction = false;
  const secondCorrectionDeleteResult = await secondCorrectionDelete;
  assert(
    secondCorrectionDeleteResult.error === undefined,
    `second correction delete failed: ${secondCorrectionDeleteResult.error?.message}`,
  );
  const promotedSnapshot = await admin.query(
    `select
       exists (select 1 from private.bonus_packs where id = $1) as pack_preserved,
       (select count(*) from private.bonus_pack_qualifiers
        where pack_id = $1 and is_issuing_qualifier) = 1 as one_promoted_issuer`,
    [correctionPackId],
  );
  assert(promotedSnapshot.rows[0].pack_preserved, "issuer correction did not preserve the pack");
  assert(promotedSnapshot.rows[0].one_promoted_issuer, "issuer correction did not promote one survivor");
  await second.query("commit");
  secondInTransaction = false;
  const correctionFinal = await admin.query(
    `select
       not exists (select 1 from private.bonus_packs where id = $1) as pack_removed,
       not exists (select 1 from private.bonus_pack_qualifiers where pack_id = $1)
         as qualifiers_removed`,
    [correctionPackId],
  );
  assert(correctionFinal.rows[0].pack_removed, "final concurrent correction left an orphan pack");
  assert(correctionFinal.rows[0].qualifiers_removed, "final correction left qualifier rows");

  // Acquisition first: its card SHARE lock makes a concurrent region->special
  // mutation wait, then the existing acquired-snapshot guard rejects it.
  const firstKindAcquisitionId = randomUUID();
  await first.query("begin");
  firstInTransaction = true;
  await first.query(
    `insert into public.acquisitions (
       id, user_id, spot_id, card_id, acquisition_type, verification_result,
       idempotency_key, field_sequence, acquired_at
     ) values ($1, $2, $3, $4, 'gift', 'not_applicable', $5, null, now())`,
    [firstKindAcquisitionId, appUserId, kindRaceSpotId, kindRaceCardId, randomUUID()],
  );
  await second.query("begin");
  secondInTransaction = true;
  const kindBehindAcquisition = capture(second.query(
    `update public.cards
     set kind = 'special', sketch_path = $2
     where id = $1`,
    [kindRaceCardId, privatePaths.kindRace],
  ));
  await waitForBlock(observer, second.processID, first.processID, "acquisition vs card kind");
  await first.query("commit");
  firstInTransaction = false;
  const kindBehindAcquisitionResult = await kindBehindAcquisition;
  assert(
    kindBehindAcquisitionResult.error?.code === "23514",
    "card changed to special after a concurrent direct acquisition committed",
  );
  await second.query("rollback");
  secondInTransaction = false;

  // Kind mutation first: the acquisition trigger waits on the same card row,
  // rereads the committed special kind, and rejects the direct acquisition.
  const reverseKindAcquisitionId = randomUUID();
  await first.query("begin");
  firstInTransaction = true;
  await first.query(
    `update public.cards
     set kind = 'special', sketch_path = $2
     where id = $1`,
    [reverseKindRaceCardId, privatePaths.reverseKindRace],
  );
  await second.query("begin");
  secondInTransaction = true;
  const acquisitionBehindKind = capture(second.query(
    `insert into public.acquisitions (
       id, user_id, spot_id, card_id, acquisition_type, verification_result,
       idempotency_key, field_sequence, acquired_at
     ) values ($1, $2, $3, $4, 'gift', 'not_applicable', $5, null, now())`,
    [
      reverseKindAcquisitionId,
      appUserId,
      reverseKindRaceSpotId,
      reverseKindRaceCardId,
      randomUUID(),
    ],
  ));
  await waitForBlock(observer, second.processID, first.processID, "card kind vs acquisition");
  await first.query("commit");
  firstInTransaction = false;
  const acquisitionBehindKindResult = await acquisitionBehindKind;
  assert(
    acquisitionBehindKindResult.error?.code === "23514",
    "direct acquisition crossed a concurrently committed special kind",
  );
  await second.query("rollback");
  secondInTransaction = false;
  const kindInvariant = await admin.query(
    `select
       exists (select 1 from public.acquisitions where id = $1) as first_preserved,
       not exists (select 1 from public.acquisitions where id = $2) as second_rejected,
       (select kind = 'region' from public.cards where id = $3) as first_stayed_region,
       (select kind = 'special' from public.cards where id = $4) as second_became_special`,
    [firstKindAcquisitionId, reverseKindAcquisitionId, kindRaceCardId, reverseKindRaceCardId],
  );
  assert(kindInvariant.rows[0].first_preserved, "first race lost its valid acquisition");
  assert(kindInvariant.rows[0].second_rejected, "second race left a direct special acquisition");
  assert(kindInvariant.rows[0].first_stayed_region, "first race changed acquired card kind");
  assert(kindInvariant.rows[0].second_became_special, "second race did not commit special kind");

  // Public object first: special-card publication must wait on the shared path
  // lock and then fail after seeing the committed public copy.
  await first.query("begin");
  firstInTransaction = true;
  await first.query(
    `insert into storage.objects (bucket_id, name, owner, version)
     values ('card-assets', $1, null, $2)`,
    [privatePaths.publicRace, `public-race-${suffix}`],
  );
  await second.query("begin");
  secondInTransaction = true;
  const publishBehindPublic = capture(second.query(
    `update public.cards set sketch_path = $2, is_published = true,
       published_at = clock_timestamp() where id = $1`,
    [publicRaceSpecialId, privatePaths.publicRace],
  ));
  await waitForBlock(observer, second.processID, first.processID, "public asset vs special publish");
  await first.query("commit");
  firstInTransaction = false;
  const publishBehindPublicResult = await publishBehindPublic;
  assert(
    publishBehindPublicResult.error?.code === "23514",
    "special publication crossed a concurrently committed public object",
  );
  await second.query("rollback");
  secondInTransaction = false;
  const publicRaceCleanup = await serviceStorage.storage
    .from("card-assets")
    .remove([privatePaths.publicRace]);
  assert(
    publicRaceCleanup.error === null,
    `public race object cleanup failed: ${publicRaceCleanup.error?.message}`,
  );

  // Publication first: a public copy starting behind it must block and fail.
  await first.query("begin");
  firstInTransaction = true;
  await first.query(
    `update public.cards set sketch_path = $2, is_published = true,
       published_at = clock_timestamp() where id = $1`,
    [reverseRaceSpecialId, privatePaths.reverseRace],
  );
  await second.query("begin");
  secondInTransaction = true;
  const publicBehindPublish = capture(second.query(
    `insert into storage.objects (bucket_id, name, owner, version)
     values ('card-assets', $1, null, $2)`,
    [privatePaths.reverseRace, `reverse-race-${suffix}`],
  ));
  await waitForBlock(observer, second.processID, first.processID, "special publish vs public asset");
  await first.query("commit");
  firstInTransaction = false;
  const publicBehindPublishResult = await publicBehindPublish;
  assert(
    publicBehindPublishResult.error?.code === "23514",
    "public object crossed a concurrently committed special publication",
  );
  await second.query("rollback");
  secondInTransaction = false;

  // The same path lock prevents an ordinary card from being published onto a
  // concurrently created private-special object.
  await first.query("begin");
  firstInTransaction = true;
  await first.query(
    `insert into storage.objects (bucket_id, name, owner, version)
     values ('special-card-assets', $1, null, $2)`,
    [privatePaths.ordinaryRace, `ordinary-race-${suffix}`],
  );
  await second.query("begin");
  secondInTransaction = true;
  const ordinaryBehindPrivate = capture(second.query(
    `update public.cards set sketch_path = $2, is_published = true,
       published_at = clock_timestamp() where id = $1`,
    [ordinaryRaceCardId, privatePaths.ordinaryRace],
  ));
  await waitForBlock(observer, second.processID, first.processID, "private asset vs ordinary publish");
  await first.query("commit");
  firstInTransaction = false;
  const ordinaryBehindPrivateResult = await ordinaryBehindPrivate;
  assert(
    ordinaryBehindPrivateResult.error?.code === "23514",
    "ordinary card crossed a concurrently committed private-special object",
  );
  await second.query("rollback");
  secondInTransaction = false;

  const ordinaryRaceCleanup = await serviceStorage.storage
    .from("special-card-assets")
    .remove([privatePaths.ordinaryRace]);
  assert(
    ordinaryRaceCleanup.error === null,
    `ordinary reverse-race cleanup failed: ${ordinaryRaceCleanup.error?.message}`,
  );

  // Ordinary publication first: a private-special object starting behind the
  // card path lock must wake and fail after the publication commits.
  await first.query("begin");
  firstInTransaction = true;
  await first.query(
    `update public.cards set sketch_path = $2, is_published = true,
       published_at = clock_timestamp() where id = $1`,
    [ordinaryRaceCardId, privatePaths.ordinaryRace],
  );
  await second.query("begin");
  secondInTransaction = true;
  const privateBehindOrdinary = capture(second.query(
    `insert into storage.objects (bucket_id, name, owner, version)
     values ('special-card-assets', $1, null, $2)`,
    [privatePaths.ordinaryRace, `ordinary-reverse-${suffix}`],
  ));
  await waitForBlock(observer, second.processID, first.processID, "ordinary publish vs private asset");
  await first.query("commit");
  firstInTransaction = false;
  const privateBehindOrdinaryResult = await privateBehindOrdinary;
  assert(
    privateBehindOrdinaryResult.error?.code === "23514",
    "private-special object crossed a concurrently committed ordinary publication",
  );
  await second.query("rollback");
  secondInTransaction = false;

  // Pool publication holds pool, card, translation-parent, and spot locks.
  // All four mutations that start behind publication must wake and fail.
  await first.query("begin");
  firstInTransaction = true;
  await first.query(
    "update private.bonus_pack_pool_versions set published_at = clock_timestamp() where id = $1",
    [publishPoolId],
  );
  await Promise.all([
    second.query("begin"),
    third.query("begin"),
    fourth.query("begin"),
    fifth.query("begin"),
  ]);
  secondInTransaction = true;
  const entryBehindPublish = capture(second.query(
    `update private.bonus_pack_pool_cards
     set sort_order = sort_order + 1
     where pool_version_id = $1 and card_id = $2`,
    [publishPoolId, publishCommonCardId],
  ));
  const cardBehindPublish = capture(third.query(
    "update public.cards set color_hex = '#AA77A0' where id = $1",
    [publishCommonCardId],
  ));
  const translationBehindPublish = capture(fourth.query(
    `update public.card_translations
     set title = title || ' changed', approved_at = clock_timestamp(), approved_by = $2
     where card_id = $1 and locale = 'en'`,
    [publishSpecialCardId, authUserId],
  ));
  const spotBehindPublish = capture(fifth.query(
    "update public.spots set region = $2 where id = $1",
    [publishSpotId, baseRegion],
  ));
  await waitForBlock(observer, second.processID, first.processID, "pool publish vs entry");
  await waitForBlock(observer, third.processID, first.processID, "pool publish vs card");
  await waitForBlock(observer, fourth.processID, first.processID, "pool publish vs translation");
  await waitForBlock(observer, fifth.processID, first.processID, "pool publish vs spot region");
  await first.query("commit");
  firstInTransaction = false;
  const publishFirstResults = await Promise.all([
    entryBehindPublish,
    cardBehindPublish,
    translationBehindPublish,
    spotBehindPublish,
  ]);
  for (const [index, label] of ["entry", "card", "translation", "spot region"].entries()) {
    assert(
      publishFirstResults[index].error?.code === "23514",
      `${label} mutation crossed a concurrently committed pool publication`,
    );
  }
  await Promise.all([
    second.query("rollback"),
    third.query("rollback"),
    fourth.query("rollback"),
    fifth.query("rollback"),
  ]);
  secondInTransaction = false;

  // Reverse lock order: each draft mutation invalidates publication readiness
  // and commits first. The blocked publisher must wake, revalidate the newly
  // committed snapshot, and fail closed for every protected dependency.
  for (const fixture of reversePoolFixtures) {
    await first.query("begin");
    firstInTransaction = true;
    if (fixture.kind === "entry") {
      await first.query(
        `delete from private.bonus_pack_pool_cards
         where pool_version_id = $1 and card_id = $2`,
        [fixture.poolId, fixture.specialCardId],
      );
    } else if (fixture.kind === "card") {
      await first.query(
        "update public.cards set is_published = false where id = $1",
        [fixture.commonCardId],
      );
    } else if (fixture.kind === "translation") {
      await first.query(
        "update public.cards set is_published = false where id = $1",
        [fixture.specialCardId],
      );
      await first.query(
        `delete from public.card_translations
         where card_id = $1 and locale = 'en'`,
        [fixture.specialCardId],
      );
    } else {
      await first.query(
        "update public.spots set region = $2 where id = $1",
        [fixture.spotId, baseRegion],
      );
    }

    await second.query("begin");
    secondInTransaction = true;
    const publishBehindMutation = capture(second.query(
      "update private.bonus_pack_pool_versions set published_at = clock_timestamp() where id = $1",
      [fixture.poolId],
    ));
    await waitForBlock(
      observer,
      second.processID,
      first.processID,
      `${fixture.kind} mutation vs pool publish`,
    );
    await first.query("commit");
    firstInTransaction = false;
    const publishBehindMutationResult = await publishBehindMutation;
    assert(
      publishBehindMutationResult.error?.code === "23514",
      `pool publication accepted a concurrently committed ${fixture.kind} invalidation`,
    );
    await second.query("rollback");
    secondInTransaction = false;
  }
} finally {
  if (firstInTransaction) await first.query("rollback").catch(() => {});
  if (secondInTransaction) await second.query("rollback").catch(() => {});
  await Promise.all([
    third.query("rollback").catch(() => {}),
    fourth.query("rollback").catch(() => {}),
    fifth.query("rollback").catch(() => {}),
  ]);

  try {
    await admin.query("set session_replication_role = replica");
    if (appUserId !== undefined) {
      await admin.query("delete from public.app_users where id = $1", [appUserId]);
    }
    await admin.query("delete from auth.users where id = $1", [authUserId]);
    if (createdLocationPolicy) {
      await admin.query("delete from private.policy_documents where id = $1", [locationPolicyId]);
    }
    await admin.query(
      "delete from private.bonus_pack_pool_versions where id = any($1::uuid[])",
      [[basePoolId, publishPoolId, ...reversePoolFixtures.map((fixture) => fixture.poolId)]],
    );
    await admin.query(
      "delete from public.cards where id = any($1::uuid[])",
      [[
        commonCardId,
        specialCardId,
        publicRaceSpecialId,
        reverseRaceSpecialId,
        ordinaryRaceCardId,
        publishCommonCardId,
        publishSpecialCardId,
        kindRaceCardId,
        reverseKindRaceCardId,
        ...reversePoolFixtures.flatMap((fixture) => [
          fixture.commonCardId,
          fixture.specialCardId,
        ]),
      ]],
    );
    await admin.query(
      "delete from public.spots where id = any($1::uuid[])",
      [[
        baseSpotId,
        publishSpotId,
        kindRaceSpotId,
        reverseKindRaceSpotId,
        ordinaryRaceSpotId,
        ...reversePoolFixtures.map((fixture) => fixture.spotId),
      ]],
    );
    await admin.query(
      "delete from public.regions where code = any($1::text[])",
      [[baseRegion, publishRegion, ...reversePoolFixtures.map((fixture) => fixture.region)]],
    );
  } catch {
    // Preserve the original regression failure; the enclosing CI job resets
    // the local database before running this script.
  } finally {
    await admin.query("set session_replication_role = origin").catch(() => {});
  }
  await serviceStorage.storage.from("special-card-assets").remove(allPrivatePaths).catch(() => {});
  await serviceStorage.storage.from("card-assets").remove([privatePaths.publicRace]).catch(() => {});
  await Promise.all([
    admin.end(),
    first.end(),
    second.end(),
    observer.end(),
    third.end(),
    fourth.end(),
    fifth.end(),
  ]);
}
