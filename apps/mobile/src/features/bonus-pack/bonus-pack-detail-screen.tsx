import { router, useLocalSearchParams } from 'expo-router';
import type { ComponentRef } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  findNodeHandle,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type {
  BonusPack,
  CardRarity,
  OpenedBonusPack,
} from '@/api/bonus-packs';
import { getBonusPack, openBonusPack } from '@/api/bonus-packs-client';
import { getLocalizedText } from '@/api/payload';
import { useAuth } from '@/auth/auth-provider';
import { BonusPackShell } from '@/components/bonus-pack-shell';
import { ReadFailurePanel } from '@/components/read-failure-panel';
import { ReadStatePanel } from '@/components/read-state-panel';
import { Screen } from '@/components/screen';
import { SpecialCardFace } from '@/components/special-card-face';
import { TravelCardFace } from '@/components/travel-card-face';
import { formatKstDate } from '@/features/read/presentation';
import { useSessionDataRefresh } from '@/features/session-data/refresh-provider';
import { useI18n } from '@/i18n/locale-provider';
import { createClientRequestId } from '@/platform/client-request-id';
import { colors, radius, spacing } from '@/theme/tokens';

import { BonusPackRulesCard } from './bonus-pack-rules-card';
import { createBonusPackOpenOperation } from './open-operation';
import { playBonusPackRevealHaptic } from './reveal-haptics';
import { useHapticPreference } from './use-haptic-preference';
import { useReducedMotion } from './use-reduced-motion';

type LoadState =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'error'; error: unknown }>
  | Readonly<{ status: 'ready'; pack: BonusPack }>;

type OpenState = 'idle' | 'submitting' | 'error';

