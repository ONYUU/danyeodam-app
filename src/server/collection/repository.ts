import "server-only";

import {
  collectionResultSchema,
  type CollectionResult,
} from "@/server/collection/db-contract";
import { throwIfAuthenticatedRateLimited } from "@/server/rate-limit/authenticated";
import { getServiceClient } from "@/server/supabase/service";

export class CollectionRepositoryError extends Error {
  constructor() {
    super("Collection repository operation failed");
    this.name = "CollectionRepositoryError";
  }
}

export async function getUserCollection(input: {
  authUserId: string;
  limit: number;
  beforeAcquiredAt: string | null;
  beforeAcquisitionId: string | null;
}): Promise<CollectionResult> {
  const { data, error } = await getServiceClient()
    .schema("api_private")
    .rpc("get_user_collection", {
      p_auth_user_id: input.authUserId,
      p_limit: input.limit,
      p_before_acquired_at: input.beforeAcquiredAt,
      p_before_acquisition_id: input.beforeAcquisitionId,
    });
  if (error !== null) {
    throw new CollectionRepositoryError();
  }
  throwIfAuthenticatedRateLimited(data);
  return collectionResultSchema.parse(data);
}
