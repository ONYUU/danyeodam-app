import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Spot } from '@/api/spots';
import { getLocalizedText } from '@/api/payload';
import { useI18n } from '@/i18n/locale-provider';
import { colors, radius, spacing } from '@/theme/tokens';

import { TravelCardFace } from './travel-card-face';

type SpotListItemProps = {
  spot: Spot;
  onPress: () => void;
};

export function SpotListItem({ spot, onPress }: SpotListItemProps) {
  const { locale, t } = useI18n();
  const spotName = getLocalizedText(spot.name, locale, t('common.untitled'));
  const regionName = getLocalizedText(spot.region.name, locale, t('common.untitled'));
  const status = t(spot.status === 'open' ? 'home.open' : 'home.teaser');
  const cardTitle = spot.card === null
    ? t('spot.cardHidden')
    : getLocalizedText(spot.card.title, locale, t('common.untitled'));

  return (
    <Pressable
      accessibilityHint={t('home.viewSpot')}
      accessibilityLabel={`${spotName}. ${regionName}. ${status}. ${cardTitle}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.container, pressed ? styles.pressed : null]}
    >
      <View style={styles.artwork}>
        <TravelCardFace
          colorHex={spot.card?.colorHex ?? colors.paperStrong}
          imageUrl={spot.card?.imageUrl ?? null}
          title={cardTitle}
          variant="compact"
        />
      </View>
      <View style={styles.copy}>
        <View style={[
          styles.status,
          spot.status === 'open' ? styles.statusOpen : styles.statusTeaser,
        ]}>
          <Text style={[
            styles.statusText,
            spot.status === 'open' ? styles.statusTextOpen : styles.statusTextTeaser,
          ]}>
            {status}
          </Text>
        </View>
        <Text numberOfLines={2} style={styles.name}>{spotName}</Text>
        <Text numberOfLines={1} style={styles.region}>{regionName}</Text>
        <Text numberOfLines={2} style={styles.cardTitle}>{cardTitle}</Text>
      </View>
      <Text accessible={false} style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    minHeight: 180,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.white,
    shadowColor: colors.shadow,
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 2,
  },
  pressed: {
    opacity: 0.76,
    transform: [{ scale: 0.995 }],
  },
  artwork: {
    width: 108,
  },
  copy: {
    flex: 1,
    alignItems: 'flex-start',
    gap: spacing.xs,
  },
  status: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  statusOpen: {
    backgroundColor: colors.accentSoft,
  },
  statusTeaser: {
    backgroundColor: colors.paperStrong,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '800',
  },
  statusTextOpen: {
    color: colors.accent,
  },
  statusTextTeaser: {
    color: colors.mutedInk,
  },
  name: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '800',
    lineHeight: 23,
  },
  region: {
    color: colors.mutedInk,
    fontSize: 12,
  },
  cardTitle: {
    color: colors.stamp,
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
  chevron: {
    color: colors.mutedInk,
    fontSize: 28,
    fontWeight: '300',
  },
});
