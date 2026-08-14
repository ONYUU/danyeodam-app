import "server-only";

import { MAX_PERSONAL_CARD_SOURCE_BYTES } from "@/server/personal-cards/input";
import {
  createSignalScopedServiceClient,
  getServiceClient,
} from "@/server/supabase/service";

const TEMPORARY_BUCKET = "personal-card-temp";
const PERMANENT_BUCKET = "personal-cards";

export class PersonalCardStorageError extends Error {
  readonly kind: "not_found" | "invalid" | "internal";

  constructor(kind: "not_found" | "invalid" | "internal") {
    super("Personal card storage operation failed");
    this.name = "PersonalCardStorageError";
    this.kind = kind;
  }
}

function isNotFoundStorageError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const statusCode = Reflect.get(error, "statusCode");
  const status = Reflect.get(error, "status");
  return statusCode === 404 || statusCode === "404" || status === 404;
}

export async function createPersonalCardSignedUploadUrl(tempPath: string): Promise<string> {
  const { data, error } = await getServiceClient()
    .storage
    .from(TEMPORARY_BUCKET)
    .createSignedUploadUrl(tempPath);

  if (error !== null || data?.signedUrl === undefined || data.signedUrl.length === 0) {
    throw new PersonalCardStorageError("internal");
  }
  return data.signedUrl;
}

export async function downloadPersonalCardTemporaryObject(tempPath: string): Promise<Uint8Array> {
  const { data, error } = await getServiceClient()
    .storage
    .from(TEMPORARY_BUCKET)
    .download(tempPath);

  if (error !== null || data === null) {
    throw new PersonalCardStorageError(isNotFoundStorageError(error) ? "not_found" : "internal");
  }
  if (data.size === 0 || data.size > MAX_PERSONAL_CARD_SOURCE_BYTES) {
    throw new PersonalCardStorageError("invalid");
  }

  return new Uint8Array(await data.arrayBuffer());
}

export async function uploadPersonalCardPermanentObject(
  permanentPath: string,
  bytes: Uint8Array,
): Promise<void> {
  const { error } = await getServiceClient()
    .storage
    .from(PERMANENT_BUCKET)
    .upload(permanentPath, bytes, {
      cacheControl: "31536000",
      contentType: "image/webp",
      upsert: false,
    });

  if (error !== null) {
    throw new PersonalCardStorageError("internal");
  }
}

async function removeObject(
  bucket: string,
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  const client = signal === undefined
    ? getServiceClient()
    : createSignalScopedServiceClient(signal);
  const { error } = await client.storage.from(bucket).remove([path]);
  if (error !== null) {
    throw new PersonalCardStorageError("internal");
  }
}

export async function deletePersonalCardTemporaryObject(
  tempPath: string,
  signal?: AbortSignal,
): Promise<void> {
  await removeObject(TEMPORARY_BUCKET, tempPath, signal);
}

export async function deletePersonalCardPermanentObject(
  permanentPath: string,
  signal?: AbortSignal,
): Promise<void> {
  await removeObject(PERMANENT_BUCKET, permanentPath, signal);
}
