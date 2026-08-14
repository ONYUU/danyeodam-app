import type {
  LocationCorrection,
  LocationFactFailure,
} from '@/api/location-rights';
import type { SupportedLocale } from '@/i18n/locales';

const DATE_TIME_LOCALES: Record<SupportedLocale, string> = {
  ko: 'ko-KR',
  en: 'en-US',
  ja: 'ja-JP',
  'zh-Hans': 'zh-CN',
  'zh-Hant': 'zh-TW',
  vi: 'vi-VN',
};

export function formatKstDateTime(
  value: string,
  locale: SupportedLocale,
): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    return value;
  }
  try {
    return new Intl.DateTimeFormat(DATE_TIME_LOCALES[locale], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: 'Asia/Seoul',
      timeZoneName: 'short',
    }).format(instant);
  } catch {
    return value;
  }
}

export type CorrectionTarget =
  | { kind: 'fact'; id: string }
  | { kind: 'acquisition'; id: string }
  | { kind: 'erased'; id: null };

export function correctionTarget(
  correction: LocationCorrection,
): CorrectionTarget {
  if (correction.locationUseFactId !== null) {
    return { kind: 'fact', id: String(correction.locationUseFactId) };
  }
  if (correction.fieldAcquisitionId !== null) {
    return { kind: 'acquisition', id: correction.fieldAcquisitionId };
  }
  return { kind: 'erased', id: null };
}

export function failureTranslationSuffix(
  failure: LocationFactFailure,
): LocationFactFailure['code'] {
  return failure.code;
}
