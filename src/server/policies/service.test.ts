import { describe, expect, it, vi } from "vitest";

import {
  readCurrentPolicies,
  readCurrentPolicyManifest,
  recordPolicyAcceptances,
  type PolicyServiceDependencies,
} from "@/server/policies/service";

const acceptance = {
  acceptances: [
    { type: "terms_of_use" as const, version: "1.0", locale: "ko" as const },
    { type: "community_guidelines" as const, version: "1.0", locale: "ko" as const },
  ],
};

function dependencies(overrides: Partial<PolicyServiceDependencies> = {}): PolicyServiceDependencies {
  return {
    findCurrent: vi.fn(async () => ({ status: "not_ready" as const })),
    accept: vi.fn(async () => ({ status: "accepted" as const })),
    ...overrides,
  };
}

describe("policy service", () => {
  it("fails closed while any current policy locale is not ready", async () => {
    await expect(readCurrentPolicies(dependencies())).rejects.toMatchObject({
      code: "INTERNAL",
      status: 500,
    });
  });

  it("maps stale versions to the policy acceptance error", async () => {
    const deps = dependencies({
      accept: vi.fn(async () => ({
        status: "policy_required" as const,
        required: [
          { type: "terms_of_use" as const, version: "1.1" },
          { type: "community_guidelines" as const, version: "1.1" },
        ],
      })),
    });
    await expect(recordPolicyAcceptances({ authUserId: crypto.randomUUID(), acceptance }, deps))
      .rejects.toMatchObject({ code: "POLICY_ACCEPTANCE_REQUIRED", status: 428 });
  });

  it("returns the public support URL with the exact current policy projection", async () => {
    const policies = [{
      type: "privacy_policy" as const,
      version: "1.0",
      effective_at: "2026-08-13T00:00:00.000Z",
      documents: {} as never,
    }];
    const deps = dependencies({
      findCurrent: vi.fn(async () => ({ status: "ready" as const, policies })) as never,
    });

    await expect(readCurrentPolicyManifest({
      supportUrl: "https://support.example/help",
    }, deps)).resolves.toEqual({
      policies,
      support_url: "https://support.example/help",
    });
    await expect(readCurrentPolicyManifest({ supportUrl: undefined }, deps))
      .resolves.toEqual({ policies, support_url: null });
  });
});
