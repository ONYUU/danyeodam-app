import { z } from "zod";

import { ApiError } from "@/server/http/api-error";

const adminListStatusSchema = z.enum([
  "active",
  "pending",
  "processing",
  "completed",
  "all",
]);
const adminListLimitSchema = z.string()
  .regex(/^(?:[1-9]|[1-9][0-9]|100)$/u)
  .transform(Number);
const adminRetrySchema = z.object({
  action: z.literal("retry"),
  client_action_id: z.uuid(),
  reason_code: z.enum([
    "OVERDUE",
    "TRANSIENT_FAILURE",
    "WORKER_STALLED",
    "MANUAL_REVIEW",
  ]),
  note: z.string().trim().min(1).max(500),
}).strict();
const deletionRequestIdSchema = z.uuid();

export type AccountDeletionAdminListStatus = z.infer<typeof adminListStatusSchema>;
export type AccountDeletionAdminRetryInput = z.infer<typeof adminRetrySchema>;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError("VALIDATION_FAILED");
  return result.data;
}

export function parseAccountDeletionAdminListQuery(url: URL): {
  status: AccountDeletionAdminListStatus;
  limit: number;
} {
  const entries = [...url.searchParams.entries()];
  if (
    entries.some(([key]) => key !== "status" && key !== "limit")
    || new Set(entries.map(([key]) => key)).size !== entries.length
  ) {
    throw new ApiError("VALIDATION_FAILED");
  }

  return {
    status: parse(
      adminListStatusSchema,
      url.searchParams.get("status") ?? "active",
    ),
    limit: parse(adminListLimitSchema, url.searchParams.get("limit") ?? "50"),
  };
}

export function parseAccountDeletionAdminRetryInput(
  value: unknown,
): AccountDeletionAdminRetryInput {
  return parse(adminRetrySchema, value);
}

export function parseAccountDeletionAdminRequestId(value: string): string {
  const result = deletionRequestIdSchema.safeParse(value);
  if (!result.success) throw new ApiError("NOT_FOUND");
  return result.data;
}
