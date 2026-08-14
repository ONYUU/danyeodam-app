import { describe, expect, it } from "vitest";

import { parseClientEventBatch } from "@/server/events/input";

const now = new Date("2026-08-08T12:00:00.000Z");
const clientEventId = "00000000-0000-4000-8000-000000000301";
const spotId = "00000000-0000-4000-8000-000000000101";

describe("parseClientEventBatch", () => {
  it("maps a strict spot event without adding location data", () => {
    expect(parseClientEventBatch({
      events: [{
        client_event_id: clientEventId,
        name: "spot_view",
        ts: "2026-08-08T11:59:00.000Z",
        props: { spot_id: spotId },
      }],
    }, now)).toEqual([{
      client_event_id: clientEventId,
      event_name: "spot_view",
      occurred_at: "2026-08-08T11:59:00.000Z",
      spot_id: spotId,
      properties: { spot_id: spotId },
    }]);
  });

  it("accepts the property-free physical-interest view", () => {
    expect(parseClientEventBatch({
      events: [{
        client_event_id: clientEventId,
        name: "physical_interest_view",
        ts: "2026-08-08T12:00:00.000Z",
        props: {},
      }],
    }, now)[0]?.spot_id).toBeNull();
  });

  it("normalizes UUID casing before the database compares JSON properties", () => {
    const upperSpotId = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
    const [event] = parseClientEventBatch({
      events: [{
        client_event_id: "AAAAAAAA-BBBB-4CCC-8DDD-FFFFFFFFFFFF",
        name: "spot_view",
        ts: "2026-08-08T12:00:00.000Z",
        props: { spot_id: upperSpotId },
      }],
    }, now);

    expect(event).toMatchObject({
      client_event_id: "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff",
      spot_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      properties: { spot_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
    });
  });

  it.each([
    "landing_view",
    "share_view",
    "acquire_success",
    "acquire_fail",
    "personal_card_created",
    "acquire_attempt",
    "personal_card_started",
  ])("rejects retired or server-only event %s", (name) => {
    expect(() => parseClientEventBatch({
      events: [{
        client_event_id: clientEventId,
        name,
        ts: "2026-08-08T12:00:00.000Z",
        props: {},
      }],
    }, now)).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("rejects arbitrary, nested, or location properties", () => {
    expect(() => parseClientEventBatch({
      events: [{
        client_event_id: clientEventId,
        name: "spot_view",
        ts: "2026-08-08T12:00:00.000Z",
        props: { spot_id: spotId, location: { lat: 37.5 } },
      }],
    }, now)).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("keeps duplicate ids for the database idempotency boundary to count", () => {
    const event = {
      client_event_id: clientEventId,
      name: "physical_interest_view",
      ts: "2026-08-08T12:00:00.000Z",
      props: {},
    };
    expect(parseClientEventBatch({ events: [event, event] }, now)).toHaveLength(2);
  });

  it("rejects timestamps outside the accepted Stage 0 window", () => {
    for (const ts of ["2026-08-07T11:59:59.000Z", "2026-08-08T12:05:01.000Z"]) {
      expect(() => parseClientEventBatch({
        events: [{
          client_event_id: clientEventId,
          name: "physical_interest_view",
          ts,
          props: {},
        }],
      }, now)).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    }
  });

  it("enforces the batch maximum", () => {
    const events = Array.from({ length: 21 }, (_, index) => ({
      client_event_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      name: "physical_interest_view",
      ts: "2026-08-08T12:00:00.000Z",
      props: {},
    }));
    expect(() => parseClientEventBatch({ events }, now)).toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });
});
