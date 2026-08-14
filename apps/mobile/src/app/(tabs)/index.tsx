import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { BrandMark } from '@/components/brand-mark';
import { ReadFailurePanel } from '@/components/read-failure-panel';
import { ReadStatePanel } from '@/components/read-state-panel';
import { Screen } from '@/components/screen';
import { SpotListItem } from '@/components/spot-list-item';
import { useSpots } from '@/features/read/use-spots';
import { useI18n } from '@/i18n/locale-provider';
import { colors, radius, spacing } from '@/theme/tokens';

export default function JourneyScreen() {
  const { locale, t } = useI18n();
  const { state, retry } = useSpots(locale);

  return (
    <Screen>
      <BrandMark />

      <View style={styles.hero}>
        <Text style={styles.kicker}>{t('home.kicker')}</Text>
        <Text accessibilityRole="header" style={styles.title}>
          {t('home.title')}
        </Text>
        <Text style={styles.body}>{t('home.body')}</Text>
      </View>

      <View accessibilityRole="text" style={styles.locationBadge}>
        <View style={styles.locationDot} />
        <Text style={styles.locationText}>{t('home.locationBadge')}</Text>
      </View>

      <View style={styles.sectionHeading}>
        <Text accessibilityRole="header" style={styles.sectionTitle}>
          {t('home.spotsTitle')}
        </Text>
        <Text style={styles.sectionBody}>{t('home.spotsBody')}</Text>
      </View>

      {state.status === 'loading' ? (
        <ReadStatePanel
          body={t('home.spotsBody')}
          loading
          title={t('home.loadingSpots')}
        />
      ) : state.status === 'error' ? (
        <ReadFailurePanel error={state.error} onRetry={retry} />
      ) : state.snapshot.spots.length === 0 ? (
        <ReadStatePanel
          body={t('home.emptyBody')}
          title={t('home.emptyTitle')}
        />
      ) : (
        <View style={styles.spotList}>
          {state.snapshot.spots.map((spot) => (
            <SpotListItem
              key={spot.id}
              onPress={() => router.push({ pathname: '/spot/[id]', params: { id: spot.id } })}
              spot={spot}
            />
          ))}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: {
    gap: spacing.md,
    paddingTop: spacing.xxl,
    paddingBottom: spacing.lg,
  },
  kicker: {
    color: colors.stamp,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.6,
  },
  title: {
    maxWidth: 560,
    color: colors.ink,
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: -1,
    lineHeight: 43,
  },
  body: {
    maxWidth: 560,
    color: colors.mutedInk,
    fontSize: 16,
    lineHeight: 25,
  },
  locationBadge: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.lg,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.accentSoft,
  },
  locationDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  locationText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '700',
  },
  sectionHeading: {
    gap: spacing.sm,
    paddingBottom: spacing.md,
  },
  sectionTitle: {
    color: colors.ink,
    fontSize: 22,
    fontWeight: '800',
  },
  sectionBody: {
    maxWidth: 560,
    color: colors.mutedInk,
    fontSize: 14,
    lineHeight: 21,
  },
  spotList: {
    gap: spacing.md,
  },
});
