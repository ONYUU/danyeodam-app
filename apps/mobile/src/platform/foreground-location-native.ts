import * as Location from 'expo-location';
import { AppState } from 'react-native';

import {
  createForegroundLocationReader,
  type ForegroundPermissionSnapshot,
} from './foreground-location';

function permissionSnapshot(
  permission: Location.LocationPermissionResponse,
): ForegroundPermissionSnapshot {
  const approximate = permission.ios?.accuracy === 'reduced'
    || permission.android?.accuracy === 'coarse';
  const precise = permission.ios?.accuracy === 'full'
    || permission.android?.accuracy === 'fine';
  return {
    status: permission.status,
    canAskAgain: permission.canAskAgain,
    precision: approximate ? 'approximate' : precise ? 'precise' : 'unknown',
  };
}

export const startForegroundLocationRead = createForegroundLocationReader({
  getAppState: () => AppState.currentState,
  addAppStateListener(listener) {
    return AppState.addEventListener('change', listener);
  },
  async getForegroundPermission() {
    return permissionSnapshot(await Location.getForegroundPermissionsAsync());
  },
  async requestForegroundPermission() {
    return permissionSnapshot(await Location.requestForegroundPermissionsAsync());
  },
  async watchPosition(onLocation, onError) {
    return Location.watchPositionAsync({
      accuracy: Location.Accuracy.Highest,
      distanceInterval: 0,
      timeInterval: 500,
    }, onLocation, onError);
  },
});
