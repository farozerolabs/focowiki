import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { selectSingleAndBatchSamplesFromEnvironment } from "./lib/sample-selector.mjs";
import { redactReportText } from "./lib/redaction.mjs";
import { matchExistingSourceSamples } from "./lib/existing-source-samples.mjs";
import { normalizeMarkdownLinkDestinations } from "./lib/markdown-body-comparison.mjs";
import { uploadMarkdownFilesWithSession } from "./lib/upload-session-client.mjs";
import {
  isReservedOkfMarkdownPath,
  requiresSourceBodyComparison,
  validateProjectionCatalog,
  validateReservedMarkdownFrontmatter
} from "./lib/okf-file-contract.mjs";
import {
  readAdminSourceFileModelName,
  readAdminSourceFileId,
  readUploadSourceFileId
} from "./lib/source-file-contract.mjs";
import {
  readConsistentGeneratedContent
} from "./lib/active-generation-content-reader.mjs";

const CHANGE_ID =
  process.env.FOCOWIKI_VALIDATION_CHANGE_ID?.trim() ||
  "implement-breaking-storage-vnext";
const CHANGE_DIR = path.resolve("openspec/changes", CHANGE_ID);
const REPORT_JSON = path.join(CHANGE_DIR, "file-inspection-report.json");
const REPORT_MD = path.join(CHANGE_DIR, "file-inspection-report.md");
const exportDirectory = process.env.FOCOWIKI_VALIDATION_EXPORT_DIR?.trim()
  ? path.resolve(process.env.FOCOWIKI_VALIDATION_EXPORT_DIR)
  : null;
const keepKnowledgeBase = process.env.FOCOWIKI_VALIDATION_KEEP_KNOWLEDGE_BASE === "1";
const existingKnowledgeBaseId =
  process.env.FOCOWIKI_VALIDATION_EXISTING_KNOWLEDGE_BASE_ID?.trim() || null;
const requireFromOkfPackage = createRequire(path.resolve("packages/okf/package.json"));
const matter = requireFromOkfPackage("gray-matter");

loadLocalEnv();

const report = {
  kind: "generated-okf-file-inspection",
  change: CHANGE_ID,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  sampleCount: 0,
  knowledgeBaseId: null,
  sourceFileIds: [],
  generationId: null,
  modelName: null,
  files: [],
  checks: [],
  failures: []
};

let cleanup = null;
let cleanupPublicKey = null;
let runError = null;

try {
  let samples = selectInspectionSamples();
  report.sampleCount = samples.length;
  const admin = createJsonClient(readBaseUrl("ADMIN_API_PORT", "43000"));
  const developer = createJsonClient(readBaseUrl("PUBLIC_OPENAPI_PORT", "43200"));
  await loginAdmin(admin);
  const publicKey = await createPublicOpenApiKey(admin);
  developer.headers.authorization = `Bearer ${publicKey.rawKey}`;
  cleanupPublicKey = () => deletePublicOpenApiKey(admin, publicKey.id);
  const knowledgeBase = existingKnowledgeBaseId
    ? { id: existingKnowledgeBaseId }
    : await createKnowledgeBase(admin);
  report.knowledgeBaseId = knowledgeBase.id;
  if (!existingKnowledgeBaseId) {
    cleanup = () => deleteKnowledgeBase(admin, knowledgeBase.id);
    const upload = await uploadMarkdownFiles(admin, knowledgeBase.id, samples);
    report.sourceFileIds = upload.files.map(readUploadSourceFileId).filter(Boolean);
  } else {
    const existingFiles = await listSourceFiles(admin, knowledgeBase.id);
    samples = matchExistingSourceSamples({
      sourceDirectory: requiredEnv("FOCOWIKI_VALIDATION_MARKDOWN_DIR"),
      existingFiles,
      expectedCount: samples.length
    }).map((sample) => ({
      ...sample,
      title: matter(fs.readFileSync(sample.filePath, "utf8")).data.title
    }));
    report.sourceFileIds = existingFiles.map(readAdminSourceFileId).filter(Boolean);
    report.checks.push(
      okCheck(
        "existing-knowledge-base",
        "A completed validation knowledge base was reused for content inspection."
      )
    );
  }
  if (report.sourceFileIds.length !== samples.length) {
    throw new Error(`Expected ${samples.length} source file identities, got ${report.sourceFileIds.length}.`);
  }
  const sourceFiles = await waitForSourceFilesCompleted(admin, knowledgeBase.id, report.sourceFileIds, readSourceFileTimeoutMs(samples.length));
  report.modelName = listSourceFileModelNames(sourceFiles).join(", ") || null;
  assertSourceFiles(sourceFiles, samples);
  report.generationId = await waitForPublicationQuiescence(
    requiredEnv("DATABASE_URL"),
    knowledgeBase.id,
    readSourceFileTimeoutMs(samples.length)
  );
  const adminGenerationId = await readActiveGeneration(admin, knowledgeBase.id);
  if (adminGenerationId !== report.generationId) {
    throw new Error("Admin and durable publication state returned different active generations.");
  }
  const generatedFiles = await waitForGeneratedFiles(
    requiredEnv("DATABASE_URL"),
    knowledgeBase.id,
    samples,
    readSourceFileTimeoutMs(samples.length)
  );
  const contents = await readAllGeneratedContents(
    developer,
    knowledgeBase.id,
    generatedFiles,
    report.generationId
  );
  inspectGeneratedFiles(generatedFiles, contents, samples);
  await inspectDeveloperTree(developer, knowledgeBase.id, generatedFiles);
  if (!keepKnowledgeBase && cleanup) {
    await cleanup();
    cleanup = null;
  } else {
    cleanup = null;
    report.checks.push(
      okCheck(
        "knowledge-base-retained",
        "The validation knowledge base was retained for follow-up mutation checks."
      )
    );
  }
  report.ok = true;
} catch (error) {
  runError = error;
  report.failures.push(redactReportText(error instanceof Error ? error.message : String(error)));
} finally {
  if (cleanup) {
    await cleanup().catch(() => undefined);
  }
  if (cleanupPublicKey) {
    await cleanupPublicKey().catch(() => undefined);
  }
  report.finishedAt = new Date().toISOString();
  writeReports(report);
}

