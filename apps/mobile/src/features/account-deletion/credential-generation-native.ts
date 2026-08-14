import * as Crypto from 'expo-crypto';

import { generateAccountDeletionCredential } from './credential-generation';

export function generateNativeAccountDeletionCredential() {
  return generateAccountDeletionCredential({
    randomUuid: () => Crypto.randomUUID(),
    randomBytes: (length) => Crypto.getRandomBytesAsync(length),
  }, Date.now);
}
