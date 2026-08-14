import { ApiTransportError } from './client';

import {
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from '@/i18n/locales';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

export type LocalizedText = Record<SupportedLocale, string>;

export function invalidPayload(): never {
  throw new ApiTransportError('INVALID_RESPONSE');
}

export function expectRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : invalidPayload();
}

export function expectArray(value: unknown, maximumLength: number): unknown[] {
  return Array.isArray(value) && value.length <= maximumLength
    ? value
    : invalidPayload();
}

export function expectString(
  value: unknown,
  options: { minimumLength?: number; maximumLength: number; pattern?: RegExp },
): string {
  if (
    typeof value !== 'string'
    || value.length < (options.minimumLength ?? 0)
    || value.length > options.maximumLength
    || (options.pattern !== undefined && !options.pattern.test(value))
  ) {
    return invalidPayload();
  }
  return value;
}

export function expectUuid(value: unknown): string {
  return expectString(value, {
    minimumLength: 36,
    maximumLength: 36,
    pattern: UUID_PATTERN,
  });
}

export function expectFiniteNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum
    ? value
    : invalidPayload();
}

export function expectNonnegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : invalidPayload();
}

export function expectBoolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : invalidPayload();
}

export function expectEnum<const Value extends string>(
  value: unknown,
  allowed: readonly Value[],
): Value {
  return typeof value === 'string' && allowed.includes(value as Value)
    ? value as Value
    : invalidPayload();
}

export function expectIsoDateTime(value: unknown): string {
  const candidate = expectString(value, { minimumLength: 20, maximumLength: 40 });
  return Number.isNaN(Date.parse(candidate)) ? invalidPayload() : candidate;
}

export function expectIsoDate(value: unknown): string {
  const candidate = expectString(value, {
    minimumLength: 10,
    maximumLength: 10,
    pattern: DATE_PATTERN,
  });
  const match = DATE_PATTERN.exec(candidate);
  if (match === null) {
    return invalidPayload();
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    ? candidate
    : invalidPayload();
}

export function expectLocalizedText(value: unknown): LocalizedText {
  const record = expectRecord(value);
  return Object.fromEntries(SUPPORTED_LOCALES.map((locale) => [
    locale,
    expectString(record[locale], { minimumLength: 1, maximumLength: 200 }),
  ])) as LocalizedText;
}

export function getLocalizedText(
  value: Partial<Record<SupportedLocale, string>>,
  locale: SupportedLocale,
  fallback: string,
): string {
  const candidates: SupportedLocale[] = [locale, 'en', 'ko', ...SUPPORTED_LOCALES];
  for (const candidate of candidates) {
    const text = value[candidate]?.trim();
    if (text !== undefined && text.length > 0) {
      return text;
    }
  }
  return fallback;
}

export function resolveApiAssetUrl(apiBaseUrl: string, path: string): string {
  const base = new URL(`${apiBaseUrl.replace(/\/$/u, '')}/`);
  const resolved = new URL(path, base);
  if (resolved.origin !== base.origin || !resolved.pathname.startsWith('/api/')) {
    return invalidPayload();
  }
  return resolved.toString();
}
