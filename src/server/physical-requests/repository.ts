import "server-only";

import { z } from "zod";

import { throwIfAuthenticatedRateLimited } from "@/server/rate-limit/authenticated";
import { getServiceClient } from "@/server/supabase/service";

const physicalRequestResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("created") }),
  z.object({ status: z.literal("duplicate") }),
  z.object({ status: z.literal("unauthorized") }),
  z.object({ status: z.literal("gate_closed") }),
]);

export type PhysicalRequestResult = z.infer<typeof physicalRequestResultSchema>;

class PhysicalRequestRepositoryError extends Error {
  constructor() {
    super("Physical request repository operation failed");
    this.name = "PhysicalRequestRepositoryError";
  }
}

export async function createPhysicalRequest(input: {
  authUserId: string;
  publicGateOpen: boolean;
  kind: "request" | "notify";
}): Promise<PhysicalRequestResult> {
  const { data, error } = await getServiceClient()
    .schema("api_private")
    .rpc("create_physical_request", {
      p_auth_user_id: input.authUserId,
      p_public_gate_open: input.publicGateOpen,
      p_kind: input.kind,
    });

  if (error !== null) {
    throw new PhysicalRequestRepositoryError();
  }
  throwIfAuthenticatedRateLimited(data);
  return physicalRequestResultSchema.parse(data);
}
