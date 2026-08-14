import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("public share route surface", () => {
  it("has no legacy dynamic secret path and exposes only fixed route files", () => {
    for (const suffix of ["route.ts", "photo/route.ts", "reports/route.ts", "block/route.ts"]) {
      expect(existsSync(resolve(`src/app/api/share/[shareSlug]/${suffix}`))).toBe(false);
    }
    expect(existsSync(resolve("src/app/share/[shareSlug]/page.tsx"))).toBe(false);
    for (const endpoint of ["resolve", "photo", "report", "block", "age-attestation"]) {
      expect(existsSync(resolve(`src/app/api/public-share/${endpoint}/route.ts`))).toBe(true);
    }
  });
});
