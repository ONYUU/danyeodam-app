import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyAdultAccessToken,
  issueRecoveryCode,
  createRecoveryCode,
  hashRecoveryCode,
  logSafeServerError,
} = vi.hoisted(() => ({
  verifyAdultAccessToken: vi.fn(),
  issueRecoveryCode: vi.fn(),
  createRecoveryCode: vi.fn(),
  hashRecoveryCode: vi.fn(),
  logSafeServerError: vi.fn(),
}));

vi.mock("@/server/auth/verify-adult-access-token", () => ({ verifyAdultAccessToken }));
vi.mock("@/server/recovery/repository", () => ({ issueRecoveryCode }));
vi.mock("@/server/recovery/code", () => ({ createRecoveryCode, hashRecoveryCode }));
vi.mock("@/server/logging/safe-log", () => ({ logSafeServerError }));

import { POST } from "@/app/api/recovery/issue/route";
import { ApiError } from "@/server/http/api-error";

function issueRequest(token = "test-access-token"): Request {
  return new Request("https://api.example.test/api/recovery/issue", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("POST /api/recovery/issue", () => {
  beforeEach(() => {
    verifyAdultAccessToken.mockReset();
    issueRecoveryCode.mockReset();
    createRecoveryCode.mockReset();
    hashRecoveryCode.mockReset();
    logSafeServerError.mockReset();
    verifyAdultAccessToken.mockResolvedValue("11111111-1111-4111-8111-111111111111");
    createRecoveryCode.mockReturnValue("A".repeat(43));
    hashRecoveryCode.mockReturnValue("b".repeat(64));
  });

  it("fails closed for a current or historical reviewer", async () => {
    issueRecoveryCode.mockResolvedValue({ status: "reviewer_forbidden" });

    const response = await POST(issueRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    expect(issueRecoveryCode).toHaveBeenCalledWith({
      authUserId: "11111111-1111-4111-8111-111111111111",
      codeHashHex: "b".repeat(64),
    });
  });

  it("returns the plaintext secret only after the DB accepts its digest", async () => {
    issueRecoveryCode.mockResolvedValue({ status: "issued" });

    const response = await POST(issueRequest());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ code: "A".repeat(43) });
  });

  it.each([
    ["MINIMUM_AGE_ATTESTATION_REQUIRED", 428],
    ["UNAUTHORIZED", 401],
  ] as const)("fails before code generation and the reviewer DB decision on %s", async (
    code,
    status,
  ) => {
    verifyAdultAccessToken.mockRejectedValue(new ApiError(code));

    const response = await POST(issueRequest());

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(createRecoveryCode).not.toHaveBeenCalled();
    expect(issueRecoveryCode).not.toHaveBeenCalled();
  });
});
