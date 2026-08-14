import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();

vi.mock("@/server/supabase/service", () => ({
  getServiceClient: () => ({ schema: () => ({ rpc }) }),
}));

import {
  readLocationCorrectionQueue,
  resolveLocationCorrection,
} from "@/server/location/admin";

const adminAuthUserId = "11111111-1111-4111-8111-111111111111";
const correctionRequestId = "22222222-2222-4222-8222-222222222222";

describe("location correction admin repository", () => {
  beforeEach(() => rpc.mockReset());

  it("accepts the fact-or-acquisition queue projection", async () => {
    rpc.mockResolvedValue({
      data: {
        status: "ready",
        items: [{
          id: correctionRequestId,
          user_id: "33333333-3333-4333-8333-333333333333",
          location_use_fact_id: null,
          field_acquisition_id: "44444444-4444-4444-8444-444444444444",
          reason: "wrong_spot",
          status: "open",
          requested_at: "2026-08-12T00:00:00.000Z",
          resolved_at: null,
        }],
      },
      error: null,
    });
    await expect(readLocationCorrectionQueue({
      adminAuthUserId,
      status: "open",
      limit: 50,
    })).resolves.toEqual([expect.objectContaining({
      location_use_fact_id: null,
      field_acquisition_id: "44444444-4444-4444-8444-444444444444",
    })]);
  });

  it("maps an authoritative post-lock not-found result without stale success", async () => {
    rpc.mockResolvedValue({ data: { status: "not_found" }, error: null });
    await expect(resolveLocationCorrection({
      adminAuthUserId,
      correctionRequestId,
      resolution: "rejected",
    })).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("fails closed on queue projection drift", async () => {
    rpc.mockResolvedValue({
      data: {
        status: "ready",
        items: [{
          id: correctionRequestId,
          user_id: "33333333-3333-4333-8333-333333333333",
          location_use_fact_id: null,
          reason: "wrong_spot",
          status: "open",
          requested_at: "2026-08-12T00:00:00.000Z",
          resolved_at: null,
        }],
      },
      error: null,
    });
    await expect(readLocationCorrectionQueue({
      adminAuthUserId,
      status: "open",
      limit: 50,
    })).rejects.toThrow();
  });
});
