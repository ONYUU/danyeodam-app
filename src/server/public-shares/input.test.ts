import { describe, expect, it } from "vitest";

import { readLimitedJson } from "@/server/http/body";
import {
  parseAgeAttestationInput,
  parsePublicShareBlockInput,
  parsePublicShareReportInput,
  parsePublicShareSecretInput,
  PUBLIC_SHARE_AGE_ATTESTATION_VERSION,
  PUBLIC_SHARE_REPORT_MAXIMUM_BYTES,
} from "@/server/public-shares/input";

const shareSecret = "AbCdEfGhIjKlMnOpQrStUv";
const actionId = "11111111-1111-4111-8111-111111111111";

describe("fixed public-share input contracts", () => {
  it("accepts only a bounded secret-only object for resolve and photo", () => {
    expect(parsePublicShareSecretInput({ share_secret: shareSecret })).toBe(shareSecret);
    for (const input of [
      { share_secret: "short" },
      { share_secret: shareSecret, echo: true },
      shareSecret,
    ]) {
      expect(() => parsePublicShareSecretInput(input)).toThrowError(
        expect.objectContaining({ code: "VALIDATION_FAILED", status: 400 }),
      );
    }
  });

  it("splits the secret from strict report and block payloads", () => {
    expect(parsePublicShareReportInput({
      share_secret: shareSecret,
      client_report_id: actionId,
      target: "content",
      reason: "privacy",
      comment: "  설명  ",
    })).toEqual({
      shareSecret,
      report: {
        client_report_id: actionId,
        target: "content",
        reason: "privacy",
        comment: "설명",
      },
    });
    expect(parsePublicShareBlockInput({
      share_secret: shareSecret,
      client_action_id: actionId,
    })).toEqual({ shareSecret, clientActionId: actionId });
    expect(() => parsePublicShareBlockInput({
      share_secret: shareSecret,
      client_action_id: actionId,
      owner_user_id: actionId,
    })).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it.each([
    ["Korean", "가"],
    ["Japanese", "日"],
    ["Chinese", "漢"],
  ])("accepts a 128-character secret and 300-character %s report within 4 KiB", async (
    _language,
    character,
  ) => {
    const body = JSON.stringify({
      share_secret: "A".repeat(128),
      client_report_id: actionId,
      target: "content",
      reason: "privacy",
      comment: character.repeat(300),
    });
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(1_024);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
      PUBLIC_SHARE_REPORT_MAXIMUM_BYTES,
    );
    const parsedBody = await readLimitedJson(new Request("https://example.test/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }), PUBLIC_SHARE_REPORT_MAXIMUM_BYTES);
    expect(parsePublicShareReportInput(parsedBody)).toMatchObject({
      shareSecret: "A".repeat(128),
      report: { comment: character.repeat(300) },
    });
  });

  it("rejects a 129-character secret and a 301-character report comment", () => {
    const base = {
      client_report_id: actionId,
      target: "content",
      reason: "privacy",
    } as const;
    expect(() => parsePublicShareReportInput({
      ...base,
      share_secret: "A".repeat(129),
      comment: "가".repeat(300),
    })).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => parsePublicShareReportInput({
      ...base,
      share_secret: "A".repeat(128),
      comment: "가".repeat(301),
    })).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("rejects a report transport body larger than 4 KiB", async () => {
    const body = JSON.stringify({ padding: "A".repeat(PUBLIC_SHARE_REPORT_MAXIMUM_BYTES) });
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(
      PUBLIC_SHARE_REPORT_MAXIMUM_BYTES,
    );
    await expect(readLimitedJson(new Request("https://example.test/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }), PUBLIC_SHARE_REPORT_MAXIMUM_BYTES)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 400,
    });
  });

  it("accepts only pass plus the current attestation version", () => {
    expect(parseAgeAttestationInput({
      pass: true,
      version: PUBLIC_SHARE_AGE_ATTESTATION_VERSION,
    })).toEqual({ pass: true, version: PUBLIC_SHARE_AGE_ATTESTATION_VERSION });
    expect(parseAgeAttestationInput({
      pass: false,
      version: PUBLIC_SHARE_AGE_ATTESTATION_VERSION,
    }).pass).toBe(false);
    expect(() => parseAgeAttestationInput({
      pass: true,
      version: "old",
    })).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => parseAgeAttestationInput({
      pass: true,
      version: PUBLIC_SHARE_AGE_ATTESTATION_VERSION,
      date_of_birth: "2000-01-01",
    })).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
});
