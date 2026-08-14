import "server-only";

import { createHmac } from "node:crypto";
import { isIP } from "node:net";

import { getServerEnvironment } from "@/server/env";
import { ApiError } from "@/server/http/api-error";

function trustedClientAddress(headers: Headers): string {
  const vercelRequestId = headers.get("x-vercel-id")?.trim();
  const forwardedFor = headers.get("x-forwarded-for")?.trim();
  if (
    vercelRequestId !== undefined
    && vercelRequestId.length > 0
    && forwardedFor !== undefined
    && !forwardedFor.includes(",")
    && isIP(forwardedFor) !== 0
  ) {
    return forwardedFor;
  }
  return "untrusted-origin";
}

export function createPublicReportClientKey(
  headers: Headers,
  secret = getServerEnvironment().ABUSE_HMAC_SECRET,
): string {
  if (secret === undefined) {
    throw new ApiError("INTERNAL");
  }
  return createHmac("sha256", secret)
    .update("danyeodam:abuse:public-report:rate-key:v2\0", "utf8")
    .update(trustedClientAddress(headers), "utf8")
    .digest("hex");
}
