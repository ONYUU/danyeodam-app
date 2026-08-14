import { describe, expect, it, vi } from 'vitest';

import { renderAfterMinimumAgeBoundary } from './admission';
import {
  resolveBindingAttestationRequestState,
  runBindingAttestationAttempt,
} from './attestation-binding';
import { runRecoveryClaimMutation } from '@/features/recovery/claim-operation';
import { createSessionBindingGenerationController } from '@/features/session-data/generation';

describe('minimum-age attestation across logical binding changes', () => {
  it('closes protected content after rotation and reopens it only after a new POST succeeds', async () => {
    const controller = createSessionBindingGenerationController();
    const submit = vi.fn(async () => undefined);
    const signal = new AbortController().signal;
    const firstGeneration = controller.current();
    const firstResult = await runBindingAttestationAttempt({
      generation: firstGeneration,
      isGenerationCurrent: controller.isCurrent,
      sessionUserId: 'same-auth-uid',
      signal,
      submit,
    });

    expect(resolveBindingAttestationRequestState({
      generation: firstGeneration,
      result: firstResult,
      sessionUserId: 'same-auth-uid',
    })).toBe('ready');
    expect(renderAfterMinimumAgeBoundary(true, () => 'protected')).toBe('protected');

    let reboundGeneration = firstGeneration;
    await expect(runRecoveryClaimMutation({
      generation: firstGeneration,
      isGenerationCurrent: controller.isCurrent,
      claim: async () => undefined,
      refreshAfterMutation: () => {
        reboundGeneration = controller.rotateBinding();
      },
      shouldRefreshAfterError: () => false,
    })).resolves.toEqual({ status: 'current' });
    expect(resolveBindingAttestationRequestState({
      generation: reboundGeneration,
      result: firstResult,
      sessionUserId: 'same-auth-uid',
    })).toBe('submitting');
    expect(renderAfterMinimumAgeBoundary(false, () => 'protected')).toBeNull();

    const reboundResult = await runBindingAttestationAttempt({
      generation: reboundGeneration,
      isGenerationCurrent: controller.isCurrent,
      sessionUserId: 'same-auth-uid',
      signal,
      submit,
    });
    expect(resolveBindingAttestationRequestState({
      generation: reboundGeneration,
      result: reboundResult,
      sessionUserId: 'same-auth-uid',
    })).toBe('ready');
    expect(renderAfterMinimumAgeBoundary(true, () => 'protected')).toBe('protected');
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('cannot reopen a rotated binding from a stale in-flight response', async () => {
    const controller = createSessionBindingGenerationController();
    const captured = controller.current();
    let finishPost: (() => void) | undefined;
    const pending = runBindingAttestationAttempt({
      generation: captured,
      isGenerationCurrent: controller.isCurrent,
      sessionUserId: 'same-auth-uid',
      signal: new AbortController().signal,
      submit: () => new Promise<void>((resolve) => {
        finishPost = resolve;
      }),
    });

    controller.rotateBinding();
    finishPost?.();

    await expect(pending).resolves.toBeNull();
  });
});
