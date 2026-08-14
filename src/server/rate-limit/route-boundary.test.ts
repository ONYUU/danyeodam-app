import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

type Method = "GET" | "POST";

const root = process.cwd();
const apiRoot = resolve(root, "src/app/api");
const migration = readFileSync(
  resolve(root, "supabase/migrations/20260812080452_authenticated_api_rate_limits.sql"),
  "utf8",
);

const boundaries = [
  {
    file: "me/collection/route.ts", method: "GET", routeCall: "readCollection(",
    repository: "src/server/collection/repository.ts", rpc: "get_user_collection",
    purpose: "collection_read",
  },
  {
    file: "acquire/route.ts", method: "POST", routeCall: "acquireCard(",
    repository: "src/server/acquire/repository.ts", rpc: "acquire_context",
    purpose: "acquire",
  },
  {
    file: "events/route.ts", method: "POST", routeCall: "ingestClientEvents(",
    repository: "src/server/events/repository.ts", rpc: "ingest_client_events",
    purpose: "event_batch",
  },
  {
    file: "personal-cards/route.ts", method: "POST", routeCall: "promotePersonalCard(",
    repository: "src/server/personal-cards/repository.ts",
    rpc: "begin_personal_card_promotion", purpose: "participant_write",
  },
  {
    file: "personal-cards/[id]/share/route.ts", method: "POST",
    routeCall: "enablePersonalCardShare(", repository: "src/server/shares/repository.ts",
    rpc: "create_personal_card_share", purpose: "participant_write",
  },
  {
    file: "physical-requests/route.ts", method: "POST", routeCall: "createPhysicalRequest(",
    repository: "src/server/physical-requests/repository.ts", rpc: "create_physical_request",
    purpose: "participant_write",
  },
  {
    file: "admin/invite-codes/route.ts", method: "POST", routeCall: "issueParticipantInvites(",
    repository: "src/server/participants/repository.ts", rpc: "issue_participant_invites",
    purpose: "admin_mutation",
  },
  {
    file: "admin/retro-grants/route.ts", method: "POST", routeCall: "grantRetroAcquisition(",
    repository: "src/server/admin/retro.ts", rpc: "grant_retro_acquisition",
    purpose: "admin_mutation",
  },
  {
    file: "admin/moderation/reports/[id]/actions/route.ts", method: "POST",
    routeCall: "applyContentReportAction(", repository: "src/server/moderation/repository.ts",
    rpc: "moderate_content_report", purpose: "admin_mutation",
  },
  {
    file: "admin/moderation/shares/[id]/actions/route.ts", method: "POST",
    routeCall: "applyShareModerationAction(", repository: "src/server/moderation/repository.ts",
    rpc: "moderate_personal_card_share", purpose: "admin_mutation",
  },
  {
    file: "admin/moderation/suspensions/[id]/actions/route.ts", method: "POST",
    routeCall: "applyShareOwnerSuspensionAction(", repository: "src/server/moderation/repository.ts",
    rpc: "moderate_share_owner_suspension", purpose: "admin_mutation",
  },
  {
    file: "admin/location-corrections/[id]/actions/route.ts", method: "POST",
    routeCall: "resolveLocationCorrection(", repository: "src/server/location/admin.ts",
    rpc: "resolve_location_correction_admin", purpose: "admin_mutation",
  },
] as const satisfies ReadonlyArray<{
  file: string;
  method: Method;
  routeCall: string;
  repository: string;
  rpc: string;
  purpose: string;
}>;

function handlerSource(source: string, method: Method): string {
  const marker = `export async function ${method}`;
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const remaining = source.slice(start + marker.length);
  const next = remaining.search(/\nexport async function (?:GET|POST|PUT|PATCH|DELETE)\b/u);
  return next < 0
    ? source.slice(start)
    : source.slice(start, start + marker.length + next);
}

function wrapperDefinition(functionName: string): string {
  const start = migration.indexOf(`create or replace function api_private.${functionName}(`);
  if (start < 0) return "";
  const end = migration.indexOf("\n$$;", start);
  return end < 0 ? "" : migration.slice(start, end + 4);
}

describe("authenticated API rate-limit domain boundary", () => {
  it("connects all 12 reviewed route methods to a rate-aware domain RPC", () => {
    expect(boundaries).toHaveLength(12);

    for (const boundary of boundaries) {
      const route = readFileSync(resolve(apiRoot, boundary.file), "utf8");
      const handler = handlerSource(route, boundary.method);
      const repository = readFileSync(resolve(root, boundary.repository), "utf8");
      const wrapper = wrapperDefinition(boundary.rpc);

      expect(handler, `${boundary.method} ${boundary.file}`).toContain(boundary.routeCall);
      expect(repository, `${boundary.rpc} repository call`).toContain(`"${boundary.rpc}"`);
      expect(repository, `${boundary.rpc} 429 mapping`).toContain(
        "throwIfAuthenticatedRateLimited",
      );
      expect(wrapper, `${boundary.rpc} wrapper`).toContain(
        "private.consume_authenticated_api_rate_limit(",
      );
      expect(wrapper, `${boundary.rpc} fixed purpose`).toContain(`'${boundary.purpose}'`);
    }
  });

  it("removes the pre-body standalone limiter from every route", () => {
    const actual = globSync("**/route.ts", { cwd: apiRoot })
      .filter((file) => readFileSync(resolve(apiRoot, file), "utf8")
        .includes("enforceAuthenticatedRateLimit"));
    expect(actual).toEqual([]);
    expect(migration).not.toContain(
      "api_private.consume_authenticated_api_rate_limit",
    );
  });

  it("limits only share creation in the mixed-method owner-share route", () => {
    const source = readFileSync(
      resolve(apiRoot, "personal-cards/[id]/share/route.ts"),
      "utf8",
    );
    expect(handlerSource(source, "POST")).toContain("enablePersonalCardShare(");
    expect(handlerSource(source, "GET")).not.toContain("enablePersonalCardShare(");
  });

  it("keeps the two intentional non-double-counted mutation boundaries", () => {
    const uploadRoute = readFileSync(
      resolve(apiRoot, "personal-cards/upload-url/route.ts"),
      "utf8",
    );
    const deletionRetryRoute = readFileSync(
      resolve(apiRoot, "admin/account-deletions/[id]/retry/route.ts"),
      "utf8",
    );
    expect(uploadRoute).toContain("issuePersonalCardUpload");
    expect(deletionRetryRoute).toContain("retryAccountDeletionJobAdmin");
  });
});
