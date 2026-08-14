import { beforeEach, describe, expect, it, vi } from "vitest";

const { upload, download, remove, from } = vi.hoisted(() => {
  const uploadMock = vi.fn();
  const downloadMock = vi.fn();
  const removeMock = vi.fn();
  return {
    upload: uploadMock,
    download: downloadMock,
    remove: removeMock,
    from: vi.fn(() => ({
      upload: uploadMock,
      download: downloadMock,
      remove: removeMock,
    })),
  };
});

vi.mock("@/server/supabase/service", () => ({
  getServiceClient: () => ({ storage: { from } }),
}));

import {
  installReviewerSampleObject,
  removeReviewerSampleObjects,
  ReviewerFixtureStorageError,
} from "@/server/reviewer-access/storage";

const bytes = Uint8Array.from([1, 2, 3]);
const hash = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";

describe("reviewer fixture Storage", () => {
  beforeEach(() => {
    upload.mockReset().mockResolvedValue({ error: null });
    download.mockReset();
    remove.mockReset().mockResolvedValue({ error: null });
    from.mockClear();
  });

  it("installs the immutable WebP without overwrite", async () => {
    await installReviewerSampleObject({ path: "owner/object.webp", bytes, expectedSha256Hex: hash });
    expect(upload).toHaveBeenCalledWith("owner/object.webp", bytes, {
      cacheControl: "31536000",
      contentType: "image/webp",
      upsert: false,
    });
  });

  it("accepts a response-loss retry only when existing bytes match", async () => {
    upload.mockResolvedValue({ error: { statusCode: "409" } });
    download.mockResolvedValue({ error: null, data: new Blob([bytes]) });
    await expect(installReviewerSampleObject({
      path: "owner/object.webp",
      bytes,
      expectedSha256Hex: hash,
    })).resolves.toBeUndefined();
  });

  it("rejects a conflicting pre-existing object", async () => {
    upload.mockResolvedValue({ error: { statusCode: "409" } });
    download.mockResolvedValue({ error: null, data: new Blob([Uint8Array.from([9])]) });
    await expect(installReviewerSampleObject({
      path: "owner/object.webp",
      bytes,
      expectedSha256Hex: hash,
    })).rejects.toBeInstanceOf(ReviewerFixtureStorageError);
  });

  it("deduplicates cleanup paths", async () => {
    await removeReviewerSampleObjects(["owner/a.webp", "owner/a.webp", "owner/b.webp"]);
    expect(remove).toHaveBeenCalledWith(["owner/a.webp", "owner/b.webp"]);
  });

  it("batches a long revoke cleanup manifest", async () => {
    const paths = Array.from({ length: 205 }, (_, index) => `owner/${index}.webp`);
    await removeReviewerSampleObjects(paths);
    expect(remove).toHaveBeenCalledTimes(3);
    expect(remove.mock.calls.map(([batch]) => batch.length)).toEqual([100, 100, 5]);
  });
});
