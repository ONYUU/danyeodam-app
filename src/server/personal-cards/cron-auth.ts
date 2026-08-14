import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function hasValidCronAuthorization(
  authorizationHeader: string | null,
  secret: string | undefined,
): boolean {
  if (secret === undefined || secret.length < 32 || authorizationHeader === null) {
    return false;
  }

  return timingSafeEqual(
    digest(authorizationHeader),
    digest(`Bearer ${secret}`),
  );
}
