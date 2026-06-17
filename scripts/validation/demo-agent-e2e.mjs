import fs from "node:fs";
import path from "node:path";
import {
  selectSamplesFromEnvironment
} from "./lib/sample-selector.mjs";
import {
  bearerHeaders,
  appendQuery,
  jsonHeaders,
  markdownFormData,
  requestJson,
  sleep,
  waitForHttp
} from "./lib/demo-agent-e2e-http.mjs";
import {
  loadLocalEnv,
  readDemoAgentE2eConfig,
  safeConfigSummary,
  validateDemoRepository
} from "./lib/demo-agent-e2e-config.mjs";
import {
  runCommand,
  startProcess,
  stopManagedProcesses
} from "./lib/demo-agent-e2e-process.mjs";
import {
  createDemoAgentReport,
  okCheck,
  writeDemoAgentReport
} from "./lib/demo-agent-e2e-report.mjs";
import { redactPotentialPathText } from "./lib/redaction.mjs";

const WHITE_BOX = "white-box";
const BLACK_BOX = "black-box";
const SECURITY = "security";

await main(process.argv.slice(2));

async function main(argv) {
  loadLocalEnv();
  const command = argv[0] || "samples";
  const config = readDemoAgentE2eConfig();
  validateDemoRepository(config);
  const sampleSelection = selectSamplesFromEnvironment();
  const samples = sampleSelection.samples;
  const report = createDemoAgentReport(config, samples, safeConfigSummary(config));

  try {
    if (command === "samples") {
      report.checks.push(
        okCheck("sample-selection", `Selected ${samples.length} cleaned Markdown fixtures.`, {}, WHITE_BOX)
      );
      report.finishedAt = new Date().toISOString();
      report.ok = true;
      writeDemoAgentReport(config, report);
      return;
    }

    if (command !== "e2e") {
      throw new Error(`Unknown demo Agent E2E command: ${command}`);
    }

    await runE2e(config, samples, report);
  } catch (error) {
    report.finishedAt = new Date().toISOString();
    report.ok = false;
    report.failures.push(redactPotentialPathText(error instanceof Error ? error.message : String(error)));
    writeDemoAgentReport(config, report);
    throw error;
  }
}

async function runE2e(config, samples, report) {
  const managedProcesses = [];
  let knowledgeBaseId = null;
  let openApiKey = config.openApiKey;

  try {
    await ensureFocowikiServices(config, report, managedProcesses);
    if (!openApiKey) {
      openApiKey = await createOpenApiKey(config, report);
    }

    await validateDeveloperOpenApiHealth(config, openApiKey, report);
    const knowledgeBase = await createKnowledgeBase(config, openApiKey, report);
    knowledgeBaseId = knowledgeBase.knowledgeBaseId;

    const upload = await uploadSamples(config, openApiKey, knowledgeBaseId, samples, report);
    const taskDetail = await pollTaskEnded(config, openApiKey, knowledgeBaseId, upload.taskId, report);
    const bundle = await validateGeneratedBundle(config, openApiKey, knowledgeBaseId, samples, report);
    await ensureDemoBackend(config, openApiKey, knowledgeBaseId, report, managedProcesses);
    const demo = await validateDemoAgentRoutes(config, bundle, report);
    await validateDemoDeveloperRoutes(config, report);
    await validateDemoLogs(config, report);

    report.validationRun = {
      knowledgeBaseId,
      taskId: upload.taskId,
      uploadedFileCount: upload.files.length,
      taskFileCount: taskDetail.files.items.length,
      rootEntryCount: bundle.rootEntries.length,
      pageFilePath: bundle.pageFile.path,
      pageFileId: bundle.pageFile.fileId,
      demoSearchResultCount: demo.searchResultCount
    };
    report.finishedAt = new Date().toISOString();
    report.ok = report.checks.every((check) => check.ok);
    writeDemoAgentReport(config, report);

    if (!report.ok) {
      throw new Error("Demo Agent E2E validation failed. See redacted report.");
    }
  } finally {
    if (knowledgeBaseId && config.cleanupKnowledgeBase && openApiKey) {
      await cleanupKnowledgeBase(config, openApiKey, knowledgeBaseId, report).catch((error) => {
        report.failures.push(redactPotentialPathText(error instanceof Error ? error.message : String(error)));
      });
    }
    await stopManagedProcesses(managedProcesses);
    writeDemoAgentReport(config, report);
  }
}

