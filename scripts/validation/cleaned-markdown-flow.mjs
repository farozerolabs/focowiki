import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnvFile } from "node:process";
import {
  SAMPLE_SOURCE_ENV,
  readSampleText,
  selectSamplesFromEnvironment
} from "./lib/sample-selector.mjs";

export { selectSamples, selectSamplesFromEnvironment } from "./lib/sample-selector.mjs";

const CHANGE_ID = "validate-cleaned-legal-full-flow";
const CHANGE_DIR = path.resolve("openspec/changes", CHANGE_ID);
const REPORT_JSON = path.join(CHANGE_DIR, "validation-report.json");
const REPORT_MD = path.join(CHANGE_DIR, "validation-report.md");
const TASK_TIMEOUT_ENV = "FOCOWIKI_VALIDATION_TASK_TIMEOUT_MS";
const WHITE_BOX = "white-box";
const BLACK_BOX = "black-box";
const requireFromApiPackage = createRequire(
  pathToFileURL(path.resolve("apps/api/package.json"))
);

export async function main(argv = process.argv.slice(2)) {
  loadLocalEnv();
  const command = argv[0] ?? "samples";

  if (command === "samples") {
    const report = await runSampleValidation();
    writeReport(report);
    writeJson(report);
    return report;
  }

  if (command === "api") {
    const report = await runApiValidation();
    writeReport(report);
    writeJson(report);
    return report;
  }

  throw new Error(`Unknown validation command: ${command}`);
}

export async function runSampleValidation() {
  const startedAt = new Date().toISOString();
  const sampleSelection = selectSamplesFromEnvironment();
  const report = createBaseReport("samples", startedAt);

  report.samples = sampleSelection.samples.map(redactSampleForReport);
  report.sampleCoverage = sampleSelection.coverage;
  report.checks.push(
    okCheck("sample-directory", "Sample source directory is configured and readable.", {}, WHITE_BOX)
  );
  report.checks.push(
    okCheck("sample-count", `Selected exactly ${sampleSelection.sampleCount} Markdown samples.`, {}, WHITE_BOX)
  );
  report.checks.push(
    okCheck(
      "sample-metadata",
      "Every selected sample has parseable frontmatter, type, title, and body.",
      {},
      WHITE_BOX
    )
  );
  report.checks.push(
    okCheck("sample-coverage", "Selected samples cover required statuses and types.", {}, WHITE_BOX)
  );
  report.finishedAt = new Date().toISOString();
  report.ok = report.checks.every((check) => check.ok);

  return report;
}

