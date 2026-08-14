import "server-only";

import {
  completeReviewerFixture,
  prepareReviewerProvision,
  prepareReviewerReset,
  revokeReviewerFixture,
  type ReviewerFixtureAppliedInternal,
  type ReviewerFixturePrepared,
} from "@/server/reviewer-access/repository";
import { ApiError } from "@/server/http/api-error";
import { getReviewerSampleImage } from "@/server/reviewer-access/sample-image";
import {
  installReviewerSampleObject,
  removeReviewerSampleObjects,
} from "@/server/reviewer-access/storage";

export type ReviewerFixtureResult = {
  status: "applied";
  store_platform: "app_store" | "play_store";
  fixture_version: string;
  retro_count: 6;
  personal_card_count: 1;
  active_share_count: 1;
  fixture_hash: string;
};

export type ReviewerRevokeResult = {
  status: "revoked";
  participant_rows: number;
  identity_rows: number;
  recovery_code_rows: number;
  share_rows: number;
};

export type ReviewerAccessDependencies = {
  sample: typeof getReviewerSampleImage;
  prepareProvision: typeof prepareReviewerProvision;
  prepareReset: typeof prepareReviewerReset;
  complete: typeof completeReviewerFixture;
  install: typeof installReviewerSampleObject;
  remove: typeof removeReviewerSampleObjects;
  revoke: typeof revokeReviewerFixture;
};

const defaultDependencies: ReviewerAccessDependencies = {
  sample: getReviewerSampleImage,
  prepareProvision: prepareReviewerProvision,
  prepareReset: prepareReviewerReset,
  complete: completeReviewerFixture,
  install: installReviewerSampleObject,
  remove: removeReviewerSampleObjects,
  revoke: revokeReviewerFixture,
};

function publicApplied(result: ReviewerFixtureAppliedInternal): ReviewerFixtureResult {
  return {
    status: "applied",
    store_platform: result.store_platform,
    fixture_version: result.fixture_version,
    retro_count: result.retro_count,
    personal_card_count: result.personal_card_count,
    active_share_count: result.active_share_count,
    fixture_hash: result.fixture_hash,
  };
}

function objectPath(appUserId: string, objectId: string): string {
  return `${appUserId}/${objectId}.webp`;
}

async function finishPrepared(input: {
  adminAuthUserId: string;
  appUserId: string;
  clientActionId: string;
  prepared: ReviewerFixturePrepared | ReviewerFixtureAppliedInternal;
  sample: Awaited<ReturnType<typeof getReviewerSampleImage>>;
}, dependencies: ReviewerAccessDependencies): Promise<ReviewerFixtureResult> {
  let applied: ReviewerFixtureAppliedInternal;
  let oldObjectIds: string[];
  if (input.prepared.status === "applied") {
    applied = input.prepared;
    oldObjectIds = input.prepared.previous_photo_object_id === null
      ? []
      : [input.prepared.previous_photo_object_id];
  } else {
    if (
      input.prepared.photo_sha256 !== input.sample.sha256Hex
      || input.prepared.photo_size_bytes !== input.sample.sizeBytes
    ) {
      throw new Error("Prepared reviewer sample binding mismatch");
    }
    const path = objectPath(input.appUserId, input.prepared.photo_object_id);
    await dependencies.install({
      path,
      bytes: input.sample.bytes,
      expectedSha256Hex: input.sample.sha256Hex,
    });
    try {
      applied = await dependencies.complete({
        adminAuthUserId: input.adminAuthUserId,
        appUserId: input.appUserId,
        clientActionId: input.clientActionId,
        photoObjectId: input.prepared.photo_object_id,
        photoSizeBytes: input.sample.sizeBytes,
        photoSha256Hex: input.sample.sha256Hex,
      });
    } catch (error) {
      // Revoke/account deletion can commit and attempt cleanup while this
      // out-of-transaction upload is still in flight. If upload wins after
      // that delete, completion fails against closed DB state; delete the
      // just-installed object here so the late writer cannot leave an orphan.
      // Only NOT_FOUND proves the target closed under the lifecycle lock.
      // INTERNAL may hide a committed response, and even RATE_LIMITED can be
      // returned to a concurrent retry after another worker committed. Those
      // ambiguous cases preserve the object for an exact idempotent retry.
      if (error instanceof ApiError && error.code === "NOT_FOUND") {
        // A cleanup failure deliberately replaces the original error so it is
        // surfaced operationally; revoke retry retains this opaque object ID.
        await dependencies.remove([path]);
      }
      throw error;
    }
    oldObjectIds = [
      ...input.prepared.old_photo_object_ids,
      ...(applied.previous_photo_object_id === null
        ? []
        : [applied.previous_photo_object_id]),
    ];
  }

  await dependencies.remove(
    oldObjectIds
      .filter((objectId) => objectId !== applied.photo_object_id)
      .map((objectId) => objectPath(input.appUserId, objectId)),
  );
  return publicApplied(applied);
}

export async function provisionReviewerAccess(input: {
  adminAuthUserId: string;
  appUserId: string;
  storePlatform: "app_store" | "play_store";
  fixtureVersion: string;
  clientActionId: string;
}, dependencies: ReviewerAccessDependencies = defaultDependencies): Promise<ReviewerFixtureResult> {
  const sample = await dependencies.sample();
  const prepared = await dependencies.prepareProvision({
    ...input,
    photoSizeBytes: sample.sizeBytes,
    photoSha256Hex: sample.sha256Hex,
  });
  return finishPrepared({
    adminAuthUserId: input.adminAuthUserId,
    appUserId: input.appUserId,
    clientActionId: input.clientActionId,
    prepared,
    sample,
  }, dependencies);
}

export async function resetReviewerAccess(input: {
  adminAuthUserId: string;
  appUserId: string;
  clientActionId: string;
}, dependencies: ReviewerAccessDependencies = defaultDependencies): Promise<ReviewerFixtureResult> {
  const sample = await dependencies.sample();
  const prepared = await dependencies.prepareReset({
    ...input,
    photoSizeBytes: sample.sizeBytes,
    photoSha256Hex: sample.sha256Hex,
  });
  return finishPrepared({ ...input, prepared, sample }, dependencies);
}

export async function revokeReviewerAccess(input: {
  adminAuthUserId: string;
  appUserId: string;
  clientActionId: string;
}, dependencies: ReviewerAccessDependencies = defaultDependencies): Promise<ReviewerRevokeResult> {
  const revoked = await dependencies.revoke(input);
  await dependencies.remove(
    revoked.old_photo_object_ids.map((objectId) => objectPath(input.appUserId, objectId)),
  );
  return {
    status: "revoked",
    participant_rows: revoked.participant_rows,
    identity_rows: revoked.identity_rows,
    recovery_code_rows: revoked.recovery_code_rows,
    share_rows: revoked.share_rows,
  };
}
