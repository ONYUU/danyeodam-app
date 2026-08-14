import {
  ApiResponseError,
  ApiTransportError,
} from '@/api/client';
import type { PersonalCardDeleteService } from '@/api/personal-card-delete';
import {
  isSameSessionBindingGeneration,
  type SessionBindingGeneration,
} from '@/features/session-data/generation';

type PendingDelete = {
  clientRequestId: string;
  generation: SessionBindingGeneration;
  personalCardId: string;
};

type ActiveDelete = {
  cancelled: boolean;
  controller: AbortController;
};

export class PersonalCardDeleteFlowError extends Error {
  readonly reason:
    | 'CANCELLED'
    | 'GENERATION_CHANGED'
    | 'IN_PROGRESS'
    | 'RETRY_INPUT_CHANGED';

  constructor(reason: PersonalCardDeleteFlowError['reason']) {
    super(`Personal card deletion failed with ${reason}.`);
    this.name = 'PersonalCardDeleteFlowError';
    this.reason = reason;
  }
}

export function isPersonalCardDeleteRetryable(error: unknown): boolean {
  if (error instanceof ApiTransportError) {
    // NETWORK_ERROR, TIMEOUT, and INVALID_RESPONSE can all mean that the
    // accepted response was lost. Reusing the same key is the safe recovery.
    return error.failure !== 'AUTH_SESSION_UNAVAILABLE'
      && error.failure !== 'ABORTED';
  }
  if (error instanceof ApiResponseError) {
    return error.code === 'INTERNAL' || error.code === 'RATE_LIMITED';
  }
  return false;
}

export function createPersonalCardDeleteCoordinator(dependencies: {
  createClientRequestId(): string;
  service: PersonalCardDeleteService;
  isGenerationCurrent(generation: SessionBindingGeneration): boolean;
}) {
  let generation: SessionBindingGeneration | null = null;
  let active: ActiveDelete | null = null;
  let pending: PendingDelete | null = null;

  const cancel = () => {
    if (active !== null) {
      active.cancelled = true;
      active.controller.abort();
    }
    pending = null;
  };

  const setGeneration = (next: SessionBindingGeneration) => {
    if (
      generation !== null
      && !isSameSessionBindingGeneration(generation, next)
    ) {
      cancel();
    }
    generation = next;
  };

  const ensureCurrent = (
    runGeneration: SessionBindingGeneration,
    attempt: ActiveDelete,
  ) => {
    if (
      attempt.cancelled
      || generation === null
      || !isSameSessionBindingGeneration(generation, runGeneration)
      || !dependencies.isGenerationCurrent(runGeneration)
    ) {
      throw new PersonalCardDeleteFlowError(
        attempt.cancelled ? 'CANCELLED' : 'GENERATION_CHANGED',
      );
    }
  };

  return {
    setGeneration,
    cancel,
    hasPendingRetry(): boolean {
      return pending !== null;
    },
    async run(input: {
      personalCardId: string;
      generation: SessionBindingGeneration;
    }): Promise<'accepted'> {
      setGeneration(input.generation);
      if (active !== null) {
        throw new PersonalCardDeleteFlowError('IN_PROGRESS');
      }
      const attempt: ActiveDelete = {
        cancelled: false,
        controller: new AbortController(),
      };
      active = attempt;
      try {
        ensureCurrent(input.generation, attempt);
        if (pending === null) {
          pending = {
            clientRequestId: dependencies.createClientRequestId(),
            generation: input.generation,
            personalCardId: input.personalCardId,
          };
        } else if (
          pending.personalCardId !== input.personalCardId
          || !isSameSessionBindingGeneration(pending.generation, input.generation)
        ) {
          throw new PersonalCardDeleteFlowError('RETRY_INPUT_CHANGED');
        }

        const request = pending;
        try {
          const result = await dependencies.service.remove({
            personalCardId: request.personalCardId,
            clientRequestId: request.clientRequestId,
            signal: attempt.controller.signal,
          });
          ensureCurrent(request.generation, attempt);
          pending = null;
          return result;
        } catch (error) {
          ensureCurrent(request.generation, attempt);
          if (!isPersonalCardDeleteRetryable(error)) {
            pending = null;
          }
          throw error;
        }
      } catch (error) {
        if (
          attempt.cancelled
          || !dependencies.isGenerationCurrent(input.generation)
        ) {
          pending = null;
          throw new PersonalCardDeleteFlowError(
            attempt.cancelled ? 'CANCELLED' : 'GENERATION_CHANGED',
          );
        }
        throw error;
      } finally {
        if (active === attempt) {
          active = null;
        }
      }
    },
  };
}
