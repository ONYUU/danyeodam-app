import "server-only";

import {
  decodeBonusPackCursor,
  decodeCardInventoryCursor,
  encodeBonusPackCursor,
  encodeCardInventoryCursor,
} from "@/server/bonus-packs/cursor";
import type {
  BonusPack,
  OpenedBonusPack,
} from "@/server/bonus-packs/db-contract";
import {
  SupabaseBonusPackRepository,
  type BonusPackRepository,
} from "@/server/bonus-packs/repository";
import { ApiError } from "@/server/http/api-error";

function projectCard(card: OpenedBonusPack["card"]) {
  return {
    id: card.id,
    rarity: card.rarity,
    title: card.title,
    image_url: card.rarity === "special"
      ? `/api/me/special-card-assets/${card.id}`
      : `/api/card-assets/${card.id}`,
    color_hex: card.color_hex,
  };
}

function projectBonusPack(pack: BonusPack) {
  const common = {
    id: pack.id,
    status: pack.status,
    issued_at: pack.issued_at,
    date_kst: pack.date_kst,
  };
  if (pack.status === "sealed") return common;
  return {
    ...common,
    opened_at: pack.opened_at,
    card: projectCard(pack.card),
  };
}

function assertPageBoundary(hasMore: boolean, nextAnchor: unknown): void {
  if (hasMore !== (nextAnchor !== null)) throw new ApiError("INTERNAL");
}

function mapReadFailure(status: "unauthorized" | "invalid" | "not_found"): never {
  if (status === "unauthorized") throw new ApiError("UNAUTHORIZED");
  if (status === "not_found") throw new ApiError("NOT_FOUND");
  throw new ApiError("INTERNAL");
}

export async function listBonusPacks(
  input: {
    authUserId: string;
    limit: number;
    cursor?: string;
    cursorSecret: string;
  },
  repository: BonusPackRepository = new SupabaseBonusPackRepository(),
) {
  const anchor = input.cursor === undefined
    ? null
    : decodeBonusPackCursor(input.cursor, input.authUserId, input.cursorSecret);
  const result = await repository.list({
    authUserId: input.authUserId,
    limit: input.limit,
    beforeIssuedAt: anchor?.issued_at ?? null,
    beforeBonusPackId: anchor?.bonus_pack_id ?? null,
  });
  if (result.status !== "ready") return mapReadFailure(result.status);
  assertPageBoundary(result.has_more, result.next_anchor);
  return {
    items: result.items.map(projectBonusPack),
    sealed_count: result.sealed_count,
    page: {
      next_cursor: result.next_anchor === null
        ? null
        : encodeBonusPackCursor({
            issued_at: result.next_anchor.issued_at,
            bonus_pack_id: result.next_anchor.id,
          }, input.authUserId, input.cursorSecret),
      has_more: result.has_more,
    },
  };
}

export async function getBonusPack(
  input: { authUserId: string; bonusPackId: string },
  repository: BonusPackRepository = new SupabaseBonusPackRepository(),
) {
  const result = await repository.get(input);
  if (result.status !== "ready") return mapReadFailure(result.status);
  return { bonus_pack: projectBonusPack(result.bonus_pack) };
}

export async function openBonusPack(
  input: {
    authUserId: string;
    bonusPackId: string;
    clientRequestId: string;
  },
  repository: BonusPackRepository = new SupabaseBonusPackRepository(),
) {
  const result = await repository.open(input);
  if (result.status === "idempotency_conflict") {
    throw new ApiError("IDEMPOTENCY_CONFLICT");
  }
  if (result.status !== "ready") return mapReadFailure(result.status);
  return { bonus_pack: projectBonusPack(result.bonus_pack) };
}

export async function listCardInventory(
  input: {
    authUserId: string;
    limit: number;
    cursor?: string;
    cursorSecret: string;
  },
  repository: BonusPackRepository = new SupabaseBonusPackRepository(),
) {
  const anchor = input.cursor === undefined
    ? null
    : decodeCardInventoryCursor(input.cursor, input.authUserId, input.cursorSecret);
  const result = await repository.listInventory({
    authUserId: input.authUserId,
    limit: input.limit,
    beforeLastAcquiredAt: anchor?.last_acquired_at ?? null,
    beforeCardId: anchor?.card_id ?? null,
  });
  if (result.status !== "ready") return mapReadFailure(result.status);
  assertPageBoundary(result.has_more, result.next_anchor);
  return {
    items: result.items.map((item) => ({
      card: projectCard(item.card),
      quantity: item.quantity,
      first_acquired_at: item.first_acquired_at,
      last_acquired_at: item.last_acquired_at,
    })),
    page: {
      next_cursor: result.next_anchor === null
        ? null
        : encodeCardInventoryCursor(result.next_anchor, input.authUserId, input.cursorSecret),
      has_more: result.has_more,
    },
  };
}
