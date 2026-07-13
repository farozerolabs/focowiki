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
  requiresSourceBodyComparison
} from "./lib/okf-file-contract.mjs";
import {
  readAdminSourceFileModelName,
  readAdminSourceFileId,
  readUploadSourceFileId
} from "./lib/source-file-contract.mjs";

const CHANGE_ID =
  process.env.FOCOWIKI_VALIDATION_CHANGE_ID?.trim() ||
  "validate-clean-architecture-full-system";
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
  releaseId: null,
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
  const bundleFiles = await waitForBundleFiles(admin, knowledgeBase.id, samples, readSourceFileTimeoutMs(samples.length));
  const release = await readLatestRelease(admin, knowledgeBase.id);
  report.releaseId = release.id;
  const contents = await readAllBundleContents(developer, knowledgeBase.id, bundleFiles);
  inspectBundleFiles(bundleFiles, contents, samples);
  await inspectDeveloperTree(developer, knowledgeBase.id, bundleFiles);
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
      body: options.formData ?? (options.body ? JSON.stringify(options.body) : undefined)
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
      selected.every((file) => file.processingStatus === "completed")
    ) {
      report.checks.push(okCheck("source-files-completed", "Uploaded source files reached completed processing state."));
      return selected;
    }

    const failed = selected.find((file) => file.processingStatus === "failed");
    if (failed) {
      throw new Error(`Source file processing failed: ${failed.relativePath} (${failed.processingErrorCode ?? "unknown"})`);
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
    if (file.processingStatus !== "completed") {
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

async function readLatestRelease(admin, knowledgeBaseId) {
  const body = await admin.json(`/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/releases?limit=1`);
  const release = body.items?.[0];

  if (!release?.id) {
    throw new Error("No active release was published after upload.");
  }

  report.checks.push(okCheck("release", "A release was published after upload."));
  return release;
}

async function waitForBundleFiles(admin, knowledgeBaseId, samples, timeoutMs) {
  const startedAt = Date.now();
  const expectedPaths = new Set(samples.map(pagePathForSample));

  while (Date.now() - startedAt < timeoutMs) {
    const files = await listBundleFiles(admin, knowledgeBaseId, { recordCheck: false });
    const availablePaths = new Set(files.map((file) => file.logicalPath));
    const missing = [...expectedPaths].filter((logicalPath) => !availablePaths.has(logicalPath));

    if (missing.length === 0) {
      report.checks.push(okCheck("bundle-file-list", `Listed ${files.length} generated bundle files.`));
      return files;
    }

    await sleep(1000);
  }

  throw new Error(`Generated bundle did not include every uploaded page within ${timeoutMs}ms.`);
}

async function listBundleFiles(admin, knowledgeBaseId, options = {}) {
  const files = [];
  let cursor = null;

  do {
    const query = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : "?limit=100";
    const page = await admin.json(`/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/bundle-files${query}`);
    files.push(...(page.items ?? []));
    cursor = page.nextCursor;
  } while (cursor);

  if (files.length === 0) {
    throw new Error("No generated bundle files were returned.");
  }

  if (options.recordCheck !== false) {
    report.checks.push(okCheck("bundle-file-list", `Listed ${files.length} generated bundle files.`));
  }
  return files.sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
}

async function readAllBundleContents(developer, knowledgeBaseId, bundleFiles) {
  const contents = new Map();
  const concurrency = readBoundedIntegerEnvironment(
    "FOCOWIKI_VALIDATION_CONTENT_READ_CONCURRENCY",
    4,
    1,
    8
  );
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, bundleFiles.length) }, async () => {
      while (nextIndex < bundleFiles.length) {
        const file = bundleFiles[nextIndex++];
        const byId = await developer.json(
          `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/${encodeURIComponent(file.id)}/content`
        );
        const byPath = await developer.json(
          `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files/content?path=${encodeURIComponent(file.logicalPath)}`
        );

        if (byId.content !== byPath.content) {
          throw new Error(`File content mismatch between id and path reads: ${file.logicalPath}`);
        }
        if (byId.file?.fileId !== file.id || byPath.file?.fileId !== file.id) {
          throw new Error(`File identity mismatch between Admin and Developer OpenAPI: ${file.logicalPath}`);
        }

        contents.set(file.logicalPath, byId.content);
        exportGeneratedContent(file.logicalPath, byId.content);
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

function inspectBundleFiles(bundleFiles, contents, samples) {
  const byPath = new Map(bundleFiles.map((file) => [file.logicalPath, file]));
  const paths = new Set(byPath.keys());
  const expectedPaths = buildExpectedPaths(samples);
  const missing = expectedPaths.filter((pathName) => !paths.has(pathName));

  if (missing.length > 0) {
    throw new Error(`Generated bundle is missing expected paths: ${missing.join(", ")}`);
  }

  for (const file of bundleFiles) {
    const content = contents.get(file.logicalPath);

    inspectSingleFile(file, content, paths, samples);
  }

  inspectIndexes(contents, paths, expectedPaths);
  report.checks.push(okCheck("all-generated-files", "Every generated Markdown and JSON file passed structural inspection."));
}

function buildExpectedPaths(samples) {
  return [
    "_index/links.json",
    "_index/manifest.json",
    "_index/search.json",
    "index.md",
    "log.md",
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
    const rootIndexKeys = file.logicalPath === "index.md" ? Object.keys(parsed.data) : [];
    const hasValidRootVersion =
      rootIndexKeys.length === 1 &&
      rootIndexKeys[0] === "okf_version" &&
      parsed.data.okf_version === "0.1";

    if (
      (file.logicalPath === "index.md" && !hasValidRootVersion) ||
      (file.logicalPath !== "index.md" && Object.keys(parsed.data).length > 0)
    ) {
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

function inspectIndexes(contents, paths, expectedPaths) {
  const manifest = JSON.parse(contents.get("_index/manifest.json"));
  const search = JSON.parse(contents.get("_index/search.json"));
  const links = JSON.parse(contents.get("_index/links.json"));
  const manifestPaths = new Set((manifest.files ?? []).map((entry) => entry.path));
  const manifestContentPaths = expectedPaths.filter((pathName) => !pathName.startsWith("_index/"));

  for (const pathName of manifestContentPaths) {
    if (!manifestPaths.has(pathName)) {
      throw new Error(`Manifest does not include generated path: ${pathName}`);
    }
  }

  for (const entry of manifest.files ?? []) {
    if (!paths.has(entry.path)) {
      throw new Error(`Manifest references missing generated path: ${entry.path}`);
    }
  }

  for (const item of search.items ?? []) {
    if (!paths.has(item.path)) {
      throw new Error(`Search index references missing generated path: ${item.path}`);
    }
    if (!item.title) {
      throw new Error(`Search index item is missing title: ${item.path}`);
    }
  }

  for (const link of links.links ?? []) {
    if (!paths.has(link.from) || !paths.has(link.to)) {
      throw new Error(`Links index references missing generated path: ${link.from} -> ${link.to}`);
    }
  }

  report.checks.push(okCheck("json-indexes", "manifest.json, search.json, and links.json reference existing generated files."));
}

async function inspectDeveloperTree(developer, knowledgeBaseId, bundleFiles) {
  const expectedFilePaths = new Set(bundleFiles.map((file) => file.logicalPath));
  const observedFilePaths = new Set();
  const queue = [""];

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
    `- Release ID: ${value.releaseId ?? "none"}`,
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
