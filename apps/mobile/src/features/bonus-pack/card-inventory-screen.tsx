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

import type { InventoryItem } from '@/api/card-inventory';
import { getLocalizedText } from '@/api/payload';
import { useAuth } from '@/auth/auth-provider';
import { ReadFailurePanel } from '@/components/read-failure-panel';
import { ReadStatePanel } from '@/components/read-state-panel';
import { SpecialCardFace } from '@/components/special-card-face';
import { TravelCardFace } from '@/components/travel-card-face';
import { useI18n } from '@/i18n/locale-provider';
import { colors, radius, spacing } from '@/theme/tokens';

import { useCardInventory } from './use-card-inventory';

export function CardInventoryScreen() {
  const auth = useAuth();
  const { locale, t } = useI18n();
  const { state, retry, loadMore } = useCardInventory({
    locale,
    enabled: auth.status === 'ready',
    sessionKey: auth.session?.user.id ?? null,
  });
  const items = state.status === 'ready' ? state.items : [];

  let emptyContent: ReactNode;
  if (auth.status === 'loading' || (auth.status === 'ready' && state.status === 'loading')) {
    emptyContent = (
      <ReadStatePanel body={t('inventory.body')} loading title={t('inventory.loading')} />
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
      <ReadFailurePanel error={state.error} onRestoreSession={auth.retry} onRetry={retry} />
    );
  } else {
    emptyContent = <ReadStatePanel body={t('inventory.body')} title={t('inventory.empty')} />;
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

  const renderItem = ({ item }: ListRenderItemInfo<InventoryItem>) => {
    const title = getLocalizedText(item.card.title, locale, t('common.untitled'));
    const special = item.card.rarity === 'special';
    const rarity = t(special ? 'bonusPack.raritySpecial' : 'bonusPack.rarityCommon');
    return (
      <View
        accessible
        accessibilityLabel={`${rarity}. ${title}. ${t('inventory.quantity')} ${item.quantity}.`}
        style={styles.item}
      >
        <View style={styles.cardThumb}>
          {special ? (
            <SpecialCardFace
              artPendingLabel={t('bonusPack.artPending')}
              colorHex={item.card.colorHex}
              imageAuthorization={auth.session?.access_token ?? null}
              imageUrl={item.card.imageUrl}
              imageRequestVersion={auth.session?.expires_at ?? 0}
            />
          ) : (
            <TravelCardFace
              acquired
              colorHex={item.card.colorHex}
              imageUrl={item.card.imageUrl}
              title={title}
              variant="compact"
            />
          )}
        </View>
        <View style={styles.itemCopy}>
          <Text style={[styles.rarity, special ? styles.specialRarity : null]}>
            {special ? '✦ ' : '● '}{rarity}
          </Text>
          <Text numberOfLines={2} style={styles.itemTitle}>{title}</Text>
          <Text style={styles.quantity}>{t('inventory.quantity')} ×{item.quantity}</Text>
        </View>
      </View>
    );
  };

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
            <Text accessibilityRole="header" style={styles.title}>{t('inventory.title')}</Text>
            <Text style={styles.body}>{t('inventory.body')}</Text>
          </View>
        )}
        contentContainerStyle={styles.content}
        data={items}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        keyExtractor={({ card }) => card.id}
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
  header: { gap: spacing.sm, paddingBottom: spacing.xl },
  back: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center' },
  backLabel: { color: colors.accent, fontSize: 14, fontWeight: '800' },
  title: { color: colors.ink, fontSize: 30, fontWeight: '900', letterSpacing: -0.8 },
  body: { color: colors.mutedInk, fontSize: 14, lineHeight: 22 },
  item: {
    minHeight: 170,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.white,
  },
  cardThumb: { width: 106 },
  itemCopy: { flex: 1, gap: spacing.sm },
  rarity: { color: colors.accent, fontSize: 11, fontWeight: '900', letterSpacing: 0.6 },
  specialRarity: { color: '#73572E' },
  itemTitle: { color: colors.ink, fontSize: 18, fontWeight: '900', lineHeight: 23 },
  quantity: { color: colors.stamp, fontSize: 14, fontWeight: '900' },
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
