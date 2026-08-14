import "server-only";

import { decodeBlockCursor, encodeBlockCursor } from "@/server/blocks/cursor";
import { ApiError } from "@/server/http/api-error";
import {
  createUserBlock,
  listUserBlocks,
  revokeUserBlock,
  type CreateBlockResult,
  type ListBlocksResult,
  type RevokeBlockResult,
} from "@/server/blocks/repository";

export type UserBlockServiceDependencies = {
  create(input: {
    authUserId: string;
    shareSlug: string;
    clientActionId: string;
    publicSharePublicationOpen: boolean;
  }): Promise<CreateBlockResult>;
  list(input: {
    authUserId: string;
    limit: number;
    beforeCreatedAt: string | null;
    beforeId: string | null;
  }): Promise<ListBlocksResult>;
  revoke(input: {
    authUserId: string;
    blockId: string;
    clientActionId: string;
  }): Promise<RevokeBlockResult>;
};

const defaultDependencies: UserBlockServiceDependencies = {
  create: createUserBlock,
  list: listUserBlocks,
  revoke: revokeUserBlock,
};

function throwCommon(result: { status: string }): never {
  switch (result.status) {
    case "unauthorized": throw new ApiError("UNAUTHORIZED");
    case "invalid": throw new ApiError("VALIDATION_FAILED");
    case "not_found": throw new ApiError("NOT_FOUND");
    case "idempotency_conflict": throw new ApiError("IDEMPOTENCY_CONFLICT");
    default: throw new ApiError("INTERNAL");
  }
}

export async function blockShareOwner(
  input: {
    authUserId: string;
    shareSlug: string;
    clientActionId: string;
    publicSharePublicationOpen: boolean;
  },
  dependencies: UserBlockServiceDependencies = defaultDependencies,
): Promise<void> {
  const result = await dependencies.create(input);
  if (result.status === "blocked") return;
  if (result.status === "rate_limited") {
    throw new ApiError("RATE_LIMITED", { retry_after_seconds: result.retry_after_seconds });
  }
  throwCommon(result);
}

export async function readUserBlocks(
  input: {
    authUserId: string;
    limit: number;
    cursor?: string;
    cursorSecret: string;
  },
  dependencies: UserBlockServiceDependencies = defaultDependencies,
) {
  const anchor = input.cursor === undefined
    ? null
    : decodeBlockCursor(input.cursor, input.authUserId, input.cursorSecret);
  const result = await dependencies.list({
    authUserId: input.authUserId,
    limit: input.limit,
    beforeCreatedAt: anchor?.created_at ?? null,
    beforeId: anchor?.block_id ?? null,
  });
  if (result.status !== "ready") throwCommon(result);
  if (result.has_more !== (result.next_anchor !== null)) throw new ApiError("INTERNAL");
  return {
    items: result.items,
    page: {
      next_cursor: result.next_anchor === null
        ? null
        : encodeBlockCursor({
            created_at: result.next_anchor.created_at,
            block_id: result.next_anchor.id,
          }, input.authUserId, input.cursorSecret),
      has_more: result.has_more,
    },
  };
}

export async function unblockUser(
  input: { authUserId: string; blockId: string; clientActionId: string },
  dependencies: UserBlockServiceDependencies = defaultDependencies,
): Promise<void> {
  const result = await dependencies.revoke(input);
  if (result.status === "revoked") return;
  throwCommon(result);
}
