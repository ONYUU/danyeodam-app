import { router } from 'expo-router';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/auth/auth-provider';
import { BonusPackShell } from '@/components/bonus-pack-shell';
import { useI18n } from '@/i18n/locale-provider';
import { colors, radius, spacing } from '@/theme/tokens';

import { useBonusPacks } from './use-bonus-packs';

export function BonusPackEntryCard() {
  const auth = useAuth();
  const { locale, t } = useI18n();
  const { state } = useBonusPacks({
    locale,
    enabled: auth.status === 'ready',
    sessionKey: auth.session?.user.id ?? null,
  });
  const sealedCount = state.status === 'ready'
    ? state.sealedCount
    : null;

  return (
    <View style={styles.root}>
      <View style={styles.packPreview}>
        <BonusPackShell compact />
      </View>
      <View style={styles.copy}>
        <Text accessibilityRole="header" style={styles.title}>
          {t('bonusPack.entryTitle')}
        </Text>
        <Text style={styles.body}>{t('bonusPack.entryBody')}</Text>
        <View style={styles.statusRow}>
          {state.status === 'loading' ? (
            <ActivityIndicator color={colors.accent} size="small" />
          ) : null}
          <Text style={styles.status}>
            {state.status === 'error'
              ? t('common.errorTitle')
              : sealedCount === null
                ? t('common.loading')
              : sealedCount === 0
                ? t('bonusPack.entryNone')
                : `${t('bonusPack.entryUnopened')} · ${sealedCount}`}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push('/bonus-packs')}
          style={({ pressed }) => [styles.button, pressed ? styles.pressed : null]}
        >
          <Text style={styles.buttonLabel}>{t('bonusPack.openInbox')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: '#D7B4AA',
    borderRadius: radius.md,
    backgroundColor: '#F6E7E0',
  },
  packPreview: {
    width: 84,
  },
  copy: {
    flex: 1,
  },
  title: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '800',
  },
  body: {
    marginTop: spacing.xs,
    color: colors.mutedInk,
    fontSize: 12,
    lineHeight: 18,
  },
  statusRow: {
    minHeight: 22,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  status: {
    color: '#8A5153',
    fontSize: 12,
    fontWeight: '800',
  },
  button: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: '#985B5E',
  },
  buttonLabel: {
    color: colors.white,
    fontSize: 13,
    fontWeight: '800',
  },
  pressed: {
    opacity: 0.72,
  },
});
