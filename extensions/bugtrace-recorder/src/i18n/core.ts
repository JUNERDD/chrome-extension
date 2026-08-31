import { catalogs, englishCatalog, type MessageKey } from './catalog';

export const SUPPORTED_LOCALES = ['en', 'zh-CN'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const LANGUAGE_PREFERENCES = ['system', ...SUPPORTED_LOCALES] as const;
export type LanguagePreference = (typeof LANGUAGE_PREFERENCES)[number];

export type MessageVariables = Readonly<Record<string, string | number>>;

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return typeof value === 'string' && (LANGUAGE_PREFERENCES as readonly string[]).includes(value);
}

export function normalizeLocale(language: string | null | undefined): SupportedLocale {
  return language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

export function resolveLocale(
  preference: LanguagePreference,
  systemLanguage: string | null | undefined,
): SupportedLocale {
  return preference === 'system' ? normalizeLocale(systemLanguage) : preference;
}

function interpolate(template: string, variables: MessageVariables | undefined): string {
  if (!variables) return template;
  return template.replace(/\{([a-zA-Z][\w]*)\}/g, (placeholder, name: string) => {
    const value = variables[name];
    return value === undefined ? placeholder : String(value);
  });
}

export function translateMessage(
  locale: SupportedLocale | string,
  key: MessageKey,
  variables?: MessageVariables,
): string {
  const normalized = normalizeLocale(locale);
  const localized = catalogs[normalized][key];
  return interpolate(localized || englishCatalog[key] || key, variables);
}

export type Translate = (key: MessageKey, variables?: MessageVariables) => string;