function packIdFromParam(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

export function BonusPackDetailScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const packId = packIdFromParam(params.id);
  const auth = useAuth();
  const { locale, t } = useI18n();
  const { refreshCollection } = useSessionDataRefresh();
  const { state: haptics } = useHapticPreference();
  const reducedMotion = useReducedMotion();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    state: LoadState;
  } | null>(null);
  const [openState, setOpenState] = useState<OpenState>('idle');
  const [revealVersion, setRevealVersion] = useState(0);
  const [revealedRarity, setRevealedRarity] = useState<CardRarity | null>(null);
  const [focusResult, setFocusResult] = useState(false);
  const [revealProgress] = useState(() => new Animated.Value(1));
  const [specialEffectProgress] = useState(() => new Animated.Value(1));
  const [openOperation] = useState(() => createBonusPackOpenOperation({
    createClientRequestId,
    open: openBonusPack,
  }));
  const openController = useRef<AbortController | null>(null);
  const requestKey = auth.status === 'ready' && packId !== null
    ? `${auth.session?.user.id ?? 'missing'}:${locale}:${packId}:${attempt}`
    : null;
  const state = useMemo<LoadState>(() => (
    requestKey !== null && result?.key === requestKey
      ? result.state
      : { status: 'loading' }
  ), [requestKey, result]);

  useEffect(() => {
    if (requestKey === null || packId === null) return undefined;
    const controller = new AbortController();
    void getBonusPack({ packId, locale, signal: controller.signal })
      .then((pack) => {
        if (!controller.signal.aborted) {
          openOperation.reset(packId);
          setFocusResult(false);
          setOpenState('idle');
          setResult({ key: requestKey, state: { status: 'ready', pack } });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setResult({ key: requestKey, state: { status: 'error', error } });
        }
      });
    return () => controller.abort();
  }, [locale, openOperation, packId, requestKey]);

  useEffect(() => () => openController.current?.abort(), []);

  useEffect(() => {
    openController.current?.abort();
  }, [requestKey]);

  useEffect(() => {
    if (revealVersion === 0 || reducedMotion) {
      revealProgress.setValue(1);
      specialEffectProgress.setValue(1);
      return;
    }
    const special = revealedRarity === 'special';
    const animation = Animated.parallel([
      Animated.timing(revealProgress, {
        toValue: 1,
        duration: special ? 850 : 420,
        useNativeDriver: true,
      }),
      Animated.timing(specialEffectProgress, {
        toValue: 1,
        duration: special ? 850 : 1,
        useNativeDriver: true,
      }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [
    reducedMotion,
    revealProgress,
    revealedRarity,
    revealVersion,
    specialEffectProgress,
  ]);

  const open = async () => {
    if (
      packId === null
      || state.status !== 'ready'
      || state.pack.status !== 'sealed'
      || openState === 'submitting'
    ) {
      return;
    }
    setOpenState('submitting');
    let controller: AbortController | null = null;
    try {
      controller = new AbortController();
      openController.current?.abort();
      openController.current = controller;
      const pack = await openOperation.run({
        packId,
        locale,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      revealProgress.setValue(reducedMotion ? 1 : 0);
      specialEffectProgress.setValue(reducedMotion ? 1 : 0);
      setResult({ key: requestKey ?? packId, state: { status: 'ready', pack } });
      setOpenState('idle');
      setRevealedRarity(pack.card.rarity);
      setFocusResult(true);
      setRevealVersion((current) => current + 1);
      refreshCollection();
      void playBonusPackRevealHaptic(
        !haptics.loading && !haptics.error && haptics.enabled,
      );
    } catch {
      if (controller?.signal.aborted !== true) setOpenState('error');
    }
  };

  const handleResultFocus = useCallback(() => setFocusResult(false), []);

  if (auth.status === 'error' || auth.status === 'signed_out') {
    return (
      <Screen>
        <BackButton />
        <ReadStatePanel
          actionLabel={t('common.restoreSession')}
          body={t('common.sessionBody')}
          onAction={auth.retry}
          title={t('common.sessionTitle')}
        />
      </Screen>
    );
  }

  if (packId === null) {
    return (
      <Screen>
        <BackButton />
        <ReadStatePanel
          actionLabel={t('bonusPack.backToCards')}
          body={t('common.errorBody')}
          onAction={() => router.replace('/(tabs)/collection')}
          title={t('common.errorTitle')}
        />
      </Screen>
    );
  }

  if (state.status === 'loading') {
    return (
      <Screen>
        <BackButton />
        <ReadStatePanel
          body={t('bonusPack.listBody')}
          loading
          title={t('bonusPack.loading')}
        />
      </Screen>
    );
  }

  if (state.status === 'error') {
    return (
      <Screen>
        <BackButton />
        <ReadFailurePanel
          error={state.error}
          onRestoreSession={auth.retry}
          onRetry={() => setAttempt((current) => current + 1)}
        />
      </Screen>
    );
  }

  return state.pack.status === 'sealed'
    ? (
        <SealedPack
          dateKst={state.pack.dateKst}
          locale={locale}
          onOpen={() => void open()}
          openState={openState}
        />
      )
    : (
        <OpenedPack
          pack={state.pack}
          focusResult={focusResult}
          onFocusHandled={handleResultFocus}
          reducedMotion={reducedMotion}
          revealProgress={revealProgress}
          revealVersion={revealVersion}
          specialEffectProgress={specialEffectProgress}
        />
      );
}

function BackButton() {
  const { t } = useI18n();
  return (
    <Pressable
      accessibilityRole="button"
      hitSlop={8}
      onPress={() => router.back()}
      style={({ pressed }) => [styles.back, pressed ? styles.pressed : null]}
    >
      <Text style={styles.backLabel}>‹ {t('common.back')}</Text>
    </Pressable>
  );
}

function SealedPack({
  dateKst,
  locale,
  onOpen,
  openState,
}: {
  dateKst: string;
  locale: Parameters<typeof formatKstDate>[1];
  onOpen(): void;
  openState: OpenState;
}) {
  const { t } = useI18n();
  return (
    <Screen contentStyle={styles.screenContent}>
      <BackButton />
      <Text accessibilityRole="header" style={styles.title}>
        {t('bonusPack.detailTitle')}
      </Text>
      <Text style={styles.date}>
        {t('bonusPack.received')} · {formatKstDate(dateKst, locale)}
      </Text>
      <View
        accessible
        accessibilityLabel={`${t('bonusPack.sealed')}. ${t('bonusPack.sealedBody')}`}
        accessibilityRole="image"
        style={styles.packHero}
      >
        <BonusPackShell />
      </View>
      <Text style={styles.centerTitle}>{t('bonusPack.sealedTitle')}</Text>
      <Text style={styles.centerBody}>{t('bonusPack.sealedBody')}</Text>
      <BonusPackRulesCard />
      {openState === 'error' ? (
        <View accessibilityLiveRegion="assertive" style={styles.errorPanel}>
          <Text style={styles.errorTitle}>{t('bonusPack.openErrorTitle')}</Text>
          <Text style={styles.errorBody}>{t('bonusPack.openErrorBody')}</Text>
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ busy: openState === 'submitting', disabled: openState === 'submitting' }}
        disabled={openState === 'submitting'}
        onPress={onOpen}
        style={({ pressed }) => [
          styles.openButton,
          pressed ? styles.pressed : null,
          openState === 'submitting' ? styles.disabled : null,
        ]}
      >
        {openState === 'submitting' ? (
          <ActivityIndicator color={colors.white} size="small" />
        ) : null}
        <Text style={styles.openButtonLabel}>
          {t(openState === 'submitting'
            ? 'bonusPack.opening'
            : openState === 'error'
              ? 'common.retry'
              : 'bonusPack.openAction')}
        </Text>
      </Pressable>
    </Screen>
  );
}

function OpenedPack({
  pack,
  focusResult,
  onFocusHandled,
  reducedMotion,
  revealProgress,
  revealVersion,
  specialEffectProgress,
}: {
  pack: OpenedBonusPack;
  focusResult: boolean;
  onFocusHandled(): void;
  reducedMotion: boolean;
  revealProgress: Animated.Value;
  revealVersion: number;
  specialEffectProgress: Animated.Value;
}) {
  const auth = useAuth();
  const { locale, t } = useI18n();
  const resultHeadingRef = useRef<ComponentRef<typeof Text>>(null);
  const special = pack.card.rarity === 'special';
  const title = getLocalizedText(pack.card.title, locale, t('common.untitled'));
  const rarityLabel = t(special
    ? 'bonusPack.raritySpecial'
    : 'bonusPack.rarityCommon');

  useEffect(() => {
    if (!focusResult || revealVersion === 0) return undefined;
    const timeout = setTimeout(() => {
      const node = findNodeHandle(resultHeadingRef.current);
      if (node !== null) AccessibilityInfo.setAccessibilityFocus(node);
      onFocusHandled();
    }, reducedMotion ? 0 : 900);
    return () => clearTimeout(timeout);
  }, [focusResult, onFocusHandled, reducedMotion, revealVersion]);

  return (
    <Screen contentStyle={styles.screenContent}>
      <BackButton />
      <Text accessibilityRole="header" style={styles.title}>
        {t('bonusPack.openedTitle')}
      </Text>
      <Text
        accessibilityRole="header"
        accessibilityLiveRegion={revealVersion > 0 ? 'assertive' : 'none'}
        ref={resultHeadingRef}
        style={styles.announcement}
      >
        {t(special
          ? 'bonusPack.resultAnnouncementSpecial'
          : 'bonusPack.resultAnnouncementCommon')} {title}
      </Text>
      <Animated.View
        accessible
        accessibilityLabel={`${rarityLabel}. ${title}.`}
        accessibilityRole="image"
        style={[
          styles.cardHero,
          {
            opacity: revealProgress,
            transform: [{
              scale: revealProgress.interpolate({
                inputRange: [0, 1],
                outputRange: [special ? 0.86 : 0.95, 1],
              }),
            }, {
              translateY: revealProgress.interpolate({
                inputRange: [0, 1],
                outputRange: [special ? 22 : 8, 0],
              }),
            }],
          },
        ]}
      >
        {special ? <SpecialRevealEffect progress={specialEffectProgress} /> : null}
        {special ? (
          <SpecialCardFace
            artPendingLabel={t('bonusPack.artPending')}
            colorHex={pack.card.colorHex}
            imageAuthorization={auth.session?.access_token ?? null}
            imageUrl={pack.card.imageUrl}
            imageRequestVersion={auth.session?.expires_at ?? 0}
            style={styles.specialCardSurface}
          />
        ) : (
          <TravelCardFace
            acquired
            colorHex={pack.card.colorHex}
            imageUrl={pack.card.imageUrl}
            title={title}
            variant="hero"
          />
        )}
        {special ? <SpecialRevealShine progress={specialEffectProgress} /> : null}
      </Animated.View>
      <View style={styles.resultCopy}>
        <View style={[styles.rarityPill, special ? styles.specialPill : null]}>
          <Text style={[styles.rarityText, special ? styles.specialText : null]}>
            {special ? '✦ ' : '● '}{rarityLabel}
          </Text>
        </View>
        <Text style={styles.resultTitle}>{title}</Text>
        <Text style={styles.date}>
          {t('bonusPack.received')} · {formatKstDate(pack.dateKst, locale)}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={() => router.replace('/card-inventory')}
        style={({ pressed }) => [styles.inventoryButton, pressed ? styles.pressed : null]}
      >
        <Text style={styles.inventoryButtonLabel}>{t('inventory.open')}</Text>
      </Pressable>
    </Screen>
  );
}

const PARTICLES = [
  { top: '7%', left: '8%', size: 7 },
  { top: '2%', right: '16%', size: 5 },
  { top: '25%', left: '-3%', size: 5 },
  { top: '30%', right: '-2%', size: 8 },
  { bottom: '24%', left: '-2%', size: 6 },
  { right: '3%', bottom: '18%', size: 5 },
  { bottom: '2%', left: '17%', size: 5 },
  { right: '20%', bottom: '4%', size: 7 },
] as const;

function SpecialRevealEffect({ progress }: { progress: Animated.Value }) {
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={styles.effectBoundary}
    >
      <Animated.View
        style={[
          styles.goldBurst,
          {
            opacity: progress.interpolate({
              inputRange: [0, 0.35, 1],
              outputRange: [0, 0.58, 0.34],
            }),
            transform: [{
              scale: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [0.82, 1.18],
              }),
            }],
          },
        ]}
      >
        {Array.from({ length: 8 }, (_, index) => (
          <View
            key={index}
            style={[styles.goldRay, { transform: [{ rotate: `${index * 45}deg` }] }]}
          />
        ))}
        <View style={styles.goldRingOuter} />
        <View style={styles.goldRingInner} />
      </Animated.View>
      <Animated.View
        style={[
          styles.particleLayer,
          {
            opacity: progress.interpolate({
              inputRange: [0, 0.42, 1],
              outputRange: [0, 0.9, 0.72],
            }),
            transform: [{
              scale: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [0.76, 1],
              }),
            }],
          },
        ]}
      >
        {PARTICLES.map(({ size, ...position }, index) => (
          <View
            key={index}
            style={[
              styles.goldParticle,
              position,
              { width: size, height: size },
            ]}
          />
        ))}
      </Animated.View>
    </View>
  );
}

