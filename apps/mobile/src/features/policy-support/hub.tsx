import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { getCurrentPolicyManifest } from '@/api/public-policies-client';
import type { CurrentPolicy, CurrentPolicyManifest, PolicyType } from '@/api/policies';
import { BrandMark } from '@/components/brand-mark';
import { Screen } from '@/components/screen';
import { getRuntimeEnvironment } from '@/config/runtime-environment';
import { useI18n } from '@/i18n/locale-provider';
import { colors, radius, spacing } from '@/theme/tokens';

import { policyManifestCache } from './cache-runtime';
import { policySupportCopy, type PolicySupportCopy } from './copy';
import type { PolicySupportRequest } from './provider';
import {
  assertTrustedPolicyManifest,
} from './verification';
import { verifyPolicyDocument, verifySupportUrl } from './verification-runtime';

type ManifestState =
  | { status: 'loading' }
  | { status: 'ready'; manifest: CurrentPolicyManifest; source: 'current' | 'cached' }
  | { status: 'error' };

type OpeningTarget = PolicyType | 'support' | null;
type ViewerState = {
  contentType: string;
  text: string;
  title: string;
  url: string;
};

const environment = getRuntimeEnvironment();

function policyLabel(type: PolicyType, copy: PolicySupportCopy): string {
  switch (type) {
    case 'terms_of_use': return copy.termsOfUse;
    case 'privacy_policy': return copy.privacyPolicy;
    case 'community_guidelines': return copy.communityGuidelines;
    case 'location_terms': return copy.locationTerms;
  }
}

