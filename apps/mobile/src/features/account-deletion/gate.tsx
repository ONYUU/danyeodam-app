import type { PropsWithChildren } from 'react';
import { useState } from 'react';
import { Linking } from 'react-native';

import { MinimumAgeStatusScreen } from '@/features/minimum-age/minimum-age-screen';
import { formatKstDateTime } from '@/features/privacy-rights/presentation';
import { useI18n } from '@/i18n/locale-provider';

import { useAccountDeletion } from './provider';

export function AccountDeletionGate({ children }: PropsWithChildren) {
  const deletion = useAccountDeletion();
  const { locale, t } = useI18n();
  const [actionFailed, setActionFailed] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const state = deletion.state;

  if (state.status === 'inactive') return children;
  if (state.status === 'checking' || state.status === 'reconciling') {
    return (
      <MinimumAgeStatusScreen
        body={t('accountDeletion.checkingBody')}
        loading
        title={t('accountDeletion.checkingTitle')}
      />
    );
  }
  if (state.status === 'error') {
    return (
      <MinimumAgeStatusScreen
        body={t('accountDeletion.errorBody')}
        buttonLabel={t('common.retry')}
        onPress={deletion.retry}
        title={t('accountDeletion.errorTitle')}
      />
    );
  }
  if (state.status === 'authorization_required') {
    return (
      <MinimumAgeStatusScreen
        body={actionFailed
          ? `${t('accountDeletion.authorizationRequiredBody')} ${t('accountDeletion.localCleanupError')}`
          : t('accountDeletion.authorizationRequiredBody')}
        buttonLabel={actionBusy
          ? t('common.loading')
          : t('accountDeletion.restartRequest')}
        onPress={() => {
          if (actionBusy) return;
          setActionBusy(true);
          setActionFailed(false);
          void deletion.restartAfterAuthorizationFailure()
            .catch(() => setActionFailed(true))
            .finally(() => setActionBusy(false));
        }}
        title={t('accountDeletion.authorizationRequiredTitle')}
      />
    );
  }
  if (state.status === 'pending') {
    return (
      <MinimumAgeStatusScreen
        body={`${t('accountDeletion.pendingBody')} ${formatKstDateTime(state.completeBy, locale)}`}
        buttonLabel={t('common.refresh')}
        onPress={deletion.retry}
        title={t('accountDeletion.pendingTitle')}
      />
    );
  }
  if (state.status === 'action_required') {
    return (
      <MinimumAgeStatusScreen
        body={actionFailed
          ? `${t('accountDeletion.actionRequiredBody')} ${t('accountDeletion.supportOpenError')}`
          : t('accountDeletion.actionRequiredBody')}
        buttonLabel={t('accountDeletion.openSupport')}
        onPress={() => {
          setActionFailed(false);
          void Linking.openURL(state.supportUrl).catch(() => setActionFailed(true));
        }}
        onSecondaryPress={deletion.retry}
        secondaryButtonLabel={t('common.refresh')}
        title={t('accountDeletion.actionRequiredTitle')}
      />
    );
  }

  return (
    <MinimumAgeStatusScreen
      body={actionFailed
        ? `${t('accountDeletion.completedBody')} ${t('accountDeletion.localCleanupError')}`
        : t('accountDeletion.completedBody')}
      buttonLabel={actionBusy ? t('common.loading') : t('accountDeletion.finish')}
      onPress={() => {
        if (actionBusy) return;
        setActionBusy(true);
        setActionFailed(false);
        void deletion.finishCompletedDeletion()
          .catch(() => setActionFailed(true))
          .finally(() => setActionBusy(false));
      }}
      title={t('accountDeletion.completedTitle')}
    />
  );
}
