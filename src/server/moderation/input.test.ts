import { describe, expect, it } from "vitest";

import {
  parseShareModerationAction,
  parseSuspensionModerationAction,
  parseSuspensionQueueQuery,
} from "@/server/moderation/input";

describe("moderation suspension input", () => {
  const base = {
    client_action_id: "11111111-1111-4111-8111-111111111111",
    reason_code: "MANUAL_REVIEW",
    note: "reviewed",
  };

  it("keeps unsuspension card-independent", () => {
    expect(() => parseShareModerationAction({ action: "unsuspend_owner", ...base })).toThrow();
    expect(parseSuspensionModerationAction({ action: "unsuspend_owner", ...base }))
      .toEqual({ action: "unsuspend_owner", ...base });
  });

  it("accepts only active or lifted suspension queues", () => {
    expect(parseSuspensionQueueQuery(new URL("https://example.test?status=lifted&limit=10")))
      .toEqual({ status: "lifted", limit: 10 });
    expect(() => parseSuspensionQueueQuery(new URL("https://example.test?status=all"))).toThrow();
  });
});
