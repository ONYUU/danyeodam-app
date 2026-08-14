import * as Clipboard from 'expo-clipboard';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { claimRecoveryCode, issueRecoveryCode } from '@/api/recovery-client';
import { useAuth } from '@/auth/auth-provider';
import { canShowReviewerSensitiveActions } from '@/features/access/reviewer-sensitive-actions';
import { useAccess } from '@/features/access/use-access';
import { formatRateLimitRetryAfter } from '@/features/rate-limit';
import { runGenerationBoundOperation } from '@/features/session-data/generation-bound-operation';
import { useSessionDataRefresh } from '@/features/session-data/refresh-provider';
import { useI18n } from '@/i18n/locale-provider';
import { scheduleRecoveryClipboardClear } from '@/platform/sensitive-clipboard-native';
import { acquireSensitiveScreenProtection } from '@/platform/sensitive-screen';
import { colors, radius, spacing } from '@/theme/tokens';

import {
  recoveryClaimFailure,
  recoveryIssueFailure,
  type RecoveryClaimFailure,
  type RecoveryIssueFailure,
} from './presentation';
import { runRecoveryClaimMutation } from './claim-operation';
import { createSensitiveCodeLifecycle } from './sensitive-code-lifecycle';

type IssueState = 'idle' | 'submitting' | 'issued' | RecoveryIssueFailure;
type ClaimState = 'idle' | 'submitting' | 'success' | RecoveryClaimFailure;

