import { ApiError } from "@/server/http/api-error";

export function requirePublicAppOrigin(configuredUrl: string | undefined): string {
  if (configuredUrl === undefined) {
    throw new ApiError("INTERNAL");
  }
  const url = new URL(configuredUrl);
  const localDevelopmentOrigin = url.protocol === "http:"
    && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
  if (
    (url.protocol !== "https:" && !localDevelopmentOrigin)
    || url.username !== ""
    || url.password !== ""
  ) {
    throw new ApiError("INTERNAL");
  }
  return url.origin;
}

export function publicShareUrl(origin: string, shareSlug: string): string {
  const url = new URL("/share", origin);
  url.hash = shareSlug;
  return url.toString();
}
