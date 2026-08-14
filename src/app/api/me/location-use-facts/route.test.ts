import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyActiveIdentityAccessToken,
  readLocationFacts,
  logSafeServerError,
} = vi.hoisted(() => ({
  verifyActiveIdentityAccessToken: vi.fn(),
  readLocationFacts: vi.fn(),
  logSafeServerError: vi.fn(),
}));

vi.mock("@/server/auth/verify-active-identity-access-token", () => ({
  verifyActiveIdentityAccessToken,
}));
vi.mock("@/server/location/service", () => ({ readLocationFacts }));
vi.mock("@/server/logging/safe-log", () => ({ logSafeServerError }));
vi.mock("@/server/env", () => ({
  getServerEnvironment: () => ({
    LOCATION_COMPLIANCE_CURSOR_SECRET: "test-location-compliance-cursor-secret-0001",
  }),
}));

import { GET } from "@/app/api/me/location-use-facts/route";
import { ApiError } from "@/server/http/api-error";

const authUserId = "11111111-1111-4111-8111-111111111111";
const spotId = "33333333-3333-4333-8333-333333333333";

function request(token = "legacy-no-age-token"): Request {
  return new Request("https://api.example.test/api/me/location-use-facts?limit=4", {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("GET /api/me/location-use-facts", () => {
  beforeEach(() => {
    verifyActiveIdentityAccessToken.mockReset();
    readLocationFacts.mockReset();
    logSafeServerError.mockReset();
    verifyActiveIdentityAccessToken.mockResolvedValue(authUserId);
  });

  it("returns outcome-consistent bounded failure reasons without an adult gate", async () => {
    const items = [
      {
        id: 1,
        idempotency_key: "44444444-4444-4444-8444-444444444441",
        spot_id: spotId,
        purpose: "field_acquisition",
        collected_at: "2026-08-12T00:00:00.000Z",
        decided_at: null,
        outcome: "pending",
        failure: null,
      },
      {
        id: 2,
        idempotency_key: "44444444-4444-4444-8444-444444444442",
        spot_id: spotId,
        purpose: "field_acquisition",
        collected_at: "2026-08-11T00:00:00.000Z",
        decided_at: "2026-08-11T00:00:01.000Z",
        outcome: "passed",
        failure: null,
      },
      {
        id: 3,
        idempotency_key: "44444444-4444-4444-8444-444444444443",
        spot_id: spotId,
        purpose: "field_acquisition",
        collected_at: "2026-08-10T00:00:00.000Z",
        decided_at: "2026-08-10T00:00:01.000Z",
        outcome: "failed",
        failure: { code: "OUT_OF_RANGE", details: { distance_band: "far" } },
      },
    ];
    readLocationFacts.mockResolvedValue(items);

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items, next_cursor: null });
    expect(verifyActiveIdentityAccessToken).toHaveBeenCalledWith("legacy-no-age-token");
    expect(readLocationFacts).toHaveBeenCalledWith({
      authUserId,
      limit: 4,
      beforeCollectedAt: null,
      beforeId: null,
    });
  });

  it("returns 401 without reading facts when the active binding is unavailable", async () => {
    verifyActiveIdentityAccessToken.mockRejectedValue(new ApiError("UNAUTHORIZED"));

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(readLocationFacts).not.toHaveBeenCalled();
  });
});
