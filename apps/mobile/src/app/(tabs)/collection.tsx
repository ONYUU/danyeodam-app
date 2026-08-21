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

import type { CollectionItem } from '@/api/collection';
import { useAuth } from '@/auth/auth-provider';
import { BrandMark } from '@/components/brand-mark';
import { CollectionItemCard } from '@/components/collection-item-card';
import { CollectionStats } from '@/components/collection-stats';
import { ReadFailurePanel } from '@/components/read-failure-panel';
import { ReadStatePanel } from '@/components/read-state-panel';
import { BonusPackEntryCard } from '@/features/bonus-pack/bonus-pack-entry-card';
import { InventoryEntryCard } from '@/features/bonus-pack/inventory-entry-card';
import { useCollection } from '@/features/read/use-collection';
import { useI18n } from '@/i18n/locale-provider';
import { colors, radius, spacing } from '@/theme/tokens';

function ItemSeparator() {
  return <View style={styles.separator} />;
}

function renderCollectionItem({ item }: ListRenderItemInfo<CollectionItem>) {
  return <CollectionItemCard item={item} />;
}

export default function CollectionScreen() {
  const { locale, t } = useI18n();
  const auth = useAuth();
  const { state, retry, loadMore } = useCollection({
    locale,
    enabled: auth.status === 'ready',
    sessionKey: auth.session?.user.id ?? null,
  });
  const items = state.status === 'ready' ? state.items : [];

  let emptyContent: ReactNode;
  if (auth.status === 'loading' || (auth.status === 'ready' && state.status === 'loading')) {
    emptyContent = (
      <ReadStatePanel
        body={t('collection.body')}
        loading
        title={t('collection.loading')}
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
  } else if (state.status === 'ready') {
    emptyContent = (
      <ReadStatePanel
        body={t('collection.emptyBody')}
        title={t('collection.emptyTitle')}
      />
    );
  } else {
    emptyContent = (
      <ReadStatePanel
        body={t('collection.body')}
        loading
        title={t('common.loading')}
      />
    );
  }

  let footer: ReactNode = null;
  if (state.status === 'ready' && state.loadMoreError !== null) {
    footer = (
      <View style={styles.footerPanel}>
        <ReadFailurePanel
          error={state.loadMoreError}
          onRestoreSession={auth.retry}
          onRetry={loadMore}
        />
      </View>
    );
  } else if (state.status === 'ready' && state.hasMore) {
    footer = (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ busy: state.loadingMore, disabled: state.loadingMore }}
        disabled={state.loadingMore}
        onPress={loadMore}
        style={({ pressed }) => [
          styles.loadMore,
          pressed ? styles.pressed : null,
          state.loadingMore ? styles.disabled : null,
        ]}
      >
        {state.loadingMore ? <ActivityIndicator color={colors.white} size="small" /> : null}
        <Text style={styles.loadMoreLabel}>
          {t(state.loadingMore ? 'common.loadingMore' : 'common.loadMore')}
        </Text>
      </Pressable>
    );
  }

  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      <FlatList
        ListEmptyComponent={<View style={styles.empty}>{emptyContent}</View>}
        ListFooterComponent={footer}
        ListHeaderComponent={(
          <View style={styles.header}>
            <BrandMark />
            <View style={styles.headingRow}>
              <View style={styles.headingCopy}>
                <Text accessibilityRole="header" style={styles.title}>
                  {t('collection.title')}
                </Text>
                <Text style={styles.body}>{t('collection.body')}</Text>
              </View>
              {state.status === 'ready' ? (
                <Pressable
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={retry}
                  style={({ pressed }) => [styles.refresh, pressed ? styles.pressed : null]}
                >
                  <Text style={styles.refreshLabel}>{t('common.refresh')}</Text>
                </Pressable>
              ) : null}
            </View>
            <BonusPackEntryCard />
            <InventoryEntryCard />
            {state.status === 'ready' ? <CollectionStats stats={state.stats} /> : null}
            <View style={styles.visitsHeading}>
              <Text accessibilityRole="header" style={styles.visitsTitle}>
                {t('collection.visitsTitle')}
              </Text>
              <Text style={styles.visitsBody}>{t('collection.visitsBody')}</Text>
            </View>
          </View>
        )}
        contentContainerStyle={styles.content}
        data={items}
        ItemSeparatorComponent={ItemSeparator}
        keyExtractor={({ acquisition }) => acquisition.id}
        renderItem={renderCollectionItem}
        showsVerticalScrollIndicator={false}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.paper,
  },
  content: {
    flexGrow: 1,
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
  },
  header: {
    gap: spacing.md,
  },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingTop: spacing.xxl,
    paddingBottom: spacing.sm,
  },
  headingCopy: {
    flex: 1,
    gap: spacing.sm,
  },
  title: {
    color: colors.ink,
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: -0.8,
  },
  body: {
    maxWidth: 560,
    color: colors.mutedInk,
    fontSize: 15,
    lineHeight: 23,
  },
  refresh: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  refreshLabel: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '700',
  },
  empty: {
    paddingBottom: spacing.lg,
  },
  separator: {
    height: spacing.md,
  },
  loadMore: {
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
  loadMoreLabel: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '700',
  },
  footerPanel: {
    marginTop: spacing.lg,
  },
  visitsHeading: {
    gap: spacing.xs,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
  },
  visitsTitle: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: '800',
  },
  visitsBody: {
    color: colors.mutedInk,
    fontSize: 13,
    lineHeight: 20,
  },
  pressed: {
    opacity: 0.72,
  },
  disabled: {
    opacity: 0.7,
  },
});
