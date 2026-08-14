import "server-only";

import { randomBytes } from "node:crypto";

const SHARE_SLUG_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SHARE_SLUG_LENGTH = 22;
const UNBIASED_BYTE_LIMIT = 248;

export function createShareSlug(): string {
  let slug = "";

  while (slug.length < SHARE_SLUG_LENGTH) {
    for (const byte of randomBytes(32)) {
      // 248 is the largest multiple of 62 below 256. Rejecting the tail
      // avoids modulo bias while preserving about 131 bits of entropy.
      if (byte >= UNBIASED_BYTE_LIMIT) {
        continue;
      }

      slug += SHARE_SLUG_ALPHABET[byte % SHARE_SLUG_ALPHABET.length];
      if (slug.length === SHARE_SLUG_LENGTH) {
        return slug;
      }
    }
  }

  return slug;
}
