import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/auth/auth-provider';
import { ReadFailurePanel } from '@/components/read-failure-panel';
import { useSessionDataRefresh } from '@/features/session-data/refresh-provider';
import { useI18n } from '@/i18n/locale-provider';
import { colors, radius, spacing } from '@/theme/tokens';

import { InviteRedeemForm } from './invite-redeem-form';
import { useAccess } from './use-access';

export function AccessPanel() {
  const auth = useAuth();
  const { t } = useI18n();
  const { generation } = useSessionDataRefresh();
  const { state, retry } = useAccess();

  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.title}>
        {t('settings.accessTitle')}
      </Text>
      {auth.status === 'loading' || (auth.status === 'ready' && state.status === 'loading') ? (
        <Text accessibilityLiveRegion="polite" style={styles.body}>
          {t('settings.accessChecking')}
        </Text>
      ) : auth.status === 'error' || auth.status === 'signed_out' ? (
        <View>
          <Text style={styles.body}>{t('common.sessionBody')}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={auth.retry}
            style={({ pressed }) => [styles.secondaryButton, pressed ? styles.pressed : null]}
          >
            <Text style={styles.secondaryLabel}>{t('common.restoreSession')}</Text>
          </Pressable>
        </View>
      ) : state.status === 'error' ? (
        <ReadFailurePanel
          error={state.error}
          onRestoreSession={auth.retry}
          onRetry={retry}
        />
      ) : state.status === 'ready' ? (
        <View>
          <Text accessibilityLiveRegion="polite" style={styles.accessStatus}>
            {t(state.access.accessType === 'store_reviewer'
              ? 'settings.accessReviewer'
              : state.access.participant
                ? 'settings.accessParticipant'
                : 'settings.accessNotParticipant')}
          </Text>
          <Text style={styles.locationNotice}>{t('settings.accessLocationRequired')}</Text>
          {state.access.participant ? null : (
            <InviteRedeemForm key={generation.id} />
          )}
        </View>
      ) : (
        <Text style={styles.body}>{t('settings.accessChecking')}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: spacing.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.white,
  },
  title: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '700',
  },
  body: {
    marginTop: spacing.sm,
    color: colors.mutedInk,
    fontSize: 14,
    lineHeight: 21,
  },
  accessStatus: {
    marginTop: spacing.sm,
    color: colors.accent,
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 21,
  },
  locationNotice: {
    marginTop: spacing.sm,
    color: colors.mutedInk,
    fontSize: 13,
    lineHeight: 20,
  },
  secondaryButton: {
    minHeight: 44,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.pill,
  },
  secondaryLabel: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.7,
  },
});
