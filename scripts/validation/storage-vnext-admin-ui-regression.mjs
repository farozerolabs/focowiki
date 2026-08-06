import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "../../apps/admin/node_modules/vite/dist/node/index.js";

const adminRoot = fileURLToPath(new URL("../../apps/admin/", import.meta.url));
const runToken = randomUUID().replaceAll("-", "").slice(0, 12);
const runOwnedKnowledgeBaseId = `kb-run-owned-${runToken}`;
const runOwnedName = `Run-owned browser ${runToken}`;
const renamedRunOwnedName = `${runOwnedName} updated`;
const controlKnowledgeBase = Object.freeze({
  id: "kb-control-immutable",
  name: "Immutable control knowledge base",
  description: "Read-only browser regression control",
  activeGenerationId: "generation-control",
  resourceRevision: 7,
  catalogGeneration: 7,
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z"
});
const controlSnapshot = JSON.stringify(controlKnowledgeBase);
const writeTargets = [];
const checks = [];
const unknownRequests = [];
const state = {
  authenticated: false,
  knowledgeBases: [controlKnowledgeBase],
  sourcePollCount: 0,
  uploadFinalized: false,
  uploadedContent: false,
  maintenanceActive: false,
  deleted: false,
  uploadEntryPath: "upload-check.md"
};

let server;
let browser;

try {
  server = await createServer({
    root: adminRoot,
    configFile: `${adminRoot}/vite.config.ts`,
    clearScreen: false,
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false
    }
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address === "object", "Vite did not expose a local address");
  const adminUrl = `http://127.0.0.1:${address.port}`;

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: "en-US",
    viewport: { width: 1440, height: 1000 }
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await context.newPage();
  await page.route("**/admin/api/**", (route) => handleAdminApiRoute(route));

  await runBrowserScenario(page, adminUrl);

  assert.equal(JSON.stringify(controlKnowledgeBase), controlSnapshot);
  assert.ok(writeTargets.length >= 8, "Expected the run-owned lifecycle to issue writes");
  assert.ok(
    writeTargets.every((target) => target.knowledgeBaseId === runOwnedKnowledgeBaseId),
    "Every knowledge-base write must target only the run-owned knowledge base"
  );
  assert.deepEqual(unknownRequests, []);
  assert.equal(state.deleted, true);

  console.log(JSON.stringify({
    kind: "storage-vnext-admin-ui-regression",
    ok: true,
    runOwnedKnowledgeBaseId,
    checks,
    sourcePollCount: state.sourcePollCount,
    writeCount: writeTargets.length,
    controlKnowledgeBaseUnchanged: true
  }, null, 2));
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
}

