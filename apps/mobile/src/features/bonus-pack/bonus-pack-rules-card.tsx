import { StyleSheet, Text, View } from 'react-native';

import { useI18n } from '@/i18n/locale-provider';
import { colors, radius, spacing } from '@/theme/tokens';

const RULE_KEYS = [
  'bonusPack.odds',
  'bonusPack.guarantee',
  'bonusPack.oneDaily',
  'bonusPack.regionalPool',
  'bonusPack.missingSpecialFirst',
  'bonusPack.noExpiry',
  'bonusPack.noPurchase',
  'bonusPack.specialApproval',
] as const;

export function BonusPackRulesCard() {
  const { t } = useI18n();
  return (
    <View style={styles.root}>
      <Text accessibilityRole="header" style={styles.title}>
        {t('bonusPack.rulesTitle')}
      </Text>
      {RULE_KEYS.map((key) => (
        <View key={key} style={styles.ruleRow}>
          <Text style={styles.dot}>•</Text>
          <Text style={styles.body}>{t(key)}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
  },
  title: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '800',
  },
  ruleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  dot: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '900',
    lineHeight: 20,
  },
  body: {
    flex: 1,
    color: colors.mutedInk,
    fontSize: 12,
    lineHeight: 20,
  },
});
