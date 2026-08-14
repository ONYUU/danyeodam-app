import type { ApiClient } from './client';
import { MINIMUM_AGE_DEVICE_PASS } from '@/features/minimum-age/device-pass';

export function createMinimumAgeAttestationService(client: ApiClient) {
  return {
    async submit(signal?: AbortSignal): Promise<void> {
      await client<void>('/api/me/minimum-age-attestation', {
        method: 'POST',
        json: MINIMUM_AGE_DEVICE_PASS,
        ...(signal === undefined ? {} : { signal }),
      });
    },
  };
}