async function ensureFocowikiServices(config, report, managedProcesses) {
  const ready = await areFocowikiServicesReachable(config);
  if (!ready && !config.startFocowiki) {
    throw new Error("Focowiki local services are not reachable and automatic startup is disabled.");
  }

  if (!ready) {
    startFocowikiServices(report, managedProcesses);
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

  report.checks.push(
    okCheck(
      "focowiki-services",
      "Focowiki Admin API, Admin UI, and Developer OpenAPI are reachable.",
      {
        adminApiBaseUrl: config.adminApiBaseUrl,
        adminUiBaseUrl: config.adminUiBaseUrl,
        openApiBaseUrl: config.openApiBaseUrl
      },
      BLACK_BOX
    )
  );
}

function startFocowikiServices(report, managedProcesses) {
  if (fs.existsSync(path.resolve("docker-compose.local.yml"))) {
    runCommand("pnpm", ["compose:local:up"], { cwd: process.cwd(), stdio: "inherit" });
    report.commandsRun.push("pnpm compose:local:up");
    runCommand("pnpm", ["--filter", "@focowiki/api", "db:migrate"], {
      cwd: process.cwd(),
      env: hostRuntimeEnv(),
      stdio: "inherit"
    });
    report.commandsRun.push("pnpm --filter @focowiki/api db:migrate");
    managedProcesses.push(
      startProcess("pnpm", ["dev"], {
        cwd: process.cwd(),
        env: hostRuntimeEnv(),
        label: "focowiki-dev"
      })
    );
    report.commandsRun.push("pnpm dev");
    return;
  }

  if (fs.existsSync(path.resolve("docker-compose.dev.yml"))) {
    runCommand("pnpm", ["compose:dev:up"], { cwd: process.cwd(), stdio: "inherit" });
    report.commandsRun.push("pnpm compose:dev:up");
    if (!composeFileHasService("docker-compose.dev.yml", "api")) {
      runCommand("pnpm", ["--filter", "@focowiki/api", "db:migrate"], {
        cwd: process.cwd(),
        env: hostRuntimeEnv(),
        stdio: "inherit"
      });
      report.commandsRun.push("pnpm --filter @focowiki/api db:migrate");
      managedProcesses.push(
        startProcess("pnpm", ["dev"], {
          cwd: process.cwd(),
          env: hostRuntimeEnv(),
          label: "focowiki-dev"
        })
      );
      report.commandsRun.push("pnpm dev");
    }
    return;
  }

  throw new Error(
    "Focowiki services are not running and no local Docker Compose file is available. Create a local compose file from the committed template or start services manually."
  );
}

function composeFileHasService(fileName, serviceName) {
  const text = fs.readFileSync(path.resolve(fileName), "utf8");
  return new RegExp(`\\n\\s{2}${serviceName}:\\s*\\n`).test(`\n${text}`);
}

function hostRuntimeEnv() {
  const env = { ...process.env };
  env.DATABASE_URL = rewriteServiceUrl(env.DATABASE_URL, {
    serviceHost: "postgres",
    localHost: "127.0.0.1",
    localPort: env.POSTGRES_PORT
  });
  env.REDIS_URL = rewriteServiceUrl(env.REDIS_URL, {
    serviceHost: "redis",
    localHost: "127.0.0.1",
    localPort: env.REDIS_PORT
  });
  return env;
}

function rewriteServiceUrl(value, options) {
  if (!value) return value;
  try {
    const url = new URL(value);
    if (url.hostname !== options.serviceHost) {
      return value;
    }
    url.hostname = options.localHost;
    if (options.localPort) {
      url.port = options.localPort;
    }
    return url.toString();
  } catch {
    return value;
  }
}

async function areFocowikiServicesReachable(config) {
  try {
    await waitForHttp(`${config.adminApiBaseUrl}/admin/api/session`, {
      timeoutMs: 2_000,
      acceptStatus: (status) => status === 200 || status === 401
    });
    await waitForHttp(`${config.openApiBaseUrl}/openapi/v1/health`, {
      timeoutMs: 2_000,
      acceptStatus: (status) => status === 200 || status === 401
    });
    await waitForHttp(config.adminUiBaseUrl, {
      timeoutMs: 2_000,
      acceptStatus: (status) => status >= 200 && status < 500
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
    body: JSON.stringify({
      username: config.adminUsername,
      password: config.adminPassword
    }),
    timeoutMs: config.requestTimeoutMs
  });
  const cookie = login.response.headers.get("set-cookie");
  if (!cookie) {
    throw new Error("Admin login did not return a session cookie.");
  }

  const created = await requestJson(`${config.adminApiBaseUrl}/admin/api/openapi-keys`, {
    method: "POST",
    headers: jsonHeaders({
      origin: config.adminOrigin,
      cookie
    }),
    body: JSON.stringify({ name: `Demo Agent E2E ${new Date().toISOString()}` }),
    timeoutMs: config.requestTimeoutMs
  });
  const rawKey = created.data?.oneTimeKey?.rawKey;
  if (!rawKey || typeof rawKey !== "string") {
    throw new Error("Admin API did not return a one-time OpenAPI key.");
  }

  report.checks.push(okCheck("openapi-key", "Created a one-time Developer OpenAPI key for this run.", {}, SECURITY));
  return rawKey;
}

async function validateDeveloperOpenApiHealth(config, openApiKey, report) {
  const unauthenticated = await requestJson(`${config.openApiBaseUrl}/openapi/v1/health`, {
    allowError: true,
    timeoutMs: config.requestTimeoutMs
  });
  if (unauthenticated.response.status !== 401) {
    throw new Error(`Expected Developer OpenAPI health without key to return 401, got ${unauthenticated.response.status}.`);
  }

  const health = await openApiJson(config, openApiKey, "/health");
  if (health.status !== "ok") {
    throw new Error("Developer OpenAPI health did not return ok.");
  }

  report.checks.push(
    okCheck("developer-openapi-health", "Developer OpenAPI health requires auth and returns safe status.", {}, SECURITY)
  );
}

async function createKnowledgeBase(config, openApiKey, report) {
  const data = await openApiJson(config, openApiKey, "/knowledge-bases", {
    method: "POST",
    body: {
      name: `Demo Agent E2E ${new Date().toISOString()}`,
      description: "Local demo Agent end-to-end validation knowledge base."
    },
    status: 201
  });
  if (!data.knowledgeBaseId) {
    data.knowledgeBaseId = data.knowledgeBase?.knowledgeBaseId;
  }
  if (!data.knowledgeBaseId) {
    throw new Error("Developer OpenAPI did not return knowledgeBase.knowledgeBaseId.");
  }

  report.checks.push(
    okCheck("knowledge-base-create", "Created a local test knowledge base through Developer OpenAPI.", {}, BLACK_BOX)
  );
  return data;
}

async function uploadSamples(config, openApiKey, knowledgeBaseId, samples, report) {
  const data = await openApiJson(config, openApiKey, `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/uploads`, {
    method: "POST",
    formData: markdownFormData(samples),
    status: 202
  });

  if (!data.taskId || !Array.isArray(data.files) || data.files.length !== samples.length) {
    throw new Error("Developer OpenAPI upload response did not preserve taskId and accepted file list.");
  }

  const invalid = data.files.filter((file) => !file.fileId || !file.originalFilename);
  if (invalid.length > 0) {
    throw new Error("Developer OpenAPI upload response contains files without reusable identifiers.");
  }

  report.checks.push(
    okCheck(
      "markdown-upload",
      "Uploaded the bounded cleaned Markdown sample through Developer OpenAPI.",
      { acceptedFileCount: data.files.length },
      BLACK_BOX
    )
  );
  return data;
}

async function pollTaskEnded(config, openApiKey, knowledgeBaseId, taskId, report) {
  const startedAt = Date.now();
  let lastDetail = null;

  while (Date.now() - startedAt < config.taskTimeoutMs) {
    lastDetail = await openApiJson(
      config,
      openApiKey,
      `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/tasks/${encodeURIComponent(taskId)}`,
      {
        query: { limit: config.maxRouteLimit }
      }
    );

    if (lastDetail.task?.lifecycle === "ended") {
      const files = lastDetail.files?.items;
      if (!Array.isArray(files) || files.length === 0) {
        throw new Error("Ended task did not expose file-level items.");
      }
      const missingIdentifiers = files.filter((file) => !file.fileId || !file.originalFilename);
      if (missingIdentifiers.length > 0) {
        throw new Error("Task file-level items do not preserve fileId and originalFilename.");
      }
      report.checks.push(
        okCheck(
          "task-ended",
          "Upload task reached ended state with file-level identifier continuity.",
          {
            fileCount: files.length,
            currentStage: lastDetail.task.progress?.currentStage || null
          },
          BLACK_BOX
        )
      );
      return lastDetail;
    }

    await sleep(config.taskPollIntervalMs);
  }

  throw new Error(`Timed out waiting for task ${taskId} to end.`);
}

async function validateGeneratedBundle(config, openApiKey, knowledgeBaseId, samples, report) {
  const root = await openApiJson(config, openApiKey, `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/tree`, {
    query: { limit: config.maxRouteLimit }
  });
  const rootEntries = assertItems(root, "root tree");
  const rootPaths = new Set(rootEntries.map((entry) => entry.path));

  for (const required of ["index.md", "log.md", "schema.md", "_index", "pages"]) {
    if (!rootPaths.has(required)) {
      throw new Error(`Generated root tree is missing ${required}.`);
    }
  }

  const pages = await openApiJson(config, openApiKey, `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/tree`, {
    query: { parentPath: "pages", limit: config.maxRouteLimit }
  });
  const pageFiles = assertItems(pages, "pages tree").filter((entry) => entry.fileId && entry.path?.endsWith(".md"));
  if (pageFiles.length < samples.length) {
    throw new Error(`Expected at least ${samples.length} generated page files, got ${pageFiles.length}.`);
  }

  const indexes = await openApiJson(config, openApiKey, `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/tree`, {
    query: { parentPath: "_index", limit: config.maxRouteLimit }
  });
  const indexPaths = new Set(assertItems(indexes, "index tree").map((entry) => entry.path));
  for (const required of ["_index/manifest.json", "_index/search.json", "_index/links.json"]) {
    if (!indexPaths.has(required)) {
      throw new Error(`Generated index tree is missing ${required}.`);
    }
  }

  const indexMarkdown = await readOpenApiContent(config, openApiKey, knowledgeBaseId, "index.md");
  const manifest = await readOpenApiContent(config, openApiKey, knowledgeBaseId, "_index/manifest.json");
  const search = await readOpenApiContent(config, openApiKey, knowledgeBaseId, "_index/search.json");
  await readOpenApiContent(config, openApiKey, knowledgeBaseId, "log.md");
  await readOpenApiContent(config, openApiKey, knowledgeBaseId, "schema.md");
  await expectOpenApiPathUnavailable(config, openApiKey, knowledgeBaseId, "sources/example.md");

  const manifestContent = parseContentJson(manifest.content, "_index/manifest.json");
  const searchContent = parseContentJson(search.content, "_index/search.json");
  if (!JSON.stringify(manifestContent).includes("metadata") || !JSON.stringify(searchContent).includes("metadata")) {
    throw new Error("Generated JSON indexes do not include metadata objects.");
  }
  if (containsInternalLeak([indexMarkdown.content, manifest.content, search.content])) {
    throw new Error("Generated bundle content exposes internal storage or local path data.");
  }

  report.checks.push(
    okCheck(
      "generated-okf-bundle",
      "Generated OKF bundle includes root files, pages, index JSON files, metadata, and no public source path.",
      {
        rootEntries: rootEntries.length,
        pageFiles: pageFiles.length,
        sampleCount: samples.length
      },
      BLACK_BOX
    )
  );

  return {
    rootEntries,
    pageFiles,
    pageFile: pageFiles[0],
    query: samples[0]?.title || pageFiles[0].name
  };
}

async function ensureDemoBackend(config, openApiKey, knowledgeBaseId, report, managedProcesses) {
  const ready = await isDemoReachable(config);
  if (!ready && !config.startDemo) {
    throw new Error("Demo backend is not reachable and automatic startup is disabled.");
  }

  if (!ready) {
    fs.mkdirSync(config.demoLogDir, { recursive: true });
    const demoPort = String(new URL(config.demoBaseUrl).port || "45010");
    const env = {
      ...process.env,
      PORT: demoPort,
      FOCOWIKI_OPENAPI_BASE_URL: config.openApiBaseUrl,
      FOCOWIKI_OPENAPI_KEY: openApiKey,
      FOCOWIKI_DEFAULT_KNOWLEDGE_BASE_ID: knowledgeBaseId,
      AGENT_API_KEY: config.agentApiKey,
      ENABLE_DEVELOPER_WRITE_ROUTES: String(config.enableDeveloperRouteChecks),
      LOG_DIR: config.demoLogDir,
      LOG_RESPONSE_PREVIEW_BYTES: "0"
    };
    managedProcesses.push(
      startProcess("pnpm", ["dev"], {
        cwd: config.demoRepo,
        env,
        label: "focowiki-demo"
      })
    );
    report.commandsRun.push("pnpm dev --dir <FOCOWIKI_DEMO_E2E_DEMO_REPO>");
  }

  await waitForHttp(`${config.demoBaseUrl}/agent/v1/health`, {
    timeoutMs: config.serviceTimeoutMs
  });
  report.checks.push(okCheck("demo-backend", "Demo backend Agent health route is reachable.", {}, BLACK_BOX));
}

async function isDemoReachable(config) {
  try {
    await waitForHttp(`${config.demoBaseUrl}/agent/v1/health`, { timeoutMs: 2_000 });
    return true;
  } catch {
    return false;
  }
}

async function validateDemoAgentRoutes(config, bundle, report) {
  const auth = bearerHeaders(config.agentApiKey);
  const health = await requestJson(`${config.demoBaseUrl}/agent/v1/health`, {
    timeoutMs: config.requestTimeoutMs
  });
  if (health.data.status !== "ok") {
    throw new Error("Demo Agent health route did not return ok.");
  }
  if (JSON.stringify(health.data).includes(config.openApiBaseUrl)) {
    throw new Error("Demo Agent health route exposes upstream configuration.");
  }

  const summary = await requestJson(`${config.demoBaseUrl}/agent/v1/knowledge-base`, {
    headers: auth,
    timeoutMs: config.requestTimeoutMs
  });
  if (!summary.data.knowledgeBase?.knowledgeBaseId) {
    throw new Error("Demo knowledge-base summary did not include knowledgeBaseId.");
  }

  const tree = await requestJson(appendQuery(`${config.demoBaseUrl}/agent/v1/tree`, { limit: 3 }), {
    headers: auth,
    timeoutMs: config.requestTimeoutMs
  });
  const treeItems = assertItems(tree.data, "demo tree");
  if (treeItems.length === 0) {
    throw new Error("Demo Agent tree returned no entries.");
  }

  const file = await requestJson(`${config.demoBaseUrl}/agent/v1/files/${encodeURIComponent(bundle.pageFile.fileId)}`, {
    headers: auth,
    timeoutMs: config.requestTimeoutMs
  });
  if (!file.data.file?.fileId) {
    throw new Error("Demo file metadata response did not include file.fileId.");
  }

  const byId = await requestJson(
    `${config.demoBaseUrl}/agent/v1/files/${encodeURIComponent(bundle.pageFile.fileId)}/content`,
    {
      headers: auth,
      timeoutMs: config.requestTimeoutMs
    }
  );
  const byPath = await requestJson(
    appendQuery(`${config.demoBaseUrl}/agent/v1/files/content`, { path: bundle.pageFile.path }),
    {
      headers: auth,
      timeoutMs: config.requestTimeoutMs
    }
  );
  if (!byId.data.content || !byPath.data.content) {
    throw new Error("Demo Agent content routes did not return content.");
  }

  const searchQuery = String(bundle.query || "").slice(0, 16);
  const search = await requestJson(appendQuery(`${config.demoBaseUrl}/agent/v1/search`, { query: searchQuery, limit: 5 }), {
    headers: auth,
    timeoutMs: config.requestTimeoutMs
  });
  const searchItems = assertItems(search.data, "demo search");

  const rejected = await requestJson(`${config.demoBaseUrl}/agent/v1/tree`, {
    allowError: true,
    timeoutMs: config.requestTimeoutMs
  });
  if (rejected.response.status !== 401) {
    throw new Error(`Expected demo Agent auth failure to return 401, got ${rejected.response.status}.`);
  }

  const traversal = await requestJson(
    appendQuery(`${config.demoBaseUrl}/agent/v1/files/content`, { path: "../index.md" }),
    {
      headers: auth,
      allowError: true,
      timeoutMs: config.requestTimeoutMs
    }
  );
  if (traversal.response.status !== 400) {
    throw new Error(`Expected demo Agent traversal rejection to return 400, got ${traversal.response.status}.`);
  }

  report.checks.push(
    okCheck(
      "demo-agent-routes",
      "Demo Agent routes returned health, summary, tree, metadata, content, search, auth rejection, and path rejection.",
      {
        treeItems: treeItems.length,
        searchItems: searchItems.length
      },
      BLACK_BOX
    )
  );

  return { searchResultCount: searchItems.length };
}

async function validateDemoDeveloperRoutes(config, report) {
  const response = await requestJson(`${config.demoBaseUrl}/developer/v1/knowledge-bases?limit=1`, {
    headers: bearerHeaders(config.agentApiKey),
    allowError: true,
    timeoutMs: config.requestTimeoutMs
  });

  if (config.enableDeveloperRouteChecks) {
    if (!response.response.ok) {
      throw new Error(`Expected enabled developer route to succeed, got ${response.response.status}.`);
    }
    report.checks.push(okCheck("demo-developer-routes", "Demo developer workflow routes are enabled for this run.", {}, BLACK_BOX));
    return;
  }

  if (response.response.status !== 403) {
    throw new Error(`Expected disabled developer route to return 403, got ${response.response.status}.`);
  }
  report.checks.push(
    okCheck("demo-developer-routes-disabled", "Demo developer workflow routes stay disabled by default.", {}, SECURITY)
  );
}

async function validateDemoLogs(config, report) {
  const logFile = path.join(config.demoLogDir, "focowiki-demo.jsonl");
  if (!fs.existsSync(logFile)) {
    throw new Error("Demo backend did not write the expected JSONL log file.");
  }

  const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);
  if (lines.length === 0) {
    throw new Error("Demo backend log file is empty.");
  }

  const entries = lines.map((line) => JSON.parse(line));
  const requiredKeys = [
    "loggedAt",
    "requestId",
    "callerIp",
    "clientFingerprint",
    "requestFingerprint",
    "responseFingerprint",
    "method",
    "path",
    "routeGroup",
    "statusCode",
    "latencyMs"
  ];
  for (const entry of entries) {
    const missing = requiredKeys.filter((key) => !(key in entry));
    if (missing.length > 0) {
      throw new Error(`Demo log entry is missing required fields: ${missing.join(", ")}`);
    }
  }

  const logText = lines.join("\n");
  for (const secret of [config.agentApiKey, config.openApiKey].filter(Boolean)) {
    if (secret && logText.includes(secret)) {
      throw new Error("Demo logs contain a raw API key.");
    }
  }
  if (containsInternalLeak([logText])) {
    throw new Error("Demo logs contain internal storage or local path data.");
  }

  report.checks.push(
    okCheck(
      "demo-logs",
      "Demo backend wrote structured JSONL logs with required fields and redaction.",
      { entries: entries.length },
      SECURITY
    )
  );
}

async function cleanupKnowledgeBase(config, openApiKey, knowledgeBaseId, report) {
  const response = await requestJson(
    `${config.openApiBaseUrl}/openapi/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`,
    {
      method: "DELETE",
      headers: bearerHeaders(openApiKey),
      allowError: true,
      timeoutMs: config.requestTimeoutMs
    }
  );
  if (![200, 202, 204, 404].includes(response.response.status)) {
    throw new Error(`Knowledge base cleanup failed with HTTP ${response.response.status}.`);
  }
  report.checks.push(okCheck("cleanup-knowledge-base", "Cleaned up the local test knowledge base.", {}, WHITE_BOX));
}

async function openApiJson(config, openApiKey, routePath, options = {}) {
  const url = appendQuery(`${config.openApiBaseUrl}/openapi/v1${routePath}`, options.query || {});
  const response = await requestJson(url, {
    method: options.method,
    headers: options.formData
      ? bearerHeaders(openApiKey)
      : bearerHeaders(openApiKey, options.body ? { "content-type": "application/json" } : {}),
    body: options.formData ?? (options.body ? JSON.stringify(options.body) : undefined),
    timeoutMs: config.requestTimeoutMs,
    allowError: options.allowError
  });

  if (options.status && response.response.status !== options.status) {
    throw new Error(`Expected ${routePath} to return ${options.status}, got ${response.response.status}.`);
  }

  return response.data;
}

async function readOpenApiContent(config, openApiKey, knowledgeBaseId, logicalPath) {
  return openApiJson(config, openApiKey, `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/content`, {
    query: { path: logicalPath }
  });
}

async function expectOpenApiPathUnavailable(config, openApiKey, knowledgeBaseId, logicalPath) {
  const result = await requestJson(
    appendQuery(`${config.openApiBaseUrl}/openapi/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/content`, {
      path: logicalPath
    }),
    {
      headers: bearerHeaders(openApiKey),
      allowError: true,
      timeoutMs: config.requestTimeoutMs
    }
  );
  if (![400, 404, 422].includes(result.response.status)) {
    throw new Error(`Expected ${logicalPath} to be unavailable, got HTTP ${result.response.status}.`);
  }
}

function assertItems(data, label) {
  if (!data || !Array.isArray(data.items)) {
    throw new Error(`${label} response did not include items.`);
  }
  return data.items;
}

function parseContentJson(content, label) {
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`${label} did not contain valid JSON content.`);
  }
}

function containsInternalLeak(values) {
  return values.some((value) =>
    /(?:^|["'\s])(?:sources\/|s3:\/\/|knowledge-bases\/[^/\s]+\/(?:uploads|releases)|\/Users\/|S3_SECRET|Authorization: Bearer)/i.test(
      String(value)
    )
  );
}
