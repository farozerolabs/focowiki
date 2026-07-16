import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type LoginFormProps = React.ComponentProps<"div"> & {
  onLogin: (input: { username: string; password: string }) => Promise<boolean>;
  onAuthenticated: () => void;
};

export function LoginForm({ className, onLogin, onAuthenticated, ...props }: LoginFormProps) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [hasError, setHasError] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setHasError(false);

    const isLoggedIn = await onLogin({ username, password });

    setIsSubmitting(false);

    if (!isLoggedIn) {
      setHasError(true);
      return;
    }

    onAuthenticated();
  }

  return (
    <div className={cn("flex w-full max-w-sm flex-col gap-6", className)} {...props}>
      <Card>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <FieldGroup>
              <Field data-invalid={hasError}>
                <FieldLabel htmlFor="admin-username">{t("auth.usernameLabel")}</FieldLabel>
                <Input
                  id="admin-username"
                  value={username}
                  placeholder={t("auth.usernamePlaceholder")}
                  autoComplete="username"
                  aria-invalid={hasError}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </Field>
              <Field data-invalid={hasError}>
                <FieldLabel htmlFor="admin-password">{t("auth.passwordLabel")}</FieldLabel>
                <Input
                  id="admin-password"
                  type="password"
                  value={password}
                  placeholder={t("auth.passwordPlaceholder")}
                  autoComplete="current-password"
                  aria-invalid={hasError}
                  onChange={(event) => setPassword(event.target.value)}
                />
                {hasError ? <FieldError>{t("auth.invalidCredentials")}</FieldError> : null}
              </Field>
              <Button type="submit" disabled={!username || !password || isSubmitting}>
                {isSubmitting ? t("auth.loggingIn") : t("auth.login")}
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
