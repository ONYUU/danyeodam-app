import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';

import { submitMinimumAgeAttestation } from '@/api/minimum-age-attestation-client';
import { useAuth } from '@/auth/auth-provider';
import { useSessionDataRefresh } from '@/features/session-data/refresh-provider';
import { useI18n } from '@/i18n/locale-provider';

import { renderAfterMinimumAgeBoundary } from './admission';
import {
  resolveBindingAttestationRequestState,
  runBindingAttestationAttempt,
  type BindingAttestationResult,
} from './attestation-binding';
import {
  canEnterPrivacyRightsFromAttestation,
  resolveAttestationPresentation,
} from './attestation-presentation';
import { MinimumAgeStatusScreen } from './minimum-age-screen';

type MinimumAgeAttestationGateProps = {
  onOpenPrivacyRights(): void;
  renderProtectedContent(): ReactNode;
};

export function MinimumAgeAttestationGate({
  onOpenPrivacyRights,
  renderProtectedContent,
}: MinimumAgeAttestationGateProps) {
  const auth = useAuth();
  const { generation, isGenerationCurrent } = useSessionDataRefresh();
  const { t } = useI18n();
  const [requestResult, setRequestResult] = useState<BindingAttestationResult | null>(null);
  const [attempt, setAttempt] = useState(0);
  const sessionUserId = auth.status === 'ready'
    ? auth.session?.user.id ?? null
    : null;

  useEffect(() => {
    if (auth.status !== 'ready' || sessionUserId === null) {
      return;
    }

    let active = true;
    const controller = new AbortController();
    void runBindingAttestationAttempt({
      generation,
      isGenerationCurrent,
      sessionUserId,
      signal: controller.signal,
      submit: submitMinimumAgeAttestation,
    }).then((result) => {
      if (active && result !== null) {
        setRequestResult(result);
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    attempt,
    auth.status,
    generation,
    isGenerationCurrent,
    sessionUserId,
  ]);

  const retry = useCallback(() => {
    setRequestResult(null);
    if (auth.status === 'ready' && auth.session !== null) {
      setAttempt((current) => current + 1);
      return;
    }
    auth.retry();
  }, [auth]);

  const requestState = resolveBindingAttestationRequestState({
    generation,
    result: requestResult,
    sessionUserId,
  });
  const presentation = resolveAttestationPresentation({
    authStatus: auth.status,
    hasSession: auth.session !== null,
    requestState,
  });
  const privacyRightsStatusProps = canEnterPrivacyRightsFromAttestation(
    presentation,
  )
    ? {
        onSecondaryPress: onOpenPrivacyRights,
        secondaryButtonLabel: t('ageGate.privacyRightsAction'),
      }
    : {};
  if (presentation === 'ready') {
    return renderAfterMinimumAgeBoundary(true, renderProtectedContent);
  }

  if (presentation === 'session_error' || presentation === 'request_error') {
    return (
      <MinimumAgeStatusScreen
        body={t(
          presentation === 'session_error'
            ? 'ageGate.sessionErrorBody'
            : 'ageGate.attestationErrorBody',
        )}
        buttonLabel={t('common.retry')}
        onPress={retry}
        {...privacyRightsStatusProps}
        title={t(
          presentation === 'session_error'
            ? 'ageGate.sessionErrorTitle'
            : 'ageGate.attestationErrorTitle',
        )}
      />
    );
  }

  return (
    <MinimumAgeStatusScreen
      body={t('ageGate.attestingBody')}
      loading
      {...privacyRightsStatusProps}
      title={t('ageGate.attestingTitle')}
    />
  );
}
