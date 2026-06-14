import { useTranslation } from "react-i18next";
import { GlobeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { resolveLocale, type SupportedLocale } from "@/i18n/resources";

export function LanguageSwitch() {
  const { t, i18n } = useTranslation();
  const currentLocale = resolveLocale(i18n.resolvedLanguage ?? i18n.language);

  function handleLanguageChange(locale: SupportedLocale) {
    void i18n.changeLanguage(locale);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="icon-sm" aria-label={t("language.switchLabel")}>
          <GlobeIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={currentLocale}
          onValueChange={(locale) => handleLanguageChange(locale as SupportedLocale)}
        >
          <DropdownMenuRadioItem value="en-US">{t("language.english")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="zh-CN">{t("language.chinese")}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
