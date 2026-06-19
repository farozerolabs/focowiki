import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { chromium } from "playwright";
import { selectSingleAndBatchSamplesFromEnvironment } from "./cleaned-markdown-flow.mjs";
import { redactReportText } from "./lib/redaction.mjs";

const CHANGE_ID = process.env.FOCOWIKI_VALIDATION_CHANGE_ID?.trim() || "validate-real-legal-full-flow";
const CHANGE_DIR = path.resolve("openspec/changes", CHANGE_ID);
const BROWSER_REPORT_JSON = path.join(CHANGE_DIR, "browser-validation-report.json");

loadLocalEnv();
normalizeCommand(process.argv[2] ?? "browser");

const sampleSelection = selectSingleAndBatchSamplesFromEnvironment();
const singleSample = sampleSelection.singleSample;
const batchSamples = sampleSelection.batchSamples;
const adminUiBaseUrl =
  process.env.ADMIN_UI_BASE_URL ?? `http://localhost:${process.env.ADMIN_UI_PORT ?? "43100"}`;
const adminUsername = requiredEnv("ADMIN_USERNAME");
const adminPassword = requiredEnv("ADMIN_PASSWORD");
const knowledgeBaseName = `Focowiki browser validation ${new Date().toISOString()}`;
const taskTimeoutMs = readValidationTaskTimeoutMs(sampleSelection.samples.length);

const report = {
  kind: "browser",
  change: CHANGE_ID,
  sampleProfile: sampleSelection.profile,
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
  singleSample: {
    basename: singleSample.basename,
    type: singleSample.type,
    status: singleSample.status,
    publicationDate: singleSample.publicationDate || "unknown-date",
    sizeBytes: singleSample.sizeBytes
  },
  batchSamples: batchSamples.map((sample) => ({
    basename: sample.basename,
    type: sample.type,
    status: sample.status,
    publicationDate: sample.publicationDate || "unknown-date",
    sizeBytes: sample.sizeBytes
  })),
  scannedCandidateProfiles: sampleSelection.scannedCandidateProfiles ?? null,
  sampleCoverageWarnings: sampleSelection.coverageWarnings ?? [],
  commandsRun: [
    readBooleanEnv(process.env.FOCOWIKI_VALIDATION_REQUIRE_MODEL)
      ? "pnpm validate:legal-llm:browser"
      : sampleSelection.profile === "large-scale"
      ? "pnpm validate:real-legal:large:browser"
      : "pnpm validate:real-legal:browser"
  ],
  testsRun: [
    "Admin UI browser flow",
    "single-file upload",
    "multi-file batch upload",
    "source-file processing table",
    "source-file processing pagination",
    "graph-backed related preview",
    "graph file tree preview",
    "preview, copy, source-backed deletion, and knowledge base deletion"
  ],
  validationPasses: [
    "Pass 1: browser login, language switching, and security header validation.",
    "Pass 2: browser single-upload and batch-upload source-file validation.",
    "Pass 3: browser preview, copy, deletion, cleanup, and report redaction validation."
  ],
  manualReviewItems: [
    "Review optional sample coverage warnings to decide whether the configured local dataset should be broadened."
  ],
  checks: [],
  failures: []
};

const browser = await chromium.launch({ headless: true });
let runError = null;

