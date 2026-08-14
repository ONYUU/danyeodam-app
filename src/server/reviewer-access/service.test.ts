import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/server/http/api-error";
import {
  provisionReviewerAccess,
  resetReviewerAccess,
  revokeReviewerAccess,
  type ReviewerAccessDependencies,
} from "@/server/reviewer-access/service";

const adminAuthUserId = "11111111-1111-4111-8111-111111111111";
const appUserId = "22222222-2222-4222-8222-222222222222";
const clientActionId = "33333333-3333-4333-8333-333333333333";
const photoObjectId = "44444444-4444-4444-8444-444444444444";
const oldObjectId = "55555555-5555-4555-8555-555555555555";
const sha256Hex = "a".repeat(64);

function applied(previousPhotoObjectId: string | null = null) {
  return {
    status: "applied" as const,
    store_platform: "app_store" as const,
    fixture_version: "fixture-v1",
    retro_count: 6 as const,
    personal_card_count: 1 as const,
    active_share_count: 1 as const,
    fixture_hash: "b".repeat(64),
    photo_object_id: photoObjectId,
    photo_sha256: sha256Hex,
    photo_size_bytes: 3,
    previous_photo_object_id: previousPhotoObjectId,
  };
}

describe("reviewer lifecycle orchestration", () => {
  let dependencies: ReviewerAccessDependencies;

  beforeEach(() => {
    dependencies = {
      sample: vi.fn().mockResolvedValue({
        bytes: Uint8Array.from([1, 2, 3]),
        sha256Hex,
        sizeBytes: 3,
      }),
      prepareProvision: vi.fn().mockResolvedValue({
        status: "prepared",
        action: "provision",
        store_platform: "app_store",
        fixture_version: "fixture-v1",
        photo_object_id: photoObjectId,
        photo_size_bytes: 3,
        photo_sha256: sha256Hex,
        old_photo_object_ids: [],
      }),
      prepareReset: vi.fn().mockResolvedValue({
        status: "prepared",
        action: "reset",
        store_platform: "app_store",
        fixture_version: "fixture-v1",
        photo_object_id: photoObjectId,
        photo_size_bytes: 3,
        photo_sha256: sha256Hex,
        old_photo_object_ids: [oldObjectId],
      }),
      complete: vi.fn().mockResolvedValue(applied(oldObjectId)),
      install: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      revoke: vi.fn().mockResolvedValue({
        status: "revoked",
        participant_rows: 1,
        identity_rows: 1,
        recovery_code_rows: 0,
        share_rows: 1,
        old_photo_object_ids: [photoObjectId],
      }),
    };
  });

  it("uploads the bound sample, completes atomically, and exposes no Storage path", async () => {
    await expect(provisionReviewerAccess({
      adminAuthUserId,
      appUserId,
      storePlatform: "app_store",
      fixtureVersion: "fixture-v1",
      clientActionId,
    }, dependencies)).resolves.toEqual({
      status: "applied",
      store_platform: "app_store",
      fixture_version: "fixture-v1",
      retro_count: 6,
      personal_card_count: 1,
      active_share_count: 1,
      fixture_hash: "b".repeat(64),
    });
    expect(dependencies.install).toHaveBeenCalledWith({
      path: `${appUserId}/${photoObjectId}.webp`,
      bytes: Uint8Array.from([1, 2, 3]),
      expectedSha256Hex: sha256Hex,
    });
    expect(dependencies.complete).toHaveBeenCalledWith({
      adminAuthUserId,
      appUserId,
      clientActionId,
      photoObjectId,
      photoSizeBytes: 3,
      photoSha256Hex: sha256Hex,
    });
  });

  it("reset deletes the previous object only after database completion", async () => {
    await resetReviewerAccess({ adminAuthUserId, appUserId, clientActionId }, dependencies);
    expect(dependencies.complete).toHaveBeenCalledBefore(
      dependencies.remove as ReturnType<typeof vi.fn>,
    );
    expect(dependencies.remove).toHaveBeenCalledWith([
      `${appUserId}/${oldObjectId}.webp`,
      `${appUserId}/${oldObjectId}.webp`,
    ]);
  });

  it("an exact completed retry skips upload and retries old-object cleanup", async () => {
    dependencies.prepareProvision = vi.fn().mockResolvedValue(applied(oldObjectId));
    await provisionReviewerAccess({
      adminAuthUserId,
      appUserId,
      storePlatform: "app_store",
      fixtureVersion: "fixture-v1",
      clientActionId,
    }, dependencies);
    expect(dependencies.install).not.toHaveBeenCalled();
    expect(dependencies.complete).not.toHaveBeenCalled();
    expect(dependencies.remove).toHaveBeenCalledWith([
      `${appUserId}/${oldObjectId}.webp`,
    ]);
  });

  it("removes a late upload when revoke or deletion closes DB completion", async () => {
    const completionError = new ApiError("NOT_FOUND");
    dependencies.complete = vi.fn().mockRejectedValue(completionError);

    await expect(resetReviewerAccess({
      adminAuthUserId,
      appUserId,
      clientActionId,
    }, dependencies)).rejects.toBe(completionError);

    expect(dependencies.install).toHaveBeenCalledBefore(
      dependencies.complete as ReturnType<typeof vi.fn>,
    );
    expect(dependencies.remove).toHaveBeenCalledWith([
      `${appUserId}/${photoObjectId}.webp`,
    ]);
  });

  it("preserves an upload after an ambiguous completion transport failure", async () => {
    const completionError = new ApiError("INTERNAL");
    dependencies.complete = vi.fn().mockRejectedValue(completionError);

    await expect(resetReviewerAccess({
      adminAuthUserId,
      appUserId,
      clientActionId,
    }, dependencies)).rejects.toBe(completionError);

    expect(dependencies.remove).not.toHaveBeenCalled();
  });

  it("preserves an upload when a concurrent completed retry is rate limited", async () => {
    const completionError = new ApiError("RATE_LIMITED");
    dependencies.complete = vi.fn().mockRejectedValue(completionError);

    await expect(resetReviewerAccess({
      adminAuthUserId,
      appUserId,
      clientActionId,
    }, dependencies)).rejects.toBe(completionError);

    expect(dependencies.remove).not.toHaveBeenCalled();
  });

  it("revoke closes DB state before best-effort-object cleanup retry", async () => {
    await expect(revokeReviewerAccess({
      adminAuthUserId,
      appUserId,
      clientActionId,
    }, dependencies)).resolves.toEqual({
      status: "revoked",
      participant_rows: 1,
      identity_rows: 1,
      recovery_code_rows: 0,
      share_rows: 1,
    });
    expect(dependencies.remove).toHaveBeenCalledWith([
      `${appUserId}/${photoObjectId}.webp`,
    ]);
  });
});
