import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  buildApplicableOkfFilterVariants,
  buildComprehensiveSearchCases,
  buildComprehensiveSearchVariants,
  evaluateExpectedRerankerOutcome,
  evaluateComprehensiveSearchObservation,
  evaluateComprehensiveReturnedItems,
  parseRetryAfterMilliseconds,
  reconcileComprehensiveCurrentSourceFiles,
  retryComprehensiveSearchOperation,
  summarizeComprehensiveSearchLatencies
} from "./lib/comprehensive-search-ledger.mjs";

const reportDirectory = path.resolve(requiredEnv("FOCOWIKI_COMPREHENSIVE_REPORT_DIR"));
const openApiBaseUrl = process.env.FOCOWIKI_COMPREHENSIVE_OPENAPI_BASE_URL?.trim()
  || "http://127.0.0.1:43200";
const provider = requiredEnv("FOCOWIKI_COMPREHENSIVE_SEARCH_PROVIDER");
const authorization = loadAuthorization(
  path.resolve(requiredEnv("FOCOWIKI_COMPREHENSIVE_AUTHORIZATION_FILE"))
);
const concurrency = readInteger(
  process.env.FOCOWIKI_COMPREHENSIVE_SEARCH_CONCURRENCY,
  4,
  1,
  20
);
const reportPath = path.resolve(
  process.env.FOCOWIKI_COMPREHENSIVE_SEARCH_REPORT?.trim()
    || path.join(reportDirectory, `search-provider-${provider}-per-file.json`)
);
const manifest = readJson(path.join(reportDirectory, "corpus-manifest.json"));
const workspace = readJson(path.join(reportDirectory, "corpus-workspace-private.json"));
const corpus = readJson(path.join(reportDirectory, "corpus-e2e.json"));
const lifecycleSummaryPath = path.join(reportDirectory, "comprehensive-crud-summary.json");
const lifecycleStatePath = path.join(
  reportDirectory,
  "comprehensive-crud-execution-private.json"
);
if (fs.existsSync(lifecycleSummaryPath) !== fs.existsSync(lifecycleStatePath)) {
  throw new Error("Comprehensive search CRUD lifecycle evidence is incomplete");
}
const knowledgeBases = Object.fromEntries(
  Object.entries(corpus.knowledgeBases).map(([family, value]) => [family, value.id])
);
const corpusFiles = fs.existsSync(lifecycleSummaryPath)
  ? reconcileComprehensiveCurrentSourceFiles({
      corpusFiles: corpus.files,
      knowledgeBases,
      lifecycleSummary: readJson(lifecycleSummaryPath),
      lifecycleState: readJson(lifecycleStatePath)
    })
  : corpus.files;
const workspaceFiles = workspace.files.map((file) => ({
  ...file,
  contents: fs.readFileSync(file.stagedPath, "utf8")
}));
const searchCases = buildComprehensiveSearchCases({
  manifestRows: manifest.rows,
  workspaceFiles,
  corpusFiles,
  knowledgeBases
});
const variants = Object.freeze(buildComprehensiveSearchVariants());
const sourceReadPromiseById = new Map();
const report = {
  format: "focowiki-comprehensive-search-provider-e2e-v1",
  provider,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  corpus: {
    expectedFileCount: 200,
    observedFileCount: searchCases.length,
    manifestSha256: sha256(fs.readFileSync(path.join(reportDirectory, "corpus-manifest.json"))),
    crudLifecycleReconciled: fs.existsSync(lifecycleSummaryPath),
    crudLifecycleStateSha256: fs.existsSync(lifecycleStatePath)
      ? sha256(fs.readFileSync(lifecycleStatePath))
      : null
  },
  variants: variants.map((variant) => ({
    id: variant.id,
    queryField: variant.queryField,
    parameters: variant.parameters
  })),
  counts: {
    expectedFiles: searchCases.length,
    completedFiles: 0,
    expectedQueries: searchCases.length * variants.length,
    completedQueries: 0,
    successfulQueries: 0,
    rerankerAppliedQueries: 0,
    rerankerSafeDegradedQueries: 0,
    sourceReads: 0,
    returnedItems: 0,
    returnedItemsWithSourceReads: 0,
    uniqueReturnedSourcesRead: 0,
    failures: 0,
    expectedFilterDispositions: searchCases.length * 3,
    completedFilterDispositions: 0
  },
  latencyMs: null,
  sourceReadEvidence: {},
  rows: [],
  failures: []
};

