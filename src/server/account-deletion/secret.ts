import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { isIP } from "node:net";

import { ApiError } from "@/server/http/api-error";

export type AccountDeletionPublicRateLimitScope =
  | "account_deletion_recovery_ip"
  | "account_deletion_status_ip";

export function hashAccountDeletionSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function constantTimeDigestMatch(expectedHex: string, actualHex: string): boolean {
  if (
    !/^[a-f0-9]{64}$/u.test(expectedHex)
    || !/^[a-f0-9]{64}$/u.test(actualHex)
  ) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(expectedHex, "hex"),
    Buffer.from(actualHex, "hex"),
  );
}

function firstValidIp(value: string | null): string | undefined {
  const candidate = value?.split(",", 1)[0]?.trim();
  return candidate !== undefined && isIP(candidate) !== 0 ? candidate : undefined;
}

export function trustedClientIp(
  request: Request,
  environment: { VERCEL?: string; NODE_ENV?: string } = process.env,
): string {
  if (environment.VERCEL === "1") {
    const vercelIp = firstValidIp(request.headers.get("x-vercel-forwarded-for"));
    if (vercelIp === undefined) {
      throw new ApiError("INTERNAL");
    }
    return vercelIp;
  }

  if (environment.NODE_ENV !== "production") {
    return firstValidIp(request.headers.get("x-forwarded-for")) ?? "127.0.0.1";
  }

  // In non-Vercel production there is no configured trusted-proxy contract.
  // Failing closed is safer than accepting a caller-controlled IP header.
  throw new ApiError("INTERNAL");
}

export function publicRateLimitSubjectDigest(input: {
  ip: string;
  scope: AccountDeletionPublicRateLimitScope;
  secret: string | undefined;
}): string {
  if (input.secret === undefined || input.secret.length < 32) {
    throw new ApiError("INTERNAL");
  }
  return createHmac("sha256", input.secret)
    .update(`danyeodam:${input.scope}:v1\n${input.ip}`, "utf8")
    .digest("hex");
}
