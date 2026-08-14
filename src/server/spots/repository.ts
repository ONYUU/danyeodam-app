import "server-only";

import {
  publicSpotsResultSchema,
  type PublicSpotsResult,
} from "@/server/spots/db-contract";
import { getServiceClient } from "@/server/supabase/service";

export class SpotsRepositoryError extends Error {
  constructor() {
    super("Spots repository operation failed");
    this.name = "SpotsRepositoryError";
  }
}

export async function listPublicSpots(): Promise<PublicSpotsResult> {
  const { data, error } = await getServiceClient()
    .schema("api_private")
    .rpc("list_public_spots");
  if (error !== null) {
    throw new SpotsRepositoryError();
  }
  return publicSpotsResultSchema.parse(data);
}