if (runError) {
  throw runError;
}

function loadLocalEnv() {
  const envFile = process.env.ENV_FILE || ".env";

  if (fs.existsSync(envFile)) {
    loadEnvFile(envFile);
  }
}

function selectInspectionSamples() {
  const selection = selectSingleAndBatchSamplesFromEnvironment();
  return [selection.singleSample, ...selection.batchSamples];
}

function createJsonClient(baseUrl) {
  return {
    baseUrl,
    cookie: "",
    headers: {},
    async request(pathname, options = {}) {
      const headers = {
        ...this.headers,
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(options.headers ?? {})
      };
      const response = await fetch(`${this.baseUrl}${pathname}`, {
        ...options,
        headers
      });
      const setCookie = response.headers.get("set-cookie");

      if (setCookie) {
        this.cookie = setCookie.split(";")[0] ?? "";
      }

      return response;
    },
    async json(pathname, options = {}) {
      const response = await this.request(pathname, options);
      const text = await response.text();
      const parsed = text ? JSON.parse(text) : null;

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${pathname}: ${JSON.stringify(parsed)}`);
      }

      return parsed;
    }
  };
}

function readBaseUrl(portField, fallbackPort) {
  const port = process.env[portField]?.trim() || fallbackPort;
  return `http://127.0.0.1:${port}`;
}

async function loginAdmin(admin) {
  const username = requiredEnv("ADMIN_USERNAME");
  const password = requiredEnv("ADMIN_PASSWORD");
  await admin.json("/admin/api/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: process.env.ADMIN_PUBLIC_ORIGIN || "http://127.0.0.1:43100"
    },
    body: JSON.stringify({ username, password })
  });
  report.checks.push(okCheck("admin-login", "Admin login succeeded."));
}

async function createPublicOpenApiKey(admin) {
  const body = await admin.json("/admin/api/openapi-keys", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: process.env.ADMIN_PUBLIC_ORIGIN || "http://127.0.0.1:43100"
    },
    body: JSON.stringify({ name: `file-inspection-${Date.now()}` })
  });
  const rawKey = body?.oneTimeKey?.rawKey;
  const keyId = body?.key?.id;

  if (!rawKey || !keyId) {
    throw new Error("OpenAPI key creation did not return a one-time raw key.");
  }

  report.checks.push(okCheck("openapi-key", "Temporary Developer OpenAPI key was created."));
  return { id: keyId, rawKey };
}

