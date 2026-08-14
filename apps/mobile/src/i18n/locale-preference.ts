import { SUPPORTED_LOCALES, type SupportedLocale } from './locales';

export type LocalePreferenceBackend = {
  getItem(): Promise<string | null>;
  setItem(locale: string): Promise<void>;
};

export function parseStoredLocale(value: string | null): SupportedLocale | null {
  return SUPPORTED_LOCALES.find((locale) => locale === value) ?? null;
}

export function createLocalePreferenceStorage(backend: LocalePreferenceBackend) {
  return {
    async load(): Promise<SupportedLocale | null> {
      return parseStoredLocale(await backend.getItem());
    },
    async save(locale: SupportedLocale): Promise<void> {
      await backend.setItem(locale);
    },
  };
}
