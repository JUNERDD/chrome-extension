export { catalogs, englishCatalog, simplifiedChineseCatalog, type MessageKey } from './catalog';
export {
  LANGUAGE_PREFERENCES,
  SUPPORTED_LOCALES,
  isLanguagePreference,
  normalizeLocale,
  resolveLocale,
  translateMessage,
  type LanguagePreference,
  type MessageVariables,
  type SupportedLocale,
  type Translate,
} from './core';
export { I18nProvider, useI18n, useTranslation, type I18nContextValue } from './react';
export {
  LANGUAGE_PREFERENCE_STORAGE_KEY,
  getSystemLanguage,
  getSystemLocale,
  loadI18nBootstrap,
  loadLanguagePreference,
  saveLanguagePreference,
  subscribeLanguagePreference,
} from './runtime';
