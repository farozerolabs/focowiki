import { loadEnvFile } from "node:process";
import { chromium } from "playwright";

const knowledgeBaseId = process.argv[2]?.trim();
if (!knowledgeBaseId) {
  throw new Error("Usage: node scripts/validation/admin-generated-link-preview.mjs <knowledge-base-id>");
}

loadEnvFile(".env");

const adminUrl = `http://127.0.0.1:${process.env.ADMIN_UI_PORT?.trim() || "43100"}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

try {
  await page.goto(adminUrl, { waitUntil: "domcontentloaded" });
  const password = page.locator('input[type="password"]');
  await password.waitFor({ state: "visible" });
  await page.locator("input").first().fill(requiredEnv("ADMIN_USERNAME"));
  await password.fill(requiredEnv("ADMIN_PASSWORD"));
  await page.locator('button[type="submit"]').click();
  await password.waitFor({ state: "hidden" });

  await page.goto(
    `${adminUrl}/?view=knowledge-base&knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`,
    { waitUntil: "domcontentloaded" }
  );
  await page.waitForFunction(
    (expectedKnowledgeBaseId) => new URLSearchParams(window.location.search).get("knowledgeBaseId") === expectedKnowledgeBaseId,
    knowledgeBaseId
  );
  const indexEntry = page.getByRole("button", { name: /index\.md/u }).last();
  await indexEntry.waitFor();
  await indexEntry.click();

  const graphLink = page.locator('button[data-preview-path="_graph/index.md"]');
  const logLink = page.locator('button[data-preview-path="log.md"]');
  await graphLink.waitFor();
  await logLink.waitFor();

  await graphLink.click();
  await page.getByRole("heading", { name: "File graph" }).waitFor();

  await indexEntry.click();
  await logLink.waitFor();
  await logLink.click();
  await page.getByRole("heading", { name: "Directory Update Log" }).waitFor();

  console.log(JSON.stringify({
    knowledgeBaseId,
    relationshipGraphPath: "_graph/index.md",
    relationshipGraphOpened: true,
    updateHistoryPath: "log.md",
    updateHistoryOpened: true
  }, null, 2));
} catch (error) {
  const screenshotPath = `/tmp/focowiki-admin-generated-link-preview-${Date.now()}.png`;
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.error(JSON.stringify({
    currentUrl: page.url(),
    pageText: (await page.locator("body").innerText()).slice(0, 4_000),
    screenshotPath
  }, null, 2));
  throw error;
} finally {
  await browser.close();
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set.`);
  return value;
}