export function PolicySupportHub({ onExit, request }: {
  onExit(): void;
  request: PolicySupportRequest;
}) {
  const { locale, t } = useI18n();
  const copy = policySupportCopy(locale);
  const [state, setState] = useState<ManifestState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [opening, setOpening] = useState<OpeningTarget>(null);
  const [openFailed, setOpenFailed] = useState(false);
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const directOpenStarted = useRef(false);
  const openingRef = useRef(false);
  const openRequest = useRef<AbortController | null>(null);

  useEffect(() => () => openRequest.current?.abort(), []);

  const openPolicy = useCallback(async (policy: CurrentPolicy) => {
    if (openingRef.current) return;
    openingRef.current = true;
    const document = policy.documents[locale];
    const controller = new AbortController();
    openRequest.current?.abort();
    openRequest.current = controller;
    setOpening(policy.type);
    setOpenFailed(false);
    try {
      const resource = await verifyPolicyDocument({
        allowedOrigins: environment.policyAllowedOrigins,
        document,
        signal: controller.signal,
        type: policy.type,
      });
      if (!controller.signal.aborted) {
        setViewer({
          ...resource,
          title: policyLabel(policy.type, copy),
        });
      }
    } catch {
      if (!controller.signal.aborted) setOpenFailed(true);
    } finally {
      if (openRequest.current === controller) {
        openRequest.current = null;
        openingRef.current = false;
        setOpening(null);
      }
    }
  }, [copy, locale]);

  const openSupport = useCallback(async (url: string) => {
    if (openingRef.current) return;
    openingRef.current = true;
    const controller = new AbortController();
    openRequest.current?.abort();
    openRequest.current = controller;
    setOpening('support');
    setOpenFailed(false);
    try {
      const resource = await verifySupportUrl({
        allowedOrigins: environment.policyAllowedOrigins,
        signal: controller.signal,
        url,
      });
      if (!controller.signal.aborted) {
        setViewer({ ...resource, title: copy.support });
      }
    } catch {
      if (!controller.signal.aborted) setOpenFailed(true);
    } finally {
      if (openRequest.current === controller) {
        openRequest.current = null;
        openingRef.current = false;
        setOpening(null);
      }
    }
  }, [copy.support]);

  const publishManifest = useCallback((
    manifest: CurrentPolicyManifest,
    source: 'current' | 'cached',
  ) => {
    setState({ status: 'ready', manifest, source });
    if (
      source !== 'current'
      || request.focus === 'hub'
      || directOpenStarted.current
    ) return;
    const requestedPolicy = manifest.policies.find(({ type }) => type === request.focus);
    if (requestedPolicy === undefined) return;
    directOpenStarted.current = true;
    void openPolicy(requestedPolicy);
  }, [openPolicy, request.focus]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void getCurrentPolicyManifest(controller.signal)
      .then(async (manifest) => {
        assertTrustedPolicyManifest(manifest, environment.policyAllowedOrigins);
        if (!active) return;
        publishManifest(manifest, 'current');
        await policyManifestCache.save(manifest).catch(() => undefined);
      })
      .catch(async () => {
        const cached = await policyManifestCache.load().catch(() => null);
        if (!active) return;
        try {
          if (cached === null) throw new Error('POLICY_CACHE_MISSING');
          assertTrustedPolicyManifest(cached.manifest, environment.policyAllowedOrigins);
          publishManifest(cached.manifest, 'cached');
        } catch {
          setState({ status: 'error' });
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [attempt, publishManifest]);

  const retry = () => {
    openRequest.current?.abort();
    openRequest.current = null;
    directOpenStarted.current = false;
    openingRef.current = false;
    setOpenFailed(false);
    setOpening(null);
    setState({ status: 'loading' });
    setAttempt((current) => current + 1);
  };

  if (viewer !== null) {
    const closeViewer = () => {
      setViewer(null);
      if (request.focus !== 'hub') onExit();
    };
    return (
      <Screen>
        <BrandMark />
        <Pressable
          accessibilityRole="button"
          onPress={closeViewer}
          style={({ pressed }) => [styles.back, pressed && styles.pressed]}
        >
          <Text style={styles.backLabel}>{t('common.back')}</Text>
        </Pressable>
        <Text accessibilityRole="header" style={styles.title}>{viewer.title}</Text>
        <Text style={styles.viewerVerification}>{copy.verificationBody}</Text>
        <Text selectable style={styles.url}>{viewer.url}</Text>
        <Text selectable style={styles.viewerContent}>{viewer.text}</Text>
      </Screen>
    );
  }

  return (
    <Screen>
      <BrandMark />
      <Pressable
        accessibilityRole="button"
        onPress={onExit}
        style={({ pressed }) => [styles.back, pressed && styles.pressed]}
      >
        <Text style={styles.backLabel}>{t('common.back')}</Text>
      </Pressable>
      <Text accessibilityRole="header" style={styles.title}>{copy.title}</Text>
      <Text style={styles.body}>{copy.body}</Text>
      <Text style={styles.verification}>{copy.verificationBody}</Text>

      {state.status === 'loading' ? (
        <View accessibilityLiveRegion="polite" style={styles.statePanel}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.stateText}>{t('common.loading')}</Text>
        </View>
      ) : null}

      {state.status === 'error' ? (
        <View accessibilityLiveRegion="assertive" style={styles.errorPanel}>
          <Text style={styles.errorText}>{copy.loadError}</Text>
          <Action label={t('common.retry')} onPress={retry} />
        </View>
      ) : null}

      {state.status === 'ready' ? (
        <>
          <View
            accessibilityLiveRegion="polite"
            style={state.source === 'cached' ? styles.warningPanel : styles.currentPanel}
          >
            <Text style={styles.stateText}>
              {state.source === 'cached' ? copy.cachedNotice : copy.currentNotice}
            </Text>
            {state.source === 'cached' ? (
              <Action label={t('common.refresh')} onPress={retry} />
            ) : null}
          </View>
          <View style={styles.list}>
            {state.manifest.policies.map((policy) => {
              const document = policy.documents[locale];
              return (
                <View key={policy.type} style={styles.card}>
                  <Text accessibilityRole="header" style={styles.cardTitle}>
                    {policyLabel(policy.type, copy)}
                  </Text>
                  <Text style={styles.meta}>
                    {t('personalCardPhoto.policyVersion')}: {policy.version}
                  </Text>
                  <Text style={styles.meta}>
                    {copy.effectiveAt}: {policy.effectiveAt.slice(0, 10)}
                  </Text>
                  <Text style={styles.meta}>{t('personalCardPhoto.policyHash')}:</Text>
                  <Text selectable style={styles.code}>{document.sha256}</Text>
                  <Text style={styles.meta}>{t('personalCardPhoto.policyUrl')}:</Text>
                  <Text selectable style={styles.url}>{document.url}</Text>
                  <Action
                    disabled={opening !== null}
                    label={opening === policy.type ? copy.opening : copy.open}
                    onPress={() => void openPolicy(policy)}
                  />
                </View>
              );
            })}
            {state.manifest.supportUrl === null ? null : (
              <View style={styles.card}>
                <Text accessibilityRole="header" style={styles.cardTitle}>{copy.support}</Text>
                <Text style={styles.body}>{copy.supportBody}</Text>
                <Text selectable style={styles.url}>{state.manifest.supportUrl}</Text>
                <Action
                  disabled={opening !== null}
                  label={opening === 'support' ? copy.opening : copy.open}
                  onPress={() => {
                    const supportUrl = state.manifest.supportUrl;
                    if (supportUrl !== null) void openSupport(supportUrl);
                  }}
                />
              </View>
            )}
          </View>
          {openFailed ? (
            <Text accessibilityLiveRegion="assertive" style={styles.openError}>
              {copy.openError}
            </Text>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

function Action(input: { disabled?: boolean; label: string; onPress(): void }) {
  const disabled = input.disabled ?? false;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={input.onPress}
      style={({ pressed }) => [
        styles.action,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Text style={styles.actionLabel}>{input.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  back: {
    alignSelf: 'flex-start',
    minHeight: 44,
    justifyContent: 'center',
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    backgroundColor: colors.white,
  },
  backLabel: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  title: {
    marginTop: spacing.xl,
    color: colors.ink,
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: -0.8,
  },
  body: { marginTop: spacing.sm, color: colors.mutedInk, fontSize: 14, lineHeight: 22 },
  verification: {
    marginTop: spacing.md,
    color: colors.accent,
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 20,
  },
  statePanel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xl,
    padding: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.white,
  },
  currentPanel: {
    marginTop: spacing.xl,
    padding: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: colors.accentSoft,
  },
  warningPanel: {
    marginTop: spacing.xl,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.stamp,
    borderRadius: radius.sm,
    backgroundColor: colors.white,
  },
  errorPanel: {
    marginTop: spacing.xl,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.stamp,
    borderRadius: radius.md,
    backgroundColor: colors.white,
  },
  stateText: { color: colors.ink, fontSize: 13, lineHeight: 20 },
  errorText: { color: colors.stamp, fontSize: 14, lineHeight: 22 },
  list: { gap: spacing.md, marginTop: spacing.md },
  card: {
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.white,
  },
  cardTitle: { color: colors.ink, fontSize: 17, fontWeight: '800' },
  meta: { marginTop: spacing.sm, color: colors.mutedInk, fontSize: 12, lineHeight: 18 },
  code: { marginTop: spacing.xs, color: colors.ink, fontSize: 11, lineHeight: 17 },
  url: { marginTop: spacing.xs, color: colors.accent, fontSize: 12, lineHeight: 18 },
  action: {
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  actionLabel: { color: colors.white, fontSize: 14, fontWeight: '700', textAlign: 'center' },
  openError: { marginTop: spacing.md, color: colors.stamp, fontSize: 13, lineHeight: 20 },
  viewerVerification: {
    marginTop: spacing.md,
    color: colors.accent,
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 20,
  },
  viewerContent: {
    marginTop: spacing.lg,
    padding: spacing.lg,
    color: colors.ink,
    fontSize: 15,
    lineHeight: 24,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.white,
  },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.75 },
});
