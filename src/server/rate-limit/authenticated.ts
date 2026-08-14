import "server-only";

import { z } from "zod";

import { ApiError } from "@/server/http/api-error";

const authenticatedRateLimitedResultSchema = z.object({
  status: z.literal("rate_limited"),
  retry_after_seconds: z.number().int().min(1).max(60),
}).strict();

/**
 * Converts the one cross-domain result emitted by authenticated rate-aware
 * database wrappers before each repository applies its domain-specific schema.
 */
export function throwIfAuthenticatedRateLimited(data: unknown): void {
  if (
    data === null
    || typeof data !== "object"
    || !("status" in data)
    || data.status !== "rate_limited"
  ) {
    return;
  }

  const parsed = authenticatedRateLimitedResultSchema.safeParse(data);
  if (!parsed.success) {
    throw new ApiError("INTERNAL");
  }
  throw new ApiError("RATE_LIMITED", {
    retry_after_seconds: parsed.data.retry_after_seconds,
  });
}
