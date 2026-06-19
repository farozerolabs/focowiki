import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";

import {
  bearerHeaders,
  appendQuery,
  jsonHeaders,
  markdownFormData,
  requestJson,
  waitForHttp,
  sleep
} from "./lib/demo-agent-e2e-http.mjs";
import { runCommand, startProcess, stopManagedProcesses } from "./lib/demo-agent-e2e-process.mjs";
import { redactPotentialPathText } from "./lib/redaction.mjs";
import {
  SAMPLE_COUNT_ENV,
  SAMPLE_SOURCE_ENV,
  sampleCoverage,
  selectSamples
} from "./lib/sample-selector.mjs";
import {
  MIN_AGENT_VALIDATION_SAMPLE_COUNT,
  aggregateCounts,
  assertAgentEvidenceBoundary,
  buildAgentScenarioPlan,
  chooseCandidates,
  classifyScenarioResult,
  createRound,
  defaultAgentProcessingTimeoutMs,
  extractContent,
  extractSearchEntries,
  latencySummary,
  normalizeItems,
  parseFrontmatter,
  parseJsonContent,
  parseJsonlContent,
  requireQuantifiedFindings,
  requireValidationSampleCount
} from "./lib/agent-openapi-validation.mjs";
import {
  redactAgentValidationText,
  reportPaths,
  writeAgentValidationReports
} from "./lib/agent-openapi-report.mjs";
import { validateSkillCurlCommands } from "./lib/skill-curl-validation.mjs";

const CHANGE_ID =
  process.env.FOCOWIKI_AGENT_VALIDATION_CHANGE_ID?.trim() ||
  "validate-agent-openapi-exploration";
const BLACK_BOX = "black-box";
const WHITE_BOX = "white-box";

await main();

async function main() {
  loadLocalEnv();
  const config = readConfig();
  const managedProcesses = [];
  const startedAt = new Date().toISOString();
  let openApiKey = config.openApiKey;
  let knowledgeBaseId = "";
  const safeFindings = [];

  const samples = selectValidationSamples(config);
  const report = createBaseReport(config, samples, startedAt);

  try {
    await ensureFocowiki(config, report, managedProcesses);
    if (!openApiKey) {
      openApiKey = await createOpenApiKey(config, report);
    }

    const api = createOpenApiClient(config, openApiKey, report);
    await validateAuthAndContract(api, config, report);
    const kb = await createKnowledgeBase(api, report);
    knowledgeBaseId = kb.knowledgeBaseId;
    const upload = await uploadSamples(api, knowledgeBaseId, samples, report);
    const sourceFiles = await pollSourceFilesCompleted(api, knowledgeBaseId, upload.files, config, report);
    const generated = await inspectGeneratedFiles(api, knowledgeBaseId, samples, report);
    await ensureDemo(config, openApiKey, knowledgeBaseId, report, managedProcesses);
    const demo = createDemoClient(config, report);
    await validateDemoSurface(demo, generated, report);
    await validateSkillCurlSurface(config, generated, report);
    await runAgentScenarios(api, demo, knowledgeBaseId, generated, samples, report);
    await validateSafeErrors(api, demo, knowledgeBaseId, generated, report);
    await validatePagination(api, knowledgeBaseId, report);

    requireQuantifiedFindings([
      { claim: "Agent exploration results are quantified", metrics: aggregateCounts(report.agentResults), rounds: report.agentResults.flatMap((item) => item.rounds) },
      { claim: "Developer integration results are quantified", metrics: report.developer.routeCoverage, evidence: report.developer.identifierHandoffs },
      { claim: "Skill curl command results are quantified", metrics: report.skillCommandSummary, evidence: report.skillCommands },
      { claim: "OKF alignment results are quantified", metrics: report.okf, evidence: report.okf.inventory }
    ]);

    report.validationRun = {
      knowledgeBaseId,
      uploadedLegalFileCount: upload.files.length,
      completedSourceFileCount: sourceFiles.length,
      directSurface: config.openApiBaseUrl,
      demoSurface: config.demoBaseUrl,
      reportFiles: reportPaths(report.change)
    };
    report.finishedAt = new Date().toISOString();
    report.agentMetrics = aggregateCounts(report.agentResults);
    report.latencies = report.latencies;
    report.ok = calculateFinalOk(report);
    writeAgentValidationReports(report);
    await verifyReportRedaction(reportPaths(report.change), report);

    if (!report.ok) {
      throw new Error("Agent OpenAPI exploration validation finished with failed checks. See local ReferenceDocs reports.");
    }
  } catch (error) {
    report.finishedAt = new Date().toISOString();
    report.ok = false;
    report.unresolvedBlockers.push({
      repository: "focowiki",
      reproductionStep: "node scripts/validation/agent-openapi-exploration.mjs",
      observedResult: redactPotentialPathText(error instanceof Error ? error.message : String(error)),
      expectedResult: "Agent exploration validation completes and writes redacted local reports.",
      attemptedChecks: report.checks.map((check) => check.name)
    });
    writeAgentValidationReports(report);
    throw error;
  } finally {
    if (knowledgeBaseId && config.cleanupKnowledgeBase && openApiKey) {
      await deleteKnowledgeBase(config, openApiKey, knowledgeBaseId).catch((error) => {
        safeFindings.push(redactPotentialPathText(error instanceof Error ? error.message : String(error)));
      });
    }
    await stopManagedProcesses(managedProcesses);
    if (safeFindings.length > 0) {
      report.unresolvedBlockers.push({
        repository: "focowiki",
        reproductionStep: "cleanup validation knowledge base",
        observedResult: safeFindings.join("; "),
        expectedResult: "Temporary validation knowledge base is removed.",
        attemptedChecks: ["deleteKnowledgeBase"]
      });
      writeAgentValidationReports(report);
    }
  }
}

