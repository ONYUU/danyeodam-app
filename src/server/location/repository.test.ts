import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();

vi.mock("@/server/supabase/service", () => ({
  getServiceClient: () => ({
    schema: () => ({ rpc }),
  }),
}));

import {
  listOwnLocationCorrections,
  listLocationUseFacts,
  listLocationCorrectionSubjects,
  LocationRepositoryError,
} from "@/server/location/repository";

const authUserId = "11111111-1111-4111-8111-111111111111";

describe("location correction subject repository", () => {
  beforeEach(() => rpc.mockReset());

  it("uses the exact privacy-right RPC and accepts its internal keyset projection", async () => {
    rpc.mockResolvedValue({
      data: {
        status: "ready",
        items: [{
          field_acquisition_id: "22222222-2222-4222-8222-222222222222",
          spot_id: "33333333-3333-4333-8333-333333333333",
          acquired_on_kst: "2026-08-12",
        }],
      },
      error: null,
    });

    await expect(listLocationCorrectionSubjects({
      authUserId,
      limit: 25,
      beforeAcquiredOnKst: "2026-08-12",
      beforeId: "22222222-2222-4222-8222-222222222222",
    })).resolves.toMatchObject({ status: "ready", items: [expect.any(Object)] });
    expect(rpc).toHaveBeenCalledWith("list_location_correction_subjects", {
      p_auth_user_id: authUserId,
      p_limit: 25,
      p_before_acquired_on_kst: "2026-08-12",
      p_before_id: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("fails closed on extra identifiers, malformed rows, and database errors", async () => {
    rpc.mockResolvedValueOnce({
      data: {
        status: "ready",
        items: [{
          field_acquisition_id: "22222222-2222-4222-8222-222222222222",
          spot_id: "33333333-3333-4333-8333-333333333333",
          acquired_on_kst: "2026-08-12",
          user_id: authUserId,
        }],
      },
      error: null,
    });
    await expect(listLocationCorrectionSubjects({
      authUserId,
      limit: 50,
      beforeAcquiredOnKst: null,
      beforeId: null,
    })).rejects.toThrow();

    rpc.mockResolvedValueOnce({ data: null, error: { message: "unavailable" } });
    await expect(listLocationCorrectionSubjects({
      authUserId,
      limit: 50,
      beforeAcquiredOnKst: null,
      beforeId: null,
    })).rejects.toBeInstanceOf(LocationRepositoryError);
  });

  it("accepts only outcome-consistent bounded location fact disclosures", async () => {
    rpc.mockResolvedValueOnce({
      data: {
        status: "ready",
        items: [
          {
            id: 1,
            idempotency_key: "44444444-4444-4444-8444-444444444441",
            spot_id: "33333333-3333-4333-8333-333333333333",
            purpose: "field_acquisition",
            collected_at: "2026-08-12T00:00:00.000Z",
            decided_at: null,
            outcome: "pending",
            failure: null,
          },
          {
            id: 2,
            idempotency_key: "44444444-4444-4444-8444-444444444442",
            spot_id: "33333333-3333-4333-8333-333333333333",
            purpose: "field_acquisition",
            collected_at: "2026-08-11T00:00:00.000Z",
            decided_at: "2026-08-11T00:00:01.000Z",
            outcome: "passed",
            failure: null,
          },
          {
            id: 3,
            idempotency_key: "44444444-4444-4444-8444-444444444443",
            spot_id: "33333333-3333-4333-8333-333333333333",
            purpose: "field_acquisition",
            collected_at: "2026-08-10T00:00:00.000Z",
            decided_at: "2026-08-10T00:00:01.000Z",
            outcome: "failed",
            failure: { code: "OUT_OF_RANGE", details: { distance_band: "near" } },
          },
        ],
      },
      error: null,
    });

    const result = await listLocationUseFacts({
      authUserId,
      limit: 50,
      beforeCollectedAt: null,
      beforeId: null,
    });
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.items.map((item) => item.outcome)).toEqual([
        "pending",
        "passed",
        "failed",
      ]);
    }

    rpc.mockResolvedValueOnce({
      data: {
        status: "ready",
        items: [{
          id: 4,
          idempotency_key: "44444444-4444-4444-8444-444444444444",
          spot_id: "33333333-3333-4333-8333-333333333333",
          purpose: "field_acquisition",
          collected_at: "2026-08-09T00:00:00.000Z",
          decided_at: "2026-08-09T00:00:01.000Z",
          outcome: "failed",
          failure: { code: "OUT_OF_RANGE", details: {} },
        }],
      },
      error: null,
    });
    await expect(listLocationUseFacts({
      authUserId,
      limit: 50,
      beforeCollectedAt: null,
      beforeId: null,
    })).rejects.toThrow();
  });

  it("passes the exact correction-history keyset anchor to the private RPC", async () => {
    rpc.mockResolvedValueOnce({
      data: {
        status: "ready",
        items: [{
          id: "55555555-5555-4555-8555-555555555555",
          location_use_fact_id: null,
          field_acquisition_id: null,
          reason: "other",
          status: "rejected",
          requested_at: "2026-08-12T00:00:00.000Z",
          resolved_at: "2026-08-12T00:00:01.000Z",
        }],
      },
      error: null,
    });

    await expect(listOwnLocationCorrections({
      authUserId,
      limit: 25,
      beforeRequestedAt: "2026-08-12T00:00:00.000Z",
      beforeId: "55555555-5555-4555-8555-555555555555",
    })).resolves.toMatchObject({ status: "ready", items: [expect.any(Object)] });
    expect(rpc).toHaveBeenLastCalledWith("list_own_location_corrections", {
      p_auth_user_id: authUserId,
      p_limit: 25,
      p_before_requested_at: "2026-08-12T00:00:00.000Z",
      p_before_id: "55555555-5555-4555-8555-555555555555",
    });
  });
});
