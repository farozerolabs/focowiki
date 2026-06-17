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
      <div className="flex w-full max-w-sm flex-col items-center gap-6">
        <img src="/logo.jpg" alt="" className="size-14 rounded-lg object-cover" />
        <LoginForm onLogin={loginAdmin} onAuthenticated={onAuthenticated} />
      </div>
    </main>
  );
}
