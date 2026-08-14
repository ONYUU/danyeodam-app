import { describe, expect, it, vi } from 'vitest';

import { completeEmailLinkWithActiveIdentity } from './email-link-completion';

describe('email-link runtime completion', () => {
  it('adopts the exchanged session before checking the active service identity', async () => {
    const order: string[] = [];
    await completeEmailLinkWithActiveIdentity('danyeodam://auth/callback?code=x', {
      complete: vi.fn(async () => {
        order.push('complete');
      }),
      verifyActiveIdentity: vi.fn(async () => {
        order.push('verify');
      }),
      rejectedFlowId: () => null,
      clearRejectedFlow: vi.fn(),
    });

    expect(order).toEqual(['complete', 'verify']);
  });

  it('does not verify or adopt any later state when the code exchange fails', async () => {
    const verifyActiveIdentity = vi.fn();
    await expect(completeEmailLinkWithActiveIdentity('invalid', {
      complete: async () => {
        throw new Error('exchange failed');
      },
      verifyActiveIdentity,
      rejectedFlowId: () => null,
      clearRejectedFlow: vi.fn(),
    })).rejects.toThrow('exchange failed');
    expect(verifyActiveIdentity).not.toHaveBeenCalled();
  });

  it('propagates an inactive-identity check failure after the exchange', async () => {
    await expect(completeEmailLinkWithActiveIdentity('callback', {
      complete: async () => undefined,
      verifyActiveIdentity: async () => {
        throw new Error('inactive identity');
      },
      rejectedFlowId: () => null,
      clearRejectedFlow: vi.fn(),
    })).rejects.toThrow('inactive identity');
  });

  it('clears only the matching pending verifier for a rejected callback', async () => {
    const clearRejectedFlow = vi.fn(async () => undefined);
    await expect(completeEmailLinkWithActiveIdentity('rejected-url', {
      complete: async () => {
        throw new Error('rejected');
      },
      verifyActiveIdentity: vi.fn(),
      rejectedFlowId: () => '11111111-1111-4111-8111-111111111111',
      clearRejectedFlow,
    })).rejects.toThrow('rejected');
    expect(clearRejectedFlow).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
    );
  });
});
