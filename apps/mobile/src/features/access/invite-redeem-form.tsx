import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { redeemParticipantInvite } from '@/api/participants-client';
import { formatRateLimitRetryAfter } from '@/features/rate-limit';
import { runGenerationBoundOperation } from '@/features/session-data/generation-bound-operation';
import { useSessionDataRefresh } from '@/features/session-data/refresh-provider';
import { useI18n } from '@/i18n/locale-provider';
import { colors, radius, spacing } from '@/theme/tokens';

import { inviteFailure, type InviteFailure } from './invite-presentation';

type InviteState = 'idle' | 'submitting' | 'success' | InviteFailure;

export function InviteRedeemForm() {
  const { locale, t } = useI18n();
  const {
    generation,
    isGenerationCurrent,
    refreshAccess,
  } = useSessionDataRefresh();
  const [code, setCode] = useState('');
  const [state, setState] = useState<InviteState>('idle');
  const [retryAfter, setRetryAfter] = useState<string | null>(null);
  const submitting = state === 'submitting';

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') {
        setCode('');
      }
    });
    return () => subscription.remove();
  }, []);

  let statusMessage: string | null = null;
  switch (state) {
    case 'success':
      statusMessage = t('settings.inviteSuccess');
      break;
    case 'invalid':
      statusMessage = t('settings.inviteInvalid');
      break;
    case 'not_found':
      statusMessage = t('settings.inviteNotFound');
      break;
    case 'rate_limited':
      statusMessage = t('settings.inviteRateLimited');
      break;
    case 'session':
      statusMessage = t('common.sessionBody');
      break;
    case 'forbidden':
      statusMessage = t('settings.inviteForbidden');
      break;
    case 'uncertain':
      statusMessage = t('settings.inviteUncertain');
      break;
    case 'error':
      statusMessage = t('settings.inviteError');
      break;
  }

  const submit = async () => {
    if (submitting) {
      return;
    }
    setState('submitting');
    setRetryAfter(null);
    const generationAtStart = generation;
    try {
      const outcome = await runGenerationBoundOperation({
        generation: generationAtStart,
        isGenerationCurrent,
        work: () => redeemParticipantInvite(code),
      });
      if (outcome.status === 'stale') {
        return;
      }
      setCode('');
      setState('success');
      refreshAccess();
    } catch (error) {
      if (!isGenerationCurrent(generationAtStart)) {
        return;
      }
      const failure = inviteFailure(error);
      setState(failure);
      setRetryAfter(formatRateLimitRetryAfter(error, locale, {
        seconds: t('settings.retryAfterSeconds'),
        minutes: t('settings.retryAfterMinutes'),
      }));
      if (failure === 'uncertain') {
        refreshAccess();
      }
    }
  };

  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.title}>
        {t('settings.inviteTitle')}
      </Text>
      <Text style={styles.body}>{t('settings.inviteBody')}</Text>
      <Text style={styles.label}>{t('settings.inviteLabel')}</Text>
      <TextInput
        accessibilityLabel={t('settings.inviteLabel')}
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect={false}
        editable={!submitting}
        importantForAutofill="noExcludeDescendants"
        maxLength={22}
        onChangeText={(value) => {
          setCode(value);
          if (state !== 'idle' && state !== 'submitting') {
            setState('idle');
            setRetryAfter(null);
          }
        }}
        onSubmitEditing={() => void submit()}
        placeholder={t('settings.invitePlaceholder')}
        placeholderTextColor={colors.mutedInk}
        returnKeyType="done"
        secureTextEntry
        style={styles.input}
        textContentType="none"
        value={code}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ busy: submitting, disabled: submitting }}
        disabled={submitting}
        onPress={() => void submit()}
        style={({ pressed }) => [
          styles.button,
          pressed && !submitting ? styles.pressed : null,
          submitting ? styles.disabled : null,
        ]}
      >
        {submitting ? <ActivityIndicator color={colors.white} size="small" /> : null}
        <Text style={styles.buttonLabel}>
          {t(submitting ? 'settings.inviteSubmitting' : 'settings.inviteSubmit')}
        </Text>
      </Pressable>
      {statusMessage === null ? null : (
        <Text
          accessibilityLiveRegion="polite"
          style={state === 'success' ? styles.success : styles.error}
        >
          {statusMessage}
        </Text>
      )}
      {retryAfter === null ? null : (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {retryAfter}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: spacing.lg,
    paddingTop: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  title: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '700',
  },
  body: {
    marginTop: spacing.xs,
    color: colors.mutedInk,
    fontSize: 13,
    lineHeight: 20,
  },
  label: {
    marginTop: spacing.md,
    marginBottom: spacing.xs,
    color: colors.ink,
    fontSize: 13,
    fontWeight: '700',
  },
  input: {
    minHeight: 48,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.paper,
    color: colors.ink,
    fontSize: 16,
    letterSpacing: 0.4,
  },
  button: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
  },
  pressed: {
    opacity: 0.76,
  },
  disabled: {
    opacity: 0.62,
  },
  buttonLabel: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '700',
  },
  success: {
    marginTop: spacing.md,
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
});
