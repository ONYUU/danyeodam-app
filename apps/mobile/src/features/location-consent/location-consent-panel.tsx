import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { acceptLocationConsent, getLocationConsent, setLocationConsentState } from '@/api/location-consent-client';
import type { LocationConsentResult } from '@/api/location-consent';
import { getCurrentPolicies } from '@/api/public-policies-client';
import type { CurrentPolicy } from '@/api/policies';
import { usePolicySupport } from '@/features/policy-support/provider';
import { useSessionDataRefresh } from '@/features/session-data/refresh-provider';
import { useI18n } from '@/i18n/locale-provider';
import { colors, radius, spacing } from '@/theme/tokens';

import { locationConsentPresentation } from './presentation';

type PanelState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; consent: LocationConsentResult; policy: CurrentPolicy | null };

export function LocationConsentPanel({ onOpenPrivacyRights }: {
  onOpenPrivacyRights(): void;
}) {
  const { generation } = useSessionDataRefresh();

  return (
    <LocationConsentPanelForGeneration
      key={generation.id}
      onOpenPrivacyRights={onOpenPrivacyRights}
    />
  );
}

function LocationConsentPanelForGeneration({ onOpenPrivacyRights }: {
  onOpenPrivacyRights(): void;
}) {
  const { locale, t } = useI18n();
  const policySupport = usePolicySupport();
  const [state, setState] = useState<PanelState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [mutating, setMutating] = useState(false);
  const [mutationFailed, setMutationFailed] = useState(false);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void getLocationConsent(controller.signal).then(async (consent) => {
      const policies = await getCurrentPolicies(controller.signal).catch(() => null);
      if (active) {
        setState({
          status: 'ready',
          consent,
          policy: policies?.find(({ type }) => type === 'location_terms') ?? null,
        });
      }
    }).catch(() => {
      if (active) setState({ status: 'error' });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [attempt]);

  const refresh = () => {
    setState({ status: 'loading' });
    setAttempt((current) => current + 1);
  };
  const mutate = async (operation: () => Promise<unknown>) => {
    if (mutating) return;
    setMutating(true);
    setMutationFailed(false);
    try {
      await operation();
      refresh();
    } catch {
      setMutationFailed(true);
    } finally {
      setMutating(false);
    }
  };

  if (state.status === 'loading') {
    return <ActivityIndicator color={colors.accent} size="small" />;
  }
  if (state.status === 'error') {
    return (
      <View style={styles.section}>
        <Text style={styles.title}>{t('locationConsent.title')}</Text>
        <Text style={styles.body}>{t('common.errorBody')}</Text>
        <Action label={t('common.retry')} onPress={refresh} />
        <Action label={t('locationConsent.openRights')} onPress={onOpenPrivacyRights} />
      </View>
    );
  }

  const presentation = locationConsentPresentation(state.consent);
  const needsAcceptance = presentation === 'required';
  const paused = presentation === 'paused';
  const pending = presentation === 'withdrawal_pending';
  return (
    <View style={styles.section}>
      <Text style={styles.title}>{t('locationConsent.title')}</Text>
      <Text style={styles.body}>
        {t(pending
          ? 'locationConsent.withdrawalPending'
          : paused
            ? 'locationConsent.paused'
            : needsAcceptance
              ? 'locationConsent.required'
              : 'locationConsent.active')}
      </Text>
      {state.policy !== null ? (
        <Action
          label={t('locationConsent.openTerms')}
          onPress={() => policySupport.openPolicy('location_terms')}
        />
      ) : null}
      {needsAcceptance && state.policy !== null && !pending ? (
        <Action
          disabled={mutating}
          label={t('locationConsent.accept')}
          onPress={() => void mutate(() => acceptLocationConsent({
            version: state.policy!.version,
            locale,
          }))}
        />
      ) : null}
      {paused && !needsAcceptance ? (
        <Action
          disabled={mutating}
          label={t('locationConsent.resume')}
          onPress={() => void mutate(() => setLocationConsentState({ state: 'active' }))}
        />
      ) : null}
      <Action label={t('locationConsent.openRights')} onPress={onOpenPrivacyRights} />
      {mutationFailed ? (
        <Text accessibilityLiveRegion="assertive" style={styles.error}>
          {t('privacyRights.mutationError')}
        </Text>
      ) : null}
    </View>
  );
}

function Action({ label, onPress, disabled = false }: {
  label: string;
  onPress(): void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.action, pressed && !disabled ? styles.pressed : null]}
    >
      <Text style={styles.actionLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { padding: spacing.lg, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.white },
  title: { color: colors.ink, fontSize: 17, fontWeight: '700' },
  body: { marginTop: spacing.sm, color: colors.mutedInk, fontSize: 14, lineHeight: 22 },
  action: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center', marginTop: spacing.md, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.accent, borderRadius: radius.pill },
  actionLabel: { color: colors.accent, fontSize: 13, fontWeight: '700' },
  error: { marginTop: spacing.md, color: colors.stamp, fontSize: 13, lineHeight: 20 },
  pressed: { opacity: 0.72 },
});
