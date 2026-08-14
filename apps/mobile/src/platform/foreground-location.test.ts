import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createForegroundLocationReader,
  ForegroundLocationError,
  type ForegroundPermissionSnapshot,
} from './foreground-location';

const precisePermission = {
  status: 'granted',
  canAskAgain: true,
  precision: 'precise',
} satisfies ForegroundPermissionSnapshot;

function locationHarness(permission: ForegroundPermissionSnapshot = precisePermission) {
  let appState = 'active';
  let appStateListener: ((state: string) => void) | null = null;
  let onLocation: ((position: {
    coords: { latitude: number; longitude: number; accuracy: number | null };
  }) => void) | null = null;
  const locationRemove = vi.fn();
  const appStateRemove = vi.fn();
  const getForegroundPermission = vi.fn(async () => permission);
  const requestForegroundPermission = vi.fn(async () => permission);
  const watchPosition = vi.fn(async (nextLocation: typeof onLocation) => {
    onLocation = nextLocation;
    return { remove: locationRemove };
  });
  const dependencies = {
    getAppState: () => appState,
    addAppStateListener: vi.fn((listener: (state: string) => void) => {
      appStateListener = listener;
      return { remove: appStateRemove };
    }),
    getForegroundPermission,
    requestForegroundPermission,
    watchPosition,
  };
  return {
    dependencies,
    locationRemove,
    appStateRemove,
    getForegroundPermission,
    requestForegroundPermission,
    watchPosition,
    emitLocation(coords: { latitude: number; longitude: number; accuracy: number | null }) {
      onLocation?.({ coords });
    },
    setAppState(nextState: string) {
      appState = nextState;
      appStateListener?.(nextState);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('cancellable foreground location reader', () => {
  it('does no permission or location work until the user-started read', async () => {
    const harness = locationHarness();
    const startRead = createForegroundLocationReader(harness.dependencies);

    expect(harness.getForegroundPermission).not.toHaveBeenCalled();
    expect(harness.watchPosition).not.toHaveBeenCalled();

    const attempt = startRead();
    await vi.waitFor(() => expect(harness.watchPosition).toHaveBeenCalledOnce());
    harness.emitLocation({ latitude: 37.57, longitude: 126.98, accuracy: 8 });

    await expect(attempt.result).resolves.toEqual({
      latitude: 37.57,
      longitude: 126.98,
      accuracy: 8,
    });
    expect(harness.locationRemove).toHaveBeenCalledOnce();
    expect(harness.appStateRemove).toHaveBeenCalledOnce();
  });

  it('distinguishes retryable denial from a denial requiring Settings', async () => {
    const retryable = locationHarness({
      status: 'denied',
      canAskAgain: true,
      precision: 'unknown',
    });
    retryable.dependencies.requestForegroundPermission = vi.fn(async () => ({
      status: 'denied' as const,
      canAskAgain: true,
      precision: 'unknown' as const,
    }));
    const retryableResult = createForegroundLocationReader(retryable.dependencies)()
      .result.catch((error: unknown) => error);
    await expect(retryableResult).resolves.toMatchObject({
      reason: 'PERMISSION_DENIED_RETRYABLE',
    });

    const permanent = locationHarness({
      status: 'denied',
      canAskAgain: false,
      precision: 'unknown',
    });
    const permanentResult = createForegroundLocationReader(permanent.dependencies)()
      .result.catch((error: unknown) => error);
    await expect(permanentResult).resolves.toMatchObject({
      reason: 'PERMISSION_DENIED_SETTINGS',
    });
    expect(permanent.requestForegroundPermission).not.toHaveBeenCalled();
  });

  it('rejects approximate permission before starting a watcher', async () => {
    const harness = locationHarness({
      status: 'granted',
      canAskAgain: true,
      precision: 'approximate',
    });
    const result = createForegroundLocationReader(harness.dependencies)()
      .result.catch((error: unknown) => error);

    await expect(result).resolves.toMatchObject({ reason: 'APPROXIMATE_PERMISSION' });
    expect(harness.watchPosition).not.toHaveBeenCalled();
  });

  it('removes the foreground watcher after the 15 second timeout', async () => {
    vi.useFakeTimers();
    const harness = locationHarness();
    const attempt = createForegroundLocationReader(harness.dependencies)();
    const result = attempt.result.catch((error: unknown) => error);
    await vi.waitFor(() => expect(harness.watchPosition).toHaveBeenCalledOnce());

    await vi.advanceTimersByTimeAsync(15_000);

    await expect(result).resolves.toBeInstanceOf(ForegroundLocationError);
    await expect(result).resolves.toMatchObject({ reason: 'TIMEOUT' });
    expect(harness.locationRemove).toHaveBeenCalledOnce();
    expect(harness.appStateRemove).toHaveBeenCalledOnce();
  });

  it('removes the watcher when the app becomes inactive', async () => {
    const harness = locationHarness();
    const attempt = createForegroundLocationReader(harness.dependencies)();
    const result = attempt.result.catch((error: unknown) => error);
    await vi.waitFor(() => expect(harness.watchPosition).toHaveBeenCalledOnce());

    harness.setAppState('inactive');

    await expect(result).resolves.toMatchObject({ reason: 'APP_INACTIVE' });
    expect(harness.locationRemove).toHaveBeenCalledOnce();
    expect(harness.appStateRemove).toHaveBeenCalledOnce();
  });

  it('removes the watcher when the caller cancels on unmount or generation change', async () => {
    const harness = locationHarness();
    const attempt = createForegroundLocationReader(harness.dependencies)();
    const result = attempt.result.catch((error: unknown) => error);
    await vi.waitFor(() => expect(harness.watchPosition).toHaveBeenCalledOnce());

    attempt.cancel();

    await expect(result).resolves.toMatchObject({ reason: 'CANCELLED' });
    expect(harness.locationRemove).toHaveBeenCalledOnce();
    expect(harness.appStateRemove).toHaveBeenCalledOnce();
  });

  it('removes a subscription that resolves after a synchronous location callback', async () => {
    const harness = locationHarness();
    harness.dependencies.watchPosition = vi.fn(async (onLocation) => {
      onLocation?.({ coords: { latitude: 37.57, longitude: 126.98, accuracy: 7 } });
      return { remove: harness.locationRemove };
    });
    const attempt = createForegroundLocationReader(harness.dependencies)();

    await expect(attempt.result).resolves.toMatchObject({ accuracy: 7 });
    await vi.waitFor(() => expect(harness.locationRemove).toHaveBeenCalledOnce());
  });
});
