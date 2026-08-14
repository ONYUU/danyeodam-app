import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { remapSupabaseCiPorts } from "./remap-supabase-ci-ports.mjs";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
const bonusE2e = readFileSync("scripts/test-bonus-pack-http-e2e.mjs", "utf8");
const supabaseConfig = readFileSync("supabase/config.toml", "utf8");

test("every Supabase CI job remaps before start and always destroys its stack", () => {
  const startCount = (workflow.match(/- run: npx supabase start$/gmu) ?? []).length;
  const remapCount = (
    workflow.match(/- run: npm run ci:remap-supabase-ports$/gmu) ?? []
  ).length;
  const alwaysStopCount = (
    workflow.match(
      /- if: always\(\)\n\s+run: npx supabase stop --no-backup/gmu,
    ) ?? []
  ).length;
  assert.equal(startCount, 2);
  assert.equal(remapCount, startCount);
  assert.equal(alwaysStopCount, startCount);

  const upgradeStart = workflow.indexOf("\n  database-upgrade:\n");
  const databaseStart = workflow.indexOf("\n  database:\n");
  const upgradeJob = workflow.slice(upgradeStart, databaseStart);
  const databaseJob = workflow.slice(workflow.indexOf("\n  database:\n"));
  for (const [label, job] of [
    ["database-upgrade", upgradeJob],
    ["database", databaseJob],
  ]) {
    const remapIndex = job.indexOf("npm run ci:remap-supabase-ports");
    const startIndex = job.indexOf("npx supabase start");
    const alwaysStopIndex = job.indexOf(
      "- if: always()\n        run: npx supabase stop --no-backup",
    );
    assert.ok(remapIndex >= 0 && remapIndex < startIndex, label);
    assert.ok(startIndex < alwaysStopIndex, label);
  }

  const bonusIndex = databaseJob.indexOf("npm run api:test:bonus-pack");
  const alwaysStopIndex = databaseJob.indexOf(
    "- if: always()\n        run: npx supabase stop --no-backup",
  );
  assert.ok(bonusIndex >= 0 && bonusIndex < alwaysStopIndex);
  assert.match(
    databaseJob,
    /- run: npm run api:test:bonus-pack\n\s+env:\n\s+DANYEODAM_BONUS_PACK_E2E_ALLOW_DISPOSABLE: "true"/u,
  );
});

test("CI port remap is exact, complete, and fails closed on reuse", () => {
  const remapped = remapSupabaseCiPorts(supabaseConfig);
  assert.equal((remapped.match(/^port = 563\d{2}$/gmu) ?? []).length, 6);
  assert.match(remapped, /^shadow_port = 56320$/mu);
  assert.doesNotMatch(remapped, /\b(?:shadow_)?port = 553\d{2}\b/u);
  assert.throws(() => remapSupabaseCiPorts(remapped), /Expected exactly one/u);
});

test("bonus HTTP E2E has no automatic CI bypass and requires explicit disposal", () => {
  assert.doesNotMatch(bonusE2e, /GITHUB_ACTIONS/u);
  assert.match(
    bonusE2e,
    /DANYEODAM_BONUS_PACK_E2E_ALLOW_DISPOSABLE/u,
  );
  assert.match(bonusE2e, /caller must run `npx supabase stop --no-backup`/u);
  assert.match(bonusE2e, /new AggregateError/u);
  assert.match(bonusE2e, /restorePolicyCurrentState/u);
  assert.doesNotMatch(bonusE2e, /catch\(\(\) => undefined\)/u);
});
