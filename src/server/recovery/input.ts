import { z } from "zod";

import { ApiError } from "@/server/http/api-error";

const claimRecoveryInputSchema = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

export type ClaimRecoveryInput = z.infer<typeof claimRecoveryInputSchema>;

export function parseClaimRecoveryInput(value: unknown): ClaimRecoveryInput {
  const result = claimRecoveryInputSchema.safeParse(value);
  if (!result.success) {
    throw new ApiError("VALIDATION_FAILED");
  }
  return result.data;
}
