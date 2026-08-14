import { describe, expect, it, vi } from 'vitest';

import { MINIMUM_AGE_DEVICE_PASS } from '@/features/minimum-age/device-pass';

import type { ApiClient, ApiRequestOptions } from './client';
import { createMinimumAgeAttestationService } from './minimum-age-attestation';

function mockApiClient() {
  const request = vi.fn(async () => undefined);
  const client = request as unknown as ApiClient;
  client.cacheAware = vi.fn();
  return { client, request };
}

describe('minimum-age attestation API client', () => {
  it('posts only the fixed boolean and policy version after authentication', async () => {
    const { client, request } = mockApiClient();
    const service = createMinimumAgeAttestationService(client);
    const controller = new AbortController();

    await service.submit(controller.signal);

    expect(request).toHaveBeenCalledWith('/api/me/minimum-age-attestation', {
      method: 'POST',
      json: MINIMUM_AGE_DEVICE_PASS,
      signal: controller.signal,
    });
    const calls = request.mock.calls as unknown as [
      string,
      ApiRequestOptions,
    ][];
    const options = calls[0]?.[1];
    expect(Object.keys(options?.json ?? {}).sort()).toEqual([
      'minimum_age_passed',
      'version',
    ]);
    expect(JSON.stringify(options)).not.toMatch(/birth|dob|year|date|hash/iu);
  });
});
