import "server-only";

import { createSignalScopedServiceClient } from "@/server/supabase/service";

export type AccountStorageBucket = "personal-card-temp" | "personal-cards";
export type AccountStoragePath = {
  bucket: AccountStorageBucket;
  object_path: string;
};

export class AccountDeletionStorageError extends Error {
  constructor(readonly operation: "list" | "delete") {
    super("Account deletion Storage operation failed");
    this.name = "AccountDeletionStorageError";
  }
}

function ownedPath(prefix: string, name: string): string {
  const path = `${prefix}/${name}`;
  if (
    !/^[0-9a-f-]{36}$/u.test(prefix)
    || name.length < 1
    || name.includes("/")
    || path.length > 512
    || path.includes("..")
  ) {
    throw new AccountDeletionStorageError("list");
  }
  return path;
}

export async function listAccountStoragePaths(input: {
  prefix: string;
  limit: number;
  signal: AbortSignal;
}): Promise<AccountStoragePath[]> {
  const perBucketLimit = Math.max(1, Math.min(2, Math.floor(input.limit / 2)));
  const client = createSignalScopedServiceClient(input.signal);
  const buckets = ["personal-card-temp", "personal-cards"] as const;
  const listed = await Promise.all(buckets.map(async (bucket) => {
    const { data, error } = await client.storage.from(bucket).list(input.prefix, {
      limit: perBucketLimit,
      offset: 0,
      sortBy: { column: "name", order: "asc" },
    });
    if (error !== null) throw new AccountDeletionStorageError("list");
    return data.map((object) => ({
      bucket,
      object_path: ownedPath(input.prefix, object.name),
    }));
  }));
  return listed.flat().slice(0, input.limit);
}

export async function deleteAccountStoragePath(input: {
  bucket: AccountStorageBucket;
  objectPath: string;
  signal: AbortSignal;
}): Promise<boolean> {
  const { error } = await createSignalScopedServiceClient(input.signal)
    .storage
    .from(input.bucket)
    .remove([input.objectPath]);
  return error === null;
}
