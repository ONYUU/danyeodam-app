import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from './client';
import { ApiTransportError } from './client';
import {
  LocationRightsRequestError,
  createLocationRightsService,
  parseLocationCorrectionCreated,
  parseLocationCorrections,
  parseLocationCorrectionsPage,
  parseLocationCorrectionSubjectsPage,
  parseLocationUseFactsPage,
} from './location-rights';

const cursor = 'eyJ2IjoxfQ.signature_1';
const spotId = '11111111-1111-4111-8111-111111111111';
const acquisitionId = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333';

const pendingFact = {
  id: 1,
  idempotency_key: '44444444-4444-4444-8444-444444444441',
  spot_id: spotId,
  purpose: 'field_acquisition',
  collected_at: '2026-08-12T00:00:00.000Z',
  decided_at: null,
  outcome: 'pending',
  failure: null,
};

const passedFact = {
  ...pendingFact,
  id: 2,
  idempotency_key: '44444444-4444-4444-8444-444444444442',
  decided_at: '2026-08-12T00:00:01.000Z',
  outcome: 'passed',
};

const failedFact = {
  ...pendingFact,
  id: 3,
  idempotency_key: '44444444-4444-4444-8444-444444444443',
  decided_at: '2026-08-12T00:00:01.000Z',
  outcome: 'failed',
  failure: { code: 'OUT_OF_RANGE', details: { distance_band: 'far' } },
};

const subject = {
  field_acquisition_id: acquisitionId,
  spot_id: spotId,
  acquired_on_kst: '2026-08-12',
};

const openCorrection = {
  id: '55555555-5555-4555-8555-555555555555',
  location_use_fact_id: 3,
  field_acquisition_id: null,
  reason: 'incorrect_outcome',
  status: 'open',
  requested_at: '2026-08-12T01:00:00.000Z',
  resolved_at: null,
};

