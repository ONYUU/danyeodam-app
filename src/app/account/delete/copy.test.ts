import { describe, expect, it } from "vitest";

import {
  deletionCopy,
  deletionLocales,
  resolveDeletionLocale,
} from "@/app/account/delete/copy";

describe("account deletion public copy", () => {
  it("keeps all six supported locales structurally complete", () => {
    const koreanKeys = Object.keys(deletionCopy.ko).sort();
    expect(deletionLocales).toHaveLength(6);
    for (const locale of deletionLocales) {
      expect(Object.keys(deletionCopy[locale]).sort()).toEqual(koreanKeys);
      expect(Object.values(deletionCopy[locale]).every((value) => value.trim() !== ""))
        .toBe(true);
    }
  });

  it("resolves supported browser language families without guessing", () => {
    expect(resolveDeletionLocale("ko-KR")).toBe("ko");
    expect(resolveDeletionLocale("zh-Hant-TW")).toBe("zh-Hant");
    expect(resolveDeletionLocale("zh-Hans-CN")).toBe("zh-Hans");
    expect(resolveDeletionLocale("vi-VN")).toBe("vi");
    expect(resolveDeletionLocale("fr-FR")).toBe("en");
  });
});
