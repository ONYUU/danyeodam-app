import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

function source(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

describe("bonus pack HTTP and adapter boundary", () => {
  it("keeps every consumer route behind bearer and adult-active verification", () => {
    const routes = [
      "src/app/api/me/bonus-packs/route.ts",
      "src/app/api/me/bonus-packs/[id]/route.ts",
      "src/app/api/me/bonus-packs/[id]/open/route.ts",
      "src/app/api/me/card-inventory/route.ts",
      "src/app/api/me/special-card-assets/[cardId]/route.ts",
    ];
    for (const route of routes) {
      expect(source(route), route).toContain("requireBearerToken(");
      expect(source(route), route).toContain("verifyAdultAccessToken(");
      expect(source(route), route).toContain('export const runtime = "nodejs"');
    }
  });

  it("keeps database calls in one service-role adapter with rate-denial mapping", () => {
    const repository = source("src/server/bonus-packs/repository.ts");
    for (const rpc of [
      "list_bonus_packs",
      "get_bonus_pack",
      "open_bonus_pack",
      "list_card_inventory",
      "get_owned_special_card_asset",
    ]) {
      expect(repository).toContain(`.rpc("${rpc}"`);
    }
    expect(repository.match(/throwIfAuthenticatedRateLimited\(data\)/gu)).toHaveLength(5);
    expect(repository).toContain('.schema("api_private")');
  });

  it("keeps issuance and cursor settings server-only and defaults issuance closed", () => {
    const environment = source("src/server/env.ts");
    const example = source(".env.example");
    expect(environment).toContain('z.enum(["off", "participants", "public"])');
    expect(environment).toContain('.default("off")');
    expect(example).toContain("BONUS_PACK_ISSUANCE_SCOPE=\n");
    expect(example).toContain("BONUS_PACK_CURSOR_SECRET=\n");
    expect(environment).not.toContain("NEXT_PUBLIC_BONUS_PACK");
    expect(example).not.toContain("NEXT_PUBLIC_BONUS_PACK");
  });

  it("uses the v0.5 acquire commit and does not add a client result choice", () => {
    const acquireRoute = source("src/app/api/acquire/route.ts");
    const acquireRepository = source("src/server/acquire/repository.ts");
    const openInput = source("src/server/bonus-packs/input.ts");
    expect(acquireRoute).toContain("bonusPackIssuanceScope");
    expect(acquireRepository).toContain('.rpc("acquire_commit_v05"');
    expect(openInput).toContain("client_request_id: uuidV4Schema");
    expect(openInput).not.toContain("card_id:");
    expect(openInput).not.toContain("rarity:");
  });

  it("routes special art through an owned bearer endpoint", () => {
    const service = source("src/server/bonus-packs/service.ts");
    const ownedRoute = source("src/app/api/me/special-card-assets/[cardId]/route.ts");
    expect(service).toContain("/api/me/special-card-assets/");
    expect(ownedRoute).toContain("downloadOwnedSpecialCardAsset(");
    expect(ownedRoute).toContain('"Cache-Control": "private, no-store"');
  });
});
