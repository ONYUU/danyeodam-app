import { z } from "zod";

import { ApiError } from "@/server/http/api-error";

const shareSecretSchema = z.string().regex(/^[A-Za-z0-9]{22,128}$/u);
const clientActionIdSchema = z.uuid();
const reportReasonSchema = z.enum([
  "sexual_content",
  "violence",
  "hate_or_harassment",
  "privacy",
  "copyright",
  "spam",
  "illegal",
  "other",
]);

const secretOnlySchema = z.object({
  share_secret: shareSecretSchema,
}).strict();

const reportSchema = z.object({
  share_secret: shareSecretSchema,
  client_report_id: z.uuid(),
  target: z.enum(["content", "user"]),
  reason: reportReasonSchema,
  comment: z.string().trim().min(1).max(300).optional(),
}).strict();

const blockSchema = z.object({
  share_secret: shareSecretSchema,
  client_action_id: clientActionIdSchema,
}).strict();

export const PUBLIC_SHARE_AGE_ATTESTATION_VERSION = "dob-18-v1";
export const PUBLIC_SHARE_REPORT_MAXIMUM_BYTES = 4_096;

const ageAttestationSchema = z.object({
  pass: z.boolean(),
  version: z.literal(PUBLIC_SHARE_AGE_ATTESTATION_VERSION),
}).strict();

export type PublicShareReportInput = {
  shareSecret: string;
  report: {
    client_report_id: string;
    target: "content" | "user";
    reason: z.infer<typeof reportReasonSchema>;
    comment?: string;
  };
};

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError("VALIDATION_FAILED");
  }
  return result.data;
}

export function parsePublicShareSecretInput(value: unknown): string {
  return parseOrThrow(secretOnlySchema, value).share_secret;
}

export function parsePublicShareReportInput(value: unknown): PublicShareReportInput {
  const parsed = parseOrThrow(reportSchema, value);
  return {
    shareSecret: parsed.share_secret,
    report: {
      client_report_id: parsed.client_report_id,
      target: parsed.target,
      reason: parsed.reason,
      ...(parsed.comment === undefined ? {} : { comment: parsed.comment }),
    },
  };
}

export function parsePublicShareBlockInput(value: unknown): {
  shareSecret: string;
  clientActionId: string;
} {
  const parsed = parseOrThrow(blockSchema, value);
  return {
    shareSecret: parsed.share_secret,
    clientActionId: parsed.client_action_id,
  };
}

export function parseAgeAttestationInput(value: unknown): {
  pass: boolean;
  version: typeof PUBLIC_SHARE_AGE_ATTESTATION_VERSION;
} {
  return parseOrThrow(ageAttestationSchema, value);
}
