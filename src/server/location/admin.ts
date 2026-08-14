import "server-only";

import { z } from "zod";

import { ApiError } from "@/server/http/api-error";
import { throwIfAuthenticatedRateLimited } from "@/server/rate-limit/authenticated";
import { getServiceClient } from "@/server/supabase/service";

const itemSchema = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  location_use_fact_id: z.number().int().positive().nullable(),
  field_acquisition_id: z.uuid().nullable(),
  reason: z.enum(["not_my_visit", "wrong_spot", "incorrect_outcome", "other"]),
  status: z.enum(["open", "approved_pending_correction", "corrected", "rejected"]),
  requested_at: z.iso.datetime({ offset: true }),
  resolved_at: z.iso.datetime({ offset: true }).nullable(),
}).strict();
const listSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), items: z.array(itemSchema).max(100) }).strict(),
  z.object({ status: z.literal("forbidden") }).strict(),
  z.object({ status: z.literal("invalid") }).strict(),
]);
const resolveSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("correction_pending"), erasure_job_id: z.uuid() }).strict(),
  z.object({ status: z.literal("corrected"), erasure_job_id: z.uuid().nullable() }).strict(),
  z.object({ status: z.enum(["rejected", "duplicate"]) }).strict(),
  z.object({ status: z.literal("unauthorized") }).strict(),
  z.object({ status: z.literal("forbidden") }).strict(),
  z.object({ status: z.literal("invalid") }).strict(),
  z.object({ status: z.literal("not_found") }).strict(),
  z.object({ status: z.literal("conflict") }).strict(),
  z.object({ status: z.literal("location_withdrawal_pending") }).strict(),
]);

async function rpc(name: string, parameters: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await getServiceClient().schema("api_private").rpc(name, parameters);
  if (error !== null) throw new ApiError("INTERNAL");
  return data;
}

export async function readLocationCorrectionQueue(input: {
  adminAuthUserId: string;
  status: "open" | "approved_pending_correction" | "corrected" | "rejected";
  limit: number;
}): Promise<z.infer<typeof itemSchema>[]> {
  const result = listSchema.parse(await rpc("list_location_corrections_admin", {
    p_admin_auth_user_id: input.adminAuthUserId,
    p_status: input.status,
    p_limit: input.limit,
  }));
  if (result.status === "ready") return result.items;
  if (result.status === "forbidden") throw new ApiError("FORBIDDEN");
  throw new ApiError("VALIDATION_FAILED");
}

export async function resolveLocationCorrection(input: {
  adminAuthUserId: string;
  correctionRequestId: string;
  resolution: "accepted" | "rejected";
}): Promise<{
  status: "correction_pending" | "corrected" | "rejected" | "duplicate";
  erasure_job_id: string | null;
}> {
  const rawResult = await rpc("resolve_location_correction_admin", {
    p_admin_auth_user_id: input.adminAuthUserId,
    p_correction_request_id: input.correctionRequestId,
    p_resolution: input.resolution,
  });
  throwIfAuthenticatedRateLimited(rawResult);
  const result = resolveSchema.parse(rawResult);
  if (result.status === "correction_pending" || result.status === "corrected") {
    return { status: result.status, erasure_job_id: result.erasure_job_id };
  }
  if (result.status === "rejected" || result.status === "duplicate") {
    return { status: result.status, erasure_job_id: null };
  }
  if (result.status === "unauthorized") throw new ApiError("UNAUTHORIZED");
  if (result.status === "forbidden") throw new ApiError("FORBIDDEN");
  if (result.status === "not_found") throw new ApiError("NOT_FOUND");
  if (result.status === "conflict") throw new ApiError("MODERATION_CONFLICT");
  if (result.status === "location_withdrawal_pending") {
    throw new ApiError("LOCATION_WITHDRAWAL_PENDING");
  }
  throw new ApiError("VALIDATION_FAILED");
}
