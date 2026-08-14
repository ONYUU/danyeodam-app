import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { globSync } from "node:fs";
import { describe, expect, it } from "vitest";

const apiRoot = resolve(process.cwd(), "src/app/api");
const routeFiles = globSync("**/route.ts", { cwd: apiRoot }).sort();

function routeName(file: string): string {
  return `/api/${relative(apiRoot, resolve(apiRoot, file)).replace(/\/route\.ts$/u, "")}`;
}

function isExempt(route: string): boolean {
  return route.startsWith("/api/admin/")
    || route.startsWith("/api/internal/")
    || route === "/api/me/minimum-age-attestation"
    || route === "/api/policies/current"
    || route === "/api/spots"
    || route.startsWith("/api/card-assets/");
}

const privacyRightsRoutes = new Set([
  "/api/me/location-consent",
  "/api/me/location-correction-subjects",
  "/api/me/location-corrections",
  "/api/me/location-use-facts",
  "/api/personal-cards/[id]",
]);

const activeIdentityMixedMethodRoutes = new Set([
  "/api/personal-cards/[id]/share",
]);

const deletionOnlyAuthRoutes = new Set([
  "/api/me/deletion-requests",
]);

describe("authenticated consumer route minimum-age boundary", () => {
  it("requires the adult-active verifier on every non-exempt bearer route", () => {
    const violations = routeFiles.flatMap((file) => {
      const route = routeName(file);
      const source = readFileSync(resolve(apiRoot, file), "utf8");
      if (
        isExempt(route)
        || privacyRightsRoutes.has(route)
        || deletionOnlyAuthRoutes.has(route)
        || !source.includes("requireBearerToken")
      ) return [];
      return source.includes("verifyAdultAccessToken") ? [] : [route];
    });
    expect(violations).toEqual([]);
  });

  it("limits raw Supabase JWT verification to the deletion retry route", () => {
    const violations = routeFiles.flatMap((file) => {
      const route = routeName(file);
      const source = readFileSync(resolve(apiRoot, file), "utf8");
      if (!source.includes("verifySupabaseAccessTokenUser")) return [];
      return deletionOnlyAuthRoutes.has(route) ? [] : [route];
    });
    expect(violations).toEqual([]);

    for (const route of deletionOnlyAuthRoutes) {
      const file = routeFiles.find((candidate) => routeName(candidate) === route);
      expect(file).toBeDefined();
      expect(readFileSync(resolve(apiRoot, file!), "utf8"))
        .toContain("verifySupabaseAccessTokenUser");
    }
  });

  it("keeps the privacy-rights verifier behind an exact static allowlist", () => {
    const violations = routeFiles.flatMap((file) => {
      const route = routeName(file);
      const source = readFileSync(resolve(apiRoot, file), "utf8");
      if (!source.includes("verifyActiveIdentityAccessToken")) return [];
      return privacyRightsRoutes.has(route) || activeIdentityMixedMethodRoutes.has(route)
        ? []
        : [route];
    });
    expect(violations).toEqual([]);
  });

  it("requires the active service-identity projection on every privacy-rights route", () => {
    const violations = [...privacyRightsRoutes].filter((route) => {
      const file = routeFiles.find((candidate) => routeName(candidate) === route);
      if (!file) return true;
      return !readFileSync(resolve(apiRoot, file), "utf8")
        .includes("verifyActiveIdentityAccessToken");
    });
    expect(violations).toEqual([]);
  });

  it("limits the mixed-method active verifier to share revocation", () => {
    const violations = [...activeIdentityMixedMethodRoutes].filter((route) => {
      const file = routeFiles.find((candidate) => routeName(candidate) === route);
      if (!file) return true;
      const source = readFileSync(resolve(apiRoot, file), "utf8");
      const deleteOffset = source.indexOf("export async function DELETE");
      if (deleteOffset < 0) return true;
      const beforeDelete = source.slice(0, deleteOffset);
      const deleteHandler = source.slice(deleteOffset);
      return !deleteHandler.includes("verifyActiveIdentityAccessToken(")
        || deleteHandler.includes("verifyAdultAccessToken(")
        || (beforeDelete.match(/verifyAdultAccessToken\(/gu) ?? []).length !== 2
        || beforeDelete.includes("verifyActiveIdentityAccessToken(");
    });
    expect(violations).toEqual([]);
  });
});
