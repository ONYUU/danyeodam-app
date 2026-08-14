import { z } from "zod";

import { ApiError } from "@/server/http/api-error";

const decimalLimitSchema = z.string().regex(/^[1-9][0-9]{0,2}$/u).transform(Number)
  .pipe(z.number().int().min(1).max(100));
const resourceIdSchema = z.uuid();
const uuidV4Schema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
);
const openInputSchema = z.object({
  client_request_id: uuidV4Schema,
}).strict();

export type BonusPackPageQuery = {
  limit: number;
  cursor?: string;
};

export type OpenBonusPackInput = z.infer<typeof openInputSchema>;

function parsePageQuery(url: string): BonusPackPageQuery {
  const parameters = new URL(url).searchParams;
  if ([...parameters.keys()].some((key) => key !== "limit" && key !== "cursor")) {
    throw new ApiError("VALIDATION_FAILED");
  }
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

export function parseBonusPackListQuery(url: string): BonusPackPageQuery {
  return parsePageQuery(url);
}

export function parseCardInventoryQuery(url: string): BonusPackPageQuery {
  return parsePageQuery(url);
}

export function assertNoQueryParameters(url: string): void {
  if ([...new URL(url).searchParams.keys()].length !== 0) {
    throw new ApiError("VALIDATION_FAILED");
  }
}

export function parseBonusPackId(value: string): string {
  const result = resourceIdSchema.safeParse(value);
  if (!result.success) throw new ApiError("NOT_FOUND");
  return result.data;
}

export function parseSpecialCardId(value: string): string {
  const result = resourceIdSchema.safeParse(value);
  if (!result.success) throw new ApiError("NOT_FOUND");
  return result.data;
}

export function parseOpenBonusPackInput(value: unknown): OpenBonusPackInput {
  const result = openInputSchema.safeParse(value);
  if (!result.success) throw new ApiError("VALIDATION_FAILED");
  return result.data;
}
