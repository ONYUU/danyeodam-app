import "server-only";

import { z } from "zod";

import { getServiceClient } from "@/server/supabase/service";

const landingReferenceSchema = z.enum(["sns", "share", "direct"]);
const recordLandingResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("recorded") }),
  z.object({ status: z.literal("invalid") }),
]);

export type LandingReference = z.infer<typeof landingReferenceSchema>;

export class PublicEventRepositoryError extends Error {
  constructor() {
    super("Public event repository operation failed");
    this.name = "PublicEventRepositoryError";
  }
}

export function normalizeLandingReference(
  value: string | string[] | undefined,
): LandingReference {
  const candidate = Array.isArray(value) ? value[0] : value;
  const result = landingReferenceSchema.safeParse(candidate);
  return result.success ? result.data : "direct";
}

export async function recordLandingView(reference: LandingReference): Promise<void> {
  const { data, error } = await getServiceClient()
    .schema("api_private")
    .rpc("record_landing_view", { p_ref: reference });

  if (error !== null) {
    throw new PublicEventRepositoryError();
  }
  const result = recordLandingResultSchema.parse(data);
  if (result.status !== "recorded") {
    throw new PublicEventRepositoryError();
  }
}
