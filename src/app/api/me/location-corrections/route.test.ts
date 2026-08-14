import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyActiveIdentityAccessToken,
  readOwnLocationCorrections,
  logSafeServerError,
} = vi.hoisted(() => ({
  verifyActiveIdentityAccessToken: vi.fn(),
  readOwnLocationCorrections: vi.fn(),
  logSafeServerError: vi.fn(),
}));

vi.mock("@/server/auth/verify-active-identity-access-token", () => ({
  verifyActiveIdentityAccessToken,
}));
vi.mock("@/server/location/service", () => ({
  readOwnLocationCorrections,
  submitLocationCorrection: vi.fn(),
}));
vi.mock("@/server/logging/safe-log", () => ({ logSafeServerError }));
vi.mock("@/server/env", () => ({
  getServerEnvironment: () => ({
    LOCATION_COMPLIANCE_CURSOR_SECRET: "test-location-compliance-cursor-secret-0001",
  }),
}));

import { GET } from "@/app/api/me/location-corrections/route";
import { ApiError } from "@/server/http/api-error";
import { encodeLocationCorrectionCursor } from "@/server/location/cursor";

const authUserId = "11111111-1111-4111-8111-111111111111";
const otherAuthUserId = "99999999-9999-4999-8999-999999999999";
const secret = "test-location-compliance-cursor-secret-0001";
const item = {
  id: "55555555-5555-4555-8555-555555555555",
  location_use_fact_id: null,
  field_acquisition_id: null,
  reason: "other",
  status: "rejected",
  requested_at: "2026-08-12T00:00:00.000Z",
  resolved_at: "2026-08-12T00:00:01.000Z",
};

function request(query = "", token = "legacy-no-age-token"): Request {
  return new Request(
    `https://api.example.test/api/me/location-corrections${query}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
}

describe("GET /api/me/location-corrections", () => {
  beforeEach(() => {
    verifyActiveIdentityAccessToken.mockReset();
    readOwnLocationCorrections.mockReset();
    logSafeServerError.mockReset();
    verifyActiveIdentityAccessToken.mockResolvedValue(authUserId);
    readOwnLocationCorrections.mockResolvedValue([]);
  });

  it("uses active identity without an adult gate and emits a user-bound safe cursor", async () => {
    readOwnLocationCorrections.mockResolvedValue([item]);

    const response = await GET(request("?limit=1"));

    expect(response.status).toBe(200);
    const body = await response.json() as {
      items: Record<string, unknown>[];
      next_cursor: string;
    };
    expect(body.items).toEqual([item]);
    expect(verifyActiveIdentityAccessToken).toHaveBeenCalledWith("legacy-no-age-token");
    expect(readOwnLocationCorrections).toHaveBeenCalledWith({
      authUserId,
      limit: 1,
      beforeRequestedAt: null,
      beforeId: null,
    });
    const [encodedPayload] = body.next_cursor.split(".");
    expect(JSON.parse(
      Buffer.from(encodedPayload ?? "", "base64url").toString("utf8"),
    )).toEqual({
      v: 1,
      requested_at: item.requested_at,
      correction_request_id: item.id,
    });
    expect(JSON.stringify(body)).not.toContain("user_id");
  });

  it("decodes the exact requested-at and UUID keyset anchor", async () => {
    const cursor = encodeLocationCorrectionCursor({
      requested_at: item.requested_at,
      correction_request_id: item.id,
    }, authUserId, secret);

    const response = await GET(request(`?limit=25&cursor=${encodeURIComponent(cursor)}`));

    expect(response.status).toBe(200);
    expect(readOwnLocationCorrections).toHaveBeenCalledWith({
      authUserId,
      limit: 25,
      beforeRequestedAt: item.requested_at,
      beforeId: item.id,
    });
  });

  it.each(["?limit=0", "?limit=101", "?limit=1.5", "?limit=abc", "?cursor="])(
    "rejects invalid pagination before repository access: %s",
    async (query) => {
      const response = await GET(request(query));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "VALIDATION_FAILED" },
      });
      expect(readOwnLocationCorrections).not.toHaveBeenCalled();
    },
  );

  it("rejects tampered and cross-user cursors", async () => {
    const cursor = encodeLocationCorrectionCursor({
      requested_at: item.requested_at,
      correction_request_id: item.id,
    }, otherAuthUserId, secret);
    expect((await GET(request(`?cursor=${encodeURIComponent(cursor)}`))).status).toBe(400);
    expect((await GET(request(`?cursor=${encodeURIComponent(`${cursor}x`)}`))).status).toBe(400);
    expect(readOwnLocationCorrections).not.toHaveBeenCalled();
  });

  it("returns 401 before cursor or repository work when the binding is inactive", async () => {
    verifyActiveIdentityAccessToken.mockRejectedValue(new ApiError("UNAUTHORIZED"));
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(readOwnLocationCorrections).not.toHaveBeenCalled();
  });
});
