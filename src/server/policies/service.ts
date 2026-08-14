import "server-only";

import { ApiError } from "@/server/http/api-error";
import type { PolicyAcceptanceInput } from "@/server/policies/input";
import {
  acceptCurrentPolicies,
  getCurrentPolicies,
  type AcceptPoliciesResult,
  type CurrentPoliciesResult,
} from "@/server/policies/repository";

export type PolicyServiceDependencies = {
  findCurrent(): Promise<CurrentPoliciesResult>;
  accept(input: {
    authUserId: string;
    acceptance: PolicyAcceptanceInput;
  }): Promise<AcceptPoliciesResult>;
};

const defaultDependencies: PolicyServiceDependencies = {
  findCurrent: getCurrentPolicies,
  accept: acceptCurrentPolicies,
};

export async function readCurrentPolicies(
  dependencies: PolicyServiceDependencies = defaultDependencies,
): Promise<Extract<CurrentPoliciesResult, { status: "ready" }> ["policies"]> {
  const result = await dependencies.findCurrent();
  if (result.status !== "ready") {
    throw new ApiError("INTERNAL");
  }
  return result.policies;
}

export async function readCurrentPolicyManifest(
  input: { supportUrl: string | undefined },
  dependencies: PolicyServiceDependencies = defaultDependencies,
): Promise<{
  policies: Extract<CurrentPoliciesResult, { status: "ready" }>["policies"];
  support_url: string | null;
}> {
  return {
    policies: await readCurrentPolicies(dependencies),
    support_url: input.supportUrl ?? null,
  };
}

export async function recordPolicyAcceptances(
  input: { authUserId: string; acceptance: PolicyAcceptanceInput },
  dependencies: PolicyServiceDependencies = defaultDependencies,
): Promise<void> {
  const result = await dependencies.accept(input);
  switch (result.status) {
    case "accepted":
      return;
    case "unauthorized":
      throw new ApiError("UNAUTHORIZED");
    case "invalid":
      throw new ApiError("VALIDATION_FAILED");
    case "policy_required":
      throw new ApiError("POLICY_ACCEPTANCE_REQUIRED", { required: result.required });
  }
}
