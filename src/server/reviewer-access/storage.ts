import "server-only";

import { createHash } from "node:crypto";

import { getServiceClient } from "@/server/supabase/service";

const BUCKET = "personal-cards";
const REMOVE_BATCH_SIZE = 100;

export class ReviewerFixtureStorageError extends Error {
  constructor() {
    super("Reviewer fixture Storage operation failed");
    this.name = "ReviewerFixtureStorageError";
  }
}

function isConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const status = Reflect.get(error, "status");
  const statusCode = Reflect.get(error, "statusCode");
  return status === 409 || statusCode === 409 || statusCode === "409";
}

export async function installReviewerSampleObject(input: {
  path: string;
  bytes: Uint8Array;
  expectedSha256Hex: string;
}): Promise<void> {
  const bucket = getServiceClient().storage.from(BUCKET);
  const { error } = await bucket.upload(input.path, input.bytes, {
    cacheControl: "31536000",
    contentType: "image/webp",
    upsert: false,
  });
  if (error === null) return;
  if (!isConflict(error)) throw new ReviewerFixtureStorageError();

  // A transport retry can find the exact immutable object already installed.
  // Only an exact byte/hash match may continue to the database completion RPC.
  const existing = await bucket.download(input.path);
  if (existing.error !== null || existing.data === null) {
    throw new ReviewerFixtureStorageError();
  }
  const bytes = new Uint8Array(await existing.data.arrayBuffer());
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== input.bytes.byteLength || hash !== input.expectedSha256Hex) {
    throw new ReviewerFixtureStorageError();
  }
}

export async function removeReviewerSampleObjects(paths: string[]): Promise<void> {
  const uniquePaths = [...new Set(paths)].filter((path) => path.length > 0);
  if (uniquePaths.length === 0) return;
  const bucket = getServiceClient().storage.from(BUCKET);
  for (let offset = 0; offset < uniquePaths.length; offset += REMOVE_BATCH_SIZE) {
    const { error } = await bucket.remove(
      uniquePaths.slice(offset, offset + REMOVE_BATCH_SIZE),
    );
    if (error !== null) throw new ReviewerFixtureStorageError();
  }
}
