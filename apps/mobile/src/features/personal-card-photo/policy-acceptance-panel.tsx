import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { acceptCurrentPolicies } from '@/api/policies-client';
import { getCurrentPolicies } from '@/api/public-policies-client';
import {
  selectCurrentConsentPolicies,
  type ConsentPolicyType,
  type CurrentConsentPolicy,
} from '@/api/policies';
import { ApiResponseError } from '@/api/client';
import { usePolicySupport } from '@/features/policy-support/provider';
import { useI18n } from '@/i18n/locale-provider';
import { colors, radius, spacing } from '@/theme/tokens';

type AcceptanceState =
  | { status: 'error' }
  | { status: 'loading' }
  | {
    status: 'ready';
    policies: readonly [CurrentConsentPolicy, CurrentConsentPolicy];
  };

const POLICY_LABEL_KEYS = {
  terms_of_use: 'personalCardPhoto.policyTerms',
  community_guidelines: 'personalCardPhoto.policyCommunity',
} as const;

export function PersonalCardPolicyAcceptancePanel(input: {
  onAccepted(): void;
}) {
  const { locale, t } = useI18n();
  const policySupport = usePolicySupport();
  const [state, setState] = useState<AcceptanceState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [reviewed, setReviewed] = useState<Record<ConsentPolicyType, boolean>>({
    terms_of_use: false,
    community_guidelines: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const acceptController = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void getCurrentPolicies(controller.signal).then((policies) => {
      if (!controller.signal.aborted) {
        setState({
          status: 'ready',
          policies: selectCurrentConsentPolicies(policies, locale),
        });
      }
    }).catch(() => {
      if (!controller.signal.aborted) {
        setState({ status: 'error' });
      }
    });
    return () => controller.abort();
  }, [attempt, locale]);

  useEffect(() => () => acceptController.current?.abort(), []);

  const refresh = () => {
    setState({ status: 'loading' });
    setActionFailed(false);
    setReviewed({ terms_of_use: false, community_guidelines: false });
    setAttempt((current) => current + 1);
  };

  const accept = async () => {
    if (
      state.status !== 'ready'
      || submitting
      || !reviewed.terms_of_use
      || !reviewed.community_guidelines
    ) {
      return;
    }
    const controller = new AbortController();
    acceptController.current = controller;
    setSubmitting(true);
    setActionFailed(false);
    try {
      await acceptCurrentPolicies({
        locale,
        policies: state.policies,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        input.onAccepted();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        if (
          error instanceof ApiResponseError
          && error.code === 'POLICY_ACCEPTANCE_REQUIRED'
        ) {
          // The current policy rotated between GET and POST. Refetch the
          // server current set and require an explicit review again.
          refresh();
        } else {
          setActionFailed(true);
        }
      }
    } finally {
      if (!controller.signal.aborted) {
        setSubmitting(false);
      }
      if (acceptController.current === controller) {
        acceptController.current = null;
      }
    }
  };

  if (state.status === 'loading') {
    return (
      <View accessibilityLiveRegion="polite" style={styles.stateRow}>
        <ActivityIndicator color={colors.accent} size="small" />
        <Text style={styles.body}>{t('personalCardPhoto.policyLoading')}</Text>
      </View>
    );
  }

  if (state.status === 'error') {
    return (
      <View style={styles.acceptancePanel}>
        <Text accessibilityLiveRegion="assertive" style={styles.error}>
          {t('personalCardPhoto.policyLoadError')}
        </Text>
        <PolicyAction
          label={t('common.retry')}
          onPress={refresh}
        />
      </View>
    );
  }

  const allReviewed = reviewed.terms_of_use && reviewed.community_guidelines;
  return (
    <View style={styles.acceptancePanel}>
      <Text accessibilityRole="header" style={styles.title}>
        {t('personalCardPhoto.policyTitle')}
      </Text>
      <Text style={styles.body}>{t('personalCardPhoto.policyBody')}</Text>
      {state.policies.map((policy) => {
        const document = policy.documents[locale];
        const checked = reviewed[policy.type];
        return (
          <View key={policy.type} style={styles.policyCard}>
            <Text style={styles.policyTitle}>{t(POLICY_LABEL_KEYS[policy.type])}</Text>
            <Text selectable style={styles.detail}>
              {t('personalCardPhoto.policyVersion')}: {policy.version}
            </Text>
            <Text selectable style={styles.detail}>
              {t('personalCardPhoto.policyHash')}: {document.sha256}
            </Text>
            <Text selectable style={styles.url}>
              {t('personalCardPhoto.policyUrl')}: {document.url}
            </Text>
            <PolicyAction
              disabled={submitting}
              label={t('personalCardPhoto.policyOpen')}
              onPress={() => policySupport.openPolicy(policy.type)}
            />
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked, disabled: submitting }}
              disabled={submitting}
              onPress={() => setReviewed((current) => ({
                ...current,
                [policy.type]: !current[policy.type],
              }))}
              style={({ pressed }) => [
                styles.checkboxRow,
                pressed && !submitting ? styles.pressed : null,
              ]}
            >
              <View style={[styles.checkbox, checked ? styles.checkboxChecked : null]}>
                <Text style={styles.checkmark}>{checked ? '✓' : ''}</Text>
              </View>
              <Text style={styles.checkboxLabel}>
                {t('personalCardPhoto.policyCheckbox')}
              </Text>
            </Pressable>
          </View>
        );
      })}
      <PolicyAction
        disabled={!allReviewed || submitting}
        label={t('personalCardPhoto.policyAccept')}
        onPress={() => void accept()}
      />
      {actionFailed ? (
        <Text accessibilityLiveRegion="assertive" style={styles.error}>
          {t('personalCardPhoto.policyActionError')}
        </Text>
      ) : null}
    </View>
  );
}

function PolicyAction(input: {
  disabled?: boolean;
  label: string;
  onPress(): void;
}) {
  const disabled = input.disabled ?? false;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={input.onPress}
      style={({ pressed }) => [
        styles.action,
        disabled ? styles.disabled : null,
        pressed && !disabled ? styles.pressed : null,
      ]}
    >
      <Text style={styles.actionLabel}>{input.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  acceptancePanel: {
    gap: spacing.sm,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.sm,
    backgroundColor: colors.accentSoft,
  },
  title: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  body: {
    color: colors.mutedInk,
    fontSize: 12,
    lineHeight: 18,
  },
  stateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  policyCard: {
    gap: spacing.xs,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.white,
  },
  policyTitle: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '800',
  },
  detail: {
    color: colors.mutedInk,
    fontSize: 10,
    lineHeight: 15,
  },
  url: {
    color: colors.accent,
    fontSize: 10,
    lineHeight: 15,
  },
  action: {
    minHeight: 44,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.pill,
  },
  actionLabel: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '700',
  },
  checkboxRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  checkbox: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 4,
    backgroundColor: colors.white,
  },
  checkboxChecked: {
    backgroundColor: colors.accent,
  },
  checkmark: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '800',
  },
  checkboxLabel: {
    flex: 1,
    color: colors.ink,
    fontSize: 12,
    lineHeight: 18,
  },
  error: {
    color: colors.stamp,
    fontSize: 12,
    lineHeight: 18,
  },
  disabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.68,
  },
});
