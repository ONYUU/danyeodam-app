import { describe, expect, it } from "vitest";

import { localizedTextSchema, supportedLocales } from "@/server/localization/schema";

describe("localized content schema", () => {
  const complete = {
    ko: "한국어", en: "English", ja: "日本語",
    "zh-Hans": "简体中文", "zh-Hant": "繁體中文", vi: "Tiếng Việt",
  };

  it("requires exactly the six approved content locales", () => {
    expect(supportedLocales).toEqual(["ko", "en", "ja", "zh-Hans", "zh-Hant", "vi"]);
    expect(localizedTextSchema.parse(complete)).toEqual(complete);
    expect(localizedTextSchema.safeParse({ ...complete, vi: undefined }).success).toBe(false);
    expect(localizedTextSchema.safeParse({ ...complete, fr: "Français" }).success).toBe(false);
  });
});
