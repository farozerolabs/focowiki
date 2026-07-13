import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { chromium } from "playwright";

loadLocalEnv();

const adminUiUrl = process.env.FOCOWIKI_ADMIN_UI_URL?.trim() || "http://127.0.0.1:43100";
const reportDir = path.resolve(
  process.env.FOCOWIKI_FULL_SYSTEM_REPORT_DIR ||
    "ReferenceDocs/validate-focowiki-full-system-e2e"
);
const username = requiredEnv("ADMIN_USERNAME");
const password = requiredEnv("ADMIN_PASSWORD");
const reportPath = path.join(reportDir, "admin-ui-settings-smoke.json");
const report = {
  kind: "admin-ui-settings-smoke",
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  checks: []
};

fs.mkdirSync(reportDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  await runScenario({
    browser,
    locale: "en-US",
    label: "desktop-en",
    viewport: { width: 1440, height: 1000 }
  });
  await runScenario({
    browser,
    locale: "zh-CN",
    label: "mobile-zh",
    viewport: { width: 390, height: 844 }
  });
  report.ok = report.checks.every((check) => check.ok);
} finally {
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}

if (!report.ok) {
  process.exitCode = 1;
}

async function runScenario({ browser, locale, label, viewport }) {
  const context = await browser.newContext({ locale, viewport });
  try {
    const page = await context.newPage();
    await page.goto(`${adminUiUrl}/?view=settings`, { waitUntil: "networkidle" });
    await page.locator("#admin-username").fill(username);
    await page.locator("#admin-password").fill(password);
    await page.locator('button[type="submit"]').click();
    await expectVisible(page.locator('[role="tablist"]'), `${label}-settings-route-after-login`);

    await page.reload({ waitUntil: "networkidle" });
    await expectVisible(page.locator('[role="tablist"]'), `${label}-settings-route-after-refresh`);
    await page.locator('[role="tab"][aria-controls$="-content-models"]').click();
    await page
      .locator('[role="tabpanel"][data-state="active"] button')
      .filter({ has: page.locator("svg.lucide-plus") })
      .click();

    const dialog = page.getByRole("dialog");
    const requiredMessage = dialog.getByRole("alert");
    const initialMessageCount = await requiredMessage.count();
    record(`${label}-model-error-hidden-on-open`, initialMessageCount === 0, {
      count: initialMessageCount
    });

    await dialog.locator('button[type="submit"]').click();
    await expectVisible(requiredMessage, `${label}-model-error-after-invalid-submit`);
    const layout = await page.evaluate(() => {
      const dialogElement = document.querySelector('[role="dialog"]');
      const bounds = dialogElement?.getBoundingClientRect();
      return {
        horizontalOverflow:
          document.documentElement.scrollWidth > document.documentElement.clientWidth,
        dialogWithinViewport: Boolean(
          bounds &&
          bounds.left >= 0 &&
          bounds.right <= document.documentElement.clientWidth
        )
      };
    });
    await page.screenshot({
      path: path.join(reportDir, `admin-model-validation-${label}.png`),
      fullPage: true
    });
    record(`${label}-no-horizontal-overflow`, !layout.horizontalOverflow, layout);
    record(`${label}-dialog-within-viewport`, layout.dialogWithinViewport, layout);
  } finally {
    await context.close();
  }
}

async function expectVisible(locator, name) {
  await locator.waitFor({ state: "visible", timeout: 10_000 });
  record(name, true);
}

function record(name, ok, details = {}) {
  report.checks.push({ name, ok, ...details });
  if (!ok) {
    throw new Error(`Admin UI smoke check failed: ${name}`);
  }
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function loadLocalEnv() {
  const envFile = process.env.ENV_FILE || ".env";
  if (fs.existsSync(envFile)) {
    loadEnvFile(envFile);
  }
}
