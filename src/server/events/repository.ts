import "server-only";

import { z } from "zod";

import type { ClientEventRecord } from "@/server/events/input";
import { throwIfAuthenticatedRateLimited } from "@/server/rate-limit/authenticated";
import { getServiceClient } from "@/server/supabase/service";

const ingestionResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("accepted"),
    accepted: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
  }),
  z.object({ status: z.literal("unauthorized") }),
  z.object({ status: z.literal("gate_closed") }),
  z.object({ status: z.literal("invalid") }),
]);

export type EventIngestionResult = z.infer<typeof ingestionResultSchema>;

class EventRepositoryError extends Error {
  constructor() {
    super("Event repository operation failed");
    this.name = "EventRepositoryError";
  }
}

export async function ingestClientEvents(input: {
  authUserId: string;
  publicGateOpen: boolean;
  events: ClientEventRecord[];
}): Promise<EventIngestionResult> {
  const { data, error } = await getServiceClient()
    .schema("api_private")
    .rpc("ingest_client_events", {
      p_auth_user_id: input.authUserId,
      p_public_gate_open: input.publicGateOpen,
      p_events: input.events,
    });

  if (error !== null) {
    throw new EventRepositoryError();
  }
  throwIfAuthenticatedRateLimited(data);
  return ingestionResultSchema.parse(data);
}
