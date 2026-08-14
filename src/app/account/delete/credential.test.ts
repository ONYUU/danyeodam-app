import { describe, expect, it } from "vitest";

import {
  createDeletionCredential,
  parseDeletionCredential,
} from "@/app/account/delete/credential";

describe("public account-deletion credential", () => {
  it("creates an opaque request ID and 32-byte base64url status token", () => {
    const credential = createDeletionCredential(globalThis.crypto);
    expect(credential.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(credential.statusToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(parseDeletionCredential(JSON.stringify(credential))).toEqual(credential);
  });

  it("fails closed on malformed or extended stored values", () => {
    expect(parseDeletionCredential(null)).toBeNull();
    expect(parseDeletionCredential("not-json")).toBeNull();
    expect(parseDeletionCredential(JSON.stringify({
      requestId: "11111111-1111-4111-8111-111111111111",
      statusToken: "A".repeat(43),
      email: "must-not-be-stored@example.test",
    }))).toBeNull();
  });
});
