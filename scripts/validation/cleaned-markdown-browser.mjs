import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { chromium } from "playwright";
import { selectSamplesFromEnvironment } from "./cleaned-markdown-flow.mjs";

const CHANGE_ID = "validate-cleaned-legal-upload-flow";
const CHANGE_DIR = path.resolve("openspec/changes", CHANGE_ID);
const BROWSER_REPORT_JSON = path.join(CHANGE_DIR, "browser-validation-report.json");

loadLocalEnv();

const sampleSelection = selectSamplesFromEnvironment();
const adminUiBaseUrl =
  process.env.ADMIN_UI_BASE_URL ?? `http://localhost:${process.env.ADMIN_UI_PORT ?? "43100"}`;
const adminUsername = requiredEnv("ADMIN_USERNAME");
const adminPassword = requiredEnv("ADMIN_PASSWORD");
const knowledgeBaseName = `Focowiki browser validation ${new Date().toISOString()}`;
const taskTimeoutMs = readValidationTaskTimeoutMs(sampleSelection.samples.length);

const report = {
  kind: "browser",
  change: CHANGE_ID,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  adminUiBaseUrl: redactUrl(adminUiBaseUrl),
  samples: sampleSelection.samples.map((sample) => ({
    basename: sample.basename,
    type: sample.type,
    status: sample.status,
    publicationDate: sample.publicationDate || "unknown-date",
    sizeBytes: sample.sizeBytes
  })),
  checks: [],
  failures: []
};

const browser = await chromium.launch({ headless: true });
let runError = null;

try {
  const context = await browser.newContext({ locale: "en-US" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await context.newPage();

  await page.goto(adminUiBaseUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Language" }).click();
  await page.getByRole("menuitemradio", { name: "Chinese" }).click();
  await page.getByRole("button", { name: "登录" }).waitFor();
  await page.getByRole("button", { name: "语言" }).click();
  await page.getByRole("menuitemradio", { name: "English" }).click();
  await page.getByRole("button", { name: "Log in" }).waitFor();
  report.checks.push(okCheck("language-switch", "Language switch works from login page."));

  await page.getByLabel("Username").fill(adminUsername);
  await page.getByLabel("Password").fill(adminPassword);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.getByRole("button", { name: "Create knowledge base" }).waitFor();
  report.checks.push(okCheck("login", "Admin login succeeded in browser."));

  await page.getByRole("button", { name: "Create knowledge base" }).click();
  const createDialog = page.getByRole("dialog");
  await createDialog.getByLabel("Knowledge base name").fill(knowledgeBaseName);
  await createDialog.getByLabel("Description").fill("Cleaned Markdown browser validation");
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/admin/api/knowledge-bases") &&
        response.status() === 201
    ),
    createDialog.getByRole("button", { name: "Create", exact: true }).click()
  ]);
  await createDialog.waitFor({ state: "detached", timeout: 30_000 });
  const knowledgeBaseCard = page.getByRole("button", {
    name: knowledgeBaseName,
    exact: true
  });
  await knowledgeBaseCard.waitFor();
  await knowledgeBaseCard.click();
  await page.getByText("Upload tasks").first().waitFor();
  await page.getByRole("button", { name: /^Upload$/ }).waitFor();
  report.checks.push(okCheck("knowledge-base", "Created and opened validation knowledge base."));

  await page.getByRole("button", { name: /^Upload$/ }).click();
  const uploadDialog = page.getByRole("dialog");
  await expectNoMetadataInputs(uploadDialog);
  await uploadDialog.locator("#source-files").setInputFiles(
    sampleSelection.samples.map((sample) => sample.filePath)
  );
  await uploadDialog.getByRole("button", { name: /^Upload$/ }).click();
  await uploadDialog.waitFor({ state: "detached", timeout: 30_000 });
  await page.getByText(/task-/).waitFor({ timeout: 30_000 });
  report.checks.push(okCheck("upload-submit", "Upload dialog submitted and task list refreshed."));

  await page.getByText("Upload parsing task ended").waitFor({ timeout: taskTimeoutMs });
  report.checks.push(okCheck("task-ended", "Browser observed ended upload task."));

  await page.getByRole("button", { name: "pages" }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "pages" }).click();
  const firstSampleName = sampleSelection.samples[0]?.basename;

  if (!firstSampleName) {
    throw new Error("No selected sample basename was available for browser preview.");
  }

  await page.getByRole("button", { name: firstSampleName }).click();
  const previewArticle = page.locator("article");
  await previewArticle.waitFor({ timeout: 30_000 });
  const previewText = await previewArticle.innerText();

  if (!previewText.includes(sampleSelection.samples[0].title)) {
    throw new Error("Generated file preview did not contain the selected Markdown title.");
  }

  report.checks.push(okCheck("file-preview", "Opened generated file preview in browser."));

  const copyButton = page.getByRole("button", { name: "Copy index URL" });
  await copyButton.click();
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());

  if (!clipboardText.includes("/kb/") || clipboardText.includes("S3_")) {
    throw new Error("Copied public URL does not look like a scoped public URL.");
  }

  report.checks.push(okCheck("copy-url", "Public URL copy action produced a scoped URL."));
  report.ok = true;
} catch (error) {
  runError = error;
  report.failures.push(error instanceof Error ? error.message : String(error));
} finally {
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(CHANGE_DIR, { recursive: true });
  fs.writeFileSync(BROWSER_REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}

if (runError) {
  throw runError;
}

if (!report.ok) {
  throw new Error("Browser validation failed. See redacted browser validation report.");
}

function loadLocalEnv() {
  const envFile = process.env.ENV_FILE || ".env";

  if (fs.existsSync(envFile)) {
    loadEnvFile(envFile);
  }
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} must be set for browser validation.`);
  }

  return value;
}

function okCheck(name, message) {
  return {
    layer: "black-box",
    name,
    ok: true,
    message
  };
}

function readValidationTaskTimeoutMs(sampleCount) {
  const configured = process.env.FOCOWIKI_VALIDATION_TASK_TIMEOUT_MS?.trim();

  if (configured) {
    const parsed = Number(configured);

    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error("FOCOWIKI_VALIDATION_TASK_TIMEOUT_MS must be a positive integer.");
    }

    return parsed;
  }

  if (!process.env.MODEL_API_KEY?.trim() || !process.env.MODEL_NAME?.trim()) {
    return 180_000;
  }

  const concurrency = readPositiveInteger(process.env.MODEL_SUGGESTION_CONCURRENCY, 2);
  const idleMs = readPositiveInteger(process.env.MODEL_REQUEST_IDLE_TIMEOUT_MS, 30_000);
  const batches = Math.ceil(sampleCount / concurrency);

  return Math.max(180_000, batches * 2 * idleMs + 120_000);
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function expectNoMetadataInputs(dialog) {
  const metadataLabels = [
    "Default type",
    "Default title",
    "Default description",
    "Default tags",
    "默认类型",
    "默认标题",
    "默认描述",
    "默认标签"
  ];

  for (const label of metadataLabels) {
    const count = await dialog.getByLabel(label, { exact: true }).count();

    if (count > 0) {
      throw new Error(`Upload dialog still exposes removed metadata field: ${label}`);
    }
  }
}

function redactUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return "<invalid-url>";
  }
}
