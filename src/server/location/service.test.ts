import { describe, expect, it, vi } from "vitest";

import {
  consentToLocation,
  readLocationConsent,
  readLocationCorrectionSubjects,
  readLocationFacts,
  readOwnLocationCorrections,
  setLocationConsentState,
  submitLocationCorrection,
  withdrawLocationConsent,
} from "@/server/location/service";

const authUserId = "11111111-1111-4111-8111-111111111111";

describe("location compliance service", () => {
  it("maps service-use consent states to fixed public errors", async () => {
    await expect(consentToLocation({
      authUserId,
      acceptance: { version: "2026.08.1", locale: "ko" },
    }, vi.fn(async () => ({ status: "minimum_age_attestation_required" as const }))))
      .rejects.toMatchObject({ code: "MINIMUM_AGE_ATTESTATION_REQUIRED", status: 428 });

    await expect(setLocationConsentState({ authUserId, state: "active" }, vi.fn(async () => ({
      status: "location_consent_required" as const,
      required: { type: "location_terms" as const, version: "2026.08.1" },
    })))).rejects.toMatchObject({
      code: "LOCATION_CONSENT_REQUIRED",
      status: 428,
      details: { required: { type: "location_terms", version: "2026.08.1" } },
    });

    await expect(setLocationConsentState({ authUserId, state: "active" }, vi.fn(async () => ({
      status: "location_withdrawal_pending" as const,
    })))).rejects.toMatchObject({ code: "LOCATION_WITHDRAWAL_PENDING", status: 409 });
  });

  it("keeps privacy-right reads active-identity-only and maps only DB outcomes", async () => {
    const readSubjects = vi.fn(async () => ({
      status: "ready" as const,
      items: [{
        field_acquisition_id: "22222222-2222-4222-8222-222222222222",
        spot_id: "33333333-3333-4333-8333-333333333333",
        acquired_on_kst: "2026-08-12",
      }],
    }));
    await expect(readLocationCorrectionSubjects({
      authUserId,
      limit: 50,
      beforeAcquiredOnKst: null,
      beforeId: null,
    }, readSubjects)).resolves.toHaveLength(1);
    expect(readSubjects).toHaveBeenCalledWith({
      authUserId,
      limit: 50,
      beforeAcquiredOnKst: null,
      beforeId: null,
    });

    await expect(readLocationFacts({
      authUserId,
      limit: 50,
      beforeCollectedAt: null,
      beforeId: null,
    }, vi.fn(async () => ({ status: "unauthorized" as const }))))
      .rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });

    await expect(readLocationConsent(
      authUserId,
      vi.fn(async () => ({ status: "minimum_age_attestation_required" as const })),
    )).rejects.toMatchObject({ code: "MINIMUM_AGE_ATTESTATION_REQUIRED", status: 428 });

    const readCorrections = vi.fn(async () => ({
      status: "ready" as const,
      items: [],
    }));
    await expect(readOwnLocationCorrections({
      authUserId,
      limit: 50,
      beforeRequestedAt: "2026-08-12T00:00:00.000Z",
      beforeId: "55555555-5555-4555-8555-555555555555",
    }, readCorrections)).resolves.toEqual([]);
    expect(readCorrections).toHaveBeenCalledWith({
      authUserId,
      limit: 50,
      beforeRequestedAt: "2026-08-12T00:00:00.000Z",
      beforeId: "55555555-5555-4555-8555-555555555555",
    });
  });

  it("maps correction and withdrawal outcomes without false completion", async () => {
    await expect(submitLocationCorrection({
      authUserId,
      correction: {
        field_acquisition_id: "22222222-2222-4222-8222-222222222222",
        client_request_id: "44444444-4444-4444-8444-444444444444",
        reason: "wrong_spot",
      },
    }, vi.fn(async () => ({ status: "location_withdrawal_pending" as const }))))
      .rejects.toMatchObject({ code: "LOCATION_WITHDRAWAL_PENDING", status: 409 });

    await expect(withdrawLocationConsent(
      authUserId,
      vi.fn(async () => ({
        status: "location_withdrawal_pending" as const,
        erasure_job_id: "55555555-5555-4555-8555-555555555555",
      })),
    )).resolves.toEqual({
      erasure_job_id: "55555555-5555-4555-8555-555555555555",
    });
  });
});
