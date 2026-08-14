import type { ApiClient } from './client';
import {
  expectArray,
  expectEnum,
  expectIsoDate,
  expectIsoDateTime,
  expectRecord,
  expectString,
  expectUuid,
  invalidPayload,
} from './payload';

const CURSOR_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const ISO_DATE_TIME_PATTERN = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/u;
const DEFAULT_PAGE_SIZE = 50;
const MAXIMUM_PAGE_SIZE = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type LocationFactFailure =
  | { code: 'LOW_ACCURACY'; details: { retry: true } }
  | { code: 'OUT_OF_RANGE'; details: { distanceBand: 'near' | 'far' } }
  | {
      code: 'ALREADY_ACQUIRED_TODAY' | 'SPOT_NOT_OPEN' | 'GATE_CLOSED';
      details: Record<string, never>;
    };

type LocationUseFactBase = {
  id: number;
  idempotencyKey: string;
  spotId: string;
  purpose: 'field_acquisition';
  collectedAt: string;
};

export type LocationUseFact = LocationUseFactBase & (
  | { outcome: 'pending'; decidedAt: null; failure: null }
  | { outcome: 'passed'; decidedAt: string; failure: null }
  | { outcome: 'failed'; decidedAt: string; failure: LocationFactFailure }
);

export type LocationUseFactsPage = {
  items: readonly LocationUseFact[];
  nextCursor: string | null;
};

export type LocationCorrectionSubject = {
  fieldAcquisitionId: string;
  spotId: string;
  acquiredOnKst: string;
};

export type LocationCorrectionSubjectsPage = {
  items: readonly LocationCorrectionSubject[];
  nextCursor: string | null;
};

export type LocationCorrectionReason =
  | 'not_my_visit'
  | 'wrong_spot'
  | 'incorrect_outcome'
  | 'other';

export type LocationCorrectionStatus =
  | 'open'
  | 'approved_pending_correction'
  | 'corrected'
  | 'rejected';

export type LocationCorrection = {
  id: string;
  locationUseFactId: number | null;
  fieldAcquisitionId: string | null;
  reason: LocationCorrectionReason;
  status: LocationCorrectionStatus;
  requestedAt: string;
  resolvedAt: string | null;
};

export type LocationCorrectionsPage = {
  items: readonly LocationCorrection[];
  nextCursor: string | null;
};

type LocationCorrectionCommonInput = {
  clientRequestId: string;
  reason: LocationCorrectionReason;
  signal?: AbortSignal;
};

export type LocationCorrectionInput = LocationCorrectionCommonInput & (
  | { locationUseFactId: number; fieldAcquisitionId?: never }
  | { locationUseFactId?: never; fieldAcquisitionId: string }
);

export class LocationRightsRequestError extends Error {
  constructor() {
    super('Location privacy-rights request input is invalid.');
    this.name = 'LocationRightsRequestError';
  }
}

function expectExactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const record = expectRecord(value);
  const actual = Object.keys(record);
  if (
    actual.length !== keys.length
    || !actual.every((key) => keys.includes(key))
  ) {
    return invalidPayload();
  }
  return record;
}

function expectEmptyRecord(value: unknown): Record<string, never> {
  const record = expectRecord(value);
  return Object.keys(record).length === 0
    ? {}
    : invalidPayload();
}

function expectPositiveInteger(value: unknown): number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
    ? value
    : invalidPayload();
}

function expectLocationDateTime(value: unknown): string {
  const candidate = expectIsoDateTime(value);
  const match = ISO_DATE_TIME_PATTERN.exec(candidate);
  if (match === null) {
    return invalidPayload();
  }
  expectIsoDate(match[1]);
  return candidate;
}

function expectNullableCursor(value: unknown): string | null {
  return value === null
    ? null
    : expectString(value, {
      minimumLength: 3,
      maximumLength: 1_024,
      pattern: CURSOR_PATTERN,
    });
}