try {
  const context = await browser.newContext({ locale: "en-US" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await context.newPage();

  const loginResponse = await page.goto(adminUiBaseUrl, { waitUntil: "domcontentloaded" });
  validateAdminUiSecurityHeaders(loginResponse?.headers() ?? {});
  report.checks.push(okCheck("admin-ui-security-headers", "Admin UI returned security headers on the login page."));
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
  await page.getByRole("button", { name: "Create knowledge base" }).first().waitFor();
  report.checks.push(okCheck("login", "Admin login succeeded in browser."));

  await page.getByRole("button", { name: "Create knowledge base" }).first().click();
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
  await page.getByText("File processing").first().waitFor();
  await page.getByRole("button", { name: /^Upload$/ }).waitFor();
  report.checks.push(okCheck("knowledge-base", "Created and opened validation knowledge base."));

  const singleSourceFileIds = await uploadFilesFromDialog(page, [singleSample], {
    checkName: "single-upload-submit",
    message: "Single-file upload dialog submitted and source-file list refreshed."
  });
  await waitForSourceFilesCompleted(page, singleSourceFileIds, taskTimeoutMs);
  report.checks.push(okCheck("single-source-file-completed", "Browser observed completed single-file processing."));
  await validateSourceFileRows(page, singleSourceFileIds, [singleSample], {
    checkName: "single-source-file-row",
    message: "Single-file upload appears as one top-level source-file row with stable metadata."
  });

  const firstSampleName = singleSample.basename;
  const secondSampleName = batchSamples[0]?.basename;

  if (!firstSampleName || !secondSampleName) {
    throw new Error("No selected sample basename was available for browser preview.");
  }

  await openPagesDirectoryIfNeeded(page, firstSampleName);
  await page.getByRole("button", { name: firstSampleName, exact: true }).click();
  await waitForPreviewText(page, singleSample.title);
  const firstCopiedUrl = await copySelectedFileUrl(page);

  report.checks.push(okCheck("single-file-preview", "Opened generated single-upload file preview in browser."));

  await page.getByRole("button", { name: "File processing" }).click();
  const batchSourceFileIds = await uploadFilesFromDialog(page, batchSamples, {
    checkName: "batch-upload-submit",
    message: "Batch upload dialog submitted and source-file list refreshed."
  });
  await waitForSourceFilesCompleted(page, batchSourceFileIds, taskTimeoutMs);
  report.checks.push(okCheck("batch-source-files-completed", "Browser observed completed batch source-file processing."));
  await validateSourceFileRows(page, batchSourceFileIds, batchSamples, {
    checkName: "batch-source-file-rows",
    message: "Batch upload appears as top-level source-file rows with original filenames, file IDs, status, stage, and pagination."
  });

  await openPagesDirectoryIfNeeded(page, firstSampleName);
  await page.getByRole("button", { name: firstSampleName, exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: secondSampleName, exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: secondSampleName, exact: true }).click();
  await waitForPreviewText(page, batchSamples[0].title);
  const relatedPreviewVisible = await hasPreviewText(page, "Related");
  const secondCopiedUrl = await copySelectedFileUrl(page);

  if (firstCopiedUrl === secondCopiedUrl) {
    throw new Error("Different selected generated files copied the same public URL.");
  }

  report.checks.push(okCheck("batch-file-preview", "Opened generated batch-upload file preview in browser."));
  report.checks.push(
    okCheck(
      "graph-related-preview",
      relatedPreviewVisible
        ? "Generated page preview shows graph-backed related links."
        : "Generated page preview has no related links for the selected small sample; graph JSON preview remains authoritative."
    )
  );
  report.checks.push(okCheck("copy-url", "Selected generated files copied distinct Developer OpenAPI URLs."));

  await validateGraphFilePreview(page, [...batchSourceFileIds].sort()[0]);

  await page.getByRole("button", { name: `File actions: ${secondSampleName}` }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const deleteFileDialog = page.getByRole("alertdialog", { name: "Delete Markdown file" });
  await deleteFileDialog.waitFor();
  await deleteFileDialog.getByRole("button", { name: "Delete" }).click();
  await deleteFileDialog.waitFor({ state: "detached", timeout: 30_000 });
  await page.getByText("File processing").first().waitFor({ timeout: 30_000 });
  await expectButtonDetached(page, secondSampleName, taskTimeoutMs);
  await page.getByRole("button", { name: firstSampleName, exact: true }).waitFor({ timeout: 30_000 });
  report.checks.push(okCheck("file-delete", "Deleted a source-backed generated page and refreshed the file tree."));

  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: knowledgeBaseName, exact: true }).waitFor();
  await page.getByRole("button", { name: `Knowledge base actions for ${knowledgeBaseName}` }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const deleteKnowledgeBaseDialog = page.getByRole("alertdialog", {
    name: "Delete knowledge base"
  });
  await deleteKnowledgeBaseDialog.waitFor();
  await deleteKnowledgeBaseDialog.getByRole("button", { name: "Delete" }).click();
  await deleteKnowledgeBaseDialog.waitFor({ state: "detached", timeout: 30_000 });
  await expectButtonDetached(page, knowledgeBaseName, 30_000);
  report.checks.push(okCheck("knowledge-base-delete", "Deleted the validation knowledge base in browser."));
  report.ok = true;
} catch (error) {
  runError = error;
  report.failures.push(redactReportText(error instanceof Error ? error.message : String(error)));
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

function normalizeCommand(rawCommand) {
  if (rawCommand === "large-browser") {
    process.env.FOCOWIKI_VALIDATION_PROFILE = "large-scale";
  }
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} must be set for browser validation.`);
  }

  return value;
}

function readBooleanEnv(value) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function okCheck(name, message) {
  return {
    layer: "black-box",
    name,
    ok: true,
    message
  };
}

function validateAdminUiSecurityHeaders(headers) {
  const referrerPolicy = headers["referrer-policy"] ?? "";
  const contentTypeOptions = headers["x-content-type-options"] ?? "";
  const frameOptions = headers["x-frame-options"] ?? "";
  const csp = headers["content-security-policy"] ?? "";

  if (
    referrerPolicy.toLowerCase() !== "no-referrer" ||
    contentTypeOptions.toLowerCase() !== "nosniff" ||
    frameOptions.toUpperCase() !== "DENY" ||
    !csp.includes("frame-ancestors 'none'")
  ) {
    throw new Error("Admin UI login page did not return expected security headers.");
  }
}

async function uploadFilesFromDialog(page, samples, { checkName, message }) {
  await page.getByRole("button", { name: /^Upload$/ }).click();
  const uploadDialog = page.getByRole("dialog");
  await expectNoMetadataInputs(uploadDialog);
  await uploadDialog.locator("#source-files").setInputFiles(samples.map((sample) => sample.filePath));
  await uploadDialog.getByText(`${samples.length} selected Markdown file`, { exact: false }).waitFor({
    timeout: 30_000
  });
  const [uploadResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/admin/api/knowledge-bases/") &&
        response.url().includes("/uploads") &&
        response.status() === 202
    ),
    uploadDialog.getByRole("button", { name: /^Upload$/ }).click()
  ]);
  const uploadBody = await uploadResponse.json();
  await uploadDialog.waitFor({ state: "detached", timeout: 30_000 });
  const sourceFileIds = Array.isArray(uploadBody?.files)
    ? uploadBody.files.map((file) => file.id ?? file.fileId).filter(Boolean)
    : [];

  if (sourceFileIds.length !== samples.length) {
    throw new Error("Upload response did not include accepted source-file ids.");
  }

  for (const sourceFileId of sourceFileIds) {
    await page.getByTestId(`source-file-row-${sourceFileId}`).waitFor({ timeout: 30_000 });
  }
  report.checks.push(okCheck(checkName, message));
  return sourceFileIds;
}

async function waitForSourceFilesCompleted(page, sourceFileIds, timeout) {
  for (const sourceFileId of sourceFileIds) {
    await page
      .getByTestId(`source-file-row-${sourceFileId}`)
      .filter({ hasText: "Completed" })
      .waitFor({ timeout });
  }
}

async function validateSourceFileRows(page, sourceFileIds, samples, { checkName, message }) {
  const panel = page.getByTestId("source-file-progress-panel");
  const table = panel.getByRole("table", { name: "File processing" });
  await table.waitFor({ timeout: 30_000 });

  for (const [index, sourceFileId] of sourceFileIds.entries()) {
    const row = page.getByTestId(`source-file-row-${sourceFileId}`);
    await row.waitFor({ timeout: 30_000 });
    await row.getByText(samples[index].basename, { exact: true }).waitFor({ timeout: 30_000 });
    await row.getByText("Completed", { exact: true }).waitFor({ timeout: 30_000 });
    await row.getByText("Release activation", { exact: true }).waitFor({ timeout: 30_000 });
  }

  if (process.env.MODEL_API_KEY?.trim() && process.env.MODEL_NAME?.trim()) {
    await waitForTableText(table, process.env.MODEL_NAME, 30_000);
  }

  const fileRows = page.locator('[data-testid^="source-file-row-"]');
  const initialRowCount = await fileRows.count();

  if (initialRowCount < 1) {
    throw new Error("Expected source-file rows.");
  }

  const rowIds = await fileRows.evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-testid") ?? "")
  );

  if (rowIds.some((id) => id === "source-file-row-")) {
    throw new Error("Source-file rows did not include stable file ids.");
  }

  if ((await panel.getByRole("button", { name: "Load more" }).count()) > 0) {
    throw new Error("File processing list still exposes the removed load-more action.");
  }

  const previousPage = panel.getByRole("button", { name: "Previous page" });
  const nextPage = panel.getByRole("button", { name: "Next page" });
  await previousPage.waitFor({ timeout: 30_000 });
  await nextPage.waitFor({ timeout: 30_000 });

  if (await nextPage.isEnabled()) {
    const firstVisibleSourceFileId = sourceFileIds[0];
    await nextPage.click();
    await page
      .getByTestId(`source-file-row-${firstVisibleSourceFileId}`)
      .waitFor({ state: "detached", timeout: 30_000 });
    await previousPage.waitFor({ timeout: 30_000 });
    await previousPage.click();
    await page.getByTestId(`source-file-row-${firstVisibleSourceFileId}`).waitFor({ timeout: 30_000 });
    report.checks.push(
      okCheck("source-file-pagination", "Browser navigated source-file pages with previous and next controls.")
    );
  } else {
    report.checks.push(
      okCheck("source-file-pagination", "Source-file rows fit within the configured browser page size.")
    );
  }

  report.checks.push(okCheck(checkName, message));
}

async function openPagesDirectoryIfNeeded(page, expectedFileName) {
  const expectedFileButton = page.getByRole("button", { name: expectedFileName, exact: true });

  if ((await expectedFileButton.count()) > 0 && (await expectedFileButton.first().isVisible())) {
    return;
  }

  const pagesButton = page.getByRole("button", { name: "pages" });
  await pagesButton.waitFor({ timeout: 30_000 });
  await pagesButton.click();
  await expectedFileButton.waitFor({ timeout: 30_000 });
}

async function validateGraphFilePreview(page, sourceFileId) {
  const graphFileName = `${sourceFileId}.json`;
  const graphFileButton = page.getByRole("button", { name: graphFileName, exact: true });

  if ((await graphFileButton.count()) === 0) {
    await page.getByRole("button", { name: "_graph", exact: true }).click();
    await page.getByRole("button", { name: "by-file", exact: true }).click();
  }

  await graphFileButton.waitFor({ timeout: 30_000 });
  await graphFileButton.click();
  await waitForPreviewText(page, sourceFileId);
  await waitForPreviewText(page, "relationships");
  report.checks.push(okCheck("graph-file-preview", "Opened generated file-first graph JSON preview in browser."));
}

async function copySelectedFileUrl(page) {
  const copyFileButton = page.getByRole("button", { name: "Copy file URL" });

  if ((await copyFileButton.count()) === 0) {
    throw new Error("Selected generated file did not expose the file URL copy action.");
  }

  await copyFileButton.click();
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());

  if (!clipboardText.includes("/openapi/v1/knowledge-bases/") || clipboardText.includes("S3_")) {
    throw new Error("Copied public URL does not look like a Developer OpenAPI file URL.");
  }

  if (clipboardText.includes("path=index.md")) {
    throw new Error("Selected generated file copied the root index URL.");
  }

  return clipboardText;
}

async function waitForPreviewText(page, expectedText) {
  await page.locator("article").waitFor({ timeout: 30_000 });

  const found = await hasPreviewText(page, expectedText);

  if (!found) {
    throw new Error("Generated file preview did not contain the selected Markdown title.");
  }
}

async function hasPreviewText(page, expectedText) {
  const found = await page
    .locator("article")
    .filter({ hasText: expectedText })
    .first()
    .waitFor({ timeout: 30_000 })
    .then(() => true)
    .catch(() => false);

  return found;
}

async function waitForTableText(table, expectedText, timeout) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    const text = await table.textContent();

    if (text?.includes(expectedText)) {
      return;
    }

    await table.page().waitForTimeout(250);
  }

  throw new Error(`Expected table text to include ${expectedText}.`);
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
  const idleMs = readPositiveInteger(process.env.MODEL_REQUEST_IDLE_TIMEOUT_MS, 120_000);
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

async function expectButtonDetached(page, name, timeout) {
  await page.waitForFunction(
    (accessibleName) => {
      const candidates = Array.from(document.querySelectorAll("button"));
      return !candidates.some((button) => button.getAttribute("aria-label") === accessibleName || button.textContent?.trim() === accessibleName);
    },
    name,
    { timeout }
  );
}

function redactUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return "<invalid-url>";
  }
}
