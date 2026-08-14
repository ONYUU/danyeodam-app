import { StyleSheet, Text, View } from 'react-native';

import type { CollectionItem } from '@/api/collection';
import { getLocalizedText } from '@/api/payload';
import { useI18n } from '@/i18n/locale-provider';
import { PersonalCardPhotoPanel } from '@/features/personal-card-photo/panel';
import { PersonalCardPhotoRecord } from '@/features/personal-card-photo/record';
import { acquisitionGlyph, formatKstDate } from '@/features/read/presentation';
import { colors, radius, spacing } from '@/theme/tokens';

import { TravelCardFace } from './travel-card-face';

type CollectionItemCardProps = {
  item: CollectionItem;
};

export function CollectionItemCard({ item }: CollectionItemCardProps) {
  const { locale, t } = useI18n();
  const title = getLocalizedText(item.card.title, locale, t('common.untitled'));
  const spotName = getLocalizedText(item.spot.name, locale, t('common.untitled'));
  const typeLabel = t(`collection.type.${item.acquisition.type}`);
  const date = formatKstDate(item.acquisition.dateKst, locale);
  const personalCardLabel = item.personalCard === null
    ? ''
    : ` ${t('collection.personalCardAttached')}`;

  return (
    <View style={styles.container}>
      <View
        accessibilityLabel={`${title}. ${spotName}. ${typeLabel}. ${date}.${personalCardLabel}`}
        accessible
        style={styles.summary}
      >
        <View style={styles.artwork}>
          <TravelCardFace
            acquired
            colorHex={item.card.colorHex}
            imageUrl={item.card.imageUrl}
            title={title}
            variant="compact"
          />
        </View>
        <View style={styles.copy}>
          <View style={styles.typeRow}>
            <Text accessible={false} style={styles.typeGlyph}>
              {acquisitionGlyph(item.acquisition.type)}
            </Text>
            <Text style={styles.typeLabel}>{typeLabel}</Text>
          </View>
          <Text numberOfLines={2} style={styles.title}>{title}</Text>
          <Text numberOfLines={1} style={styles.spot}>{spotName}</Text>
          <Text style={styles.date}>{date}</Text>
          {item.personalCard === null ? null : (
            <Text style={styles.personalCardLabel}>
              {t('collection.personalCardAttached')}
            </Text>
          )}
        </View>
      </View>
      {item.personalCard === null ? (
        <PersonalCardPhotoPanel acquisitionId={item.acquisition.id} />
      ) : (
        <PersonalCardPhotoRecord personalCard={item.personalCard} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.md,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.white,
  },
  summary: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  artwork: {
    width: 132,
  },
  copy: {
    flex: 1,
    gap: spacing.xs,
    paddingTop: spacing.xs,
  },
  typeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  typeGlyph: {
    color: colors.stamp,
    fontSize: 12,
  },
  typeLabel: {
    color: colors.stamp,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  title: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '800',
    lineHeight: 22,
  },
  spot: {
    color: colors.mutedInk,
    fontSize: 13,
  },
  date: {
    color: colors.mutedInk,
    fontSize: 12,
  },
  personalCardLabel: {
    marginTop: spacing.xs,
    color: colors.accent,
    fontSize: 11,
    fontWeight: '700',
  },
});
