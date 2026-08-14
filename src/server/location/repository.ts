import "server-only";

import { z } from "zod";

import type {
  LocationConsentInput,
  LocationCorrectionInput,
} from "@/server/location/input";
import { getServiceClient } from "@/server/supabase/service";

const requiredSchema = z.object({
  type: z.literal("location_terms"),
  version: z.string().min(1).max(64),
}).strict();

const commonFailureSchemas = [
  z.object({ status: z.literal("unauthorized") }).strict(),
  z.object({ status: z.literal("minimum_age_attestation_required") }).strict(),
] as const;

const consentReadSchema = z.discriminatedUnion("status", [
  ...commonFailureSchemas,
  z.object({ status: z.literal("missing"), required: requiredSchema.or(z.object({}).strict()) }).strict(),
  z.object({
    status: z.literal("found"),
    consent: z.object({
      state: z.enum(["active", "paused", "withdrawal_pending"]),
      policy_version: z.string().min(1).max(64),
      locale: z.enum(["ko", "en", "ja", "zh-Hans", "zh-Hant", "vi"]),
      consented_at: z.iso.datetime({ offset: true }),
      updated_at: z.iso.datetime({ offset: true }),
      withdrawal_requested_at: z.iso.datetime({ offset: true }).nullable(),
      is_current: z.boolean(),
    }).strict(),
  }).strict(),
]);

const consentMutationSchema = z.discriminatedUnion("status", [
  ...commonFailureSchemas,
  z.object({ status: z.literal("invalid") }).strict(),
  z.object({ status: z.literal("active") }).strict(),
  z.object({ status: z.literal("paused") }).strict(),
  z.object({ status: z.literal("location_withdrawal_pending"), erasure_job_id: z.uuid().nullable().optional() }).strict(),
  z.object({ status: z.literal("location_consent_required"), required: requiredSchema.or(z.object({}).strict()).optional() }).strict(),
]);

const withdrawalSchema = z.discriminatedUnion("status", [
  ...commonFailureSchemas,
  z.object({ status: z.literal("withdrawn") }).strict(),
  z.object({ status: z.literal("location_withdrawal_pending"), erasure_job_id: z.uuid() }).strict(),
]);

const factBaseShape = {
  id: z.number().int().positive(),
  idempotency_key: z.uuid(),
  spot_id: z.uuid(),
  purpose: z.literal("field_acquisition"),
  collected_at: z.iso.datetime({ offset: true }),
};
const terminalFailureSchema = z.discriminatedUnion("code", [
  z.object({
    code: z.literal("LOW_ACCURACY"),
    details: z.object({ retry: z.literal(true) }).strict(),
  }).strict(),
  z.object({
    code: z.literal("OUT_OF_RANGE"),
    details: z.object({ distance_band: z.enum(["near", "far"]) }).strict(),
  }).strict(),
  z.object({
    code: z.enum(["ALREADY_ACQUIRED_TODAY", "SPOT_NOT_OPEN", "GATE_CLOSED"]),
    details: z.object({}).strict(),
  }).strict(),
]);
const factSchema = z.discriminatedUnion("outcome", [
  z.object({
    ...factBaseShape,
    decided_at: z.null(),
    outcome: z.literal("pending"),
    failure: z.null(),
  }).strict(),
  z.object({
    ...factBaseShape,
    decided_at: z.iso.datetime({ offset: true }),
    outcome: z.literal("passed"),
    failure: z.null(),
  }).strict(),
  z.object({
    ...factBaseShape,
    decided_at: z.iso.datetime({ offset: true }),
    outcome: z.literal("failed"),
    failure: terminalFailureSchema,
  }).strict(),
]);
const factListSchema = z.discriminatedUnion("status", [
  ...commonFailureSchemas,
  z.object({ status: z.literal("invalid") }).strict(),
  z.object({ status: z.literal("ready"), items: z.array(factSchema).max(100) }).strict(),
]);

const correctionSubjectSchema = z.object({
  field_acquisition_id: z.uuid(),
  spot_id: z.uuid(),
  acquired_on_kst: z.iso.date(),
}).strict();
const correctionSubjectListSchema = z.discriminatedUnion("status", [
  ...commonFailureSchemas,
  z.object({ status: z.literal("invalid") }).strict(),
  z.object({
    status: z.literal("ready"),
    items: z.array(correctionSubjectSchema).max(100),
  }).strict(),
]);

