import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyActiveIdentityAccessToken,
  verifyAdultAccessToken,
  disablePersonalCardShare,
  enablePersonalCardShare,
  readPersonalCardShareStatus,
  logSafeServerError,
} = vi.hoisted(() => ({
  verifyActiveIdentityAccessToken: vi.fn(),
  verifyAdultAccessToken: vi.fn(),
  disablePersonalCardShare: vi.fn(),
  enablePersonalCardShare: vi.fn(),
  readPersonalCardShareStatus: vi.fn(),
  logSafeServerError: vi.fn(),
}));

vi.mock("@/server/auth/verify-active-identity-access-token", () => ({
  verifyActiveIdentityAccessToken,
}));
vi.mock("@/server/auth/verify-adult-access-token", () => ({
  verifyAdultAccessToken,
}));
vi.mock("@/server/shares/service", () => ({
  disablePersonalCardShare,
  enablePersonalCardShare,
  readPersonalCardShareStatus,
}));
vi.mock("@/server/logging/safe-log", () => ({ logSafeServerError }));

import { DELETE, GET, POST } from "@/app/api/personal-cards/[id]/share/route";
import { ApiError } from "@/server/http/api-error";

const authUserId = "11111111-1111-4111-8111-111111111111";
const personalCardId = "22222222-2222-4222-8222-222222222222";
const context = { params: Promise.resolve({ id: personalCardId }) };

function request(method: "DELETE" | "GET" | "POST", token: string): Request {
  return new Request(`https://api.example.test/api/personal-cards/${personalCardId}/share`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("/api/personal-cards/[id]/share verifier boundary", () => {
  beforeEach(() => {
    verifyActiveIdentityAccessToken.mockReset();
    verifyAdultAccessToken.mockReset();
    disablePersonalCardShare.mockReset();
    enablePersonalCardShare.mockReset();
    readPersonalCardShareStatus.mockReset();
    logSafeServerError.mockReset();
    verifyActiveIdentityAccessToken.mockResolvedValue(authUserId);
    verifyAdultAccessToken.mockResolvedValue(authUserId);
    disablePersonalCardShare.mockResolvedValue(undefined);
  });

  it("lets an active no-age legacy owner revoke an existing share", async () => {
    const response = await DELETE(request("DELETE", "legacy-no-age-token"), context);

    expect(response.status).toBe(204);
    expect(verifyActiveIdentityAccessToken).toHaveBeenCalledWith("legacy-no-age-token");
    expect(verifyAdultAccessToken).not.toHaveBeenCalled();
    expect(disablePersonalCardShare).toHaveBeenCalledWith({
      authUserId,
      personalCardId,
    });
  });

  it("returns 401 without revoking when the active identity is unavailable", async () => {
    verifyActiveIdentityAccessToken.mockRejectedValue(new ApiError("UNAUTHORIZED"));

    const response = await DELETE(request("DELETE", "revoked-token"), context);

    expect(response.status).toBe(401);
    expect(disablePersonalCardShare).not.toHaveBeenCalled();
  });

  it("keeps share creation and status reads behind the adult verifier", async () => {
    verifyAdultAccessToken.mockRejectedValue(new ApiError("MINIMUM_AGE_ATTESTATION_REQUIRED"));

    const postResponse = await POST(request("POST", "no-age-token"), context);
    const getResponse = await GET(request("GET", "no-age-token"), context);

    expect(postResponse.status).toBe(428);
    expect(getResponse.status).toBe(428);
    expect(verifyAdultAccessToken).toHaveBeenCalledTimes(2);
    expect(verifyActiveIdentityAccessToken).not.toHaveBeenCalled();
    expect(enablePersonalCardShare).not.toHaveBeenCalled();
    expect(readPersonalCardShareStatus).not.toHaveBeenCalled();
  });
});
