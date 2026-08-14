import { describe, expect, it } from "vitest";

import {
  parseDeletionRequestInput,
  parseDeletionStatusToken,
  parseRecoveryDeletionRequestInput,
} from "@/server/account-deletion/input";

const requestId = "11111111-1111-4111-8111-111111111111";
const token = "A".repeat(43);
const recoveryCode = Buffer.alloc(32, 1).toString("base64url");

describe("account deletion input", () => {
  it("accepts only an explicit irreversible confirmation and 256-bit status token", () => {
    expect(parseDeletionRequestInput({
      client_request_id: requestId,
      status_token: token,
      confirmation: "DELETE_MY_ACCOUNT",
    })).toEqual({
      client_request_id: requestId,
      status_token: token,
      confirmation: "DELETE_MY_ACCOUNT",
    });
  });

  it("requires the recovery code without broadening the authenticated payload", () => {
    expect(parseRecoveryDeletionRequestInput({
      recovery_code: recoveryCode,
      client_request_id: requestId,
      status_token: token,
      confirmation: "DELETE_MY_ACCOUNT",
    }).recovery_code).toBe(recoveryCode);
  });

  it.each([
    { client_request_id: requestId, status_token: "short", confirmation: "DELETE_MY_ACCOUNT" },
    { client_request_id: requestId, status_token: token, confirmation: "yes" },
    { client_request_id: requestId, status_token: token, confirmation: "DELETE_MY_ACCOUNT", extra: true },
  ])("rejects malformed or expanded deletion requests", (value) => {
    expect(() => parseDeletionRequestInput(value)).toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });

  it("rejects a missing or malformed status-token header", () => {
    expect(() => parseDeletionStatusToken(null)).toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
    expect(() => parseDeletionStatusToken(`${"A".repeat(42)}!`)).toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
    expect(() => parseDeletionStatusToken(`${"A".repeat(42)}_`)).toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });
});