function RecoveryIssueContent() {
  const { locale, t } = useI18n();
  const { generation, isGenerationCurrent } = useSessionDataRefresh();
  const [state, setState] = useState<IssueState>('idle');
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const [retryAfter, setRetryAfter] = useState<string | null>(null);
  const visibilityVersion = useRef(0);
  const appIsActive = useRef(AppState.currentState === 'active');
  const mounted = useRef(true);
  const releaseScreenProtection = useRef<(() => void) | null>(null);
  const submitting = state === 'submitting';

  const releaseProtection = useCallback(() => {
    releaseScreenProtection.current?.();
    releaseScreenProtection.current = null;
  }, []);
  const [sensitiveLifecycle] = useState(createSensitiveCodeLifecycle);

  const redact = useCallback(() => {
    visibilityVersion.current += 1;
    sensitiveLifecycle.requestRedaction();
    setIssuedCode(null);
    setCopyState('idle');
    setState((current) => current === 'submitting' ? 'uncertain' : 'idle');
  }, [sensitiveLifecycle]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sensitiveLifecycle.leaveScreen(releaseProtection);
    };
  }, [releaseProtection, sensitiveLifecycle]);

  useFocusEffect(useCallback(() => () => {
    redact();
  }, [redact]));

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      appIsActive.current = nextState === 'active';
      if (nextState !== 'active') {
        redact();
      }
    });
    return () => subscription.remove();
  }, [redact]);

  useEffect(() => {
    if (issuedCode === null) {
      sensitiveLifecycle.commitRedactedUi(releaseProtection);
    }
  }, [issuedCode, releaseProtection, sensitiveLifecycle]);

  let issueMessage: string | null = null;
  switch (state) {
    case 'no_acquisition':
      issueMessage = t('settings.recoveryNoAcquisition');
      break;
    case 'session':
      issueMessage = t('common.sessionBody');
      break;
    case 'rate_limited':
      issueMessage = t('settings.recoveryRateLimited');
      break;
    case 'uncertain':
      issueMessage = t('settings.recoveryIssueUncertain');
      break;
    case 'error':
      issueMessage = t('settings.recoveryIssueError');
      break;
  }

  const issue = async () => {
    if (submitting) {
      return;
    }
    sensitiveLifecycle.requestRedaction();
    setIssuedCode(null);
    setCopyState('idle');
    setRetryAfter(null);
    setState('submitting');
    const versionAtStart = visibilityVersion.current;
    const generationAtStart = generation;
    try {
      const outcome = await runGenerationBoundOperation({
        generation: generationAtStart,
        isGenerationCurrent,
        work: issueRecoveryCode,
      });
      if (
        outcome.status === 'stale'
        || !mounted.current
        || !appIsActive.current
        || visibilityVersion.current !== versionAtStart
      ) {
        return;
      }
      const screenRelease = await acquireSensitiveScreenProtection();
      if (
        !mounted.current
        || !appIsActive.current
        || visibilityVersion.current !== versionAtStart
        || !isGenerationCurrent(generationAtStart)
      ) {
        screenRelease();
        return;
      }
      releaseProtection();
      releaseScreenProtection.current = screenRelease;
      sensitiveLifecycle.markSecretVisible();
      setIssuedCode(outcome.value);
      setState('issued');
    } catch (error) {
      if (
        !mounted.current
        || !appIsActive.current
        || visibilityVersion.current !== versionAtStart
        || !isGenerationCurrent(generationAtStart)
      ) {
        return;
      }
      setState(recoveryIssueFailure(error));
      setRetryAfter(formatRateLimitRetryAfter(error, locale, {
        seconds: t('settings.retryAfterSeconds'),
        minutes: t('settings.retryAfterMinutes'),
      }));
    }
  };

  const copy = async () => {
    if (issuedCode === null) {
      return;
    }
    const codeAtStart = issuedCode;
    const generationAtStart = generation;
    const versionAtStart = visibilityVersion.current;
    try {
      await Clipboard.setStringAsync(codeAtStart);
      scheduleRecoveryClipboardClear(codeAtStart);
      if (
        mounted.current
        && appIsActive.current
        && visibilityVersion.current === versionAtStart
        && isGenerationCurrent(generationAtStart)
        && issuedCode === codeAtStart
      ) {
        setCopyState('copied');
      }
    } catch {
      if (
        mounted.current
        && appIsActive.current
        && visibilityVersion.current === versionAtStart
        && isGenerationCurrent(generationAtStart)
      ) {
        setCopyState('error');
      }
    }
  };

  return (
    <View>
      <Text accessibilityRole="header" style={styles.title}>
        {t('settings.recoveryTitle')}
      </Text>
      <Text style={styles.body}>{t('settings.recoveryBody')}</Text>
      {issuedCode === null ? null : (
        <View style={styles.codeBox}>
          <Text accessibilityLiveRegion="polite" style={styles.codeLabel}>
            {t('settings.recoveryCodeLabel')}
          </Text>
          <Text style={styles.code}>{issuedCode}</Text>
          <Text style={styles.warning}>{t('settings.recoveryCodeWarning')}</Text>
          <View style={styles.actionRow}>
            <Pressable
              accessibilityRole="button"
              onPress={() => void copy()}
              style={({ pressed }) => [styles.secondaryButton, pressed ? styles.pressed : null]}
            >
              <Text style={styles.secondaryLabel}>{t('settings.recoveryCopy')}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                sensitiveLifecycle.requestRedaction();
                setIssuedCode(null);
                setCopyState('idle');
                setState('idle');
              }}
              style={({ pressed }) => [styles.secondaryButton, pressed ? styles.pressed : null]}
            >
              <Text style={styles.secondaryLabel}>{t('settings.recoveryHide')}</Text>
            </Pressable>
          </View>
          {copyState === 'idle' ? null : (
            <Text
              accessibilityLiveRegion="polite"
              style={copyState === 'copied' ? styles.success : styles.error}
            >
              {t(copyState === 'copied'
                ? 'settings.recoveryCopied'
                : 'settings.recoveryCopyError')}
            </Text>
          )}
        </View>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ busy: submitting, disabled: submitting }}
        disabled={submitting}
        onPress={() => void issue()}
        style={({ pressed }) => [
          styles.primaryButton,
          pressed && !submitting ? styles.pressed : null,
          submitting ? styles.disabled : null,
        ]}
      >
        {submitting ? <ActivityIndicator color={colors.white} size="small" /> : null}
        <Text style={styles.primaryLabel}>
          {t(submitting
            ? 'settings.recoveryIssuing'
            : issuedCode === null
              ? 'settings.recoveryIssue'
              : 'settings.recoveryReissue')}
        </Text>
      </Pressable>
      {issueMessage === null ? null : (
        <Text accessibilityLiveRegion="polite" style={styles.error}>{issueMessage}</Text>
      )}
      {retryAfter === null ? null : (
        <Text accessibilityLiveRegion="polite" style={styles.error}>{retryAfter}</Text>
      )}
    </View>
  );
}