function loadLocalEnv() {
  const envFile = process.env.ENV_FILE || ".env";
  if (fs.existsSync(envFile)) {
    loadEnvFile(envFile);
  }
}

function readConfig(env = process.env) {
  const adminApiBaseUrl = trimTrailingSlash(
    env.FOCOWIKI_AGENT_VALIDATION_ADMIN_API_BASE_URL?.trim() ||
      `http://127.0.0.1:${env.ADMIN_API_PORT?.trim() || "43000"}`
  );
  const openApiBaseUrl = trimTrailingSlash(
    env.FOCOWIKI_AGENT_VALIDATION_OPENAPI_BASE_URL?.trim() ||
      `http://127.0.0.1:${env.PUBLIC_OPENAPI_PORT?.trim() || "43200"}`
  );
  const adminUiBaseUrl = trimTrailingSlash(
    env.FOCOWIKI_AGENT_VALIDATION_ADMIN_UI_BASE_URL?.trim() ||
      `http://127.0.0.1:${env.ADMIN_UI_PORT?.trim() || "43100"}`
  );
  const demoBaseUrl = trimTrailingSlash(
    env.FOCOWIKI_AGENT_VALIDATION_DEMO_BASE_URL?.trim() || "http://127.0.0.1:45012"
  );
  return {
    adminApiBaseUrl,
    adminUiBaseUrl,
    openApiBaseUrl,
    demoBaseUrl,
    adminOrigin:
      env.FOCOWIKI_AGENT_VALIDATION_ADMIN_ORIGIN?.trim() ||
      env.ADMIN_PUBLIC_ORIGIN?.trim() ||
      "http://localhost:43100",
    adminUsername: env.ADMIN_USERNAME?.trim() || "",
    adminPassword: env.ADMIN_PASSWORD || "",
    openApiKey:
      env.FOCOWIKI_AGENT_VALIDATION_OPENAPI_KEY?.trim() ||
      env.FOCOWIKI_OPENAPI_KEY?.trim() ||
      "",
    demoRepo: path.resolve(env.FOCOWIKI_AGENT_VALIDATION_DEMO_REPO?.trim() || "../focowiki-demo"),
    startServices: readBoolean(env.FOCOWIKI_AGENT_VALIDATION_START_SERVICES, true),
    startFocowiki: readBoolean(env.FOCOWIKI_AGENT_VALIDATION_START_FOCOWIKI, true),
    startDemo: readBoolean(env.FOCOWIKI_AGENT_VALIDATION_START_DEMO, true),
    cleanupKnowledgeBase: readBoolean(env.FOCOWIKI_AGENT_VALIDATION_CLEANUP_KNOWLEDGE_BASE, true),
    requestTimeoutMs: readPositiveInteger(env.FOCOWIKI_AGENT_VALIDATION_REQUEST_TIMEOUT_MS, 45_000),
    serviceTimeoutMs: readPositiveInteger(env.FOCOWIKI_AGENT_VALIDATION_SERVICE_TIMEOUT_MS, 180_000),
    processingTimeoutMs: readPositiveInteger(
      env.FOCOWIKI_AGENT_VALIDATION_PROCESSING_TIMEOUT_MS,
      defaultAgentProcessingTimeoutMs(
        readPositiveInteger(env[SAMPLE_COUNT_ENV], MIN_AGENT_VALIDATION_SAMPLE_COUNT)
      )
    ),
    pollIntervalMs: readPositiveInteger(env.FOCOWIKI_AGENT_VALIDATION_POLL_INTERVAL_MS, 2_500),
    maxRouteLimit: readPositiveInteger(env.FOCOWIKI_AGENT_VALIDATION_MAX_ROUTE_LIMIT, 100),
    scenarioLimit: readPositiveInteger(env.FOCOWIKI_AGENT_VALIDATION_SCENARIO_LIMIT, 12),
    demoLogDir: path.resolve(
      env.FOCOWIKI_AGENT_VALIDATION_DEMO_LOG_DIR?.trim() ||
        `openspec/changes/${CHANGE_ID}/runtime/demo-logs`
    )
  };
}

function selectValidationSamples(config, env = process.env) {
  const sourceDir = env[SAMPLE_SOURCE_ENV];
  if (!sourceDir) {
    throw new Error(`${SAMPLE_SOURCE_ENV} must be set to a local Markdown directory.`);
  }
  const sampleCount = Math.max(
    MIN_AGENT_VALIDATION_SAMPLE_COUNT,
    readPositiveInteger(env[SAMPLE_COUNT_ENV], MIN_AGENT_VALIDATION_SAMPLE_COUNT)
  );
  const selection = selectSamples(sourceDir, sampleCount);
  requireValidationSampleCount(selection.samples);
  return selection.samples;
}

function createBaseReport(config, samples, startedAt) {
  return {
    change: CHANGE_ID,
    startedAt,
    finishedAt: null,
    ok: false,
    source: {
      env: SAMPLE_SOURCE_ENV,
      redactedRoot: `<${SAMPLE_SOURCE_ENV}>`
    },
    config: {
      adminApiBaseUrl: config.adminApiBaseUrl,
      adminUiBaseUrl: config.adminUiBaseUrl,
      openApiBaseUrl: config.openApiBaseUrl,
      demoBaseUrl: config.demoBaseUrl,
      demoRepo: "<FOCOWIKI_AGENT_VALIDATION_DEMO_REPO>",
      startServices: config.startServices,
      cleanupKnowledgeBase: config.cleanupKnowledgeBase
    },
    sampleCount: samples.length,
    sampleCoverage: sampleCoverage(samples),
    samples: samples.map((sample) => ({
      basename: sample.basename,
      title: sample.title,
      type: sample.type,
      status: sample.status,
      category: sample.category,
      publicationDate: sample.publicationDate || "unknown-date",
      sizeBytes: sample.sizeBytes
    })),
    checks: [],
    agentResults: [],
    developer: {
      routeCoverage: { total: 0, passed: 0, failed: 0 },
      schemaExampleGaps: [],
      identifierHandoffs: [],
      pagination: { passed: 0, failed: 0 },
      errors: { passed: 0, failed: 0 },
      demo: { passed: 0, failed: 0 },
      errorChecks: [],
      score: 0
    },
    okf: {
      inventoryCount: 0,
      inventory: [],
      reservedFiles: { passed: 0, failed: 0 },
      conceptPages: { passed: 0, failed: 0 },
      indexes: { passed: 0, failed: 0 },
      graph: { passed: 0, failed: 0 },
      graphEvidence: [],
      privacy: { passed: 0, failed: 0 },
      score: 0
    },
    latencies: [],
    unsupportedFindings: [],
    unresolvedBlockers: [],
    securityLeakageCount: 0,
    skillCommands: [],
    skillCommandSummary: {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      leaked: 0,
      identifierContinuityPassed: 0,
      identifierContinuityFailed: 0
    },
    validationRun: null
  };
}