assert(searchCases.length === 200, "Comprehensive search run requires exactly 200 files");
writePrivateReport(reportPath, report);

await mapWithConcurrency(searchCases, concurrency, async (searchCase) => {
  const row = {
    alias: searchCase.alias,
    family: searchCase.family,
    knowledgeBaseId: searchCase.knowledgeBaseId,
    sourceFileId: searchCase.sourceFileId,
    sourcePath: searchCase.sourcePath,
    expectedGeneratedPath: searchCase.expectedGeneratedPath,
    sourceChecksumSha256: searchCase.checksumSha256,
    queries: [],
    filterDispositions: [],
    sourceRead: null,
    ok: false
  };
  let exactPathObservation = null;
  for (const variant of variants) {
    const observation = await executeVariant(row, searchCase, variant);
    if (variant.id === "exact_path_file") exactPathObservation = observation;
  }
  const filters = buildApplicableOkfFilterVariants(exactPathObservation?.okfSignals ?? null);
  row.filterDispositions = filters.dispositions;
  report.counts.completedFilterDispositions += filters.dispositions.length;
  report.counts.expectedQueries += filters.variants.length;
  for (const variant of filters.variants) {
    await executeVariant(row, searchCase, variant);
  }
  try {
    const exactPath = row.queries.find((query) => query.variant === "exact_path_file");
    if (!exactPath?.found) throw new Error("Exact path result is unavailable for source read");
    const [byId, byPath] = await Promise.all([
      readContent(exactPath.fileContentById),
      readContent(exactPath.fileContentByPath)
    ]);
    row.sourceRead = {
      byId,
      byPath,
      matched: byId.sha256 === byPath.sha256 && byId.byteCount === byPath.byteCount
    };
    report.counts.sourceReads += 2;
    if (!row.sourceRead.matched) {
      recordFailure({
        alias: searchCase.alias,
        variant: "source_read",
        code: "source_read_mismatch"
      });
    }
  } catch (error) {
    row.sourceRead = { error: safeError(error), matched: false };
    recordFailure({
      alias: searchCase.alias,
      variant: "source_read",
      code: "source_read_failed",
      detail: safeError(error)
    });
  }
  row.ok = row.queries.length === variants.length + filters.variants.length
    && row.queries.every((query) =>
      query.found === true
        && query.pathMatched === true
        && query.modeMatches === true
        && query.scopeMatches === true
        && query.rerankerMatches === true
        && query.returnedItems?.length === query.resultCount
        && query.returnedItems.every((item) => item.sourceReadMatched === true)
    )
    && row.filterDispositions.length === 3
    && row.sourceRead?.matched === true;
  report.rows.push(row);
  report.counts.completedFiles += 1;
  report.rows.sort((left, right) => left.alias.localeCompare(right.alias, "en"));
  writePrivateReport(reportPath, report);
  process.stdout.write(
    `search-provider ${provider}: ${report.counts.completedFiles}/${report.counts.expectedFiles}\n`
  );
});

const latencyValues = report.rows.flatMap((row) =>
  row.queries.map((query) => query.latencyMs).filter(Number.isFinite)
);
report.latencyMs = summarizeComprehensiveSearchLatencies(latencyValues);
report.finishedAt = new Date().toISOString();
report.counts.failures = report.failures.length;
report.ok = report.counts.completedFiles === report.counts.expectedFiles
  && report.counts.completedQueries === report.counts.expectedQueries
  && report.counts.successfulQueries === report.counts.expectedQueries
  && report.counts.completedFilterDispositions === report.counts.expectedFilterDispositions
  && report.counts.sourceReads === report.counts.expectedFiles * 2
  && report.counts.returnedItems > 0
  && report.counts.returnedItemsWithSourceReads === report.counts.returnedItems
  && report.counts.uniqueReturnedSourcesRead === report.counts.expectedFiles
  && report.rows.every((row) => row.ok)
  && report.failures.length === 0;
