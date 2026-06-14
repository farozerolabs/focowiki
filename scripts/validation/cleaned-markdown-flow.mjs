import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnvFile } from "node:process";

const CHANGE_DIR = path.resolve("openspec/changes/validate-cleaned-markdown-upload-flow");
const REPORT_JSON = path.join(CHANGE_DIR, "validation-report.json");
const REPORT_MD = path.join(CHANGE_DIR, "validation-report.md");
const SAMPLE_COUNT = 24;
const SAMPLE_SOURCE_ENV = "FOCOWIKI_VALIDATION_MARKDOWN_DIR";
const requireFromApiPackage = createRequire(
  pathToFileURL(path.resolve("apps/api/package.json"))
);

const REQUIRED_SAMPLE_COVERAGE = {
  statuses: ["有效", "已修改", "尚未生效"],
  types: ["法律", "行政法规", "地方性法规", "司法解释", "监察法规"]
};

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
  report.checks.push(okCheck("sample-directory", "Sample source directory is configured and readable."));
  report.checks.push(okCheck("sample-count", "Selected exactly 24 Markdown samples."));
  report.checks.push(
    okCheck("sample-metadata", "Every selected sample has parseable frontmatter, type, title, and body.")
  );
  report.checks.push(okCheck("sample-coverage", "Selected samples cover required statuses and types."));
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
    assertUploadLimit(env.MAX_UPLOAD_FILES, sampleSelection.samples.length);

    const admin = createHttpClient(adminBaseUrl);
    const publicApi = createHttpClient(publicBaseUrl);

    await expectUnauthorizedAdmin(admin, report);

    await loginAdmin(admin, env, report);
    const knowledgeBase = await createValidationKnowledgeBase(admin, report);
    const uploadTask = await uploadSamples(admin, knowledgeBase.id, sampleSelection.samples, report);
    const completedTask = await pollTaskEnded(admin, knowledgeBase.id, uploadTask.id, report);
    const taskDetail = await fetchTaskDetail(admin, knowledgeBase.id, completedTask.id, report);
    const adminFiles = await validateAdminFileSurfaces(admin, knowledgeBase.id, report);
    await validatePublicOpenApi(publicApi, knowledgeBase.id, adminFiles, env, report);
    await validateDatabaseBoundaries(env.DATABASE_URL, knowledgeBase.id, completedTask.id, report);
    await validateRedisBoundaries(env.REDIS_URL, sampleSelection.samples, report);

    report.validationRun = {
      knowledgeBaseId: knowledgeBase.id,
      taskId: completedTask.id,
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

export function selectSamplesFromEnvironment() {
  const sourceDir = process.env[SAMPLE_SOURCE_ENV];

  if (!sourceDir) {
    throw new Error(`${SAMPLE_SOURCE_ENV} must be set to a local Markdown directory.`);
  }

  return selectSamples(sourceDir);
}

export function selectSamples(sourceDir) {
  const absoluteSourceDir = path.resolve(sourceDir);

  if (!fs.existsSync(absoluteSourceDir) || !fs.statSync(absoluteSourceDir).isDirectory()) {
    throw new Error(`${SAMPLE_SOURCE_ENV} must point to an existing directory.`);
  }

  const files = fs
    .readdirSync(absoluteSourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(absoluteSourceDir, entry.name))
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right)));

  const candidates = files.map(readSampleCandidate);
  const selected = [];
  const selectedNames = new Set();

  for (const status of REQUIRED_SAMPLE_COVERAGE.statuses) {
    addFirstMatching(selected, selectedNames, candidates, (candidate) => candidate.status === status);
  }

  for (const type of REQUIRED_SAMPLE_COVERAGE.types) {
    addFirstMatching(selected, selectedNames, candidates, (candidate) => candidate.type === type);
  }

  addFirstMatching(selected, selectedNames, candidates, (candidate) =>
    candidate.basename.includes("__unknown-date__")
  );
  addFirstMatching(selected, selectedNames, candidates, (candidate) => candidate.title.length >= 80);

  for (const candidate of duplicatedTitleCandidates(candidates)) {
    addCandidate(selected, selectedNames, candidate);

    if (selected.length >= 14) {
      break;
    }
  }

  for (const candidate of candidates) {
    addCandidate(selected, selectedNames, candidate);

    if (selected.length >= SAMPLE_COUNT) {
      break;
    }
  }

  if (selected.length !== SAMPLE_COUNT) {
    throw new Error(`Expected ${SAMPLE_COUNT} samples, selected ${selected.length}.`);
  }

  const invalid = selected.filter(
    (sample) => !sample.basename.endsWith(".md") || !sample.type || !sample.title || !sample.body
  );

  if (invalid.length > 0) {
    throw new Error(`Selected samples contain invalid Markdown metadata: ${invalid.map((item) => item.basename).join(", ")}`);
  }

  const coverage = sampleCoverage(selected);
  const missingStatuses = REQUIRED_SAMPLE_COVERAGE.statuses.filter(
    (status) => !coverage.statuses.includes(status)
  );
  const missingTypes = REQUIRED_SAMPLE_COVERAGE.types.filter((type) => !coverage.types.includes(type));

  if (missingStatuses.length > 0 || missingTypes.length > 0 || !coverage.includesUnknownDate || !coverage.includesLongTitle || !coverage.includesDuplicatedTitle) {
    throw new Error(
      `Sample coverage is incomplete: ${JSON.stringify({ missingStatuses, missingTypes, coverage })}`
    );
  }

  return {
    samples: selected,
    coverage
  };
}