function RecoveryClaimContent({
  onAttempt,
  onSuccess,
}: {
  onAttempt(): void;
  onSuccess(): void;
}) {
  const auth = useAuth();
  const { locale, t } = useI18n();
  const {
    generation,
    isGenerationCurrent,
    refreshAccessAndCollection,
  } = useSessionDataRefresh();
  const [code, setCode] = useState('');
  const [state, setState] = useState<ClaimState>('idle');
  const [retryAfter, setRetryAfter] = useState<string | null>(null);
  const visibilityVersion = useRef(0);
  const appIsActive = useRef(AppState.currentState === 'active');
  const mounted = useRef(true);
  const submitting = state === 'submitting';
  const isAnonymous = auth.session?.user.is_anonymous === true;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const redactInput = useCallback(() => {
    visibilityVersion.current += 1;
    setCode('');
    setState((current) => current === 'submitting' ? 'uncertain' : 'idle');
  }, []);

  useFocusEffect(useCallback(() => () => {
    redactInput();
  }, [redactInput]));

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      appIsActive.current = nextState === 'active';
      if (nextState !== 'active') {
        redactInput();
      }
    });
    return () => subscription.remove();
  }, [redactInput]);

  let message: string | null = null;
  switch (state) {
    case 'success':
      message = t('settings.recoveryClaimSuccess');
      break;
    case 'invalid':
      message = t('settings.recoveryInvalid');
      break;
    case 'not_found':
      message = t('settings.recoveryNotFound');
      break;
    case 'conflict':
      message = t('settings.recoveryConflict');
      break;
    case 'forbidden':
      message = t('settings.recoveryForbidden');
      break;
    case 'rate_limited':
      message = t('settings.recoveryRateLimited');
      break;
    case 'session':
      message = t('common.sessionBody');
      break;
    case 'uncertain':
      message = t('settings.recoveryClaimUncertain');
      break;
    case 'error':
      message = t('settings.recoveryClaimError');
      break;
  }

  const claim = async () => {
    if (submitting || !isAnonymous) {
      return;
    }
    onAttempt();
    setState('submitting');
    setRetryAfter(null);
    const submittedCode = code;
    const versionAtStart = visibilityVersion.current;
    const generationAtStart = generation;
    try {
      const outcome = await runRecoveryClaimMutation({
        generation: generationAtStart,
        isGenerationCurrent,
        claim: () => claimRecoveryCode(submittedCode),
        refreshAfterMutation: refreshAccessAndCollection,
        shouldRefreshAfterError: (error) => recoveryClaimFailure(error) === 'uncertain',
      });
      const mayShowResult = outcome.status === 'current'
        && mounted.current
        && appIsActive.current
        && visibilityVersion.current === versionAtStart;
      if (mayShowResult) {
        setCode('');
        setState('success');
        onSuccess();
      }
    } catch (error) {
      const failure = recoveryClaimFailure(error);
      if (
        !mounted.current
        || !appIsActive.current
        || visibilityVersion.current !== versionAtStart
        || !isGenerationCurrent(generationAtStart)
      ) {
        return;
      }
      setState(failure);
      setRetryAfter(formatRateLimitRetryAfter(error, locale, {
        seconds: t('settings.retryAfterSeconds'),
        minutes: t('settings.retryAfterMinutes'),
      }));
    }
  };

  return (
    <View style={styles.claimSection}>
      <Text accessibilityRole="header" style={styles.title}>
        {t('settings.recoveryClaimTitle')}
      </Text>
      <Text style={styles.body}>
        {t(isAnonymous ? 'settings.recoveryClaimBody' : 'settings.recoveryClaimLinked')}
      </Text>
      {isAnonymous ? (
        <View>
          <Text style={styles.inputLabel}>{t('settings.recoveryClaimLabel')}</Text>
          <TextInput
            accessibilityLabel={t('settings.recoveryClaimLabel')}
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect={false}
            editable={!submitting}
            importantForAutofill="noExcludeDescendants"
            maxLength={43}
            onChangeText={(value) => {
              setCode(value);
              if (state !== 'idle' && state !== 'submitting') {
                setState('idle');
                setRetryAfter(null);
              }
            }}
            onSubmitEditing={() => void claim()}
            placeholder={t('settings.recoveryClaimPlaceholder')}
            placeholderTextColor={colors.mutedInk}
            returnKeyType="done"
            secureTextEntry
            style={styles.input}
            textContentType="none"
            value={code}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ busy: submitting, disabled: submitting }}
            disabled={submitting}
            onPress={() => void claim()}
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && !submitting ? styles.pressed : null,
              submitting ? styles.disabled : null,
            ]}
          >
            {submitting ? <ActivityIndicator color={colors.white} size="small" /> : null}
            <Text style={styles.primaryLabel}>
              {t(submitting
                ? 'settings.recoveryClaiming'
                : 'settings.recoveryClaimSubmit')}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {message === null ? null : (
        <Text
          accessibilityLiveRegion="polite"
          style={state === 'success' ? styles.success : styles.error}
        >
          {message}
        </Text>
      )}
      {retryAfter === null ? null : (
        <Text accessibilityLiveRegion="polite" style={styles.error}>{retryAfter}</Text>
      )}
    </View>
  );
}

