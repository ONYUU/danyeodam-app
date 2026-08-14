import { describe, expect, it } from 'vitest';

import type { LocationCorrection } from '@/api/location-rights';

import { correctionTarget, formatKstDateTime } from './presentation';

function correction(
  overrides: Partial<LocationCorrection> = {},
): LocationCorrection {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    locationUseFactId: 42,
    fieldAcquisitionId: null,
    reason: 'wrong_spot',
    status: 'open',
    requestedAt: '2026-08-11T15:30:00Z',
    resolvedAt: null,
    ...overrides,
  };
}

describe('privacy-rights record presentation', () => {
  it('formats an instant after midnight in Asia/Seoul instead of the UTC date', () => {
    const formatted = formatKstDateTime('2026-08-11T15:30:00Z', 'ko');
    expect(formatted).toMatch(/2026/u);
    expect(formatted).toMatch(/8/u);
    expect(formatted).toMatch(/12/u);
    expect(formatted).toMatch(/00:30/u);
  });

  it('keeps the exact correction subject distinguishable after erasure', () => {
    expect(correctionTarget(correction())).toEqual({ kind: 'fact', id: '42' });
    expect(correctionTarget(correction({
      locationUseFactId: null,
      fieldAcquisitionId: '22222222-2222-4222-8222-222222222222',
    }))).toEqual({
      kind: 'acquisition',
      id: '22222222-2222-4222-8222-222222222222',
    });
    expect(correctionTarget(correction({
      locationUseFactId: null,
      status: 'corrected',
      resolvedAt: '2026-08-12T01:00:00+09:00',
    }))).toEqual({ kind: 'erased', id: null });
  });
});
