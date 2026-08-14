import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { AcquireSuccess } from '@/api/acquire';
import { getLocalizedText } from '@/api/payload';
import { useAuth } from '@/auth/auth-provider';
import { TravelCardFace } from '@/components/travel-card-face';
import { RecoveryIssuePanel } from '@/features/recovery/recovery-panel';
import { formatKstDate } from '@/features/read/presentation';
import { useSessionDataRefresh } from '@/features/session-data/refresh-provider';
import { useI18n } from '@/i18n/locale-provider';
import { colors, radius, spacing } from '@/theme/tokens';

import { acquireFailure, type AcquireFailure } from './presentation';
import { createRuntimeAcquireCoordinator } from './runtime';

type AcquireState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'success'; result: AcquireSuccess }
  | { status: 'error'; failure: AcquireFailure };

function failureMessageKey(failure: AcquireFailure) {
  switch (failure) {
    case 'permission_denied':
      return 'acquire.permissionDenied' as const;
    case 'permission_settings':
      return 'acquire.permissionSettings' as const;
    case 'approximate_location':
      return 'acquire.approximateLocation' as const;
    case 'location_timeout':
      return 'acquire.locationTimeout' as const;
    case 'location_unavailable':
      return 'acquire.locationUnavailable' as const;
    case 'low_accuracy':
      return 'acquire.lowAccuracy' as const;
    case 'out_of_range_near':
      return 'acquire.outOfRangeNear' as const;
    case 'out_of_range_far':
      return 'acquire.outOfRangeFar' as const;
    case 'already_today':
      return 'acquire.alreadyToday' as const;
    case 'spot_not_open':
      return 'acquire.spotNotOpen' as const;
    case 'gate_closed':
      return 'acquire.gateClosed' as const;
    case 'minimum_age_required':
      return 'acquire.minimumAgeRequired' as const;
    case 'location_consent_required':
      return 'acquire.locationConsentRequired' as const;
    case 'location_use_paused':
      return 'acquire.locationUsePaused' as const;
    case 'location_withdrawal_pending':
      return 'acquire.locationWithdrawalPending' as const;
    case 'location_correction_pending':
      return 'acquire.locationCorrectionPending' as const;
    case 'session':
      return 'common.sessionBody' as const;
    case 'uncertain':
      return 'acquire.uncertain' as const;
    case 'error':
      return 'acquire.error' as const;
  }
}