async function runBrowserScenario(page, adminUrl) {
  await page.goto(adminUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Language" }).click();
  await page.getByRole("menuitemradio", { name: "Chinese" }).click();
  await page.getByRole("button", { name: "登录" }).waitFor();
  await page.getByRole("button", { name: "语言" }).click();
  await page.getByRole("menuitemradio", { name: "English" }).click();
  await page.getByRole("button", { name: "Log in" }).waitFor();
  recordCheck("productCopy", "Released English and Chinese login copy is available.");

  await page.getByLabel("Username").fill("run-owned-admin");
  await page.getByLabel("Password").fill("run-owned-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await page.getByRole("button", { name: "Create knowledge base" }).first().waitFor();
  recordCheck("navigation", "Login and locale navigation reached the released home route.");

  await page.getByRole("button", { name: controlKnowledgeBase.name, exact: true }).waitFor();
  await page.getByRole("button", { name: "Create knowledge base" }).first().click();
  const createDialog = page.getByRole("dialog", { name: "Create knowledge base" });
  await createDialog.getByText(
    "Create a knowledge base before uploading Markdown sources.",
    { exact: true }
  ).waitFor();
  await createDialog.getByLabel("Knowledge base name").fill(runOwnedName);
  await createDialog.getByLabel("Description").fill("Run-owned browser regression data");
  await createDialog.getByRole("button", { name: "Create", exact: true }).click();
  await createDialog.waitFor({ state: "detached" });
  await page.getByRole("button", { name: runOwnedName, exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: controlKnowledgeBase.name, exact: true }).count(), 1);
  recordCheck("list", "The list preserves the immutable control and adds one run-owned knowledge base.");

  await page.getByRole("button", { name: `Knowledge base actions for ${runOwnedName}` }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const editDialog = page.getByRole("dialog", { name: "Edit knowledge base" });
  await editDialog.getByLabel("Knowledge base name").fill(renamedRunOwnedName);
  await editDialog.getByLabel("Description").fill("Updated run-owned browser regression data");
  await editDialog.getByRole("button", { name: "Save", exact: true }).click();
  await editDialog.waitFor({ state: "detached" });
  await page.getByRole("button", { name: renamedRunOwnedName, exact: true }).waitFor();
  recordCheck("mutation", "Knowledge-base metadata mutation updates dynamic card data.");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const expectedTabs = [
    "API limits",
    "Worker",
    "Publication",
    "Graph",
    "Maintenance",
    "Search",
    "Models"
  ];
  for (const tab of expectedTabs) {
    await page.getByRole("tab", { name: tab, exact: true }).waitFor();
  }
  for (const removedFieldId of [
    "worker-generationBatchSize",
    "worker-hardDeleteVersionPurgeEnabled",
    "publication-generationAssemblyConcurrency",
    "publication-generationRetentionDays",
    "maintenance-migrationBackfillConcurrency",
    "maintenance-lexicalRebuildDatabaseWriteConcurrency",
    "maintenance-lexicalRebuildClaimBatchSize",
    "maintenance-lexicalRebuildDatabaseBatchSize"
  ]) {
    assert.equal(await page.locator(`#${removedFieldId}`).count(), 0, `${removedFieldId} must remain absent`);
  }
  recordCheck("settings", "Released settings tabs render dynamic values without removed fields.");
  await page.getByRole("button", { name: "Knowledge bases", exact: true }).click();

  await page.getByRole("button", { name: renamedRunOwnedName, exact: true }).click();
  await page.getByText("File processing", { exact: true }).first().waitFor();
  await page.locator('[data-slot="knowledge-base-detail-content"]').waitFor();
  const detailLayout = await page.locator('[data-slot="knowledge-base-detail-content"]').evaluate((element) => ({
    className: element.className,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
  }));
  for (const requiredClass of ["flex", "min-h-0", "min-w-0", "overflow-hidden", "p-4"]) {
    assert.ok(detailLayout.className.split(/\s+/u).includes(requiredClass), `Missing released class ${requiredClass}`);
  }
  assert.equal(detailLayout.horizontalOverflow, false);
  recordCheck("layout", "Released detail layout classes render without horizontal page overflow.");

  const pollBaseline = state.sourcePollCount;
  await waitForCondition(() => state.sourcePollCount >= Math.max(3, pollBaseline + 1), 8_000);
  await page.getByText("Visible", { exact: true }).first().waitFor({ timeout: 8_000 });
  recordCheck("polling", "Browser polling advanced source processing from running to visible.");

  await page.getByRole("button", { name: "guide.md", exact: true }).first().click();
  await page.getByText("Run-owned Guide", { exact: true }).first().waitFor();
  await page.getByText("Dynamic preview content.", { exact: true }).waitFor();
  recordCheck("detail", "The file tree opens dynamic generated-file detail content.");

  await page.getByRole("button", { name: "File actions: guide.md" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const fileDeleteDialog = page.getByRole("alertdialog", { name: "Delete Markdown file" });
  await fileDeleteDialog.getByText(
    "Delete guide.md and republish the knowledge base.",
    { exact: true }
  ).waitFor();
  await fileDeleteDialog.getByRole("button", { name: "Cancel" }).click();
  await fileDeleteDialog.waitFor({ state: "detached" });

  await page.getByRole("button", { name: "File processing", exact: true }).click();
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  const uploadDialog = page.getByRole("dialog", { name: "Markdown sources" });
  await uploadDialog.locator("#source-files").setInputFiles({
    name: "upload-check.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Upload Check\n\nRun-owned upload content.\n", "utf8")
  });
  await uploadDialog.getByText("1 selected Markdown file", { exact: true }).waitFor();
  await uploadDialog.getByRole("button", { name: "Upload", exact: true }).click();
  await uploadDialog.waitFor({ state: "detached", timeout: 10_000 });
  assert.equal(state.uploadFinalized, true);
  assert.equal(state.uploadedContent, true);
  recordCheck("upload", "Upload dialog completed manifest, content transfer, and finalization.");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByText("Maintenance required", { exact: true }).waitFor();
  await page.getByText("Idle", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Maintain index", exact: true }).click();
  const maintenanceDialog = page.getByRole("alertdialog", {
    name: "Maintain this knowledge base?"
  });
  await maintenanceDialog.getByRole("button", { name: "Start maintenance" }).click();
  await maintenanceDialog.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Maintenance in progress", exact: true }).waitFor();
  await page.getByText("Running", { exact: true }).waitFor();
  recordCheck("maintenance", "Maintenance changes from required and idle to active and running.");

  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: renamedRunOwnedName, exact: true }).waitFor();
  await page.getByRole("button", {
    name: `Knowledge base actions for ${renamedRunOwnedName}`
  }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const knowledgeBaseDeleteDialog = page.getByRole("alertdialog", {
    name: "Delete knowledge base"
  });
  await knowledgeBaseDeleteDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await knowledgeBaseDeleteDialog.waitFor({ state: "detached" });
  await page.getByRole("button", { name: renamedRunOwnedName, exact: true }).waitFor({ state: "detached" });
  await page.getByRole("button", { name: controlKnowledgeBase.name, exact: true }).waitFor();
  recordCheck("delete", "Only the run-owned knowledge base is deleted; the control remains visible.");
}

async function handleAdminApiRoute(route) {
  const request = route.request();
  const method = request.method();
  const url = new URL(request.url());
  const pathname = url.pathname;

  if (pathname === "/admin/api/session" && method === "GET") {
    return fulfillJson(route, state.authenticated ? 200 : 401, {
      authenticated: state.authenticated
    });
  }
  if (pathname === "/admin/api/login" && method === "POST") {
    state.authenticated = true;
    return fulfillJson(route, 200, { authenticated: true });
  }
  if (pathname === "/admin/api/settings/runtime" && method === "GET") {
    return fulfillJson(route, 200, runtimeSettingsFixture());
  }
  if (pathname === "/admin/api/knowledge-bases" && method === "GET") {
    const query = url.searchParams.get("query")?.toLowerCase() ?? "";
    const items = state.knowledgeBases.filter((item) =>
      !query || `${item.id} ${item.name} ${item.description ?? ""}`.toLowerCase().includes(query)
    );
    return fulfillJson(route, 200, { items, nextCursor: null });
  }
  if (pathname === "/admin/api/knowledge-bases" && method === "POST") {
    const body = request.postDataJSON();
    assert.match(body.name, /^Run-owned browser /u);
    assertRunOwnedWrite(runOwnedKnowledgeBaseId, method, pathname);
    const knowledgeBase = {
      id: runOwnedKnowledgeBaseId,
      name: body.name,
      description: body.description ?? null,
      activeGenerationId: "generation-run-owned",
      resourceRevision: 1,
      catalogGeneration: 1,
      createdAt: "2026-08-02T01:00:00.000Z",
      updatedAt: "2026-08-02T01:00:00.000Z"
    };
    state.knowledgeBases = [knowledgeBase, controlKnowledgeBase];
    return fulfillJson(route, 201, { knowledgeBase });
  }

  const knowledgeBaseMatch = pathname.match(/^\/admin\/api\/knowledge-bases\/([^/]+)(.*)$/u);
  if (knowledgeBaseMatch) {
    const knowledgeBaseId = decodeURIComponent(knowledgeBaseMatch[1]);
    const suffix = knowledgeBaseMatch[2];

    if (suffix === "" && method === "GET") {
      const knowledgeBase = state.knowledgeBases.find((item) => item.id === knowledgeBaseId);
      return knowledgeBase
        ? fulfillJson(route, 200, { knowledgeBase })
        : fulfillJson(route, 404, { error: { messageKey: "errors.notFound" } });
    }
    if (suffix === "" && method === "PATCH") {
      assertRunOwnedWrite(knowledgeBaseId, method, pathname);
      const body = request.postDataJSON();
      const current = requireRunOwnedKnowledgeBase();
      const knowledgeBase = {
        ...current,
        name: body.name,
        description: body.description,
        resourceRevision: current.resourceRevision + 1,
        updatedAt: "2026-08-02T01:01:00.000Z"
      };
      state.knowledgeBases = [knowledgeBase, controlKnowledgeBase];
      return fulfillJson(route, 200, { knowledgeBase, publicationQueued: true });
    }
    if (suffix === "" && method === "DELETE") {
      assertRunOwnedWrite(knowledgeBaseId, method, pathname);
      state.knowledgeBases = [controlKnowledgeBase];
      state.deleted = true;
      return fulfillJson(route, 200, { deleted: true });
    }
    if (suffix === "/files/tree" && method === "GET") {
      return fulfillJson(route, 200, generatedTreeFixture());
    }
    if (suffix === "/files/tree/search" && method === "GET") {
      return fulfillJson(route, 200, { items: [], nextCursor: null });
    }
    if (suffix === "/files/detail" && method === "GET") {
      return fulfillJson(route, 200, generatedFileFixture());
    }
    if (suffix === "/public-urls" && method === "GET") {
      return fulfillJson(route, 200, { publicUrls: publicUrlsFixture() });
    }
    if (suffix === "/source-files" && method === "GET") {
      state.sourcePollCount += 1;
      return fulfillJson(route, 200, sourceFilePageFixture());
    }
    if (suffix === "/processing-summary" && method === "GET") {
      return fulfillJson(route, 200, processingSummaryFixture());
    }
    if (suffix === "/operations" && method === "GET") {
      return fulfillJson(route, 200, { items: [], nextCursor: null });
    }
    if (suffix === "/index-maintenance" && method === "POST") {
      assertRunOwnedWrite(knowledgeBaseId, method, pathname);
      state.maintenanceActive = true;
      return fulfillJson(route, 202, {
        result: "accepted",
        maintenance: processingSummaryFixture().indexMaintenance
      });
    }
    if (suffix.startsWith("/upload-sessions")) {
      return handleUploadSessionRoute(route, knowledgeBaseId, suffix);
    }
  }

  unknownRequests.push(`${method} ${pathname}`);
  return fulfillJson(route, 404, { error: { messageKey: "errors.notFound" } });
}

function handleUploadSessionRoute(route, knowledgeBaseId, suffix) {
  const request = route.request();
  const method = request.method();
  const sessionId = "upload-session-run-owned";
  const entryId = "upload-entry-run-owned";

  assertRunOwnedWrite(knowledgeBaseId, method, request.url());
  if (suffix === "/upload-sessions" && method === "POST") {
    return fulfillJson(route, 201, {
      session: uploadSessionFixture("draft"),
      transport: { manifestPageSize: 50, contentUploadConcurrency: 1 }
    });
  }
  if (suffix === `/upload-sessions/${sessionId}/entries` && method === "POST") {
    const body = request.postDataJSON();
    state.uploadEntryPath = body.entries[0]?.relativePath ?? state.uploadEntryPath;
    return fulfillJson(route, 200, { session: uploadSessionFixture("manifest_building") });
  }
  if (suffix === `/upload-sessions/${sessionId}/seal` && method === "POST") {
    return fulfillJson(route, 200, {
      session: uploadSessionFixture("manifest_sealed", { selected: 1, uploadRequired: 1 }),
      sample: [uploadEntryFixture(entryId, "missing")],
      nextCursor: null
    });
  }
  if (suffix === `/upload-sessions/${sessionId}` && method === "GET") {
    return fulfillJson(route, 200, {
      session: uploadSessionFixture("uploading", { selected: 1, uploadRequired: 1 }),
      entries: { items: [uploadEntryFixture(entryId, "missing")], nextCursor: null }
    });
  }
  if (suffix === `/upload-sessions/${sessionId}/entries/${entryId}/content` && method === "PUT") {
    state.uploadedContent = true;
    return fulfillJson(route, 200, { entry: uploadEntryFixture(entryId, "uploaded") });
  }
  if (suffix === `/upload-sessions/${sessionId}/finalize` && method === "POST") {
    state.uploadFinalized = true;
    return fulfillJson(route, 200, {
      session: uploadSessionFixture("completed", {
        selected: 1,
        uploadRequired: 1,
        uploaded: 1,
        finalized: 1
      })
    });
  }
  return fulfillJson(route, 404, { error: { messageKey: "errors.uploadFailed" } });
}

function assertRunOwnedWrite(knowledgeBaseId, method, path) {
  assert.equal(
    knowledgeBaseId,
    runOwnedKnowledgeBaseId,
    `Blocked ${method} write to non-run-owned knowledge base ${knowledgeBaseId}`
  );
  writeTargets.push({ knowledgeBaseId, method, path });
}

function requireRunOwnedKnowledgeBase() {
  const knowledgeBase = state.knowledgeBases.find((item) => item.id === runOwnedKnowledgeBaseId);
  assert.ok(knowledgeBase, "Run-owned knowledge base is missing");
  return knowledgeBase;
}

function sourceFilePageFixture() {
  const visible = state.sourcePollCount >= 3;
  const source = {
    id: "source-run-owned-guide",
    name: "guide.md",
    relativePath: "guide.md",
    resourceRevision: 1,
    state: visible ? "visible" : "running",
    currentStage: visible ? "generation_activation" : "metadata_resolution",
    failure: null,
    actions: visible ? [{
      kind: "open_generated_file",
      method: "GET",
      href: `/admin/api/knowledge-bases/${runOwnedKnowledgeBaseId}/files/detail?path=pages%2Fguide.md`,
      scope: "source_file"
    }] : [],
    processingStartedAt: "2026-08-02T01:02:00.000Z",
    processingEndedAt: visible ? "2026-08-02T01:02:02.000Z" : null,
    generatedOutputStatus: visible ? "visible" : "pending",
    generatedFileAvailable: visible,
    generatedFilePath: "pages/guide.md",
    generatedFileId: "file-run-owned-guide",
    graphSummary: {
      sourceFileId: "source-run-owned-guide",
      relationshipCount: 0,
      relationships: []
    },
    createdAt: "2026-08-02T01:02:00.000Z"
  };
  const items = [source];
  if (state.uploadFinalized) {
    items.unshift({
      ...source,
      id: "source-run-owned-upload",
      name: state.uploadEntryPath,
      relativePath: state.uploadEntryPath,
      generatedFilePath: "pages/upload-check.md",
      generatedFileId: "file-run-owned-upload",
      graphSummary: {
        sourceFileId: "source-run-owned-upload",
        relationshipCount: 0,
        relationships: []
      }
    });
  }
  return { items, nextCursor: null, refreshAfterMs: 2_000 };
}

function generatedTreeFixture() {
  return {
    items: [{
      id: "tree-run-owned-guide",
      name: "guide.md",
      logicalPath: "pages/guide.md",
      entryType: "file",
      generatedFileId: "file-run-owned-guide",
      sourceFileId: "source-run-owned-guide",
      resourceRevision: 1,
      fileKind: "page",
      deletable: true
    }],
    nextCursor: null
  };
}

function generatedFileFixture() {
  return {
    file: {
      id: "file-run-owned-guide",
      sourceFileId: "source-run-owned-guide",
      fileKind: "page",
      logicalPath: "pages/guide.md",
      contentType: "text/markdown",
      title: "Run-owned Guide",
      deletable: true
    },
    relationships: [],
    content: "# Run-owned Guide\n\nDynamic preview content.\n",
    readOnly: true
  };
}

function publicUrlsFixture() {
  const base = `https://run-owned.invalid/openapi/v2/knowledge-bases/${runOwnedKnowledgeBaseId}`;
  return {
    index: `${base}/files/content?path=index.md`,
    search: `${base}/files/content?path=_index%2Fsearch.json`,
    links: `${base}/files/content?path=_index%2Flinks.json`
  };
}

function processingSummaryFixture() {
  const sourceRunning = state.sourcePollCount < 3;
  return {
    activeGenerationId: "generation-run-owned",
    pendingDispatch: {
      pendingCount: 0,
      oldestPendingAt: null,
      paused: false,
      pausedReason: null
    },
    sourceFileJobs: queueSummary(sourceRunning ? 1 : 0),
    publicationJobs: queueSummary(0),
    publicationProgress: {
      generationId: "generation-run-owned",
      stage: null,
      processedImpactCount: 1,
      totalImpactCount: 1,
      touchedShardCount: 1,
      throughputPerMinute: 30,
      oldestDirtyAt: null,
      queuedAt: null,
      startedAt: null,
      heartbeatAt: null,
      completedAt: "2026-08-02T01:02:02.000Z",
      lastSuccessAt: "2026-08-02T01:02:02.000Z",
      safeErrorCode: null,
      safeErrorMessage: null
    },
    maintenanceProgress: {
      migration: null,
      lexicalRebuild: null,
      projectionRepair: null,
      compaction: { active: null, latestCompleted: null }
    },
    indexMaintenance: state.maintenanceActive ? {
      requestId: "maintenance-run-owned",
      state: "running",
      trigger: "manual",
      stage: "search:rebuild",
      active: true,
      completedCount: 2,
      expectedCount: 5,
      retryCount: 0,
      lastProgressAt: "2026-08-02T01:03:00.000Z",
      lastCompletedAt: null,
      maintenanceRequired: true,
      safeErrorCode: null,
      safeErrorMessage: null
    } : {
      requestId: null,
      state: "idle",
      trigger: null,
      stage: null,
      active: false,
      completedCount: 0,
      expectedCount: 0,
      retryCount: 0,
      lastProgressAt: null,
      lastCompletedAt: null,
      maintenanceRequired: true,
      safeErrorCode: null,
      safeErrorMessage: null
    },
    dirtySourceFiles: { count: 0, oldestDirtyAt: null }
  };
}

function queueSummary(runningCount) {
  return {
    queuedCount: 0,
    runningCount,
    completedCount: runningCount ? 0 : 1,
    failedCount: 0,
    deadLetterCount: 0,
    oldestQueuedAt: null,
    oldestQueuedAgeSeconds: null
  };
}

function uploadSessionFixture(sessionState, overrides = {}) {
  return {
    id: "upload-session-run-owned",
    knowledgeBaseId: runOwnedKnowledgeBaseId,
    state: sessionState,
    declaredFileCount: 1,
    declaredByteCount: 43,
    counts: {
      selected: 0,
      uploadRequired: 0,
      skippedExisting: 0,
      waitingReservation: 0,
      rejectedDeleting: 0,
      uploaded: 0,
      failed: 0,
      finalized: 0,
      ...overrides
    },
    expiresAt: "2026-08-02T02:00:00.000Z"
  };
}

function uploadEntryFixture(id, transferState) {
  return {
    id,
    relativePath: state.uploadEntryPath,
    directoryPath: "",
    name: state.uploadEntryPath,
    declaredSize: 43,
    receivedSize: transferState === "uploaded" ? 43 : null,
    disposition: "upload_required",
    transferState,
    sourceDirectoryId: null,
    sourceFileId: "source-run-owned-upload",
    existingResourceRevision: null,
    generatedPath: "pages/upload-check.md",
    errorCode: null
  };
}

function runtimeSettingsFixture() {
  return {
    settings: {
      rateLimits: {
        adminLogin: { max: 8, windowSeconds: 900 },
        adminApi: { max: 600, windowSeconds: 60 },
        publicOpenApi: { max: 1200, windowSeconds: 60 }
      },
      worker: {
        sourceFileConcurrency: 2,
        sourceObjectReadConcurrency: 2,
        graphQueryConcurrency: 2,
        databaseMutationConcurrency: 2,
        claimBatchSize: 10,
        pollIntervalMs: 1000,
        lockTtlSeconds: 900,
        heartbeatIntervalMs: 15000,
        jobMaxAttempts: 3,
        jobRetryDelayMs: 30000,
        sourceQueueHardDepth: 5000,
        sourceQueueResumeDepth: 3000,
        sourceQueueHardAgeSeconds: 3600,
        sourceQueueResumeAgeSeconds: 1800,
        shutdownGraceMs: 30000,
        completedJobRetentionDays: 7,
        failedJobRetentionDays: 30,
        deadLetterJobRetentionDays: 90,
        retentionCleanupBatchSize: 1000,
        hardDeleteConcurrency: 1,
        hardDeleteDatabaseBatchSize: 1000,
        hardDeleteObjectBatchSize: 1000,
        hardDeleteMaxAttempts: 3,
        hardDeleteRetryDelayMs: 60000,
        hardDeleteFailedRetentionDays: 30
      },
      publication: {
        mode: "batch",
        batchSize: 300,
        intervalSeconds: 300,
        roleConcurrency: 1,
        claimBatchSize: 1,
        impactBatchSize: 100,
        impactConcurrency: 8,
        projectionPartitionConcurrency: 8,
        generatedObjectWriteConcurrency: 8,
        directoryMaterializationConcurrency: 4,
        dirtyFileHardCount: 2000,
        dirtyFileResumeCount: 1000,
        dirtyAgeHardSeconds: 900,
        dirtyAgeResumeSeconds: 300,
        pendingImpactHardCount: 20000,
        pendingImpactResumeCount: 10000,
        indexShardSize: 1000,
        linkIndexShardSize: 1000,
        manifestShardSize: 1000,
        graphEdgeShardSize: 5000,
        graphCandidateLimit: 200,
        graphMaintenanceBatchSize: 500,
        rootSummaryLimit: 500,
        directoryIndexMaxEntries: 200,
        directoryIndexMaxBytes: 65536,
        okfLogMaxEntries: 100,
        okfLogMaxBytes: 65536
      },
      graph: {
        candidateLimit: 200,
        acceptedEdgeLimit: 40,
        searchDefaultDepth: 1,
        searchMaxDepth: 2,
        searchDefaultFanout: 10,
        searchMaxFanout: 25,
        modelReviewEnabled: true,
        publicationShardSize: 5000,
        cacheTtlSeconds: 30,
        genericPhraseThreshold: 4
      },
      maintenance: {
        knowledgeBaseMaintenanceMode: "manual",
        knowledgeBaseMaintenanceScanIntervalSeconds: 21600,
        knowledgeBaseMaintenanceConcurrency: 1,
        reconciliationEnabled: true,
        scanIntervalSeconds: 21600,
        scanBatchSize: 500,
        deletionBatchSize: 100,
        quarantineGracePeriodSeconds: 86400,
        confirmationPasses: 2,
        maxAttempts: 5,
        retryDelayMs: 30000,
        compactionConcurrency: 1
      },
      search: {
        requestTimeoutMs: 3000,
        engineSearchCutoffMs: 1000,
        branchCandidateLimit: 200,
        fusedCandidateLimit: 100,
        overfetchFactor: 3,
        graphSeedLimit: 100,
        graphNeighborLimit: 20,
        cacheTtlSeconds: 15,
        indexBatchDocumentCount: 500,
        indexBatchCompressedBytes: 8388608,
        maxInFlightTasks: 8,
        engineQueueLatencyLimitMs: 30000,
        engineResidentMemoryLimitBytes: 3221225472,
        engineDatabaseSizeLimitBytes: 107374182400,
        engineTaskQueueSizeLimitBytes: 536870912,
        taskPollIntervalMs: 500,
        taskTimeoutMs: 600000,
        maxAttempts: 5,
        retryDelayMs: 2000,
        cleanupBatchSize: 1000,
        stagingRetentionHours: 24,
        cropLength: 1200
      },
      activeModel: null
    },
    models: [],
    maintenanceStatus: null,
    objectProtectionStatus: null
  };
}

function fulfillJson(route, status, body) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body)
  });
}

function recordCheck(name, message) {
  checks.push({ name, ok: true, message });
}

async function waitForCondition(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the browser regression condition");
}
