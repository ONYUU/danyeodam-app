import { describe, expect, it } from 'vitest';

import { ApiResponseError, ApiTransportError } from '@/api/client';
import {
  mutationAttemptFor,
  shouldRetainBlockMutationAttempt,
} from './mutation-attempt';

describe('block mutation attempt', () => {
  it('reuses an ID only for the same logical mutation subject', () => {
    const previous = {
      subjectId: 'block-1',
      clientActionId: 'action-1',
    } as const;
    const createClientActionId = () => 'action-2';

    expect(mutationAttemptFor({ previous, subjectId: 'block-1', createClientActionId }))
      .toBe(previous);
    expect(mutationAttemptFor({ previous, subjectId: 'block-2', createClientActionId }))
      .toEqual({ subjectId: 'block-2', clientActionId: 'action-2' });
  });

  it('retains IDs only for uncertain or explicitly delayed outcomes', () => {
    expect(shouldRetainBlockMutationAttempt(new ApiTransportError('NETWORK_ERROR')))
      .toBe(true);
    expect(shouldRetainBlockMutationAttempt(new ApiResponseError({
      code: 'INTERNAL', status: 503, requestId: null, details: null,
    }))).toBe(true);
    expect(shouldRetainBlockMutationAttempt(new ApiResponseError({
      code: 'RATE_LIMITED', status: 429, requestId: null, details: null,
    }))).toBe(true);
    expect(shouldRetainBlockMutationAttempt(new ApiResponseError({
      code: 'FORBIDDEN', status: 403, requestId: null, details: null,
    }))).toBe(false);
  });
});
