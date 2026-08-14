import "server-only";

import {
  decodeCollectionCursor,
  encodeCollectionCursor,
} from "@/server/collection/cursor";
import type { CollectionResult } from "@/server/collection/db-contract";
import { getUserCollection } from "@/server/collection/repository";
import { ApiError } from "@/server/http/api-error";
import { publicShareUrl, requirePublicAppOrigin } from "@/server/http/public-url";

type ReadyCollection = Extract<CollectionResult, { status: "ready" }>;

type Dependencies = {
  read(input: {
    authUserId: string;
    limit: number;
    beforeAcquiredAt: string | null;
    beforeAcquisitionId: string | null;
  }): Promise<CollectionResult>;
};

const defaultDependencies: Dependencies = { read: getUserCollection };

function projectItem(item: ReadyCollection["items"][number], publicAppUrl: string | undefined) {
  const share = item.personal_card === null
    ? null
    : {
        status: item.personal_card.share_status,
        slug: item.personal_card.share_slug,
        url: item.personal_card.share_status === "active" && item.personal_card.share_slug !== null
          ? publicShareUrl(
              requirePublicAppOrigin(publicAppUrl),
              item.personal_card.share_slug,
            )
          : null,
        reason_code: item.personal_card.reason_code,
      };
  return {
    acquisition: {
      id: item.acquisition.id,
      spot_id: item.acquisition.spot_id,
      card_id: item.acquisition.card_id,
      type: item.acquisition.type,
      acquired_at: item.acquisition.acquired_at,
      date_kst: item.acquisition.date_kst,
    },
    spot: item.spot,
    card: {
      title: item.card.title,
      image_url: `/api/card-assets/${item.acquisition.card_id}`,
      color_hex: item.card.color_hex,
    },
    personal_card: item.personal_card === null
      ? null
      : {
          id: item.personal_card.id,
          caption: item.personal_card.caption,
          photo_url: `/api/personal-cards/${item.personal_card.id}/photo`,
          created_at: item.personal_card.created_at,
          share,
        },
  };
}

export async function readCollection(
  input: {
    authUserId: string;
    limit: number;
    cursor?: string;
    cursorSecret: string;
    publicAppUrl?: string;
  },
  dependencies: Dependencies = defaultDependencies,
) {
  const anchor = input.cursor === undefined
    ? null
    : decodeCollectionCursor(input.cursor, input.authUserId, input.cursorSecret);
  const result = await dependencies.read({
    authUserId: input.authUserId,
    limit: input.limit,
    beforeAcquiredAt: anchor?.acquired_at ?? null,
    beforeAcquisitionId: anchor?.acquisition_id ?? null,
  });
  if (result.status === "unauthorized") {
    throw new ApiError("UNAUTHORIZED");
  }
  if (result.status === "invalid") {
    throw new ApiError("INTERNAL");
  }

  if (result.has_more !== (result.next_anchor !== null)) {
    throw new ApiError("INTERNAL");
  }
  return {
    items: result.items.map((item) => projectItem(item, input.publicAppUrl)),
    page: {
      next_cursor: result.next_anchor !== null
        ? encodeCollectionCursor({
            acquired_at: result.next_anchor.acquired_at,
            acquisition_id: result.next_anchor.id,
          }, input.authUserId, input.cursorSecret)
        : null,
      has_more: result.has_more,
    },
    stats: result.stats,
  };
}
