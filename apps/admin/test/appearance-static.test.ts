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
    const sidebarHeader = readFileSync(
      join(process.cwd(), "src/components/admin-sidebar-header.tsx"),
      "utf8"
    );
    const logo = readFileSync(join(process.cwd(), "public/logo.svg"), "utf8");
    const docsConfig = readFileSync(join(process.cwd(), "../../docs/.vitepress/config.ts"), "utf8");

    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/logo.svg" />');
    for (const component of [loginPage, sidebarHeader]) {
      expect(component).toContain('src="/logo.svg"');
      expect(component).not.toContain('src="/logo.jpg"');
    }
    expect(loginPage).toContain('className="size-10 object-contain"');
    expect(logo).toContain("<svg");
    expect(docsConfig).toContain('logo: "/logo.svg"');
  });

  it("uses the shared compact admin page header", () => {
    const pageHeader = readFileSync(
      join(process.cwd(), "src/components/admin-page-header.tsx"),
      "utf8"
    );
    const homePage = readFileSync(join(process.cwd(), "src/pages/AdminHomePage.tsx"), "utf8");
    const detailPage = readFileSync(
      join(process.cwd(), "src/pages/KnowledgeBaseDetailPage.tsx"),
      "utf8"
    );

    for (const page of [homePage, detailPage]) {
      expect(page).toContain("<AdminPageHeader");
      expect(page).not.toContain("<header className=");
    }
    expect(pageHeader).toContain('className="h-14 shrink-0 border-b bg-card"');
    expect(pageHeader).toContain('className="flex h-full items-center justify-between gap-3 px-4"');
    expect(pageHeader).not.toContain("max-w-6xl");
  });

  it("uses a navigation list instead of tabs on the admin home", () => {
    const app = readFileSync(join(process.cwd(), "src/App.tsx"), "utf8");
    const homePage = readFileSync(join(process.cwd(), "src/pages/AdminHomePage.tsx"), "utf8");
    const homeSidebar = readFileSync(
      join(process.cwd(), "src/components/home-sidebar.tsx"),
      "utf8"
    );
    const settingsPanel = readFileSync(
      join(process.cwd(), "src/components/settings-panel.tsx"),
      "utf8"
    );

    expect(homePage).toContain("<SidebarProvider");
    expect(homePage).toContain("<HomeSidebar");
    expect(homePage).toContain("<SidebarInset");
    expect(homePage).toContain("<SidebarTrigger");
    expect(homePage).not.toContain("<aside");
    expect(homeSidebar).toContain("<Sidebar");
    expect(homeSidebar).toContain("<SidebarContent");
    expect(homeSidebar).toContain("<SidebarMenu");
    expect(homeSidebar).toContain("<SidebarMenuButton");
    expect(homeSidebar).toContain("<nav");
    expect(homeSidebar).toContain("<SettingsIcon");
    expect(homeSidebar).toContain('activeSection === "settings"');
    expect(homeSidebar).toContain('aria-current={activeSection === "knowledge-bases" ? "page" : undefined}');
    expect(homePage).toContain("<SettingsPanel");
    expect(homePage).not.toContain("<SettingsIcon");
    expect(app).not.toContain("<SettingsPage");
    expect(settingsPanel).not.toContain("<AdminPageHeader");
    expect(settingsPanel).not.toContain("<main");
    expect(homePage).not.toContain('from "@/components/ui/tabs"');
    expect(homePage).not.toContain("<Tabs");
  });

  it("splits sidebar and content headers like the knowledge base detail page", () => {
    const homePage = readFileSync(join(process.cwd(), "src/pages/AdminHomePage.tsx"), "utf8");
    const homeSidebar = readFileSync(
      join(process.cwd(), "src/components/home-sidebar.tsx"),
      "utf8"
    );
    const appSidebar = readFileSync(
      join(process.cwd(), "src/components/app-sidebar.tsx"),
      "utf8"
    );
    const sidebarHeader = readFileSync(
      join(process.cwd(), "src/components/admin-sidebar-header.tsx"),
      "utf8"
    );

    expect(homeSidebar).toContain("<AdminSidebarHeader");
    expect(appSidebar).toContain("<AdminSidebarHeader");
    expect(sidebarHeader).toContain("<SidebarHeader");
    expect(sidebarHeader).toContain('className="h-14 shrink-0 justify-center border-b"');
    expect(homePage.indexOf("<SidebarInset")).toBeLessThan(
      homePage.indexOf("<AdminPageHeader")
    );
    expect(homePage).not.toContain('className="top-14 bottom-0 h-auto"');
  });

  it("does not repeat the file processing label above its detail navigation item", () => {
    const appSidebar = readFileSync(
      join(process.cwd(), "src/components/app-sidebar.tsx"),
      "utf8"
    );

    expect(appSidebar).not.toContain(
      "<SidebarGroupLabel>{labels.uploadProgress}</SidebarGroupLabel>"
    );
    expect(appSidebar).toContain("<span>{labels.uploadProgress}</span>");
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
