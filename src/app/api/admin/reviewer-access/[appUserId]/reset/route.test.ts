import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifyAccessToken, resetReviewerAccess, logSafeServerError } = vi.hoisted(() => ({
  verifyAccessToken: vi.fn(),
  resetReviewerAccess: vi.fn(),
  logSafeServerError: vi.fn(),
}));

vi.mock("@/server/auth/verify-access-token", () => ({ verifyAccessToken }));
vi.mock("@/server/reviewer-access/service", () => ({ resetReviewerAccess }));
vi.mock("@/server/logging/safe-log", () => ({ logSafeServerError }));

import { POST } from "@/app/api/admin/reviewer-access/[appUserId]/reset/route";

const adminAuthUserId = "11111111-1111-4111-8111-111111111111";
const appUserId = "22222222-2222-4222-8222-222222222222";
const clientActionId = "33333333-3333-4333-8333-333333333333";

describe("POST /api/admin/reviewer-access/:appUserId/reset", () => {
  beforeEach(() => {
    verifyAccessToken.mockReset().mockResolvedValue(adminAuthUserId);
    resetReviewerAccess.mockReset().mockResolvedValue({
      status: "applied",
      store_platform: "app_store",
      fixture_version: "fixture-v1",
      retro_count: 6,
      personal_card_count: 1,
      active_share_count: 1,
      fixture_hash: "a".repeat(64),
    });
    logSafeServerError.mockReset();
  });

  it("resets by path target and one client action key", async () => {
    const response = await POST(new Request(
      `https://api.example.test/api/admin/reviewer-access/${appUserId}/reset`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer admin-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ client_action_id: clientActionId }),
      },
    ), { params: Promise.resolve({ appUserId }) });
    expect(response.status).toBe(200);
    expect(resetReviewerAccess).toHaveBeenCalledWith({
      adminAuthUserId,
      appUserId,
      clientActionId,
    });
  });
});