const correctionSchema = z.object({
  id: z.uuid(),
  location_use_fact_id: z.number().int().positive().nullable(),
  field_acquisition_id: z.uuid().nullable(),
  reason: z.enum(["not_my_visit", "wrong_spot", "incorrect_outcome", "other"]),
  status: z.enum(["open", "approved_pending_correction", "corrected", "rejected"]),
  requested_at: z.iso.datetime({ offset: true }),
  resolved_at: z.iso.datetime({ offset: true }).nullable(),
}).strict();
const correctionListSchema = z.discriminatedUnion("status", [
  ...commonFailureSchemas,
  z.object({ status: z.literal("invalid") }).strict(),
  z.object({ status: z.literal("ready"), items: z.array(correctionSchema).max(100) }).strict(),
]);
const correctionCreateSchema = z.discriminatedUnion("status", [
  ...commonFailureSchemas,
  z.object({ status: z.literal("invalid") }).strict(),
  z.object({ status: z.literal("not_found") }).strict(),
  z.object({ status: z.literal("idempotency_conflict") }).strict(),
  z.object({ status: z.literal("location_withdrawal_pending") }).strict(),
  z.object({ status: z.enum(["created", "duplicate"]), correction_request_id: z.uuid() }).strict(),
]);

export type LocationConsentReadResult = z.infer<typeof consentReadSchema>;
export type LocationConsentMutationResult = z.infer<typeof consentMutationSchema>;
export type LocationFact = z.infer<typeof factSchema>;
export type LocationFactListResult = z.infer<typeof factListSchema>;
export type LocationCorrectionSubject = z.infer<typeof correctionSubjectSchema>;
export type LocationCorrectionSubjectListResult = z.infer<
  typeof correctionSubjectListSchema
>;
export type LocationCorrectionListResult = z.infer<typeof correctionListSchema>;
export type LocationCorrectionCreateResult = z.infer<typeof correctionCreateSchema>;

export class LocationRepositoryError extends Error {
  constructor() {
    super("Location repository operation failed");
    this.name = "LocationRepositoryError";
  }
}

async function rpc(name: string, parameters: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await getServiceClient().schema("api_private").rpc(name, parameters);
  if (error !== null) throw new LocationRepositoryError();
  return data;
}

export const getLocationConsent = async (authUserId: string): Promise<LocationConsentReadResult> =>
  consentReadSchema.parse(await rpc("get_location_consent", { p_auth_user_id: authUserId }));

export const acceptLocationConsent = async (input: {
  authUserId: string;
  acceptance: LocationConsentInput;
}): Promise<LocationConsentMutationResult> => consentMutationSchema.parse(
  await rpc("accept_location_consent", {
    p_auth_user_id: input.authUserId,
    p_acceptance: input.acceptance,
  }),
);

export const changeLocationConsentState = async (input: {
  authUserId: string;
  state: "active" | "paused";
}): Promise<LocationConsentMutationResult> => consentMutationSchema.parse(
  await rpc("change_location_consent_state", {
    p_auth_user_id: input.authUserId,
    p_state: input.state,
  }),
);

export async function requestLocationWithdrawal(authUserId: string): Promise<z.infer<typeof withdrawalSchema>> {
  return withdrawalSchema.parse(await rpc("request_location_withdrawal", {
    p_auth_user_id: authUserId,
  }));
}

export async function listLocationUseFacts(input: {
  authUserId: string;
  limit: number;
  beforeCollectedAt: string | null;
  beforeId: number | null;
}): Promise<LocationFactListResult> {
  return factListSchema.parse(await rpc("list_location_use_facts", {
    p_auth_user_id: input.authUserId,
    p_limit: input.limit,
    p_before_collected_at: input.beforeCollectedAt,
    p_before_id: input.beforeId,
  }));
}

export async function listLocationCorrectionSubjects(input: {
  authUserId: string;
  limit: number;
  beforeAcquiredOnKst: string | null;
  beforeId: string | null;
}): Promise<LocationCorrectionSubjectListResult> {
  return correctionSubjectListSchema.parse(await rpc(
    "list_location_correction_subjects",
    {
      p_auth_user_id: input.authUserId,
      p_limit: input.limit,
      p_before_acquired_on_kst: input.beforeAcquiredOnKst,
      p_before_id: input.beforeId,
    },
  ));
}

export async function createLocationCorrection(input: {
  authUserId: string;
  correction: LocationCorrectionInput;
}): Promise<LocationCorrectionCreateResult> {
  return correctionCreateSchema.parse(await rpc("create_location_correction_request", {
    p_auth_user_id: input.authUserId,
    p_location_use_fact_id: "location_use_fact_id" in input.correction
      ? input.correction.location_use_fact_id
      : null,
    p_field_acquisition_id: "field_acquisition_id" in input.correction
      ? input.correction.field_acquisition_id
      : null,
    p_client_request_id: input.correction.client_request_id,
    p_reason: input.correction.reason,
  }));
}

export async function listOwnLocationCorrections(input: {
  authUserId: string;
  limit: number;
  beforeRequestedAt: string | null;
  beforeId: string | null;
}): Promise<LocationCorrectionListResult> {
  return correctionListSchema.parse(await rpc("list_own_location_corrections", {
    p_auth_user_id: input.authUserId,
    p_limit: input.limit,
    p_before_requested_at: input.beforeRequestedAt,
    p_before_id: input.beforeId,
  }));
}