function readSampleCandidate(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const { frontmatter, body } = splitFrontmatter(text);
  const metadata = parseFrontmatter(frontmatter);
  const basename = path.basename(filePath);

  if (!frontmatter) {
    throw new Error(`Selected candidate has no frontmatter: ${basename}`);
  }

  return {
    basename,
    filePath,
    title: String(metadata.title ?? ""),
    type: String(metadata.type ?? ""),
    status: String(metadata.status ?? ""),
    category: String(metadata.category ?? ""),
    publicationDate: String(metadata.publicationDate ?? ""),
    body: body.trim(),
    sizeBytes: Buffer.byteLength(text, "utf8")
  };
}

function splitFrontmatter(text) {
  if (!text.startsWith("---\n")) {
    return { frontmatter: "", body: text };
  }

  const end = text.indexOf("\n---\n", 4);

  if (end === -1) {
    return { frontmatter: "", body: text };
  }

  return {
    frontmatter: text.slice(4, end),
    body: text.slice(end + 5)
  };
}

function parseFrontmatter(frontmatter) {
  const metadata = {};

  for (const line of frontmatter.split("\n")) {
    const index = line.indexOf(":");

    if (index === -1) {
      continue;
    }

    metadata[line.slice(0, index).trim()] = stripYamlValue(line.slice(index + 1));
  }

  return metadata;
}

function stripYamlValue(value) {
  return String(value ?? "")
    .trim()
    .replace(/^"(.*)"$/s, "$1")
    .replace(/^'(.*)'$/s, "$1");
}

function addFirstMatching(selected, selectedNames, candidates, predicate) {
  const candidate = candidates.find((item) => !selectedNames.has(item.basename) && predicate(item));

  if (!candidate) {
    return;
  }

  addCandidate(selected, selectedNames, candidate);
}

function addCandidate(selected, selectedNames, candidate) {
  if (selectedNames.has(candidate.basename) || selected.length >= SAMPLE_COUNT) {
    return;
  }

  selected.push(candidate);
  selectedNames.add(candidate.basename);
}

function duplicatedTitleCandidates(candidates) {
  const groups = new Map();

  for (const candidate of candidates) {
    if (!candidate.title) {
      continue;
    }

    const group = groups.get(candidate.title) ?? [];
    group.push(candidate);
    groups.set(candidate.title, group);
  }

  return Array.from(groups.values())
    .filter((group) => group.length > 1)
    .flatMap((group) => group.slice(0, 2))
    .sort((left, right) => left.basename.localeCompare(right.basename));
}

function sampleCoverage(samples) {
  const duplicatedTitles = samples
    .map((sample) => sample.title)
    .filter((title, index, titles) => title && titles.indexOf(title) !== index);

  return {
    statuses: Array.from(new Set(samples.map((sample) => sample.status).filter(Boolean))).sort(),
    types: Array.from(new Set(samples.map((sample) => sample.type).filter(Boolean))).sort(),
    categories: Array.from(new Set(samples.map((sample) => sample.category).filter(Boolean))).sort(),
    includesUnknownDate: samples.some((sample) => sample.basename.includes("__unknown-date__")),
    includesLongTitle: samples.some((sample) => sample.title.length >= 80),
    includesDuplicatedTitle: duplicatedTitles.length > 0,
    totalSizeBytes: samples.reduce((sum, sample) => sum + sample.sizeBytes, 0)
  };
}

