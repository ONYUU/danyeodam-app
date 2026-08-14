import { AppState } from 'react-native';

import { acquireAtSpot } from '@/api/acquire-client';
import { getLocationConsent } from '@/api/location-consent-client';
import type { SessionBindingGeneration } from '@/features/session-data/generation';
import { createAcquisitionIdempotencyKey } from '@/platform/acquisition-key';
import { startForegroundLocationRead } from '@/platform/foreground-location-native';

import { createAcquireCoordinator } from './coordinator';

export function createRuntimeAcquireCoordinator(input: {
  isGenerationCurrent(generation: SessionBindingGeneration): boolean;
}) {
  return createAcquireCoordinator({
    acquire: acquireAtSpot,
    async ensureLocationAccess(signal) {
      const result = await getLocationConsent(signal);
      if (result.status === 'missing') {
        return 'missing';
      }
      if (result.consent.state === 'withdrawal_pending') {
        return 'withdrawal_pending';
      }
      if (result.consent.state === 'paused') {
        return 'paused';
      }
      return result.consent.isCurrent ? 'active' : 'stale';
    },
    createIdempotencyKey: createAcquisitionIdempotencyKey,
    isAppActive: () => AppState.currentState === 'active',
    isGenerationCurrent: input.isGenerationCurrent,
    startLocationRead: startForegroundLocationRead,
  });
}
