import { describe, expect, it } from 'vitest';

import type { SessionBindingGeneration } from './generation';
import { runGenerationBoundOperation } from './generation-bound-operation';

function generation(
  authToken: symbol,
  bindingVersion: number,
): SessionBindingGeneration {
  return { authToken, bindingVersion, id: bindingVersion };
}

describe('generation-bound operation', () => {
  it('returns a value only while the captured session and binding remain current', async () => {
    const authToken = Symbol('auth');
    let current = generation(authToken, 1);
    const captured = current;

    const result = await runGenerationBoundOperation({
      generation: captured,
      isGenerationCurrent: (candidate) => candidate.authToken === current.authToken
        && candidate.bindingVersion === current.bindingVersion,
      work: async () => 'one-time-secret',
    });

    expect(result).toEqual({ status: 'current', value: 'one-time-secret' });
  });

  it('discards an async secret after the binding generation rotates', async () => {
    const authToken = Symbol('auth');
    let current = generation(authToken, 1);
    const captured = current;
    let resolveWork: ((value: string) => void) | undefined;
    const work = new Promise<string>((resolve) => {
      resolveWork = resolve;
    });
    const pending = runGenerationBoundOperation({
      generation: captured,
      isGenerationCurrent: (candidate) => candidate.authToken === current.authToken
        && candidate.bindingVersion === current.bindingVersion,
      work: () => work,
    });

    current = generation(authToken, 2);
    resolveWork?.('must-not-escape');

    await expect(pending).resolves.toEqual({ status: 'stale' });
    await expect(pending).resolves.not.toHaveProperty('value');
  });
});
