import { useTranslation } from "react-i18next";
import { DocumentationLink } from "@/components/documentation-link";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { LoginForm } from "@/components/login-form";
import { loginAdmin } from "@/lib/admin-api";

type LoginPageProps = {
  onAuthenticated: () => void;
};

export function LoginPage({ onAuthenticated }: LoginPageProps) {
  const { t } = useTranslation();

  return (
    <main className="relative flex min-h-svh items-center justify-center bg-muted/40 p-6">
      <div className="absolute left-6 top-6 flex items-center gap-2">
        <img src="/logo.svg" alt="" className="size-10 object-contain" />
        <span className="text-lg font-medium">{t("app.name")}</span>
      </div>
      <div className="absolute right-6 top-6 flex items-center gap-2">
        <DocumentationLink />
        <LanguageSwitch />
      </div>
      <div className="flex w-full max-w-sm flex-col items-center">
        <LoginForm onLogin={loginAdmin} onAuthenticated={onAuthenticated} />
      </div>
      <a
        href="https://github.com/farozerolabs/focowiki"
        target="_blank"
        rel="noreferrer"
        className="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-muted-foreground/70 transition-colors hover:text-muted-foreground"
      >
        {t("auth.poweredBy")}
      </a>
    </main>
  );
}
