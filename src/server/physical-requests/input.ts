import { z } from "zod";

import { ApiError } from "@/server/http/api-error";

const physicalRequestSchema = z.object({
  kind: z.enum(["request", "notify"]),
}).strict();

export type PhysicalRequestInput = z.infer<typeof physicalRequestSchema>;

export function parsePhysicalRequestInput(value: unknown): PhysicalRequestInput {
  const result = physicalRequestSchema.safeParse(value);
  if (!result.success) {
    throw new ApiError("VALIDATION_FAILED");
  }
  return result.data;
}
