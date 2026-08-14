import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyActiveIdentityAccessToken,
  readLocationCorrectionSubjects,
  logSafeServerError,
} = vi.hoisted(() => ({
  verifyActiveIdentityAccessToken: vi.fn(),
  readLocationCorrectionSubjects: vi.fn(),
  logSafeServerError: vi.fn(),
}));

vi.mock("@/server/auth/verify-active-identity-access-token", () => ({
  verifyActiveIdentityAccessToken,
}));
vi.mock("@/server/location/service", () => ({ readLocationCorrectionSubjects }));
vi.mock("@/server/logging/safe-log", () => ({ logSafeServerError }));
vi.mock("@/server/env", () => ({
  getServerEnvironment: () => ({
    LOCATION_COMPLIANCE_CURSOR_SECRET: "test-location-compliance-cursor-secret-0001",
  }),
}));

import { GET } from "@/app/api/me/location-correction-subjects/route";
import { ApiError } from "@/server/http/api-error";
import { encodeLocationCorrectionSubjectCursor } from "@/server/location/cursor";

const authUserId = "11111111-1111-4111-8111-111111111111";
const otherAuthUserId = "99999999-9999-4999-8999-999999999999";
const secret = "test-location-compliance-cursor-secret-0001";
const item = {
  field_acquisition_id: "22222222-2222-4222-8222-222222222222",
  spot_id: "33333333-3333-4333-8333-333333333333",
  acquired_on_kst: "2026-08-12",
};

function request(query = "", token = "legacy-no-age-token"): Request {
  return new Request(
    `https://api.example.test/api/me/location-correction-subjects${query}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
}

describe("GET /api/me/location-correction-subjects", () => {
  beforeEach(() => {
    verifyActiveIdentityAccessToken.mockReset();
    readLocationCorrectionSubjects.mockReset();
    logSafeServerError.mockReset();
    verifyActiveIdentityAccessToken.mockResolvedValue(authUserId);
    readLocationCorrectionSubjects.mockResolvedValue([]);
  });

  it("allows an active legacy session without invoking the adult verifier", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(verifyActiveIdentityAccessToken).toHaveBeenCalledWith("legacy-no-age-token");
    expect(readLocationCorrectionSubjects).toHaveBeenCalledWith({
      authUserId,
      limit: 50,
      beforeAcquiredOnKst: null,
      beforeId: null,
    });
  });

  it("returns a user-bound cursor containing only the already-disclosed KST date", async () => {
    readLocationCorrectionSubjects.mockResolvedValue([item]);
    const response = await GET(request("?limit=1"));

    expect(response.status).toBe(200);
    const body = await response.json() as {
      items: Record<string, unknown>[];
      next_cursor: string;
    };
    expect(body.items).toEqual([{
      field_acquisition_id: item.field_acquisition_id,
      spot_id: item.spot_id,
      acquired_on_kst: item.acquired_on_kst,
    }]);
    const [encodedPayload] = body.next_cursor.split(".");
    const cursorPayload = JSON.parse(
      Buffer.from(encodedPayload ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(cursorPayload).toEqual({
      v: 1,
      acquired_on_kst: item.acquired_on_kst,
      acquisition_id: item.field_acquisition_id,
    });
    expect(JSON.stringify(body)).not.toContain("acquired_at");

    readLocationCorrectionSubjects.mockResolvedValue([]);
    const next = await GET(request(`?limit=1&cursor=${encodeURIComponent(body.next_cursor)}`));
    expect(next.status).toBe(200);
    expect(readLocationCorrectionSubjects).toHaveBeenLastCalledWith({
      authUserId,
      limit: 1,
      beforeAcquiredOnKst: item.acquired_on_kst,
      beforeId: item.field_acquisition_id,
    });
  });

  it.each(["?limit=0", "?limit=101", "?limit=1.5", "?limit=abc"])(
    "rejects invalid limits before repository access: %s",
    async (query) => {
      const response = await GET(request(query));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "VALIDATION_FAILED" },
      });
      expect(readLocationCorrectionSubjects).not.toHaveBeenCalled();
    },
  );

  it("rejects tampered and cross-user cursors", async () => {
    const cursor = encodeLocationCorrectionSubjectCursor({
      acquired_on_kst: item.acquired_on_kst,
      acquisition_id: item.field_acquisition_id,
    }, otherAuthUserId, secret);
    const response = await GET(request(`?cursor=${encodeURIComponent(cursor)}`));
    expect(response.status).toBe(400);
    expect(readLocationCorrectionSubjects).not.toHaveBeenCalled();

    const tampered = await GET(request(`?cursor=${encodeURIComponent(`${cursor}x`)}`));
    expect(tampered.status).toBe(400);
  });

  it("returns 401 when no active identity can be established", async () => {
    verifyActiveIdentityAccessToken.mockRejectedValue(new ApiError("UNAUTHORIZED"));
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(readLocationCorrectionSubjects).not.toHaveBeenCalled();
  });
});
