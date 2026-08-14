import { z } from "zod";

import { ApiError } from "@/server/http/api-error";

const acquireInputSchema = z
  .object({
    spot_id: z.uuid(),
    lat: z.number().finite().min(-90).max(90),
    lng: z.number().finite().min(-180).max(180),
    accuracy: z.number().finite().min(0).max(50_000),
    idempotency_key: z.uuid(),
  })
  .strict();

export type AcquireInput = z.infer<typeof acquireInputSchema>;

export function parseAcquireInput(value: unknown): AcquireInput {
  const result = acquireInputSchema.safeParse(value);
  if (!result.success) {
    throw new ApiError("VALIDATION_FAILED");
  }
  return result.data;
}
