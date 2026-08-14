import type { ApiClient } from './client';
import {
  expectBoolean,
  expectEnum,
  expectRecord,
  expectString,
  invalidPayload,
} from './payload';

export type AccessProjection =
  | {
      participant: boolean;
      accessType: 'standard';
      fieldAcquisitionRequiresLocation: true;
      fixtureVersion: null;
    }
  | {
      participant: true;
      accessType: 'store_reviewer';
      fieldAcquisitionRequiresLocation: true;
      fixtureVersion: string;
    };

export function parseAccessProjection(value: unknown): AccessProjection {
  const record = expectRecord(value);
  const participant = expectBoolean(record.participant);
  const accessType = expectEnum(record.access_type, ['standard', 'store_reviewer'] as const);
  if (record.field_acquisition_requires_location !== true) {
    return invalidPayload();
  }

  if (accessType === 'store_reviewer') {
    if (!participant || record.fixture_version === null) {
      return invalidPayload();
    }
    return {
      participant: true,
      accessType,
      fieldAcquisitionRequiresLocation: true,
      fixtureVersion: expectString(record.fixture_version, {
        minimumLength: 1,
        maximumLength: 64,
      }),
    };
  }

  if (record.fixture_version !== null) {
    return invalidPayload();
  }
  return {
    participant,
    accessType,
    fieldAcquisitionRequiresLocation: true,
    fixtureVersion: null,
  };
}

export function createAccessService(client: ApiClient) {
  return async function getAccess(signal?: AbortSignal): Promise<AccessProjection> {
    const response = await client<unknown>('/api/me/access', {
      ...(signal === undefined ? {} : { signal }),
    });
    return parseAccessProjection(response);
  };
}
