import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { ApiError } from "@/server/http/api-error";

const bonusPackPayloadSchema = z.object({
  v: z.literal(1),
  issued_at: z.iso.datetime({ offset: true }),
  bonus_pack_id: z.uuid(),
}).strict();
const inventoryPayloadSchema = z.object({
  v: z.literal(1),
  last_acquired_at: z.iso.datetime({ offset: true }),
  card_id: z.uuid(),
}).strict();
const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;

export type BonusPackCursor = z.infer<typeof bonusPackPayloadSchema>;
export type CardInventoryCursor = z.infer<typeof inventoryPayloadSchema>;

function signature(
  domain: "bonus-packs" | "card-inventory",
  payload: string,
  authUserId: string,
  secret: string,
): Buffer {
  return createHmac("sha256", secret)
    .update(`danyeodam.${domain}.v1\n`, "utf8")
    .update(authUserId, "utf8")
    .update("\n", "utf8")
    .update(payload, "utf8")
    .digest();
}

function encode(
  domain: "bonus-packs" | "card-inventory",
  value: Record<string, unknown>,
  authUserId: string,
  secret: string,
): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, ...value }), "utf8").toString("base64url");
  return `${payload}.${signature(domain, payload, authUserId, secret).toString("base64url")}`;
}

function decode(
  domain: "bonus-packs" | "card-inventory",
  token: string,
  authUserId: string,
  secret: string,
): unknown {
  try {
    if (token.length > 1_024) throw new Error("cursor too long");
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("invalid framing");
    const [payload, encodedSignature] = parts as [string, string];
    if (!base64UrlPattern.test(payload) || !base64UrlPattern.test(encodedSignature)) {
      throw new Error("invalid encoding");
    }
    const supplied = Buffer.from(encodedSignature, "base64url");
    const expected = signature(domain, payload, authUserId, secret);
    if (
      supplied.toString("base64url") !== encodedSignature
      || supplied.length !== expected.length
      || !timingSafeEqual(supplied, expected)
    ) {
      throw new Error("invalid signature");
    }
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new ApiError("VALIDATION_FAILED");
  }
}

export function encodeBonusPackCursor(
  anchor: Omit<BonusPackCursor, "v">,
  authUserId: string,
  secret: string,
): string {
  return encode("bonus-packs", anchor, authUserId, secret);
}

export function decodeBonusPackCursor(
  token: string,
  authUserId: string,
  secret: string,
): BonusPackCursor {
  try {
    return bonusPackPayloadSchema.parse(
      decode("bonus-packs", token, authUserId, secret),
    );
  } catch {
    throw new ApiError("VALIDATION_FAILED");
  }
}

export function encodeCardInventoryCursor(
  anchor: Omit<CardInventoryCursor, "v">,
  authUserId: string,
  secret: string,
): string {
  return encode("card-inventory", anchor, authUserId, secret);
}

export function decodeCardInventoryCursor(
  token: string,
  authUserId: string,
  secret: string,
): CardInventoryCursor {
  try {
    return inventoryPayloadSchema.parse(
      decode("card-inventory", token, authUserId, secret),
    );
  } catch {
    throw new ApiError("VALIDATION_FAILED");
  }
}