function parseFactFailure(value: unknown): LocationFactFailure {
  const record = expectExactRecord(value, ['code', 'details']);
  const code = expectEnum(record.code, [
    'LOW_ACCURACY',
    'OUT_OF_RANGE',
    'ALREADY_ACQUIRED_TODAY',
    'SPOT_NOT_OPEN',
    'GATE_CLOSED',
  ] as const);
  if (code === 'LOW_ACCURACY') {
    const details = expectExactRecord(record.details, ['retry']);
    if (details.retry !== true) {
      return invalidPayload();
    }
    return { code, details: { retry: true } };
  }
  if (code === 'OUT_OF_RANGE') {
    const details = expectExactRecord(record.details, ['distance_band']);
    return {
      code,
      details: {
        distanceBand: expectEnum(details.distance_band, ['near', 'far'] as const),
      },
    };
  }
  return { code, details: expectEmptyRecord(record.details) };
}

function parseLocationUseFact(value: unknown): LocationUseFact {
  const record = expectExactRecord(value, [
    'id',
    'idempotency_key',
    'spot_id',
    'purpose',
    'collected_at',
    'decided_at',
    'outcome',
    'failure',
  ]);
  if (record.purpose !== 'field_acquisition') {
    return invalidPayload();
  }
  const common: LocationUseFactBase = {
    id: expectPositiveInteger(record.id),
    idempotencyKey: expectUuid(record.idempotency_key),
    spotId: expectUuid(record.spot_id),
    purpose: 'field_acquisition',
    collectedAt: expectLocationDateTime(record.collected_at),
  };
  const outcome = expectEnum(record.outcome, ['pending', 'passed', 'failed'] as const);
  if (outcome === 'pending') {
    if (record.decided_at !== null || record.failure !== null) {
      return invalidPayload();
    }
    return { ...common, outcome, decidedAt: null, failure: null };
  }

  const decidedAt = expectLocationDateTime(record.decided_at);
  if (Date.parse(decidedAt) < Date.parse(common.collectedAt)) {
    return invalidPayload();
  }
  if (outcome === 'passed') {
    if (record.failure !== null) {
      return invalidPayload();
    }
    return { ...common, outcome, decidedAt, failure: null };
  }
  return {
    ...common,
    outcome,
    decidedAt,
    failure: parseFactFailure(record.failure),
  };
}

function expectPaginationConsistency(
  itemCount: number,
  requestedLimit: number,
  nextCursor: string | null,
): void {
  if ((itemCount === requestedLimit) !== (nextCursor !== null)) {
    return invalidPayload();
  }
}

function expectResponseLimit(value: number): number {
  return Number.isSafeInteger(value)
    && value >= 1
    && value <= MAXIMUM_PAGE_SIZE
    ? value
    : invalidPayload();
}

export function parseLocationUseFactsPage(
  value: unknown,
  requestedLimit = DEFAULT_PAGE_SIZE,
): LocationUseFactsPage {
  expectResponseLimit(requestedLimit);
  const record = expectExactRecord(value, ['items', 'next_cursor']);
  const items = expectArray(record.items, requestedLimit).map(parseLocationUseFact);
  const nextCursor = expectNullableCursor(record.next_cursor);
  expectPaginationConsistency(items.length, requestedLimit, nextCursor);
  if (
    new Set(items.map(({ id }) => id)).size !== items.length
    || new Set(items.map(({ idempotencyKey }) => idempotencyKey)).size !== items.length
  ) {
    return invalidPayload();
  }
  return { items, nextCursor };
}

function parseLocationCorrectionSubject(value: unknown): LocationCorrectionSubject {
  const record = expectExactRecord(value, [
    'field_acquisition_id',
    'spot_id',
    'acquired_on_kst',
  ]);
  return {
    fieldAcquisitionId: expectUuid(record.field_acquisition_id),
    spotId: expectUuid(record.spot_id),
    acquiredOnKst: expectIsoDate(record.acquired_on_kst),
  };
}

