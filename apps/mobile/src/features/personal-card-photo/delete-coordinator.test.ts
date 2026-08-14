import { describe, expect, it, vi } from 'vitest';

import {
  ApiResponseError,
  ApiTransportError,
} from '@/api/client';
import type { PersonalCardDeleteService } from '@/api/personal-card-delete';
import type { SessionBindingGeneration } from '@/features/session-data/generation';

import {
  createPersonalCardDeleteCoordinator,
  PersonalCardDeleteFlowError,
} from './delete-coordinator';

const personalCardId = '44444444-4444-4444-8444-444444444444';
const clientRequestId = '55555555-5555-4555-8555-555555555555';

function generation(authToken: symbol, id: number): SessionBindingGeneration {
  return { authToken, bindingVersion: id, id };
}

function service(remove: PersonalCardDeleteService['remove']): PersonalCardDeleteService {
  return { remove };
}

describe('generation-bound personal-card deletion coordinator', () => {
  it('retries a lost response with the same card and client request IDs', async () => {
    const current = generation(Symbol('auth'), 1);
    const remove = vi.fn()
      .mockRejectedValueOnce(new ApiTransportError('NETWORK_ERROR'))
      .mockResolvedValueOnce('accepted');
    const createClientRequestId = vi.fn(() => clientRequestId);
    const coordinator = createPersonalCardDeleteCoordinator({
      createClientRequestId,
      service: service(remove),
      isGenerationCurrent: (candidate) => candidate === current,
    });
    const input = { personalCardId, generation: current };

    await expect(coordinator.run(input)).rejects.toMatchObject({
      failure: 'NETWORK_ERROR',
    });
    expect(coordinator.hasPendingRetry()).toBe(true);
    await expect(coordinator.run(input)).resolves.toBe('accepted');
    expect(createClientRequestId).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      personalCardId,
      clientRequestId,
    }));
    expect(remove.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      personalCardId,
      clientRequestId,
    }));
  });

  it('also retains the same key when an accepted response has an invalid shape', async () => {
    const current = generation(Symbol('auth'), 1);
    const remove = vi.fn()
      .mockRejectedValueOnce(new ApiTransportError('INVALID_RESPONSE'))
      .mockResolvedValueOnce('accepted');
    const coordinator = createPersonalCardDeleteCoordinator({
      createClientRequestId: () => clientRequestId,
      service: service(remove),
      isGenerationCurrent: (candidate) => candidate === current,
    });

    await expect(coordinator.run({ personalCardId, generation: current }))
      .rejects.toMatchObject({ failure: 'INVALID_RESPONSE' });
    await expect(coordinator.run({ personalCardId, generation: current }))
      .resolves.toBe('accepted');
    expect(remove.mock.calls[1]?.[0].clientRequestId).toBe(clientRequestId);
  });

  it('clears the key after a deterministic conflict', async () => {
    const current = generation(Symbol('auth'), 1);
    const remove = vi.fn(async () => {
      throw new ApiResponseError({
        code: 'IDEMPOTENCY_CONFLICT',
        status: 409,
        requestId: null,
        details: null,
      });
    });
    const coordinator = createPersonalCardDeleteCoordinator({
      createClientRequestId: () => clientRequestId,
      service: service(remove),
      isGenerationCurrent: (candidate) => candidate === current,
    });

    await expect(coordinator.run({ personalCardId, generation: current }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(coordinator.hasPendingRetry()).toBe(false);
  });

  it('cancels a response-loss retry when the authenticated generation changes', async () => {
    const authToken = Symbol('auth');
    const first = generation(authToken, 1);
    const second = generation(authToken, 2);
    let current = first;
    const coordinator = createPersonalCardDeleteCoordinator({
      createClientRequestId: () => clientRequestId,
      service: service(async () => {
        throw new ApiTransportError('TIMEOUT');
      }),
      isGenerationCurrent: (candidate) => candidate === current,
    });

    await expect(coordinator.run({ personalCardId, generation: first }))
      .rejects.toMatchObject({ failure: 'TIMEOUT' });
    expect(coordinator.hasPendingRetry()).toBe(true);
    current = second;
    coordinator.setGeneration(second);
    expect(coordinator.hasPendingRetry()).toBe(false);
  });

  it('aborts an active request on cancellation', async () => {
    const current = generation(Symbol('auth'), 1);
    const remove = vi.fn(({ signal }: { signal?: AbortSignal }) => (
      new Promise<'accepted'>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      })
    ));
    const coordinator = createPersonalCardDeleteCoordinator({
      createClientRequestId: () => clientRequestId,
      service: service(remove),
      isGenerationCurrent: (candidate) => candidate === current,
    });
    const pending = coordinator.run({ personalCardId, generation: current });
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());

    coordinator.cancel();
    await expect(pending).rejects.toBeInstanceOf(PersonalCardDeleteFlowError);
    expect(coordinator.hasPendingRetry()).toBe(false);
  });
});
