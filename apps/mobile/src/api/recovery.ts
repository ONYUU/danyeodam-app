import type { ApiClient } from './client';
import { expectRecord, expectString, invalidPayload } from './payload';
import { requireRecoveryCode } from './sensitive-codes';

const RECOVERY_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export function parseRecoveryIssue(value: unknown): string {
  const record = expectRecord(value);
  return expectString(record.code, {
    minimumLength: 43,
    maximumLength: 43,
    pattern: RECOVERY_CODE_PATTERN,
  });
}

export function parseRecoveryClaim(value: unknown): true {
  const record = expectRecord(value);
  return record.restored === true ? true : invalidPayload();
}

export function createRecoveryService(client: ApiClient) {
  return {
    async issue(): Promise<string> {
      const response = await client<unknown>('/api/recovery/issue', { method: 'POST' });
      return parseRecoveryIssue(response);
    },
    async claim(codeValue: string): Promise<void> {
      const code = requireRecoveryCode(codeValue);
      const response = await client<unknown>('/api/recovery/claim', {
        method: 'POST',
        json: { code },
      });
      parseRecoveryClaim(response);
    },
  };
}