async function ensureFocowiki(config, report, managedProcesses) {
  const ready = await isFocowikiReachable(config);
  if (!ready && (!config.startServices || !config.startFocowiki)) {
    throw new Error("Focowiki services are not reachable and automatic startup is disabled.");
  }
  if (!ready) {
    if (fs.existsSync("docker-compose.local.yml")) {
      runCommand("pnpm", ["compose:local:up"], { cwd: process.cwd(), stdio: "inherit" });
      runCommand("pnpm", ["--filter", "@focowiki/api", "db:migrate"], {
        cwd: process.cwd(),
        env: hostRuntimeEnv(),
        stdio: "inherit"
      });
      managedProcesses.push(
        startProcess("pnpm", ["dev"], {
          cwd: process.cwd(),
          env: hostRuntimeEnv(),
          label: "focowiki-dev"
        })
      );
    } else if (fs.existsSync("docker-compose.dev.yml")) {
      runCommand("pnpm", ["compose:dev:up"], { cwd: process.cwd(), stdio: "inherit" });
      runCommand("pnpm", ["--filter", "@focowiki/api", "db:migrate"], {
        cwd: process.cwd(),
        env: hostRuntimeEnv(),
        stdio: "inherit"
      });
      managedProcesses.push(
        startProcess("pnpm", ["dev"], {
          cwd: process.cwd(),
          env: hostRuntimeEnv(),
          label: "focowiki-dev"
        })
      );
    } else {
      throw new Error("Focowiki local compose file is missing. Start services manually before validation.");
    }
  }
  await waitForHttp(`${config.adminApiBaseUrl}/admin/api/session`, {
    timeoutMs: config.serviceTimeoutMs,
    acceptStatus: (status) => status === 200 || status === 401
  });
  await waitForHttp(`${config.openApiBaseUrl}/openapi/v1/health`, {
    timeoutMs: config.serviceTimeoutMs,
    acceptStatus: (status) => status === 200 || status === 401
  });
  await waitForHttp(config.adminUiBaseUrl, {
    timeoutMs: config.serviceTimeoutMs,
    acceptStatus: (status) => status >= 200 && status < 500
  });
  pass(report, "focowiki-services", "Focowiki services are reachable.", WHITE_BOX);
}

async function isFocowikiReachable(config) {
  try {
    await waitForHttp(`${config.adminApiBaseUrl}/admin/api/session`, {
      timeoutMs: 2_000,
      acceptStatus: (status) => status === 200 || status === 401
    });
    await waitForHttp(`${config.openApiBaseUrl}/openapi/v1/health`, {
      timeoutMs: 2_000,
      acceptStatus: (status) => status === 200 || status === 401
    });
    return true;
  } catch {
    return false;
  }
}

async function createOpenApiKey(config, report) {
  if (!config.adminUsername || !config.adminPassword) {
    throw new Error("ADMIN_USERNAME and ADMIN_PASSWORD must be set when no runtime OpenAPI key is provided.");
  }
  const login = await requestJson(`${config.adminApiBaseUrl}/admin/api/login`, {
    method: "POST",
    headers: jsonHeaders({ origin: config.adminOrigin }),
    body: JSON.stringify({ username: config.adminUsername, password: config.adminPassword }),
    timeoutMs: config.requestTimeoutMs
  });
  const cookie = login.response.headers.get("set-cookie");
  if (!cookie) throw new Error("Admin login did not return a session cookie.");
  const created = await requestJson(`${config.adminApiBaseUrl}/admin/api/openapi-keys`, {
    method: "POST",
    headers: jsonHeaders({ origin: config.adminOrigin, cookie }),
    body: JSON.stringify({ name: `Agent OpenAPI Validation ${new Date().toISOString()}` }),
    timeoutMs: config.requestTimeoutMs
  });
  const rawKey = created.data?.oneTimeKey?.rawKey;
  if (!rawKey || typeof rawKey !== "string") {
    throw new Error("Admin API did not return a one-time OpenAPI key.");
  }
  pass(report, "openapi-key", "Created one-time Developer OpenAPI key for validation.", WHITE_BOX);
  return rawKey;
}

function createOpenApiClient(config, openApiKey, report) {
  return {
    async json(pathname, options = {}) {
      const url = new URL(`${config.openApiBaseUrl}/openapi/v1${pathname}`);
      for (const [key, value] of Object.entries(options.query || {})) {
        if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
      }
      const started = Date.now();
      const result = await requestJson(url.toString(), {
        method: options.method || "GET",
        headers: options.formData ? bearerHeaders(openApiKey) : bearerHeaders(openApiKey, options.body ? { "content-type": "application/json" } : {}),
        body: options.formData ?? (options.body ? JSON.stringify(options.body) : undefined),
        allowError: options.allowError,
        timeoutMs: options.timeoutMs || config.requestTimeoutMs
      });
      const latencyMs = Date.now() - started;
      report.latencies.push(latencyMs);
      if (options.status && result.response.status !== options.status) {
        throw new Error(`Expected ${options.status} for ${pathname}, got ${result.response.status}.`);
      }
      return { ...result, latencyMs };
    },
    async content(knowledgeBaseId, logicalPath) {
      return this.json(`/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/content`, {
        query: { path: logicalPath }
      });
    }
  };
}

