import "server-only";

import {
  bonusPackDetailResultSchema,
  bonusPackListResultSchema,
  cardInventoryResultSchema,
  openBonusPackResultSchema,
  ownedSpecialCardAssetResultSchema,
  type BonusPackDetailResult,
  type BonusPackListResult,
  type CardInventoryResult,
  type OpenBonusPackResult,
  type OwnedSpecialCardAssetResult,
} from "@/server/bonus-packs/db-contract";
import { throwIfAuthenticatedRateLimited } from "@/server/rate-limit/authenticated";
import { getServiceClient } from "@/server/supabase/service";

export type BonusPackRepository = {
  list(input: {
    authUserId: string;
    limit: number;
    beforeIssuedAt: string | null;
    beforeBonusPackId: string | null;
  }): Promise<BonusPackListResult>;
  get(input: {
    authUserId: string;
    bonusPackId: string;
  }): Promise<BonusPackDetailResult>;
  open(input: {
    authUserId: string;
    bonusPackId: string;
    clientRequestId: string;
  }): Promise<OpenBonusPackResult>;
  listInventory(input: {
    authUserId: string;
    limit: number;
    beforeLastAcquiredAt: string | null;
    beforeCardId: string | null;
  }): Promise<CardInventoryResult>;
};

export type BonusPackAssetRepository = {
  getOwnedSpecialAsset(input: {
    authUserId: string;
    cardId: string;
  }): Promise<OwnedSpecialCardAssetResult>;
};

class BonusPackRepositoryError extends Error {
  constructor() {
    super("Bonus pack repository operation failed");
    this.name = "BonusPackRepositoryError";
  }
}

export class SupabaseBonusPackRepository implements BonusPackRepository {
  async list(input: {
    authUserId: string;
    limit: number;
    beforeIssuedAt: string | null;
    beforeBonusPackId: string | null;
  }): Promise<BonusPackListResult> {
    const { data, error } = await getServiceClient()
      .schema("api_private")
      .rpc("list_bonus_packs", {
        p_auth_user_id: input.authUserId,
        p_limit: input.limit,
        p_before_issued_at: input.beforeIssuedAt,
        p_before_bonus_pack_id: input.beforeBonusPackId,
      });
    if (error !== null) throw new BonusPackRepositoryError();
    throwIfAuthenticatedRateLimited(data);
    return bonusPackListResultSchema.parse(data);
  }

  async get(input: {
    authUserId: string;
    bonusPackId: string;
  }): Promise<BonusPackDetailResult> {
    const { data, error } = await getServiceClient()
      .schema("api_private")
      .rpc("get_bonus_pack", {
        p_auth_user_id: input.authUserId,
        p_bonus_pack_id: input.bonusPackId,
      });
    if (error !== null) throw new BonusPackRepositoryError();
    throwIfAuthenticatedRateLimited(data);
    return bonusPackDetailResultSchema.parse(data);
  }

  async open(input: {
    authUserId: string;
    bonusPackId: string;
    clientRequestId: string;
  }): Promise<OpenBonusPackResult> {
    const { data, error } = await getServiceClient()
      .schema("api_private")
      .rpc("open_bonus_pack", {
        p_auth_user_id: input.authUserId,
        p_bonus_pack_id: input.bonusPackId,
        p_client_request_id: input.clientRequestId,
      });
    if (error !== null) throw new BonusPackRepositoryError();
    throwIfAuthenticatedRateLimited(data);
    return openBonusPackResultSchema.parse(data);
  }

  async listInventory(input: {
    authUserId: string;
    limit: number;
    beforeLastAcquiredAt: string | null;
    beforeCardId: string | null;
  }): Promise<CardInventoryResult> {
    const { data, error } = await getServiceClient()
      .schema("api_private")
      .rpc("list_card_inventory", {
        p_auth_user_id: input.authUserId,
        p_limit: input.limit,
        p_before_last_acquired_at: input.beforeLastAcquiredAt,
        p_before_card_id: input.beforeCardId,
      });
    if (error !== null) throw new BonusPackRepositoryError();
    throwIfAuthenticatedRateLimited(data);
    return cardInventoryResultSchema.parse(data);
  }
}

export class SupabaseBonusPackAssetRepository implements BonusPackAssetRepository {
  async getOwnedSpecialAsset(input: {
    authUserId: string;
    cardId: string;
  }): Promise<OwnedSpecialCardAssetResult> {
    const { data, error } = await getServiceClient()
      .schema("api_private")
      .rpc("get_owned_special_card_asset", {
        p_auth_user_id: input.authUserId,
        p_card_id: input.cardId,
      });
    if (error !== null) throw new BonusPackRepositoryError();
    throwIfAuthenticatedRateLimited(data);
    return ownedSpecialCardAssetResultSchema.parse(data);
  }
}
