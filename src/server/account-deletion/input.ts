import { z } from "zod";

import { ApiError } from "@/server/http/api-error";

const base64Url32ByteSecret = z.string()
  .regex(/^[A-Za-z0-9_-]{43}$/u)
  .refine((value) => {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length === 32 && decoded.toString("base64url") === value;
  });

const uuidV4 = z.uuid().refine(
  (value) => value[14]?.toLowerCase() === "4",
  { message: "UUID v4 required" },
);

const deletionRequestSchema = z.object({
  client_request_id: uuidV4,
  status_token: base64Url32ByteSecret,
  confirmation: z.literal("DELETE_MY_ACCOUNT"),
}).strict();

const recoveryDeletionRequestSchema = deletionRequestSchema.extend({
  recovery_code: base64Url32ByteSecret,
}).strict();

const deletionStatusTokenSchema = base64Url32ByteSecret;
const deletionRequestIdSchema = uuidV4;

export type DeletionRequestInput = z.infer<typeof deletionRequestSchema>;
export type RecoveryDeletionRequestInput = z.infer<typeof recoveryDeletionRequestSchema>;

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError("VALIDATION_FAILED");
  }
  return result.data;
}

export function parseDeletionRequestInput(value: unknown): DeletionRequestInput {
  return parseOrThrow(deletionRequestSchema, value);
}

export function parseRecoveryDeletionRequestInput(
  value: unknown,
): RecoveryDeletionRequestInput {
  return parseOrThrow(recoveryDeletionRequestSchema, value);
}

export function parseDeletionStatusToken(value: string | null): string {
  return parseOrThrow(deletionStatusTokenSchema, value);
}

export function parseDeletionRequestId(value: string): string {
  return parseOrThrow(deletionRequestIdSchema, value);
}