export async function runApiValidation() {
  const startedAt = new Date().toISOString();
  const report = createBaseReport("api", startedAt);
  try {
    const sampleSelection = selectSamplesFromEnvironment();
    const env = readRuntimeEnv();

    report.samples = sampleSelection.samples.map(redactSampleForReport);
    report.sampleCoverage = sampleSelection.coverage;

    const adminBaseUrl = env.ADMIN_API_BASE_URL ?? `http://127.0.0.1:${env.ADMIN_API_PORT ?? "43000"}`;
    const publicBaseUrl = env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${env.PUBLIC_OPENAPI_PORT ?? "43200"}`;

    assertEnvValue(env.ADMIN_USERNAME, "ADMIN_USERNAME");
    assertEnvValue(env.ADMIN_PASSWORD, "ADMIN_PASSWORD");
    assertEnvValue(env.DATABASE_URL, "DATABASE_URL");
    assertEnvValue(env.REDIS_URL, "REDIS_URL");
    assertEnvValue(env.S3_ENDPOINT, "S3_ENDPOINT");
    assertEnvValue(env.S3_REGION, "S3_REGION");
    assertEnvValue(env.S3_BUCKET, "S3_BUCKET");
    assertEnvValue(env.S3_ACCESS_KEY_ID, "S3_ACCESS_KEY_ID");
    assertEnvValue(env.S3_SECRET_ACCESS_KEY, "S3_SECRET_ACCESS_KEY");
    assertEnvValue(env.S3_PREFIX, "S3_PREFIX");
    assertUploadLimit(env.MAX_UPLOAD_FILES, sampleSelection.samples.length);

    const admin = createHttpClient(adminBaseUrl);
    const publicApi = createHttpClient(publicBaseUrl);

    await validateDatabaseConnectivity(env.DATABASE_URL, report);
    await validateRedisConnectivity(env.REDIS_URL, report);
    await validateS3Connectivity(env, report);
    await expectUnauthorizedAdmin(admin, report);
    await validatePublicApiReachable(publicApi, env, report);

    await loginAdmin(admin, env, report);
    const knowledgeBase = await createValidationKnowledgeBase(admin, report);
    const uploadTask = await uploadSamples(admin, knowledgeBase.id, sampleSelection.samples, report);
    const taskTimeoutMs = readValidationTaskTimeoutMs(env, sampleSelection.samples.length);
    const completedTask = await pollTaskEnded(
      admin,
      knowledgeBase.id,
      uploadTask.id,
      taskTimeoutMs,
      report
    );
    const taskDetail = await fetchTaskDetail(admin, knowledgeBase.id, completedTask.id, report);
    await validateSingleUploadTaskRow(admin, knowledgeBase.id, completedTask.id, report);
    const adminFiles = await validateAdminFileSurfaces(admin, knowledgeBase.id, report);
    await validatePublicOpenApi(publicApi, knowledgeBase.id, adminFiles, env, report);
    const storageEvidence = await validateDatabaseBoundaries(
      env.DATABASE_URL,
      knowledgeBase.id,
      completedTask.id,
      sampleSelection.samples,
      report
    );
    await validateS3ObjectBoundaries(env, storageEvidence, sampleSelection.samples, report);
    await validateRedisBoundaries(env.REDIS_URL, sampleSelection.samples, report);
    const deletionEvidence = await validateSourceDeletionFullFlow({
      admin,
      publicApi,
      env,
      knowledgeBaseId: knowledgeBase.id,
      pageFile: adminFiles.pageFile,
      taskTimeoutMs,
      report
    });
    await validateKnowledgeBaseDeletion({
      admin,
      publicApi,
      env,
      knowledgeBaseId: knowledgeBase.id,
      report
    });

    report.validationRun = {
      knowledgeBaseId: knowledgeBase.id,
      taskId: completedTask.id,
      deletionTaskId: deletionEvidence.taskId,
      deletedPagePath: deletionEvidence.deletedPagePath,
      sourceCount: completedTask.sourceCount,
      phaseCount: taskDetail.phaseDetails.items.length,
      publicBaseUrl: redactUrl(publicBaseUrl),
      adminBaseUrl: redactUrl(adminBaseUrl)
    };
    report.finishedAt = new Date().toISOString();
    report.ok = report.checks.every((check) => check.ok);
    writeReport(report);
    writeJson(report);

    if (!report.ok) {
      throw new Error("Cleaned Markdown API validation failed. See redacted validation report.");
    }

    return report;
  } catch (error) {
    report.finishedAt = new Date().toISOString();
    report.ok = false;
    report.failures.push(redactPotentialPathText(error instanceof Error ? error.message : String(error)));
    writeReport(report);
    writeJson(report);
    throw error;
  }
}

function createBaseReport(kind, startedAt) {
  return {
    kind,
    change: CHANGE_ID,
    startedAt,
    finishedAt: null,
    ok: false,
    source: {
      env: SAMPLE_SOURCE_ENV,
      redactedRoot: `<${SAMPLE_SOURCE_ENV}>`
    },
    samples: [],
    sampleCoverage: null,
    validationRun: null,
    checks: [],
    failures: []
  };
}

function redactSampleForReport(sample) {
  return {
    basename: sample.basename,
    title: sample.title,
    type: sample.type,
    status: sample.status,
    category: sample.category,
    publicationDate: sample.publicationDate || "unknown-date",
    sizeBytes: sample.sizeBytes
  };
}

function okCheck(name, message, details = {}, layer = BLACK_BOX) {
  return {
    layer,
    name,
    ok: true,
    message,
    details
  };
}

function failCheck(name, message, details = {}, layer = BLACK_BOX) {
  return {
    layer,
    name,
    ok: false,
    message,
    details
  };
}

function writeReport(report) {
  fs.mkdirSync(CHANGE_DIR, { recursive: true });
  const whiteBoxChecks = report.checks.filter((check) => check.layer === WHITE_BOX);
  const blackBoxChecks = report.checks.filter((check) => check.layer === BLACK_BOX);
  const lines = [
    "# Cleaned Legal Upload Validation Report",
    "",
    `- Change: ${report.change}`,
    `- Kind: ${report.kind}`,
    `- Started at: ${report.startedAt}`,
    `- Finished at: ${report.finishedAt ?? "not-finished"}`,
    `- Source: <${SAMPLE_SOURCE_ENV}>`,
    `- Result: ${report.ok ? "pass" : "fail"}`,
    "",
    "## Sample Coverage",
    "",
    `- Samples: ${report.samples.length}`,
    `- Statuses: ${report.sampleCoverage?.statuses.join(", ") ?? "none"}`,
    `- Types: ${report.sampleCoverage?.types.join(", ") ?? "none"}`,
    `- Unknown date sample: ${report.sampleCoverage?.includesUnknownDate ? "yes" : "no"}`,
    `- Long title sample: ${report.sampleCoverage?.includesLongTitle ? "yes" : "no"}`,
    `- Duplicated title sample: ${report.sampleCoverage?.includesDuplicatedTitle ? "yes" : "no"}`,
    "",
    "## Selected Files",
    "",
    ...report.samples.map(
      (sample) =>
        `- ${sample.basename}: type=${sample.type || "none"}, status=${sample.status || "none"}, date=${sample.publicationDate}`
    ),
    "",
    "## Checks",
    "",
    ...report.checks.map(
      (check) => `- ${check.ok ? "PASS" : "FAIL"} [${check.layer}] ${check.name}: ${check.message}`
    ),
    "",
    "## White-box Checks",
    "",
    ...(whiteBoxChecks.length
      ? whiteBoxChecks.map((check) => `- ${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.message}`)
      : ["- None recorded."]),
    "",
    "## Black-box Checks",
    "",
    ...(blackBoxChecks.length
      ? blackBoxChecks.map((check) => `- ${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.message}`)
      : ["- None recorded."]),
    "",
    "## Failures",
    "",
    ...(report.failures.length
      ? report.failures.map((failure) => `- ${failure}`)
      : ["- None recorded."]),
    ""
  ];

  fs.writeFileSync(REPORT_MD, lines.join("\n"));
}

function writeJson(report) {
  fs.mkdirSync(CHANGE_DIR, { recursive: true });
  fs.writeFileSync(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`);
}

function readRuntimeEnv() {
  return process.env;
}

function loadLocalEnv() {
  const envFile = process.env.ENV_FILE || ".env";

  if (fs.existsSync(envFile)) {
    loadEnvFile(envFile);
  }
}

function assertEnvValue(value, name) {
  if (!value) {
    throw new Error(`${name} must be set for cleaned Markdown validation.`);
  }
}

function assertUploadLimit(value, sampleCount) {
  const parsed = Number(value ?? Number.NaN);

  if (!Number.isSafeInteger(parsed) || parsed < sampleCount) {
    throw new Error(`MAX_UPLOAD_FILES must be at least ${sampleCount} for this validation run.`);
  }
}

