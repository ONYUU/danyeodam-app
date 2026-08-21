import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useI18n } from '@/i18n/locale-provider';
import { colors, radius, spacing } from '@/theme/tokens';

export function InventoryEntryCard() {
  const { t } = useI18n();

  return (
    <View style={styles.root}>
      <View style={styles.headingRow}>
        <View style={styles.icon}>
          <Text style={styles.iconLabel}>▧</Text>
        </View>
        <View style={styles.copy}>
          <Text accessibilityRole="header" style={styles.title}>
            {t('inventory.title')}
          </Text>
          <Text style={styles.body}>{t('inventory.body')}</Text>
        </View>
      </View>
      <View style={styles.actionRow}>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push('/card-inventory')}
          style={({ pressed }) => [styles.button, pressed ? styles.pressed : null]}
        >
          <Text style={styles.buttonLabel}>{t('inventory.open')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.white,
  },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  icon: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 21,
    backgroundColor: colors.accentSoft,
  },
  iconLabel: {
    color: colors.accent,
    fontSize: 19,
    fontWeight: '900',
  },
  copy: {
    flex: 1,
  },
  title: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '800',
  },
  body: {
    marginTop: spacing.xs,
    color: colors.mutedInk,
    fontSize: 12,
    lineHeight: 18,
  },
  actionRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  button: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.pill,
  },
  buttonLabel: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '800',
  },
  pressed: {
    opacity: 0.72,
  },
});
