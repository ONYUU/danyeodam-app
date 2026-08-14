import { createHash, randomBytes } from "node:crypto";

export function createInviteCode(): string {
  return randomBytes(16).toString("base64url");
}

export function hashInviteCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}
