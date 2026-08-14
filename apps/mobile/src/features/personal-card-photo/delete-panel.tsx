import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { ApiResponseError, ApiTransportError } from '@/api/client';
import { useAuth } from '@/auth/auth-provider';
import { useSessionDataRefresh } from '@/features/session-data/refresh-provider';
import type { SessionBindingGeneration } from '@/features/session-data/generation';
import { useI18n } from '@/i18n/locale-provider';
import { colors, radius, spacing } from '@/theme/tokens';

import { PersonalCardDeleteFlowError } from './delete-coordinator';
import { createRuntimePersonalCardDeleteCoordinator } from './delete-runtime';

type DeleteState =
  | { status: 'confirming' }
  | { status: 'error'; reason: 'error' | 'session' | 'uncertain' }
  | { status: 'idle' }
  | { status: 'working' };

export function PersonalCardPhotoDeletePanel(input: {
  personalCardId: string;
  onAccepted(): void;
}) {
  const { generation, isGenerationCurrent } = useSessionDataRefresh();

  return (
    <PersonalCardPhotoDeletePanelForGeneration
      key={generation.id}
      generation={generation}
      isGenerationCurrent={isGenerationCurrent}
      onAccepted={input.onAccepted}
      personalCardId={input.personalCardId}
    />
  );
}

function PersonalCardPhotoDeletePanelForGeneration(input: {
  generation: SessionBindingGeneration;
  isGenerationCurrent(generation: SessionBindingGeneration): boolean;
  personalCardId: string;
  onAccepted(): void;
}) {
  const auth = useAuth();
  const { t } = useI18n();
  const [coordinator] = useState(() => createRuntimePersonalCardDeleteCoordinator({
    isGenerationCurrent: input.isGenerationCurrent,
  }));
  const [state, setState] = useState<DeleteState>({ status: 'idle' });
  const operationVersion = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    coordinator.setGeneration(input.generation);
    return () => coordinator.cancel();
  }, [coordinator, input.generation]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operationVersion.current += 1;
      coordinator.cancel();
    };
  }, [coordinator]);

  const remove = async () => {
    if (state.status === 'working' || auth.status !== 'ready') {
      return;
    }
    const generationAtStart = input.generation;
    operationVersion.current += 1;
    const versionAtStart = operationVersion.current;
    setState({ status: 'working' });
    try {
      await coordinator.run({
        personalCardId: input.personalCardId,
        generation: generationAtStart,
      });
      if (
        mounted.current
        && operationVersion.current === versionAtStart
        && input.isGenerationCurrent(generationAtStart)
      ) {
        input.onAccepted();
      }
    } catch (error) {
      if (
        !mounted.current
        || operationVersion.current !== versionAtStart
        || !input.isGenerationCurrent(generationAtStart)
      ) {
        return;
      }
      if (
        error instanceof PersonalCardDeleteFlowError
        && (
          error.reason === 'CANCELLED'
          || error.reason === 'GENERATION_CHANGED'
        )
      ) {
        setState({ status: 'idle' });
        return;
      }
      if (
        error instanceof ApiTransportError
        && error.failure === 'AUTH_SESSION_UNAVAILABLE'
      ) {
        setState({ status: 'error', reason: 'session' });
        return;
      }
      if (
        error instanceof ApiResponseError
        && (error.status === 401 || error.code === 'UNAUTHORIZED')
      ) {
        setState({ status: 'error', reason: 'session' });
        return;
      }
      setState({
        status: 'error',
        reason: coordinator.hasPendingRetry() ? 'uncertain' : 'error',
      });
    }
  };

  const cancel = () => {
    operationVersion.current += 1;
    coordinator.cancel();
    setState({ status: 'idle' });
  };

  if (state.status === 'idle') {
    return (
      <DeleteAction
        label={t('personalCardPhoto.removeAction')}
        onPress={() => setState({ status: 'confirming' })}
      />
    );
  }

  if (state.status === 'confirming') {
    return (
      <View style={styles.confirmation}>
        <Text accessibilityRole="header" style={styles.title}>
          {t('personalCardPhoto.removeTitle')}
        </Text>
        <Text style={styles.body}>{t('personalCardPhoto.removeBody')}</Text>
        <View style={styles.actions}>
          <DeleteAction
            destructive
            label={t('personalCardPhoto.removeConfirm')}
            onPress={() => void remove()}
          />
          <DeleteAction
            label={t('personalCardPhoto.cancel')}
            onPress={cancel}
          />
        </View>
      </View>
    );
  }

  const pendingRetry = coordinator.hasPendingRetry();
  return (
    <View style={styles.statusPanel}>
      {state.status === 'working' ? (
        <View accessibilityLiveRegion="polite" style={styles.progress}>
          <ActivityIndicator color={colors.accent} size="small" />
          <Text style={styles.body}>{t('personalCardPhoto.removing')}</Text>
        </View>
      ) : (
        <Text accessibilityLiveRegion="assertive" style={styles.error}>
          {t(state.reason === 'session'
            ? 'common.sessionBody'
            : state.reason === 'uncertain'
              ? 'personalCardPhoto.removeUncertain'
              : 'personalCardPhoto.removeError')}
        </Text>
      )}
      <View style={styles.actions}>
        {state.status === 'error' ? (
          <DeleteAction
            destructive
            label={t(pendingRetry
              ? 'personalCardPhoto.removeRetry'
              : 'personalCardPhoto.removeConfirm')}
            onPress={() => void remove()}
          />
        ) : null}
        <DeleteAction
          label={t(state.status === 'working'
            ? 'personalCardPhoto.stop'
            : 'personalCardPhoto.cancel')}
          onPress={cancel}
        />
      </View>
    </View>
  );
}

function DeleteAction(input: {
  destructive?: boolean;
  label: string;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={input.onPress}
      style={({ pressed }) => [
        styles.action,
        input.destructive ? styles.destructiveAction : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <Text style={[
        styles.actionLabel,
        input.destructive ? styles.destructiveLabel : null,
      ]}>
        {input.label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  confirmation: {
    gap: spacing.sm,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.stamp,
    borderRadius: radius.sm,
    backgroundColor: colors.paperStrong,
  },
  statusPanel: {
    gap: spacing.sm,
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
  error: {
    color: colors.stamp,
    fontSize: 12,
    lineHeight: 18,
  },
  progress: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  action: {
    minHeight: 44,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.pill,
  },
  destructiveAction: {
    borderColor: colors.stamp,
  },
  actionLabel: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: '700',
  },
  destructiveLabel: {
    color: colors.stamp,
  },
  pressed: {
    opacity: 0.68,
  },
});