async function deletePublicOpenApiKey(admin, keyId) {
  await admin.json(`/admin/api/openapi-keys/${encodeURIComponent(keyId)}`, {
    method: "DELETE",
    headers: {
      origin: process.env.ADMIN_PUBLIC_ORIGIN || "http://127.0.0.1:43100"
    }
  });
}

async function createKnowledgeBase(admin) {
  const body = await admin.json("/admin/api/knowledge-bases", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: process.env.ADMIN_PUBLIC_ORIGIN || "http://127.0.0.1:43100"
    },
    body: JSON.stringify({
      name: `Generated file inspection ${new Date().toISOString()}`,
      description: "Generated OKF file inspection"
    })
  });
  const knowledgeBase = body?.knowledgeBase;

  if (!knowledgeBase?.id) {
    throw new Error("Knowledge base creation did not return an id.");
  }

  report.checks.push(okCheck("knowledge-base-create", "Inspection knowledge base was created."));
  return knowledgeBase;
}

async function deleteKnowledgeBase(admin, knowledgeBaseId) {
  await admin.json(`/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`, {
    method: "DELETE",
    headers: {
      origin: process.env.ADMIN_PUBLIC_ORIGIN || "http://127.0.0.1:43100"
    }
  });
}

async function uploadMarkdownFiles(admin, knowledgeBaseId, samples) {
  const body = await uploadMarkdownFilesWithSession({
    request: (pathname, options) => admin.json(pathname, {
      method: options.method,
      headers: {
        origin: process.env.ADMIN_PUBLIC_ORIGIN || "http://127.0.0.1:43100",
        ...(options.headers ?? {}),
        ...(options.body ? { "content-type": "application/json" } : {})
      },
      body: options.rawBody ?? (options.body ? JSON.stringify(options.body) : undefined)
    }),
    routeBase: `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/upload-sessions`,
    files: samples.map((sample) => ({
      relativePath: sample.relativePath ?? sample.basename,
      bytes: fs.readFileSync(sample.filePath)
    }))
  });

  if (!Array.isArray(body?.files) || body.files.length !== samples.length) {
    throw new Error("Upload response did not include accepted source files.");
  }

  const missingIds = body.files.filter((file) => !readUploadSourceFileId(file));
  if (missingIds.length > 0) {
    throw new Error("Upload response included source files without id.");
  }

  report.checks.push(okCheck("upload-submit", "Selected Markdown files were uploaded."));
  return body;
}

async function waitForSourceFilesCompleted(admin, knowledgeBaseId, sourceFileIds, timeoutMs) {
  const startedAt = Date.now();
  const expectedIds = new Set(sourceFileIds);

  while (Date.now() - startedAt < timeoutMs) {
    const files = await listSourceFiles(admin, knowledgeBaseId);
    const selected = files.filter((file) => {
      const sourceFileId = readAdminSourceFileId(file);
      return sourceFileId ? expectedIds.has(sourceFileId) : false;
    });

    if (
      selected.length === expectedIds.size &&
      selected.every((file) => file.state === "visible")
    ) {
      report.checks.push(okCheck("source-files-completed", "Uploaded source files reached completed processing state."));
      return selected;
    }

    const failed = selected.find((file) => file.state === "failed");
    if (failed) {
      throw new Error(`Source file processing failed: ${failed.relativePath} (${failed.failure?.code ?? "unknown"})`);
    }

    await sleep(1000);
  }

  throw new Error(`Source files did not complete within ${timeoutMs}ms.`);
}

