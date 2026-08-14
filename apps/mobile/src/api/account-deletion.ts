import type { ApiClient } from './client';
import {
  expectEnum,
  expectIsoDateTime,
  expectRecord,
  expectString,
  expectUuid,
  invalidPayload,
} from './payload';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const STATUS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export type AccountDeletionCredential = Readonly<{
  requestId: string;
  statusToken: string;
}>;

export type AccountDeletionAccepted = Readonly<{
  id: string;
  status: 'pending';
  requestedAt: string;
  completeBy: string;
}>;

export type AccountDeletionStatus = Readonly<{
  id: string;
  status: 'pending' | 'completed' | 'action_required';
  reasonCode: 'retrying' | 'manual_support_required' | null;
  requestedAt: string;
  completeBy: string;
  completedAt: string | null;
  supportUrl: string | null;
}>;

function expectExactRecord(value: unknown, keys: readonly string[]) {
  const record = expectRecord(value);
  const actual = Object.keys(record);
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
    ? record
    : invalidPayload();
}

function expectRequestId(value: unknown): string {
  const requestId = expectUuid(value);
  return UUID_V4_PATTERN.test(requestId) ? requestId : invalidPayload();
}

function expectStatusToken(value: unknown): string {
  return expectString(value, {
    minimumLength: 43,
    maximumLength: 43,
    pattern: STATUS_TOKEN_PATTERN,
  });
}

function expectNullableDateTime(value: unknown): string | null {
  return value === null ? null : expectIsoDateTime(value);
}

function expectSupportUrl(value: unknown): string | null {
  if (value === null) return null;
  const candidate = expectString(value, { minimumLength: 1, maximumLength: 2_048 });
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && url.username === '' && url.password === ''
      ? candidate
      : invalidPayload();
  } catch {
    return invalidPayload();
  }
}

export function parseAccountDeletionAccepted(value: unknown): AccountDeletionAccepted {
  const envelope = expectExactRecord(value, ['deletion_request']);
  const request = expectExactRecord(envelope.deletion_request, [
    'id',
    'status',
    'requested_at',
    'complete_by',
  ]);
  const requestedAt = expectIsoDateTime(request.requested_at);
  const completeBy = expectIsoDateTime(request.complete_by);
  if (Date.parse(completeBy) <= Date.parse(requestedAt)) return invalidPayload();
  return {
    id: expectRequestId(request.id),
    status: expectEnum(request.status, ['pending'] as const),
    requestedAt,
    completeBy,
  };
}

export function parseAccountDeletionStatus(value: unknown): AccountDeletionStatus {
  const record = expectExactRecord(value, [
    'id',
    'status',
    'reason_code',
    'requested_at',
    'complete_by',
    'completed_at',
    'support_url',
  ]);
  const status = expectEnum(record.status, [
    'pending',
    'completed',
    'action_required',
  ] as const);
  const reasonCode = record.reason_code === null
    ? null
    : expectEnum(record.reason_code, ['retrying', 'manual_support_required'] as const);
  const requestedAt = expectIsoDateTime(record.requested_at);
  const completeBy = expectIsoDateTime(record.complete_by);
  const completedAt = expectNullableDateTime(record.completed_at);
  const requestedAtMs = Date.parse(requestedAt);
  const completedAtMs = completedAt === null ? null : Date.parse(completedAt);
  if (
    Date.parse(completeBy) <= Date.parse(requestedAt)
    || (status === 'completed') !== (completedAt !== null)
    || (status === 'action_required') !== (reasonCode === 'manual_support_required')
    || (status === 'pending' && reasonCode === 'manual_support_required')
    || (status === 'completed' && reasonCode !== null)
    || (completedAtMs !== null && completedAtMs < requestedAtMs)
  ) {
    return invalidPayload();
  }
  return {
    id: expectRequestId(record.id),
    status,
    reasonCode,
    requestedAt,
    completeBy,
    completedAt,
    supportUrl: expectSupportUrl(record.support_url),
  };
}

function validateCredential(credential: AccountDeletionCredential): AccountDeletionCredential {
  return {
    requestId: expectRequestId(credential.requestId),
    statusToken: expectStatusToken(credential.statusToken),
  };
}

export function createAccountDeletionService(client: ApiClient) {
  return {
    async request(
      credential: AccountDeletionCredential,
      signal?: AbortSignal,
    ): Promise<AccountDeletionAccepted> {
      const valid = validateCredential(credential);
      const response = await client<unknown>('/api/me/deletion-requests', {
        method: 'POST',
        authenticated: true,
        json: {
          client_request_id: valid.requestId,
          status_token: valid.statusToken,
          confirmation: 'DELETE_MY_ACCOUNT',
        },
        ...(signal === undefined ? {} : { signal }),
      });
      const result = parseAccountDeletionAccepted(response);
      return result.id === valid.requestId ? result : invalidPayload();
    },

    async status(
      credential: AccountDeletionCredential,
      signal?: AbortSignal,
    ): Promise<AccountDeletionStatus> {
      const valid = validateCredential(credential);
      const response = await client<unknown>(
        `/api/account/deletion-requests/${valid.requestId}`,
        {
          authenticated: false,
          deletionStatusToken: valid.statusToken,
          ...(signal === undefined ? {} : { signal }),
        },
      );
      const result = parseAccountDeletionStatus(response);
      return result.id === valid.requestId ? result : invalidPayload();
    },
  };
}
