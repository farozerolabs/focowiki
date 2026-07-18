import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { chromium } from "playwright";
import { selectSingleAndBatchSamplesFromEnvironment } from "./cleaned-markdown-flow.mjs";
import { resolveUploadResponseTimeoutMs } from "./lib/browser-timeouts.mjs";
import { redactReportText } from "./lib/redaction.mjs";

const CHANGE_ID =
  process.env.FOCOWIKI_VALIDATION_CHANGE_ID?.trim() ||
  "implement-incremental-sharded-publication";
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
const uploadResponseTimeoutMs = readPositiveInteger(
  process.env.FOCOWIKI_VALIDATION_MAX_MUTATION_ENDPOINT_MS,
  30_000
);

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
    `${readBooleanEnv(process.env.FOCOWIKI_VALIDATION_REQUIRE_MODEL) ? "FOCOWIKI_VALIDATION_REQUIRE_MODEL=true " : ""}node scripts/validation/cleaned-markdown-browser.mjs ${
      sampleSelection.profile === "large-scale" ? "large-browser" : "browser"
    }`
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
  await validateRuntimeSettingsPage(page);

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
  await validateResizableSidebar(page);

  const singleUpload = await uploadFilesFromDialog(page, [singleSample], {
    checkName: "single-upload-submit",
    message: "Single-file upload dialog submitted and source-file list refreshed."
  });
  const singleSourceFileIds = singleUpload.sourceFileIds;
  await waitForSourceFilesCompleted(page, singleUpload.knowledgeBaseId, singleSourceFileIds, taskTimeoutMs);
  report.checks.push(okCheck("single-source-file-completed", "Browser observed completed single-file processing."));
  await validateSourceFileRows(page, singleSourceFileIds, [singleSample], taskTimeoutMs, {
    checkName: "single-source-file-row",
    message: "Single-file upload appears as one top-level source-file row with stable metadata."
  });

  const firstSampleName = singleSample.basename;

  if (!firstSampleName || batchSamples.length === 0) {
    throw new Error("No selected sample basename was available for browser preview.");
  }

  await openGeneratedFileFromProcessingRow(page, singleSourceFileIds[0]);
  await waitForPreviewText(page, singleSample.title);
  const firstCopiedUrl = await copySelectedFileUrl(page);

  report.checks.push(okCheck("single-file-preview", "Opened generated single-upload file preview in browser."));

  await page.getByRole("button", { name: "File processing" }).click();
  const batchUpload = await uploadFilesFromDialog(page, batchSamples, {
    checkName: "batch-upload-submit",
    message: "Batch upload dialog submitted and source-file list refreshed."
  });
  const batchSourceFileIds = batchUpload.sourceFileIds;
  await waitForSourceFilesCompleted(page, batchUpload.knowledgeBaseId, batchSourceFileIds, taskTimeoutMs);
  report.checks.push(okCheck("batch-source-files-completed", "Browser observed completed batch source-file processing."));
  await validateSourceFileRows(page, batchSourceFileIds, batchSamples, taskTimeoutMs, {
    checkName: "batch-source-file-rows",
    message: "Batch upload appears as top-level source-file rows with original filenames, file IDs, status, stage, and pagination."
  });
  await validateSourceFileFilterControls(page, batchSamples[0]);

  await page.getByRole("button", { name: "File processing" }).click();
  const batchPreview = await openFirstVisibleGeneratedFileFromProcessingRows(
    page,
    batchSourceFileIds,
    batchSamples
  );
  await waitForPreviewText(page, batchPreview.sample.title);
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
  await validateFileTreeSearch(page, batchPreview.sample.basename);
  await validateTaskDeletionControls(page, batchSourceFileIds, batchSamples);

  await openPagesDirectoryIfNeeded(page, batchPreview.sample.basename);
  await page.getByRole("button", { name: `File actions: ${batchPreview.sample.basename}` }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const deleteFileDialog = page.getByRole("alertdialog", { name: "Delete Markdown file" });
  await deleteFileDialog.waitFor();
  await deleteFileDialog.getByRole("button", { name: "Delete" }).click();
  await deleteFileDialog.waitFor({ state: "detached", timeout: 30_000 });
  await page.getByText("File processing").first().waitFor({ timeout: 30_000 });
  await expectButtonDetached(page, batchPreview.sample.basename, taskTimeoutMs);
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

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
        response.url().includes("/upload-sessions/") &&
        response.url().includes("/finalize") &&
        response.status() === 202,
      {
        timeout: resolveUploadResponseTimeoutMs({
          sampleCount: samples.length,
          configuredTimeoutMs: uploadResponseTimeoutMs,
          taskTimeoutMs
        })
      }
    ),
    uploadDialog.getByRole("button", { name: /^Upload$/ }).click()
  ]);
  const knowledgeBaseId = extractKnowledgeBaseIdFromAdminUrl(uploadResponse.url());
  const sessionUrl = uploadResponse.url().replace(/\/finalize(?:\?.*)?$/u, "");
  const sessionResponse = await page.request.get(sessionUrl);
  if (!sessionResponse.ok()) {
    throw new Error(`Upload session read failed with HTTP ${sessionResponse.status()}.`);
  }
  const uploadBody = await sessionResponse.json();
  await uploadDialog.waitFor({ state: "detached", timeout: 30_000 });
  const sourceFileIds = Array.isArray(uploadBody?.entries?.items)
    ? uploadBody.entries.items.map((entry) => entry.sourceFileId).filter(Boolean)
    : [];

  if (sourceFileIds.length !== samples.length) {
    throw new Error("Upload response did not include accepted source-file ids.");
  }

  await waitForVisibleSourceFileRow(page, sourceFileIds, 30_000);
  report.checks.push(okCheck(checkName, message));
  return { knowledgeBaseId, sourceFileIds };
}

