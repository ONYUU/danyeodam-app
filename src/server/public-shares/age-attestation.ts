import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { ApiError } from "@/server/http/api-error";
import { PUBLIC_SHARE_AGE_ATTESTATION_VERSION } from "@/server/public-shares/input";

export const PUBLIC_SHARE_AGE_COOKIE_NAME = "__Host-danyeodam-share-age";
export const PUBLIC_SHARE_AGE_MAX_AGE_SECONDS = 30 * 60;

const tokenSchema = z.object({
  version: z.literal(PUBLIC_SHARE_AGE_ATTESTATION_VERSION),
  issued_at: z.number().int().nonnegative(),
  expires_at: z.number().int().positive(),
}).strict();

const signingDomain = "danyeodam:public-share:age-attestation:token:v1\0";
const keyDerivationDomain = "danyeodam:public-share:age-attestation:key:v1\0";
const encodedPayloadPattern = /^[A-Za-z0-9_-]{1,512}$/u;
const encodedSignaturePattern = /^[A-Za-z0-9_-]{43}$/u;

function derivedSigningKey(secret: string): Buffer {
  return createHmac("sha256", secret)
    .update(keyDerivationDomain, "utf8")
    .digest();
}

function signPayload(encodedPayload: string, secret: string): Buffer {
  return createHmac("sha256", derivedSigningKey(secret))
    .update(signingDomain, "utf8")
    .update(encodedPayload, "ascii")
    .digest();
}

export function createAgeAttestationToken(
  secret: string,
  nowMs = Date.now(),
  version: string = PUBLIC_SHARE_AGE_ATTESTATION_VERSION,
): string {
  const issuedAt = Math.floor(nowMs / 1_000);
  const payload = Buffer.from(JSON.stringify({
    version,
    issued_at: issuedAt,
    expires_at: issuedAt + PUBLIC_SHARE_AGE_MAX_AGE_SECONDS,
  }), "utf8").toString("base64url");
  return `${payload}.${signPayload(payload, secret).toString("base64url")}`;
}

function readCookie(cookieHeader: string | null, name: string): string | null {
  if (cookieHeader === null || cookieHeader.length > 8_192) {
    return null;
  }
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

export function verifyAgeAttestationToken(
  token: string,
  secret: string,
  nowMs = Date.now(),
): boolean {
  if (token.length > 768) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [encodedPayload, encodedSignature] = parts;
  if (
    encodedPayload === undefined
    || encodedSignature === undefined
    || !encodedPayloadPattern.test(encodedPayload)
    || !encodedSignaturePattern.test(encodedSignature)
  ) {
    return false;
  }

  const providedSignature = Buffer.from(encodedSignature, "base64url");
  const expectedSignature = signPayload(encodedPayload, secret);
  if (
    providedSignature.length !== expectedSignature.length
    || !timingSafeEqual(providedSignature, expectedSignature)
  ) {
    return false;
  }

  try {
    const claims = tokenSchema.parse(
      JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as unknown,
    );
    const nowSeconds = Math.floor(nowMs / 1_000);
    return claims.expires_at - claims.issued_at === PUBLIC_SHARE_AGE_MAX_AGE_SECONDS
      && claims.issued_at <= nowSeconds + 60
      && claims.expires_at > nowSeconds;
  } catch {
    return false;
  }
}

export function createAgeAttestationSetCookie(secret: string, nowMs = Date.now()): string {
  const token = createAgeAttestationToken(secret, nowMs);
  const expires = new Date(nowMs + PUBLIC_SHARE_AGE_MAX_AGE_SECONDS * 1_000).toUTCString();
  return `${PUBLIC_SHARE_AGE_COOKIE_NAME}=${token}; Path=/; Max-Age=${PUBLIC_SHARE_AGE_MAX_AGE_SECONDS}; Expires=${expires}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearAgeAttestationSetCookie(): string {
  return `${PUBLIC_SHARE_AGE_COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict`;
}

export function requireAgeAttestation(
  request: Request,
  secret: string | undefined,
  nowMs = Date.now(),
): void {
  if (secret === undefined) {
    throw new ApiError("INTERNAL");
  }
  const token = readCookie(request.headers.get("cookie"), PUBLIC_SHARE_AGE_COOKIE_NAME);
  if (token === null || !verifyAgeAttestationToken(token, secret, nowMs)) {
    throw new ApiError("AGE_ATTESTATION_REQUIRED", {
      version: PUBLIC_SHARE_AGE_ATTESTATION_VERSION,
      minimum_age: 18,
    });
  }
}
