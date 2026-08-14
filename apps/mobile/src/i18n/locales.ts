export const SUPPORTED_LOCALES = [
  'ko',
  'en',
  'ja',
  'zh-Hans',
  'zh-Hant',
  'vi',
] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = 'en';

export const LANGUAGE_OPTIONS: readonly {
  locale: SupportedLocale;
  label: string;
}[] = [
  { locale: 'ko', label: '한국어' },
  { locale: 'en', label: 'English' },
  { locale: 'ja', label: '日本語' },
  { locale: 'zh-Hans', label: '简体中文' },
  { locale: 'zh-Hant', label: '繁體中文' },
  { locale: 'vi', label: 'Tiếng Việt' },
];

function normalizeLocaleTag(tag: string): string {
  return tag.trim().replaceAll('_', '-').toLowerCase();
}

export function resolveSupportedLocale(
  preferredLocaleTags: readonly string[],
): SupportedLocale {
  for (const rawTag of preferredLocaleTags) {
    const tag = normalizeLocaleTag(rawTag);

    const exact = SUPPORTED_LOCALES.find(
      (supported) => supported.toLowerCase() === tag,
    );
    if (exact) {
      return exact;
    }

    if (
      tag.startsWith('zh-hant') ||
      tag.startsWith('zh-tw') ||
      tag.startsWith('zh-hk') ||
      tag.startsWith('zh-mo')
    ) {
      return 'zh-Hant';
    }

    if (tag === 'zh' || tag.startsWith('zh-')) {
      return 'zh-Hans';
    }

    const language = tag.split('-')[0];
    const languageMatch = SUPPORTED_LOCALES.find(
      (supported) => supported.toLowerCase() === language,
    );
    if (languageMatch) {
      return languageMatch;
    }
  }

  return DEFAULT_LOCALE;
}
