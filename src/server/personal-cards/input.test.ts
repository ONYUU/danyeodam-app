import { describe, expect, it } from "vitest";

import { ApiError } from "@/server/http/api-error";
import {
  MAX_PERSONAL_CARD_SOURCE_BYTES,
  parsePersonalCardDeletionInput,
  parsePersonalCardPromotionInput,
  parsePersonalCardUploadInput,
} from "@/server/personal-cards/input";

const userId = "11111111-1111-4111-8111-111111111111";
const uploadId = "22222222-2222-4222-8222-222222222222";
const clientRequestId = "33333333-3333-4333-8333-333333333333";

describe("personal card input", () => {
  it("accepts the three contract image types at the byte limit", () => {
    for (const content_type of ["image/jpeg", "image/png", "image/webp"] as const) {
      expect(parsePersonalCardUploadInput({
        content_type,
        size: MAX_PERSONAL_CARD_SOURCE_BYTES,
        client_request_id: clientRequestId,
      })).toEqual({
        content_type,
        size: MAX_PERSONAL_CARD_SOURCE_BYTES,
        client_request_id: clientRequestId,
      });
    }
  });

  it("rejects unsupported, fractional, empty, oversized, and excess upload fields", () => {
    for (const value of [
      { content_type: "image/gif", size: 1, client_request_id: clientRequestId },
      { content_type: "image/jpeg", size: 1.5, client_request_id: clientRequestId },
      { content_type: "image/jpeg", size: 0, client_request_id: clientRequestId },
      {
        content_type: "image/jpeg",
        size: MAX_PERSONAL_CARD_SOURCE_BYTES + 1,
        client_request_id: clientRequestId,
      },
      { content_type: "image/jpeg", size: 1 },
      { content_type: "image/jpeg", size: 1, client_request_id: "not-a-uuid" },
      {
        content_type: "image/jpeg",
        size: 1,
        client_request_id: clientRequestId,
        path: "client/path.jpg",
      },
    ]) {
      expect(() => parsePersonalCardUploadInput(value)).toThrow(ApiError);
    }
  });

  it("accepts only a strict UUID personal-card deletion key", () => {
    expect(parsePersonalCardDeletionInput({ client_request_id: clientRequestId }))
      .toEqual({ client_request_id: clientRequestId });
    expect(() => parsePersonalCardDeletionInput({ client_request_id: "bad" }))
      .toThrow(ApiError);
    expect(() => parsePersonalCardDeletionInput({
      client_request_id: clientRequestId,
      personal_card_id: uploadId,
    })).toThrow(ApiError);
  });

  it("accepts an owned temporary path and defaults the caption", () => {
    expect(parsePersonalCardPromotionInput({
      acquisition_id: "33333333-3333-4333-8333-333333333333",
      temp_path: `${userId}/${uploadId}.jpg`,
    })).toEqual({
      acquisition_id: "33333333-3333-4333-8333-333333333333",
      temp_path: `${userId}/${uploadId}.jpg`,
      caption: "",
    });
  });

  it("rejects traversal, non-canonical paths, overlong captions, and excess fields", () => {
    for (const value of [
      {
        acquisition_id: "33333333-3333-4333-8333-333333333333",
        temp_path: `${userId}/../${uploadId}.jpg`,
        caption: "",
      },
      {
        acquisition_id: "33333333-3333-4333-8333-333333333333",
        temp_path: "client-selected.jpg",
        caption: "",
      },
      {
        acquisition_id: "33333333-3333-4333-8333-333333333333",
        temp_path: `${userId}/${uploadId}.jpg`,
        caption: "a".repeat(61),
      },
      {
        acquisition_id: "33333333-3333-4333-8333-333333333333",
        temp_path: `${userId}/${uploadId}.jpg`,
        caption: "",
        user_id: userId,
      },
    ]) {
      expect(() => parsePersonalCardPromotionInput(value)).toThrow(ApiError);
    }
  });
});
