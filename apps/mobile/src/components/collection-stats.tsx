import { StyleSheet, Text, View } from 'react-native';

import type { CollectionStats as Stats } from '@/api/collection';
import { useI18n } from '@/i18n/locale-provider';
import { colors, radius, spacing } from '@/theme/tokens';

type CollectionStatsProps = {
  stats: Stats;
};

export function CollectionStats({ stats }: CollectionStatsProps) {
  const { t } = useI18n();
  const values = [
    [t('collection.stats.total'), stats.totalAcquisitions],
    [t('collection.stats.spots'), stats.spotsVisited],
    [t('collection.stats.personal'), stats.personalCards],
  ] as const;

  return (
    <View accessibilityRole="summary" style={styles.container}>
      {values.map(([label, value]) => (
        <View accessibilityLabel={`${label}: ${value}`} accessible key={label} style={styles.item}>
          <Text style={styles.value}>{value}</Text>
          <Text numberOfLines={2} style={styles.label}>{label}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingBottom: spacing.lg,
  },
  item: {
    flex: 1,
    minHeight: 82,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.white,
  },
  value: {
    color: colors.ink,
    fontSize: 22,
    fontWeight: '800',
  },
  label: {
    color: colors.mutedInk,
    fontSize: 11,
    lineHeight: 15,
    textAlign: 'center',
  },
});
