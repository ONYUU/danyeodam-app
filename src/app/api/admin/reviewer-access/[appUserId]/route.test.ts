import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifyAccessToken, revokeReviewerAccess, logSafeServerError } = vi.hoisted(() => ({
  verifyAccessToken: vi.fn(),
  revokeReviewerAccess: vi.fn(),
  logSafeServerError: vi.fn(),
}));

vi.mock("@/server/auth/verify-access-token", () => ({ verifyAccessToken }));
vi.mock("@/server/reviewer-access/service", () => ({ revokeReviewerAccess }));
vi.mock("@/server/logging/safe-log", () => ({ logSafeServerError }));

import { DELETE } from "@/app/api/admin/reviewer-access/[appUserId]/route";

const adminAuthUserId = "11111111-1111-4111-8111-111111111111";
const appUserId = "22222222-2222-4222-8222-222222222222";
const clientActionId = "33333333-3333-4333-8333-333333333333";

describe("DELETE /api/admin/reviewer-access/:appUserId", () => {
  beforeEach(() => {
    verifyAccessToken.mockReset().mockResolvedValue(adminAuthUserId);
    revokeReviewerAccess.mockReset().mockResolvedValue({
      status: "revoked",
      participant_rows: 1,
      identity_rows: 1,
      recovery_code_rows: 0,
      share_rows: 1,
    });
    logSafeServerError.mockReset();
  });

  it("revokes the exact path target with an idempotent action", async () => {
    const response = await DELETE(new Request(
      `https://api.example.test/api/admin/reviewer-access/${appUserId}`,
      {
        method: "DELETE",
        headers: {
          authorization: "Bearer admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ client_action_id: clientActionId }),
      },
    ), { params: Promise.resolve({ appUserId }) });
    expect(response.status).toBe(200);
    expect(revokeReviewerAccess).toHaveBeenCalledWith({
      adminAuthUserId,
      appUserId,
      clientActionId,
    });
  });
});
