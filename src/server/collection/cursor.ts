import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { ApiError } from "@/server/http/api-error";

const cursorPayloadSchema = z.object({
  v: z.literal(1),
  acquired_at: z.iso.datetime({ offset: true }),
  acquisition_id: z.uuid(),
}).strict();
const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;

export type CollectionCursor = z.infer<typeof cursorPayloadSchema>;

function signature(payload: string, authUserId: string, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update("danyeodam.collection.v1\n", "utf8")
    .update(authUserId, "utf8")
    .update("\n", "utf8")
    .update(payload, "utf8")
    .digest();
}

export function encodeCollectionCursor(
  anchor: Omit<CollectionCursor, "v">,
  authUserId: string,
  secret: string,
): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, ...anchor }), "utf8").toString("base64url");
  return `${payload}.${signature(payload, authUserId, secret).toString("base64url")}`;
}

export function decodeCollectionCursor(
  token: string,
  authUserId: string,
  secret: string,
): CollectionCursor {
  try {
    if (token.length > 1_024) {
      throw new Error("cursor too long");
    }
    const parts = token.split(".");
    if (parts.length !== 2 || parts[0]?.length === 0 || parts[1]?.length === 0) {
      throw new Error("cursor framing invalid");
    }
    const [payload, encodedSignature] = parts as [string, string];
    if (!base64UrlPattern.test(payload) || !base64UrlPattern.test(encodedSignature)) {
      throw new Error("cursor encoding invalid");
    }
    const supplied = Buffer.from(encodedSignature, "base64url");
    const expected = signature(payload, authUserId, secret);
    if (
      supplied.toString("base64url") !== encodedSignature
      || supplied.length !== expected.length
      || !timingSafeEqual(supplied, expected)
    ) {
      throw new Error("cursor signature invalid");
    }
    return cursorPayloadSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
  } catch {
    throw new ApiError("VALIDATION_FAILED");
  }
}