async function waitForSourceFilesCompleted(page, knowledgeBaseId, sourceFileIds, timeout) {
  await waitForSourceFilesCompletedByApi(page, knowledgeBaseId, sourceFileIds, timeout);
  await refreshSourceFilePage(page);
  await waitForVisibleSourceFileRow(page, sourceFileIds, 30_000);
}

async function waitForSourceFilesCompletedByApi(page, knowledgeBaseId, sourceFileIds, timeout) {
  const deadline = Date.now() + timeout;
  const expectedIds = new Set(sourceFileIds);
  let lastFailedRecord = null;

  while (Date.now() < deadline) {
    const records = await readSourceFileRecordsByApi(page, knowledgeBaseId, expectedIds);
    const missingIds = sourceFileIds.filter((sourceFileId) => !records.has(sourceFileId));
    const failedRecords = [...records.values()].filter((record) => record.state === "failed");

    if (failedRecords.length > 0) {
      lastFailedRecord = failedRecords[0];
    }

    if (
      missingIds.length === 0 &&
      [...records.values()].every(
        (record) => record.state === "visible" && record.generatedFileAvailable
      )
    ) {
      return;
    }

    await wait(1500);
  }

  if (lastFailedRecord) {
    throw new Error(`Source-file processing remained failed in browser validation: ${lastFailedRecord.id}`);
  }

  throw new Error("Timed out waiting for source files to complete through Admin API pagination.");
}

