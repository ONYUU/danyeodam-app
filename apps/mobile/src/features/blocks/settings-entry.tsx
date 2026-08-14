import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useI18n } from '@/i18n/locale-provider';
import { colors, radius, spacing } from '@/theme/tokens';

export function BlockSettingsEntry({ onOpen }: { onOpen(): void }) {
  const { t } = useI18n();
  return (
    <View style={styles.section}>
      <Text style={styles.title}>{t('blocks.settingsTitle')}</Text>
      <Text style={styles.body}>{t('blocks.settingsBody')}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={onOpen}
        style={({ pressed }) => [styles.button, pressed ? styles.pressed : null]}
      >
        <Text style={styles.buttonLabel}>{t('blocks.openList')}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.white,
  },
  title: { color: colors.ink, fontSize: 17, fontWeight: '700' },
  body: { color: colors.mutedInk, fontSize: 14, lineHeight: 21 },
  button: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  pressed: { opacity: 0.72 },
  buttonLabel: { color: colors.white, fontSize: 14, fontWeight: '700' },
});