function createBaseReport(kind, startedAt) {
  return {
    kind,
    change: "validate-cleaned-markdown-upload-flow",
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

function okCheck(name, message, details = {}) {
  return {
    name,
    ok: true,
    message,
    details
  };
}

function failCheck(name, message, details = {}) {
  return {
    name,
    ok: false,
    message,
    details
  };
}

function writeReport(report) {
  fs.mkdirSync(CHANGE_DIR, { recursive: true });
  const lines = [
    "# Cleaned Markdown Upload Validation Report",
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
    ...report.checks.map((check) => `- ${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.message}`),
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

async function pollTaskEnded(admin, knowledgeBaseId, taskId, report) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const response = await admin.request(
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/tasks?limit=10`
    );

    if (!response.ok) {
      throw new Error(`Task list request failed with HTTP ${response.status}.`);
    }

    const body = await response.json();
    const task = body.items?.find((item) => item.id === taskId);

    if (task?.endedAt) {
      report.checks.push(okCheck("task-ended", "Upload task reached ended lifecycle state."));
      return task;
    }

    await sleep(1_000);
  }

  throw new Error("Timed out waiting for upload task to end.");
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

async function validateAdminFileSurfaces(admin, knowledgeBaseId, report) {
  const [sourceFiles, releases, bundleFiles, tree, urls] = await Promise.all([
    readJson(admin, `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files?limit=50`),
    readJson(admin, `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/releases?limit=10`),
    readJson(admin, `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/bundle-files?limit=50`),
    readJson(admin, `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/tree?limit=50`),
    readJson(admin, `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/public-urls`)
  ]);

  if ((sourceFiles.items?.length ?? 0) !== SAMPLE_COUNT) {
    throw new Error(`Expected ${SAMPLE_COUNT} source file records.`);
  }

  const release = releases.items?.[0];

  if (!release?.publishedAt || (bundleFiles.items?.length ?? 0) === 0 || (tree.items?.length ?? 0) === 0) {
    throw new Error("Expected published release, bundle files, and root tree entries.");
  }

  const pageFile = bundleFiles.items.find((file) => String(file.logicalPath).startsWith("pages/"));
  const sourceFile = bundleFiles.items.find((file) => String(file.logicalPath).startsWith("sources/"));
  const indexFile = bundleFiles.items.find((file) => file.logicalPath === "index.md");
  const searchFile = bundleFiles.items.find((file) => file.logicalPath === "_index/search.json");

  if (!pageFile || !sourceFile || !indexFile || !searchFile) {
    throw new Error("Generated bundle is missing page, source, index, or search files.");
  }

  const detail = await readJson(
    admin,
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/detail?path=${encodeURIComponent(pageFile.logicalPath)}`
  );

  if (!detail.content || detail.readOnly !== true) {
    throw new Error("Admin file detail did not return read-only file content.");
  }

  report.checks.push(
    okCheck("admin-file-surfaces", "Admin source, release, bundle, tree, detail, and public URL surfaces work.", {
      sourceFiles: sourceFiles.items.length,
      bundleFiles: bundleFiles.items.length,
      rootTreeItems: tree.items.length
    })
  );

  return {
    pageFile,
    sourceFile,
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
    adminFiles.sourceFile.logicalPath,
    "_index/manifest.json",
    "_index/search.json",
    "_index/links.json"
  ];

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
  }

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
    `/kb/${encodeURIComponent(knowledgeBaseId)}/pages/missing.md`,
    authHeaders,
    [404]
  );
  await expectJsonError(
    publicApi,
    `/kb/${encodeURIComponent(knowledgeBaseId)}/unsupported.txt`,
    authHeaders,
    [404]
  );

  report.checks.push(okCheck("public-openapi", "Public scoped Markdown, JSON, task, auth, and error checks passed."));
}

async function validateDatabaseBoundaries(databaseUrl, knowledgeBaseId, taskId, report) {
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

    if (
      recordCounts.source_files !== SAMPLE_COUNT ||
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

    report.checks.push(
      okCheck("database-boundaries", "PostgreSQL contains records and no raw file body columns.", recordCounts)
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function validateRedisBoundaries(redisUrl, samples, report) {
  const { createClient } = requireFromApiPackage("redis");
  const client = createClient({ url: redisUrl });
  await client.connect();

  try {
    const bodySnippets = samples
      .map((sample) => bodySnippet(sample.body))
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
      })
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
