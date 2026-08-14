import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { signInStoreReviewer } from '@/auth/reviewer';
import { createReviewerProbeAuth } from '@/auth/reviewer-probe';
import { supabase } from '@/auth/supabase';
import { BrandMark } from '@/components/brand-mark';
import { Screen } from '@/components/screen';
import { getRuntimeEnvironment } from '@/config/runtime-environment';
import { policySupportCopy } from '@/features/policy-support/copy';
import { usePolicySupport } from '@/features/policy-support/provider';
import { useI18n } from '@/i18n/locale-provider';
import { colors, radius, spacing } from '@/theme/tokens';

type FormError = 'credentials' | 'access' | null;

export default function ReviewerLoginScreen() {
  const { locale, t } = useI18n();
  const policySupport = usePolicySupport();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<FormError>(null);

  const submit = async () => {
    if (submitting || email.trim() === '' || password === '') {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await signInStoreReviewer({
        email,
        password,
        apiBaseUrl: getRuntimeEnvironment().apiBaseUrl,
      }, {
        probeAuth: createReviewerProbeAuth(),
        primaryAuth: supabase.auth,
        fetch,
      });
      router.replace('/(tabs)/collection');
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message === 'REVIEWER_CREDENTIALS_INVALID'
          ? 'credentials'
          : 'access',
      );
    } finally {
      setPassword('');
      setSubmitting(false);
    }
  };

  const errorText = error === 'credentials'
    ? t('reviewer.invalid')
    : error === 'access'
      ? t('reviewer.accessError')
      : null;

  return (
    <Screen>
      <BrandMark />
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>{t('reviewer.title')}</Text>
        <Text style={styles.body}>{t('reviewer.body')}</Text>
      </View>

      <View style={styles.form}>
        <Text style={styles.label}>{t('reviewer.email')}</Text>
        <TextInput
          accessibilityLabel={t('reviewer.email')}
          autoCapitalize="none"
          autoComplete="email"
          editable={!submitting}
          inputMode="email"
          keyboardType="email-address"
          onChangeText={setEmail}
          returnKeyType="next"
          style={styles.input}
          textContentType="username"
          value={email}
        />

        <Text style={[styles.label, styles.passwordLabel]}>{t('reviewer.password')}</Text>
        <TextInput
          accessibilityLabel={t('reviewer.password')}
          autoCapitalize="none"
          autoComplete="current-password"
          editable={!submitting}
          onChangeText={setPassword}
          onSubmitEditing={() => void submit()}
          returnKeyType="go"
          secureTextEntry
          style={styles.input}
          textContentType="password"
          value={password}
        />

        {errorText ? (
          <Text accessibilityLiveRegion="assertive" style={styles.error}>{errorText}</Text>
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: submitting }}
          disabled={submitting}
          onPress={() => void submit()}
          style={({ pressed }) => [
            styles.button,
            submitting && styles.buttonDisabled,
            pressed && styles.buttonPressed,
          ]}
        >
          {submitting ? <ActivityIndicator color={colors.white} /> : null}
          <Text style={styles.buttonText}>
            {submitting ? t('reviewer.checking') : t('reviewer.submit')}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={policySupport.openHub}
          style={({ pressed }) => [
            styles.policyButton,
            pressed && styles.buttonPressed,
          ]}
        >
          <Text style={styles.policyButtonText}>
            {policySupportCopy(locale).entry}
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingTop: spacing.xxl,
    paddingBottom: spacing.xl,
  },
  title: {
    color: colors.ink,
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: -0.8,
  },
  body: {
    marginTop: spacing.sm,
    color: colors.mutedInk,
    fontSize: 15,
    lineHeight: 23,
  },
  form: {
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.white,
  },
  label: {
    marginBottom: spacing.sm,
    color: colors.ink,
    fontSize: 14,
    fontWeight: '700',
  },
  passwordLabel: {
    marginTop: spacing.md,
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
  error: {
    marginTop: spacing.md,
    color: colors.stamp,
    fontSize: 14,
    lineHeight: 21,
  },
  button: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  buttonDisabled: {
    opacity: 0.65,
  },
  buttonPressed: {
    opacity: 0.78,
  },
  buttonText: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
  },
  policyButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  policyButtonText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
});
