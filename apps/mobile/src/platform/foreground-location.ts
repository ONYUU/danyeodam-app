export type ForegroundCoordinates = {
  latitude: number;
  longitude: number;
  accuracy: number;
};

export type ForegroundLocationFailure =
  | 'PERMISSION_DENIED_RETRYABLE'
  | 'PERMISSION_DENIED_SETTINGS'
  | 'APPROXIMATE_PERMISSION'
  | 'APP_INACTIVE'
  | 'TIMEOUT'
  | 'UNAVAILABLE'
  | 'CANCELLED';

export class ForegroundLocationError extends Error {
  readonly reason: ForegroundLocationFailure;

  constructor(reason: ForegroundLocationFailure) {
    super(`Foreground location failed with ${reason}.`);
    this.name = 'ForegroundLocationError';
    this.reason = reason;
  }
}

export type ForegroundPermissionSnapshot = {
  status: 'granted' | 'denied' | 'undetermined';
  canAskAgain: boolean;
  precision: 'precise' | 'approximate' | 'unknown';
};

type RemovableSubscription = { remove(): void };

type LocationDependencies = {
  getAppState(): string;
  addAppStateListener(listener: (state: string) => void): RemovableSubscription;
  getForegroundPermission(): Promise<ForegroundPermissionSnapshot>;
  requestForegroundPermission(): Promise<ForegroundPermissionSnapshot>;
  watchPosition(
    onLocation: (position: {
      coords: {
        latitude: number;
        longitude: number;
        accuracy: number | null;
      };
    }) => void,
    onError: () => void,
  ): Promise<RemovableSubscription>;
};

export type ForegroundLocationAttempt = {
  result: Promise<ForegroundCoordinates>;
  cancel(): void;
};

function isValidCoordinate(value: number, minimum: number, maximum: number): boolean {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

function permissionFailure(
  permission: ForegroundPermissionSnapshot,
): ForegroundLocationFailure | null {
  if (permission.status !== 'granted') {
    return permission.canAskAgain
      ? 'PERMISSION_DENIED_RETRYABLE'
      : 'PERMISSION_DENIED_SETTINGS';
  }
  return permission.precision === 'approximate'
    ? 'APPROXIMATE_PERMISSION'
    : null;
}

export function createForegroundLocationReader(
  dependencies: LocationDependencies,
  timeoutMs = 15_000,
) {
  return function startForegroundLocationRead(): ForegroundLocationAttempt {
    let settled = false;
    let locationSubscription: RemovableSubscription | null = null;
    let appStateSubscription: RemovableSubscription | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let resolveResult: (coordinates: ForegroundCoordinates) => void = () => undefined;
    let rejectResult: (error: ForegroundLocationError) => void = () => undefined;

    const result = new Promise<ForegroundCoordinates>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    const cleanup = () => {
      if (timeout !== null) {
        clearTimeout(timeout);
        timeout = null;
      }
      locationSubscription?.remove();
      locationSubscription = null;
      appStateSubscription?.remove();
      appStateSubscription = null;
    };
    const fail = (reason: ForegroundLocationFailure) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      rejectResult(new ForegroundLocationError(reason));
    };
    const succeed = (coordinates: ForegroundCoordinates) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolveResult(coordinates);
    };

    const initialize = async () => {
      if (dependencies.getAppState() !== 'active') {
        fail('APP_INACTIVE');
        return;
      }

      let permission = await dependencies.getForegroundPermission();
      if (settled) {
        return;
      }
      if (permission.status !== 'granted' && permission.canAskAgain) {
        permission = await dependencies.requestForegroundPermission();
      }
      if (settled) {
        return;
      }
      const deniedReason = permissionFailure(permission);
      if (deniedReason !== null) {
        fail(deniedReason);
        return;
      }
      if (dependencies.getAppState() !== 'active') {
        fail('APP_INACTIVE');
        return;
      }

      appStateSubscription = dependencies.addAppStateListener((nextState) => {
        if (nextState !== 'active') {
          fail('APP_INACTIVE');
        }
      });
      if (dependencies.getAppState() !== 'active') {
        fail('APP_INACTIVE');
        return;
      }
      timeout = setTimeout(() => fail('TIMEOUT'), timeoutMs);

      const nextSubscription = await dependencies.watchPosition((position) => {
        const { latitude, longitude, accuracy } = position.coords;
        if (accuracy === null) {
          return;
        }
        if (
          !isValidCoordinate(latitude, -90, 90)
          || !isValidCoordinate(longitude, -180, 180)
          || !isValidCoordinate(accuracy, 0, 50_000)
        ) {
          fail('UNAVAILABLE');
          return;
        }
        succeed({ latitude, longitude, accuracy });
      }, () => fail('UNAVAILABLE'));

      if (settled) {
        nextSubscription.remove();
      } else {
        locationSubscription = nextSubscription;
      }
    };

    void initialize().catch(() => fail('UNAVAILABLE'));
    return {
      result,
      cancel: () => fail('CANCELLED'),
    };
  };
}
