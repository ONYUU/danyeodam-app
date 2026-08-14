import { describe, expect, it } from "vitest";

import { ApiError } from "@/server/http/api-error";
import {
  parseReviewerAppUserId,
  parseReviewerLifecycleActionInput,
  parseReviewerProvisionInput,
} from "@/server/reviewer-access/input";

const appUserId = "11111111-1111-4111-8111-111111111111";
const clientActionId = "22222222-2222-4222-8222-222222222222";

describe("reviewer lifecycle input", () => {
  it("accepts the bounded provision contract", () => {
    expect(parseReviewerProvisionInput({
      app_user_id: appUserId,
      store_platform: "app_store",
      fixture_version: "app-store-2026.08.1",
      client_action_id: clientActionId,
    })).toEqual({
      app_user_id: appUserId,
      store_platform: "app_store",
      fixture_version: "app-store-2026.08.1",
      client_action_id: clientActionId,
    });
  });

  it("rejects credentials and identifying extras from the route body", () => {
    expect(() => parseReviewerProvisionInput({
      app_user_id: appUserId,
      store_platform: "play_store",
      fixture_version: "play-store-2026.08.1",
      client_action_id: clientActionId,
      email: "must-not-enter-this-api@example.test",
      password: "must-not-enter-this-api",
    })).toThrow(ApiError);
  });

  it("keeps reset and revoke bodies to one idempotency key", () => {
    expect(parseReviewerLifecycleActionInput({
      client_action_id: clientActionId,
    })).toEqual({ client_action_id: clientActionId });
    expect(() => parseReviewerLifecycleActionInput({
      client_action_id: clientActionId,
      fixture_version: "not-accepted",
    })).toThrow(ApiError);
  });

  it("maps an invalid path identifier to non-enumerating not found", () => {
    try {
      parseReviewerAppUserId("not-a-uuid");
      throw new Error("expected parser to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("NOT_FOUND");
    }
  });
});