export function RecoveryIssuePanel({ embedded = false }: { embedded?: boolean }) {
  const { generation } = useSessionDataRefresh();
  const { state: accessState } = useAccess();

  if (!canShowReviewerSensitiveActions(
    accessState.status === 'ready' ? accessState.access : null,
  )) {
    return null;
  }

  return (
    <View style={embedded ? styles.embedded : styles.section}>
      <RecoveryIssueContent key={generation.id} />
    </View>
  );
}

export function RecoverySettingsPanel() {
  const { generation } = useSessionDataRefresh();
  const { t } = useI18n();
  const [claimSucceeded, setClaimSucceeded] = useState(false);
  const { state: accessState } = useAccess();

  if (!canShowReviewerSensitiveActions(
    accessState.status === 'ready' ? accessState.access : null,
  )) {
    return null;
  }

  return (
    <View style={styles.section}>
      <RecoveryIssueContent key={`issue-${generation.id}`} />
      <RecoveryClaimContent
        key={`claim-${generation.id}`}
        onAttempt={() => setClaimSucceeded(false)}
        onSuccess={() => setClaimSucceeded(true)}
      />
      {claimSucceeded ? (
        <Text accessibilityLiveRegion="polite" style={styles.success}>
          {t('settings.recoveryClaimSuccess')}
        </Text>
      ) : null}
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
  embedded: {
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
  primaryButton: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
  },
  primaryLabel: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.74,
  },
  disabled: {
    opacity: 0.62,
  },
  codeBox: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: colors.paper,
  },
  codeLabel: {
    color: colors.mutedInk,
    fontSize: 12,
    fontWeight: '700',
  },
  code: {
    marginTop: spacing.sm,
    color: colors.ink,
    fontFamily: 'monospace',
    fontSize: 14,
    lineHeight: 21,
  },
  warning: {
    marginTop: spacing.sm,
    color: colors.stamp,
    fontSize: 12,
    lineHeight: 18,
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  secondaryButton: {
    minHeight: 44,
    justifyContent: 'center',
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
  success: {
    marginTop: spacing.md,
    color: colors.accent,
    fontSize: 13,
    lineHeight: 20,
  },
  error: {
    marginTop: spacing.md,
    color: colors.stamp,
    fontSize: 13,
    lineHeight: 20,
  },
  claimSection: {
    marginTop: spacing.xl,
    paddingTop: spacing.xl,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  inputLabel: {
    marginTop: spacing.md,
    marginBottom: spacing.xs,
    color: colors.ink,
    fontSize: 13,
    fontWeight: '700',
  },
  input: {
    minHeight: 48,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.paper,
    color: colors.ink,
    fontSize: 16,
    letterSpacing: 0.4,
  },
});