async function listSourceFiles(admin, knowledgeBaseId) {
  const files = [];
  let cursor = null;

  do {
    const params = new URLSearchParams({ limit: "100" });
    if (cursor) {
      params.set("cursor", cursor);
    }
    const body = await admin.json(
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/source-files?${params.toString()}`
    );
    files.push(...(body.items ?? []));
    cursor = body.nextCursor ?? null;
  } while (cursor);

  return files;
}

function assertSourceFiles(files, samples) {
  const expectedPaths = new Set(
    samples.map((sample) => sample.relativePath ?? sample.basename)
  );

  if (files.length !== expectedPaths.size) {
    throw new Error(`Expected ${expectedPaths.size} source files, got ${files.length}.`);
  }

  for (const file of files) {
    if (!expectedPaths.has(file.relativePath)) {
      throw new Error(`Unexpected source file path: ${file.relativePath}`);
    }
    if (file.state !== "visible") {
      throw new Error(`Source file did not finish processing: ${file.relativePath}`);
    }
    if (file.modelInvocationStatus === "running") {
      throw new Error(`Source file model invocation did not reach a terminal state: ${file.relativePath}`);
    }
    if (file.modelInvocationStatus === "failed") {
      report.checks.push(
        okCheck(
          "source-file-model-fallback",
          "Model invocation failed but source-file processing completed with deterministic fallback.",
          {
            sourceFileId: readAdminSourceFileId(file),
            name: file.relativePath,
            relativePath: file.relativePath,
            modelInvocationErrorCode: file.modelInvocationErrorCode ?? null
          }
        )
      );
    }
  }

  report.checks.push(okCheck("source-files", "Every uploaded source file finished processing with preserved original names."));
}

function listSourceFileModelNames(files) {
  return [...new Set(files.map(readAdminSourceFileModelName).filter(Boolean))].sort();
}

async function readActiveGeneration(admin, knowledgeBaseId) {
  const body = await admin.json(
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
  );
  const generationId = body.knowledgeBase?.activeGenerationId;
  if (!generationId) {
    throw new Error("No active generation was published after upload.");
  }
  report.checks.push(okCheck("generation", "An active generation was published after upload."));
  return generationId;
}

async function waitForPublicationQuiescence(
  databaseUrl,
  knowledgeBaseId,
  timeoutMs
) {
  const requireFromApi = createRequire(path.resolve("apps/api/package.json"));
  const postgresModule = requireFromApi("postgres");
  const postgres = postgresModule.default ?? postgresModule;
  const sql = postgres(databaseUrl, { max: 1 });
  const deadline = Date.now() + timeoutMs;
  let stableGenerationId = null;
  let stablePolls = 0;

  try {
    while (Date.now() < deadline) {
      const rows = await sql`
        SELECT snapshot.release_root_public_id AS active_generation_id,
               (
                 SELECT count(*)::int
                 FROM focowiki.operation_work_items work
                 WHERE work.knowledge_base_id = ${knowledgeBaseId}
                   AND work.work_kind IN ('publication', 'search')
                   AND work.state IN ('queued', 'running', 'retry')
               ) AS publication_job_count,
               (
                 SELECT count(*)::int
                 FROM focowiki.release_candidates candidate
                 WHERE candidate.knowledge_base_id = ${knowledgeBaseId}
                   AND candidate.state IN ('building', 'validating', 'ready')
               ) AS nonterminal_generation_count
        FROM focowiki.knowledge_bases knowledge_base
        LEFT JOIN focowiki.active_snapshots snapshot
          ON snapshot.knowledge_base_id = knowledge_base.public_id
        WHERE knowledge_base.public_id = ${knowledgeBaseId}
          AND knowledge_base.deleted_at IS NULL
      `;
      const row = rows[0];
      const generationId = row?.active_generation_id ?? null;
      const idle = generationId
        && Number(row.publication_job_count) === 0
        && Number(row.nonterminal_generation_count) === 0;

      if (idle && generationId === stableGenerationId) {
        stablePolls += 1;
      } else {
        stableGenerationId = idle ? generationId : null;
        stablePolls = idle ? 1 : 0;
      }
      if (stablePolls >= 3) {
        report.checks.push(
          okCheck(
            "publication-quiescence",
            "Publication reached a stable active generation before content inspection."
          )
        );
        return stableGenerationId;
      }
      await sleep(250);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  throw new Error(`Publication did not become quiescent within ${timeoutMs}ms.`);
}

async function waitForGeneratedFiles(databaseUrl, knowledgeBaseId, samples, timeoutMs) {
  const startedAt = Date.now();
  const expectedPaths = new Set(samples.map(pagePathForSample));

  while (Date.now() - startedAt < timeoutMs) {
    const files = await listActiveGeneratedFiles(databaseUrl, knowledgeBaseId);
    const availablePaths = new Set(files.map((file) => file.logicalPath));
    const missing = [...expectedPaths].filter((logicalPath) => !availablePaths.has(logicalPath));

    if (missing.length === 0) {
      report.checks.push(okCheck("active-file-list", `Listed ${files.length} active generated files.`));
      return files;
    }

    await sleep(1000);
  }

  throw new Error(`Active generation did not include every uploaded page within ${timeoutMs}ms.`);
}

async function listActiveGeneratedFiles(databaseUrl, knowledgeBaseId) {
  const requireFromApi = createRequire(path.resolve("apps/api/package.json"));
  const postgresModule = requireFromApi("postgres");
  const postgres = postgresModule.default ?? postgresModule;
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await sql`
      SELECT coalesce(entry.source_file_public_id, entry.object_id) AS id,
             entry.entry_kind,
             entry.logical_path,
             entry.source_file_public_id,
             registration.storage_key,
             registration.content_type,
             entry.byte_count,
             entry.checksum_sha256
      FROM focowiki.active_snapshots snapshot
      CROSS JOIN LATERAL
        focowiki.resolve_release_catalog(snapshot.release_root_public_id) entry
      JOIN focowiki.object_registrations registration
        ON registration.object_id = entry.object_id
       AND registration.state = 'verified'
      WHERE snapshot.knowledge_base_id = ${knowledgeBaseId}
      ORDER BY entry.logical_path
    `;
    if (rows.length === 0) throw new Error("No active generated files were returned.");
    return rows.map((row) => ({
      id: row.id,
      logicalPath: row.logical_path,
      sourceFileId: row.source_file_public_id,
      fileKind: generatedFileKind(row.entry_kind, row.logical_path),
      objectKey: row.storage_key,
      contentType: row.content_type,
      sizeBytes: Number(row.byte_count),
      checksumSha256: row.checksum_sha256,
      title: null,
      deletable: row.entry_kind === "source" && Boolean(row.source_file_public_id)
    }));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function generatedFileKind(entryKind, logicalPath) {
  if (entryKind === "source") return "page";
  if (logicalPath.startsWith("_graph/")) return "graph_index";
  if (logicalPath.startsWith("_index/")) return "search_index";
  return "index";
}

async function readAllGeneratedContents(
  developer,
  knowledgeBaseId,
  generatedFiles,
  generationId
) {
  const contents = new Map();
  const concurrency = readBoundedIntegerEnvironment(
    "FOCOWIKI_VALIDATION_CONTENT_READ_CONCURRENCY",
    4,
    1,
    8
  );
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, generatedFiles.length) }, async () => {
      while (nextIndex < generatedFiles.length) {
        const file = generatedFiles[nextIndex++];
        const result = await readConsistentGeneratedContent({
          logicalPath: file.logicalPath,
          maxAttempts: 5,
          expectedGenerationId: generationId,
          readById: () => developer.json(
            `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/${encodeURIComponent(file.id)}/content`
          ),
          readByPath: () => developer.json(
            `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/content?path=${encodeURIComponent(file.logicalPath)}`
          ),
          wait: () => new Promise((resolve) => setTimeout(resolve, 100))
        });

        if (result.file?.fileId !== file.id) {
          throw new Error(`File identity mismatch between Admin and Developer OpenAPI: ${file.logicalPath}`);
        }

        contents.set(file.logicalPath, result.content);
        exportGeneratedContent(file.logicalPath, result.content);
      }
    })
  );

  report.checks.push(okCheck("content-read", "Every generated file was readable by id and logical path."));
  return contents;
}

function exportGeneratedContent(logicalPath, content) {
  if (!exportDirectory) return;
  const target = path.resolve(exportDirectory, logicalPath);
  if (target !== exportDirectory && !target.startsWith(`${exportDirectory}${path.sep}`)) {
    throw new Error(`Generated export path escaped its target directory: ${logicalPath}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function readBoundedIntegerEnvironment(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function inspectGeneratedFiles(generatedFiles, contents, samples) {
  const byPath = new Map(generatedFiles.map((file) => [file.logicalPath, file]));
  const paths = new Set(byPath.keys());
  const expectedPaths = buildExpectedPaths(samples);
  const missing = expectedPaths.filter((pathName) => !paths.has(pathName));

  if (missing.length > 0) {
    throw new Error(`Active generation is missing expected paths: ${missing.join(", ")}`);
  }

  for (const file of generatedFiles) {
    const content = contents.get(file.logicalPath);

    inspectSingleFile(file, content, paths, samples);
  }

  inspectIndexes(contents, paths);
  report.checks.push(okCheck("all-generated-files", "Every generated Markdown and JSON file passed structural inspection."));
}

function buildExpectedPaths(samples) {
  return [
    "_graph/index.md",
    "_index/catalog.json",
    "_index/index.md",
    "index.md",
    "log.md",
    "pages/index.md",
    ...samples.map(pagePathForSample).sort((left, right) => left.localeCompare(right)),
    "schema.md"
  ];
}

function inspectSingleFile(file, content, paths, samples) {
  if (typeof content !== "string" || content.length === 0) {
    throw new Error(`Generated file is empty: ${file.logicalPath}`);
  }
  if (sha256(content) !== file.checksumSha256) {
    throw new Error(`Generated file checksum mismatch: ${file.logicalPath}`);
  }
  assertSafeGeneratedText(file.logicalPath, content);

  if (file.logicalPath.endsWith(".json")) {
    JSON.parse(content);
    assertContentType(file, "application/json; charset=utf-8");
  } else if (file.logicalPath.endsWith(".jsonl")) {
    inspectJsonlFile(file, content);
    assertContentType(file, "application/x-ndjson; charset=utf-8");
  } else if (file.logicalPath.endsWith(".md")) {
    assertContentType(file, "text/markdown; charset=utf-8");
    inspectMarkdownFile(file, content, samples);
  } else {
    throw new Error(`Unexpected generated file extension: ${file.logicalPath}`);
  }

  report.files.push({
    path: file.logicalPath,
    kind: file.fileKind,
    sizeBytes: file.sizeBytes,
    checksumSha256: file.checksumSha256,
    title: file.title || null,
    sourceBacked: Boolean(file.sourceFileId)
  });
}

function inspectJsonlFile(file, content) {
  const lines = content.split("\n").filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    throw new Error(`JSONL file is empty: ${file.logicalPath}`);
  }

  for (const line of lines) {
    JSON.parse(line);
  }
}

function inspectMarkdownFile(file, content, samples) {
  const parsed = matter(content);

  if (isReservedOkfMarkdownPath(file.logicalPath)) {
    if (!validateReservedMarkdownFrontmatter(file.logicalPath, parsed.data)) {
      throw new Error(`Reserved Markdown file has invalid frontmatter: ${file.logicalPath}`);
    }
    if (!parsed.content.startsWith("# ")) {
      throw new Error(`Reserved Markdown file must start with a heading: ${file.logicalPath}`);
    }
    return;
  }

  if (!parsed.data?.type || !parsed.data?.title) {
    throw new Error(`Markdown file is missing required OKF frontmatter: ${file.logicalPath}`);
  }

  if (file.logicalPath === "schema.md") {
    return;
  }

  if (file.logicalPath.startsWith("_graph/")) {
    if (!parsed.content.startsWith("# ")) {
      throw new Error(`Graph Markdown file must start with a heading: ${file.logicalPath}`);
    }
    return;
  }

  if (file.fileKind === "directory_index_page" || file.fileKind === "directory_index_map") {
    if (!parsed.content.startsWith("# ")) {
      throw new Error(`Directory navigation file must start with a heading: ${file.logicalPath}`);
    }
    return;
  }

  if (!requiresSourceBodyComparison(file)) {
    if (!parsed.content.startsWith("# ")) {
      throw new Error(`Generated Markdown concept must start with a heading: ${file.logicalPath}`);
    }
    return;
  }

  const sample = samples.find((candidate) => pagePathForSample(candidate) === file.logicalPath);

  if (!sample) {
    throw new Error(`Generated page path does not match any uploaded original filename: ${file.logicalPath}`);
  }

  const sourceFile = matter(fs.readFileSync(sample.filePath, "utf8"));
  assertMetadataPreserved(file.logicalPath, sourceFile.data, parsed.data);
  assertSourceBodyPreserved(file.logicalPath, sourceFile.content, parsed.content);

  if (!parsed.content.includes(sample.title)) {
    throw new Error(`Generated page content does not include the source title: ${file.logicalPath}`);
  }

  if (countMarkdownHeading(parsed.content, "related") > 1) {
    throw new Error(`Generated page contains duplicate Related sections: ${file.logicalPath}`);
  }

  if (countMarkdownHeading(parsed.content, "citations") > 1) {
    throw new Error(`Generated page contains duplicate Citations sections: ${file.logicalPath}`);
  }
}

function pagePathForSample(sample) {
  return `pages/${sample.relativePath ?? sample.basename}`;
}

function assertSourceBodyPreserved(filePath, sourceContent, generatedContent) {
  const prepared = prepareSourceBodyForComparison(sourceContent);
  const generated = prepareSourceBodyForComparison(generatedContent);

  if (generated !== prepared) {
    throw new Error(`Generated page body does not exactly match its source Markdown: ${filePath}`);
  }

  const snippets = selectBodySnippets(prepared);

  if (snippets.length === 0) {
    throw new Error(`Source body did not provide comparable snippets: ${filePath}`);
  }

  const missing = snippets.filter((snippet) => !generated.includes(snippet));

  if (missing.length > 0) {
    throw new Error(`Generated page dropped source body snippets in ${filePath}: ${missing.slice(0, 2).join(" | ")}`);
  }
}

function prepareSourceBodyForComparison(sourceContent) {
  let lines = sourceContent.trimEnd().split(/\r?\n/);
  const citationsStart = findTrailingHeading(lines, "citations");

  if (citationsStart !== null) {
    lines = lines.slice(0, citationsStart);
  }

  const relatedStart = findTrailingHeading(lines, "related");

  if (relatedStart !== null) {
    lines = lines.slice(0, relatedStart);
  }

  return normalizeMarkdownLinkDestinations(lines.join("\n").trim());
}

function selectBodySnippets(content) {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 24 && !/^#{1,6}\s+related\s*$/i.test(line));
  const selected = [];

  for (const index of [0, 1, 2, Math.floor(lines.length / 2), lines.length - 3, lines.length - 2, lines.length - 1]) {
    const line = lines[index];

    if (line && !selected.includes(line)) {
      selected.push(line);
    }
  }

  return selected;
}

function countMarkdownHeading(content, expectedTitle) {
  return content
    .split(/\r?\n/)
    .filter((line) => readHeadingTitle(line) === expectedTitle)
    .length;
}

function findTrailingHeading(lines, expectedTitle) {
  const headingStart = findLastMarkdownHeading(lines);

  if (headingStart === null) {
    return null;
  }

  return readHeadingTitle(lines[headingStart]) === expectedTitle ? headingStart : null;
}

function findLastMarkdownHeading(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (readHeadingTitle(lines[index])) {
      return index;
    }
  }

  return null;
}

function readHeadingTitle(line) {
  const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line?.trim() ?? "");
  return match?.[2]?.trim().toLowerCase() || null;
}

function assertMetadataPreserved(filePath, source, generated) {
  for (const [field, value] of Object.entries(source ?? {})) {
    if (!isComparableMetadataValue(value)) {
      continue;
    }

    const generatedValue = generated[field];

    if (
      field === "description" &&
      typeof value === "string" &&
      isLowInformationDescription(value, source?.title, filePath)
    ) {
      if (
        typeof generatedValue !== "string" ||
        generatedValue.trim().length === 0 ||
        isLowInformationDescription(generatedValue, generated?.title, filePath)
      ) {
        throw new Error(`Generated metadata kept a low-information description in ${filePath}.`);
      }
      continue;
    }

    if (Array.isArray(value)) {
      const generatedItems = Array.isArray(generatedValue) ? generatedValue : [];
      const missingItems = value.filter((item) => !generatedItems.includes(item));

      if (missingItems.length > 0) {
        throw new Error(`Generated metadata dropped source ${field} values in ${filePath}: ${missingItems.join(", ")}`);
      }
      continue;
    }

    if (hasValue(value) && generatedValue !== value) {
      throw new Error(`Generated metadata changed source ${field} in ${filePath}.`);
    }
  }
}

function isLowInformationDescription(description, title, filePath) {
  const normalizedDescription = normalizePresentationText(description);
  const fileName = filePath.split("/").at(-1)?.replace(/\.md$/iu, "") ?? "";
  return normalizedDescription.length === 0 || [title, fileName]
    .map(normalizePresentationText)
    .filter(Boolean)
    .includes(normalizedDescription);
}

function normalizePresentationText(value) {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/gu, " ").trim().replace(/[.!?。！？]+$/gu, "").trim().toLowerCase()
    : "";
}