export function AcquirePanel({ spotId }: { spotId: string }) {
  const auth = useAuth();
  const { locale, t } = useI18n();
  const {
    generation,
    isGenerationCurrent,
    refreshCollection,
  } = useSessionDataRefresh();
  const [coordinator] = useState(() => createRuntimeAcquireCoordinator({
    isGenerationCurrent,
  }));
  const [state, setState] = useState<AcquireState>({ status: 'idle' });
  const mounted = useRef(true);
  const submitting = state.status === 'submitting';
  const sessionUnavailable = auth.status === 'error'
    || auth.status === 'signed_out'
    || (state.status === 'error' && state.failure === 'session');

  useEffect(() => {
    coordinator.setGeneration(generation);
    return () => coordinator.cancelActiveAttempt();
  }, [coordinator, generation]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      coordinator.cancelActiveAttempt();
    };
  }, [coordinator]);

  const acquire = async () => {
    if (submitting) {
      return;
    }
    setState({ status: 'submitting' });
    const generationAtStart = generation;
    try {
      const result = await coordinator.run(spotId, locale, generationAtStart);
      if (!mounted.current || !isGenerationCurrent(generationAtStart)) {
        return;
      }
      setState({ status: 'success', result });
      refreshCollection();
    } catch (error) {
      if (!mounted.current || !isGenerationCurrent(generationAtStart)) {
        return;
      }
      setState({ status: 'error', failure: acquireFailure(error) });
    }
  };

  if (state.status === 'success') {
    const title = getLocalizedText(
      state.result.card.title,
      locale,
      t('common.untitled'),
    );
    const date = formatKstDate(state.result.dateKst, locale);
    return (
      <View style={styles.successSection}>
        <Text
          accessibilityLiveRegion="polite"
          accessibilityRole="header"
          style={styles.successTitle}
        >
          {t('acquire.successTitle')}
        </Text>
        <Text style={styles.successBody}>{t('acquire.successBody')}</Text>
        <View
          accessible
          accessibilityLabel={`${title}. ${t('acquire.dateLabel')} ${date}`}
          accessibilityRole="image"
          style={styles.cardFrame}
        >
          <TravelCardFace
            acquired
            colorHex={state.result.card.colorHex}
            imageUrl={state.result.card.imageUrl}
            title={title}
            variant="hero"
          />
        </View>
        <Text style={styles.date}>
          {t('acquire.dateLabel')} · {date}
        </Text>
        <RecoveryIssuePanel embedded />
      </View>
    );
  }

  const failure = state.status === 'error' ? state.failure : null;
  const locationSettingsFailure = failure === 'permission_settings'
    || failure === 'approximate_location';
  const rightsFailure = failure === 'minimum_age_required'
    || failure === 'location_consent_required'
    || failure === 'location_use_paused'
    || failure === 'location_withdrawal_pending'
    || failure === 'location_correction_pending';
  const terminalFailure = failure === 'already_today'
    || failure === 'spot_not_open'
    || rightsFailure;
  const canAcquire = !sessionUnavailable
    && failure !== 'gate_closed'
    && !terminalFailure;
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.title}>{t('acquire.title')}</Text>
      <Text style={styles.body}>{t('acquire.body')}</Text>
      <View style={styles.notice}>
        <Text style={styles.noticeBody}>{t('acquire.locationNotice')}</Text>
      </View>
      {failure === null ? null : (
        <Text accessibilityLiveRegion="assertive" style={styles.error}>
          {t(failureMessageKey(failure))}
        </Text>
      )}
      {failure === 'gate_closed' || rightsFailure ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push('/(tabs)/settings')}
          style={({ pressed }) => [styles.secondaryButton, pressed ? styles.pressed : null]}
        >
          <Text style={styles.secondaryLabel}>
            {t(rightsFailure ? 'acquire.openPrivacyRights' : 'acquire.openSettings')}
          </Text>
        </Pressable>
      ) : null}
      {locationSettingsFailure ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            void Linking.openSettings().catch(() => undefined);
          }}
          style={({ pressed }) => [styles.secondaryButton, pressed ? styles.pressed : null]}
        >
          <Text style={styles.secondaryLabel}>{t('acquire.openDeviceSettings')}</Text>
        </Pressable>
      ) : null}
      {sessionUnavailable ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setState({ status: 'idle' });
            auth.retry();
          }}
          style={({ pressed }) => [styles.primaryButton, pressed ? styles.pressed : null]}
        >
          <Text style={styles.primaryLabel}>{t('common.restoreSession')}</Text>
        </Pressable>
      ) : canAcquire ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{
            busy: submitting,
            disabled: submitting || auth.status === 'loading',
          }}
          disabled={submitting || auth.status === 'loading'}
          onPress={() => void acquire()}
          style={({ pressed }) => [
            styles.primaryButton,
            pressed && !submitting ? styles.pressed : null,
            submitting || auth.status === 'loading' ? styles.disabled : null,
          ]}
        >
          {submitting ? <ActivityIndicator color={colors.white} size="small" /> : null}
          <Text style={styles.primaryLabel}>
            {t(submitting
              ? 'acquire.submitting'
              : auth.status === 'loading'
                ? 'common.loading'
                : failure === null
                  ? 'acquire.button'
                  : 'common.retry')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.white,
  },
  title: {
    color: colors.ink,
    fontSize: 19,
    fontWeight: '800',
  },
  body: {
    marginTop: spacing.sm,
    color: colors.mutedInk,
    fontSize: 14,
    lineHeight: 22,
  },
  notice: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: colors.accentSoft,
  },
  noticeBody: {
    color: colors.accent,
    fontSize: 13,
    lineHeight: 20,
  },
  error: {
    marginTop: spacing.md,
    color: colors.stamp,
    fontSize: 13,
    lineHeight: 20,
  },
  primaryButton: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
  },
  primaryLabel: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '700',
  },
  secondaryButton: {
    minHeight: 44,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.pill,
  },
  secondaryLabel: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.72,
  },
  disabled: {
    opacity: 0.62,
  },
  successSection: {
    gap: spacing.lg,
  },
  successTitle: {
    color: colors.accent,
    fontSize: 24,
    fontWeight: '800',
  },
  successBody: {
    color: colors.mutedInk,
    fontSize: 14,
    lineHeight: 22,
  },
  cardFrame: {
    width: '100%',
    maxWidth: 380,
    alignSelf: 'center',
  },
  date: {
    marginTop: -spacing.sm,
    textAlign: 'center',
    color: colors.mutedInk,
    fontSize: 13,
  },
});
