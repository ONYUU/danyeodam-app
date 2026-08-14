import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { unblockUser } from '@/api/blocks-client';
import { ApiResponseError } from '@/api/client';
import { useAuth } from '@/auth/auth-provider';
import { BrandMark } from '@/components/brand-mark';
import { Screen } from '@/components/screen';
import { createClientRequestId } from '@/platform/client-request-id';
import { useI18n } from '@/i18n/locale-provider';
import { colors, radius, spacing } from '@/theme/tokens';
import {
  mutationAttemptFor,
  shouldRetainBlockMutationAttempt,
  type BlockMutationAttempt,
} from './mutation-attempt';
import { useUserBlocks } from './use-user-blocks';

type MutationState =
  | Readonly<{ status: 'idle' }>
  | Readonly<{ status: 'working'; attempt: BlockMutationAttempt }>
  | Readonly<{
      status: 'error';
      attempt: BlockMutationAttempt | null;
      rateLimited: boolean;
    }>;

export function BlockListScreen() {
  const auth = useAuth();
  const router = useRouter();
  const { locale, t } = useI18n();
  const sessionKey = auth.session?.user.id ?? 'missing-session';
  const { state, refresh, loadMore, remove } = useUserBlocks(sessionKey);
  const [mutation, setMutation] = useState<MutationState>({ status: 'idle' });
  const mutationController = useRef<AbortController | null>(null);
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }),
    [locale],
  );

  useEffect(() => () => mutationController.current?.abort(), []);

  const runUnblock = (attempt: BlockMutationAttempt) => {
    const controller = new AbortController();
    mutationController.current?.abort();
    mutationController.current = controller;
    setMutation({ status: 'working', attempt });
    void unblockUser({
      blockId: attempt.subjectId,
      clientActionId: attempt.clientActionId,
      signal: controller.signal,
    }).then(() => {
      if (controller.signal.aborted) return;
      remove(attempt.subjectId);
      setMutation({ status: 'idle' });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setMutation({
        status: 'error',
        attempt: shouldRetainBlockMutationAttempt(error) ? attempt : null,
        rateLimited: error instanceof ApiResponseError && error.code === 'RATE_LIMITED',
      });
    });
  };

  const beginUnblock = (blockId: string) => {
    const previous = mutation.status === 'error' ? mutation.attempt : null;
    runUnblock(mutationAttemptFor({
      previous,
      subjectId: blockId,
      createClientActionId: createClientRequestId,
    }));
  };

  return (
    <Screen>
      <BrandMark />
      <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}>
        <Text style={styles.backLabel}>{t('common.back')}</Text>
      </Pressable>
      <Text accessibilityRole="header" style={styles.title}>{t('blocks.listTitle')}</Text>
      <Text style={styles.body}>{t('blocks.listBody')}</Text>

      {state.status === 'loading' ? (
        <ActivityIndicator accessibilityLabel={t('common.loading')} color={colors.accent} />
      ) : null}
      {state.status === 'error' ? (
        <StatusPanel body={t('blocks.listError')} action={t('common.retry')} onPress={refresh} />
      ) : null}
      {state.status === 'ready' && state.items.length === 0 ? (
        <StatusPanel body={t('blocks.empty')} />
      ) : null}
      {state.status === 'ready' ? state.items.map((item) => {
        const working = mutation.status === 'working'
          && mutation.attempt.subjectId === item.id;
        return (
          <View key={item.id} style={styles.card}>
            <Text style={styles.cardTitle}>{t('blocks.opaqueAccount')}</Text>
            <Text style={styles.metadata}>
              {t('blocks.blockedAt')} {dateFormatter.format(new Date(item.createdAt))}
            </Text>
            <Text accessibilityLabel={`${t('blocks.opaqueId')} ${item.id}`} style={styles.opaqueId}>
              {t('blocks.opaqueId')} {item.id.slice(0, 8)}…
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: mutation.status !== 'idle' }}
              disabled={mutation.status !== 'idle'}
              onPress={() => beginUnblock(item.id)}
              style={({ pressed }) => [
                styles.secondaryButton,
                mutation.status !== 'idle' ? styles.disabled : null,
                pressed ? styles.pressed : null,
              ]}
            >
              <Text style={styles.secondaryButtonLabel}>
                {working ? t('blocks.unblocking') : t('blocks.unblock')}
              </Text>
            </Pressable>
          </View>
        );
      }) : null}

      {mutation.status === 'error' ? (
        <StatusPanel
          body={mutation.rateLimited ? t('blocks.rateLimited') : t('blocks.unblockError')}
          action={mutation.attempt === null ? t('common.refresh') : t('blocks.retrySameAction')}
          onPress={() => {
            if (mutation.attempt === null) {
              setMutation({ status: 'idle' });
              refresh();
            } else {
              runUnblock(mutation.attempt);
            }
          }}
        />
      ) : null}

      {state.status === 'ready' && state.nextCursor !== null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: state.loadingMore }}
          disabled={state.loadingMore}
          onPress={loadMore}
          style={({ pressed }) => [styles.button, pressed ? styles.pressed : null]}
        >
          <Text style={styles.buttonLabel}>
            {state.loadingMore ? t('common.loading') : t('blocks.loadMore')}
          </Text>
        </Pressable>
      ) : null}
      {state.status === 'ready' && state.loadMoreError !== null ? (
        <Text accessibilityLiveRegion="polite" style={styles.errorText}>
          {t('blocks.loadMoreError')}
        </Text>
      ) : null}
    </Screen>
  );
}

function StatusPanel({
  body,
  action,
  onPress,
}: {
  body: string;
  action?: string;
  onPress?(): void;
}) {
  return (
    <View style={styles.statusPanel}>
      <Text accessibilityLiveRegion="polite" style={styles.body}>{body}</Text>
      {action !== undefined && onPress !== undefined ? (
        <Pressable accessibilityRole="button" onPress={onPress} style={styles.button}>
          <Text style={styles.buttonLabel}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  back: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' },
  backLabel: { color: colors.accent, fontSize: 14, fontWeight: '700' },
  title: { marginTop: spacing.md, color: colors.ink, fontSize: 28, fontWeight: '800' },
  body: { marginTop: spacing.sm, color: colors.mutedInk, fontSize: 14, lineHeight: 22 },
  card: {
    gap: spacing.sm,
    marginTop: spacing.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.white,
  },
  cardTitle: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  metadata: { color: colors.mutedInk, fontSize: 13 },
  opaqueId: { color: colors.mutedInk, fontSize: 12 },
  statusPanel: {
    gap: spacing.md,
    marginTop: spacing.lg,
    padding: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
  },
  button: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  buttonLabel: { color: colors.white, fontSize: 14, fontWeight: '700' },
  secondaryButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.pill,
  },
  secondaryButtonLabel: { color: colors.accent, fontSize: 14, fontWeight: '700' },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.72 },
  errorText: { marginTop: spacing.sm, color: colors.stamp, fontSize: 13 },
});