function isComparableMetadataValue(value) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }

  return Array.isArray(value) && value.every((item) =>
    typeof item === "string" || typeof item === "number" || typeof item === "boolean"
  );
}

function inspectIndexes(contents, paths) {
  const catalog = JSON.parse(contents.get("_index/catalog.json"));
  if (!validateProjectionCatalog(catalog)) {
    throw new Error("Projection catalog does not match the current sharded contract.");
  }
  const shardedProjectionKeys = [
    "search",
    "links",
    "manifest",
    "tree",
    "graphNodes",
    "graphEdges"
  ];
  for (const key of shardedProjectionKeys) {
    for (const shard of catalog.projections[key].shards) {
      if (!paths.has(shard.path)) {
        throw new Error(`Projection catalog references a missing shard: ${shard.path}`);
      }
    }
  }
  const machineFiles = [...paths].filter((logicalPath) => logicalPath.endsWith(".json"));
  for (const logicalPath of machineFiles) {
    JSON.parse(contents.get(logicalPath));
  }
  report.checks.push(okCheck(
    "json-indexes",
    "The projection catalog and active machine-readable shards are valid JSON.",
    { machineFileCount: machineFiles.length }
  ));
}

async function inspectDeveloperTree(developer, knowledgeBaseId, generatedFiles) {
  const expectedFilePaths = new Set(generatedFiles
    .filter((file) => file.fileKind === "page")
    .map((file) => file.logicalPath));
  const observedFilePaths = new Set();
  const queue = ["pages"];

  while (queue.length > 0) {
    const parentPath = queue.shift();
    let cursor = null;

    do {
      const params = new URLSearchParams({ limit: "100" });

      if (parentPath) {
        params.set("parentPath", parentPath);
      }
      if (cursor) {
        params.set("cursor", cursor);
      }

      const page = await developer.json(
        `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/tree?${params.toString()}`
      );

      for (const item of page.items ?? []) {
        if (item.entryType === "directory") {
          queue.push(item.path);
        } else {
          observedFilePaths.add(item.path);
        }
      }

      cursor = page.nextCursor;
    } while (cursor);
  }

  const missing = [...expectedFilePaths].filter((pathName) => !observedFilePaths.has(pathName));

  if (missing.length > 0) {
    throw new Error(`Developer OpenAPI tree omitted generated files: ${missing.join(", ")}`);
  }

  report.checks.push(okCheck("developer-tree", "Developer OpenAPI tree includes every generated file."));
}

