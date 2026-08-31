import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';
import {
  resolveLocale,
  translateMessage,
  type LanguagePreference,
  type SupportedLocale,
  type Translate,
} from './core';
import {
  getSystemLanguage,
  loadLanguagePreference,
  saveLanguagePreference,
  subscribeLanguagePreference,
} from './runtime';

export interface I18nContextValue {
  languagePreference: LanguagePreference;
  locale: SupportedLocale;
  ready: boolean;
  setLanguagePreference: (preference: LanguagePreference) => Promise<void>;
  systemLanguage: string;
  t: Translate;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  children,
  initialLanguagePreference,
}: PropsWithChildren<{ initialLanguagePreference?: LanguagePreference }>) {
  const hasInitialPreference = initialLanguagePreference !== undefined;
  const [languagePreference, setPreference] = useState<LanguagePreference>(
    initialLanguagePreference ?? 'system',
  );
  const [ready, setReady] = useState(hasInitialPreference);
  const systemLanguage = useMemo(() => getSystemLanguage(), []);
  const locale = resolveLocale(languagePreference, systemLanguage);

  useEffect(() => {
    let mounted = true;
    if (!hasInitialPreference) {
      void loadLanguagePreference()
        .catch(() => 'system' as const)
        .then((preference) => {
          if (mounted) setPreference(preference);
        })
        .finally(() => {
          if (mounted) setReady(true);
        });
    }

    const unsubscribe = subscribeLanguagePreference((preference) => {
      if (mounted) setPreference(preference);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [hasInitialPreference]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLanguagePreference = useCallback(async (preference: LanguagePreference) => {
    setPreference(preference);
    try {
      await saveLanguagePreference(preference);
    } catch (error) {
      const storedPreference = await loadLanguagePreference().catch(() => 'system' as const);
      setPreference(storedPreference);
      throw error;
    }
  }, []);

  const t = useCallback<Translate>(
    (key, variables) => translateMessage(locale, key, variables),
    [locale],
  );

  const value = useMemo<I18nContextValue>(
    () => ({
      languagePreference,
      locale,
      ready,
      setLanguagePreference,
      systemLanguage,
      t,
    }),
    [languagePreference, locale, ready, setLanguagePreference, systemLanguage, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside an I18nProvider.');
  return context;
}

export const useTranslation = useI18n;
