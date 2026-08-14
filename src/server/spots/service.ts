import "server-only";

import type { PublicSpotsResult } from "@/server/spots/db-contract";
import { listPublicSpots } from "@/server/spots/repository";

export type PublicSpotsBody = {
  content_version: string;
  spots: Array<{
    id: string;
    slug: string;
    name: PublicSpotsResult["spots"][number]["name"];
    region: PublicSpotsResult["spots"][number]["region"];
    status: "open" | "teaser";
    latitude: number;
    longitude: number;
    card: null | {
      id: string;
      title: NonNullable<PublicSpotsResult["spots"][number]["card"]>["title"];
      sketch_url: string;
      color_hex: string;
    };
  }>;
};

export async function readPublicSpots(
  read: () => Promise<PublicSpotsResult> = listPublicSpots,
): Promise<PublicSpotsBody> {
  const result = await read();
  return {
    content_version: result.content_version,
    spots: result.spots.map((spot) => ({
      id: spot.id,
      slug: spot.slug,
      name: spot.name,
      region: spot.region,
      status: spot.status,
      latitude: spot.latitude,
      longitude: spot.longitude,
      card: spot.card === null
        ? null
        : {
            id: spot.card.id,
            title: spot.card.title,
            sketch_url: `/api/card-assets/${spot.card.id}`,
            color_hex: spot.card.color_hex,
          },
    })),
  };
}