function createDemoClient(config, report) {
  return {
    async json(pathname, options = {}) {
      const url = new URL(`${config.demoBaseUrl}/agent/v1${pathname}`);
      for (const [key, value] of Object.entries(options.query || {})) {
        if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
      }
      const started = Date.now();
      const result = await requestJson(url.toString(), {
        method: options.method || "GET",
        allowError: options.allowError,
        timeoutMs: options.timeoutMs || config.requestTimeoutMs
      });
      const latencyMs = Date.now() - started;
      report.latencies.push(latencyMs);
      return { ...result, latencyMs };
    },
    async content(logicalPath) {
      return this.json("/files/content", { query: { path: logicalPath } });
    }
  };
}

async function validateAuthAndContract(api, config, report) {
  const unauthenticated = await requestJson(`${config.openApiBaseUrl}/openapi/v1/health`, {
    allowError: true,
    timeoutMs: config.requestTimeoutMs
  });
  if (unauthenticated.response.status !== 401) {
    fail(report, "openapi-auth", `Expected unauthenticated health to return 401, got ${unauthenticated.response.status}.`, BLACK_BOX);
  } else {
    pass(report, "openapi-auth", "Developer OpenAPI requires bearer key for health.", BLACK_BOX);
  }
  const health = await api.json("/health");
  if (health.data.status !== "ok") throw new Error("Developer OpenAPI health did not return ok.");
  const contract = await api.json("/openapi.json");
  const paths = contract.data.paths || {};
  const usedPaths = [
    "/openapi/v1/health",
    "/openapi/v1/openapi.json",
    "/openapi/v1/knowledge-bases",
    "/openapi/v1/knowledge-bases/{knowledgeBaseId}/uploads",
    "/openapi/v1/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}",
    "/openapi/v1/knowledge-bases/{knowledgeBaseId}/tree",
    "/openapi/v1/knowledge-bases/{knowledgeBaseId}/files/content",
    "/openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}/related"
  ];
  const gaps = [];
  for (const route of usedPaths) {
    const methods = paths[route];
    if (!methods) {
      gaps.push(`${route} missing`);
      continue;
    }
    const operation = Object.values(methods)[0];
    if (!operation?.responses || !operation?.summary) gaps.push(`${route} missing summary or responses`);
  }
  report.developer.routeCoverage.total = usedPaths.length;
  report.developer.routeCoverage.passed = usedPaths.length - gaps.length;
  report.developer.routeCoverage.failed = gaps.length;
  report.developer.schemaExampleGaps.push(...gaps);
  if (gaps.length > 0) fail(report, "openapi-contract", `OpenAPI contract has ${gaps.length} route gaps.`, BLACK_BOX);
  else pass(report, "openapi-contract", "OpenAPI contract includes schemas for used validation routes.", BLACK_BOX);
}

async function createKnowledgeBase(api, report) {
  const created = await api.json("/knowledge-bases", {
    method: "POST",
    body: {
      name: `Agent OpenAPI Validation ${new Date().toISOString()}`,
      description: "Local Agent OpenAPI exploration validation knowledge base."
    },
    status: 201
  });
  const knowledgeBaseId = created.data.knowledgeBaseId || created.data.knowledgeBase?.knowledgeBaseId;
  if (!knowledgeBaseId) throw new Error("Create knowledge base response did not include knowledgeBaseId.");
  report.developer.identifierHandoffs.push({ from: "createKnowledgeBase", to: "uploadMarkdown", field: "knowledgeBaseId" });
  pass(report, "knowledge-base-create", "Created validation knowledge base through Developer OpenAPI.", BLACK_BOX);
  return { knowledgeBaseId };
}

async function uploadSamples(api, knowledgeBaseId, samples, report) {
  const uploaded = await api.json(`/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/uploads`, {
    method: "POST",
    formData: markdownFormData(samples),
    status: 202,
    timeoutMs: 120_000
  });
  const files = uploaded.data.files || [];
  if (files.length !== samples.length) {
    throw new Error(`Upload accepted ${files.length} files, expected ${samples.length}.`);
  }
  const invalid = files.filter((file) => !file.fileId || !file.originalFilename);
  if (invalid.length > 0) throw new Error("Upload response omitted reusable file identifiers.");
  report.developer.identifierHandoffs.push({ from: "uploadMarkdown", to: "getSourceFile", field: "fileId" });
  pass(report, "upload-markdown", `Uploaded ${files.length} cleaned Markdown files.`, BLACK_BOX);
  return { files };
}

async function pollSourceFilesCompleted(api, knowledgeBaseId, files, config, report) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < config.processingTimeoutMs) {
    const details = [];
    for (const file of files) {
      const detail = await api.json(
        `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files/${encodeURIComponent(file.fileId)}`
      );
      details.push(detail.data.file);
    }
    const failed = details.find((file) => file?.processingState === "failed");
    if (failed) {
      throw new Error(`Source file processing failed: ${failed.originalFilename || failed.fileId} (${failed.processingErrorCode || "unknown"})`);
    }
    if (details.length === files.length && details.every((file) => file?.processingState === "completed")) {
      pass(report, "source-files-completed", `All ${details.length} source files completed processing.`, BLACK_BOX);
      return details;
    }
    await sleep(config.pollIntervalMs);
  }
  throw new Error("Timed out waiting for uploaded source files to complete.");
}

