import { Stack } from 'expo-router';

import { AuthProvider } from '@/auth/auth-provider';
import { MinimumAgeAttestationGate } from '@/features/minimum-age/attestation-gate';
import { SessionDataRefreshProvider } from '@/features/session-data/refresh-provider';

type AuthenticatedApplicationProps = {
  onOpenPrivacyRights(): void;
};

export default function AuthenticatedApplication({
  onOpenPrivacyRights,
}: AuthenticatedApplicationProps) {
  return (
    <AuthProvider>
      <SessionDataRefreshProvider>
        <MinimumAgeAttestationGate
          onOpenPrivacyRights={onOpenPrivacyRights}
          renderProtectedContent={() => (
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="auth/callback" />
              <Stack.Screen name="reviewer-login" />
              <Stack.Screen name="spot/[id]" />
              <Stack.Screen name="bonus-packs/index" />
              <Stack.Screen name="bonus-packs/[id]" />
              <Stack.Screen name="card-inventory" />
              <Stack.Screen name="share-block" />
              <Stack.Screen name="public-share-block" />
              <Stack.Screen name="blocks" />
            </Stack>
          )}
        />
      </SessionDataRefreshProvider>
    </AuthProvider>
  );
}
