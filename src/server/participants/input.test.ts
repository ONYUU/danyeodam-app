import { describe, expect, it } from "vitest";

import {
  parseIssueParticipantInvitesInput,
  parseRedeemParticipantInput,
} from "@/server/participants/input";

describe("participant input", () => {
  it("accepts the fixed invite-code format", () => {
    expect(parseRedeemParticipantInput({
      invite_code: "AAAAAAAAAAAAAAAAAAAAAA",
    })).toEqual({ invite_code: "AAAAAAAAAAAAAAAAAAAAAA" });
  });

  it.each(["short", "AAAAAAAAAAAAAAAAAAAAA!", `${"A".repeat(23)}`])(
    "rejects an invalid invite code",
    (inviteCode) => {
      expect(() => parseRedeemParticipantInput({ invite_code: inviteCode })).toThrowError(
        expect.objectContaining({ code: "VALIDATION_FAILED" }),
      );
    },
  );

  it("bounds the admin batch and note", () => {
    expect(parseIssueParticipantInvitesInput({ count: 20, note: "현장 테스트" })).toEqual({
      count: 20,
      note: "현장 테스트",
    });
    expect(() => parseIssueParticipantInvitesInput({ count: 21 })).toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });
});
