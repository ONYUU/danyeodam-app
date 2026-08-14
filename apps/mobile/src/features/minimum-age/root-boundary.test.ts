import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

describe('mobile root minimum-age boundary', () => {
  it('checks deletion state before minimum age, auth, or anonymous creation', () => {
    const root = source('src/app/_layout.tsx');
    const providerIndex = root.indexOf('<AccountDeletionProvider>');
    const gateIndex = root.indexOf('<AccountDeletionGate>');
    const experienceIndex = root.indexOf('<RootExperience />');

    expect(providerIndex).toBeGreaterThan(-1);
    expect(gateIndex).toBeGreaterThan(providerIndex);
    expect(experienceIndex).toBeGreaterThan(gateIndex);
    expect(source('src/features/account-deletion/provider.tsx'))
      .not.toContain('restoreOrCreateAnonymousSession');
  });

  it('keeps the ordinary service application lazy and behind the local pass', () => {
    const root = source('src/app/_layout.tsx');

    expect(root).not.toContain("from '@/api/");
    expect(root).not.toContain("from '@/auth/supabase'");
    expect(root).toContain(
      "lazy(\n  () => import('@/app-root/authenticated-application')",
    );
    expect(root).toContain('<MinimumAgeBoundary');
    expect(root).toContain('renderProtectedContent={() => (');
    expect(root).toContain('onOpenPrivacyRights={openPrivacyRights}');
  });

  it('keeps the deletion status probe free of eager Supabase Auth imports', () => {
    const provider = source('src/features/account-deletion/provider.tsx');
    const statusClient = source('src/api/account-deletion-status-client.ts');
    expect(provider).not.toMatch(
      /^import .*['"]@\/(?:auth\/supabase|api\/account-deletion-client|api\/index)['"];?$/gmu,
    );
    expect(provider).toContain("await import('@/api/account-deletion-client')");
    expect(provider).toContain("import('@/auth/supabase')");
    expect(statusClient).toContain('createApiClient({');
    expect(statusClient).toContain('async getAccessToken()');
    expect(statusClient).not.toContain("from '@/auth/");
    expect(statusClient).not.toContain("from './index'");
    expect(statusClient).not.toContain('supabase');
  });

  it('mounts only the restricted existing-session provider for pre-age rights', () => {
    const root = source('src/app/_layout.tsx');
    const restrictedApplication = source(
      'src/features/minimum-age/privacy-rights-application.tsx',
    );
    const provider = source('src/auth/privacy-rights-session-provider.tsx');
    const restore = source('src/auth/privacy-rights-session.ts');

    expect(root).not.toContain("from '@/auth/");
    expect(root).toContain(
      "import('@/features/minimum-age/privacy-rights-application')",
    );
    expect(root).not.toContain('<AuthProvider>');
    expect(restrictedApplication).toContain('<PrivacyRightsSessionProvider>');
    expect(restrictedApplication).toContain(
      "from '@/features/privacy-rights/privacy-rights-entry'",
    );
    expect(restrictedApplication).not.toContain('<AuthProvider>');
    expect(restrictedApplication).not.toContain('<Stack');
    expect(restrictedApplication).not.toContain('SessionDataRefreshProvider');
    expect(restrictedApplication).not.toContain('AuthenticatedApplication');
    expect(provider).toContain('restoreExistingPrivacyRightsSession(supabase.auth)');
    expect(provider).not.toContain('restoreOrCreateAnonymousSession');
    expect(provider).not.toContain('signInAnonymously');
    expect(restore).toContain('auth.getSession()');
    expect(restore).not.toContain('signInAnonymously');
  });

  it('wires the rights action through local and server pre-age screens', () => {
    const localBoundary = source(
      'src/features/minimum-age/minimum-age-boundary.tsx',
    );
    const attestationBoundary = source(
      'src/features/minimum-age/attestation-gate.tsx',
    );
    const screen = source(
      'src/features/minimum-age/minimum-age-screen.tsx',
    );

    expect(localBoundary).toContain('canEnterPrivacyRightsFromBoundary(phase)');
    expect(localBoundary).toContain('onOpenPrivacyRights={onOpenPrivacyRights}');
    expect(attestationBoundary).toContain(
      'canEnterPrivacyRightsFromAttestation(',
    );
    expect(screen).toContain("t('ageGate.privacyRightsAction')");
    expect(screen).toContain('onPress={onOpenPrivacyRights}');
  });

  it('keeps the navigation stack behind auth and server attestation', () => {
    const protectedApplication = source(
      'src/app-root/authenticated-application.tsx',
    );
    const authIndex = protectedApplication.indexOf('<AuthProvider>');
    const generationIndex = protectedApplication.indexOf(
      '<SessionDataRefreshProvider>',
    );
    const attestationIndex = protectedApplication.indexOf(
      '<MinimumAgeAttestationGate',
    );
    const stackIndex = protectedApplication.indexOf('<Stack ');

    expect(authIndex).toBeGreaterThan(-1);
    expect(generationIndex).toBeGreaterThan(authIndex);
    expect(attestationIndex).toBeGreaterThan(generationIndex);
    expect(stackIndex).toBeGreaterThan(attestationIndex);
  });

  it('uses device-only unlocked secure storage and no web persistence', () => {
    const storage = source(
      'src/features/minimum-age/device-pass-storage.ts',
    );

    expect(storage).toContain('SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY');
    expect(storage).not.toContain('localStorage');
    expect(storage).not.toContain('AsyncStorage');

    const deletionStorage = source(
      'src/features/account-deletion/credential-storage.ts',
    );
    expect(deletionStorage).toContain('SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY');
    expect(deletionStorage).not.toContain('localStorage');
    expect(deletionStorage).not.toContain('AsyncStorage');
  });

  it('keeps numeric date input actionable while the keyboard is open', () => {
    const ageScreen = source(
      'src/features/minimum-age/minimum-age-screen.tsx',
    );
    const screen = source('src/components/screen.tsx');

    expect(ageScreen.match(/keyboardType="number-pad"/gu)).toHaveLength(3);
    expect(ageScreen.match(/autoComplete="off"/gu)).toHaveLength(3);
    expect(ageScreen.match(/importantForAutofill="no"/gu)).toHaveLength(3);
    expect(screen).toContain('automaticallyAdjustKeyboardInsets');
    expect(screen).toContain('keyboardShouldPersistTaps="handled"');
  });
});
