import { z } from "zod";

import { ApiError } from "@/server/http/api-error";

const normalizedUuidSchema = z.uuid().transform((value) => value.toLowerCase());

const spotPropertiesSchema = z.object({
  spot_id: normalizedUuidSchema,
}).strict();

const emptyPropertiesSchema = z.object({}).strict();

const clientEventSchema = z.discriminatedUnion("name", [
  z.object({
    client_event_id: normalizedUuidSchema,
    name: z.literal("spot_view"),
    ts: z.iso.datetime({ offset: true }),
    props: spotPropertiesSchema,
  }).strict(),
  z.object({
    client_event_id: normalizedUuidSchema,
    name: z.literal("physical_interest_view"),
    ts: z.iso.datetime({ offset: true }),
    props: emptyPropertiesSchema,
  }).strict(),
]);

const eventBatchSchema = z.object({
  events: z.array(clientEventSchema).min(1).max(20),
}).strict();

export type ClientEventBatch = z.infer<typeof eventBatchSchema>;

export type ClientEventRecord = {
  client_event_id: string;
  event_name: "spot_view" | "physical_interest_view";
  occurred_at: string;
  spot_id: string | null;
  properties: Record<string, string>;
};

const maximumPastAgeMilliseconds = 24 * 60 * 60 * 1_000;
const maximumFutureSkewMilliseconds = 5 * 60 * 1_000;

export function parseClientEventBatch(
  value: unknown,
  now = new Date(),
): ClientEventRecord[] {
  const parsed = eventBatchSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError("VALIDATION_FAILED");
  }

  const nowMilliseconds = now.getTime();
  const records = parsed.data.events.map((event): ClientEventRecord => {
    const occurredAt = new Date(event.ts).getTime();
    if (
      occurredAt < nowMilliseconds - maximumPastAgeMilliseconds
      || occurredAt > nowMilliseconds + maximumFutureSkewMilliseconds
    ) {
      throw new ApiError("VALIDATION_FAILED");
    }

    const spotId = "spot_id" in event.props ? event.props.spot_id : null;
    return {
      client_event_id: event.client_event_id,
      event_name: event.name,
      occurred_at: event.ts,
      spot_id: spotId,
      properties: event.props,
    };
  });

  return records;
}
