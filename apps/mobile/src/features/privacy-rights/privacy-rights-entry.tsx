import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { getLocationConsent, setLocationConsentState, withdrawLocationConsent } from '@/api/location-consent-client';
import type { LocationConsentResult } from '@/api/location-consent';
import { getLocationCorrectionSubjectsPage, getLocationCorrectionsPage, getLocationUseFactsPage, submitLocationCorrection } from '@/api/location-rights-client';
import type { LocationCorrection, LocationCorrectionReason, LocationCorrectionSubject, LocationUseFact } from '@/api/location-rights';
import { getCurrentPolicies } from '@/api/public-policies-client';
import type { CurrentPolicy } from '@/api/policies';
import { ApiResponseError } from '@/api/client';
import { usePrivacyRightsSession } from '@/auth/privacy-rights-session-provider';
import { Screen } from '@/components/screen';
import { getRuntimeEnvironment } from '@/config/runtime-environment';
import { useAccountDeletion } from '@/features/account-deletion/provider';
import { resolvePublicAccountDeletionUrl } from '@/features/account-deletion/public-page';
import { usePolicySupport } from '@/features/policy-support/provider';
import { useI18n } from '@/i18n/locale-provider';
import { createClientRequestId } from '@/platform/client-request-id';
import { colors, radius, spacing } from '@/theme/tokens';
import { formatKstDate } from '@/features/read/presentation';

import {
  correctionAttemptFor,
  shouldRetainCorrectionAttempt,
  type CorrectionAttempt,
} from './correction-attempt';
import {
  correctionTarget,
  failureTranslationSuffix,
  formatKstDateTime,
} from './presentation';

type RightsState =
  | { status: 'loading' }
  | { status: 'ready'; consent: LocationConsentResult; facts: readonly LocationUseFact[] | null; factsNextCursor: string | null; subjects: readonly LocationCorrectionSubject[] | null; subjectsNextCursor: string | null; corrections: readonly LocationCorrection[] | null; correctionsNextCursor: string | null; locationPolicy: CurrentPolicy | null }
  | { status: 'error'; sessionLost: boolean };

