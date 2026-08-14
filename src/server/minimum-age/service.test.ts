import { describe, expect, it, vi } from "vitest";

import {
  attestMinimumAge,
  readMinimumAgeAttestation,
  type MinimumAgeDependencies,
} from "@/server/minimum-age/service";

const authUserId = "11111111-1111-4111-8111-111111111111";
const attestation = { minimum_age_passed: true as const, version: "18plus-v1" as const };

function dependencies(
  overrides: Partial<MinimumAgeDependencies> = {},
): MinimumAgeDependencies {
  return {
    read: vi.fn(async () => ({ status: "missing" as const })),
    write: vi.fn(async () => ({ status: "attested" as const })),
    ...overrides,
  };
}

describe("minimum-age attestation service", () => {
  it("records the exact safe attestation without adding age data", async () => {
    const deps = dependencies();
    await expect(attestMinimumAge({ authUserId, attestation }, deps))
      .resolves.toBeUndefined();
    expect(deps.write).toHaveBeenCalledWith({ authUserId, attestation });
    expect(JSON.stringify((deps.write as ReturnType<typeof vi.fn>).mock.calls))
      .not.toMatch(/birth|dob|year|age(?!_passed)/iu);
  });

  it("maps unauthorized and invalid database outcomes", async () => {
    await expect(attestMinimumAge(
      { authUserId, attestation },
      dependencies({ write: vi.fn(async () => ({ status: "unauthorized" as const })) }),
    )).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
    await expect(attestMinimumAge(
      { authUserId, attestation },
      dependencies({ write: vi.fn(async () => ({ status: "invalid" as const })) }),
    )).rejects.toMatchObject({ code: "VALIDATION_FAILED", status: 400 });
  });

  it("projects attested, missing, and unauthorized states without inferring age", async () => {
    await expect(readMinimumAgeAttestation(
      authUserId,
      dependencies({
        read: vi.fn(async () => ({
          status: "attested" as const,
          minimum_age_passed: true as const,
          version: "18plus-v1" as const,
          attested_at: "2026-08-12T00:00:00.000Z",
        })),
      }),
    )).resolves.toEqual({
      minimum_age_passed: true,
      version: "18plus-v1",
      attested_at: "2026-08-12T00:00:00.000Z",
    });
    await expect(readMinimumAgeAttestation(authUserId, dependencies()))
      .resolves.toEqual({
        minimum_age_passed: false,
        version: null,
        attested_at: null,
      });
    await expect(readMinimumAgeAttestation(
      authUserId,
      dependencies({ read: vi.fn(async () => ({ status: "unauthorized" as const })) }),
    )).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
  });
});