function readValidationTaskTimeoutMs(env, sampleCount) {
  const configured = env[TASK_TIMEOUT_ENV]?.trim();

  if (configured) {
    const parsed = Number(configured);

    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`${TASK_TIMEOUT_ENV} must be a positive integer.`);
    }

    return parsed;
  }

  if (!env.MODEL_API_KEY?.trim() || !env.MODEL_NAME?.trim()) {
    return 180_000;
  }

  const concurrency = readPositiveInteger(env.MODEL_SUGGESTION_CONCURRENCY, 2);
  const idleMs = readPositiveInteger(env.MODEL_REQUEST_IDLE_TIMEOUT_MS, 30_000);
  const batches = Math.ceil(sampleCount / concurrency);

  return Math.max(180_000, batches * 2 * idleMs + 120_000);
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createHttpClient(baseUrl) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  let cookie = "";

  return {
    get cookie() {
      return cookie;
    },
    async request(pathname, options = {}) {
      const headers = new Headers(options.headers ?? {});

      if (cookie && !headers.has("cookie")) {
        headers.set("cookie", cookie);
      }

      let response;

      try {
        response = await fetch(`${normalizedBaseUrl}${pathname}`, {
          ...options,
          headers
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Request failed for ${redactUrl(normalizedBaseUrl)}${pathname}: ${message}`);
      }

      const setCookie = response.headers.get("set-cookie");

      if (setCookie) {
        cookie = setCookie.split(";")[0] ?? "";
      }

      return response;
    }
  };
}

async function validateDatabaseConnectivity(databaseUrl, report) {
  const postgresModule = requireFromApiPackage("postgres");
  const postgres = postgresModule.default ?? postgresModule;
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    await sql`SELECT 1`;
    report.checks.push(okCheck("postgres-prerequisite", "PostgreSQL is reachable.", {}, WHITE_BOX));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function validateRedisConnectivity(redisUrl, report) {
  const { createClient } = requireFromApiPackage("redis");
  const client = createClient({ url: redisUrl });
  await client.connect();

  try {
    await client.ping();
    report.checks.push(okCheck("redis-prerequisite", "Redis is reachable.", {}, WHITE_BOX));
  } finally {
    await client.quit();
  }
}

async function validateS3Connectivity(env, report) {
  const { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } =
    requireFromApiPackage("@aws-sdk/client-s3");
  const client = new S3Client(createS3ClientConfigFromEnv(env));
  const key = `${normalizeS3Prefix(env.S3_PREFIX)}/validation/${randomUUID()}.txt`;

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
        Body: "focowiki-validation",
        ContentType: "text/plain; charset=utf-8"
      })
    );
    const response = await client.send(
      new GetObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key
      })
    );
    const body = await responseBodyToString(response.Body);

    if (body !== "focowiki-validation") {
      throw new Error("S3 validation object body mismatch.");
    }

    report.checks.push(
      okCheck("s3-prerequisite", "S3-compatible storage accepts put and get operations.", {}, WHITE_BOX)
    );
  } catch (error) {
    throw new Error(
      `S3 prerequisite check failed. Verify configured endpoint, bucket, credentials, and prefix. ${redactPotentialPathText(
        error instanceof Error ? error.message : String(error)
      )}`
    );
  } finally {
    await client
      .send(
        new DeleteObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: key
        })
      )
      .catch(() => undefined);
  }
}

async function validatePublicApiReachable(publicApi, env, report) {
  const headers =
    env.PUBLIC_API_AUTH_REQUIRED === "true" && env.PUBLIC_API_KEY
      ? { authorization: `Bearer ${env.PUBLIC_API_KEY}` }
      : {};
  const response = await publicApi.request("/kb/focowiki-validation-missing/index.md", { headers });

  if (response.status !== 404) {
    throw new Error(`Public OpenAPI prerequisite expected HTTP 404, got ${response.status}.`);
  }

  report.checks.push(okCheck("public-openapi-prerequisite", "Public OpenAPI is reachable."));
}

async function expectUnauthorizedAdmin(admin, report) {
  const response = await admin.request("/admin/api/knowledge-bases");

  if (response.status !== 401) {
    report.checks.push(failCheck("admin-auth-required", "Admin API did not reject an unauthenticated request."));
    return;
  }

  report.checks.push(okCheck("admin-auth-required", "Admin API rejects unauthenticated knowledge base reads."));
}

async function loginAdmin(admin, env, report) {
  const response = await admin.request("/admin/api/login", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      username: env.ADMIN_USERNAME,
      password: env.ADMIN_PASSWORD
    })
  });

  if (!response.ok) {
    throw new Error(`Admin login failed with HTTP ${response.status}.`);
  }

  report.checks.push(okCheck("admin-login", "Admin login succeeded with configured credentials."));
}

async function createValidationKnowledgeBase(admin, report) {
  const response = await admin.request("/admin/api/knowledge-bases", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      name: `Focowiki validation ${new Date().toISOString()}`,
      description: "Cleaned Markdown validation run"
    })
  });

  if (response.status !== 201) {
    throw new Error(`Knowledge base creation failed with HTTP ${response.status}.`);
  }

  const body = await response.json();
  const knowledgeBase = body.knowledgeBase;

  if (!knowledgeBase?.id) {
    throw new Error("Knowledge base creation response did not include an id.");
  }

  report.checks.push(okCheck("knowledge-base-create", "Created validation knowledge base."));
  return knowledgeBase;
}

async function uploadSamples(admin, knowledgeBaseId, samples, report) {
  const formData = new FormData();

  for (const sample of samples) {
    const bytes = fs.readFileSync(sample.filePath);
    formData.append("files", new Blob([bytes], { type: "text/markdown" }), sample.basename);
  }

  const response = await admin.request(
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/uploads`,
    {
      method: "POST",
      body: formData
    }
  );

  if (response.status !== 202) {
    const text = await response.text();
    throw new Error(`Sample upload failed with HTTP ${response.status}: ${redactPotentialPathText(text)}`);
  }

  const body = await response.json();
  const task = body.task;

  if (!task?.id || task.sourceCount !== samples.length) {
    throw new Error("Upload response did not include the expected task and source count.");
  }

  report.checks.push(
    okCheck("upload-submit", "Uploaded selected samples in one upload action.", {
      sourceCount: task.sourceCount
    })
  );

  return task;
}

async function pollTaskEnded(admin, knowledgeBaseId, taskId, timeoutMs, report) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await admin.request(
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/tasks?limit=10`
    );

    if (!response.ok) {
      throw new Error(`Task list request failed with HTTP ${response.status}.`);
    }

    const body = await response.json();
    const task = body.items?.find((item) => item.id === taskId);

    if (task?.endedAt) {
      report.checks.push(
        okCheck("task-ended", "Upload task reached ended lifecycle state.", {
          timeoutMs
        })
      );
      return task;
    }

    await sleep(1_000);
  }

  throw new Error(`Timed out waiting for upload task to end after ${timeoutMs}ms.`);
}

async function fetchTaskDetail(admin, knowledgeBaseId, taskId, report) {
  const response = await admin.request(
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/tasks/${encodeURIComponent(taskId)}?limit=50`
  );

  if (!response.ok) {
    throw new Error(`Task detail request failed with HTTP ${response.status}.`);
  }

  const body = await response.json();
  const phases = body.phaseDetails?.items ?? [];

  if (phases.length === 0 || phases.length > 6) {
    throw new Error(`Expected bounded admin phase details, got ${phases.length}.`);
  }

  report.checks.push(
    okCheck("task-detail", "Task detail exposes bounded admin-only phase entries.", {
      phaseCount: phases.length,
      sourceCount: body.sourceFiles?.items?.length ?? 0
    })
  );
  return body;
}

async function validateSingleUploadTaskRow(admin, knowledgeBaseId, taskId, report) {
  const body = await readJson(
    admin,
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/tasks?limit=50`
  );
  const uploadTasks = (body.items ?? []).filter((task) => task.operation === "upload");

  if (uploadTasks.length !== 1 || uploadTasks[0]?.id !== taskId) {
    throw new Error(`Expected one upload task row for one upload action, got ${uploadTasks.length}.`);
  }

  report.checks.push(
    okCheck("single-upload-task-row", "One upload action is represented as one task row with one lifecycle status.", {
      taskId
    })
  );
}

async function validateAdminFileSurfaces(admin, knowledgeBaseId, report) {
  const [releases, bundleFiles, tree, urls] = await Promise.all([
    readJson(admin, `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/releases?limit=10`),
    readJson(admin, `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/bundle-files?limit=50`),
    readJson(admin, `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/tree?limit=50`),
    readJson(admin, `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/public-urls`)
  ]);

  const release = releases.items?.[0];

  if (!release?.publishedAt || (bundleFiles.items?.length ?? 0) === 0 || (tree.items?.length ?? 0) === 0) {
    throw new Error("Expected published release, bundle files, and root tree entries.");
  }

  const pageFile = bundleFiles.items.find((file) => String(file.logicalPath).startsWith("pages/"));
  const indexFile = bundleFiles.items.find((file) => file.logicalPath === "index.md");
  const searchFile = bundleFiles.items.find((file) => file.logicalPath === "_index/search.json");
  const exposedSourceFile = bundleFiles.items.find((file) => String(file.logicalPath).startsWith("sources/"));

  if (!pageFile || !indexFile || !searchFile || exposedSourceFile) {
    throw new Error("Generated bundle must include page and index files without sources/ files.");
  }

  const detail = await readJson(
    admin,
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/detail?path=${encodeURIComponent(pageFile.logicalPath)}`
  );

  if (!detail.content || detail.readOnly !== true) {
    throw new Error("Admin file detail did not return read-only file content.");
  }

  report.checks.push(
    okCheck("admin-file-surfaces", "Admin release, bundle, tree, detail, and public URL surfaces work.", {
      bundleFiles: bundleFiles.items.length,
      rootTreeItems: tree.items.length
    })
  );

  return {
    pageFile,
    indexFile,
    searchFile,
    publicUrls: urls.publicUrls
  };
}

async function validatePublicOpenApi(publicApi, knowledgeBaseId, adminFiles, env, report) {
  if (env.PUBLIC_API_AUTH_REQUIRED === "true") {
    const missingAuth = await publicApi.request(`/kb/${encodeURIComponent(knowledgeBaseId)}/index.md`);

    if (missingAuth.status !== 401) {
      throw new Error("Public OpenAPI private mode did not reject missing bearer auth.");
    }
  }

  const authHeaders =
    env.PUBLIC_API_AUTH_REQUIRED === "true" && env.PUBLIC_API_KEY
      ? { authorization: `Bearer ${env.PUBLIC_API_KEY}` }
      : {};
  const paths = [
    "index.md",
    "schema.md",
    adminFiles.pageFile.logicalPath,
    "_index/manifest.json",
    "_index/search.json",
    "_index/links.json"
  ];
  const bodies = new Map();

  for (const logicalPath of paths) {
    const response = await publicApi.request(
      `/kb/${encodeURIComponent(knowledgeBaseId)}/${encodePublicLogicalPath(logicalPath)}`,
      {
        headers: authHeaders
      }
    );

    if (!response.ok) {
      throw new Error(`Public read failed for ${logicalPath} with HTTP ${response.status}.`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();

    if (!body.trim()) {
      throw new Error(`Public read returned an empty body for ${logicalPath}.`);
    }

    if (logicalPath.endsWith(".json") && !contentType.includes("application/json")) {
      throw new Error(`Expected JSON content type for ${logicalPath}.`);
    }

    if (logicalPath.endsWith(".md") && !contentType.includes("text/markdown")) {
      throw new Error(`Expected Markdown content type for ${logicalPath}.`);
    }

    bodies.set(logicalPath, body);
  }

  validateOkfPublicArtifactBodies({
    bodies,
    pagePath: adminFiles.pageFile.logicalPath,
    report
  });

  const taskStatus = await readJson(
    publicApi,
    `/kb/${encodeURIComponent(knowledgeBaseId)}/tasks/latest`,
    { headers: authHeaders }
  );

  if (!taskStatus.taskId || !taskStatus.startedAt || taskStatus.phaseDetails) {
    throw new Error("Public latest task status does not match the unified public lifecycle shape.");
  }

  await expectJsonError(
    publicApi,
    `/kb/${encodeURIComponent(knowledgeBaseId)}/pages/%252e%252e/secret.md`,
    authHeaders,
    [400]
  );
  await expectJsonError(
    publicApi,
    `/kb/${encodeURIComponent(knowledgeBaseId)}/pages/%5Csecret.md`,
    authHeaders,
    [400]
  );
  await expectJsonError(
    publicApi,
    `/kb/${encodeURIComponent(knowledgeBaseId)}/pages/missing.md`,
    authHeaders,
    [404]
  );
  await expectJsonError(
    publicApi,
    `/kb/${encodeURIComponent(knowledgeBaseId)}/sources/${encodeURIComponent(path.basename(adminFiles.pageFile.logicalPath))}`,
    authHeaders,
    [404]
  );
  await expectJsonError(
    publicApi,
    `/kb/${encodeURIComponent(knowledgeBaseId)}/unsupported.txt`,
    authHeaders,
    [404]
  );

  report.checks.push(
    okCheck(
      "public-openapi",
      "Public scoped Markdown, JSON, task, auth, source hiding, and error checks passed."
    )
  );
}

function validateOkfPublicArtifactBodies({ bodies, pagePath, report }) {
  const index = bodies.get("index.md") ?? "";
  const page = bodies.get(pagePath) ?? "";
  const manifest = parseJsonIndex(bodies.get("_index/manifest.json"), "_index/manifest.json");
  const search = parseJsonIndex(bodies.get("_index/search.json"), "_index/search.json");
  const links = parseJsonIndex(bodies.get("_index/links.json"), "_index/links.json");

  if (!index.includes(pagePath) && !index.includes(encodeURIComponent(path.basename(pagePath)))) {
    throw new Error("Public index.md does not reference the sampled page path.");
  }

  if (!page.startsWith("---\n") || !/\n#\s+/.test(page)) {
    throw new Error("Sampled public page does not include expected frontmatter and heading content.");
  }

  if (!Array.isArray(manifest.files) || !manifest.files.some((file) => file.path === pagePath)) {
    throw new Error("Manifest index does not include sampled public page path.");
  }

  if (!Array.isArray(search.items) || !search.items.some((item) => item.path === pagePath && item.title)) {
    throw new Error("Search index does not include sampled public page metadata.");
  }

  if (
    !Array.isArray(links.links) ||
    !links.links.some((link) => link.to === pagePath || link.from === pagePath)
  ) {
    throw new Error("Link index does not include graph link data for the sampled page.");
  }

  for (const [logicalPath, body] of bodies) {
    if (body.includes("sources/")) {
      throw new Error(`Public artifact unexpectedly exposes sources/ path: ${logicalPath}`);
    }
  }

  report.checks.push(
    okCheck("okf-public-artifacts", "Public OKF Markdown, metadata indexes, headings, and graph links are internally consistent.", {
      pagePath,
      manifestFiles: manifest.files.length,
      searchItems: search.items.length,
      links: links.links.length
    }, WHITE_BOX)
  );
}

async function validateSourceDeletionFullFlow({
  admin,
  publicApi,
  env,
  knowledgeBaseId,
  pageFile,
  taskTimeoutMs,
  report
}) {
  if (!pageFile?.logicalPath || !pageFile.sourceFileId || pageFile.deletable !== true) {
    throw new Error("Validation did not receive a deletable source-backed page file.");
  }

  const response = await admin.request(
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/detail?path=${encodeURIComponent(pageFile.logicalPath)}`,
    {
      method: "DELETE"
    }
  );

  if (response.status !== 202) {
    throw new Error(`Source-backed page deletion failed with HTTP ${response.status}.`);
  }

  const body = await response.json();
  const deletionTask = body.task;

  if (!deletionTask?.id || deletionTask.operation !== "delete_source") {
    throw new Error("Deletion response did not include a source deletion task.");
  }

  report.checks.push(
    okCheck("source-page-delete-submit", "Submitted source-backed page deletion through the Admin API.", {
      operation: deletionTask.operation
    })
  );

  const completedDeletionTask = await pollTaskEnded(
    admin,
    knowledgeBaseId,
    deletionTask.id,
    taskTimeoutMs,
    report
  );

  if (completedDeletionTask.operation !== "delete_source") {
    throw new Error("Deletion task did not keep the delete_source operation.");
  }

  const deletionDetail = await fetchTaskDetail(admin, knowledgeBaseId, deletionTask.id, report);

  if (deletionDetail.task.operation !== "delete_source") {
    throw new Error("Deletion task detail did not expose delete_source operation.");
  }

  await validateDeletionDatabaseBoundaries({
    databaseUrl: env.DATABASE_URL,
    knowledgeBaseId,
    sourceFileId: pageFile.sourceFileId,
    deletedPagePath: pageFile.logicalPath,
    deletionTaskId: deletionTask.id,
    report
  });

  const postDeleteFiles = await readJson(
    admin,
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/bundle-files?limit=50`
  );
  const remainingPage = postDeleteFiles.items?.find(
    (file) => String(file.logicalPath).startsWith("pages/") && file.logicalPath !== pageFile.logicalPath
  );

  if (postDeleteFiles.items?.some((file) => file.logicalPath === pageFile.logicalPath)) {
    throw new Error("Deleted page still appears in the active admin bundle file list.");
  }

  if (!remainingPage?.logicalPath) {
    throw new Error("Deletion validation requires at least one non-deleted source-backed page.");
  }

  await validatePublicDeletionState({
    publicApi,
    env,
    knowledgeBaseId,
    deletedPagePath: pageFile.logicalPath,
    remainingPagePath: remainingPage.logicalPath,
    report
  });

  report.checks.push(
    okCheck("source-page-delete-full-flow", "Source-backed page deletion republished active files without stale page references.", {
      deletedPagePath: pageFile.logicalPath,
      remainingPagePath: remainingPage.logicalPath
    })
  );

  return {
    taskId: deletionTask.id,
    deletedPagePath: pageFile.logicalPath,
    remainingPagePath: remainingPage.logicalPath
  };
}

async function validateDeletionDatabaseBoundaries({
  databaseUrl,
  knowledgeBaseId,
  sourceFileId,
  deletedPagePath,
  deletionTaskId,
  report
}) {
  const postgresModule = requireFromApiPackage("postgres");
  const postgres = postgresModule.default ?? postgresModule;
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    const [shape] = await sql`
      SELECT
        (SELECT count(*)::int
         FROM focowiki.source_files
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND id = ${sourceFileId}
           AND deleted_at IS NOT NULL) AS deleted_sources,
        (SELECT count(*)::int
         FROM focowiki.upload_tasks
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND id = ${deletionTaskId}
           AND operation = 'delete_source'
           AND ended_at IS NOT NULL) AS ended_deletion_tasks,
        (SELECT count(*)::int
         FROM focowiki.upload_task_events
         WHERE task_id = ${deletionTaskId}) AS deletion_task_events,
        (SELECT count(*)::int
         FROM focowiki.releases
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND published_at IS NOT NULL) AS published_releases,
        (SELECT count(*)::int
         FROM focowiki.bundle_files
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND release_id = (
             SELECT active_release_id
             FROM focowiki.knowledge_bases
             WHERE id = ${knowledgeBaseId}
           )
           AND logical_path = ${deletedPagePath}) AS stale_active_pages
    `;

    if (
      shape.deleted_sources !== 1 ||
      shape.ended_deletion_tasks !== 1 ||
      shape.deletion_task_events < 1 ||
      shape.published_releases < 2 ||
      shape.stale_active_pages !== 0
    ) {
      throw new Error(`Unexpected deletion database state: ${JSON.stringify(shape)}`);
    }

    report.checks.push(
      okCheck("deletion-database-boundaries", "PostgreSQL records source deletion, one ended deletion task, task phases, and a replacement active release.", shape, WHITE_BOX)
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function validatePublicDeletionState({
  publicApi,
  env,
  knowledgeBaseId,
  deletedPagePath,
  remainingPagePath,
  report
}) {
  const headers = publicAuthHeaders(env);

  await expectJsonError(
    publicApi,
    `/kb/${encodeURIComponent(knowledgeBaseId)}/${encodePublicLogicalPath(deletedPagePath)}`,
    headers,
    [404]
  );

  const remaining = await readPublicText(
    publicApi,
    `/kb/${encodeURIComponent(knowledgeBaseId)}/${encodePublicLogicalPath(remainingPagePath)}`,
    headers
  );

  if (!remaining.trim()) {
    throw new Error("Remaining source-backed page became unavailable after deletion republish.");
  }

  const publicBodies = new Map([
    [
      "index.md",
      await readPublicText(publicApi, `/kb/${encodeURIComponent(knowledgeBaseId)}/index.md`, headers)
    ],
    [
      "_index/manifest.json",
      await readPublicText(publicApi, `/kb/${encodeURIComponent(knowledgeBaseId)}/_index/manifest.json`, headers)
    ],
    [
      "_index/search.json",
      await readPublicText(publicApi, `/kb/${encodeURIComponent(knowledgeBaseId)}/_index/search.json`, headers)
    ],
    [
      "_index/links.json",
      await readPublicText(publicApi, `/kb/${encodeURIComponent(knowledgeBaseId)}/_index/links.json`, headers)
    ]
  ]);

  for (const [logicalPath, body] of publicBodies) {
    if (body.includes(deletedPagePath) || body.includes(encodeURIComponent(path.basename(deletedPagePath)))) {
      throw new Error(`Public ${logicalPath} still references deleted page ${deletedPagePath}.`);
    }
  }

  const manifest = parseJsonIndex(publicBodies.get("_index/manifest.json"), "_index/manifest.json");
  const search = parseJsonIndex(publicBodies.get("_index/search.json"), "_index/search.json");
  const links = parseJsonIndex(publicBodies.get("_index/links.json"), "_index/links.json");

  if (
    manifest.files.some((file) => file.path === deletedPagePath) ||
    search.items.some((item) => item.path === deletedPagePath) ||
    links.links.some((link) => link.from === deletedPagePath || link.to === deletedPagePath)
  ) {
    throw new Error("Generated indexes still contain deleted page graph or metadata references.");
  }

  report.checks.push(
    okCheck("public-deletion-state", "Public OpenAPI and generated indexes reflect source-backed page deletion.", {
      deletedPagePath,
      remainingPagePath
    })
  );
}

async function validateKnowledgeBaseDeletion({ admin, publicApi, env, knowledgeBaseId, report }) {
  const response = await admin.request(
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`,
    {
      method: "DELETE"
    }
  );

  if (!response.ok) {
    throw new Error(`Knowledge base deletion failed with HTTP ${response.status}.`);
  }

  const body = await response.json();

  if (body.deleted !== true) {
    throw new Error("Knowledge base deletion response did not confirm deletion.");
  }

  const detailResponse = await admin.request(
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
  );

  if (detailResponse.status !== 404) {
    throw new Error("Deleted knowledge base detail route did not return not found.");
  }

  const list = await readJson(admin, "/admin/api/knowledge-bases?limit=50");

  if (list.items?.some((item) => item.id === knowledgeBaseId)) {
    throw new Error("Deleted knowledge base still appears in the admin list.");
  }

  await expectJsonError(
    publicApi,
    `/kb/${encodeURIComponent(knowledgeBaseId)}/index.md`,
    publicAuthHeaders(env),
    [404]
  );

  report.checks.push(
    okCheck("knowledge-base-delete", "Knowledge base deletion hides admin and public reads.")
  );
}

async function validateDatabaseBoundaries(databaseUrl, knowledgeBaseId, taskId, samples, report) {
  const postgresModule = requireFromApiPackage("postgres");
  const postgres = postgresModule.default ?? postgresModule;
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    const [recordCounts] = await sql`
      SELECT
        (SELECT count(*)::int FROM focowiki.source_files WHERE knowledge_base_id = ${knowledgeBaseId}) AS source_files,
        (SELECT count(*)::int FROM focowiki.upload_tasks WHERE knowledge_base_id = ${knowledgeBaseId} AND id = ${taskId}) AS upload_tasks,
        (SELECT count(*)::int FROM focowiki.releases WHERE knowledge_base_id = ${knowledgeBaseId}) AS releases,
        (SELECT count(*)::int FROM focowiki.bundle_files WHERE knowledge_base_id = ${knowledgeBaseId}) AS bundle_files,
        (SELECT count(*)::int FROM focowiki.bundle_tree_entries WHERE knowledge_base_id = ${knowledgeBaseId}) AS bundle_tree_entries
    `;
    const storageShapeRows = await sql`
      SELECT
        (SELECT count(*)::int
         FROM focowiki.source_files
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND task_id = ${taskId}
           AND object_key LIKE '%/uploads/%/sources/%') AS internal_source_objects,
        (SELECT count(*)::int
         FROM focowiki.bundle_files
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND logical_path LIKE 'pages/%'
           AND object_key LIKE '%/releases/%/bundle/pages/%') AS public_page_objects,
        (SELECT count(*)::int
         FROM focowiki.bundle_files
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND logical_path LIKE 'sources/%') AS exposed_source_bundle_files,
        (SELECT bool_and(jsonb_typeof(metadata_json) = 'object')
         FROM focowiki.source_files
         WHERE knowledge_base_id = ${knowledgeBaseId}
           AND task_id = ${taskId}) AS source_metadata_is_object
    `;
    const bodyColumns = await sql`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'focowiki'
        AND table_name IN ('source_files', 'bundle_files')
        AND (
          column_name IN ('body', 'content', 'raw_body', 'markdown_body', 'json_body', 'file_body')
          OR column_name LIKE '%\\_body'
        )
      ORDER BY table_name, column_name
    `;
    const sourceRows = await sql`
      SELECT original_name, object_key, metadata_json
      FROM focowiki.source_files
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND task_id = ${taskId}
      ORDER BY original_name
    `;
    const pageRows = await sql`
      SELECT logical_path, object_key, frontmatter_json
      FROM focowiki.bundle_files
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND release_id = (
          SELECT active_release_id
          FROM focowiki.knowledge_bases
          WHERE id = ${knowledgeBaseId}
        )
        AND logical_path LIKE 'pages/%'
      ORDER BY logical_path
    `;
    const storageShape = storageShapeRows[0] ?? {};
    const expectedNames = new Set(samples.map((sample) => sample.basename));
    const actualNames = new Set(sourceRows.map((row) => row.original_name));

    if (
      recordCounts.source_files !== samples.length ||
      recordCounts.upload_tasks !== 1 ||
      recordCounts.releases < 1 ||
      recordCounts.bundle_files < 1 ||
      recordCounts.bundle_tree_entries < 1
    ) {
      throw new Error(`Unexpected database record counts: ${JSON.stringify(recordCounts)}`);
    }

    if (bodyColumns.length > 0) {
      throw new Error(`Database contains suspicious file body columns: ${JSON.stringify(bodyColumns)}`);
    }

    if (
      storageShape.internal_source_objects !== samples.length ||
      storageShape.public_page_objects < samples.length ||
      storageShape.exposed_source_bundle_files !== 0 ||
      storageShape.source_metadata_is_object !== true
    ) {
      throw new Error(`Unexpected storage-backed database shape: ${JSON.stringify(storageShape)}`);
    }

    for (const name of expectedNames) {
      if (!actualNames.has(name)) {
        throw new Error(`Database did not preserve uploaded original file name: ${name}`);
      }
    }

    const firstSource = sourceRows[0];
    const firstPage = pageRows[0];

    if (!firstSource?.object_key || !firstPage?.object_key || !firstPage?.logical_path) {
      throw new Error("Database did not provide source and generated page storage evidence.");
    }

    report.checks.push(
      okCheck(
        "database-boundaries",
        "PostgreSQL contains durable records, original file names, storage-backed keys, and no raw file body columns.",
        {
          ...recordCounts,
          internalSourceObjects: storageShape.internal_source_objects,
          publicPageObjects: storageShape.public_page_objects,
          exposedSourceBundleFiles: storageShape.exposed_source_bundle_files
        },
        WHITE_BOX
      )
    );

    return {
      sourceObjectKey: firstSource.object_key,
      pageObjectKey: firstPage.object_key,
      pageLogicalPath: firstPage.logical_path,
      sourceOriginalName: firstSource.original_name
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function validateS3ObjectBoundaries(env, evidence, samples, report) {
  const { GetObjectCommand, S3Client } = requireFromApiPackage("@aws-sdk/client-s3");
  const client = new S3Client(createS3ClientConfigFromEnv(env));
  const sourceText = await getS3ObjectText(client, env.S3_BUCKET, evidence.sourceObjectKey);
  const pageText = await getS3ObjectText(client, env.S3_BUCKET, evidence.pageObjectKey);
  const matchingSample = samples.find((sample) => sample.basename === evidence.sourceOriginalName);

  if (!matchingSample) {
    throw new Error("S3 validation could not match database source evidence to selected sample.");
  }

  if (!sourceText.includes(matchingSample.title) || !pageText.startsWith("---\n")) {
    throw new Error("S3 object body validation failed for internal source or generated page object.");
  }

  if (evidence.pageLogicalPath.startsWith("sources/")) {
    throw new Error("S3 generated public page evidence unexpectedly used a sources/ logical path.");
  }

  report.checks.push(
    okCheck(
      "s3-object-boundaries",
      "S3 contains internal source objects and generated public page objects without exposing source logical paths.",
      {
        sourceBodyReadable: true,
        pageBodyReadable: true,
        pageLogicalPath: evidence.pageLogicalPath
      },
      WHITE_BOX
    )
  );
}

async function validateRedisBoundaries(redisUrl, samples, report) {
  const { createClient } = requireFromApiPackage("redis");
  const client = createClient({ url: redisUrl });
  await client.connect();

  try {
    const bodySnippets = samples
      .map((sample) => bodySnippet(readSampleText(sample)))
      .filter(Boolean);
    let cursor = "0";
    let scanned = 0;
    let leakedBodyKey = null;

    do {
      const result = await client.scan(cursor, { COUNT: 100 });
      cursor = String(result.cursor);

      for (const key of result.keys) {
        scanned += 1;
        const type = await client.type(key);

        if (type !== "string") {
          continue;
        }

        const value = await client.get(key);

        const normalizedValue = normalizeTextForLeakScan(value);

        if (normalizedValue && bodySnippets.some((snippet) => normalizedValue.includes(snippet))) {
          leakedBodyKey = key;
          break;
        }
      }
    } while (cursor !== "0" && !leakedBodyKey);

    if (leakedBodyKey) {
      throw new Error("Redis string values contain selected sample Markdown body content.");
    }

    report.checks.push(
      okCheck("redis-boundaries", "Redis scan did not find selected sample Markdown bodies in string values.", {
        scannedKeys: scanned
      }, WHITE_BOX)
    );
  } finally {
    await client.quit();
  }
}

function bodySnippet(value) {
  const normalized = normalizeTextForLeakScan(value);

  return normalized.length >= 120 ? normalized.slice(0, 120) : "";
}

function normalizeTextForLeakScan(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

async function readJson(client, pathname, options = {}) {
  const response = await client.request(pathname, options);

  if (!response.ok) {
    throw new Error(`Request ${pathname} failed with HTTP ${response.status}.`);
  }

  return response.json();
}

async function readPublicText(client, pathname, headers) {
  const response = await client.request(pathname, { headers });

  if (!response.ok) {
    throw new Error(`Request ${pathname} failed with HTTP ${response.status}.`);
  }

  return response.text();
}

async function expectJsonError(client, pathname, headers, statuses) {
  const response = await client.request(pathname, { headers });

  if (!statuses.includes(response.status)) {
    throw new Error(`Expected ${pathname} to return one of ${statuses.join(", ")}, got ${response.status}.`);
  }

  const contentType = response.headers.get("content-type") ?? "";

  if (!contentType.includes("application/json")) {
    throw new Error(`Expected JSON error body for ${pathname}.`);
  }

  const body = await response.json();
  const serialized = JSON.stringify(body);

  if (!body.error?.code) {
    throw new Error(`Expected stable JSON error code for ${pathname}.`);
  }

  if (/bucket|objectKey|object_key|release-[0-9a-f-]|S3_|secret|access/i.test(serialized)) {
    throw new Error(`Public error exposed storage details for ${pathname}.`);
  }
}

function publicAuthHeaders(env) {
  return env.PUBLIC_API_AUTH_REQUIRED === "true" && env.PUBLIC_API_KEY
    ? { authorization: `Bearer ${env.PUBLIC_API_KEY}` }
    : {};
}

function parseJsonIndex(raw, logicalPath) {
  try {
    return JSON.parse(String(raw ?? ""));
  } catch {
    throw new Error(`Public index is not valid JSON: ${logicalPath}`);
  }
}

async function getS3ObjectText(client, bucket, key) {
  const { GetObjectCommand } = requireFromApiPackage("@aws-sdk/client-s3");
  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key
    })
  );

  return responseBodyToString(response.Body);
}

function createS3ClientConfigFromEnv(env) {
  return {
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY
    },
    forcePathStyle: env.S3_FORCE_PATH_STYLE === "true"
  };
}

function normalizeS3Prefix(value) {
  return String(value ?? "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

async function responseBodyToString(body) {
  if (!body) {
    return "";
  }

  if (typeof body === "string") {
    return body;
  }

  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }

  if (typeof body.transformToString === "function") {
    return body.transformToString();
  }

  if (typeof body[Symbol.asyncIterator] === "function") {
    const chunks = [];

    for await (const chunk of body) {
      chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
    }

    return new TextDecoder().decode(Buffer.concat(chunks));
  }

  throw new TypeError("Unsupported S3 response body");
}

function encodePublicLogicalPath(logicalPath) {
  return logicalPath.split("/").map(encodeURIComponent).join("/");
}

function redactUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return "<invalid-url>";
  }
}

function redactPotentialPathText(text) {
  return text
    .replace(/\/[^"'`\s]*\/[^"'`\s]*/g, "<redacted-path>")
    .replace(/[A-Z]:\\[^"'`\s]*/g, "<redacted-path>");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
