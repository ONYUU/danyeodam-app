import { describe, expect, it } from "vitest";

import {
  PUBLIC_SHARE_COPY,
  PUBLIC_SHARE_LOCALES,
  selectPublicShareLocale,
  selectPublicShareLocaleFromHeader,
} from "@/app/share/copy";
import { selectSpotName } from "@/app/share/transport";

const localized = {
  ko: "경복궁", en: "Gyeongbokgung", ja: "景福宮",
  "zh-Hans": "景福宫", "zh-Hant": "景福宮", vi: "Cung Gyeongbok",
};

describe("public share locale copy", () => {
  it("maps browser locales and falls back to English", () => {
    expect(selectPublicShareLocale(["ko-KR"])).toBe("ko");
    expect(selectPublicShareLocale(["ja-JP"])).toBe("ja");
    expect(selectPublicShareLocale(["zh-CN"])).toBe("zh-Hans");
    expect(selectPublicShareLocale(["zh-Hant-HK"])).toBe("zh-Hant");
    expect(selectPublicShareLocale(["vi-VN"])).toBe("vi");
    expect(selectPublicShareLocale(["fr-FR", "en-GB"])).toBe("en");
    expect(selectPublicShareLocale(["fr-FR"])).toBe("en");
    expect(selectPublicShareLocaleFromHeader("fr-FR;q=0.9, vi-VN;q=1")).toBe("vi");
    expect(selectPublicShareLocaleFromHeader("zh-TW,zh;q=0.8,en;q=0.7")).toBe("zh-Hant");
    expect(selectPublicShareLocaleFromHeader(null)).toBe("en");
  });

  it("has complete non-empty UI and report copy for every supported locale", () => {
    const referenceKeys = Object.keys(PUBLIC_SHARE_COPY.en).sort();
    const reasonKeys = Object.keys(PUBLIC_SHARE_COPY.en.reportReasons).sort();
    expect(Object.keys(PUBLIC_SHARE_COPY).sort()).toEqual([...PUBLIC_SHARE_LOCALES].sort());
    for (const locale of PUBLIC_SHARE_LOCALES) {
      const copy = PUBLIC_SHARE_COPY[locale];
      expect(Object.keys(copy).sort()).toEqual(referenceKeys);
      expect(Object.keys(copy.reportReasons).sort()).toEqual(reasonKeys);
      for (const [key, value] of Object.entries(copy)) {
        if (key !== "reportReasons") expect(value).toEqual(expect.any(String));
      }
      expect(Object.values(copy.reportReasons).every((value) => value.length > 0)).toBe(true);
    }
  });

  it("selects only the localized spot name and leaves the caption outside localization", () => {
    for (const locale of PUBLIC_SHARE_LOCALES) {
      expect(selectSpotName(localized, locale)).toBe(localized[locale]);
    }
  });
});
