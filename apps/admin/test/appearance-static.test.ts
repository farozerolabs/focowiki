import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("admin appearance defaults", () => {
  it("loads the app in dark mode by default", () => {
    const html = readFileSync(join(process.cwd(), "index.html"), "utf8");

    expect(html).toContain('<html lang="en" class="dark">');
  });

  it("uses the shared scalable brand mark", () => {
    const html = readFileSync(join(process.cwd(), "index.html"), "utf8");
    const loginPage = readFileSync(join(process.cwd(), "src/pages/LoginPage.tsx"), "utf8");
    const homePage = readFileSync(join(process.cwd(), "src/pages/AdminHomePage.tsx"), "utf8");
    const settingsPage = readFileSync(join(process.cwd(), "src/pages/SettingsPage.tsx"), "utf8");
    const sidebar = readFileSync(join(process.cwd(), "src/components/app-sidebar.tsx"), "utf8");
    const logo = readFileSync(join(process.cwd(), "public/logo.svg"), "utf8");
    const docsConfig = readFileSync(join(process.cwd(), "../../docs/.vitepress/config.ts"), "utf8");

    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/logo.svg" />');
    for (const component of [loginPage, homePage, settingsPage, sidebar]) {
      expect(component).toContain('src="/logo.svg"');
      expect(component).not.toContain('src="/logo.jpg"');
    }
    expect(loginPage).toContain('className="size-10 object-contain"');
    expect(logo).toContain("<svg");
    expect(docsConfig).toContain('logo: "/logo.svg"');
  });

  it("renders the login form without a card frame", () => {
    const loginForm = readFileSync(join(process.cwd(), "src/components/login-form.tsx"), "utf8");

    expect(loginForm).not.toContain('from "@/components/ui/card"');
    expect(loginForm).not.toContain("<Card>");
    expect(loginForm).not.toContain("<CardContent>");
  });

  it("does not allow inline or evaluated scripts in development and production CSP", () => {
    const viteConfig = readFileSync(join(process.cwd(), "vite.config.ts"), "utf8");
    const nginxConfig = readFileSync(
      join(process.cwd(), "../../deploy/nginx/default.conf.template"),
      "utf8"
    );

    for (const policySource of [viteConfig, nginxConfig]) {
      const scriptDirective = policySource.match(/script-src[^;"\n]*/u)?.[0] ?? "";

      expect(scriptDirective).toContain("script-src 'self'");
      expect(scriptDirective).not.toContain("'unsafe-inline'");
      expect(scriptDirective).not.toContain("'unsafe-eval'");
    }

    expect(viteConfig).toContain('randomBytes(16).toString("base64url")');
    expect(viteConfig).toContain('`script-src \'self\' \'nonce-${developmentCspNonce}\'`');
    expect(viteConfig).toContain("cspNonce: developmentCspNonce");
  });
});
