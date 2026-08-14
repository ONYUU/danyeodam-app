import { describe, expect, it } from 'vitest';

import {
  canEnterPrivacyRightsFromBoundary,
  PRE_AGE_BOUNDARY_PHASES,
} from './privacy-rights-entry';
import {
  canEnterPrivacyRightsFromAttestation,
  type AttestationPresentation,
} from './attestation-presentation';

describe('pre-age privacy-rights entry', () => {
  it('is available from every local pre-age phase and closed after admission', () => {
    for (const phase of PRE_AGE_BOUNDARY_PHASES) {
      expect(canEnterPrivacyRightsFromBoundary(phase)).toBe(true);
    }
    expect(canEnterPrivacyRightsFromBoundary('passed')).toBe(false);
  });

  it('is available while server attestation is not ready', () => {
    const preAttestation: AttestationPresentation[] = [
      'loading',
      'session_error',
      'request_error',
    ];
    for (const presentation of preAttestation) {
      expect(canEnterPrivacyRightsFromAttestation(presentation)).toBe(true);
    }
    expect(canEnterPrivacyRightsFromAttestation('ready')).toBe(false);
  });
});
