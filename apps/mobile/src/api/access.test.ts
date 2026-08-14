import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from './client';
import { ApiTransportError } from './client';
import { createAccessService, parseAccessProjection } from './access';

describe('access projection', () => {
  it('accepts standard and fully provisioned reviewer projections', () => {
    expect(parseAccessProjection({
      participant: false,
      access_type: 'standard',
      field_acquisition_requires_location: true,
      fixture_version: null,
    })).toEqual({
      participant: false,
      accessType: 'standard',
      fieldAcquisitionRequiresLocation: true,
      fixtureVersion: null,
    });
    expect(parseAccessProjection({
      participant: true,
      access_type: 'store_reviewer',
      field_acquisition_requires_location: true,
      fixture_version: 'review-2026.08',
    })).toEqual({
      participant: true,
      accessType: 'store_reviewer',
      fieldAcquisitionRequiresLocation: true,
      fixtureVersion: 'review-2026.08',
    });
  });

  it('rejects any projection that could imply a reviewer location bypass', () => {
    for (const projection of [
      {
        participant: true,
        access_type: 'store_reviewer',
        field_acquisition_requires_location: false,
        fixture_version: 'review-2026.08',
      },
      {
        participant: true,
        access_type: 'store_reviewer',
        field_acquisition_requires_location: true,
        fixture_version: null,
      },
      {
        participant: true,
        access_type: 'standard',
        field_acquisition_requires_location: true,
        fixture_version: 'unexpected',
      },
    ]) {
      expect(() => parseAccessProjection(projection)).toThrow(ApiTransportError);
    }
  });

  it('loads the current access projection through the protected API client', async () => {
    const client = vi.fn(async () => ({
      participant: true,
      access_type: 'standard',
      field_acquisition_requires_location: true,
      fixture_version: null,
    }));
    const getAccess = createAccessService(client as unknown as ApiClient);

    await expect(getAccess()).resolves.toMatchObject({ participant: true });
    expect(client).toHaveBeenCalledWith('/api/me/access', {});
  });
});
