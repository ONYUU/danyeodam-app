import { useRouter } from 'expo-router';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { blockPublicShareOwner } from '@/api/blocks-client';
import { ApiResponseError } from '@/api/client';
import { BrandMark } from '@/components/brand-mark';
import { Screen } from '@/components/screen';
import {
  mutationAttemptFor,
  shouldRetainBlockMutationAttempt,
  type BlockMutationAttempt,
} from '@/features/blocks/mutation-attempt';
import { useI18n } from '@/i18n/locale-provider';
import { createClientRequestId } from '@/platform/client-request-id';
import { colors, radius, spacing } from '@/theme/tokens';
import {
  acknowledgeShareBlockIngress,
  peekShareBlockIngress,
} from './secret-ingress';

type ScreenState =
  | Readonly<{ status: 'invalid' }>
  | Readonly<{ status: 'confirm'; shareSecret: string }>
  | Readonly<{
      status: 'working';
      shareSecret: string;
      attempt: BlockMutationAttempt;
    }>
  | Readonly<{
      status: 'error';
      shareSecret: string | null;
      attempt: BlockMutationAttempt | null;
      reason: 'rate_limited' | 'unavailable' | 'generic';
    }>
  | Readonly<{ status: 'success' }>;

export function PublicShareBlockScreen() {
  const router = useRouter();
  const { t } = useI18n();
  const [ingress] = useState(peekShareBlockIngress);
  const [state, setState] = useState<ScreenState>(() => {
    return ingress.status === 'ready'
      ? { status: 'confirm', shareSecret: ingress.shareSecret }
      : { status: 'invalid' };
  });
  const controllerRef = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    acknowledgeShareBlockIngress(ingress);
  }, [ingress]);
  useEffect(() => () => controllerRef.current?.abort(), []);

  const runBlock = (shareSecret: string, attempt: BlockMutationAttempt) => {
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setState({ status: 'working', shareSecret, attempt });
    void blockPublicShareOwner({
      shareSecret,
      clientActionId: attempt.clientActionId,
      signal: controller.signal,
    }).then(() => {
      if (!controller.signal.aborted) setState({ status: 'success' });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const retain = shouldRetainBlockMutationAttempt(error);
      const reason = error instanceof ApiResponseError && error.code === 'RATE_LIMITED'
        ? 'rate_limited'
        : error instanceof ApiResponseError
          && (error.code === 'NOT_FOUND' || error.code === 'VALIDATION_FAILED')
          ? 'unavailable'
          : 'generic';
      setState({
        status: 'error',
        shareSecret: retain ? shareSecret : null,
        attempt: retain ? attempt : null,
        reason,
      });
    });
  };

  const begin = (shareSecret: string) => {
    runBlock(shareSecret, mutationAttemptFor({
      previous: null,
      subjectId: shareSecret,
      createClientActionId: createClientRequestId,
    }));
  };

  const close = () => router.replace('/(tabs)/settings');

  return (
    <Screen contentStyle={styles.content}>
      <BrandMark />
      <View style={styles.panel}>
        {state.status === 'working' ? (
          <ActivityIndicator
            accessibilityLabel={t('shareBlock.working')}
            color={colors.accent}
            size="large"
          />
        ) : null}
        <Text accessibilityRole="header" style={styles.title}>
          {state.status === 'success'
            ? t('shareBlock.successTitle')
            : state.status === 'invalid'
              ? t('shareBlock.invalidTitle')
              : state.status === 'error'
                ? t('shareBlock.errorTitle')
                : t('shareBlock.title')}
        </Text>
        <Text accessibilityLiveRegion="polite" style={styles.body}>
          {state.status === 'success'
            ? t('shareBlock.successBody')
            : state.status === 'invalid'
              ? t('shareBlock.invalidBody')
              : state.status === 'error'
                ? state.reason === 'rate_limited'
                  ? t('shareBlock.rateLimited')
                  : state.reason === 'unavailable'
                    ? t('shareBlock.unavailable')
                    : state.attempt === null
                      ? t('shareBlock.unavailable')
                      : t('shareBlock.errorBody')
                : t('shareBlock.body')}
        </Text>

        {state.status === 'confirm' ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => begin(state.shareSecret)}
            style={({ pressed }) => [styles.destructiveButton, pressed ? styles.pressed : null]}
          >
            <Text style={styles.destructiveLabel}>{t('shareBlock.confirm')}</Text>
          </Pressable>
        ) : null}
        {state.status === 'error'
          && state.attempt !== null
          && state.shareSecret !== null ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                if (state.shareSecret !== null && state.attempt !== null) {
                  runBlock(state.shareSecret, state.attempt);
                }
              }}
              style={({ pressed }) => [styles.button, pressed ? styles.pressed : null]}
            >
              <Text style={styles.buttonLabel}>{t('shareBlock.retrySameAction')}</Text>
            </Pressable>
          ) : null}
        {state.status !== 'working' ? (
          <Pressable
            accessibilityRole="button"
            onPress={close}
            style={({ pressed }) => [styles.secondaryButton, pressed ? styles.pressed : null]}
          >
            <Text style={styles.secondaryLabel}>
              {state.status === 'confirm' ? t('shareBlock.cancel') : t('shareBlock.close')}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { justifyContent: 'center' },
  panel: {
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xxl,
  },
  title: { color: colors.ink, fontSize: 26, fontWeight: '800', textAlign: 'center' },
  body: {
    maxWidth: 440,
    color: colors.mutedInk,
    fontSize: 15,
    lineHeight: 23,
    textAlign: 'center',
  },
  destructiveButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.pill,
    backgroundColor: colors.stamp,
  },
  destructiveLabel: { color: colors.white, fontSize: 15, fontWeight: '700' },
  button: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  buttonLabel: { color: colors.white, fontSize: 15, fontWeight: '700' },
  secondaryButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  secondaryLabel: { color: colors.accent, fontSize: 14, fontWeight: '700' },
  pressed: { opacity: 0.72 },
});
