import type { AcquisitionCoordinates, AcquireSuccess } from '@/api/acquire';
import { ApiTransportError } from '@/api/client';
import {
  isSameSessionBindingGeneration,
  type SessionBindingGeneration,
} from '@/features/session-data/generation';
import type { SupportedLocale } from '@/i18n/locales';
import {
  ForegroundLocationError,
  type ForegroundLocationAttempt,
} from '@/platform/foreground-location';

export type AcquireRetryMetadata = Readonly<{
  spotId: string;
  idempotencyKey: string;
}>;

type GenerationScopedRetry = AcquireRetryMetadata & {
  generation: SessionBindingGeneration;
};

type ActiveAttempt = {
  generationCancelled: boolean;
  location: ForegroundLocationAttempt | null;
  requestController: AbortController;
};

export class AcquireFlowError extends Error {
  readonly reason:
    | 'IN_PROGRESS'
    | 'GENERATION_CHANGED'
    | 'LOCATION_CONSENT_REQUIRED'
    | 'LOCATION_USE_PAUSED'
    | 'LOCATION_WITHDRAWAL_PENDING';

  constructor(reason: AcquireFlowError['reason']) {
    super(`Acquisition flow failed with ${reason}.`);
    this.name = 'AcquireFlowError';
    this.reason = reason;
  }
}

function isAmbiguousTransportFailure(error: unknown): boolean {
  return error instanceof ApiTransportError
    && error.failure !== 'AUTH_SESSION_UNAVAILABLE';
}

export function createAcquireCoordinator(dependencies: {
  ensureLocationAccess(signal: AbortSignal): Promise<
    'active' | 'missing' | 'paused' | 'stale' | 'withdrawal_pending'
  >;
  startLocationRead(): ForegroundLocationAttempt;
  createIdempotencyKey(): string;
  isAppActive(): boolean;
  isGenerationCurrent(generation: SessionBindingGeneration): boolean;
  acquire(input: {
    spotId: string;
    idempotencyKey: string;
    coordinates: AcquisitionCoordinates;
    locale: SupportedLocale;
    signal: AbortSignal;
  }): Promise<AcquireSuccess>;
}) {
  let generation: SessionBindingGeneration | null = null;
  let ambiguousAttempt: GenerationScopedRetry | null = null;
  let activeAttempt: ActiveAttempt | null = null;

  const cancelActiveAttempt = () => {
    if (activeAttempt === null) {
      return;
    }
    activeAttempt.generationCancelled = true;
    activeAttempt.location?.cancel();
    activeAttempt.requestController.abort();
  };

  const setGeneration = (nextGeneration: SessionBindingGeneration) => {
    if (
      generation !== null
      && !isSameSessionBindingGeneration(generation, nextGeneration)
    ) {
      ambiguousAttempt = null;
      cancelActiveAttempt();
    }
    generation = nextGeneration;
  };

  return {
    setGeneration,
    cancelActiveAttempt,
    async run(
      spotId: string,
      locale: SupportedLocale,
      runGeneration: SessionBindingGeneration,
    ): Promise<AcquireSuccess> {
      setGeneration(runGeneration);
      if (activeAttempt !== null) {
        throw new AcquireFlowError('IN_PROGRESS');
      }
      if (!dependencies.isGenerationCurrent(runGeneration)) {
        throw new AcquireFlowError('GENERATION_CHANGED');
      }
      if (
        ambiguousAttempt !== null
        && (
          ambiguousAttempt.spotId !== spotId
          || !isSameSessionBindingGeneration(
            ambiguousAttempt.generation,
            runGeneration,
          )
        )
      ) {
        ambiguousAttempt = null;
      }

      const attempt: ActiveAttempt = {
        generationCancelled: false,
        location: null,
        requestController: new AbortController(),
      };
      activeAttempt = attempt;
      try {
        const consent = await dependencies.ensureLocationAccess(
          attempt.requestController.signal,
        );
        if (consent === 'missing' || consent === 'stale') {
          throw new AcquireFlowError('LOCATION_CONSENT_REQUIRED');
        }
        if (consent === 'paused') {
          throw new AcquireFlowError('LOCATION_USE_PAUSED');
        }
        if (consent === 'withdrawal_pending') {
          throw new AcquireFlowError('LOCATION_WITHDRAWAL_PENDING');
        }
        if (
          attempt.generationCancelled
          || !dependencies.isGenerationCurrent(runGeneration)
          || generation === null
          || !isSameSessionBindingGeneration(generation, runGeneration)
        ) {
          throw new AcquireFlowError('GENERATION_CHANGED');
        }

        const location = dependencies.startLocationRead();
        attempt.location = location;
        const coordinates = await location.result;
        attempt.location = null;

        if (!dependencies.isAppActive()) {
          throw new ForegroundLocationError('APP_INACTIVE');
        }
        if (
          attempt.generationCancelled
          || !dependencies.isGenerationCurrent(runGeneration)
          || generation === null
          || !isSameSessionBindingGeneration(generation, runGeneration)
        ) {
          throw new AcquireFlowError('GENERATION_CHANGED');
        }

        const idempotencyKey = ambiguousAttempt?.idempotencyKey
          ?? dependencies.createIdempotencyKey();
        try {
          const result = await dependencies.acquire({
            spotId,
            idempotencyKey,
            coordinates,
            locale,
            signal: attempt.requestController.signal,
          });
          ambiguousAttempt = null;
          return result;
        } catch (error) {
          const generationChanged = attempt.generationCancelled
            || !dependencies.isGenerationCurrent(runGeneration)
            || generation === null
            || !isSameSessionBindingGeneration(generation, runGeneration);
          ambiguousAttempt = !generationChanged && isAmbiguousTransportFailure(error)
            ? { spotId, idempotencyKey, generation: runGeneration }
            : null;
          throw error;
        }
      } finally {
        if (activeAttempt === attempt) {
          activeAttempt = null;
        }
      }
    },
    getRetryMetadata(): AcquireRetryMetadata | null {
      if (
        ambiguousAttempt === null
        || generation === null
        || !isSameSessionBindingGeneration(ambiguousAttempt.generation, generation)
      ) {
        return null;
      }
      return {
        spotId: ambiguousAttempt.spotId,
        idempotencyKey: ambiguousAttempt.idempotencyKey,
      };
    },
  };
}

export type AcquireCoordinator = ReturnType<typeof createAcquireCoordinator>;