describe('location privacy-rights service', () => {
  it('parses every location fact outcome and keeps only coarse failure details', () => {
    const parsed = parseLocationUseFactsPage({
      items: [pendingFact, passedFact, failedFact],
      next_cursor: null,
    });

    expect(parsed.items.map(({ outcome }) => outcome)).toEqual([
      'pending',
      'passed',
      'failed',
    ]);
    expect(parsed.items[2]).toMatchObject({
      failure: { code: 'OUT_OF_RANGE', details: { distanceBand: 'far' } },
    });
  });

  it.each([
    [{ code: 'LOW_ACCURACY', details: { retry: true } }, { retry: true }],
    [{ code: 'ALREADY_ACQUIRED_TODAY', details: {} }, {}],
    [{ code: 'SPOT_NOT_OPEN', details: {} }, {}],
    [{ code: 'GATE_CLOSED', details: {} }, {}],
  ])('accepts the bounded terminal failure %o', (failure, details) => {
    const parsed = parseLocationUseFactsPage({
      items: [{ ...failedFact, failure }],
      next_cursor: cursor,
    }, 1);
    expect(parsed.items[0]).toMatchObject({ failure: { details } });
  });

  it('rejects raw coordinates, extra failure diagnostics, and inconsistent outcomes', () => {
    for (const fact of [
      { ...failedFact, latitude: 37.5 },
      {
        ...failedFact,
        failure: {
          code: 'OUT_OF_RANGE',
          details: { distance_band: 'far', distance_m: 300 },
        },
      },
      { ...passedFact, failure: { code: 'SPOT_NOT_OPEN', details: {} } },
      { ...pendingFact, decided_at: '2026-08-12T00:00:01Z' },
      { ...failedFact, decided_at: '2026-08-11T23:59:59Z' },
    ]) {
      expect(() => parseLocationUseFactsPage({
        items: [fact],
        next_cursor: null,
      })).toThrow(ApiTransportError);
    }
  });

  it('enforces signed cursor shape, page cardinality, and unique fact keys', () => {
    expect(() => parseLocationUseFactsPage({
      items: [pendingFact],
      next_cursor: null,
    }, 1)).toThrow(ApiTransportError);
    expect(() => parseLocationUseFactsPage({
      items: [pendingFact],
      next_cursor: 'not-a-signed-cursor',
    }, 1)).toThrow(ApiTransportError);
    expect(() => parseLocationUseFactsPage({
      items: [pendingFact, { ...pendingFact, id: 4 }],
      next_cursor: null,
    })).toThrow(ApiTransportError);
  });

  it('parses only the minimum correction-subject disclosure', () => {
    expect(parseLocationCorrectionSubjectsPage({
      items: [subject],
      next_cursor: cursor,
    }, 1)).toEqual({
      items: [{
        fieldAcquisitionId: acquisitionId,
        spotId,
        acquiredOnKst: '2026-08-12',
      }],
      nextCursor: cursor,
    });
    expect(() => parseLocationCorrectionSubjectsPage({
      items: [{ ...subject, acquired_at: '2026-08-12T01:00:00Z' }],
      next_cursor: cursor,
    }, 1)).toThrow(ApiTransportError);
    expect(() => parseLocationCorrectionSubjectsPage({
      items: [{ ...subject, acquired_on_kst: '2026-02-30' }],
      next_cursor: cursor,
    }, 1)).toThrow(ApiTransportError);
  });

  it('parses pending and terminal correction target invariants', () => {
    const parsed = parseLocationCorrections({
      items: [
        openCorrection,
        {
          ...openCorrection,
          id: '66666666-6666-4666-8666-666666666666',
          location_use_fact_id: null,
          field_acquisition_id: acquisitionId,
          status: 'approved_pending_correction',
        },
        {
          ...openCorrection,
          id: '77777777-7777-4777-8777-777777777777',
          location_use_fact_id: null,
          status: 'corrected',
          resolved_at: '2026-08-12T02:00:00.000Z',
        },
      ],
      next_cursor: null,
    });
    expect(parsed.map(({ status }) => status)).toEqual([
      'open',
      'approved_pending_correction',
      'corrected',
    ]);
  });

  it('rejects malformed correction targets, states, dates, and duplicate IDs', () => {
    for (const correction of [
      { ...openCorrection, field_acquisition_id: acquisitionId },
      { ...openCorrection, location_use_fact_id: null },
      { ...openCorrection, status: 'corrected' },
      {
        ...openCorrection,
        status: 'rejected',
        resolved_at: '2026-08-12T00:59:59Z',
      },
      { ...openCorrection, reason: 'precise_distance_wrong' },
    ]) {
      expect(() => parseLocationCorrections({
        items: [correction],
        next_cursor: null,
      }))
        .toThrow(ApiTransportError);
    }
    expect(() => parseLocationCorrections({
      items: [openCorrection, openCorrection],
      next_cursor: null,
    })).toThrow(ApiTransportError);
  });

  it('enforces correction-history cursor shape and page cardinality', () => {
    expect(parseLocationCorrectionsPage({
      items: [openCorrection],
      next_cursor: cursor,
    }, 1)).toEqual({
      items: [expect.objectContaining({ id: openCorrection.id })],
      nextCursor: cursor,
    });
    expect(() => parseLocationCorrectionsPage({
      items: [openCorrection],
      next_cursor: null,
    }, 1)).toThrow(ApiTransportError);
    expect(() => parseLocationCorrectionsPage({
      items: [],
      next_cursor: cursor,
    })).toThrow(ApiTransportError);
    expect(() => parseLocationCorrectionsPage({
      items: [],
      next_cursor: null,
      user_id: requestId,
    })).toThrow(ApiTransportError);
  });

  it('parses only a strict correction receipt UUID', () => {
    expect(parseLocationCorrectionCreated({ correction_request_id: requestId }))
      .toBe(requestId);
    expect(() => parseLocationCorrectionCreated({
      correction_request_id: requestId,
      storage_path: 'private/path',
    })).toThrow(ApiTransportError);
  });

  it('calls all rights reads through authenticated, bounded routes', async () => {
    const responses: unknown[] = [
      { items: [], next_cursor: null },
      { items: [], next_cursor: null },
      { items: [openCorrection], next_cursor: cursor },
      { items: [openCorrection], next_cursor: null },
    ];
    const client = vi.fn(async () => responses.shift());
    const service = createLocationRightsService(client as unknown as ApiClient);

    await service.facts({ limit: 10, cursor });
    await service.correctionSubjects({ limit: 20, cursor });
    await expect(service.correctionsPage({ limit: 1, cursor })).resolves.toEqual({
      items: [expect.objectContaining({ id: openCorrection.id })],
      nextCursor: cursor,
    });
    await expect(service.corrections({ limit: 30 })).resolves.toHaveLength(1);

    expect(client.mock.calls).toEqual([
      [`/api/me/location-use-facts?limit=10&cursor=${cursor}`, {
        authenticated: true,
      }],
      [`/api/me/location-correction-subjects?limit=20&cursor=${cursor}`, {
        authenticated: true,
      }],
      [`/api/me/location-corrections?limit=1&cursor=${cursor}`, {
        authenticated: true,
      }],
      ['/api/me/location-corrections?limit=30', { authenticated: true }],
    ]);
  });

  it('submits each exact correction target without retaining unrelated fields', async () => {
    const client = vi.fn(async () => ({ correction_request_id: requestId }));
    const service = createLocationRightsService(client as unknown as ApiClient);

    await expect(service.submitCorrection({
      locationUseFactId: 3,
      clientRequestId: requestId,
      reason: 'incorrect_outcome',
    })).resolves.toBe(requestId);
    await expect(service.submitCorrection({
      fieldAcquisitionId: acquisitionId,
      clientRequestId: requestId,
      reason: 'not_my_visit',
    })).resolves.toBe(requestId);

    expect(client.mock.calls).toEqual([
      ['/api/me/location-corrections', {
        method: 'POST',
        authenticated: true,
        json: {
          location_use_fact_id: 3,
          client_request_id: requestId,
          reason: 'incorrect_outcome',
        },
      }],
      ['/api/me/location-corrections', {
        method: 'POST',
        authenticated: true,
        json: {
          field_acquisition_id: acquisitionId,
          client_request_id: requestId,
          reason: 'not_my_visit',
        },
      }],
    ]);
  });

  it('rejects invalid paging and correction input before any request', async () => {
    const client = vi.fn();
    const service = createLocationRightsService(client as unknown as ApiClient);

    await expect(service.facts({ limit: 0 })).rejects
      .toBeInstanceOf(LocationRightsRequestError);
    await expect(service.correctionSubjects({ cursor: 'raw cursor' })).rejects
      .toBeInstanceOf(LocationRightsRequestError);
    await expect(service.submitCorrection({
      locationUseFactId: 0,
      clientRequestId: requestId,
      reason: 'other',
    })).rejects.toBeInstanceOf(LocationRightsRequestError);
    await expect(service.submitCorrection({
      fieldAcquisitionId: 'not-a-uuid',
      clientRequestId: requestId,
      reason: 'other',
    })).rejects.toBeInstanceOf(LocationRightsRequestError);
    await expect(service.submitCorrection({
      locationUseFactId: 1,
      fieldAcquisitionId: acquisitionId,
      clientRequestId: requestId,
      reason: 'other',
    } as never)).rejects.toBeInstanceOf(LocationRightsRequestError);
    expect(client).not.toHaveBeenCalled();
  });
});
