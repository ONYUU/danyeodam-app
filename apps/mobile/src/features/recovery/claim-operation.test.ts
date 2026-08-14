import { describe, expect, it, vi } from 'vitest';

import type { SessionBindingGeneration } from '@/features/session-data/generation';

import { runRecoveryClaimMutation } from './claim-operation';

function generation(bindingVersion: number): SessionBindingGeneration {
  return { authToken: Symbol('auth'), bindingVersion, id: bindingVersion };
}

describe('recovery claim binding mutation', () => {
  it('refreshes access and collection after confirmed success even when UI is stale', async () => {
    const captured = generation(1);
    const refreshAfterMutation = vi.fn();

    await expect(runRecoveryClaimMutation({
      generation: captured,
      isGenerationCurrent: () => false,
      claim: async () => undefined,
      refreshAfterMutation,
      shouldRefreshAfterError: () => false,
    })).resolves.toEqual({ status: 'stale' });
    expect(refreshAfterMutation).toHaveBeenCalledOnce();
  });

  it('refreshes after an ambiguous failure but not after a definitive failure', async () => {
    const captured = generation(1);
    const ambiguousRefresh = vi.fn();
    const definitiveRefresh = vi.fn();
    const ambiguous = new Error('ambiguous');
    const definitive = new Error('definitive');

    await expect(runRecoveryClaimMutation({
      generation: captured,
      isGenerationCurrent: () => true,
      claim: async () => { throw ambiguous; },
      refreshAfterMutation: ambiguousRefresh,
      shouldRefreshAfterError: (error) => error === ambiguous,
    })).rejects.toBe(ambiguous);
    await expect(runRecoveryClaimMutation({
      generation: captured,
      isGenerationCurrent: () => true,
      claim: async () => { throw definitive; },
      refreshAfterMutation: definitiveRefresh,
      shouldRefreshAfterError: () => false,
    })).rejects.toBe(definitive);

    expect(ambiguousRefresh).toHaveBeenCalledOnce();
    expect(definitiveRefresh).not.toHaveBeenCalled();
  });
});
