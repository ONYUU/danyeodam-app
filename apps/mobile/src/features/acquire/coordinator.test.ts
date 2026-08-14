import { describe, expect, it, vi } from 'vitest';

import type { AcquisitionCoordinates, AcquireSuccess } from '@/api/acquire';
import { ApiResponseError, ApiTransportError } from '@/api/client';
import type { SessionBindingGeneration } from '@/features/session-data/generation';
import {
  ForegroundLocationError,
  type ForegroundLocationAttempt,
} from '@/platform/foreground-location';

import { createAcquireCoordinator } from './coordinator';

const spotId = '11111111-1111-4111-8111-111111111111';
const firstKey = '22222222-2222-4222-8222-222222222222';
const secondKey = '33333333-3333-4333-8333-333333333333';
const success = {
  acquisition: {
    id: '44444444-4444-4444-8444-444444444444',
    spotId,
    cardId: '55555555-5555-4555-8555-555555555555',
    acquiredAt: '2026-08-12T00:00:00.000Z',
  },
  card: {
    id: '55555555-5555-4555-8555-555555555555',
    title: {
      ko: '카드', en: 'Card', ja: 'カード',
      'zh-Hans': '卡片', 'zh-Hant': '卡片', vi: 'Thẻ',
    },
    imageUrl: 'https://api.example.com/api/card-assets/card',
    colorHex: '#356A5A',
  },
  dateKst: '2026-08-12',
} satisfies AcquireSuccess;

function generation(
  authToken: symbol,
  bindingVersion: number,
): SessionBindingGeneration {
  return { authToken, bindingVersion, id: bindingVersion };
}

function resolvedLocation(coordinates: AcquisitionCoordinates): ForegroundLocationAttempt {
  return { result: Promise.resolve(coordinates), cancel: vi.fn() };
}

function pendingLocation() {
  let resolve: ((coordinates: AcquisitionCoordinates) => void) | undefined;
  let reject: ((error: ForegroundLocationError) => void) | undefined;
  const result = new Promise<AcquisitionCoordinates>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  const cancel = vi.fn(() => reject?.(new ForegroundLocationError('CANCELLED')));
  return { attempt: { result, cancel }, resolve };
}

