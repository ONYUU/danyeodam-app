import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyAdultAccessToken,
  downloadOwnedSpecialCardAsset,
  logSafeServerError,
} = vi.hoisted(() => ({
  verifyAdultAccessToken: vi.fn(),
  downloadOwnedSpecialCardAsset: vi.fn(),
  logSafeServerError: vi.fn(),
}));

vi.mock("@/server/auth/verify-adult-access-token", () => ({ verifyAdultAccessToken }));
vi.mock("@/server/bonus-packs/assets", () => ({ downloadOwnedSpecialCardAsset }));
vi.mock("@/server/logging/safe-log", () => ({ logSafeServerError }));

import { GET } from "@/app/api/me/special-card-assets/[cardId]/route";

const authUserId = "11111111-1111-4111-8111-111111111111";
const cardId = "22222222-2222-4222-8222-222222222222";

function request(query = "", token = "private-access-token"): Request {
  return new Request(
    `https://api.example.test/api/me/special-card-assets/${cardId}${query}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
}

function context(value = cardId) {
  return { params: Promise.resolve({ cardId: value }) };
}

describe("GET /api/me/special-card-assets/[cardId]", () => {
  beforeEach(() => {
    verifyAdultAccessToken.mockResolvedValue(authUserId);
    downloadOwnedSpecialCardAsset.mockResolvedValue({
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      }),
      contentType: "image/webp",
      contentLength: 3,
    });
  });

  it("streams owned art behind bearer auth with private no-store headers", async () => {
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(downloadOwnedSpecialCardAsset).toHaveBeenCalledWith({ authUserId, cardId });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("rejects query expansion and malformed IDs before the asset service", async () => {
    expect((await GET(request("?download=true"), context())).status).toBe(400);
    expect((await GET(request(), context("not-an-id"))).status).toBe(404);
    expect(downloadOwnedSpecialCardAsset).not.toHaveBeenCalled();
  });

  it("does not log the bearer token or card ID on an upstream failure", async () => {
    downloadOwnedSpecialCardAsset.mockRejectedValue(new Error("private storage detail"));
    const response = await GET(request("", "secret-bearer"), context());
    expect(response.status).toBe(500);
    expect(logSafeServerError).toHaveBeenCalledWith({
      requestId: expect.any(String),
      operation: "owned_special_card_asset",
      category: "unexpected",
    });
    const logged = JSON.stringify(logSafeServerError.mock.calls);
    expect(logged).not.toContain("secret-bearer");
    expect(logged).not.toContain(cardId);
  });
});
