import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from './client';
import { createParticipantService } from './participants';

describe('participant invite service', () => {
  it('posts an exact one-time code and accepts the 204 result', async () => {
    const client = vi.fn(async () => undefined);
    const redeem = createParticipantService(client as unknown as ApiClient);
    const code = 'Abcdefghijklmnopqrstuv';

    await expect(redeem(code)).resolves.toBeUndefined();
    expect(client).toHaveBeenCalledWith('/api/participants/redeem', {
      method: 'POST',
      json: { invite_code: code },
    });
  });

  it('does not send malformed codes', async () => {
    const client = vi.fn();
    const redeem = createParticipantService(client as unknown as ApiClient);

    await expect(redeem('invalid')).rejects.toMatchObject({ kind: 'invite' });
    expect(client).not.toHaveBeenCalled();
  });
});
