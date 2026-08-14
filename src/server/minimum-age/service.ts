import "server-only";

import { ApiError } from "@/server/http/api-error";
import type { MinimumAgeAttestationInput } from "@/server/minimum-age/input";
import {
  getMinimumAgeAttestation,
  recordMinimumAgeAttestation,
  type MinimumAgeReadResult,
  type MinimumAgeWriteResult,
} from "@/server/minimum-age/repository";

export type MinimumAgeDependencies = {
  read(authUserId: string): Promise<MinimumAgeReadResult>;
  write(input: {
    authUserId: string;
    attestation: MinimumAgeAttestationInput;
  }): Promise<MinimumAgeWriteResult>;
};

const defaultDependencies: MinimumAgeDependencies = {
  read: getMinimumAgeAttestation,
  write: recordMinimumAgeAttestation,
};

export async function attestMinimumAge(
  input: { authUserId: string; attestation: MinimumAgeAttestationInput },
  dependencies: MinimumAgeDependencies = defaultDependencies,
): Promise<void> {
  const result = await dependencies.write(input);
  if (result.status === "attested") return;
  if (result.status === "unauthorized") throw new ApiError("UNAUTHORIZED");
  throw new ApiError("VALIDATION_FAILED");
}

export async function readMinimumAgeAttestation(
  authUserId: string,
  dependencies: MinimumAgeDependencies = defaultDependencies,
): Promise<{ minimum_age_passed: boolean; version: "18plus-v1" | null; attested_at: string | null }> {
  const result = await dependencies.read(authUserId);
  if (result.status === "unauthorized") throw new ApiError("UNAUTHORIZED");
  if (result.status === "missing") {
    return { minimum_age_passed: false, version: null, attested_at: null };
  }
  return {
    minimum_age_passed: true,
    version: result.version,
    attested_at: result.attested_at,
  };
}