export function PrivacyRightsEntry({ onExit }: { onExit(): void }) {
  const session = usePrivacyRightsSession();
  const accountDeletion = useAccountDeletion();
  const policySupport = usePolicySupport();
  const { locale, t } = useI18n();
  const [state, setState] = useState<RightsState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [mutating, setMutating] = useState(false);
  const [mutationFailed, setMutationFailed] = useState(false);
  const [correctionReason, setCorrectionReason] = useState<LocationCorrectionReason>('incorrect_outcome');
  const [correctionAttempt, setCorrectionAttempt] = useState<CorrectionAttempt | null>(null);
  const [correctionSubmitted, setCorrectionSubmitted] = useState(false);
  const [loadingMore, setLoadingMore] = useState<'facts' | 'subjects' | 'corrections' | null>(null);
  const [pageFailed, setPageFailed] = useState<'facts' | 'subjects' | 'corrections' | null>(null);
  const [confirmingDeletion, setConfirmingDeletion] = useState(false);
  const [deletionStarting, setDeletionStarting] = useState(false);
  const [deletionFailed, setDeletionFailed] = useState(false);
  const [publicPageFailed, setPublicPageFailed] = useState(false);
  const pageRequest = useRef<{
    controller: AbortController;
    generation: number;
  } | null>(null);
  const dataGeneration = useRef(0);

  useEffect(() => () => {
    pageRequest.current?.controller.abort();
  }, []);

  useEffect(() => {
    if (session.status !== 'ready') {
      return;
    }
    let active = true;
    const controller = new AbortController();
    void getLocationConsent(controller.signal).then(async (consent) => {
      const [factsResult, subjectsResult, correctionsResult, policiesResult] = await Promise.allSettled([
        getLocationUseFactsPage({ limit: 50, signal: controller.signal }),
        getLocationCorrectionSubjectsPage({ limit: 50, signal: controller.signal }),
        getLocationCorrectionsPage({ limit: 50, signal: controller.signal }),
        getCurrentPolicies(controller.signal),
      ]);
      if (active) {
        setState({
          status: 'ready',
          consent,
          facts: factsResult.status === 'fulfilled' ? factsResult.value.items : null,
          factsNextCursor: factsResult.status === 'fulfilled' ? factsResult.value.nextCursor : null,
          subjects: subjectsResult.status === 'fulfilled' ? subjectsResult.value.items : null,
          subjectsNextCursor: subjectsResult.status === 'fulfilled' ? subjectsResult.value.nextCursor : null,
          corrections: correctionsResult.status === 'fulfilled' ? correctionsResult.value.items : null,
          correctionsNextCursor: correctionsResult.status === 'fulfilled'
            ? correctionsResult.value.nextCursor
            : null,
          locationPolicy: policiesResult.status === 'fulfilled'
            ? policiesResult.value.find(({ type }) => type === 'location_terms') ?? null
            : null,
        });
      }
    }).catch((error: unknown) => {
      if (active) {
        setState({
          status: 'error',
          sessionLost: error instanceof ApiResponseError && error.code === 'UNAUTHORIZED',
        });
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [attempt, session.status]);

  const refresh = () => {
    dataGeneration.current += 1;
    pageRequest.current?.controller.abort();
    pageRequest.current = null;
    setLoadingMore(null);
    setPageFailed(null);
    setState({ status: 'loading' });
    setAttempt((current) => current + 1);
  };
  const mutate = async (operation: () => Promise<unknown>) => {
    if (mutating) return;
    setMutating(true);
    setMutationFailed(false);
    try {
      await operation();
      refresh();
    } catch {
      setMutationFailed(true);
    } finally {
      setMutating(false);
    }
  };
  const submitCorrection = async (input: { subject: string; factId?: number; acquisitionId?: string }) => {
    if (mutating) return;
    const attemptForRequest = correctionAttemptFor({
      previous: correctionAttempt,
      subject: input.subject,
      reason: correctionReason,
      createClientRequestId,
    });
    const { clientRequestId } = attemptForRequest;
    setCorrectionAttempt(attemptForRequest);
    setCorrectionSubmitted(false);
    setMutationFailed(false);
    setMutating(true);
    try {
      await submitLocationCorrection({
        ...(input.factId === undefined
          ? { fieldAcquisitionId: input.acquisitionId! }
          : { locationUseFactId: input.factId }),
        clientRequestId,
        reason: correctionReason,
      });
      setCorrectionAttempt(null);
      setCorrectionSubmitted(true);
      refresh();
    } catch (error) {
      if (!shouldRetainCorrectionAttempt(error)) {
        setCorrectionAttempt(null);
      }
      setMutationFailed(true);
    } finally {
      setMutating(false);
    }
  };
  const loadMore = async (kind: 'facts' | 'subjects' | 'corrections', cursor: string) => {
    if (pageRequest.current !== null || state.status !== 'ready') return;
    const controller = new AbortController();
    const generation = dataGeneration.current;
    pageRequest.current = { controller, generation };
    setLoadingMore(kind);
    setPageFailed(null);
    try {
      if (kind === 'facts') {
        const page = await getLocationUseFactsPage({
          limit: 50,
          cursor,
          signal: controller.signal,
        });
        if (generation !== dataGeneration.current) return;
        setState((current) => current.status === 'ready'
          && current.factsNextCursor === cursor ? {
            ...current,
            facts: appendUnique(
              current.facts ?? [],
              page.items,
              ({ id }) => String(id),
            ),
            factsNextCursor: page.nextCursor === cursor ? null : page.nextCursor,
          } : current);
      } else if (kind === 'subjects') {
        const page = await getLocationCorrectionSubjectsPage({
          limit: 50,
          cursor,
          signal: controller.signal,
        });
        if (generation !== dataGeneration.current) return;
        setState((current) => current.status === 'ready'
          && current.subjectsNextCursor === cursor ? {
            ...current,
            subjects: appendUnique(
              current.subjects ?? [],
              page.items,
              ({ fieldAcquisitionId }) => fieldAcquisitionId,
            ),
            subjectsNextCursor: page.nextCursor === cursor ? null : page.nextCursor,
          } : current);
      } else {
        const page = await getLocationCorrectionsPage({
          limit: 50,
          cursor,
          signal: controller.signal,
        });
        if (generation !== dataGeneration.current) return;
        setState((current) => current.status === 'ready'
          && current.correctionsNextCursor === cursor ? {
            ...current,
            corrections: appendUnique(
              current.corrections ?? [],
              page.items,
              ({ id }) => id,
            ),
            correctionsNextCursor: page.nextCursor === cursor ? null : page.nextCursor,
          } : current);
      }
    } catch {
      if (!controller.signal.aborted && generation === dataGeneration.current) {
        setPageFailed(kind);
      }
    } finally {
      if (pageRequest.current?.controller === controller) {
        pageRequest.current = null;
        setLoadingMore(null);
      }
    }
  };

  return (
    <Screen>
      <Text accessibilityRole="header" style={styles.title}>{t('privacyRights.title')}</Text>
      <Text style={styles.body}>{t('privacyRights.body')}</Text>
      <Pressable accessibilityRole="button" onPress={onExit} style={styles.linkButton}>
        <Text style={styles.linkLabel}>{t('common.back')}</Text>
      </Pressable>

      {session.status === 'checking' ? <Loading label={t('common.loading')} /> : null}
      {session.status === 'no_session' ? (
        <>
          <StatusCard
            title={t('privacyRights.noSessionTitle')}
            body={t('privacyRights.noSessionBody')}
            action={t('accountDeletion.openPublicPage')}
            onAction={() => {
              setPublicPageFailed(false);
              void Promise.resolve()
                .then(() => Linking.openURL(resolvePublicAccountDeletionUrl(
                  getRuntimeEnvironment().apiBaseUrl,
                )))
                .catch(() => setPublicPageFailed(true));
            }}
          />
          {publicPageFailed ? (
            <Text accessibilityLiveRegion="assertive" style={styles.error}>
              {t('accountDeletion.publicPageError')}
            </Text>
          ) : null}
        </>
      ) : null}
      {session.status === 'error' ? (
        <StatusCard
          title={t('privacyRights.sessionErrorTitle')}
          body={t('privacyRights.sessionErrorBody')}
          action={t('common.retry')}
          onAction={session.retry}
        />
      ) : null}
      {session.status === 'ready' && state.status === 'loading' ? (
        <Loading label={t('common.loading')} />
      ) : null}
      {session.status === 'ready' && state.status === 'error' ? (
        state.sessionLost ? (
          <StatusCard
            title={t('privacyRights.noSessionTitle')}
            body={t('privacyRights.noSessionBody')}
          />
        ) : (
          <StatusCard
            title={t('common.errorTitle')}
            body={t('common.errorBody')}
            action={t('common.retry')}
            onAction={refresh}
          />
        )
      ) : null}
      {session.status === 'ready' && state.status === 'ready' ? (
        <>
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>{t('privacyRights.consentTitle')}</Text>
            <Text style={styles.body}>{consentDescription(state.consent, t)}</Text>
            {state.locationPolicy === null ? null : (
              <Pressable
                accessibilityRole="link"
                onPress={() => policySupport.openPolicy('location_terms')}
                style={styles.linkButton}
              >
                <Text style={styles.linkLabel}>{t('privacyRights.openTerms')}</Text>
              </Pressable>
            )}
            {state.consent.status === 'found' && state.consent.consent.state === 'active' ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ busy: mutating, disabled: mutating }}
                disabled={mutating}
                onPress={() => void mutate(() => setLocationConsentState({ state: 'paused' }))}
                style={styles.secondaryButton}
              >
                <Text style={styles.secondaryLabel}>{t('privacyRights.pause')}</Text>
              </Pressable>
            ) : null}
            {state.consent.status === 'missing'
              || state.consent.consent.state !== 'withdrawal_pending' ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ busy: mutating, disabled: mutating }}
                disabled={mutating}
                onPress={() => void mutate(() => withdrawLocationConsent())}
                style={styles.dangerButton}
              >
                <Text style={styles.dangerLabel}>{t('privacyRights.withdraw')}</Text>
              </Pressable>
            ) : null}
            {mutationFailed ? (
              <Text accessibilityLiveRegion="assertive" style={styles.error}>
                {t('privacyRights.mutationError')}
              </Text>
            ) : null}
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>{t('privacyRights.factsTitle')}</Text>
            <Text style={styles.body}>{t('privacyRights.factsBody')}</Text>
            <Text style={styles.subheading}>{t('privacyRights.correctionReason')}</Text>
            <View style={styles.reasonRow}>
              {(['not_my_visit', 'wrong_spot', 'incorrect_outcome', 'other'] as const).map((reason) => (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ checked: correctionReason === reason }}
                  key={reason}
                  onPress={() => {
                    setCorrectionReason(reason);
                    setCorrectionAttempt(null);
                  }}
                  style={[styles.reasonButton, correctionReason === reason ? styles.reasonSelected : null]}
                >
                  <Text style={correctionReason === reason ? styles.reasonSelectedLabel : styles.reasonLabel}>
                    {t(`privacyRights.reason.${reason}`)}
                  </Text>
                </Pressable>
              ))}
            </View>
            {state.facts === null ? <Text style={styles.error}>{t('privacyRights.sectionError')}</Text> : state.facts.length === 0 ? <Text style={styles.muted}>{t('privacyRights.empty')}</Text> : (
              state.facts.map((fact) => (
                <View key={fact.id} style={styles.itemGroup}>
                  <Text style={styles.item}>
                    {t('privacyRights.factId')}: {fact.id}
                  </Text>
                  <Text style={styles.item}>
                    {t('privacyRights.collectedAt')}: {formatKstDateTime(fact.collectedAt, locale)}
                  </Text>
                  <Text style={styles.item}>
                    {t('privacyRights.spotId')}: {fact.spotId}
                  </Text>
                  <Text style={styles.item}>
                    {t('privacyRights.outcome')}: {t(`privacyRights.outcome.${fact.outcome}`)}
                  </Text>
                  {fact.decidedAt === null ? null : (
                    <Text style={styles.item}>
                      {t('privacyRights.decidedAt')}: {formatKstDateTime(fact.decidedAt, locale)}
                    </Text>
                  )}
                  {fact.failure === null ? null : (
                    <Text style={styles.item}>
                      {t('privacyRights.failure')}: {t(
                        `privacyRights.failure.${failureTranslationSuffix(fact.failure)}`,
                      )}
                      {fact.failure.code === 'OUT_OF_RANGE'
                        ? ` · ${t('privacyRights.distanceBand')}: ${t(
                            `privacyRights.distanceBand.${fact.failure.details.distanceBand}`,
                          )}`
                        : ''}
                    </Text>
                  )}
                  <ActionButton
                    disabled={mutating}
                    label={t('privacyRights.requestCorrection')}
                    onPress={() => void submitCorrection({ subject: `fact:${fact.id}`, factId: fact.id })}
                  />
                </View>
              ))
            )}
            {state.factsNextCursor === null ? null : (
              <ActionButton
                busy={loadingMore === 'facts'}
                disabled={loadingMore !== null}
                label={t(loadingMore === 'facts' ? 'common.loading' : 'privacyRights.loadMore')}
                onPress={() => void loadMore('facts', state.factsNextCursor!)}
              />
            )}
            {pageFailed === 'facts' ? (
              <Text accessibilityLiveRegion="assertive" style={styles.error}>
                {t('privacyRights.pageError')}
              </Text>
            ) : null}
            {state.subjects === null ? <Text style={styles.error}>{t('privacyRights.sectionError')}</Text> : state.subjects.map((subject) => (
              <View key={subject.fieldAcquisitionId} style={styles.itemGroup}>
                <Text style={styles.item}>
                  {formatKstDate(subject.acquiredOnKst, locale)} · {t('privacyRights.fieldVisit')}
                </Text>
                <Text style={styles.item}>{t('privacyRights.spotId')}: {subject.spotId}</Text>
                <ActionButton
                  disabled={mutating}
                  label={t('privacyRights.requestCorrection')}
                  onPress={() => void submitCorrection({
                    subject: `acquisition:${subject.fieldAcquisitionId}`,
                    acquisitionId: subject.fieldAcquisitionId,
                  })}
                />
              </View>
            ))}
            {state.subjectsNextCursor === null ? null : (
              <ActionButton
                busy={loadingMore === 'subjects'}
                disabled={loadingMore !== null}
                label={t(loadingMore === 'subjects' ? 'common.loading' : 'privacyRights.loadMore')}
                onPress={() => void loadMore('subjects', state.subjectsNextCursor!)}
              />
            )}
            {pageFailed === 'subjects' ? (
              <Text accessibilityLiveRegion="assertive" style={styles.error}>
                {t('privacyRights.pageError')}
              </Text>
            ) : null}
            {correctionSubmitted ? (
              <Text accessibilityLiveRegion="polite" style={styles.success}>
                {t('privacyRights.correctionSubmitted')}
              </Text>
            ) : null}
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>{t('privacyRights.correctionsTitle')}</Text>
            <Text style={styles.body}>{t('privacyRights.correctionsBody')}</Text>
            {state.corrections === null ? <Text style={styles.error}>{t('privacyRights.sectionError')}</Text> : state.corrections.length === 0 ? <Text style={styles.muted}>{t('privacyRights.empty')}</Text> : (
              state.corrections.map((correction) => {
                const target = correctionTarget(correction);
                return (
                  <View key={correction.id} style={styles.itemGroup}>
                    <Text style={styles.item}>
                      {t('privacyRights.correctionId')}: {correction.id}
                    </Text>
                    <Text style={styles.item}>
                      {t('privacyRights.requestedAt')}: {formatKstDateTime(correction.requestedAt, locale)}
                    </Text>
                    <Text style={styles.item}>
                      {t('privacyRights.correctionReason')}: {t(
                        `privacyRights.reason.${correction.reason}`,
                      )}
                    </Text>
                    <Text style={styles.item}>
                      {t('privacyRights.correctionTarget')}: {target.kind === 'erased'
                        ? t('privacyRights.targetErased')
                        : `${t(
                            target.kind === 'fact'
                              ? 'privacyRights.targetFact'
                              : 'privacyRights.targetAcquisition',
                          )} ${target.id}`}
                    </Text>
                    <Text style={styles.item}>
                      {t('privacyRights.status')}: {t(
                        `privacyRights.status.${correction.status}`,
                      )}
                    </Text>
                    {correction.resolvedAt === null ? null : (
                      <Text style={styles.item}>
                        {t('privacyRights.resolvedAt')}: {formatKstDateTime(correction.resolvedAt, locale)}
                      </Text>
                    )}
                  </View>
                );
              })
            )}
            {state.correctionsNextCursor === null ? null : (
              <ActionButton
                busy={loadingMore === 'corrections'}
                disabled={loadingMore !== null}
                label={t(loadingMore === 'corrections' ? 'common.loading' : 'privacyRights.loadMore')}
                onPress={() => void loadMore('corrections', state.correctionsNextCursor!)}
              />
            )}
            {pageFailed === 'corrections' ? (
              <Text accessibilityLiveRegion="assertive" style={styles.error}>
                {t('privacyRights.pageError')}
              </Text>
            ) : null}
          </View>
        </>
      ) : null}
      {session.status === 'ready' ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>
            {t(confirmingDeletion
              ? 'accountDeletion.confirmTitle'
              : 'accountDeletion.requestTitle')}
          </Text>
          <Text style={styles.body}>
            {t(confirmingDeletion
              ? 'accountDeletion.confirmBody'
              : 'accountDeletion.requestBody')}
          </Text>
          {Platform.OS === 'web' ? (
            <Pressable
              accessibilityRole="link"
              onPress={() => {
                setPublicPageFailed(false);
                void Promise.resolve()
                  .then(() => Linking.openURL(resolvePublicAccountDeletionUrl(
                    getRuntimeEnvironment().apiBaseUrl,
                  )))
                  .catch(() => setPublicPageFailed(true));
              }}
              style={styles.dangerButton}
            >
              <Text style={styles.dangerLabel}>
                {t('accountDeletion.openPublicPage')}
              </Text>
            </Pressable>
          ) : confirmingDeletion ? (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{
                  busy: deletionStarting,
                  disabled: deletionStarting,
                }}
                disabled={deletionStarting}
                onPress={() => {
                  if (deletionStarting) return;
                  setDeletionStarting(true);
                  setDeletionFailed(false);
                  void accountDeletion.begin()
                    .catch(() => setDeletionFailed(true))
                    .finally(() => setDeletionStarting(false));
                }}
                style={styles.dangerButton}
              >
                <Text style={styles.dangerLabel}>
                  {t(deletionStarting
                    ? 'common.loading'
                    : 'accountDeletion.confirmAction')}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={deletionStarting}
                onPress={() => {
                  setConfirmingDeletion(false);
                  setDeletionFailed(false);
                }}
                style={styles.secondaryButton}
              >
                <Text style={styles.secondaryLabel}>{t('common.back')}</Text>
              </Pressable>
            </>
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setConfirmingDeletion(true);
                setDeletionFailed(false);
              }}
              style={styles.dangerButton}
            >
              <Text style={styles.dangerLabel}>
                {t('accountDeletion.requestAction')}
              </Text>
            </Pressable>
          )}
          {deletionFailed ? (
            <Text accessibilityLiveRegion="assertive" style={styles.error}>
              {t('accountDeletion.startError')}
            </Text>
          ) : null}
          {publicPageFailed ? (
            <Text accessibilityLiveRegion="assertive" style={styles.error}>
              {t('accountDeletion.publicPageError')}
            </Text>
          ) : null}
        </View>
      ) : null}
    </Screen>
  );
}

