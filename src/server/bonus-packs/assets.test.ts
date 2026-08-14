import { describe, expect, it, vi } from "vitest";

const downloadOwnedSpecialCardAssetAtPath = vi.hoisted(() => vi.fn());

vi.mock("@/server/cards/assets", () => ({ downloadOwnedSpecialCardAssetAtPath }));

import { downloadOwnedSpecialCardAsset } from "@/server/bonus-packs/assets";
import type { BonusPackAssetRepository } from "@/server/bonus-packs/repository";

const authUserId = "11111111-1111-4111-8111-111111111111";
const cardId = "22222222-2222-4222-8222-222222222222";

function repository(
  result: Awaited<ReturnType<BonusPackAssetRepository["getOwnedSpecialAsset"]>>,
): BonusPackAssetRepository {
  return { getOwnedSpecialAsset: vi.fn(async () => result) };
}

describe("owned special card assets", () => {
  it("downloads only the database-authorized internal path", async () => {
    const stream = {
      body: new ReadableStream<Uint8Array>(),
      contentType: "image/webp",
      contentLength: 42,
    };
    downloadOwnedSpecialCardAssetAtPath.mockResolvedValue(stream);
    const result = await downloadOwnedSpecialCardAsset(
      { authUserId, cardId },
      repository({
        status: "found",
        bucket: "special-card-assets",
        asset_path: "cards/special/owned.webp",
      }),
    );
    expect(result).toBe(stream);
    expect(downloadOwnedSpecialCardAssetAtPath).toHaveBeenCalledWith(
      "cards/special/owned.webp",
    );
  });

  it.each([
    [{ status: "unauthorized" as const }, "UNAUTHORIZED"],
    [{ status: "not_found" as const }, "NOT_FOUND"],
    [{ status: "invalid" as const }, "INTERNAL"],
  ])("maps a safe ownership result without touching Storage: %j", async (result, code) => {
    await expect(downloadOwnedSpecialCardAsset(
      { authUserId, cardId },
      repository(result),
    )).rejects.toMatchObject({ code });
    expect(downloadOwnedSpecialCardAssetAtPath).not.toHaveBeenCalled();
  });
});