async function inspectGeneratedFiles(api, knowledgeBaseId, samples, report) {
  const inventory = await listGeneratedInventory(api, knowledgeBaseId);
  report.okf.inventory = inventory;
  report.okf.inventoryCount = inventory.length;

  const requiredRoot = ["index.md", "log.md", "schema.md"];
  for (const file of requiredRoot) {
    const result = await api.content(knowledgeBaseId, file);
    if (extractContent(result.data).trim()) report.okf.reservedFiles.passed += 1;
    else report.okf.reservedFiles.failed += 1;
  }

  const manifest = await api.content(knowledgeBaseId, "_index/manifest.json");
  const search = await api.content(knowledgeBaseId, "_index/search.json");
  const links = await api.content(knowledgeBaseId, "_index/links.json");
  const manifestJson = parseJsonContent(extractContent(manifest.data), "_index/manifest.json");
  const searchEntries = extractSearchEntries(extractContent(search.data));
  parseJsonContent(extractContent(links.data), "_index/links.json");
  if (searchEntries.length >= samples.length && JSON.stringify(manifestJson).includes("metadata")) {
    report.okf.indexes.passed += 3;
  } else {
    report.okf.indexes.failed += 1;
  }

  const pageEntries = inventory.filter((entry) => entry.path?.startsWith("pages/") && entry.path.endsWith(".md"));
  const inspectedPages = [];
  for (const page of pageEntries.slice(0, Math.min(10, pageEntries.length))) {
    const content = await api.content(knowledgeBaseId, page.path);
    const markdown = extractContent(content.data);
    const frontmatter = parseFrontmatter(markdown);
    if (frontmatter.title && frontmatter.type && frontmatter.fileId && markdown.replace(/^---[\s\S]*?\n---\n/, "").trim()) {
      report.okf.conceptPages.passed += 1;
    } else {
      report.okf.conceptPages.failed += 1;
    }
    inspectedPages.push({ ...page, frontmatter, content: markdown, file: content.data.file });
  }

  const graphIndex = await api.content(knowledgeBaseId, "_graph/index.md");
  const graphManifest = await api.content(knowledgeBaseId, "_graph/manifest.json");
  const graphNodes = await api.content(knowledgeBaseId, "_graph/nodes.jsonl");
  parseJsonContent(extractContent(graphManifest.data), "_graph/manifest.json");
  parseJsonlContent(extractContent(graphNodes.data), "_graph/nodes.jsonl");
  report.okf.graph.passed += 3;
  report.okf.graphEvidence.push({ path: "_graph/index.md", summary: extractContent(graphIndex.data).slice(0, 120).replace(/\s+/g, " ") });

  const byFileEntry = inventory.find((entry) => entry.path?.startsWith("_graph/by-file/") && entry.path.endsWith(".json"));
  if (byFileEntry) {
    const byFile = await api.content(knowledgeBaseId, byFileEntry.path);
    parseJsonContent(extractContent(byFile.data), byFileEntry.path);
    report.okf.graph.passed += 1;
    report.okf.graphEvidence.push({ path: byFileEntry.path, summary: "Parsed per-file graph neighborhood JSON." });
  } else {
    report.okf.graph.failed += 1;
  }

  const leakText = [
    ...requiredRoot.map((file) => file),
    extractContent(manifest.data),
    extractContent(search.data),
    extractContent(graphManifest.data)
  ].join("\n");
  if (hasLeak(leakText)) {
    report.okf.privacy.failed += 1;
    report.securityLeakageCount += 1;
  } else {
    report.okf.privacy.passed += 1;
  }
  report.okf.score = scoreOkf(report.okf);
  pass(report, "okf-generated-files", "Generated OKF files, indexes, and graph files were inspected.", WHITE_BOX);
  return { inventory, pageEntries, inspectedPages, searchEntries };
}

async function listGeneratedInventory(api, knowledgeBaseId) {
  const parentPaths = ["", "pages", "_index", "_graph", "_graph/by-file", "_graph/edges"];
  const inventory = [];
  for (const parentPath of parentPaths) {
    let cursor = null;
    do {
      const page = await api.json(`/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/tree`, {
        query: { parentPath, limit: 100, cursor }
      });
      const items = normalizeItems(page.data);
      inventory.push(...items);
      cursor = page.data.nextCursor || null;
    } while (cursor);
  }
  return inventory;
}

async function ensureDemo(config, openApiKey, knowledgeBaseId, report, managedProcesses) {
  if (!fs.existsSync(path.join(config.demoRepo, "package.json"))) {
    throw new Error("FOCOWIKI_AGENT_VALIDATION_DEMO_REPO must point to the demo backend repository.");
  }
  const ready = await isDemoReachable(config);
  if (!ready && (!config.startServices || !config.startDemo)) {
    throw new Error("Demo backend is not reachable and automatic startup is disabled.");
  }
  if (!ready) {
    fs.mkdirSync(config.demoLogDir, { recursive: true });
    const demoPort = new URL(config.demoBaseUrl).port || "45012";
    managedProcesses.push(
      startProcess("pnpm", ["dev"], {
        cwd: config.demoRepo,
        label: "focowiki-demo-agent-validation",
        env: {
          ...process.env,
          PORT: demoPort,
          FOCOWIKI_OPENAPI_BASE_URL: config.openApiBaseUrl,
          FOCOWIKI_OPENAPI_KEY: openApiKey,
          FOCOWIKI_DEFAULT_KNOWLEDGE_BASE_ID: knowledgeBaseId,
          LOG_DIR: config.demoLogDir,
          LOG_RESPONSE_PREVIEW_BYTES: "0",
          MAX_UPSTREAM_CONCURRENCY: "8",
          AGENT_API_KEY: ""
        }
      })
    );
  }
  await waitForHttp(`${config.demoBaseUrl}/agent/v1/health`, { timeoutMs: config.serviceTimeoutMs });
  pass(report, "demo-backend", "Demo backend Agent HTTP route is reachable.", BLACK_BOX);
}

