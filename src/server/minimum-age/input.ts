import { z } from "zod";

import { ApiError } from "@/server/http/api-error";

const inputSchema = z.object({
  minimum_age_passed: z.literal(true),
  version: z.literal("18plus-v1"),
}).strict();

export type MinimumAgeAttestationInput = z.infer<typeof inputSchema>;

export function parseMinimumAgeAttestationInput(value: unknown): MinimumAgeAttestationInput {
  const result = inputSchema.safeParse(value);
  if (!result.success) throw new ApiError("VALIDATION_FAILED");
  return result.data;
}
