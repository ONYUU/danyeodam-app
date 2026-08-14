import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  classifyDateOfBirth,
  consumeShareSecretFromFragment,
  parsePublicShareReportReceipt,
  parseResolvedPublicShare,
  PUBLIC_SHARE_ENDPOINTS,
  publicShareBlockAppUrl,
  publicShareReportBody,
  publicShareSecretBody,
} from "@/app/share/transport";

const shareSecret = "AbCdEfGhIjKlMnOpQrStUv";
const localized = {
  ko: "경복궁", en: "Gyeongbokgung", ja: "景福宮",
  "zh-Hans": "景福宫", "zh-Hant": "景福宮", vi: "Cung Gyeongbok",
};

describe("public share fragment transport", () => {
  it("consumes the fragment once and immediately clears the visible URL", () => {
    const replaceState = vi.fn();
    expect(consumeShareSecretFromFragment({
      location: { hash: `#${shareSecret}` },
      history: { replaceState },
    })).toBe(shareSecret);
    expect(replaceState).toHaveBeenCalledOnce();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/share");

    const invalidHistory = { replaceState: vi.fn() };
    expect(consumeShareSecretFromFragment({
      location: { hash: "#not-valid" },
      history: invalidHistory,
    })).toBeNull();
    expect(invalidHistory.replaceState).toHaveBeenCalledWith(null, "", "/share");
  });

  it("uses only fixed paths and carries the secret in strict JSON bodies", () => {
    for (const path of Object.values(PUBLIC_SHARE_ENDPOINTS)) {
      const url = new URL(path, "https://danyeodam.example");
      expect(url.pathname).not.toContain(shareSecret);
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
    }
    expect(JSON.parse(publicShareSecretBody(shareSecret))).toEqual({ share_secret: shareSecret });
    expect(JSON.parse(publicShareReportBody({
      shareSecret,
      clientReportId: "11111111-1111-4111-8111-111111111111",
      reason: "privacy",
    }))).toMatchObject({ share_secret: shareSecret, target: "content" });
  });

  it("hands a secret to the native block screen only through a custom-scheme fragment", () => {
    const handoff = new URL(publicShareBlockAppUrl(shareSecret)!);
    expect(handoff.protocol).toBe("danyeodam:");
    expect(handoff.hostname).toBe("share-block");
    expect(handoff.pathname).toBe("");
    expect(handoff.search).toBe("");
    expect(handoff.hash).toBe(`#${shareSecret}`);
    expect(publicShareBlockAppUrl("not-valid")).toBeNull();
  });

  it("distinguishes adult, underage, and invalid DOB without retaining it", () => {
    const today = new Date("2026-08-12T03:00:00.000Z");
    expect(classifyDateOfBirth("2008-08-12", today)).toBe("adult");
    expect(classifyDateOfBirth("2008-08-13", today)).toBe("underage");
    expect(classifyDateOfBirth("2008-02-30", today)).toBe("invalid");
    expect(classifyDateOfBirth("2027-01-01", today)).toBe("invalid");
  });

  it("uses the Asia/Seoul calendar at the eighteenth-birthday boundary", () => {
    const dateOfBirth = "2008-08-12";
    expect(classifyDateOfBirth(
      dateOfBirth,
      new Date("2026-08-11T14:59:59.999Z"),
    )).toBe("underage");
    expect(classifyDateOfBirth(
      dateOfBirth,
      new Date("2026-08-11T15:00:00.000Z"),
    )).toBe("adult");
  });

  it("requires exactly the six-locale safe projection and no photo URL", () => {
    expect(parseResolvedPublicShare({
      date_kst: "2026-08-12",
      spot: { name: localized },
      caption: "기억",
      photo_available: true,
    })).toEqual({ dateKst: "2026-08-12", spotName: localized, caption: "기억" });
    expect(parseResolvedPublicShare({
      date_kst: "2026-08-12",
      spot: { name: { ...localized, vi: undefined } },
      caption: "기억",
      photo_available: true,
    })).toBeNull();
    expect(parseResolvedPublicShare({
      date_kst: "2026-08-12",
      spot: { name: localized },
      caption: "기억",
      photo_available: true,
      // Deliberate legacy invalid-payload fixture: a public photo URL must be rejected.
      photo_url: `/api/share/${shareSecret}/photo`,
    })).toBeNull();
  });

  it("accepts only the strict 202 report receipt projection", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(parsePublicShareReportReceipt({
      report: { id, status: "received" },
    })).toEqual({ id });
    expect(parsePublicShareReportReceipt({
      report: { id, status: "received", owner_id: id },
    })).toBeNull();
    expect(parsePublicShareReportReceipt({
      report: { id, status: "queued" },
    })).toBeNull();
    expect(parsePublicShareReportReceipt({
      report: { id: "not-a-uuid", status: "received" },
    })).toBeNull();
  });

  it("contains no browser persistence or legacy secret-path transport", () => {
    const clientSource = readFileSync(
      new URL("./share-client.tsx", import.meta.url),
      "utf8",
    );
    for (const forbidden of [
      "localStorage", "sessionStorage", "document.cookie", "location.search", "/api/share/",
    ]) {
      expect(clientSource).not.toContain(forbidden);
    }
    expect(clientSource).toContain('ageCheck === "underage"');
    expect(clientSource).toContain('setStage("unavailable")');
    expect(clientSource).toContain("postPublicShareJson");
  });
});
