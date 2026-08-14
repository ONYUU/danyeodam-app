import { z } from "zod";

import { ApiError } from "@/server/http/api-error";

const decimalLimitSchema = z.string().regex(/^[1-9][0-9]{0,2}$/u).transform(Number)
  .pipe(z.number().int().min(1).max(100));

export type CollectionQuery = {
  limit: number;
  cursor?: string;
};

export function parseCollectionQuery(url: string): CollectionQuery {
  const parameters = new URL(url).searchParams;
  if (parameters.getAll("limit").length > 1 || parameters.getAll("cursor").length > 1) {
    throw new ApiError("VALIDATION_FAILED");
  }

  const rawLimit = parameters.get("limit");
  const limit = rawLimit === null ? 50 : decimalLimitSchema.safeParse(rawLimit);
  if (typeof limit !== "number" && !limit.success) {
    throw new ApiError("VALIDATION_FAILED");
  }

  const cursor = parameters.get("cursor");
  if (cursor !== null && (cursor.length < 1 || cursor.length > 1_024)) {
    throw new ApiError("VALIDATION_FAILED");
  }

  return {
    limit: typeof limit === "number" ? limit : limit.data,
    ...(cursor === null ? {} : { cursor }),
  };
}
