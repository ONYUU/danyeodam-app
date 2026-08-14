import { StatusBar } from 'expo-status-bar';
import { lazy, Suspense, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AccountDeletionGate } from '@/features/account-deletion/gate';
import { AccountDeletionProvider } from '@/features/account-deletion/provider';
import { MinimumAgeBoundary } from '@/features/minimum-age/minimum-age-boundary';
import { MinimumAgeStatusScreen } from '@/features/minimum-age/minimum-age-screen';
import { PublicShareBlockIngressBoundary } from '@/features/public-share-block/ingress-boundary';
import { PolicySupportBoundary } from '@/features/policy-support/boundary';
import { PolicySupportProvider } from '@/features/policy-support/provider';
import { LocaleProvider, useI18n } from '@/i18n/locale-provider';

const AuthenticatedApplication = lazy(
  () => import('@/app-root/authenticated-application'),
);
const PrivacyRightsApplication = lazy(
  () => import('@/features/minimum-age/privacy-rights-application'),
);

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <LocaleProvider>
        <StatusBar style="dark" />
        <PolicySupportProvider>
          <PolicySupportBoundary>
            <AccountDeletionProvider>
              <PublicShareBlockIngressBoundary>
                <AccountDeletionGate>
                  <RootExperience />
                </AccountDeletionGate>
              </PublicShareBlockIngressBoundary>
            </AccountDeletionProvider>
          </PolicySupportBoundary>
        </PolicySupportProvider>
      </LocaleProvider>
    </SafeAreaProvider>
  );
}

function RootExperience() {
  const [privacyRightsOpen, setPrivacyRightsOpen] = useState(false);
  if (privacyRightsOpen) {
    const closePrivacyRights = () => setPrivacyRightsOpen(false);
    return (
      <Suspense fallback={<PrivacyRightsLoading onExit={closePrivacyRights} />}>
        <PrivacyRightsApplication
          onExit={closePrivacyRights}
        />
      </Suspense>
    );
  }

  const openPrivacyRights = () => setPrivacyRightsOpen(true);
  return (
    <MinimumAgeBoundary
      onOpenPrivacyRights={openPrivacyRights}
      renderProtectedContent={() => (
        <AuthenticatedApplicationLoader
          onOpenPrivacyRights={openPrivacyRights}
        />
      )}
    />
  );
}

function PrivacyRightsLoading({ onExit }: { onExit(): void }) {
  const { t } = useI18n();
  return (
    <MinimumAgeStatusScreen
      body={t('ageGate.privacyRightsCheckingBody')}
      loading
      onSecondaryPress={onExit}
      secondaryButtonLabel={t('common.back')}
      title={t('ageGate.privacyRightsTitle')}
    />
  );
}

function AuthenticatedApplicationLoader({
  onOpenPrivacyRights,
}: {
  onOpenPrivacyRights(): void;
}) {
  const { t } = useI18n();
  return (
    <Suspense fallback={(
      <MinimumAgeStatusScreen
        body={t('ageGate.loadingBody')}
        loading
        title={t('ageGate.loadingTitle')}
      />
    )}>
      <AuthenticatedApplication onOpenPrivacyRights={onOpenPrivacyRights} />
    </Suspense>
  );
}
