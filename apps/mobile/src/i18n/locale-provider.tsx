import { getLocales } from 'expo-localization';
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { localeStorage } from './locale-storage';
import {
  resolveSupportedLocale,
  type SupportedLocale,
} from './locales';
import { translate, type TranslationKey } from './translations';

interface LocaleContextValue {
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
  t: (key: TranslationKey) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

function getInitialLocale(): SupportedLocale {
  return resolveSupportedLocale(getLocales().map(({ languageTag }) => languageTag));
}

export function LocaleProvider({ children }: PropsWithChildren) {
  const [locale, setLocale] = useState<SupportedLocale>(getInitialLocale);
  const selectionVersion = useRef(0);

  useEffect(() => {
    let mounted = true;
    const versionAtStart = selectionVersion.current;
    void localeStorage.load()
      .then((storedLocale) => {
        if (
          mounted
          && storedLocale !== null
          && selectionVersion.current === versionAtStart
        ) {
          setLocale(storedLocale);
        }
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  const selectLocale = useCallback((nextLocale: SupportedLocale) => {
    selectionVersion.current += 1;
    setLocale(nextLocale);
    void localeStorage.save(nextLocale).catch(() => undefined);
  }, []);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale: selectLocale,
      t: (key) => translate(locale, key),
    }),
    [locale, selectLocale],
  );

  return (
    <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
  );
}

export function useI18n(): LocaleContextValue {
  const value = useContext(LocaleContext);

  if (!value) {
    throw new Error('useI18n must be used within LocaleProvider.');
  }

  return value;
}