writePrivateReport(reportPath, report);
if (!report.ok) {
  throw new Error(
    `Comprehensive ${provider} search provider run failed with ${report.failures.length} failures`
  );
}

async function executeVariant(row, searchCase, variant) {
  const query = searchCase.queries[variant.queryField];
  try {
    const result = await search(searchCase, query, variant.parameters);
    const observation = evaluateComprehensiveSearchObservation({
      expected: searchCase,
      response: result.body
    });
    const sourceReads = new Map(await Promise.all(result.body.items.map(async (item) => [
      item.sourceFileId,
      await readReturnedSource(item, searchCase.knowledgeBaseId)
    ])));
    const returnedItems = evaluateComprehensiveReturnedItems({
      knowledgeBaseId: searchCase.knowledgeBaseId,
      items: result.body.items,
      sourceReads
    });
    const modeMatches = expectedMode(variant.parameters) === observation.searchMode;
    const scopeMatches = !variant.parameters.scope
      || observation.queryContext?.scope === variant.parameters.scope;
    const rerankerOutcome = evaluateExpectedRerankerOutcome({
      requested: variant.parameters.rerank === "true",
      status: observation.rerankerStatus
    });
    const rerankerMatches = rerankerOutcome.matched;
    const queryRow = {
      variant: variant.id,
      query,
      querySha256: sha256(query),
      qrels: searchCase.qrels[variant.queryField],
      parameters: variant.parameters,
      status: result.status,
      latencyMs: result.latencyMs,
      resultCount: result.body.items.length,
      returnedSourceFileIds: result.body.items.map((item) => item.sourceFileId),
      returnedItems,
      nextCursorProvided: typeof result.body.nextCursor === "string",
      nextCursorSha256: typeof result.body.nextCursor === "string"
        ? sha256(result.body.nextCursor)
        : null,
      found: observation.found,
      rank: observation.rank,
      pathMatched: observation.pathMatched,
      modeMatches,
      scopeMatches,
      rerankerMatches,
      rerankerOutcome: rerankerOutcome.outcome,
      rerankerExternalClassification: rerankerOutcome.externalClassification,
      searchMode: observation.searchMode,
      semanticStatus: observation.semanticStatus,
      evidenceStatus: observation.evidenceStatus,
      rerankerStatus: observation.rerankerStatus,
      graphStatus: observation.graphStatus,
      fileContentById: observation.fileContentById,
      fileContentByPath: observation.fileContentByPath
    };
    row.queries.push(queryRow);
    report.counts.returnedItems += returnedItems.length;
    report.counts.returnedItemsWithSourceReads += returnedItems.filter((item) =>
      item.sourceReadMatched === true).length;
    report.counts.completedQueries += 1;
    if (rerankerOutcome.outcome === "applied") {
      report.counts.rerankerAppliedQueries += 1;
    } else if (rerankerOutcome.outcome === "safe_degraded") {
      report.counts.rerankerSafeDegradedQueries += 1;
    }
    if (observation.found && observation.pathMatched && modeMatches && scopeMatches && rerankerMatches) {
      report.counts.successfulQueries += 1;
    } else {
      recordFailure({
        alias: searchCase.alias,
        variant: variant.id,
        code: !observation.found
          ? "expected_source_missing"
          : !observation.pathMatched
            ? "path_mismatch"
            : !modeMatches
              ? "mode_mismatch"
              : !scopeMatches
                ? "scope_mismatch"
                : "reranker_not_applied"
      });
    }
    return observation;
  } catch (error) {
    report.counts.completedQueries += 1;
    row.queries.push({
      variant: variant.id,
      query,
      querySha256: sha256(query),
      qrels: searchCase.qrels[variant.queryField],
      parameters: variant.parameters,
      error: safeError(error)
    });
    recordFailure({
      alias: searchCase.alias,
      variant: variant.id,
      code: "query_failed",
      detail: safeError(error)
    });
    return null;
  }
}

function expectedMode(parameters) {
  return parameters.mode ?? "hybrid";
}

async function search(searchCase, query, parameters) {
  const pathname = `/openapi/v2/knowledge-bases/${encodeURIComponent(
    searchCase.knowledgeBaseId
  )}/files/search`;
  const url = new URL(pathname, `${openApiBaseUrl}/`);
  url.search = new URLSearchParams({ query, ...parameters }).toString();
  return requestJson(url);
}

