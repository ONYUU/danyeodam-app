import { describe, expect, it } from 'vitest';

import { canShowReviewerSensitiveActions } from './reviewer-sensitive-actions';

describe('reviewer-sensitive account actions', () => {
  it('shows recovery and email linking only after standard access is confirmed', () => {
    expect(canShowReviewerSensitiveActions({
      participant: true,
      accessType: 'standard',
      fieldAcquisitionRequiresLocation: true,
      fixtureVersion: null,
    })).toBe(true);

    expect(canShowReviewerSensitiveActions({
      participant: true,
      accessType: 'store_reviewer',
      fieldAcquisitionRequiresLocation: true,
      fixtureVersion: 'review-fixture-v1',
    })).toBe(false);

    expect(canShowReviewerSensitiveActions(null)).toBe(false);
  });
});
