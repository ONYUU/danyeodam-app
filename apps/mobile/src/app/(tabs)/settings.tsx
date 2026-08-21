import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useState } from 'react';

import { PrivacyRightsSessionProvider } from '@/auth/privacy-rights-session-provider';
import { BrandMark } from '@/components/brand-mark';
import { Screen } from '@/components/screen';
import { AccessPanel } from '@/features/access/access-panel';
import { BlockSettingsEntry } from '@/features/blocks/settings-entry';
import { useHapticPreference } from '@/features/bonus-pack/use-haptic-preference';
import { EmailLinkPanel } from '@/features/email-link/email-link-panel';
import { LocationConsentPanel } from '@/features/location-consent/location-consent-panel';
import { PrivacyRightsEntry } from '@/features/privacy-rights/privacy-rights-entry';
import { RecoverySettingsPanel } from '@/features/recovery/recovery-panel';
import { policySupportCopy } from '@/features/policy-support/copy';
import { usePolicySupport } from '@/features/policy-support/provider';
import { useI18n } from '@/i18n/locale-provider';
import { LANGUAGE_OPTIONS } from '@/i18n/locales';
import { colors, radius, spacing } from '@/theme/tokens';

export default function SettingsScreen() {
  const router = useRouter();
  const { locale, setLocale, t } = useI18n();
  const policySupport = usePolicySupport();
  const policyCopy = policySupportCopy(locale);
  const [privacyRightsOpen, setPrivacyRightsOpen] = useState(false);
  const { state: haptics, setEnabled: setHapticsEnabled } = useHapticPreference();

  if (privacyRightsOpen) {
    return (
      <PrivacyRightsSessionProvider>
        <PrivacyRightsEntry onExit={() => setPrivacyRightsOpen(false)} />
      </PrivacyRightsSessionProvider>
    );
  }

  return (
    <Screen>
      <BrandMark />
      <Text accessibilityRole="header" style={styles.title}>
        {t('settings.title')}
      </Text>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t('settings.language')}</Text>
        <Text style={styles.sectionHint}>{t('settings.languageHint')}</Text>
        <View
          accessibilityLabel={t('settings.language')}
          accessibilityRole="radiogroup"
          style={styles.languageGrid}
        >
          {LANGUAGE_OPTIONS.map((option) => {
            const selected = locale === option.locale;

            return (
              <Pressable
                accessibilityRole="radio"
                accessibilityLabel={option.label}
                accessibilityState={{ checked: selected }}
                key={option.locale}
                onPress={() => setLocale(option.locale)}
                style={({ pressed }) => [
                  styles.languageButton,
                  selected && styles.languageButtonSelected,
                  pressed && styles.languageButtonPressed,
                ]}
              >
                <Text
                  style={[
                    styles.languageLabel,
                    selected && styles.languageLabelSelected,
                  ]}
                >
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.section}>
        <View style={styles.preferenceRow}>
          <View style={styles.preferenceCopy}>
            <Text style={styles.sectionTitle}>{t('settings.hapticsTitle')}</Text>
            <Text style={styles.sectionHint}>{t('settings.hapticsBody')}</Text>
          </View>
          <Switch
            accessibilityLabel={t('settings.hapticsTitle')}
            accessibilityRole="switch"
            accessibilityState={{
              checked: haptics.enabled,
              busy: haptics.loading || haptics.saving,
              disabled: haptics.loading || haptics.saving,
            }}
            disabled={haptics.loading || haptics.saving}
            onValueChange={setHapticsEnabled}
            thumbColor={colors.white}
            trackColor={{ false: colors.border, true: colors.accent }}
            value={haptics.enabled}
          />
        </View>
        {haptics.error ? (
          <Text accessibilityLiveRegion="assertive" style={styles.preferenceError}>
            {t('settings.hapticsError')}
          </Text>
        ) : null}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{policyCopy.settingsTitle}</Text>
        <Text style={styles.sectionHint}>{policyCopy.settingsBody}</Text>
        <Pressable
          accessibilityRole="link"
          onPress={policySupport.openPrivacyPolicy}
          style={({ pressed }) => [
            styles.policyPrimaryButton,
            pressed && styles.languageButtonPressed,
          ]}
        >
          <Text style={styles.policyPrimaryLabel}>{policyCopy.privacyPolicy}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={policySupport.openHub}
          style={({ pressed }) => [
            styles.policySecondaryButton,
            pressed && styles.languageButtonPressed,
          ]}
        >
          <Text style={styles.policySecondaryLabel}>{policyCopy.entry}</Text>
        </Pressable>
      </View>

      <AccessPanel />

      <LocationConsentPanel onOpenPrivacyRights={() => setPrivacyRightsOpen(true)} />

      <RecoverySettingsPanel />

      <BlockSettingsEntry onOpen={() => router.push('/blocks')} />

      <EmailLinkPanel />

      <View style={[styles.section, styles.privacySection]}>
        <Text style={styles.sectionTitle}>{t('settings.privacyTitle')}</Text>
        <Text style={styles.privacyBody}>{t('settings.privacyBody')}</Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: {
    paddingTop: spacing.xxl,
    paddingBottom: spacing.xl,
    color: colors.ink,
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: -0.8,
  },
  section: {
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.white,
  },
  sectionTitle: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '700',
  },
  sectionHint: {
    marginTop: spacing.xs,
    color: colors.mutedInk,
    fontSize: 13,
    lineHeight: 20,
  },
  languageGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  preferenceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  preferenceCopy: {
    flex: 1,
  },
  preferenceError: {
    marginTop: spacing.sm,
    color: colors.stamp,
    fontSize: 12,
    lineHeight: 18,
  },
  languageButton: {
    minWidth: 96,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    backgroundColor: colors.paper,
  },
  languageButtonSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
  },
  languageButtonPressed: {
    opacity: 0.72,
  },
  languageLabel: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  languageLabelSelected: {
    color: colors.white,
  },
  privacySection: {
    marginTop: spacing.md,
    backgroundColor: colors.accentSoft,
    borderColor: colors.accentSoft,
  },
  privacyBody: {
    marginTop: spacing.sm,
    color: colors.mutedInk,
    fontSize: 14,
    lineHeight: 22,
  },
  policyPrimaryButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  policyPrimaryLabel: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '700',
  },
  policySecondaryButton: {
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.pill,
    backgroundColor: colors.white,
  },
  policySecondaryLabel: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '700',
  },
});
