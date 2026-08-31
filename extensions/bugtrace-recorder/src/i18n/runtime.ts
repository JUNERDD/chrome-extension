import { browser } from 'wxt/browser';
import {
  isLanguagePreference,
  resolveLocale,
  type LanguagePreference,
  type SupportedLocale,
  normalizeLocale,
} from './core';

export const LANGUAGE_PREFERENCE_STORAGE_KEY = 'bugtrace.language-preference';

export function getSystemLanguage(): string {
  try {
    return browser.i18n.getUILanguage();
  } catch {
    return typeof navigator === 'undefined' ? 'en' : navigator.language;
  }
}

export function getSystemLocale(): SupportedLocale {
  return normalizeLocale(getSystemLanguage());
}

export async function loadLanguagePreference(): Promise<LanguagePreference> {
  const stored = await browser.storage.local.get(LANGUAGE_PREFERENCE_STORAGE_KEY);
  const value = stored[LANGUAGE_PREFERENCE_STORAGE_KEY];
  return isLanguagePreference(value) ? value : 'system';
}

export async function loadI18nBootstrap(): Promise<{
  languagePreference: LanguagePreference;
  locale: SupportedLocale;
}> {
  const languagePreference = await loadLanguagePreference().catch(() => 'system' as const);
  return {
    languagePreference,
    locale: resolveLocale(languagePreference, getSystemLanguage()),
  };
}

export async function saveLanguagePreference(preference: LanguagePreference): Promise<void> {
  await browser.storage.local.set({ [LANGUAGE_PREFERENCE_STORAGE_KEY]: preference });
}

export function subscribeLanguagePreference(
  listener: (preference: LanguagePreference) => void,
): () => void {
  const handleChange = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'local') return;
    const value = changes[LANGUAGE_PREFERENCE_STORAGE_KEY]?.newValue;
    if (value === undefined) listener('system');
    else if (isLanguagePreference(value)) listener(value);
  };

  browser.storage.onChanged.addListener(handleChange);
  return () => browser.storage.onChanged.removeListener(handleChange);
}
