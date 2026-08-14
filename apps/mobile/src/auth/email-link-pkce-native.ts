import * as Crypto from 'expo-crypto';

import { createEmailLinkPkce } from './email-link-pkce';

export function createNativeEmailLinkPkce() {
  return createEmailLinkPkce({
    randomUUID: () => Crypto.randomUUID(),
    getRandomBytes: (length) => Crypto.getRandomBytesAsync(length),
    sha256Base64: (value) => Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      value,
      { encoding: Crypto.CryptoEncoding.BASE64 },
    ),
  });
}