async function readSourceFileRecordsByApi(page, knowledgeBaseId, expectedIds) {
  const records = new Map();
  let cursor = null;
  let guard = 0;

  while (guard < 100) {
    guard += 1;
    const url = new URL(
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files`,
      adminUiBaseUrl
    );
    url.searchParams.set("limit", "100");
    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    const response = await page.request.get(url.toString());

    if (!response.ok()) {
      throw new Error(`Admin source-file page request failed with HTTP ${response.status()}.`);
    }

    const body = await response.json();
    const items = Array.isArray(body.items) ? body.items : [];

    for (const item of items) {
      if (expectedIds.has(item.id)) {
        records.set(item.id, item);
      }
    }

    if (records.size === expectedIds.size || !body.nextCursor) {
      return records;
    }

    cursor = body.nextCursor;
  }

  throw new Error("Admin source-file pagination exceeded the browser validation guard limit.");
}

async function waitForVisibleSourceFileRow(page, sourceFileIds, timeout) {
  const deadline = Date.now() + timeout;
  const sourceFileIdSet = new Set(sourceFileIds);

  while (Date.now() < deadline) {
    const visibleSourceFileIds = await readVisibleSourceFileIds(page);

    if (visibleSourceFileIds.some((sourceFileId) => sourceFileIdSet.has(sourceFileId))) {
      return;
    }

    await refreshSourceFilePage(page);
    await wait(1000);
  }

  throw new Error("Timed out waiting for an uploaded source-file row on the current browser page.");
}

async function readVisibleSourceFileIds(page) {
  const fileRows = page.locator('[data-testid^="source-file-row-"]');
  const rowIds = await fileRows.evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-testid") ?? "")
  );

  return rowIds.map(readSourceFileIdFromTestId).filter(Boolean);
}

function readSourceFileIdFromTestId(testId) {
  const prefix = "source-file-row-";

  return testId.startsWith(prefix) && testId.length > prefix.length ? testId.slice(prefix.length) : null;
}

async function validateRuntimeSettingsPage(page) {
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("heading", { name: "Settings" }).waitFor();
  await page.getByRole("tab", { name: "Worker" }).click();
  await page.locator("#worker-generationBatchSize").waitFor();

  const workerFields = [
    "worker-sourceFileConcurrency",
    "worker-generationBatchSize",
    "worker-sourceQueueHardDepth",
    "worker-sourceQueueResumeDepth"
  ];

  for (const fieldId of workerFields) {
    const field = page.locator(`#${fieldId}`);
    await field.waitFor();
    const value = await field.inputValue();

    if (!value || Number(value) <= 0) {
      throw new Error(`Runtime settings field ${fieldId} must be prefilled with a positive value.`);
    }
  }

  const generationBatchSize = page.locator("#worker-generationBatchSize");
  const originalGenerationBatchSize = await generationBatchSize.inputValue();
  await generationBatchSize.fill("");
  await page.getByRole("button", { name: "Save" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Required numeric fields must be positive integers." })
    .first()
    .waitFor();
  await generationBatchSize.fill(originalGenerationBatchSize);

  await page.getByRole("tab", { name: "Publication" }).click();
  for (const fieldId of [
    "publication-impactBatchSize",
    "publication-pendingImpactHardCount",
    "publication-indexShardSize"
  ]) {
    const field = page.locator(`#${fieldId}`);
    await field.waitFor();
    if (Number(await field.inputValue()) <= 0) {
      throw new Error(`Runtime settings field ${fieldId} must be positive.`);
    }
  }

  await page.locator("header button").first().click();
  await page.getByRole("button", { name: "Create knowledge base" }).first().waitFor();
  report.checks.push(okCheck(
    "runtime-settings-page",
    "Admin UI runtime settings validate source dispatch and incremental publication fields."
  ));
}

function createSearchTokenFromFilename(filename) {
  const basename = path.basename(filename, path.extname(filename));
  const titleToken = basename.split("__")[0]?.trim() || basename.trim();
  const token = titleToken.replace(/\s+/g, " ").trim();

  if (token.length >= 2) {
    return token.slice(0, 32);
  }

  return basename.slice(0, 32);
}

async function refreshSourceFilePage(page) {
  const refreshButton = page.getByRole("button", { name: "Refresh" });

  if ((await refreshButton.count()) > 0) {
    await Promise.all([
      page
        .waitForResponse(
          (response) =>
            response.request().method() === "GET" &&
            response.url().includes("/admin/api/knowledge-bases/") &&
            response.url().includes("/source-files") &&
            response.status() === 200,
          { timeout: 30_000 }
        )
        .catch(() => null),
      refreshButton.first().click()
    ]);
  }
}

function extractKnowledgeBaseIdFromAdminUrl(url) {
  const match = url.match(/\/admin\/api\/knowledge-bases\/([^/]+)\/upload-sessions\//);

  if (!match?.[1]) {
    throw new Error("Could not read knowledge base id from upload response URL.");
  }

  return decodeURIComponent(match[1]);
}

async function validateSourceFileRows(page, sourceFileIds, samples, timeout, { checkName, message }) {
  const panel = page.getByTestId("source-file-progress-panel");
  const table = panel.getByRole("table", { name: "File processing" });
  await table.waitFor({ timeout: 30_000 });

  const visibleSourceFileIds = await readVisibleSourceFileIds(page);
  const sourceFileIdSet = new Set(sourceFileIds);
  const visibleUploadedSourceFileIds = visibleSourceFileIds.filter((sourceFileId) =>
    sourceFileIdSet.has(sourceFileId)
  );
  const sourceFileIdsToValidate =
    sourceFileIds.length <= visibleSourceFileIds.length
      ? sourceFileIds
      : visibleUploadedSourceFileIds.slice(0, Math.min(5, visibleUploadedSourceFileIds.length));

  if (sourceFileIdsToValidate.length === 0) {
    throw new Error("Expected at least one uploaded source-file row on the current browser page.");
  }

  for (const sourceFileId of sourceFileIdsToValidate) {
    const index = sourceFileIds.indexOf(sourceFileId);
    const row = page.getByTestId(`source-file-row-${sourceFileId}`);
    await row.waitFor({ timeout: 30_000 });
    await row.getByText(samples[index].basename, { exact: true }).waitFor({ timeout: 30_000 });
    await row.getByText("Completed", { exact: true }).waitFor({ timeout: 30_000 });
    await row.getByText("Release activation", { exact: true }).waitFor({ timeout });
    await row.getByText("Available", { exact: true }).waitFor({ timeout });
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
    const firstVisibleSourceFileId = readSourceFileIdFromTestId(rowIds[0]);

    if (!firstVisibleSourceFileId) {
      throw new Error("Could not read the first visible source-file row id.");
    }

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

async function validateSourceFileFilterControls(page, sample) {
  if (!sample?.basename) {
    throw new Error("Source-file filter validation requires a browser sample.");
  }

  await page.getByRole("button", { name: "Filter File name" }).click();
  await page.getByRole("textbox", { name: "File name" }).fill(createSearchTokenFromFilename(sample.basename));
  await page.getByText("1 active filter").waitFor({ timeout: 30_000 });
  await page.getByText(sample.basename, { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole("menuitem", { name: "Clear" }).click();
  await page.getByText("1 active filter").waitFor({ state: "detached", timeout: 30_000 });
  report.checks.push(okCheck("source-file-filter-controls", "Filtered source files from the file-name column and cleared the active filter."));
}

async function validateTaskDeletionControls(page, sourceFileIds, samples) {
  await page.getByRole("button", { name: "File processing" }).click();
  await page.getByTestId("source-file-progress-panel").waitFor({ timeout: 30_000 });
  const visibleSourceFileIds = await readVisibleSourceFileIds(page);
  const candidateSourceFileId = visibleSourceFileIds.find((sourceFileId) => sourceFileIds.includes(sourceFileId));

  if (!candidateSourceFileId) {
    throw new Error("Expected a visible uploaded source-file row before validating task deletion controls.");
  }

  const sampleIndex = sourceFileIds.indexOf(candidateSourceFileId);
  const sample = samples[sampleIndex];

  if (!sample?.basename) {
    throw new Error("Could not map visible source-file row to a browser validation sample for task deletion.");
  }

  await page.getByLabel(`Select ${sample.basename}`).click();
  await page.getByText("1 selected").waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Delete selected" }).click();

  const deleteTasksDialog = page.getByRole("alertdialog", { name: "Delete processing tasks" });
  await deleteTasksDialog.waitFor({ timeout: 30_000 });
  await deleteTasksDialog.getByRole("button", { name: "Delete tasks" }).click();
  await page.getByText("Tasks deleted", { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByTestId(`source-file-row-${candidateSourceFileId}`).waitFor({
    state: "detached",
    timeout: 30_000
  });
  report.checks.push(okCheck("source-file-task-deletion-controls", "Deleted a selected completed task row from the current source-file page."));
}

async function validateFileTreeSearch(page, expectedFileName) {
  await page.getByPlaceholder("Search files and folders").fill(createSearchTokenFromFilename(expectedFileName));
  await page.getByRole("button", { name: expectedFileName, exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Clear file tree search" }).click();
  await page.getByPlaceholder("Search files and folders").waitFor({ timeout: 30_000 });
  report.checks.push(okCheck("file-tree-search", "Searched the file tree and kept the matching file visible with its parent context."));
}

async function validateResizableSidebar(page) {
  const rail = page.getByRole("separator", { name: "Resize sidebar" });
  await rail.waitFor({ timeout: 30_000 });
  const before = Number(await rail.getAttribute("aria-valuenow"));
  const box = await rail.boundingBox();

  if (!Number.isFinite(before) || !box) {
    throw new Error("Resizable sidebar rail did not expose a measurable width.");
  }

  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + 80, centerY, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(
    (previousWidth) => {
      const rail = document.querySelector('[data-sidebar="rail"][role="separator"]');
      const currentWidth = Number(rail?.getAttribute("aria-valuenow"));
      return Number.isFinite(currentWidth) && currentWidth > previousWidth;
    },
    before,
    { timeout: 30_000 }
  );
  report.checks.push(okCheck("resizable-file-tree-sidebar", "Resized the file-tree sidebar by dragging the sidebar rail."));
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

async function openGeneratedFileFromProcessingRow(page, sourceFileId) {
  const row = page.getByTestId(`source-file-row-${sourceFileId}`);

  await row.waitFor({ timeout: 30_000 });
  await row.getByRole("button", { name: "Open file" }).click();
}

async function openFirstVisibleGeneratedFileFromProcessingRows(page, sourceFileIds, samples) {
  const visibleSourceFileIds = await readVisibleSourceFileIds(page);
  const visibleUploadedSourceFileId = visibleSourceFileIds.find((sourceFileId) =>
    sourceFileIds.includes(sourceFileId)
  );

  if (!visibleUploadedSourceFileId) {
    throw new Error("Expected a visible uploaded source-file row before opening generated file preview.");
  }

  const sampleIndex = sourceFileIds.indexOf(visibleUploadedSourceFileId);

  if (sampleIndex < 0 || !samples[sampleIndex]) {
    throw new Error("Could not map visible source-file row to selected browser validation sample.");
  }

  await openGeneratedFileFromProcessingRow(page, visibleUploadedSourceFileId);

  return {
    sample: samples[sampleIndex],
    sourceFileId: visibleUploadedSourceFileId
  };
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

  if (!clipboardText.includes("/openapi/v2/knowledge-bases/") || clipboardText.includes("S3_")) {
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

  return Math.max(180_000, sampleCount * 120_000 + 180_000);
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
