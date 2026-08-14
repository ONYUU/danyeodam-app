import { describe, expect, it } from 'vitest';

import { createCallbackUrlGate } from './callback-url-gate';

describe('callback URL gate', () => {
  it('waits for a warm-app URL instead of consuming the initial null value', () => {
    const gate = createCallbackUrlGate();

    expect(gate.take(null)).toBeNull();
    expect(gate.take('danyeodam://auth/callback?code=warm')).toBe(
      'danyeodam://auth/callback?code=warm',
    );
  });

  it('allows only one callback URL to be processed', () => {
    const gate = createCallbackUrlGate();

    expect(gate.take('danyeodam://auth/callback?code=first')).toContain('first');
    expect(gate.take('danyeodam://auth/callback?code=second')).toBeNull();
  });
});
