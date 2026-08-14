import { describe, expect, it } from "vitest";

import { createShareSlug } from "@/server/shares/code";

describe("createShareSlug", () => {
  it("creates fixed-length base62 secrets", () => {
    for (let index = 0; index < 64; index += 1) {
      expect(createShareSlug()).toMatch(/^[A-Za-z0-9]{22}$/);
    }
  });
});