describe('generation-scoped acquire coordinator', () => {
  it('does not read device location before current active consent is confirmed', async () => {
    const currentGeneration = generation(Symbol('auth'), 1);
    let resolveConsent: ((state: 'active') => void) | undefined;
    const consent = new Promise<'active'>((resolve) => {
      resolveConsent = resolve;
    });
    const startLocationRead = vi.fn(() => resolvedLocation({
      latitude: 37.57,
      longitude: 126.98,
      accuracy: 8,
    }));
    const acquire = vi.fn().mockResolvedValue(success);
    const coordinator = createAcquireCoordinator({
      ensureLocationAccess: () => consent,
      startLocationRead,
      createIdempotencyKey: () => firstKey,
      isAppActive: () => true,
      isGenerationCurrent: (candidate) => candidate === currentGeneration,
      acquire,
    });

    const result = coordinator.run(spotId, 'ko', currentGeneration);
    await Promise.resolve();
    expect(startLocationRead).not.toHaveBeenCalled();

    resolveConsent?.('active');
    await expect(result).resolves.toBe(success);
    expect(startLocationRead).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing', 'LOCATION_CONSENT_REQUIRED'],
    ['stale', 'LOCATION_CONSENT_REQUIRED'],
    ['paused', 'LOCATION_USE_PAUSED'],
    ['withdrawal_pending', 'LOCATION_WITHDRAWAL_PENDING'],
  ] as const)('blocks %s consent without reading location', async (consent, reason) => {
    const currentGeneration = generation(Symbol('auth'), 1);
    const startLocationRead = vi.fn();
    const coordinator = createAcquireCoordinator({
      ensureLocationAccess: async () => consent,
      startLocationRead,
      createIdempotencyKey: () => firstKey,
      isAppActive: () => true,
      isGenerationCurrent: (candidate) => candidate === currentGeneration,
      acquire: vi.fn(),
    });

    await expect(coordinator.run(spotId, 'ko', currentGeneration)).rejects.toMatchObject({
      reason,
    });
    expect(startLocationRead).not.toHaveBeenCalled();
  });

  it('reuses only the key after an ambiguous transport failure in the same generation', async () => {
    const authToken = Symbol('auth');
    const currentGeneration = generation(authToken, 1);
    const coordinates = [
      { latitude: 37.57, longitude: 126.98, accuracy: 12 },
      { latitude: 37.58, longitude: 126.99, accuracy: 9 },
    ];
    const startLocationRead = vi.fn(() => resolvedLocation(coordinates.shift()!));
    const createIdempotencyKey = vi.fn(() => firstKey);
    const acquire = vi.fn()
      .mockRejectedValueOnce(new ApiTransportError('NETWORK_ERROR'))
      .mockResolvedValueOnce(success);
    const coordinator = createAcquireCoordinator({
      ensureLocationAccess: async () => 'active',
      startLocationRead,
      createIdempotencyKey,
      isAppActive: () => true,
      isGenerationCurrent: (candidate) => candidate === currentGeneration,
      acquire,
    });

    await expect(coordinator.run(spotId, 'ko', currentGeneration)).rejects.toMatchObject({
      failure: 'NETWORK_ERROR',
    });
    expect(coordinator.getRetryMetadata()).toEqual({ spotId, idempotencyKey: firstKey });
    expect(JSON.stringify(coordinator.getRetryMetadata())).not.toContain('37.57');

    await expect(coordinator.run(spotId, 'ko', currentGeneration)).resolves.toBe(success);
    expect(createIdempotencyKey).toHaveBeenCalledOnce();
    expect(acquire.mock.calls[0]?.[0].idempotencyKey).toBe(firstKey);
    expect(acquire.mock.calls[1]?.[0].idempotencyKey).toBe(firstKey);
    expect(acquire.mock.calls[1]?.[0].coordinates).toEqual({
      latitude: 37.58,
      longitude: 126.99,
      accuracy: 9,
    });
  });

  it('uses a new key after a definitive server failure', async () => {
    const currentGeneration = generation(Symbol('auth'), 1);
    const createIdempotencyKey = vi.fn()
      .mockReturnValueOnce(firstKey)
      .mockReturnValueOnce(secondKey);
    const acquire = vi.fn()
      .mockRejectedValueOnce(new ApiResponseError({
        code: 'OUT_OF_RANGE',
        status: 422,
        requestId: null,
        details: { distance_band: 'near' },
      }))
      .mockResolvedValueOnce(success);
    const coordinator = createAcquireCoordinator({
      ensureLocationAccess: async () => 'active',
      startLocationRead: () => resolvedLocation({
        latitude: 37.57,
        longitude: 126.98,
        accuracy: 10,
      }),
      createIdempotencyKey,
      isAppActive: () => true,
      isGenerationCurrent: (candidate) => candidate === currentGeneration,
      acquire,
    });

    await expect(coordinator.run(spotId, 'en', currentGeneration)).rejects.toMatchObject({
      code: 'OUT_OF_RANGE',
    });
    await expect(coordinator.run(spotId, 'en', currentGeneration)).resolves.toBe(success);
    expect(acquire.mock.calls[0]?.[0].idempotencyKey).toBe(firstKey);
    expect(acquire.mock.calls[1]?.[0].idempotencyKey).toBe(secondKey);
  });

  it('cancels an active watcher and clears an ambiguous key when generation changes', async () => {
    const authToken = Symbol('auth');
    let currentGeneration = generation(authToken, 1);
    const location = pendingLocation();
    const acquire = vi.fn();
    const startLocationRead = vi.fn(() => location.attempt);
    const coordinator = createAcquireCoordinator({
      ensureLocationAccess: async () => 'active',
      startLocationRead,
      createIdempotencyKey: () => firstKey,
      isAppActive: () => true,
      isGenerationCurrent: (candidate) => candidate === currentGeneration,
      acquire,
    });
    const result = coordinator.run(spotId, 'vi', currentGeneration)
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(startLocationRead).toHaveBeenCalledOnce());

    currentGeneration = generation(authToken, 2);
    coordinator.setGeneration(currentGeneration);

    await expect(result).resolves.toMatchObject({ reason: 'CANCELLED' });
    expect(location.attempt.cancel).toHaveBeenCalledOnce();
    expect(acquire).not.toHaveBeenCalled();
    expect(coordinator.getRetryMetadata()).toBeNull();
  });

  it('rechecks generation and app activity immediately before POST', async () => {
    const authToken = Symbol('auth');
    let currentGeneration = generation(authToken, 1);
    let appActive = true;
    const firstLocation = pendingLocation();
    const acquire = vi.fn();
    const coordinator = createAcquireCoordinator({
      ensureLocationAccess: async () => 'active',
      startLocationRead: vi.fn()
        .mockReturnValueOnce(firstLocation.attempt)
        .mockReturnValueOnce(resolvedLocation({
          latitude: 37.57,
          longitude: 126.98,
          accuracy: 8,
        })),
      createIdempotencyKey: () => firstKey,
      isAppActive: () => appActive,
      isGenerationCurrent: (candidate) => candidate === currentGeneration,
      acquire,
    });
    const staleRun = coordinator.run(spotId, 'ja', currentGeneration)
      .catch((error: unknown) => error);
    const oldGeneration = currentGeneration;
    currentGeneration = generation(authToken, 2);
    firstLocation.resolve?.({ latitude: 37.57, longitude: 126.98, accuracy: 8 });
    await expect(staleRun).resolves.toMatchObject({ reason: 'GENERATION_CHANGED' });

    coordinator.setGeneration(currentGeneration);
    appActive = false;
    await expect(coordinator.run(spotId, 'ja', currentGeneration)).rejects.toMatchObject({
      reason: 'APP_INACTIVE',
    });
    expect(oldGeneration).not.toBe(currentGeneration);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('aborts an in-flight POST and retains no retry key after generation changes', async () => {
    const authToken = Symbol('auth');
    let currentGeneration = generation(authToken, 1);
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const acquire = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      requestStarted?.();
      return new Promise<AcquireSuccess>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new ApiTransportError('ABORTED')), {
          once: true,
        });
      });
    });
    const coordinator = createAcquireCoordinator({
      ensureLocationAccess: async () => 'active',
      startLocationRead: () => resolvedLocation({
        latitude: 37.57,
        longitude: 126.98,
        accuracy: 8,
      }),
      createIdempotencyKey: () => firstKey,
      isAppActive: () => true,
      isGenerationCurrent: (candidate) => candidate === currentGeneration,
      acquire,
    });
    const result = coordinator.run(spotId, 'zh-Hans', currentGeneration)
      .catch((error: unknown) => error);
    await started;

    currentGeneration = generation(authToken, 2);
    coordinator.setGeneration(currentGeneration);

    await expect(result).resolves.toMatchObject({ failure: 'ABORTED' });
    expect(coordinator.getRetryMetadata()).toBeNull();
  });

  it('aborts an in-flight POST when the acquisition screen unmounts', async () => {
    const currentGeneration = generation(Symbol('auth'), 1);
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const acquire = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      requestStarted?.();
      return new Promise<AcquireSuccess>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new ApiTransportError('ABORTED')), {
          once: true,
        });
      });
    });
    const coordinator = createAcquireCoordinator({
      ensureLocationAccess: async () => 'active',
      startLocationRead: () => resolvedLocation({
        latitude: 37.57,
        longitude: 126.98,
        accuracy: 8,
      }),
      createIdempotencyKey: () => firstKey,
      isAppActive: () => true,
      isGenerationCurrent: (candidate) => candidate === currentGeneration,
      acquire,
    });
    const result = coordinator.run(spotId, 'zh-Hant', currentGeneration)
      .catch((error: unknown) => error);
    await started;

    coordinator.cancelActiveAttempt();

    await expect(result).resolves.toMatchObject({ failure: 'ABORTED' });
    expect(coordinator.getRetryMetadata()).toBeNull();
  });
});
