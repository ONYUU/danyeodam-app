import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { getLocalizedText } from '@/api/payload';
import { BrandMark } from '@/components/brand-mark';
import { ReadFailurePanel } from '@/components/read-failure-panel';
import { ReadStatePanel } from '@/components/read-state-panel';
import { Screen } from '@/components/screen';
import { TravelCardFace } from '@/components/travel-card-face';
import { AcquirePanel } from '@/features/acquire/acquire-panel';
import { useSpots } from '@/features/read/use-spots';
import { useSessionDataRefresh } from '@/features/session-data/refresh-provider';
import { useI18n } from '@/i18n/locale-provider';
import { colors, radius, spacing } from '@/theme/tokens';

function returnToJourney() {
  if (router.canGoBack()) {
    router.back();
    return;
  }
  router.replace('/');
}

export default function SpotDetailScreen() {
  const parameters = useLocalSearchParams<{ id?: string | string[] }>();
  const spotId = Array.isArray(parameters.id) ? parameters.id[0] : parameters.id;
  const { locale, t } = useI18n();
  const { generation } = useSessionDataRefresh();
  const { state, retry } = useSpots(locale);
  const spot = state.status === 'ready'
    ? state.snapshot.spots.find(({ id }) => id === spotId)
    : undefined;
  const spotName = spot === undefined
    ? ''
    : getLocalizedText(spot.name, locale, t('common.untitled'));
  const regionName = spot === undefined
    ? ''
    : getLocalizedText(spot.region.name, locale, t('common.untitled'));
  const cardTitle = spot === undefined || spot.card === null
    ? t('spot.cardHidden')
    : getLocalizedText(spot.card.title, locale, t('common.untitled'));

  return (
    <Screen>
      <Pressable
        accessibilityRole="button"
        hitSlop={8}
        onPress={returnToJourney}
        style={({ pressed }) => [styles.back, pressed ? styles.pressed : null]}
      >
        <Text style={styles.backLabel}>‹ {t('common.back')}</Text>
      </Pressable>
      <BrandMark />

      {state.status === 'loading' ? (
        <View style={styles.state}>
          <ReadStatePanel
            body={t('home.spotsBody')}
            loading
            title={t('home.loadingSpots')}
          />
        </View>
      ) : state.status === 'error' ? (
        <View style={styles.state}>
          <ReadFailurePanel error={state.error} onRetry={retry} />
        </View>
      ) : spot === undefined ? (
        <View style={styles.state}>
          <ReadStatePanel
            actionLabel={t('spot.backToJourney')}
            body={t('spot.notFoundBody')}
            onAction={returnToJourney}
            title={t('spot.notFoundTitle')}
          />
        </View>
      ) : (
        <View style={styles.content}>
          <View style={styles.heading}>
            <View style={[
              styles.status,
              spot.status === 'open' ? styles.statusOpen : styles.statusTeaser,
            ]}>
              <Text style={[
                styles.statusLabel,
                spot.status === 'open' ? styles.statusLabelOpen : styles.statusLabelTeaser,
              ]}>
                {t(spot.status === 'open' ? 'home.open' : 'home.teaser')}
              </Text>
            </View>
            <Text accessibilityRole="header" style={styles.title}>
              {spotName}
            </Text>
            <Text style={styles.region}>{regionName}</Text>
          </View>

          <View style={styles.cardStage}>
            <Text style={styles.cardEyebrow}>
              {t(spot.card === null ? 'spot.cardHidden' : 'spot.cardAvailable')}
            </Text>
            <View
              accessible
              accessibilityLabel={`${cardTitle}. PLACE.`}
              accessibilityRole="image"
              style={styles.cardFace}
            >
              <TravelCardFace
                colorHex={spot.card?.colorHex ?? colors.paperStrong}
                imageUrl={spot.card?.imageUrl ?? null}
                title={cardTitle}
                variant="hero"
              />
            </View>
          </View>

          <View style={styles.notice}>
            <Text style={styles.noticeBody}>
              {t(spot.status === 'open' ? 'spot.openBody' : 'spot.teaserBody')}
            </Text>
          </View>
          {spot.status === 'open' && spot.card !== null ? (
            <AcquirePanel key={generation.id} spotId={spot.id} />
          ) : null}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  back: {
    minHeight: 44,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  pressed: {
    opacity: 0.65,
  },
  backLabel: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '700',
  },
  state: {
    paddingTop: spacing.xl,
  },
  content: {
    gap: spacing.lg,
    paddingTop: spacing.xl,
  },
  heading: {
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  status: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
  },
  statusOpen: {
    backgroundColor: colors.accentSoft,
  },
  statusTeaser: {
    backgroundColor: colors.paperStrong,
  },
  statusLabel: {
    fontSize: 11,
    fontWeight: '800',
  },
  statusLabelOpen: {
    color: colors.accent,
  },
  statusLabelTeaser: {
    color: colors.mutedInk,
  },
  title: {
    color: colors.ink,
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: -0.8,
    lineHeight: 40,
  },
  region: {
    color: colors.mutedInk,
    fontSize: 14,
  },
  cardStage: {
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
  },
  cardEyebrow: {
    alignSelf: 'center',
    marginBottom: spacing.sm,
    color: colors.stamp,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.3,
  },
  cardFace: {
    width: '100%',
    maxWidth: 420,
  },
  notice: {
    padding: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
  },
  noticeBody: {
    color: colors.accent,
    fontSize: 14,
    lineHeight: 22,
  },
});
