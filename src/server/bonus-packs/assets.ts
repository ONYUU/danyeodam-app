import "server-only";

import type { CardAssetStream } from "@/server/cards/assets";
import { downloadOwnedSpecialCardAssetAtPath } from "@/server/cards/assets";
import {
  SupabaseBonusPackAssetRepository,
  type BonusPackAssetRepository,
} from "@/server/bonus-packs/repository";
import { ApiError } from "@/server/http/api-error";

export async function downloadOwnedSpecialCardAsset(
  input: { authUserId: string; cardId: string },
  repository: BonusPackAssetRepository = new SupabaseBonusPackAssetRepository(),
): Promise<CardAssetStream> {
  const result = await repository.getOwnedSpecialAsset(input);
  if (result.status === "unauthorized") throw new ApiError("UNAUTHORIZED");
  if (result.status === "not_found") throw new ApiError("NOT_FOUND");
  if (result.status === "invalid") throw new ApiError("INTERNAL");
  return downloadOwnedSpecialCardAssetAtPath(result.asset_path);
}
