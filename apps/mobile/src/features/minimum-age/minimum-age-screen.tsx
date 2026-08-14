import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { BrandMark } from '@/components/brand-mark';
import { Screen } from '@/components/screen';
import { policySupportCopy } from '@/features/policy-support/copy';
import { usePolicySupport } from '@/features/policy-support/provider';
import { useI18n } from '@/i18n/locale-provider';
import { colors, radius, spacing } from '@/theme/tokens';

import type { BirthDateFields } from './policy';

type BirthDateField = keyof BirthDateFields;

type MinimumAgeBirthDateScreenProps = {
  fields: BirthDateFields;
  error: boolean;
  onChange(field: BirthDateField, value: string): void;
  onOpenPrivacyRights(): void;
  onSubmit(): void;
};

type MinimumAgeStatusScreenProps = {
  title: string;
  body: string;
  buttonLabel?: string;
  loading?: boolean;
  onPress?: () => void;
  onSecondaryPress?: () => void;
  secondaryButtonLabel?: string;
};

function digitsOnly(value: string, maximumLength: number): string {
  return value.replace(/[^0-9]/gu, '').slice(0, maximumLength);
}

export function MinimumAgeBirthDateScreen({
  fields,
  error,
  onChange,
  onOpenPrivacyRights,
  onSubmit,
}: MinimumAgeBirthDateScreenProps) {
  const { locale, t } = useI18n();
  const policySupport = usePolicySupport();

  return (
    <Screen contentStyle={styles.content}>
      <BrandMark />
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>
          {t('ageGate.title')}
        </Text>
        <Text style={styles.body}>{t('ageGate.body')}</Text>
        <Text style={styles.privacy}>{t('ageGate.privacy')}</Text>
      </View>

      <View style={styles.form}>
        <View style={styles.dateRow}>
          <View style={styles.yearField}>
            <Text nativeID="minimum-age-year-label" style={styles.label}>
              {t('ageGate.year')}
            </Text>
            <TextInput
              accessibilityLabel={t('ageGate.year')}
              aria-labelledby="minimum-age-year-label"
              autoComplete="off"
              importantForAutofill="no"
              inputMode="numeric"
              keyboardType="number-pad"
              maxLength={4}
              onChangeText={(value) => onChange('year', digitsOnly(value, 4))}
              placeholder="YYYY"
              placeholderTextColor={colors.mutedInk}
              returnKeyType="next"
              style={[styles.input, error ? styles.inputError : null]}
              textContentType="none"
              value={fields.year}
            />
          </View>
          <View style={styles.shortField}>
            <Text nativeID="minimum-age-month-label" style={styles.label}>
              {t('ageGate.month')}
            </Text>
            <TextInput
              accessibilityLabel={t('ageGate.month')}
              aria-labelledby="minimum-age-month-label"
              autoComplete="off"
              importantForAutofill="no"
              inputMode="numeric"
              keyboardType="number-pad"
              maxLength={2}
              onChangeText={(value) => onChange('month', digitsOnly(value, 2))}
              placeholder="MM"
              placeholderTextColor={colors.mutedInk}
              returnKeyType="next"
              style={[styles.input, error ? styles.inputError : null]}
              textContentType="none"
              value={fields.month}
            />
          </View>
          <View style={styles.shortField}>
            <Text nativeID="minimum-age-day-label" style={styles.label}>
              {t('ageGate.day')}
            </Text>
            <TextInput
              accessibilityLabel={t('ageGate.day')}
              aria-labelledby="minimum-age-day-label"
              autoComplete="off"
              importantForAutofill="no"
              inputMode="numeric"
              keyboardType="number-pad"
              maxLength={2}
              onChangeText={(value) => onChange('day', digitsOnly(value, 2))}
              onSubmitEditing={onSubmit}
              placeholder="DD"
              placeholderTextColor={colors.mutedInk}
              returnKeyType="done"
              style={[styles.input, error ? styles.inputError : null]}
              textContentType="none"
              value={fields.day}
            />
          </View>
        </View>

        {error ? (
          <Text accessibilityLiveRegion="assertive" style={styles.error}>
            {t('ageGate.invalidDate')}
          </Text>
        ) : null}

        <Pressable
          accessibilityRole="button"
          onPress={onSubmit}
          style={({ pressed }) => [
            styles.button,
            pressed ? styles.buttonPressed : null,
          ]}
        >
          <Text style={styles.buttonLabel}>{t('ageGate.continue')}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={policySupport.openHub}
          style={({ pressed }) => [
            styles.tertiaryButton,
            pressed ? styles.buttonPressed : null,
          ]}
        >
          <Text style={styles.tertiaryButtonLabel}>
            {policySupportCopy(locale).entry}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={onOpenPrivacyRights}
          style={({ pressed }) => [
            styles.secondaryButton,
            pressed ? styles.buttonPressed : null,
          ]}
        >
          <Text style={styles.secondaryButtonLabel}>
            {t('ageGate.privacyRightsAction')}
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}

export function MinimumAgeStatusScreen({
  title,
  body,
  buttonLabel,
  loading = false,
  onPress,
  onSecondaryPress,
  secondaryButtonLabel,
}: MinimumAgeStatusScreenProps) {
  const { locale } = useI18n();
  const policySupport = usePolicySupport();
  return (
    <Screen contentStyle={styles.centeredContent}>
      <BrandMark />
      <View style={styles.statusPanel}>
        {loading ? (
          <ActivityIndicator accessibilityLabel={title} color={colors.accent} size="large" />
        ) : null}
        <Text accessibilityRole="header" style={[styles.title, styles.centeredText]}>
          {title}
        </Text>
        <Text accessibilityLiveRegion="polite" style={[styles.body, styles.centeredText]}>
          {body}
        </Text>
        {buttonLabel !== undefined && onPress !== undefined ? (
          <Pressable
            accessibilityRole="button"
            onPress={onPress}
            style={({ pressed }) => [
              styles.button,
              styles.statusButton,
              pressed ? styles.buttonPressed : null,
            ]}
          >
            <Text style={styles.buttonLabel}>{buttonLabel}</Text>
          </Pressable>
        ) : null}
        {secondaryButtonLabel !== undefined && onSecondaryPress !== undefined ? (
          <Pressable
            accessibilityRole="button"
            onPress={onSecondaryPress}
            style={({ pressed }) => [
              styles.secondaryButton,
              pressed ? styles.buttonPressed : null,
            ]}
          >
            <Text style={styles.secondaryButtonLabel}>
              {secondaryButtonLabel}
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          onPress={policySupport.openHub}
          style={({ pressed }) => [
            styles.tertiaryButton,
            pressed ? styles.buttonPressed : null,
          ]}
        >
          <Text style={styles.tertiaryButtonLabel}>
            {policySupportCopy(locale).entry}
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    minHeight: '100%',
  },
  centeredContent: {
    minHeight: '100%',
    justifyContent: 'center',
  },
  header: {
    gap: spacing.sm,
    paddingTop: spacing.xxl,
    paddingBottom: spacing.xl,
  },
  title: {
    color: colors.ink,
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: -0.8,
    lineHeight: 38,
  },
  body: {
    maxWidth: 520,
    color: colors.mutedInk,
    fontSize: 15,
    lineHeight: 23,
  },
  privacy: {
    maxWidth: 520,
    color: colors.accent,
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 20,
  },
  form: {
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.white,
  },
  dateRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  yearField: {
    flex: 1.35,
  },
  shortField: {
    flex: 1,
  },
  label: {
    marginBottom: spacing.sm,
    color: colors.ink,
    fontSize: 14,
    fontWeight: '700',
  },
  input: {
    minHeight: 52,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.paper,
    color: colors.ink,
    fontSize: 17,
    textAlign: 'center',
  },
  inputError: {
    borderColor: colors.stamp,
  },
  error: {
    marginTop: spacing.md,
    color: colors.stamp,
    fontSize: 14,
    lineHeight: 21,
  },
  button: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  buttonPressed: {
    opacity: 0.78,
  },
  buttonLabel: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
  },
  secondaryButton: {
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
  tertiaryButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  tertiaryButtonLabel: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
    textDecorationLine: 'underline',
  },
  secondaryButtonLabel: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
  },
  statusPanel: {
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xxl,
  },
  centeredText: {
    textAlign: 'center',
  },
  statusButton: {
    marginTop: spacing.sm,
  },
});
