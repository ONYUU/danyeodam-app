import { createHash, randomBytes } from "node:crypto";

export function createRecoveryCode(): string {
  return randomBytes(32).toString("base64url");
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}