function consentDescription(consent: LocationConsentResult, t: ReturnType<typeof useI18n>['t']) {
  if (consent.status === 'missing') return t('privacyRights.consentMissing');
  if (consent.consent.state === 'paused') return t('privacyRights.consentPaused');
  if (consent.consent.state === 'withdrawal_pending') return t('privacyRights.consentWithdrawal');
  return consent.consent.isCurrent
    ? t('privacyRights.consentActive')
    : t('privacyRights.consentStale');
}

function Loading({ label }: { label: string }) {
  return (
    <ActivityIndicator
      accessibilityLabel={label}
      color={colors.accent}
      size="large"
      style={styles.loading}
    />
  );
}

function StatusCard({ title, body, action, onAction }: {
  title: string;
  body: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.body}>{body}</Text>
      {action && onAction ? (
        <Pressable accessibilityRole="button" onPress={onAction} style={styles.secondaryButton}>
          <Text style={styles.secondaryLabel}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ActionButton({ label, onPress, disabled, busy = false }: {
  label: string;
  onPress(): void;
  disabled: boolean;
  busy?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={styles.inlineButton}
    >
      <Text style={styles.linkLabel}>{label}</Text>
    </Pressable>
  );
}

function appendUnique<T>(
  current: readonly T[],
  next: readonly T[],
  key: (value: T) => string,
): readonly T[] {
  const seen = new Set(current.map(key));
  return [
    ...current,
    ...next.filter((value) => {
      const candidate = key(value);
      if (seen.has(candidate)) return false;
      seen.add(candidate);
      return true;
    }),
  ];
}

const styles = StyleSheet.create({
  title: { marginTop: spacing.xl, color: colors.ink, fontSize: 28, fontWeight: '800' },
  body: { marginTop: spacing.sm, color: colors.mutedInk, fontSize: 14, lineHeight: 22 },
  loading: { marginTop: spacing.xxl },
  card: { marginTop: spacing.lg, padding: spacing.lg, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.white },
  sectionTitle: { color: colors.ink, fontSize: 17, fontWeight: '700' },
  muted: { marginTop: spacing.md, color: colors.mutedInk, fontSize: 13 },
  item: { marginTop: spacing.md, color: colors.ink, fontSize: 13 },
  itemGroup: { marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  subheading: { marginTop: spacing.md, color: colors.ink, fontSize: 13, fontWeight: '700' },
  reasonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.sm },
  reasonButton: { minHeight: 36, justifyContent: 'center', paddingHorizontal: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill },
  reasonSelected: { borderColor: colors.accent, backgroundColor: colors.accent },
  reasonLabel: { color: colors.ink, fontSize: 12 },
  reasonSelectedLabel: { color: colors.white, fontSize: 12, fontWeight: '700' },
  inlineButton: { minHeight: 40, alignSelf: 'flex-start', justifyContent: 'center', marginTop: spacing.xs },
  success: { marginTop: spacing.md, color: colors.accent, fontSize: 13, lineHeight: 20 },
  error: { marginTop: spacing.md, color: colors.stamp, fontSize: 13, lineHeight: 20 },
  linkButton: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center', marginTop: spacing.md },
  linkLabel: { color: colors.accent, fontSize: 14, fontWeight: '700' },
  secondaryButton: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center', marginTop: spacing.md, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.accent, borderRadius: radius.pill },
  secondaryLabel: { color: colors.accent, fontSize: 13, fontWeight: '700' },
  dangerButton: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center', marginTop: spacing.md, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.stamp, borderRadius: radius.pill },
  dangerLabel: { color: colors.stamp, fontSize: 13, fontWeight: '700' },
});
