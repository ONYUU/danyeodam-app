import "server-only";

import { z } from "zod";

import { getServerEnvironment } from "@/server/env";
import { ApiError } from "@/server/http/api-error";
import { getServiceClient } from "@/server/supabase/service";

const assetPathSchema = z.string().min(1).refine(
  (path) => !path.startsWith("/") && !path.split("/").some((segment) => segment === ".."),
);

const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const maximumAssetBytes = 10 * 1024 * 1024;

export type CardAssetStream = {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  contentLength?: number;
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

export async function downloadPublishedCardAsset(cardId: string): Promise<CardAssetStream> {
  const client = getServiceClient();
  const { data: rawPath, error: pathError } = await client
    .schema("api_private")
    .rpc("get_published_card_asset", { p_card_id: cardId });

  if (pathError !== null) {
    throw new ApiError("INTERNAL");
  }
  if (rawPath === null) {
    throw new ApiError("NOT_FOUND");
  }

  const path = assetPathSchema.safeParse(rawPath);
  if (!path.success) {
    throw new ApiError("INTERNAL");
  }

  const environment = getServerEnvironment();
  const endpoint = new URL(
    `/storage/v1/object/card-assets/${encodedStoragePath(path.data)}`,
    environment.NEXT_PUBLIC_SUPABASE_URL,
  );
  const response = await fetch(endpoint, {
    headers: {
      apikey: environment.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${environment.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    if (await isMissingStorageObject(response)) {
      throw new ApiError("NOT_FOUND");
    }
    throw new ApiError("INTERNAL");
  }

  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase();
  if (contentType === undefined || !allowedImageTypes.has(contentType) || response.body === null) {
    await response.body?.cancel();
    throw new ApiError("INTERNAL");
  }

  const rawLength = response.headers.get("content-length");
  const contentLength = rawLength === null ? undefined : Number(rawLength);
  if (
    contentLength !== undefined
    && (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > maximumAssetBytes)
  ) {
    await response.body.cancel();
    throw new ApiError("INTERNAL");
  }

  return {
    body: response.body,
    contentType,
    ...(contentLength === undefined ? {} : { contentLength }),
  };
}
