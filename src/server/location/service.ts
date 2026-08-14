import "server-only";

import { ApiError } from "@/server/http/api-error";
import type { LocationConsentInput, LocationCorrectionInput } from "@/server/location/input";
import {
  acceptLocationConsent,
  changeLocationConsentState,
  createLocationCorrection,
  getLocationConsent,
  listLocationUseFacts,
  listLocationCorrectionSubjects,
  listOwnLocationCorrections,
  requestLocationWithdrawal,
  type LocationConsentMutationResult,
  type LocationConsentReadResult,
  type LocationCorrectionCreateResult,
  type LocationCorrectionListResult,
  type LocationCorrectionSubjectListResult,
  type LocationFactListResult,
} from "@/server/location/repository";

function mapCommonFailure(status: string): never {
  if (status === "unauthorized") throw new ApiError("UNAUTHORIZED");
  if (status === "minimum_age_attestation_required") {
    throw new ApiError("MINIMUM_AGE_ATTESTATION_REQUIRED");
  }
  if (status === "invalid") throw new ApiError("VALIDATION_FAILED");
  throw new ApiError("INTERNAL");
}

function mapConsentMutation(result: LocationConsentMutationResult): "active" | "paused" {
  if (result.status === "active" || result.status === "paused") return result.status;
  if (result.status === "location_consent_required") {
    throw new ApiError("LOCATION_CONSENT_REQUIRED", result.required ? { required: result.required } : undefined);
  }
  if (result.status === "location_withdrawal_pending") {
    throw new ApiError("LOCATION_WITHDRAWAL_PENDING");
  }
  return mapCommonFailure(result.status);
}

export async function readLocationConsent(
  authUserId: string,
  read: (authUserId: string) => Promise<LocationConsentReadResult> = getLocationConsent,
): Promise<Extract<LocationConsentReadResult, { status: "found" | "missing" }>> {
  const result = await read(authUserId);
  if (result.status === "found" || result.status === "missing") return result;
  return mapCommonFailure(result.status);
}

export async function consentToLocation(input: {
  authUserId: string;
  acceptance: LocationConsentInput;
}, write = acceptLocationConsent): Promise<void> {
  mapConsentMutation(await write(input));
}

export async function setLocationConsentState(input: {
  authUserId: string;
  state: "active" | "paused";
}, write = changeLocationConsentState): Promise<"active" | "paused"> {
  return mapConsentMutation(await write(input));
}

export async function withdrawLocationConsent(
  authUserId: string,
  withdraw = requestLocationWithdrawal,
): Promise<{ erasure_job_id: string | null }> {
  const result = await withdraw(authUserId);
  if (result.status === "location_withdrawal_pending" && result.erasure_job_id) {
    return { erasure_job_id: result.erasure_job_id };
  }
  if (result.status === "withdrawn") return { erasure_job_id: null };
  return mapCommonFailure(result.status);
}

export async function readLocationFacts(
  input: { authUserId: string; limit: number; beforeCollectedAt: string | null; beforeId: number | null },
  read = listLocationUseFacts,
): Promise<Extract<LocationFactListResult, { status: "ready" }>["items"]> {
  const result = await read(input);
  if (result.status === "ready") return result.items;
  return mapCommonFailure(result.status);
}

export async function readLocationCorrectionSubjects(
  input: {
    authUserId: string;
    limit: number;
    beforeAcquiredOnKst: string | null;
    beforeId: string | null;
  },
  read = listLocationCorrectionSubjects,
): Promise<Extract<LocationCorrectionSubjectListResult, { status: "ready" }>["items"]> {
  const result = await read(input);
  if (result.status === "ready") return result.items;
  return mapCommonFailure(result.status);
}

export async function submitLocationCorrection(
  input: { authUserId: string; correction: LocationCorrectionInput },
  write: typeof createLocationCorrection = createLocationCorrection,
): Promise<{ created: boolean; correction_request_id: string }> {
  const result: LocationCorrectionCreateResult = await write(input);
  if (result.status === "created" || result.status === "duplicate") {
    return { created: result.status === "created", correction_request_id: result.correction_request_id };
  }
  if (result.status === "not_found") throw new ApiError("NOT_FOUND");
  if (result.status === "idempotency_conflict") throw new ApiError("IDEMPOTENCY_CONFLICT");
  if (result.status === "location_withdrawal_pending") {
    throw new ApiError("LOCATION_WITHDRAWAL_PENDING");
  }
  return mapCommonFailure(result.status);
}

export async function readOwnLocationCorrections(
  input: {
    authUserId: string;
    limit: number;
    beforeRequestedAt: string | null;
    beforeId: string | null;
  },
  read = listOwnLocationCorrections,
): Promise<Extract<LocationCorrectionListResult, { status: "ready" }>["items"]> {
  const result = await read(input);
  if (result.status === "ready") return result.items;
  return mapCommonFailure(result.status);
}
