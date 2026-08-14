import { StyleSheet, Text, View } from 'react-native';

import { useI18n } from '@/i18n/locale-provider';
import { colors, spacing } from '@/theme/tokens';

export function BrandMark() {
  const { t } = useI18n();

  return (
    <View accessibilityRole="header" style={styles.container}>
      <Text style={styles.name}>{t('brand.name')}</Text>
      <View style={styles.divider} />
      <Text style={styles.tagline}>{t('brand.tagline')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'flex-start',
  },
  name: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 1.6,
  },
  divider: {
    width: 28,
    height: 1,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
    backgroundColor: colors.stamp,
  },
  tagline: {
    color: colors.mutedInk,
    fontSize: 12,
    letterSpacing: 0.4,
  },
});
