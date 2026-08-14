import type { ApiClient } from './client';
import {
  expectRecord,
  expectUuid,
  invalidPayload,
} from './payload';

export type PersonalCardDeleteService = {
  remove(input: {
    personalCardId: string;
    clientRequestId: string;
    signal?: AbortSignal;
  }): Promise<'accepted'>;
};

export function parsePersonalCardDeleteAccepted(value: unknown): 'accepted' {
  const record = expectRecord(value);
  if (
    Object.keys(record).length !== 1
    || record.status !== 'accepted'
  ) {
    return invalidPayload();
  }
  return 'accepted';
}

export function createPersonalCardDeleteService(
  client: ApiClient,
): PersonalCardDeleteService {
  return {
    async remove(input) {
      const personalCardId = expectUuid(input.personalCardId);
      const clientRequestId = expectUuid(input.clientRequestId);
      const payload = await client<unknown>(
        `/api/personal-cards/${encodeURIComponent(personalCardId)}`,
        {
          method: 'DELETE',
          expectedStatus: 202,
          json: { client_request_id: clientRequestId },
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
      );
      return parsePersonalCardDeleteAccepted(payload);
    },
  };
}
