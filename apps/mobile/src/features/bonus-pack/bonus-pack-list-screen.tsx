import { router } from 'expo-router';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  type ListRenderItemInfo,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { BonusPack } from '@/api/bonus-packs';
import { useAuth } from '@/auth/auth-provider';
import { BonusPackShell } from '@/components/bonus-pack-shell';
import { ReadFailurePanel } from '@/components/read-failure-panel';
import { ReadStatePanel } from '@/components/read-state-panel';
import { formatKstDate } from '@/features/read/presentation';
import { useI18n } from '@/i18n/locale-provider';
import { colors, radius, spacing } from '@/theme/tokens';

import { BonusPackRulesCard } from './bonus-pack-rules-card';
import { useBonusPacks } from './use-bonus-packs';

export function BonusPackListScreen() {
  const auth = useAuth();
  const { locale, t } = useI18n();
  const { state, retry, loadMore } = useBonusPacks({
    locale,
    enabled: auth.status === 'ready',
    sessionKey: auth.session?.user.id ?? null,
  });
  const items = state.status === 'ready' ? state.items : [];

  let emptyContent: ReactNode;
  if (auth.status === 'loading' || (auth.status === 'ready' && state.status === 'loading')) {
    emptyContent = (
      <ReadStatePanel
        body={t('bonusPack.listBody')}
        loading
        title={t('bonusPack.loading')}
      />
    );
  } else if (auth.status === 'error' || auth.status === 'signed_out') {
    emptyContent = (
      <ReadStatePanel
        actionLabel={t('common.restoreSession')}
        body={t('common.sessionBody')}
        onAction={auth.retry}
        title={t('common.sessionTitle')}
      />
    );
  } else if (state.status === 'error') {
    emptyContent = (
      <ReadFailurePanel
        error={state.error}
        onRestoreSession={auth.retry}
        onRetry={retry}
      />
    );
  } else {
    emptyContent = (
      <ReadStatePanel
        body={t('bonusPack.emptyBody')}
        title={t('bonusPack.emptyTitle')}
      />
    );
  }

  let footer: ReactNode = null;
  if (state.status === 'ready' && state.loadMoreError !== null) {
    footer = (
      <ReadFailurePanel
        error={state.loadMoreError}
        onRestoreSession={auth.retry}
        onRetry={loadMore}
      />
    );
  } else if (state.status === 'ready' && state.hasMore) {
    footer = (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ busy: state.loadingMore, disabled: state.loadingMore }}
        disabled={state.loadingMore}
        onPress={loadMore}
        style={({ pressed }) => [styles.loadMore, pressed ? styles.pressed : null]}
      >
        {state.loadingMore ? <ActivityIndicator color={colors.white} size="small" /> : null}
        <Text style={styles.loadMoreLabel}>
          {t(state.loadingMore ? 'common.loadingMore' : 'common.loadMore')}
        </Text>
      </Pressable>
    );
  }

  const renderItem = ({ item }: ListRenderItemInfo<BonusPack>) => (
    <Pressable
      accessibilityLabel={`${item.status === 'sealed' ? t('bonusPack.sealed') : t('bonusPack.opened')}. ${t('bonusPack.received')} ${formatKstDate(item.dateKst, locale)}.`}
      accessibilityRole="button"
      onPress={() => router.push({ pathname: '/bonus-packs/[id]', params: { id: item.id } })}
      style={({ pressed }) => [styles.item, pressed ? styles.pressed : null]}
    >
      <View style={styles.packThumb}>
        <BonusPackShell compact />
      </View>
      <View style={styles.itemCopy}>
        <Text style={styles.statusLabel}>
          {item.status === 'sealed' ? t('bonusPack.sealed') : t('bonusPack.opened')}
        </Text>
        <Text style={styles.date}>
          {t('bonusPack.received')} · {formatKstDate(item.dateKst, locale)}
        </Text>
        {item.status === 'opened' ? (
          <Text style={styles.rarity}>
            {t(item.card.rarity === 'special'
              ? 'bonusPack.raritySpecial'
              : 'bonusPack.rarityCommon')}
          </Text>
        ) : null}
        <Text style={styles.view}>{t('bonusPack.view')} →</Text>
      </View>
    </Pressable>
  );

  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      <FlatList
        ListEmptyComponent={<View style={styles.empty}>{emptyContent}</View>}
        ListFooterComponent={footer}
        ListHeaderComponent={(
          <View style={styles.header}>
            <Pressable
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => router.replace('/(tabs)/collection')}
              style={({ pressed }) => [styles.back, pressed ? styles.pressed : null]}
            >
              <Text style={styles.backLabel}>‹ {t('bonusPack.backToCards')}</Text>
            </Pressable>
            <Text accessibilityRole="header" style={styles.title}>
              {t('bonusPack.listTitle')}
            </Text>
            <Text style={styles.body}>{t('bonusPack.listBody')}</Text>
            <BonusPackRulesCard />
          </View>
        )}
        contentContainerStyle={styles.content}
        data={items}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        keyExtractor={({ id }) => id}
        renderItem={renderItem}
        showsVerticalScrollIndicator={false}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.paper },
  content: {
    flexGrow: 1,
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
  },
  header: { gap: spacing.md, paddingBottom: spacing.xl },
  back: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center' },
  backLabel: { color: colors.accent, fontSize: 14, fontWeight: '800' },
  title: { color: colors.ink, fontSize: 30, fontWeight: '900', letterSpacing: -0.8 },
  body: { color: colors.mutedInk, fontSize: 14, lineHeight: 22 },
  item: {
    minHeight: 156,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.white,
  },
  packThumb: { width: 92 },
  itemCopy: { flex: 1, gap: spacing.xs },
  statusLabel: { color: colors.ink, fontSize: 16, fontWeight: '900' },
  date: { color: colors.mutedInk, fontSize: 12, lineHeight: 18 },
  rarity: { color: colors.stamp, fontSize: 11, fontWeight: '900', letterSpacing: 0.5 },
  view: { marginTop: spacing.xs, color: colors.accent, fontSize: 12, fontWeight: '800' },
  empty: { paddingBottom: spacing.lg },
  separator: { height: spacing.md },
  loadMore: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  loadMoreLabel: { color: colors.white, fontSize: 14, fontWeight: '800' },
  pressed: { opacity: 0.72 },
});
