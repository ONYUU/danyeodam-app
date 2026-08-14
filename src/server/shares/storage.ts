import "server-only";

import { z } from "zod";

import { getServerEnvironment } from "@/server/env";
import { ApiError } from "@/server/http/api-error";

const photoPathSchema = z.string().max(256).regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/i,
);
const maximumPhotoBytes = 10 * 1024 * 1024;
const storageDownloadTimeoutMs = 10_000;

export type SharePhotoStream = {
  body: ReadableStream<Uint8Array>;
  contentType: "image/webp";
  contentLength: number;
};

function encodedStoragePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function isMissingStorageObject(response: Response): Promise<boolean> {
  if (response.status === 404) {
    return true;
  }
  if (response.status !== 400) {
    return false;
  }
  const payload = await response.json().catch(() => ({})) as {
    error?: unknown;
    code?: unknown;
  };
  return payload.error === "not_found" || payload.code === "not_found";
}

export async function downloadSharePhoto(photoPath: string): Promise<SharePhotoStream> {
  const path = photoPathSchema.safeParse(photoPath);
  if (!path.success) {
    throw new ApiError("INTERNAL");
  }

  const environment = getServerEnvironment();
  const endpoint = new URL(
    `/storage/v1/object/personal-cards/${encodedStoragePath(path.data)}`,
    environment.NEXT_PUBLIC_SUPABASE_URL,
  );
  const response = await fetch(endpoint, {
    headers: {
      apikey: environment.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${environment.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(storageDownloadTimeoutMs),
  });

  if (!response.ok) {
    if (await isMissingStorageObject(response)) {
      throw new ApiError("NOT_FOUND");
    }
    throw new ApiError("INTERNAL");
  }

  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase();
  const contentLength = Number(response.headers.get("content-length"));
  if (
    contentType !== "image/webp"
    || response.body === null
    || !Number.isSafeInteger(contentLength)
    || contentLength < 1
    || contentLength > maximumPhotoBytes
  ) {
    await response.body?.cancel();
    throw new ApiError("INTERNAL");
  }

  return {
    body: response.body,
    contentType,
    contentLength,
  };
}