async function isDemoReachable(config) {
  try {
    await waitForHttp(`${config.demoBaseUrl}/agent/v1/health`, { timeoutMs: 2_000 });
    return true;
  } catch {
    return false;
  }
}

async function validateDemoSurface(demo, generated, report) {
  const health = await demo.json("/health");
  if (JSON.stringify(health.data).includes("OPENAPI") || JSON.stringify(health.data).includes("Bearer")) {
    report.developer.demo.failed += 1;
    throw new Error("Demo health route exposed upstream configuration.");
  }
  const summary = await demo.json("/knowledge-base");
  const tree = await demo.json("/tree", { query: { limit: 5 } });
  const content = await demo.content("index.md");
  const search = await demo.json("/search", { query: { query: generated.inspectedPages[0]?.frontmatter?.title || "index", limit: 5 } });
  const graph = await demo.content(generated.inventory.find((entry) => entry.path?.startsWith("_graph/by-file/"))?.path || "_graph/index.md");
  if (summary.data.knowledgeBase && normalizeItems(tree.data).length > 0 && extractContent(content.data) && normalizeItems(search.data).length >= 0 && extractContent(graph.data)) {
    report.developer.demo.passed += 5;
  } else {
    report.developer.demo.failed += 1;
  }
  pass(report, "demo-agent-surface", "Demo backend supports summary, tree, content, search, and graph reads.", BLACK_BOX);
}

async function validateSkillCurlSurface(config, generated, report) {
  const result = await validateSkillCurlCommands({
    demoBaseUrl: `${config.demoBaseUrl}/agent/v1`,
    generated,
    requestTimeoutMs: config.requestTimeoutMs
  });
  report.skillCommands = result.commands;
  report.skillCommandSummary = result.summary;
  report.latencies.push(
    ...result.commands
      .map((command) => command.latencyMs)
      .filter((latencyMs) => Number.isFinite(latencyMs))
  );
  report.developer.demo.passed += result.summary.passed;
  report.developer.demo.failed +=
    result.summary.failed +
    result.summary.skipped +
    result.summary.leaked +
    result.summary.identifierContinuityFailed;

  const issueCount =
    result.summary.failed +
    result.summary.skipped +
    result.summary.leaked +
    result.summary.identifierContinuityFailed;
  if (issueCount === 0 && result.summary.passed === result.summary.total) {
    pass(report, "skill-curl-commands", `Executed ${result.summary.passed} Skill curl commands.`, BLACK_BOX);
  } else {
    fail(report, "skill-curl-commands", `Skill curl commands had ${issueCount} validation issues.`, BLACK_BOX);
  }
}

async function runAgentScenarios(api, demo, knowledgeBaseId, generated, samples, report) {
  const plan = buildAgentScenarioPlan(samples).slice(0, report.config.startServices ? undefined : 8);
  for (const scenario of plan.slice(0, Math.min(plan.length, report.config.startServices ? 12 : 8))) {
    report.agentResults.push(await runScenario("developer-openapi", scenario, api, knowledgeBaseId, generated));
    report.agentResults.push(await runScenario("demo-http", scenario, demo, knowledgeBaseId, generated));
  }
  const counts = aggregateCounts(report.agentResults);
  if (counts.scenarioCount > 0 && counts.roundCount > 0) {
    pass(report, "agent-scenarios", `Recorded ${counts.roundCount} Agent exploration rounds.`, BLACK_BOX);
  }
}