export function parseLocationCorrectionSubjectsPage(
  value: unknown,
  requestedLimit = DEFAULT_PAGE_SIZE,
): LocationCorrectionSubjectsPage {
  expectResponseLimit(requestedLimit);
  const record = expectExactRecord(value, ['items', 'next_cursor']);
  const items = expectArray(record.items, requestedLimit)
    .map(parseLocationCorrectionSubject);
  const nextCursor = expectNullableCursor(record.next_cursor);
  expectPaginationConsistency(items.length, requestedLimit, nextCursor);
  if (
    new Set(items.map(({ fieldAcquisitionId }) => fieldAcquisitionId)).size
      !== items.length
  ) {
    return invalidPayload();
  }
  return { items, nextCursor };
}

function parseLocationCorrection(value: unknown): LocationCorrection {
  const record = expectExactRecord(value, [
    'id',
    'location_use_fact_id',
    'field_acquisition_id',
    'reason',
    'status',
    'requested_at',
    'resolved_at',
  ]);
  const locationUseFactId = record.location_use_fact_id === null
    ? null
    : expectPositiveInteger(record.location_use_fact_id);
  const fieldAcquisitionId = record.field_acquisition_id === null
    ? null
    : expectUuid(record.field_acquisition_id);
  const status = expectEnum(record.status, [
    'open',
    'approved_pending_correction',
    'corrected',
    'rejected',
  ] as const);
  const requestedAt = expectLocationDateTime(record.requested_at);
  const resolvedAt = record.resolved_at === null
    ? null
    : expectLocationDateTime(record.resolved_at);
  const targetCount = Number(locationUseFactId !== null)
    + Number(fieldAcquisitionId !== null);
  const pending = status === 'open' || status === 'approved_pending_correction';
  if (
    (pending && (targetCount !== 1 || resolvedAt !== null))
    || (!pending && (targetCount > 1 || resolvedAt === null))
    || (resolvedAt !== null && Date.parse(resolvedAt) < Date.parse(requestedAt))
  ) {
    return invalidPayload();
  }
  return {
    id: expectUuid(record.id),
    locationUseFactId,
    fieldAcquisitionId,
    reason: expectEnum(record.reason, [
      'not_my_visit',
      'wrong_spot',
      'incorrect_outcome',
      'other',
    ] as const),
    status,
    requestedAt,
    resolvedAt,
  };
}

export function parseLocationCorrectionsPage(
  value: unknown,
  requestedLimit = DEFAULT_PAGE_SIZE,
): LocationCorrectionsPage {
  expectResponseLimit(requestedLimit);
  const record = expectExactRecord(value, ['items', 'next_cursor']);
  const items = expectArray(record.items, requestedLimit).map(parseLocationCorrection);
  const nextCursor = expectNullableCursor(record.next_cursor);
  expectPaginationConsistency(items.length, requestedLimit, nextCursor);
  if (new Set(items.map(({ id }) => id)).size !== items.length) {
    return invalidPayload();
  }
  return { items, nextCursor };
}

export function parseLocationCorrections(
  value: unknown,
  requestedLimit = DEFAULT_PAGE_SIZE,
): readonly LocationCorrection[] {
  return parseLocationCorrectionsPage(value, requestedLimit).items;
}

export function parseLocationCorrectionCreated(value: unknown): string {
  const record = expectExactRecord(value, ['correction_request_id']);
  return expectUuid(record.correction_request_id);
}

function requireLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_PAGE_SIZE) {
    throw new LocationRightsRequestError();
  }
  return limit;
}

function requireCursor(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    value.length < 3
    || value.length > 1_024
    || !CURSOR_PATTERN.test(value)
  ) {
    throw new LocationRightsRequestError();
  }
  return value;
}

