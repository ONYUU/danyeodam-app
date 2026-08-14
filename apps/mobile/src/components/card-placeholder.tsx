import { StyleSheet, Text, View } from 'react-native';

import { useI18n } from '@/i18n/locale-provider';
import { colors, radius, spacing } from '@/theme/tokens';

export function CardPlaceholder() {
  const { t } = useI18n();

  return (
    <View accessibilityLabel={t('home.cardTitle')} style={styles.frame}>
      <View style={styles.artwork}>
        <View style={styles.sun} />
        <View style={[styles.hill, styles.hillBack]} />
        <View style={[styles.hill, styles.hillFront]} />
        <View style={styles.route} />
        <View style={styles.spot} />
      </View>
      <View style={styles.caption}>
        <View style={styles.captionCopy}>
          <Text style={styles.cardTitle}>{t('home.cardTitle')}</Text>
          <Text style={styles.cardBody}>{t('home.cardBody')}</Text>
        </View>
        <View
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.stamp}
        >
          <Text style={styles.stampText}>
            D
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.white,
    shadowColor: colors.shadow,
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 4,
  },
  artwork: {
    height: 230,
    overflow: 'hidden',
    backgroundColor: '#E9E4D7',
  },
  sun: {
    position: 'absolute',
    top: 36,
    right: 44,
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: '#DCA56E',
  },
  hill: {
    position: 'absolute',
    width: 420,
    height: 240,
    borderRadius: 210,
  },
  hillBack: {
    left: -170,
    bottom: -134,
    backgroundColor: '#B8C5B0',
    transform: [{ rotate: '-8deg' }],
  },
  hillFront: {
    right: -165,
    bottom: -150,
    backgroundColor: '#6E8D78',
    transform: [{ rotate: '9deg' }],
  },
  route: {
    position: 'absolute',
    left: '48%',
    bottom: -18,
    width: 16,
    height: 150,
    borderRadius: radius.pill,
    backgroundColor: '#F4E8CF',
    transform: [{ rotate: '12deg' }],
  },
  spot: {
    position: 'absolute',
    left: '49%',
    top: 98,
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 4,
    borderColor: colors.white,
    backgroundColor: colors.stamp,
  },
  caption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  captionCopy: {
    flex: 1,
    gap: spacing.xs,
  },
  cardTitle: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '700',
  },
  cardBody: {
    color: colors.mutedInk,
    fontSize: 13,
    lineHeight: 19,
  },
  stamp: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.stamp,
    borderRadius: 22,
    transform: [{ rotate: '-8deg' }],
  },
  stampText: {
    color: colors.stamp,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
});
