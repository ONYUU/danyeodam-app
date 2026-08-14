import { ApiResponseError } from '@/api/client';
import type { SupportedLocale } from '@/i18n/locales';

type RetryTemplates = {
  minutes: string;
  seconds: string;
};

function safeNonNegativeInteger(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0
    ? Number(value)
    : null;
}

export function formatRateLimitRetryAfter(
  error: unknown,
  locale: SupportedLocale,
  templates: RetryTemplates,
): string | null {
  if (!(error instanceof ApiResponseError) || error.code !== 'RATE_LIMITED') {
    return null;
  }
  const seconds = safeNonNegativeInteger(error.details?.retry_after_seconds);
  const lockedMinutes = safeNonNegativeInteger(error.details?.locked_minutes);
  const unit = seconds === null ? 'minutes' : 'seconds';
  const value = seconds ?? lockedMinutes;
  if (value === null) {
    return null;
  }
  return templates[unit].replace(
    '{count}',
    new Intl.NumberFormat(locale).format(value),
  );
}