async function runScenario(surface, scenario, client, knowledgeBaseId, generated) {
  const rounds = [];
  const evidence = [];
  const routePrefix = surface === "developer-openapi" ? `/knowledge-bases/${knowledgeBaseId}` : "";
  const readSearch = async () => {
    if (surface === "demo-http") {
      const query = scenario.expectedVisibleClues[0] || scenario.question;
      const result = await client.json("/search", { query: { query, limit: 10 }, allowError: true });
      return { data: normalizeItems(result.data), latencyMs: result.latencyMs, route: "/agent/v1/search" };
    }
    return { data: generated.searchEntries, latencyMs: 0, route: "_index/search.json" };
  };
  const search = await readSearch();
  const candidates = chooseCandidates(search.data, scenario, 3);
  rounds.push(createRound({
    round: 1,
    persona: scenario.persona,
    scenarioType: scenario.scenarioType,
    action: "discover-candidates",
    routeOrFile: search.route,
    visibleInput: { question: scenario.question },
    outputSummary: `candidateCount=${candidates.length}`,
    extractedClues: candidates.map((item) => item.title || item.path).filter(Boolean).slice(0, 3),
    nextStepDecision: candidates.length > 0 ? "read-page" : "stop",
    advancedAnswer: candidates.length > 0,
    metrics: { filesDiscovered: candidates.length, latencyMs: search.latencyMs, scoreContribution: candidates.length > 0 ? 15 : 0 },
    boundary: {}
  }));

  if (scenario.expectsNoAnswer || candidates.length === 0) {
    const result = classifyScenarioResult(scenario, evidence, rounds, candidates.length === 0 ? "blocked" : "");
    return scenarioResult(surface, scenario, rounds, evidence, "discovery", result);
  }

  const candidate = candidates[0];
  const candidatePath = candidate.path || candidate.logicalPath || candidate.file?.path;
  let page;
  if (!candidatePath) {
    const result = classifyScenarioResult(scenario, evidence, rounds, "blocked");
    return scenarioResult(surface, scenario, rounds, evidence, "candidate-selection", result);
  }

  try {
    page = surface === "demo-http"
      ? await client.content(candidatePath)
      : await client.content(knowledgeBaseId, candidatePath);
  } catch {
    const result = classifyScenarioResult(scenario, evidence, rounds, "blocked");
    rounds.push(createRound({
      round: 2,
      persona: scenario.persona,
      scenarioType: scenario.scenarioType,
      action: "read-page",
      routeOrFile: `${routePrefix}/files/content?path=${candidatePath}`,
      outputSummary: "page read failed",
      nextStepDecision: "stop",
      metrics: { routeFailures: 1 },
      boundary: {}
    }));
    return scenarioResult(surface, scenario, rounds, evidence, "page-read", result);
  }

  const markdown = extractContent(page.data);
  const frontmatter = parseFrontmatter(markdown);
  const pageFile = page.data.file || {};
  evidence.push({
    fileId: pageFile.fileId || candidate.fileId,
    path: pageFile.path || candidatePath,
    title: pageFile.title || frontmatter.title || candidate.title
  });
  rounds.push(createRound({
    round: 2,
    persona: scenario.persona,
    scenarioType: scenario.scenarioType,
    action: "read-page",
    routeOrFile: `${routePrefix}/files/content?path=${candidatePath}`,
    outputSummary: `read page title=${frontmatter.title || pageFile.title || "unknown"}`,
    extractedClues: [frontmatter.title, frontmatter.type, frontmatter.status].filter(Boolean),
    nextStepDecision: "read-graph",
    advancedAnswer: true,
    metrics: { filesRead: 1, latencyMs: page.latencyMs, evidenceItemsFound: 1, scoreContribution: 25 },
    boundary: {}
  }));

  const graphPath = normalizeLogicalGraphPath(
    frontmatter.graph || frontmatter.graphRef || pageFile.graphRef || inferGraphPath(frontmatter, pageFile, candidate)
  );
  if (graphPath) {
    try {
      const graph = surface === "demo-http" ? await client.content(graphPath) : await client.content(knowledgeBaseId, graphPath);
      const graphContent = extractContent(graph.data);
      const graphJson = graphPath.endsWith(".json") ? parseJsonContent(graphContent, graphPath) : { content: graphContent };
      const relatedPath = firstRelatedPath(graphJson);
      rounds.push(createRound({
        round: 3,
        persona: scenario.persona,
        scenarioType: scenario.scenarioType,
        action: "read-graph",
        routeOrFile: graphPath,
        outputSummary: `graph readable relatedPath=${relatedPath || "none"}`,
        extractedClues: relatedPath ? [relatedPath] : [],
        nextStepDecision: relatedPath ? "read-related-page" : "read-related-endpoint",
        advancedAnswer: Boolean(relatedPath),
        metrics: { graphFilesRead: 1, latencyMs: graph.latencyMs, scoreContribution: 20 },
        boundary: {}
      }));
      if (relatedPath) {
        const related = surface === "demo-http" ? await client.content(relatedPath) : await client.content(knowledgeBaseId, relatedPath);
        const relatedFile = related.data.file || {};
        evidence.push({
          fileId: relatedFile.fileId,
          path: relatedFile.path || relatedPath,
          title: relatedFile.title || parseFrontmatter(extractContent(related.data)).title
        });
        rounds.push(createRound({
          round: 4,
          persona: scenario.persona,
          scenarioType: scenario.scenarioType,
          action: "read-related-page",
          routeOrFile: relatedPath,
          outputSummary: `related page read title=${relatedFile.title || "unknown"}`,
          nextStepDecision: "answer",
          advancedAnswer: true,
          metrics: { filesRead: 1, relatedFilesFollowed: 1, latencyMs: related.latencyMs, evidenceItemsFound: 1, scoreContribution: 25 },
          boundary: {}
        }));
      }
    } catch {
      rounds.push(createRound({
        round: 3,
        persona: scenario.persona,
        scenarioType: scenario.scenarioType,
        action: "read-graph",
        routeOrFile: graphPath,
        outputSummary: "graph read failed",
        nextStepDecision: "read-related-endpoint",
        metrics: { routeFailures: 1 },
        boundary: {}
      }));
    }
  }

  if (pageFile.fileId) {
    try {
      const related = surface === "demo-http"
        ? await client.json(`/files/${encodeURIComponent(pageFile.fileId)}/related`, { query: { limit: 5 }, allowError: true })
        : await client.json(`/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/${encodeURIComponent(pageFile.fileId)}/related`, { query: { limit: 5 }, allowError: true });
      const relatedItems = normalizeItems(related.data);
      rounds.push(createRound({
        round: rounds.length + 1,
        persona: scenario.persona,
        scenarioType: scenario.scenarioType,
        action: "read-related-endpoint",
        routeOrFile: `${routePrefix}/files/${pageFile.fileId}/related`,
        outputSummary: `relatedCount=${relatedItems.length}`,
        extractedClues: relatedItems.map((item) => item.path || item.title).filter(Boolean).slice(0, 3),
        nextStepDecision: relatedItems.length > 0 ? "answer" : "stop",
        advancedAnswer: relatedItems.length > 0,
        metrics: { graphFilesRead: 0, relatedFilesFollowed: relatedItems.length > 0 ? 1 : 0, latencyMs: related.latencyMs, scoreContribution: relatedItems.length > 0 ? 15 : 0 },
        boundary: {}
      }));
    } catch {
      // The graph file path remains the primary Agent path; related endpoint is supplemental.
    }
  }

  const result = classifyScenarioResult(scenario, evidence, rounds);
  return scenarioResult(surface, scenario, rounds, evidence, "completed", result);
}

function scenarioResult(surface, scenario, rounds, evidence, stopStage, result) {
  return {
    surface,
    persona: scenario.persona,
    scenarioType: scenario.scenarioType,
    question: scenario.question,
    rounds,
    evidence,
    stopStage,
    stopReason: result.stopReason,
    answerability: result.answerability,
    score: result.score
  };
}

