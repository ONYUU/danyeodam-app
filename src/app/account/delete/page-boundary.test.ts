import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "src/app/account/delete/delete-client.tsx"),
  "utf8",
);
const reviewerAuthSource = readFileSync(
  join(process.cwd(), "src/app/account/delete/reviewer-auth.ts"),
  "utf8",
);

describe("public account-deletion page boundary", () => {
  it("stores the opaque status credential before either deletion request", () => {
    const storeIndex = source.indexOf("storeDeletionCredential(window.localStorage, saved)");
    const fetchIndex = source.indexOf("const response = await fetch(endpoint");
    expect(storeIndex).toBeGreaterThan(0);
    expect(fetchIndex).toBeGreaterThan(storeIndex);
  });

  it("uses existing linked-email Auth only and never creates an account", () => {
    expect(source).toContain("shouldCreateUser: false");
    expect(source).not.toContain("signInAnonymously");
    expect(source).not.toContain("console.");
  });

  it("keeps the reviewer password path separate from ordinary email OTP", () => {
    expect(source).toContain("signInReviewerWithPassword");
    expect(source).toContain('autoComplete="current-password"');
    expect(reviewerAuthSource).toContain("auth.signInWithPassword");
    expect(reviewerAuthSource).not.toContain("signInWithOtp");
    expect(reviewerAuthSource).not.toContain("signUp");
    expect(reviewerAuthSource).not.toContain("console.");
    expect(source).not.toContain("error.message");
  });

  it("keeps status tokens out of URLs", () => {
    expect(source).toContain('"X-Deletion-Status-Token": saved.statusToken');
    expect(source).not.toMatch(/searchParams[^\n]*statusToken/u);
  });
});
