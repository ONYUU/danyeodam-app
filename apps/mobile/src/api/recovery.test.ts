import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from './client';
import { ApiTransportError } from './client';
import { createRecoveryService, parseRecoveryIssue } from './recovery';

const recoveryCode = 'Abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';

describe('recovery service', () => {
  it('returns the one-time plaintext only from an explicit issue call', async () => {
    const client = vi.fn(async () => ({ code: recoveryCode }));
    const service = createRecoveryService(client as unknown as ApiClient);

    expect(client).not.toHaveBeenCalled();
    await expect(service.issue()).resolves.toBe(recoveryCode);
    expect(client).toHaveBeenCalledWith('/api/recovery/issue', { method: 'POST' });
  });

  it('validates issue projections and claim responses', async () => {
    expect(() => parseRecoveryIssue({ code: 'short' })).toThrow(ApiTransportError);
    const client = vi.fn(async () => ({ restored: true }));
    const service = createRecoveryService(client as unknown as ApiClient);

    await expect(service.claim(recoveryCode)).resolves.toBeUndefined();
    expect(client).toHaveBeenCalledWith('/api/recovery/claim', {
      method: 'POST',
      json: { code: recoveryCode },
    });
  });

  it('rejects malformed claim codes before network I/O', async () => {
    const client = vi.fn();
    const service = createRecoveryService(client as unknown as ApiClient);

    await expect(service.claim('invalid')).rejects.toMatchObject({ kind: 'recovery' });
    expect(client).not.toHaveBeenCalled();
  });
});
