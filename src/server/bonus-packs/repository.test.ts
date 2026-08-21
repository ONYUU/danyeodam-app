import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();

vi.mock("@/server/supabase/service", () => ({
  getServiceClient: () => ({ schema: () => ({ rpc }) }),
}));

import {
  SupabaseBonusPackAssetRepository,
  SupabaseBonusPackRepository,
} from "@/server/bonus-packs/repository";

const authUserId = "11111111-1111-4111-8111-111111111111";
const bonusPackId = "22222222-2222-4222-8222-222222222222";
const clientRequestId = "abcdefab-cdef-4abc-8abc-abcdefabcdef";

describe("Supabase bonus pack repository adapter", () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it("uses only the five fixed private RPC boundaries", async () => {
    const repository = new SupabaseBonusPackRepository();

    rpc.mockResolvedValueOnce({
      data: {
        status: "ready",
        items: [],
        sealed_count: 0,
        has_more: false,
        next_anchor: null,
      },
      error: null,
    });
    await repository.list({
      authUserId,
      limit: 50,
      beforeIssuedAt: null,
      beforeBonusPackId: null,
    });

    rpc.mockResolvedValueOnce({ data: { status: "not_found" }, error: null });
    await repository.get({ authUserId, bonusPackId });

    rpc.mockResolvedValueOnce({ data: { status: "not_found" }, error: null });
    await repository.open({ authUserId, bonusPackId, clientRequestId });

    rpc.mockResolvedValueOnce({
      data: { status: "ready", items: [], has_more: false, next_anchor: null },
      error: null,
    });
    await repository.listInventory({
      authUserId,
      limit: 50,
      beforeLastAcquiredAt: null,
      beforeCardId: null,
    });

    rpc.mockResolvedValueOnce({ data: { status: "not_found" }, error: null });
    await new SupabaseBonusPackAssetRepository().getOwnedSpecialAsset({
      authUserId,
      cardId: bonusPackId,
    });

    expect(rpc.mock.calls).toEqual([
      ["list_bonus_packs", {
        p_auth_user_id: authUserId,
        p_limit: 50,
        p_before_issued_at: null,
        p_before_bonus_pack_id: null,
      }],
      ["get_bonus_pack", {
        p_auth_user_id: authUserId,
        p_bonus_pack_id: bonusPackId,
      }],
      ["open_bonus_pack", {
        p_auth_user_id: authUserId,
        p_bonus_pack_id: bonusPackId,
        p_client_request_id: clientRequestId,
      }],
      ["list_card_inventory", {
        p_auth_user_id: authUserId,
        p_limit: 50,
        p_before_last_acquired_at: null,
        p_before_card_id: null,
      }],
      ["get_owned_special_card_asset", {
        p_auth_user_id: authUserId,
        p_card_id: bonusPackId,
      }],
    ]);
  });

  it("maps a strict database rate denial before domain parsing", async () => {
    rpc.mockResolvedValueOnce({
      data: { status: "rate_limited", retry_after_seconds: 12 },
      error: null,
    });
    await expect(new SupabaseBonusPackRepository().list({
      authUserId,
      limit: 50,
      beforeIssuedAt: null,
      beforeBonusPackId: null,
    })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
      details: { retry_after_seconds: 12 },
    });
  });

  it("does not forward database errors or malformed sealed projections", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "private database detail" } });
    await expect(new SupabaseBonusPackRepository().get({ authUserId, bonusPackId }))
      .rejects.toMatchObject({ name: "BonusPackRepositoryError" });

    rpc.mockResolvedValueOnce({
      data: {
        status: "ready",
        items: [{
          id: bonusPackId,
          status: "sealed",
          issued_at: "2026-08-15T00:00:00.000Z",
          date_kst: "2026-08-15",
          rarity: "special",
        }],
        sealed_count: 1,
        has_more: false,
        next_anchor: null,
      },
      error: null,
    });
    await expect(new SupabaseBonusPackRepository().list({
      authUserId,
      limit: 50,
      beforeIssuedAt: null,
      beforeBonusPackId: null,
    })).rejects.toThrow();
  });
});
