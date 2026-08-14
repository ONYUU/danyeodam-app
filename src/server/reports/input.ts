import { z } from "zod";

import { ApiError } from "@/server/http/api-error";

const contentReportInputSchema = z.object({
  client_report_id: z.uuid(),
  target: z.enum(["content", "user"]),
  reason: z.enum([
    "sexual_content",
    "violence",
    "hate_or_harassment",
    "privacy",
    "copyright",
    "spam",
    "illegal",
    "other",
  ]),
  comment: z.string().trim().min(1).max(300).optional(),
}).strict();

export type ContentReportInput = z.infer<typeof contentReportInputSchema>;

export function parseContentReportInput(value: unknown): ContentReportInput {
  const result = contentReportInputSchema.safeParse(value);
  if (!result.success) {
    throw new ApiError("VALIDATION_FAILED");
  }
  return result.data;
}
