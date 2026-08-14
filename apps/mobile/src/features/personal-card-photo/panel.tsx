import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { MAX_PERSONAL_CARD_CAPTION_LENGTH } from '@/api/personal-card-photo';
import { useAuth } from '@/auth/auth-provider';
import { useSessionDataRefresh } from '@/features/session-data/refresh-provider';
import { useI18n } from '@/i18n/locale-provider';
import { colors, radius, spacing } from '@/theme/tokens';

import type { PersonalCardPhotoProgress } from './coordinator';
import {
  personalCardPhotoFailure,
  type PersonalCardPhotoFailure,
} from './presentation';
import { PersonalCardPolicyAcceptancePanel } from './policy-acceptance-panel';
import { createRuntimePersonalCardPhotoCoordinator } from './runtime';

type PanelState =
  | { status: 'idle' }
  | { status: 'editing' }
  | { status: 'error'; failure: PersonalCardPhotoFailure }
  | { status: 'success' }
  | { status: 'working'; progress: PersonalCardPhotoProgress };

function failureMessageKey(failure: PersonalCardPhotoFailure) {
  switch (failure) {
    case 'access_required':
      return 'personalCardPhoto.accessRequired' as const;
    case 'error':
      return 'personalCardPhoto.error' as const;
    case 'expired':
      return 'personalCardPhoto.expired' as const;
    case 'processing':
      return 'personalCardPhoto.processing' as const;
    case 'policy_required':
      return 'personalCardPhoto.policyBody' as const;
    case 'quota':
      return 'personalCardPhoto.quota' as const;
    case 'rate_limited':
      return 'personalCardPhoto.rateLimited' as const;
    case 'session':
      return 'common.sessionBody' as const;
    case 'too_large':
      return 'personalCardPhoto.tooLarge' as const;
    case 'uncertain':
      return 'personalCardPhoto.uncertain' as const;
    case 'unsupported':
      return 'personalCardPhoto.unsupported' as const;
    case 'cancelled':
      return 'personalCardPhoto.error' as const;
  }
}

function progressMessageKey(progress: PersonalCardPhotoProgress) {
  switch (progress) {
    case 'choosing':
      return 'personalCardPhoto.choosing' as const;
    case 'requesting_upload':
      return 'personalCardPhoto.preparing' as const;
    case 'uploading':
      return 'personalCardPhoto.uploading' as const;
    case 'creating':
      return 'personalCardPhoto.creating' as const;
  }
}

export function PersonalCardPhotoPanel({ acquisitionId }: { acquisitionId: string }) {
  const { generation } = useSessionDataRefresh();

  return (
    <PersonalCardPhotoPanelForGeneration
      key={generation.id}
      acquisitionId={acquisitionId}
    />
  );
}

