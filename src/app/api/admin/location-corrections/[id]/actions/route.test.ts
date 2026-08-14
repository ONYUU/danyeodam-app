import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifyAccessToken, resolveLocationCorrection, logSafeServerError } = vi.hoisted(() => ({
  verifyAccessToken: vi.fn(),
  resolveLocationCorrection: vi.fn(),
  logSafeServerError: vi.fn(),
}));

vi.mock("@/server/auth/verify-access-token", () => ({ verifyAccessToken }));
vi.mock("@/server/location/admin", () => ({ resolveLocationCorrection }));
vi.mock("@/server/logging/safe-log", () => ({ logSafeServerError }));

import { POST } from "@/app/api/admin/location-corrections/[id]/actions/route";

function request(): Request {
  return new Request("https://api.example.test/api/admin/location-corrections/bad/actions", {
    method: "POST",
    headers: {
      authorization: "Bearer admin-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ resolution: "accepted" }),
  });
}

describe("POST /api/admin/location-corrections/[id]/actions", () => {
  beforeEach(() => {
    verifyAccessToken.mockReset();
    resolveLocationCorrection.mockReset();
    logSafeServerError.mockReset();
    verifyAccessToken.mockResolvedValue("11111111-1111-4111-8111-111111111111");
  });

  it("returns validation failure for a malformed request id before database access", async () => {
    const response = await POST(request(), { params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });
    expect(resolveLocationCorrection).not.toHaveBeenCalled();
  });
});