function requireCorrectionInput(input: LocationCorrectionInput): {
  json: Record<string, unknown>;
  signal?: AbortSignal;
} {
  const record = input as unknown as Record<string, unknown>;
  const hasFact = Object.prototype.hasOwnProperty.call(
    record,
    'locationUseFactId',
  );
  const hasAcquisition = Object.prototype.hasOwnProperty.call(
    record,
    'fieldAcquisitionId',
  );
  const allowedKeys = new Set([
    'clientRequestId',
    'reason',
    'signal',
    hasFact ? 'locationUseFactId' : 'fieldAcquisitionId',
  ]);
  if (
    hasFact === hasAcquisition
    || Object.keys(record).some((key) => !allowedKeys.has(key))
  ) {
    throw new LocationRightsRequestError();
  }
  const clientRequestId = record.clientRequestId;
  const reason = record.reason;
  if (
    typeof clientRequestId !== 'string'
    || !UUID_PATTERN.test(clientRequestId)
    || typeof reason !== 'string'
    || ![
      'not_my_visit',
      'wrong_spot',
      'incorrect_outcome',
      'other',
    ].includes(reason)
  ) {
    throw new LocationRightsRequestError();
  }
  const subject = hasFact
    ? record.locationUseFactId
    : record.fieldAcquisitionId;
  if (
    (hasFact && (
      typeof subject !== 'number'
      || !Number.isSafeInteger(subject)
      || subject <= 0
    ))
    || (
      hasAcquisition
      && (
        typeof subject !== 'string'
        || !UUID_PATTERN.test(subject)
      )
    )
  ) {
    throw new LocationRightsRequestError();
  }
  return {
    json: {
      ...(hasFact
        ? { location_use_fact_id: subject }
        : { field_acquisition_id: subject }),
      client_request_id: clientRequestId,
      reason,
    },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

function pagedPath(base: string, limit: number, cursor?: string): string {
  return cursor === undefined
    ? `${base}?limit=${limit}`
    : `${base}?limit=${limit}&cursor=${encodeURIComponent(cursor)}`;
}

export function createLocationRightsService(client: ApiClient) {
  async function readCorrectionsPage(input: {
    limit?: number;
    cursor?: string;
    signal?: AbortSignal;
  } = {}): Promise<LocationCorrectionsPage> {
    const limit = requireLimit(input.limit);
    const cursor = requireCursor(input.cursor);
    const response = await client<unknown>(
      pagedPath('/api/me/location-corrections', limit, cursor),
      {
        authenticated: true,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    );
    return parseLocationCorrectionsPage(response, limit);
  }

  return {
    async facts(input: {
      limit?: number;
      cursor?: string;
      signal?: AbortSignal;
    } = {}): Promise<LocationUseFactsPage> {
      const limit = requireLimit(input.limit);
      const cursor = requireCursor(input.cursor);
      const response = await client<unknown>(
        pagedPath('/api/me/location-use-facts', limit, cursor),
        {
          authenticated: true,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
      );
      return parseLocationUseFactsPage(response, limit);
    },

    async correctionSubjects(input: {
      limit?: number;
      cursor?: string;
      signal?: AbortSignal;
    } = {}): Promise<LocationCorrectionSubjectsPage> {
      const limit = requireLimit(input.limit);
      const cursor = requireCursor(input.cursor);
      const response = await client<unknown>(
        pagedPath('/api/me/location-correction-subjects', limit, cursor),
        {
          authenticated: true,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
      );
      return parseLocationCorrectionSubjectsPage(response, limit);
    },

    correctionsPage: readCorrectionsPage,

    async corrections(input: {
      limit?: number;
      signal?: AbortSignal;
    } = {}): Promise<readonly LocationCorrection[]> {
      return (await readCorrectionsPage(input)).items;
    },

    async submitCorrection(input: LocationCorrectionInput): Promise<string> {
      const request = requireCorrectionInput(input);
      const response = await client<unknown>('/api/me/location-corrections', {
        method: 'POST',
        authenticated: true,
        json: request.json,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      return parseLocationCorrectionCreated(response);
    },
  };
}
