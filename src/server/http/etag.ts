import { createHash } from "node:crypto";

export function contentVersionEtag(contentVersion: string): string {
  const digest = createHash("sha256").update(contentVersion, "utf8").digest("base64url");
  return `"${digest}"`;
}

function weakOpaqueTag(tag: string): string | null {
  const trimmed = tag.trim();
  const withoutWeakPrefix = trimmed.startsWith("W/") ? trimmed.slice(2).trimStart() : trimmed;
  return /^"[^"\r\n]*"$/u.test(withoutWeakPrefix) ? withoutWeakPrefix : null;
}

export function ifNoneMatchMatches(header: string | null, etag: string): boolean {
  if (header === null) {
    return false;
  }
  return header
    .split(",")
    .some((candidate) => candidate.trim() === "*" || weakOpaqueTag(candidate) === etag);
}
