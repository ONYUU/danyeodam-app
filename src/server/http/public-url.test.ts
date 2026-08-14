import { describe, expect, it } from "vitest";

import { publicShareUrl, requirePublicAppOrigin } from "@/server/http/public-url";

describe("public application URL", () => {
  it("normalizes configuration and keeps the share secret in the fragment", () => {
    expect(requirePublicAppOrigin("https://danyeodam.example/base"))
      .toBe("https://danyeodam.example");
    expect(publicShareUrl("https://danyeodam.example", "AbCd0123"))
      .toBe("https://danyeodam.example/share#AbCd0123");
    expect(requirePublicAppOrigin("http://127.0.0.1:31119"))
      .toBe("http://127.0.0.1:31119");
  });

  it("fails closed when the deployment origin is absent or contains credentials", () => {
    expect(() => requirePublicAppOrigin(undefined)).toThrowError(
      expect.objectContaining({ code: "INTERNAL" }),
    );
    expect(() => requirePublicAppOrigin("https://user:pass@example.test"))
      .toThrowError(expect.objectContaining({ code: "INTERNAL" }));
    expect(() => requirePublicAppOrigin("http://danyeodam.example"))
      .toThrowError(expect.objectContaining({ code: "INTERNAL" }));
  });
});
