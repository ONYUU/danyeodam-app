import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { ApiError } from "@/server/http/api-error";

const payloadSchema = z.object({
  v: z.literal(1),
  collected_at: z.iso.datetime({ offset: true }),
  fact_id: z.number().int().positive(),
}).strict();
const correctionSubjectPayloadSchema = z.object({
  v: z.literal(1),
  acquired_on_kst: z.iso.date(),
  acquisition_id: z.uuid(),
}).strict();
const correctionPayloadSchema = z.object({
  v: z.literal(1),
  requested_at: z.iso.datetime({ offset: true }),
  correction_request_id: z.uuid(),
}).strict();
const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;

export type LocationFactCursor = z.infer<typeof payloadSchema>;
export type LocationCorrectionSubjectCursor = z.infer<
  typeof correctionSubjectPayloadSchema
>;
export type LocationCorrectionCursor = z.infer<typeof correctionPayloadSchema>;

function sign(payload: string, authUserId: string, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update("danyeodam.location-facts.v1\n", "utf8")
    .update(authUserId, "utf8")
    .update("\n", "utf8")
    .update(payload, "utf8")
    .digest();
}

function signCorrectionSubject(
  payload: string,
  authUserId: string,
  secret: string,
): Buffer {
  return createHmac("sha256", secret)
    .update("danyeodam.location-correction-subjects.v1\n", "utf8")
    .update(authUserId, "utf8")
    .update("\n", "utf8")
    .update(payload, "utf8")
    .digest();
}

function signCorrection(
  payload: string,
  authUserId: string,
  secret: string,
): Buffer {
  return createHmac("sha256", secret)
    .update("danyeodam.location-corrections.v1\n", "utf8")
    .update(authUserId, "utf8")
    .update("\n", "utf8")
    .update(payload, "utf8")
    .digest();
}

export function encodeLocationFactCursor(
  anchor: Omit<LocationFactCursor, "v">,
  authUserId: string,
  secret: string,
): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, ...anchor }), "utf8").toString("base64url");
  return `${payload}.${sign(payload, authUserId, secret).toString("base64url")}`;
}

export function decodeLocationFactCursor(
  token: string,
  authUserId: string,
  secret: string,
): LocationFactCursor {
  try {
    if (token.length > 1_024) throw new Error("cursor too long");
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("invalid framing");
    const [payload, encodedSignature] = parts as [string, string];
    if (!base64UrlPattern.test(payload) || !base64UrlPattern.test(encodedSignature)) {
      throw new Error("invalid encoding");
    }
    const supplied = Buffer.from(encodedSignature, "base64url");
    const expected = sign(payload, authUserId, secret);
    if (
      supplied.toString("base64url") !== encodedSignature
      || supplied.length !== expected.length
      || !timingSafeEqual(supplied, expected)
    ) {
      throw new Error("invalid signature");
    }
    return payloadSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    throw new ApiError("VALIDATION_FAILED");
  }
}

export function encodeLocationCorrectionSubjectCursor(
  anchor: Omit<LocationCorrectionSubjectCursor, "v">,
  authUserId: string,
  secret: string,
): string {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, ...anchor }),
    "utf8",
  ).toString("base64url");
  return `${payload}.${signCorrectionSubject(payload, authUserId, secret).toString("base64url")}`;
}

export function decodeLocationCorrectionSubjectCursor(
  token: string,
  authUserId: string,
  secret: string,
): LocationCorrectionSubjectCursor {
  try {
    if (token.length > 1_024) throw new Error("cursor too long");
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("invalid framing");
    const [payload, encodedSignature] = parts as [string, string];
    if (!base64UrlPattern.test(payload) || !base64UrlPattern.test(encodedSignature)) {
      throw new Error("invalid encoding");
    }
    const supplied = Buffer.from(encodedSignature, "base64url");
    const expected = signCorrectionSubject(payload, authUserId, secret);
    if (
      supplied.toString("base64url") !== encodedSignature
      || supplied.length !== expected.length
      || !timingSafeEqual(supplied, expected)
    ) {
      throw new Error("invalid signature");
    }
    return correctionSubjectPayloadSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
  } catch {
    throw new ApiError("VALIDATION_FAILED");
  }
}

export function encodeLocationCorrectionCursor(
  anchor: Omit<LocationCorrectionCursor, "v">,
  authUserId: string,
  secret: string,
): string {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, ...anchor }),
    "utf8",
  ).toString("base64url");
  return `${payload}.${signCorrection(payload, authUserId, secret).toString("base64url")}`;
}

export function decodeLocationCorrectionCursor(
  token: string,
  authUserId: string,
  secret: string,
): LocationCorrectionCursor {
  try {
    if (token.length > 1_024) throw new Error("cursor too long");
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("invalid framing");
    const [payload, encodedSignature] = parts as [string, string];
    if (!base64UrlPattern.test(payload) || !base64UrlPattern.test(encodedSignature)) {
      throw new Error("invalid encoding");
    }
    const supplied = Buffer.from(encodedSignature, "base64url");
    const expected = signCorrection(payload, authUserId, secret);
    if (
      supplied.toString("base64url") !== encodedSignature
      || supplied.length !== expected.length
      || !timingSafeEqual(supplied, expected)
    ) {
      throw new Error("invalid signature");
    }
    return correctionPayloadSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
  } catch {
    throw new ApiError("VALIDATION_FAILED");
  }
}