function SpecialRevealShine({ progress }: { progress: Animated.Value }) {
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={styles.shineClip}
    >
      <Animated.View
        style={[
          styles.shine,
          {
            opacity: progress.interpolate({
              inputRange: [0, 0.2, 0.78, 1],
              outputRange: [0, 0.24, 0.24, 0],
            }),
            transform: [
              { rotate: '14deg' },
              {
                translateX: progress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [-260, 260],
                }),
              },
            ],
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screenContent: { gap: spacing.md },
  back: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center' },
  backLabel: { color: colors.accent, fontSize: 14, fontWeight: '800' },
  title: { color: colors.ink, fontSize: 29, fontWeight: '900', letterSpacing: -0.8 },
  date: { color: colors.mutedInk, fontSize: 12, textAlign: 'center' },
  packHero: { width: '68%', maxWidth: 300, alignSelf: 'center', marginVertical: spacing.sm },
  cardHero: { width: '80%', maxWidth: 360, alignSelf: 'center', marginVertical: spacing.md },
  specialCardSurface: { zIndex: 2 },
  effectBoundary: {
    position: 'absolute',
    top: '-10%',
    right: '-12%',
    bottom: '-10%',
    left: '-12%',
  },
  goldBurst: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  goldRay: {
    position: 'absolute',
    width: 2,
    height: '116%',
    borderRadius: 2,
    backgroundColor: '#C9A861',
  },
  goldRingOuter: {
    position: 'absolute',
    width: '96%',
    aspectRatio: 1,
    borderWidth: 2,
    borderColor: '#C9A861',
    borderRadius: 999,
  },
  goldRingInner: {
    position: 'absolute',
    width: '78%',
    aspectRatio: 1,
    borderWidth: 1,
    borderColor: '#F1DCA2',
    borderRadius: 999,
  },
  particleLayer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  goldParticle: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: '#FFF0B5',
    borderRadius: 999,
    backgroundColor: '#B98E39',
  },
  shineClip: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 3,
    overflow: 'hidden',
    borderRadius: 22,
  },
  shine: {
    position: 'absolute',
    top: '-15%',
    bottom: '-15%',
    width: 66,
    backgroundColor: '#FFF4CF',
  },
  centerTitle: { color: colors.ink, fontSize: 20, fontWeight: '900', textAlign: 'center' },
  centerBody: { color: colors.mutedInk, fontSize: 14, lineHeight: 22, textAlign: 'center' },
  errorPanel: {
    padding: spacing.md,
    borderWidth: 1,
    borderColor: '#DAB1A7',
    borderRadius: radius.md,
    backgroundColor: '#F8E8E3',
  },
  errorTitle: { color: colors.stamp, fontSize: 14, fontWeight: '900' },
  errorBody: { marginTop: spacing.xs, color: colors.mutedInk, fontSize: 12, lineHeight: 19 },
  openButton: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: '#985B5E',
  },
  openButtonLabel: { color: colors.white, fontSize: 15, fontWeight: '900' },
  announcement: { color: colors.accent, fontSize: 14, fontWeight: '800', textAlign: 'center' },
  resultCopy: { alignItems: 'center', gap: spacing.sm },
  rarityPill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: colors.accentSoft },
  specialPill: { borderWidth: 1, borderColor: colors.cardGold, backgroundColor: '#F0E1C3' },
  rarityText: { color: colors.accent, fontSize: 11, fontWeight: '900', letterSpacing: 0.7 },
  specialText: { color: '#73572E' },
  resultTitle: { color: colors.ink, fontSize: 22, fontWeight: '900', textAlign: 'center' },
  inventoryButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.pill,
    backgroundColor: colors.white,
  },
  inventoryButtonLabel: { color: colors.accent, fontSize: 14, fontWeight: '800' },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.62 },
});
