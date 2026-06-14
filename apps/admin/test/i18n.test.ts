import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, resources, resolveLocale } from "../src/i18n/resources";

describe("admin i18n resources", () => {
  it("keeps locale resources in sync", () => {
    expect(flattenResourceKeys(resources["en-US"].translation)).toEqual(
      flattenResourceKeys(resources["zh-CN"].translation)
    );
  });

  it("defines copy for the in-page language switch", () => {
    expect(resources["en-US"].translation.language).toEqual({
      switchLabel: "Language",
      english: "English",
      chinese: "Chinese"
    });
    expect(resources["zh-CN"].translation.language).toEqual({
      switchLabel: "语言",
      english: "English",
      chinese: "中文"
    });
  });

  it("resolves supported browser locales and falls back for unsupported locales", () => {
    expect(resolveLocale("en-US")).toBe("en-US");
    expect(resolveLocale("zh-CN")).toBe("zh-CN");
    expect(resolveLocale("en")).toBe("en-US");
    expect(resolveLocale("zh")).toBe("zh-CN");
    expect(resolveLocale("fr-FR")).toBe(DEFAULT_LOCALE);
    expect(resolveLocale(undefined)).toBe(DEFAULT_LOCALE);
  });
});

function flattenResourceKeys(value: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(value)
    .flatMap(([key, entry]) => {
      const path = prefix ? `${prefix}.${key}` : key;

      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        return flattenResourceKeys(entry as Record<string, unknown>, path);
      }

      return [path];
    })
    .sort();
}
