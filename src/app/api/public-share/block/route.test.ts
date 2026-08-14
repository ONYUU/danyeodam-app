import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  blockShareOwner,
  getServerEnvironment,
  verifyAdultAccessToken,
} = vi.hoisted(() => ({
  blockShareOwner: vi.fn(),
  getServerEnvironment: vi.fn(),
  verifyAdultAccessToken: vi.fn(),
}));

vi.mock("@/server/blocks/service", () => ({ blockShareOwner }));
vi.mock("@/server/auth/verify-adult-access-token", () => ({ verifyAdultAccessToken }));
vi.mock("@/server/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/env")>();
  return { ...actual, getServerEnvironment };
});

import { POST } from "@/app/api/public-share/block/route";
import { ApiError } from "@/server/http/api-error";

const authUserId = "11111111-1111-4111-8111-111111111111";
const shareSecret = "AbCdEfGhIjKlMnOpQrStUv";
const clientActionId = "22222222-2222-4222-8222-222222222222";

function request(
  body: unknown = { share_secret: shareSecret, client_action_id: clientActionId },
): Request {
  return new Request("https://api.example.test/api/public-share/block", {
    method: "POST",
    headers: {
      authorization: "Bearer adult-access-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/public-share/block", () => {
  beforeEach(() => {
    blockShareOwner.mockReset();
    getServerEnvironment.mockReset();
    verifyAdultAccessToken.mockReset();
    getServerEnvironment.mockReturnValue({ PUBLIC_SHARE_PUBLICATION: "true" });
    verifyAdultAccessToken.mockResolvedValue(authUserId);
    blockShareOwner.mockResolvedValue(undefined);
  });

  it("returns publication-closed 404 before bearer verification or body parsing", async () => {
    getServerEnvironment.mockReturnValue({ PUBLIC_SHARE_PUBLICATION: "false" });
    const malformed = new Request("https://api.example.test/api/public-share/block", {
      method: "POST",
      body: "not-json",
    });

    const response = await POST(malformed);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(verifyAdultAccessToken).not.toHaveBeenCalled();
    expect(blockShareOwner).not.toHaveBeenCalled();
  });

  it("accepts an adult bearer without a web age cookie", async () => {
    const response = await POST(request());

    expect(response.status).toBe(204);
    expect(verifyAdultAccessToken).toHaveBeenCalledWith("adult-access-token");
    expect(blockShareOwner).toHaveBeenCalledWith({
      authUserId,
      shareSlug: shareSecret,
      clientActionId,
      publicSharePublicationOpen: true,
    });
  });

  it("verifies the adult bearer before parsing the strict body", async () => {
    verifyAdultAccessToken.mockRejectedValue(
      new ApiError("MINIMUM_AGE_ATTESTATION_REQUIRED"),
    );

    const response = await POST(request({ unexpected: true }));

    expect(response.status).toBe(428);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "MINIMUM_AGE_ATTESTATION_REQUIRED" },
    });
    expect(verifyAdultAccessToken).toHaveBeenCalledOnce();
    expect(blockShareOwner).not.toHaveBeenCalled();
  });

  it("rejects a non-exact body after adult verification", async () => {
    const response = await POST(request({
      share_secret: shareSecret,
      client_action_id: clientActionId,
      age_cookie: "must-not-cross-the-boundary",
    }));

    expect(response.status).toBe(400);
    expect(verifyAdultAccessToken).toHaveBeenCalledOnce();
    expect(blockShareOwner).not.toHaveBeenCalled();
  });
});