async function requestJson(url) {
  return retryComprehensiveSearchOperation(async () => {
    const startedAt = performance.now();
    const response = await fetch(url, { headers: { authorization } });
    const text = await response.text();
    const latencyMs = round(performance.now() - startedAt);
    if (!response.ok) {
      const error = new Error(`OpenAPI returned HTTP ${response.status}`);
      error.status = response.status;
      error.retryAfterMs = parseRetryAfterMilliseconds(response.headers.get("retry-after"));
      throw error;
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("OpenAPI returned invalid JSON");
    }
    return { status: response.status, latencyMs, body };
  });
}

async function readContent(pathname) {
  return retryComprehensiveSearchOperation(async () => {
    const startedAt = performance.now();
    const response = await fetch(new URL(pathname, `${openApiBaseUrl}/`), {
      headers: { authorization }
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`OpenAPI source read returned HTTP ${response.status}`);
      error.status = response.status;
      error.retryAfterMs = parseRetryAfterMilliseconds(response.headers.get("retry-after"));
      throw error;
    }
    const contentType = response.headers.get("content-type") ?? "";
    let contents = text;
    if (contentType.includes("application/json")) {
      const parsed = JSON.parse(text);
      if (typeof parsed.content !== "string") {
        throw new Error("OpenAPI source read omitted content");
      }
      contents = parsed.content;
    }
    return {
      status: response.status,
      byteCount: Buffer.byteLength(contents),
      sha256: sha256(contents),
      latencyMs: round(performance.now() - startedAt)
    };
  });
}

async function readReturnedSource(item, knowledgeBaseId) {
  if (item?.knowledgeBaseId !== knowledgeBaseId || typeof item?.sourceFileId !== "string") {
    throw new Error("Search result source ownership is invalid");
  }
  const byIdPath = item.readActions?.fileContentById;
  const byPathPath = item.readActions?.fileContentByPath;
  if (typeof byIdPath !== "string" || typeof byPathPath !== "string") {
    throw new Error("Search result source read actions are unavailable");
  }
  const readActionsSha256 = sha256(JSON.stringify({ byIdPath, byPathPath }));
  const existing = sourceReadPromiseById.get(item.sourceFileId);
  if (existing) {
    if (existing.readActionsSha256 !== readActionsSha256) {
      throw new Error("Search result source read actions changed within one run");
    }
    return existing.promise;
  }
  const promise = Promise.all([
    readContent(byIdPath),
    readContent(byPathPath)
  ]).then(([byId, byPath]) => {
    const evidence = {
      id: item.sourceFileId,
      readActionsSha256,
      byId,
      byPath,
      matched: byId.sha256 === byPath.sha256 && byId.byteCount === byPath.byteCount
    };
    if (!evidence.matched) {
      throw new Error("Search result source read actions returned different Markdown content");
    }
    report.sourceReadEvidence[item.sourceFileId] = evidence;
    report.counts.uniqueReturnedSourcesRead = Object.keys(report.sourceReadEvidence).length;
    return evidence;
  });
  sourceReadPromiseById.set(item.sourceFileId, { readActionsSha256, promise });
  return promise;
}

async function mapWithConcurrency(values, limit, operation) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      await operation(values[index]);
    }
  });
  await Promise.all(workers);
}

function recordFailure(value) {
  report.failures.push(value);
  report.counts.failures = report.failures.length;
}

function writePrivateReport(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function loadAuthorization(filePath) {
  const contents = fs.readFileSync(filePath, "utf8").trim();
  const header = contents.match(/^Authorization:\s+(Bearer\s+\S+)$/iu)?.[1]
    ?? (/^Bearer\s+\S+$/iu.test(contents) ? contents : `Bearer ${contents}`);
  if (!/^Bearer\s+\S+$/iu.test(header)) {
    throw new Error("Authorization file must contain one API key or Bearer header");
  }
  return header;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readInteger(value, fallback, minimum, maximum) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("Comprehensive search concurrency is invalid");
  }
  return parsed;
}

function safeError(error) {
  return error instanceof Error ? error.message : "Unknown validation error";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