function PersonalCardPhotoPanelForGeneration({ acquisitionId }: {
  acquisitionId: string;
}) {
  const auth = useAuth();
  const { locale, t } = useI18n();
  const {
    generation,
    isGenerationCurrent,
    refreshCollection,
  } = useSessionDataRefresh();
  const [coordinator] = useState(() => createRuntimePersonalCardPhotoCoordinator({
    isGenerationCurrent,
  }));
  const [caption, setCaption] = useState('');
  const [state, setState] = useState<PanelState>({ status: 'idle' });
  const mounted = useRef(true);
  const operationVersion = useRef(0);
  const working = state.status === 'working';

  useEffect(() => {
    coordinator.setGeneration(generation);
    return () => coordinator.cancelActiveAttempt();
  }, [coordinator, generation]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operationVersion.current += 1;
      coordinator.cancelActiveAttempt();
    };
  }, [coordinator]);

  const save = async () => {
    if (working || auth.status !== 'ready') {
      return;
    }
    const generationAtStart = generation;
    operationVersion.current += 1;
    const versionAtStart = operationVersion.current;
    try {
      const result = await coordinator.run({
        acquisitionId,
        caption,
        generation: generationAtStart,
        onProgress(progress) {
          if (
            mounted.current
            && operationVersion.current === versionAtStart
            && isGenerationCurrent(generationAtStart)
          ) {
            setState({ status: 'working', progress });
          }
        },
      });
      if (
        !mounted.current
        || operationVersion.current !== versionAtStart
        || !isGenerationCurrent(generationAtStart)
      ) {
        return;
      }
      if (result === null) {
        setState({ status: 'editing' });
        return;
      }
      setState({ status: 'success' });
      refreshCollection();
    } catch (error) {
      if (
        !mounted.current
        || operationVersion.current !== versionAtStart
        || !isGenerationCurrent(generationAtStart)
      ) {
        return;
      }
      const failure = personalCardPhotoFailure(error);
      setState(failure === 'cancelled'
        ? { status: 'editing' }
        : { status: 'error', failure });
    }
  };

  const cancel = () => {
    operationVersion.current += 1;
    coordinator.cancelActiveAttempt();
    setCaption('');
    setState({ status: 'idle' });
  };

  if (state.status === 'idle') {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={() => setState({ status: 'editing' })}
        style={({ pressed }) => [styles.addButton, pressed ? styles.pressed : null]}
      >
        <Text style={styles.addLabel}>{t('personalCardPhoto.add')}</Text>
      </Pressable>
    );
  }

  const pendingRetry = coordinator.hasPendingRetry();
  const inputDisabled = working || pendingRetry;
  const awaitingPolicy = state.status === 'error'
    && state.failure === 'policy_required';
  return (
    <View style={styles.panel}>
      <Text accessibilityRole="header" style={styles.title}>
        {t('personalCardPhoto.title')}
      </Text>
      <Text style={styles.body}>{t('personalCardPhoto.body')}</Text>
      <View style={styles.privacyNotice}>
        <Text style={styles.privacyText}>{t('personalCardPhoto.privacy')}</Text>
      </View>
      <TextInput
        accessibilityLabel={t('personalCardPhoto.captionLabel')}
        editable={!inputDisabled}
        maxLength={MAX_PERSONAL_CARD_CAPTION_LENGTH}
        multiline
        onChangeText={setCaption}
        placeholder={t('personalCardPhoto.captionPlaceholder')}
        placeholderTextColor={colors.mutedInk}
        style={[styles.input, inputDisabled ? styles.disabledInput : null]}
        value={caption}
      />
      {state.status === 'working' ? (
        <View accessibilityLiveRegion="polite" style={styles.progress}>
          <ActivityIndicator color={colors.accent} size="small" />
          <Text style={styles.progressText}>{t(progressMessageKey(state.progress))}</Text>
        </View>
      ) : null}
      {state.status === 'error' && !awaitingPolicy ? (
        <Text accessibilityLiveRegion="assertive" style={styles.error}>
          {t(failureMessageKey(state.failure))}
        </Text>
      ) : null}
      {awaitingPolicy ? (
        <PersonalCardPolicyAcceptancePanel
          key={locale}
          onAccepted={() => void save()}
        />
      ) : null}
      {state.status === 'success' ? (
        <Text accessibilityLiveRegion="polite" style={styles.success}>
          {t('personalCardPhoto.success')}
        </Text>
      ) : null}
      <View style={styles.actions}>
        {state.status === 'success' || awaitingPolicy ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ busy: working, disabled: working }}
            disabled={working}
            onPress={() => void save()}
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && !working ? styles.pressed : null,
              working ? styles.disabled : null,
            ]}
          >
            <Text style={styles.primaryLabel}>
              {t(pendingRetry
                ? 'personalCardPhoto.retrySame'
                : 'personalCardPhoto.chooseAndSave')}
            </Text>
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          onPress={cancel}
          style={({ pressed }) => [styles.cancelButton, pressed ? styles.pressed : null]}
        >
          <Text style={styles.cancelLabel}>
            {t(working ? 'personalCardPhoto.stop' : 'personalCardPhoto.cancel')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  addButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.pill,
  },
  addLabel: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '700',
  },
  panel: {
    gap: spacing.sm,
    marginTop: spacing.sm,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  title: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  body: {
    color: colors.mutedInk,
    fontSize: 12,
    lineHeight: 18,
  },
  privacyNotice: {
    padding: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.accentSoft,
  },
  privacyText: {
    color: colors.accent,
    fontSize: 11,
    lineHeight: 17,
  },
  input: {
    minHeight: 72,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    color: colors.ink,
    backgroundColor: colors.white,
    fontSize: 13,
    lineHeight: 19,
    textAlignVertical: 'top',
  },
  disabledInput: {
    opacity: 0.62,
  },
  progress: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  progressText: {
    color: colors.mutedInk,
    fontSize: 12,
  },
  error: {
    color: colors.stamp,
    fontSize: 12,
    lineHeight: 18,
  },
  success: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 18,
  },
  actions: {
    gap: spacing.xs,
  },
  primaryButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  primaryLabel: {
    color: colors.white,
    fontSize: 12,
    fontWeight: '700',
  },
  cancelButton: {
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  cancelLabel: {
    color: colors.mutedInk,
    fontSize: 12,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.68,
  },
  disabled: {
    opacity: 0.62,
  },
});
