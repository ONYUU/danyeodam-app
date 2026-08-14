import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

import { useI18n } from '@/i18n/locale-provider';

import {
  completeMinimumAgeAdmission,
  renderAfterMinimumAgeBoundary,
} from './admission';
import { minimumAgeDevicePassStore } from './device-pass-storage';
import {
  MinimumAgeBirthDateScreen,
  MinimumAgeStatusScreen,
} from './minimum-age-screen';
import {
  evaluateBirthDate,
  type BirthDateFields,
} from './policy';
import {
  canEnterPrivacyRightsFromBoundary,
  type MinimumAgeBoundaryPhase,
} from './privacy-rights-entry';

type MinimumAgeBoundaryProps = {
  onOpenPrivacyRights(): void;
  renderProtectedContent(): ReactNode;
};

function emptyBirthDateFields(): BirthDateFields {
  return { year: '', month: '', day: '' };
}

export function MinimumAgeBoundary({
  onOpenPrivacyRights,
  renderProtectedContent,
}: MinimumAgeBoundaryProps) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<MinimumAgeBoundaryPhase>('checking');
  const [fields, setFields] = useState<BirthDateFields>(emptyBirthDateFields);
  const [invalidDate, setInvalidDate] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const submitting = useRef(false);
  const privacyRightsStatusProps = canEnterPrivacyRightsFromBoundary(phase)
    ? {
        onSecondaryPress: onOpenPrivacyRights,
        secondaryButtonLabel: t('ageGate.privacyRightsAction'),
      }
    : {};

  useEffect(() => {
    let active = true;
    void minimumAgeDevicePassStore.load()
      .then((passed) => {
        if (active) {
          setPhase(passed ? 'passed' : 'collecting');
        }
      })
      .catch(() => {
        if (active) {
          setPhase('storage_error');
        }
      });
    return () => {
      active = false;
    };
  }, [loadAttempt]);

  const submit = () => {
    if (submitting.current || phase !== 'collecting') {
      return;
    }
    submitting.current = true;
    const decision = evaluateBirthDate(fields);
    if (decision === 'invalid') {
      setInvalidDate(true);
      submitting.current = false;
      return;
    }

    setFields(emptyBirthDateFields());
    setInvalidDate(false);
    if (decision === 'ineligible') {
      setPhase('ineligible');
      submitting.current = false;
      return;
    }
    setPhase('saving');

    void completeMinimumAgeAdmission(
      decision,
      () => minimumAgeDevicePassStore.save(),
    )
      .then((outcome) => {
        setPhase(outcome === 'passed' ? 'passed' : 'ineligible');
      })
      .catch(() => {
        setPhase('storage_error');
      })
      .finally(() => {
        submitting.current = false;
      });
  };

  if (phase === 'passed') {
    return renderAfterMinimumAgeBoundary(true, renderProtectedContent);
  }
  if (phase === 'checking' || phase === 'saving') {
    return (
      <MinimumAgeStatusScreen
        body={t(
          phase === 'saving'
            ? 'ageGate.savingBody'
            : 'ageGate.loadingBody',
        )}
        loading
        {...privacyRightsStatusProps}
        title={t(
          phase === 'saving'
            ? 'ageGate.savingTitle'
            : 'ageGate.loadingTitle',
        )}
      />
    );
  }
  if (phase === 'ineligible') {
    return (
      <MinimumAgeStatusScreen
        body={t('ageGate.unavailableBody')}
        {...privacyRightsStatusProps}
        title={t('ageGate.unavailableTitle')}
      />
    );
  }
  if (phase === 'storage_error') {
    return (
      <MinimumAgeStatusScreen
        body={t('ageGate.storageErrorBody')}
        buttonLabel={t('common.retry')}
        onPress={() => {
          setPhase('checking');
          setLoadAttempt((current) => current + 1);
        }}
        {...privacyRightsStatusProps}
        title={t('ageGate.storageErrorTitle')}
      />
    );
  }

  return (
    <MinimumAgeBirthDateScreen
      error={invalidDate}
      fields={fields}
      onChange={(field, value) => {
        setInvalidDate(false);
        setFields((current) => ({ ...current, [field]: value }));
      }}
      onOpenPrivacyRights={onOpenPrivacyRights}
      onSubmit={submit}
    />
  );
}
