import { LanguageSwitch } from "@/components/LanguageSwitch";
import { LoginForm } from "@/components/login-form";
import { loginAdmin } from "@/lib/admin-api";

type LoginPageProps = {
  onAuthenticated: () => void;
};

export function LoginPage({ onAuthenticated }: LoginPageProps) {
  return (
    <main className="relative flex min-h-svh items-center justify-center bg-muted/40 p-6">
      <div className="absolute right-6 top-6">
        <LanguageSwitch />
      </div>
      <LoginForm onLogin={loginAdmin} onAuthenticated={onAuthenticated} />
    </main>
  );
}
