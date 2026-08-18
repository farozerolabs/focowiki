import { resolveLocale, SUPPORTED_LOCALES, type SupportedLocale } from "./resources";

export const LANGUAGE_PREFERENCE_KEY = "focowiki.admin.language";

type LanguagePreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export function resolveInitialLocale(
  browserLanguage: string | undefined,
  storage: LanguagePreferenceStorage | undefined = readBrowserStorage()
): SupportedLocale {
  const persistedLocale = readLanguagePreference(storage);
  return persistedLocale ?? resolveLocale(browserLanguage);
}

export function persistLanguagePreference(
  locale: SupportedLocale,
  storage: LanguagePreferenceStorage | undefined = readBrowserStorage()
): void {
  storage?.setItem(LANGUAGE_PREFERENCE_KEY, locale);
}

function readLanguagePreference(
  storage: LanguagePreferenceStorage | undefined
): SupportedLocale | null {
  const value = storage?.getItem(LANGUAGE_PREFERENCE_KEY);
  return SUPPORTED_LOCALES.find((locale) => locale === value) ?? null;
}

function readBrowserStorage(): LanguagePreferenceStorage | undefined {
  return globalThis.localStorage;
}