function assertContentType(file, expected) {
  if (file.contentType !== expected) {
    throw new Error(`Unexpected content type for ${file.logicalPath}: ${file.contentType}`);
  }
}

function assertSafeGeneratedText(filePath, content) {
  const forbiddenPatterns = [
    /\bS3_[A-Z0-9_]*\b/,
    /\bs3:\/\/[^\s)]+/i,
    /\/Users\/[^\s)]+/,
    /\/private\/[^\s)]+/,
    /\bbaselineRunId\b/,
    /\bderivativeRunId\b/,
    /\bsourceFile\b/
  ];

  for (const pattern of forbiddenPatterns) {
    if (pattern.test(content)) {
      throw new Error(`Generated file exposes internal implementation detail: ${filePath}`);
    }
  }
}

function okCheck(name, message) {
  return {
    name,
    ok: true,
    message
  };
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readSourceFileTimeoutMs(sampleCount) {
  const configured = process.env.FOCOWIKI_VALIDATION_TASK_TIMEOUT_MS?.trim();

  if (configured) {
    const parsed = Number(configured);

    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return Math.max(180_000, sampleCount * 60_000);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} must be set.`);
  }

  return value;
}

function writeReports(value) {
  fs.mkdirSync(CHANGE_DIR, { recursive: true });
  fs.writeFileSync(REPORT_JSON, `${JSON.stringify(value, null, 2)}\n`);
  fs.writeFileSync(REPORT_MD, renderMarkdownReport(value));
}

function renderMarkdownReport(value) {
  return `${[
    "# Generated OKF File Inspection",
    "",
    `- Result: ${value.ok ? "pass" : "fail"}`,
    `- Sample count: ${value.sampleCount}`,
    `- Knowledge base ID: ${value.knowledgeBaseId ?? "none"}`,
    `- Source file IDs: ${value.sourceFileIds.join(", ") || "none"}`,
    `- Generation ID: ${value.generationId ?? "none"}`,
    `- Model: ${value.modelName ?? "none"}`,
    "",
    "## Checks",
    "",
    ...value.checks.map((check) => `- ${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.message}`),
    "",
    "## Files",
    "",
    ...value.files.map(
      (file) =>
        `- ${file.path}: kind=${file.kind}, size=${file.sizeBytes}, checksum=${file.checksumSha256}, sourceBacked=${file.sourceBacked}`
    ),
    "",
    "## Failures",
    "",
    ...(value.failures.length ? value.failures.map((failure) => `- ${failure}`) : ["- None recorded."]),
    ""
  ].join("\n")}\n`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