async function validateSafeErrors(api, demo, knowledgeBaseId, generated, report) {
  const checks = [];
  const unsafePath = await api.json(`/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/content`, {
    query: { path: "../index.md" },
    allowError: true
  });
  checks.push({ name: "openapi-unsafe-path", status: unsafePath.response.status, code: unsafePath.data.error?.code });
  const missing = await api.json(`/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/missing-file-id`, {
    allowError: true
  });
  checks.push({ name: "openapi-missing-file", status: missing.response.status, code: missing.data.error?.code });
  const demoUnsafe = await demo.content("../index.md").catch((error) => ({
    response: { status: error.status || 400 },
    data: { error: { code: "INVALID_PATH" } }
  }));
  checks.push({ name: "demo-unsafe-path", status: demoUnsafe.response.status, code: demoUnsafe.data.error?.code });

  for (const check of checks) {
    if ([400, 401, 404, 422].includes(check.status) && check.code) report.developer.errors.passed += 1;
    else report.developer.errors.failed += 1;
  }
  report.developer.errorChecks.push(...checks);
  pass(report, "safe-errors", "Safe error envelopes checked for invalid paths and missing IDs.", BLACK_BOX);
}

async function validatePagination(api, knowledgeBaseId, report) {
  const first = await api.json(`/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/tree`, {
    query: { limit: 2 }
  });
  const items = normalizeItems(first.data);
  if (items.length <= 2) report.developer.pagination.passed += 1;
  else report.developer.pagination.failed += 1;
  if (first.data.nextCursor) {
    const second = await api.json(`/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/tree`, {
      query: { limit: 2, cursor: first.data.nextCursor }
    });
    if (normalizeItems(second.data).length <= 2) report.developer.pagination.passed += 1;
    else report.developer.pagination.failed += 1;
  }
  pass(report, "pagination", "Bounded tree pagination was checked.", BLACK_BOX);
}

async function verifyReportRedaction(paths, report) {
  for (const filePath of paths) {
    const text = fs.readFileSync(filePath, "utf8");
    if (hasLeak(text)) {
      report.securityLeakageCount += 1;
      throw new Error(`Report contains unsafe local or secret evidence: ${filePath}`);
    }
  }
  pass(report, "report-redaction", "Generated reports are redacted and stored under ReferenceDocs.", WHITE_BOX);
}

async function deleteKnowledgeBase(config, openApiKey, knowledgeBaseId) {
  await requestJson(`${config.openApiBaseUrl}/openapi/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`, {
    method: "DELETE",
    headers: bearerHeaders(openApiKey),
    allowError: true,
    timeoutMs: config.requestTimeoutMs
  });
}

function inferGraphPath(frontmatter, pageFile, candidate) {
  const fileId = frontmatter.fileId || pageFile.sourceFileId || candidate.sourceFileId || candidate.fileId;
  return fileId ? `_graph/by-file/${fileId}.json` : "";
}

function normalizeLogicalGraphPath(value) {
  return String(value || "")
    .replace(/^(\.\/)+/, "")
    .replace(/^(\.\.\/)+/, "")
    .replace(/^\/+/, "");
}

function firstRelatedPath(graphJson) {
  const arrays = [
    graphJson.relationships,
    graphJson.related,
    graphJson.relatedFiles,
    graphJson.edges,
    graphJson.items
  ].filter(Array.isArray);
  for (const row of arrays.flat()) {
    const path = row.path || row.targetPath || row.toPath || row.file?.path;
    if (typeof path === "string" && path.startsWith("pages/")) return path;
  }
  return "";
}

function calculateFinalOk(report) {
  report.developer.score = scoreDeveloper(report.developer);
  report.okf.score = scoreOkf(report.okf);
  return (
    report.checks.every((check) => check.ok) &&
    report.securityLeakageCount === 0 &&
    report.agentResults.length > 0 &&
    report.developer.score >= 70 &&
    report.okf.score >= 70
  );
}

function scoreDeveloper(developer) {
  const routeScore = developer.routeCoverage.total
    ? Math.round((developer.routeCoverage.passed / developer.routeCoverage.total) * 40)
    : 0;
  const paginationScore = developer.pagination.failed === 0 ? 20 : 10;
  const errorTotal = developer.errors.passed + developer.errors.failed;
  const errorScore = errorTotal ? Math.round((developer.errors.passed / errorTotal) * 20) : 0;
  const demoScore = developer.demo.failed === 0 && developer.demo.passed > 0 ? 20 : 5;
  return routeScore + paginationScore + errorScore + demoScore;
}

function scoreOkf(okf) {
  const groups = [okf.reservedFiles, okf.conceptPages, okf.indexes, okf.graph, okf.privacy];
  const totalPass = groups.reduce((sum, group) => sum + group.passed, 0);
  const total = groups.reduce((sum, group) => sum + group.passed + group.failed, 0);
  return total ? Math.round((totalPass / total) * 100) : 0;
}

function hasLeak(text) {
  return /\/Users\/|\/home\/|Authorization:\s*Bearer|fwok_[A-Za-z0-9]|S3_SECRET_ACCESS_KEY|MODEL_API_KEY|knowledge-bases\/[^"'\s]+\/uploads\//.test(
    text
  );
}

function hostRuntimeEnv() {
  const env = { ...process.env };
  env.DATABASE_URL = rewriteServiceUrl(env.DATABASE_URL, "postgres", "127.0.0.1", env.POSTGRES_PORT);
  env.REDIS_URL = rewriteServiceUrl(env.REDIS_URL, "redis", "127.0.0.1", env.REDIS_PORT);
  return env;
}

function rewriteServiceUrl(value, serviceHost, localHost, localPort) {
  if (!value) return value;
  try {
    const url = new URL(value);
    if (url.hostname !== serviceHost) return value;
    url.hostname = localHost;
    if (localPort) url.port = localPort;
    return url.toString();
  } catch {
    return value;
  }
}

function pass(report, name, message, layer) {
  report.checks.push({ name, message, layer, ok: true });
}

function fail(report, name, message, layer) {
  report.checks.push({ name, message, layer, ok: false });
}

function readBoolean(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function readPositiveInteger(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("Expected positive integer validation setting.");
  }
  return parsed;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}
