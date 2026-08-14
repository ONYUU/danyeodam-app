import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { ApiResponseError, ApiTransportError } from '@/api';
import { useAuth } from '@/auth/auth-provider';
import { requestEmailLink } from '@/auth/email-link-runtime';
import { EmailLinkStartError } from '@/auth/email-link';
import { canShowReviewerSensitiveActions } from '@/features/access/reviewer-sensitive-actions';
import { useAccess } from '@/features/access/use-access';
import { useI18n } from '@/i18n/locale-provider';
import { colors, radius, spacing } from '@/theme/tokens';

type RequestState =
  | 'idle'
  | 'submitting'
  | 'sent'
  | 'uncertain'
  | 'invalid'
  | 'conflict'
  | 'rate'
  | 'error';

function requestFailure(error: unknown): RequestState {
  if (error instanceof EmailLinkStartError && error.reason === 'INVALID_EMAIL') {
    return 'invalid';
  }
  if (error instanceof ApiResponseError && error.code === 'EMAIL_ALREADY_IN_USE') {
    return 'conflict';
  }
  if (error instanceof ApiResponseError && error.code === 'RATE_LIMITED') {
    return 'rate';
  }
  if (error instanceof ApiTransportError) {
    return 'uncertain';
  }
  return 'error';
}

export function EmailLinkPanel() {
  const { session } = useAuth();
  const { state: accessState } = useAccess();
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [requestState, setRequestState] = useState<RequestState>('idle');
  const isSubmitting = requestState === 'submitting';

  const statusMessage = useMemo(() => {
    switch (requestState) {
      case 'sent':
        return t('settings.emailSent');
      case 'invalid':
        return t('settings.emailInvalid');
      case 'uncertain':
        return t('settings.emailUncertain');
      case 'conflict':
        return t('settings.emailInUse');
      case 'rate':
        return t('settings.emailRateLimited');
      case 'error':
        return t('settings.emailError');
      default:
        return null;
    }
  }, [requestState, t]);

  if (session === null || !canShowReviewerSensitiveActions(
    accessState.status === 'ready' ? accessState.access : null,
  )) {
    return null;
  }

  const isAnonymous = session.user.is_anonymous === true;
  if (!isAnonymous) {
    return (
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t('settings.emailTitle')}</Text>
        <Text accessibilityLiveRegion="polite" style={styles.body}>
          {t('settings.emailLinked')}
        </Text>
      </View>
    );
  }

  const submit = async () => {
    if (isSubmitting) {
      return;
    }
    setRequestState('submitting');
    try {
      await requestEmailLink(email);
      setRequestState('sent');
    } catch (error) {
      setRequestState(requestFailure(error));
    }
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{t('settings.emailTitle')}</Text>
      <Text style={styles.body}>{t('settings.emailBody')}</Text>
      <Text style={styles.label}>{t('settings.emailLabel')}</Text>
      <TextInput
        accessibilityLabel={t('settings.emailLabel')}
        autoCapitalize="none"
        autoComplete="email"
        autoCorrect={false}
        editable={!isSubmitting}
        keyboardType="email-address"
        maxLength={254}
        onChangeText={(value) => {
          setEmail(value);
          if (requestState !== 'idle' && requestState !== 'submitting') {
            setRequestState('idle');
          }
        }}
        onSubmitEditing={() => void submit()}
        placeholder={t('settings.emailPlaceholder')}
        placeholderTextColor={colors.mutedInk}
        returnKeyType="send"
        style={styles.input}
        textContentType="emailAddress"
        value={email}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ busy: isSubmitting, disabled: isSubmitting }}
        disabled={isSubmitting}
        onPress={() => void submit()}
        style={({ pressed }) => [
          styles.button,
          pressed && !isSubmitting && styles.buttonPressed,
          isSubmitting && styles.buttonDisabled,
        ]}
      >
        {isSubmitting ? (
          <ActivityIndicator color={colors.white} size="small" />
        ) : null}
        <Text style={styles.buttonLabel}>
          {isSubmitting ? t('settings.emailSubmitting') : t('settings.emailSubmit')}
        </Text>
      </Pressable>
      {statusMessage === null ? null : (
        <Text
          accessibilityLiveRegion="polite"
          style={requestState === 'sent' || requestState === 'uncertain'
            ? styles.success
            : styles.error}
        >
          {statusMessage}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: spacing.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.white,
  },
  sectionTitle: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '700',
  },
  body: {
    marginTop: spacing.sm,
    color: colors.mutedInk,
    fontSize: 14,
    lineHeight: 21,
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
  },
  button: {
    minHeight: 48,
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  buttonPressed: {
    opacity: 0.76,
  },
  buttonDisabled: {
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
    fontSize: 14,
    lineHeight: 21,
  },
  error: {
    marginTop: spacing.md,
    color: colors.stamp,
    fontSize: 14,
    lineHeight: 21,
  },
});
