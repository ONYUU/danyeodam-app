import { z } from "zod";

import { ApiError } from "@/server/http/api-error";

const reasonCodeSchema = z.string().trim().regex(/^[A-Z0-9_]{1,64}$/);
const noteSchema = z.string().trim().min(1).max(500);

const shareActionSchema = z.object({
  action: z.enum([
    "approve",
    "reject",
    "take_down",
    "reinstate",
    "suspend_owner",
  ]),
  client_action_id: z.uuid(),
  reason_code: reasonCodeSchema,
  note: noteSchema,
}).strict();

const reportActionSchema = z.object({
  action: z.enum(["dismiss", "take_down", "suspend_owner"]),
  client_action_id: z.uuid(),
  reason_code: reasonCodeSchema,
  note: noteSchema,
}).strict();

const suspensionActionSchema = z.object({
  action: z.literal("unsuspend_owner"),
  client_action_id: z.uuid(),
  reason_code: reasonCodeSchema,
  note: noteSchema,
}).strict();

const moderationIdSchema = z.uuid();
const moderationLimitSchema = z.coerce.number().int().min(1).max(100);
const shareQueueStatusSchema = z.enum(["pending", "active", "rejected", "taken_down"]);
const reportQueueStatusSchema = z.enum(["open", "resolved", "dismissed"]);
const suspensionQueueStatusSchema = z.enum(["active", "lifted"]);

export type ShareModerationActionInput = z.infer<typeof shareActionSchema>;
export type ReportModerationActionInput = z.infer<typeof reportActionSchema>;
export type SuspensionModerationActionInput = z.infer<typeof suspensionActionSchema>;

function parseOrValidationError<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError("VALIDATION_FAILED");
  }
  return result.data;
}

export function parseShareModerationAction(value: unknown): ShareModerationActionInput {
  return parseOrValidationError(shareActionSchema, value);
}

export function parseReportModerationAction(value: unknown): ReportModerationActionInput {
  return parseOrValidationError(reportActionSchema, value);
}

export function parseSuspensionModerationAction(value: unknown): SuspensionModerationActionInput {
  return parseOrValidationError(suspensionActionSchema, value);
}

export function parseModerationId(value: string): string {
  const result = moderationIdSchema.safeParse(value);
  if (!result.success) {
    throw new ApiError("NOT_FOUND");
  }
  return result.data;
}

export function parseShareQueueQuery(url: URL): { status: string; limit: number } {
  if ([...url.searchParams.keys()].some((key) => key !== "status" && key !== "limit")) {
    throw new ApiError("VALIDATION_FAILED");
  }
  return {
    status: parseOrValidationError(shareQueueStatusSchema, url.searchParams.get("status") ?? "pending"),
    limit: parseOrValidationError(moderationLimitSchema, url.searchParams.get("limit") ?? "50"),
  };
}

export function parseReportQueueQuery(url: URL): { status: string; limit: number } {
  if ([...url.searchParams.keys()].some((key) => key !== "status" && key !== "limit")) {
    throw new ApiError("VALIDATION_FAILED");
  }
  return {
    status: parseOrValidationError(reportQueueStatusSchema, url.searchParams.get("status") ?? "open"),
    limit: parseOrValidationError(moderationLimitSchema, url.searchParams.get("limit") ?? "50"),
  };
}

export function parseSuspensionQueueQuery(url: URL): { status: string; limit: number } {
  if ([...url.searchParams.keys()].some((key) => key !== "status" && key !== "limit")) {
    throw new ApiError("VALIDATION_FAILED");
  }
  return {
    status: parseOrValidationError(suspensionQueueStatusSchema, url.searchParams.get("status") ?? "active"),
    limit: parseOrValidationError(moderationLimitSchema, url.searchParams.get("limit") ?? "50"),
  };
}
