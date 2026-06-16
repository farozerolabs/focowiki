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
  commandsRun: ["pnpm validate:real-legal:browser"],
  testsRun: [
    "Admin UI browser flow",
    "single-file upload",
    "multi-file batch upload",
    "expandable upload task file table",
    "task source pagination",
    "preview, copy, source-backed deletion, and knowledge base deletion"
  ],
  validationPasses: [
    "Pass 1: browser login, language switching, and security header validation.",
    "Pass 2: browser single-upload and batch-upload task validation.",
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
  await page.getByText("Upload tasks").first().waitFor();
  await page.getByRole("button", { name: /^Upload$/ }).waitFor();
  report.checks.push(okCheck("knowledge-base", "Created and opened validation knowledge base."));

  const singleUploadTaskId = await uploadFilesFromDialog(page, [singleSample], {
    checkName: "single-upload-submit",
    message: "Single-file upload dialog submitted and task list refreshed."
  });
  await waitForTaskEnded(page, singleUploadTaskId, taskTimeoutMs);
  report.checks.push(okCheck("single-task-ended", "Browser observed ended single-file upload task."));
  await validateExpandedTaskFileTable(page, singleUploadTaskId, [singleSample], {
    checkName: "single-expanded-task-files",
    message: "Single-file task expands to one nested file row with stable file metadata."
  });

  const firstSampleName = singleSample.basename;
  const secondSampleName = batchSamples[0]?.basename;

  if (!firstSampleName || !secondSampleName) {
    throw new Error("No selected sample basename was available for browser preview.");
  }

  await openPagesDirectoryIfNeeded(page, firstSampleName);
  await page.getByRole("button", { name: firstSampleName, exact: true }).click();
  await waitForPreviewText(page, singleSample.title);

  report.checks.push(okCheck("single-file-preview", "Opened generated single-upload file preview in browser."));

  await page.getByRole("button", { name: "Upload tasks" }).click();
  const batchUploadTaskId = await uploadFilesFromDialog(page, batchSamples, {
    checkName: "batch-upload-submit",
    message: "Batch upload dialog submitted and task list refreshed."
  });
  await waitForTaskEnded(page, batchUploadTaskId, taskTimeoutMs);
  report.checks.push(okCheck("batch-task-ended", "Browser observed ended batch upload task."));
  await validateExpandedTaskFileTable(page, batchUploadTaskId, batchSamples, {
    checkName: "batch-expanded-task-files",
    message: "Batch task expands to a nested file table with original filenames, file IDs, status, stage, and pagination."
  });

  await openPagesDirectoryIfNeeded(page, firstSampleName);
  await page.getByRole("button", { name: firstSampleName, exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: secondSampleName, exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: secondSampleName, exact: true }).click();
  await waitForPreviewText(page, batchSamples[0].title);

  report.checks.push(okCheck("batch-file-preview", "Opened generated batch-upload file preview in browser."));

  const copyButton = page.getByRole("button", { name: "Copy index URL" });
  await copyButton.click();
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());

  if (!clipboardText.includes("/kb/") || clipboardText.includes("S3_")) {
    throw new Error("Copied public URL does not look like a scoped public URL.");
  }

  report.checks.push(okCheck("copy-url", "Public URL copy action produced a scoped URL."));

  await page.getByRole("button", { name: `File actions: ${secondSampleName}` }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const deleteFileDialog = page.getByRole("alertdialog", { name: "Delete Markdown file" });
  await deleteFileDialog.waitFor();
  await deleteFileDialog.getByRole("button", { name: "Delete" }).click();
  await deleteFileDialog.waitFor({ state: "detached", timeout: 30_000 });
  await page.getByText("Upload tasks").first().waitFor({ timeout: 30_000 });
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
  const taskId = uploadBody?.task?.id;

  if (!taskId) {
    throw new Error("Upload response did not include a task id.");
  }

  await page.getByTestId(`upload-task-row-${taskId}`).waitFor({ timeout: 30_000 });
  report.checks.push(okCheck(checkName, message));
  return taskId;
}

async function waitForTaskEnded(page, taskId, timeout) {
  await page
    .getByTestId(`upload-task-row-${taskId}`)
    .filter({ hasText: "Upload parsing task ended" })
    .waitFor({ timeout });
}

async function validateExpandedTaskFileTable(page, taskId, samples, { checkName, message }) {
  const taskRow = page.getByTestId(`upload-task-row-${taskId}`);

  if ((await taskRow.count()) !== 1) {
    throw new Error(`Expected one visible task row for ${taskId}.`);
  }

  const expandButton = page.getByRole("button", { name: `Expand task ${taskId}` });
  await expandButton.waitFor({ timeout: 30_000 });
  await expandButton.click();

  const fileTable = page.getByRole("table", { name: `Files for ${taskId}` });
  await fileTable.waitFor({ timeout: 30_000 });
  await fileTable.getByText(samples[0].basename, { exact: true }).waitFor({ timeout: 30_000 });
  await fileTable.getByText("Completed", { exact: true }).first().waitFor({ timeout: 30_000 });
  await fileTable.getByText("Release activation", { exact: true }).first().waitFor({ timeout: 30_000 });

  const fileRows = page.locator(`[data-testid^="upload-task-file-row-${taskId}-"]`);
  const initialRowCount = await fileRows.count();

  if (initialRowCount < 1) {
    throw new Error(`Expected nested file rows for ${taskId}.`);
  }

  const rowIds = await fileRows.evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-testid") ?? "")
  );

  if (rowIds.some((id) => id === `upload-task-file-row-${taskId}-`)) {
    throw new Error("Expanded task file rows did not include stable file ids.");
  }

  const loadMoreFiles = page.getByRole("button", { name: "Load more files" });

  if ((await loadMoreFiles.count()) > 0) {
    await loadMoreFiles.click();
    await fileTable.getByText(samples.at(-1).basename, { exact: true }).waitFor({
      timeout: 30_000
    });
    report.checks.push(okCheck("task-source-pagination", "Browser loaded another source-file page for a task."));
  } else {
    report.checks.push(okCheck("task-source-pagination", "Task source-file page fit within the configured browser page size."));
  }

  await page.getByRole("button", { name: `Collapse task ${taskId}` }).click();
  report.checks.push(okCheck(checkName, message));
}

async function openPagesDirectoryIfNeeded(page, expectedFileName) {
  const expectedFileButton = page.getByRole("button", { name: expectedFileName, exact: true });

  if ((await expectedFileButton.count()) > 0) {
    return;
  }

  const pagesButton = page.getByRole("button", { name: "pages" });
  await pagesButton.waitFor({ timeout: 30_000 });
  await pagesButton.click();
  await expectedFileButton.waitFor({ timeout: 30_000 });
}

async function waitForPreviewText(page, expectedText) {
  await page.locator("article").waitFor({ timeout: 30_000 });

  const found = await page
    .locator("article")
    .filter({ hasText: expectedText })
    .first()
    .waitFor({ timeout: 30_000 })
    .then(() => true)
    .catch(() => false);

  if (!found) {
    throw new Error("Generated file preview did not contain the selected Markdown title.");
  }
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
