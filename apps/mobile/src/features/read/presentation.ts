import { ApiResponseError, ApiTransportError } from '@/api/client';
import type { AcquisitionType } from '@/api/collection';
import type { SupportedLocale } from '@/i18n/locales';

export type ReadErrorKind = 'offline' | 'session' | 'generic';

export function classifyReadError(error: unknown): ReadErrorKind {
  if (error instanceof ApiResponseError && error.status === 401) {
    return 'session';
  }
  if (error instanceof ApiTransportError) {
    if (error.failure === 'AUTH_SESSION_UNAVAILABLE') {
      return 'session';
    }
    if (error.failure === 'NETWORK_ERROR' || error.failure === 'TIMEOUT') {
      return 'offline';
    }
  }
  return 'generic';
}

const DATE_LOCALES: Record<SupportedLocale, string> = {
  ko: 'ko-KR',
  en: 'en-US',
  ja: 'ja-JP',
  'zh-Hans': 'zh-CN',
  'zh-Hant': 'zh-TW',
  vi: 'vi-VN',
};

export function formatKstDate(dateKst: string, locale: SupportedLocale): string {
  const instant = new Date(`${dateKst}T00:00:00+09:00`);
  if (Number.isNaN(instant.getTime())) {
    return dateKst;
  }
  try {
    return new Intl.DateTimeFormat(DATE_LOCALES[locale], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'Asia/Seoul',
    }).format(instant);
  } catch {
    return dateKst;
  }
}

export function acquisitionGlyph(type: AcquisitionType): string {
  if (type === 'field') {
    return '●';
  }
  if (type === 'retro') {
    return '◌';
  }
  return '◇';
}
