import { describe, expect, it, vi } from "vitest";

import { readOwnedPersonalCardPhoto } from "@/server/personal-cards/photo-service";

const authUserId = "11111111-1111-4111-8111-111111111111";
const personalCardId = "22222222-2222-4222-8222-222222222222";

describe("owned personal-card photo", () => {
  it("looks up ownership before downloading the private object", async () => {
    const downloadPhoto = vi.fn(async () => ({
      body: new ReadableStream<Uint8Array>(),
      contentType: "image/webp" as const,
      contentLength: 3,
    }));
    await readOwnedPersonalCardPhoto({ authUserId, personalCardId }, {
      findOwnedPhoto: vi.fn(async () => ({
        status: "found" as const,
        photo_path: `${authUserId}/${personalCardId}.webp`,
      })),
      downloadPhoto,
    });
    expect(downloadPhoto).toHaveBeenCalledWith(`${authUserId}/${personalCardId}.webp`);
  });

  it("collapses missing and non-owned cards to 404 without touching Storage", async () => {
    const downloadPhoto = vi.fn();
    await expect(readOwnedPersonalCardPhoto({ authUserId, personalCardId }, {
      findOwnedPhoto: vi.fn(async () => ({ status: "not_found" as const })),
      downloadPhoto,
    })).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(downloadPhoto).not.toHaveBeenCalled();
  });
});
