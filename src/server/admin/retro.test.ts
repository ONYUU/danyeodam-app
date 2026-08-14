import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();

vi.mock("@/server/supabase/service", () => ({
  getServiceClient: () => ({
    schema: () => ({ rpc }),
  }),
}));

import { grantRetroAcquisition, parseRetroGrantInput } from "@/server/admin/retro";

const authUserId = "11111111-1111-4111-8111-111111111111";
const appUserId = "22222222-2222-4222-8222-222222222222";
const spotId = "33333333-3333-4333-8333-333333333333";
const cardId = "44444444-4444-4444-8444-444444444444";
const acquisitionId = "55555555-5555-4555-8555-555555555555";

describe("retro grant", () => {
  beforeEach(() => {
    rpc.mockReset();
  });

  it("accepts only the contract body and enforces the audit-note limit", () => {
    expect(parseRetroGrantInput({
      app_user_id: appUserId,
      spot_id: spotId,
      note: "현장 장애 복구",
    })).toEqual({
      app_user_id: appUserId,
      spot_id: spotId,
      note: "현장 장애 복구",
    });
    for (const value of [
      { app_user_id: appUserId, spot_id: spotId },
      { app_user_id: appUserId, spot_id: spotId, note: "" },
      { app_user_id: appUserId, spot_id: spotId, note: "a".repeat(501) },
      { app_user_id: appUserId, spot_id: spotId, note: "ok", extra: true },
    ]) {
      expect(() => parseRetroGrantInput(value)).toThrow(expect.objectContaining({
        code: "VALIDATION_FAILED",
      }));
    }
  });

  it("passes the active admin and returns only the contract-safe acquisition", async () => {
    rpc.mockResolvedValue({
      data: {
        status: "created",
        acquisition: {
          id: acquisitionId,
          spot_id: spotId,
          card_id: cardId,
          type: "retro",
          acquired_at: "2026-08-09T01:02:03+00:00",
        },
      },
      error: null,
    });

    await expect(grantRetroAcquisition({
      authUserId,
      grant: { app_user_id: appUserId, spot_id: spotId, note: "manual recovery" },
    })).resolves.toMatchObject({
      status: "created",
      acquisition: { type: "retro", spot_id: spotId },
    });
    expect(rpc).toHaveBeenCalledWith("grant_retro_acquisition", {
      p_admin_auth_user_id: authUserId,
      p_app_user_id: appUserId,
      p_spot_id: spotId,
      p_note: "manual recovery",
    });
  });
});
