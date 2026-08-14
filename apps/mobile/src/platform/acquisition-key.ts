import { randomUUID } from 'expo-crypto';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function createAcquisitionIdempotencyKey(): string {
  const value = randomUUID();
  if (!UUID_V4_PATTERN.test(value)) {
    throw new Error('ACQUISITION_KEY_GENERATION_FAILED');
  }
  return value;
}
