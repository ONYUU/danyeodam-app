import { describe, expect, it } from "vitest";

import { readPublicSpots } from "@/server/spots/service";

const localized = {
  ko: "경복궁",
  en: "Gyeongbokgung",
  ja: "景福宮",
  "zh-Hans": "景福宫",
  "zh-Hant": "景福宮",
  vi: "Cung Gyeongbok",
};

describe("public spots service", () => {
  it("projects only the contract fields and hides asset paths and sort values", async () => {
    const body = await readPublicSpots(async () => ({
      content_version: "2026-08-12T00:00:00.000Z",
      spots: [{
        id: "11111111-1111-4111-8111-111111111111",
        slug: "gyeongbokgung",
        name: localized,
        region: { code: "seoul", name: localized },
        status: "open",
        latitude: 37.5796,
        longitude: 126.977,
        card: {
          id: "22222222-2222-4222-8222-222222222222",
          title: localized,
          sketch_path: "seoul/gyeongbokgung.webp",
          color_hex: "#123456",
        },
      }],
    }));

    expect(body.spots[0]?.card).toEqual({
      id: "22222222-2222-4222-8222-222222222222",
      title: localized,
      sketch_url: "/api/card-assets/22222222-2222-4222-8222-222222222222",
      color_hex: "#123456",
    });
    expect(JSON.stringify(body)).not.toContain("sketch_path");
    expect(JSON.stringify(body)).not.toContain("sort_order");
  });
});
