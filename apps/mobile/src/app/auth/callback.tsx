import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { completeEmailLinkCallback } from '@/auth/email-link-runtime';
import { createCallbackUrlGate } from '@/auth/callback-url-gate';
import { BrandMark } from '@/components/brand-mark';
import { Screen } from '@/components/screen';
import { useI18n } from '@/i18n/locale-provider';
import { colors, spacing } from '@/theme/tokens';

type CallbackStatus = 'working' | 'success' | 'error';

export default function AuthCallbackScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const linkingUrl = Linking.useLinkingURL();
  const [callbackUrlGate] = useState(createCallbackUrlGate);
  const [status, setStatus] = useState<CallbackStatus>('working');

  useEffect(() => {
    const callbackUrl = callbackUrlGate.take(linkingUrl);
    if (callbackUrl === null) {
      return;
    }
    let active = true;
    let redirectTimer: ReturnType<typeof setTimeout> | undefined;

    void (async () => {
      await completeEmailLinkCallback(callbackUrl);
      if (!active) {
        return;
      }
      setStatus('success');
      redirectTimer = setTimeout(() => router.replace('/(tabs)/settings'), 700);
    })().catch(() => {
      if (active) {
        setStatus('error');
      }
    });

    return () => {
      active = false;
      if (redirectTimer !== undefined) {
        clearTimeout(redirectTimer);
      }
    };
  }, [callbackUrlGate, linkingUrl, router]);

  const body = status === 'working'
    ? t('auth.callbackBody')
    : status === 'success'
      ? t('auth.callbackSuccess')
      : t('auth.callbackError');

  return (
    <Screen contentStyle={styles.content}>
      <BrandMark />
      <View style={styles.panel}>
        {status === 'working' ? (
          <ActivityIndicator accessibilityLabel={body} color={colors.accent} size="large" />
        ) : null}
        <Text accessibilityRole="header" style={styles.title}>
          {t('auth.callbackTitle')}
        </Text>
        <Text accessibilityLiveRegion="polite" style={styles.body}>
          {body}
        </Text>
        {status === 'error' ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.replace('/(tabs)/settings')}
            style={({ pressed }) => [styles.button, pressed ? styles.buttonPressed : null]}
          >
            <Text style={styles.buttonLabel}>{t('common.back')}</Text>
          </Pressable>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    justifyContent: 'center',
  },
  panel: {
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xxl,
  },
  title: {
    color: colors.ink,
    fontSize: 26,
    fontWeight: '800',
    textAlign: 'center',
  },
  body: {
    maxWidth: 420,
    color: colors.mutedInk,
    fontSize: 15,
    lineHeight: 23,
    textAlign: 'center',
  },
  button: {
    minHeight: 44,
    justifyContent: 'center',
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  buttonPressed: {
    opacity: 0.75,
  },
  buttonLabel: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '700',
  },
});
