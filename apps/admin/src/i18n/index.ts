import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { DEFAULT_LOCALE, resources, resolveLocale } from "./resources";

export async function initI18n(language = globalThis.navigator?.language): Promise<typeof i18next> {
  if (i18next.isInitialized) {
    return i18next;
  }

  await i18next.use(initReactI18next).init({
    resources,
    lng: resolveLocale(language),
    fallbackLng: DEFAULT_LOCALE,
    interpolation: {
      escapeValue: false
    }
  });

  return i18next;
}
