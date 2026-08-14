import { z } from "zod";

import { ApiError } from "@/server/http/api-error";

const blockMutationSchema = z.object({
  client_action_id: z.uuid(),
}).strict();

const blockIdSchema = z.uuid();
const decimalLimitSchema = z.string().regex(/^[1-9][0-9]{0,2}$/u).transform(Number)
  .pipe(z.number().int().min(1).max(100));

export type BlockMutationInput = z.infer<typeof blockMutationSchema>;
export type BlockListQuery = { limit: number; cursor?: string };

export function parseBlockMutationInput(value: unknown): BlockMutationInput {
  const result = blockMutationSchema.safeParse(value);
  if (!result.success) throw new ApiError("VALIDATION_FAILED");
  return result.data;
}

export function parseBlockId(value: string): string {
  const result = blockIdSchema.safeParse(value);
  if (!result.success) throw new ApiError("NOT_FOUND");
  return result.data;
}

export function parseBlockListQuery(url: string): BlockListQuery {
  const parameters = new URL(url).searchParams;
  if (parameters.getAll("limit").length > 1 || parameters.getAll("cursor").length > 1) {
    throw new ApiError("VALIDATION_FAILED");
  }
  const rawLimit = parameters.get("limit");
  const parsedLimit = rawLimit === null ? 50 : decimalLimitSchema.safeParse(rawLimit);
  if (typeof parsedLimit !== "number" && !parsedLimit.success) {
    throw new ApiError("VALIDATION_FAILED");
  }
  const cursor = parameters.get("cursor");
  if (cursor !== null && (cursor.length < 1 || cursor.length > 1_024)) {
    throw new ApiError("VALIDATION_FAILED");
  }
  return {
    limit: typeof parsedLimit === "number" ? parsedLimit : parsedLimit.data,
    ...(cursor === null ? {} : { cursor }),
  };
}
