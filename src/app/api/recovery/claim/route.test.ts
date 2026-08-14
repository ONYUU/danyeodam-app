import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyAdultAccessToken,
  claimRecoveryCode,
  logSafeServerError,
} = vi.hoisted(() => ({
  verifyAdultAccessToken: vi.fn(),
  claimRecoveryCode: vi.fn(),
  logSafeServerError: vi.fn(),
}));

vi.mock("@/server/auth/verify-adult-access-token", () => ({ verifyAdultAccessToken }));
vi.mock("@/server/recovery/repository", () => ({ claimRecoveryCode }));
vi.mock("@/server/logging/safe-log", () => ({ logSafeServerError }));

import { POST } from "@/app/api/recovery/claim/route";
import { ApiError } from "@/server/http/api-error";

function claimRequest(code = "A".repeat(43)): Request {
  return new Request("https://api.example.test/api/recovery/claim", {
    method: "POST",
    headers: {
      authorization: "Bearer test-access-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ code }),
  });
}

describe("POST /api/recovery/claim", () => {
  beforeEach(() => {
    verifyAdultAccessToken.mockReset();
    claimRecoveryCode.mockReset();
    logSafeServerError.mockReset();
    verifyAdultAccessToken.mockResolvedValue("11111111-1111-4111-8111-111111111111");
  });

  it("returns the same non-enumerating response for a reviewer code", async () => {
    claimRecoveryCode.mockResolvedValue({ status: "not_found" });

    const response = await POST(claimRequest());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });

  it("preserves the ordinary successful recovery response", async () => {
    claimRecoveryCode.mockResolvedValue({ status: "restored" });

    const response = await POST(claimRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ restored: true });
  });

  it.each([
    ["MINIMUM_AGE_ATTESTATION_REQUIRED", 428],
    ["UNAUTHORIZED", 401],
  ] as const)("checks the adult-active boundary before parsing the code on %s", async (
    code,
    status,
  ) => {
    verifyAdultAccessToken.mockRejectedValue(new ApiError(code));

    const response = await POST(claimRequest("not-an-exact-code"));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(claimRecoveryCode).not.toHaveBeenCalled();
  });
});
