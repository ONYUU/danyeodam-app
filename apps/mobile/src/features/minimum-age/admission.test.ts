import { describe, expect, it, vi } from 'vitest';

import {
  completeMinimumAgeAdmission,
  renderAfterMinimumAgeBoundary,
} from './admission';

describe('minimum-age root boundary', () => {
  it.each(['invalid', 'ineligible'] as const)(
    'mounts no auth or API path for a %s decision',
    async (decision) => {
      const persistPass = vi.fn(async () => undefined);
      const mountAuth = vi.fn(() => 'authenticated-tree');
      const callApi = vi.fn();

      const outcome = await completeMinimumAgeAdmission(decision, persistPass);
      const tree = renderAfterMinimumAgeBoundary(
        outcome === 'passed',
        () => {
          callApi();
          return mountAuth();
        },
      );

      expect(tree).toBeNull();
      expect(persistPass).not.toHaveBeenCalled();
      expect(mountAuth).not.toHaveBeenCalled();
      expect(callApi).not.toHaveBeenCalled();
    },
  );

  it('persists the minimal pass before mounting auth and starting attestation', async () => {
    const events: string[] = [];
    let finishSave: (() => void) | undefined;
    const persistPass = vi.fn(async () => {
      events.push('save:start');
      await new Promise<void>((resolve) => {
        finishSave = resolve;
      });
      events.push('save:finish');
    });
    const pending = completeMinimumAgeAdmission('eligible', persistPass);

    expect(events).toEqual(['save:start']);
    expect(renderAfterMinimumAgeBoundary(false, () => 'auth')).toBeNull();

    finishSave?.();
    const outcome = await pending;
    const tree = renderAfterMinimumAgeBoundary(outcome === 'passed', () => {
      events.push('auth:mount');
      events.push('attestation:post');
      return 'authenticated-tree';
    });

    expect(tree).toBe('authenticated-tree');
    expect(events).toEqual([
      'save:start',
      'save:finish',
      'auth:mount',
      'attestation:post',
    ]);
  });
});
