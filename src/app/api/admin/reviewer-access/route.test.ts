import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifyAccessToken, provisionReviewerAccess, logSafeServerError } = vi.hoisted(() => ({
  verifyAccessToken: vi.fn(),
  provisionReviewerAccess: vi.fn(),
  logSafeServerError: vi.fn(),
}));

vi.mock("@/server/auth/verify-access-token", () => ({ verifyAccessToken }));
vi.mock("@/server/reviewer-access/service", () => ({ provisionReviewerAccess }));
vi.mock("@/server/logging/safe-log", () => ({ logSafeServerError }));

import { POST } from "@/app/api/admin/reviewer-access/route";

const adminAuthUserId = "11111111-1111-4111-8111-111111111111";
const appUserId = "22222222-2222-4222-8222-222222222222";
const clientActionId = "33333333-3333-4333-8333-333333333333";

function request(body: unknown): Request {
  return new Request("https://api.example.test/api/admin/reviewer-access", {
    method: "POST",
    headers: {
      authorization: "Bearer admin-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/reviewer-access", () => {
  beforeEach(() => {
    verifyAccessToken.mockReset().mockResolvedValue(adminAuthUserId);
    provisionReviewerAccess.mockReset().mockResolvedValue({
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

  it("provisions only an already-created logical reviewer target", async () => {
    const response = await POST(request({
      app_user_id: appUserId,
      store_platform: "app_store",
      fixture_version: "fixture-v1",
      client_action_id: clientActionId,
    }));
    expect(response.status).toBe(201);
    expect(provisionReviewerAccess).toHaveBeenCalledWith({
      adminAuthUserId,
      appUserId,
      storePlatform: "app_store",
      fixtureVersion: "fixture-v1",
      clientActionId,
    });
    expect(JSON.stringify(await response.json())).not.toMatch(/password|email|photo_path/u);
  });

  it("rejects attempts to send reviewer credentials through this API", async () => {
    const response = await POST(request({
      app_user_id: appUserId,
      store_platform: "app_store",
      fixture_version: "fixture-v1",
      client_action_id: clientActionId,
      email: "reviewer@example.test",
      password: "must-not-be-accepted",
    }));
    expect(response.status).toBe(400);
    expect(provisionReviewerAccess).not.toHaveBeenCalled();
  });
});
