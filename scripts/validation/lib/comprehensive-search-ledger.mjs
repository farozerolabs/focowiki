import { createHash } from "node:crypto";

const FORBIDDEN_BODY_FIELDS = Object.freeze(["body", "content", "markdown"]);
const LEXICAL_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "after", "be", "by", "for", "from",
  "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "was",
  "were", "with"
]);
const TRANSIENT_RERANKER_SAFE_CODES = new Set([
  "RERANKER_ABORTED",
  "RERANKER_PROVIDER_UNAVAILABLE",
  "RERANKER_RATE_LIMITED",
  "RERANKER_TIMEOUT",
  "RERANKER_UNAVAILABLE"
]);
const SEARCH_MATCHED_FIELDS = new Set([
  "path", "title", "description", "metadata", "content", "file_relationship"
]);
const SEARCH_EVIDENCE_TYPES = new Set([
  "path", "title", "content", "file_relationship", "entity", "relationship", "community"
]);
const SEARCH_MATCH_TYPES = new Set([
  "file_direct", "graph_node", "graph_edge", "graph_neighbor", "hybrid"
]);

export function buildComprehensiveSearchVariants() {
  return [
    {
      id: "exact_path_file",
      queryField: "exactPath",
      parameters: { mode: "file", graphDepth: "0", limit: "20", rerank: "false" }
    },
    {
      id: "exact_title_file",
      queryField: "exactTitle",
      parameters: { mode: "file", graphDepth: "0", limit: "20", rerank: "false" }
    },
    {
      id: "lexical_file",
      queryField: "lexical",
      parameters: { mode: "file", graphDepth: "0", limit: "20", rerank: "false" }
    },
    {
      id: "natural_sentence_hybrid",
      queryField: "naturalSentence",
      parameters: { mode: "hybrid", graphDepth: "2", limit: "50", rerank: "false" }
    },
    {
      id: "natural_sentence_hybrid_omitted",
      queryField: "naturalSentence",
      parameters: { graphDepth: "2", limit: "50", rerank: "false" }
    },
    {
      id: "exact_title_graph",
      queryField: "exactTitle",
      parameters: { mode: "graph", graphDepth: "2", limit: "50", rerank: "false" }
    },
    {
      id: "exact_path_scope_path",
      queryField: "exactPath",
      parameters: { scope: "path", mode: "file", graphDepth: "0", limit: "20", rerank: "false" }
    },
    {
      id: "exact_title_scope_metadata",
      queryField: "exactTitle",
      parameters: { scope: "metadata", mode: "file", graphDepth: "0", limit: "20", rerank: "false" }
    },
    {
      id: "natural_sentence_hybrid_reranked",
      queryField: "naturalSentence",
      parameters: {
        mode: "hybrid",
        graphDepth: "2",
        limit: "50",
        rerank: "true",
        rerankTopK: "50",
        rerankScoreThreshold: "0"
      }
    }
  ];
}

export function reconcileComprehensiveCurrentSourceFiles(input) {
  const corpusFiles = requireRecord(input?.corpusFiles, "corpus files");
  const knowledgeBases = requireRecord(input?.knowledgeBases, "knowledge bases");
  const summary = requireRecord(input?.lifecycleSummary, "CRUD lifecycle summary");
  const lifecycle = requireRecord(input?.lifecycleState, "CRUD lifecycle state");
  if (
    summary.kind !== "focowiki-comprehensive-crud-summary"
    || summary.version !== 1
    || summary.ok !== true
    || summary.complete !== true
    || summary.planned?.files !== Object.keys(corpusFiles).length
  ) {
    throw new Error("Comprehensive search CRUD lifecycle summary is incomplete");
  }
  if (
    lifecycle.kind !== "focowiki-comprehensive-crud-execution-state"
    || lifecycle.version !== 1
  ) {
    throw new Error("Comprehensive search CRUD lifecycle state is invalid");
  }
  const currentFiles = requireRecord(lifecycle.files, "CRUD lifecycle files");
  const aliases = Object.keys(corpusFiles).sort((left, right) =>
    left.localeCompare(right, "en"));
  const currentAliases = Object.keys(currentFiles).sort((left, right) =>
    left.localeCompare(right, "en"));
  if (JSON.stringify(aliases) !== JSON.stringify(currentAliases)) {
    throw new Error("Comprehensive search CRUD lifecycle aliases do not match");
  }
  const sourceFileIds = new Set();
  return Object.fromEntries(aliases.map((alias) => {
    const corpus = requireRecord(corpusFiles[alias], `corpus file ${alias}`);
    const current = requireRecord(currentFiles[alias], `CRUD lifecycle file ${alias}`);
    const family = requireString(corpus.family, `corpus family ${alias}`);
    if (current.knowledgeBaseId !== knowledgeBases[family]) {
      throw new Error(`Comprehensive search CRUD knowledge base does not match: ${alias}`);
    }
    if (current.state !== "visible") {
      throw new Error(`Comprehensive search CRUD source is not visible: ${alias}`);
    }
    const originalPath = requireString(
      current.originalRelativePath,
      `CRUD original path ${alias}`
    );
    if (current.currentRelativePath !== originalPath) {
      throw new Error(`Comprehensive search CRUD path does not match: ${alias}`);
    }
    const sourceFileId = requireString(
      current.sourceFileId,
      `current source file ID ${alias}`
    );
    if (sourceFileIds.has(sourceFileId)) {
      throw new Error(`Comprehensive search CRUD source ownership is duplicated: ${alias}`);
    }
    sourceFileIds.add(sourceFileId);
    return [alias, { ...corpus, sourceFileId }];
  }));
}

export function evaluateExpectedRerankerOutcome(input) {
  const state = input?.status?.state;
  const safeCode = input?.status?.safeCode ?? null;
  if (input?.requested !== true) {
    const matched = state === "skipped" && safeCode === "RERANKER_DISABLED";
    return {
      matched,
      outcome: matched ? "disabled" : "unexpected",
      externalClassification: null
    };
  }
  if (state === "applied" && safeCode === null) {
    return { matched: true, outcome: "applied", externalClassification: null };
  }
  if (state === "degraded" && TRANSIENT_RERANKER_SAFE_CODES.has(safeCode)) {
    return {
      matched: true,
      outcome: "safe_degraded",
      externalClassification: "transient_external_dependency"
    };
  }
  return { matched: false, outcome: "unexpected", externalClassification: null };
}

export function reconcileComprehensiveSearchProviderReport(input) {
  if (
    !input || input.format !== "focowiki-comprehensive-search-provider-e2e-v1"
    || !Array.isArray(input.rows) || !Array.isArray(input.failures)
    || !input.counts || typeof input.provider !== "string"
  ) {
    throw new Error("Comprehensive search provider report is invalid");
  }
  const originalSha256 = sha256(JSON.stringify(input));
  const report = structuredClone(input);
  const failures = [];
  let successfulQueries = 0;
  let completedQueries = 0;
  let sourceReads = 0;
  let rerankerAppliedQueries = 0;
  let rerankerSafeDegradedQueries = 0;
  let completedFilterDispositions = 0;
  for (const row of report.rows) {
    if (!Array.isArray(row.queries) || !Array.isArray(row.filterDispositions)) {
      throw new Error("Comprehensive search provider row is invalid");
    }
    for (const query of row.queries) {
      completedQueries += 1;
      if (query.error) {
        failures.push({
          alias: row.alias,
          variant: query.variant,
          code: "query_failed",
          detail: query.error
        });
        continue;
      }
      const outcome = evaluateExpectedRerankerOutcome({
        requested: query.parameters?.rerank === "true",
        status: query.rerankerStatus
      });
      query.rerankerMatches = outcome.matched;
      query.rerankerOutcome = outcome.outcome;
      query.rerankerExternalClassification = outcome.externalClassification;
      if (outcome.outcome === "applied") rerankerAppliedQueries += 1;
      if (outcome.outcome === "safe_degraded") rerankerSafeDegradedQueries += 1;
      const code = query.found !== true
        ? "expected_source_missing"
        : query.pathMatched !== true
          ? "path_mismatch"
          : query.modeMatches !== true
            ? "mode_mismatch"
            : query.scopeMatches !== true
              ? "scope_mismatch"
              : outcome.matched !== true
                ? "reranker_not_applied"
                : null;
      if (code) {
        failures.push({ alias: row.alias, variant: query.variant, code });
      } else {
        successfulQueries += 1;
      }
    }
    completedFilterDispositions += row.filterDispositions.length;
    if (row.sourceRead?.matched === true) {
      sourceReads += 2;
    } else {
      failures.push({ alias: row.alias, variant: "source_read", code: "source_read_failed" });
    }
    row.ok = row.queries.every((query) =>
      !query.error
        && query.found === true
        && query.pathMatched === true
        && query.modeMatches === true
        && query.scopeMatches === true
        && query.rerankerMatches === true)
      && row.filterDispositions.length === 3
      && row.sourceRead?.matched === true;
  }
  report.failures = failures;
  report.counts = {
    ...report.counts,
    completedFiles: report.rows.length,
    completedQueries,
    successfulQueries,
    sourceReads,
    failures: failures.length,
    completedFilterDispositions,
    rerankerAppliedQueries,
    rerankerSafeDegradedQueries
  };
  report.ok = report.counts.completedFiles === report.counts.expectedFiles
    && report.counts.completedQueries === report.counts.expectedQueries
    && report.counts.successfulQueries === report.counts.expectedQueries
    && report.counts.completedFilterDispositions
      === report.counts.expectedFilterDispositions
    && report.counts.sourceReads === report.counts.expectedFiles * 2
    && report.rows.every((row) => row.ok)
    && failures.length === 0;
  report.reconciliation = {
    originalReportSha256: originalSha256,
    originalOk: input.ok === true,
    originalFailureCount: input.failures.length,
    policy: "grounded retrieval with explicit transient reranker degradation"
  };
  return report;
}

export function buildApplicableOkfFilterVariants(signals) {
  const variants = [];
  const dispositions = [];
  const status = signals?.effectiveStatus;
  if (["draft", "stable", "deprecated"].includes(status)) {
    variants.push(filterVariant("filter_okf_status", "okfStatus", status));
    dispositions.push({ field: "okfStatus", status: "applicable", value: status });
  } else {
    dispositions.push({ field: "okfStatus", status: "not_applicable", reason: "missing_valid_signal" });
  }
  const trustTier = signals?.trustTier;
  if (["unverified", "machine-confirmed", "human-reviewed"].includes(trustTier)) {
    variants.push(filterVariant("filter_okf_trust_tier", "okfTrustTier", trustTier));
    dispositions.push({ field: "okfTrustTier", status: "applicable", value: trustTier });
  } else {
    dispositions.push({ field: "okfTrustTier", status: "not_applicable", reason: "missing_valid_signal" });
  }
  if (typeof signals?.isStale === "boolean" && typeof signals?.staleAfter === "string") {
    const freshness = signals.isStale ? "stale" : "fresh";
    variants.push(filterVariant("filter_okf_freshness", "okfFreshness", freshness));
    dispositions.push({ field: "okfFreshness", status: "applicable", value: freshness });
  } else {
    dispositions.push({ field: "okfFreshness", status: "not_applicable", reason: "missing_valid_signal" });
  }
  return { variants, dispositions };
}

function filterVariant(id, field, value) {
  return {
    id,
    queryField: "exactPath",
    parameters: {
      scope: "path",
      mode: "file",
      graphDepth: "0",
      limit: "20",
      rerank: "false",
      [field]: value
    }
  };
}

export function buildComprehensiveSearchCases(input) {
  const manifestRows = requireArray(input?.manifestRows, "manifest rows");
  const workspaceFiles = requireArray(input?.workspaceFiles, "workspace files");
  const corpusFiles = requireRecord(input?.corpusFiles, "corpus files");
  const knowledgeBases = requireRecord(input?.knowledgeBases, "knowledge bases");
  const workspaceByPathHash = new Map();

  for (const file of workspaceFiles) {
    const sourcePath = requireString(file?.path, "workspace path").normalize("NFC");
    const pathSegments = sourcePath.split("/");
    const familyRelativePath = pathSegments.length > 1
      ? pathSegments.slice(1).join("/")
      : sourcePath;
    const pathHash = sha256(familyRelativePath);
    if (workspaceByPathHash.has(pathHash)) {
      throw new Error(`Comprehensive search ledger has a duplicate workspace path: ${sourcePath}`);
    }
    workspaceByPathHash.set(pathHash, { ...file, path: sourcePath });
  }

  const seenAliases = new Set();
  const seenSourceFileIds = new Set();
  const rows = manifestRows.map((manifest) => {
    const alias = requireString(manifest?.alias, "manifest alias");
    if (seenAliases.has(alias)) {
      throw new Error(`Comprehensive search ledger has a duplicate alias: ${alias}`);
    }
    seenAliases.add(alias);
    const family = requireString(manifest?.family, "manifest family");
    const workspace = workspaceByPathHash.get(
      requireSha256(manifest?.pathHash, "manifest path hash")
    );
    if (!workspace) throw new Error(`Comprehensive search ledger is missing workspace file: ${alias}`);
    const corpus = corpusFiles[alias];
    if (!corpus) throw new Error(`Comprehensive search ledger is missing corpus file: ${alias}`);
    if (corpus.family !== family) {
      throw new Error(`Comprehensive search ledger family does not match: ${alias}`);
    }
    const sourceFileId = requireString(corpus.sourceFileId, "source file ID");
    if (seenSourceFileIds.has(sourceFileId)) {
      throw new Error(`Comprehensive search ledger has duplicate source ownership: ${sourceFileId}`);
    }
    seenSourceFileIds.add(sourceFileId);
    const knowledgeBaseId = requireString(
      knowledgeBases[family],
      `knowledge base for ${family}`
    );
    const checksumSha256 = requireSha256(
      manifest?.checksumSha256,
      "manifest checksum"
    );
    if (workspace.checksumSha256 !== checksumSha256) {
      throw new Error(`Comprehensive search ledger checksum does not match: ${alias}`);
    }
    const contents = requireString(workspace.contents, "workspace contents");
    const title = extractTitle(contents, workspace.path);
    const extractedSentence = extractNaturalSentence(contents, title);
    const naturalSentence = topicBoundNaturalSentence(title, extractedSentence);
    return {
      alias,
      family,
      knowledgeBaseId,
      sourceFileId,
      sourcePath: workspace.path,
      expectedGeneratedPath: `pages/${workspace.path}`,
      stagedPath: requireString(workspace.stagedPath, "workspace staged path"),
      checksumSha256,
      queries: {
        exactPath: `pages/${workspace.path}`,
        exactTitle: title,
        lexical: lexicalQuery(title, naturalSentence),
        naturalSentence
      },
      qrels: {
        exactPath: [{ sourceFileId, relevance: 3 }],
        exactTitle: [{ sourceFileId, relevance: 3 }],
        lexical: [{ sourceFileId, relevance: 3 }],
        naturalSentence: [{ sourceFileId, relevance: 3 }]
      }
    };
  });

  if (workspaceByPathHash.size !== rows.length) {
    throw new Error("Comprehensive search ledger has unmatched workspace files");
  }
  if (Object.keys(corpusFiles).length !== rows.length) {
    throw new Error("Comprehensive search ledger has unmatched corpus files");
  }
  return rows;
}

export function evaluateComprehensiveSearchObservation(input) {
  const expected = requireRecord(input?.expected, "expected search row");
  const response = requireRecord(input?.response, "search response");
  const items = requireArray(response.items, "search response items");
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Comprehensive search response contains an invalid item");
    }
    if (FORBIDDEN_BODY_FIELDS.some((field) => field in item)) {
      throw new Error("Comprehensive search response embedded original body content");
    }
    if (item.knowledgeBaseId !== expected.knowledgeBaseId) {
      throw new Error("Comprehensive search response crossed knowledge-base scope");
    }
  }
  const rankIndex = items.findIndex((item) => item.sourceFileId === expected.sourceFileId);
  if (rankIndex < 0) {
    return {
      found: false,
      rank: null,
      pathMatched: false,
      searchResponseContainedOriginalBody: false,
      fileContentById: null,
      fileContentByPath: null,
      semanticStatus: response.semanticStatus ?? null,
      evidenceStatus: response.evidenceStatus ?? null,
      rerankerStatus: response.rerankerStatus ?? null,
      searchMode: response.searchMode ?? null,
      queryContext: response.query ?? null,
      graphStatus: response.graphStatus ?? null,
      okfSignals: null
    };
  }
  const item = items[rankIndex];
  if (item.contentAvailable !== true) {
    throw new Error("Comprehensive search result does not expose readable source evidence");
  }
  const readActions = requireRecord(item.readActions, "search result read actions");
  return {
    found: true,
    rank: rankIndex + 1,
    pathMatched: item.path === expected.expectedGeneratedPath,
    searchResponseContainedOriginalBody: false,
    fileContentById: requireString(readActions.fileContentById, "fileContentById"),
    fileContentByPath: requireString(readActions.fileContentByPath, "fileContentByPath"),
    semanticStatus: response.semanticStatus ?? null,
    evidenceStatus: response.evidenceStatus ?? null,
    rerankerStatus: response.rerankerStatus ?? null,
    searchMode: response.searchMode ?? null,
    queryContext: response.query ?? null,
    graphStatus: response.graphStatus ?? null,
    okfSignals: item.okfSignals ?? null
  };
}

export function evaluateComprehensiveReturnedItems(input) {
  const knowledgeBaseId = requireString(input?.knowledgeBaseId, "knowledge base ID");
  const items = requireArray(input?.items, "search response items");
  const sourceReads = input?.sourceReads;
  if (!(sourceReads instanceof Map)) {
    throw new Error("Comprehensive search source reads must be a map");
  }
  const seenSourceFileIds = new Set();
  return items.map((item, index) => {
    const record = requireRecord(item, "search response item");
    if (FORBIDDEN_BODY_FIELDS.some((field) => field in record)) {
      throw new Error("Comprehensive search response embedded original body content");
    }
    if (record.knowledgeBaseId !== knowledgeBaseId) {
      throw new Error("Comprehensive search response crossed knowledge-base scope");
    }
    const sourceFileId = requireString(record.sourceFileId, "source file ID");
    if (seenSourceFileIds.has(sourceFileId)) {
      throw new Error("Comprehensive search response returned a duplicate source file");
    }
    seenSourceFileIds.add(sourceFileId);
    const resultPath = requireString(record.path, "result path");
    if (record.generatedFilePath !== resultPath) {
      throw new Error("Comprehensive search result path aliases do not match");
    }
    if (record.contentAvailable !== true) {
      throw new Error("Comprehensive search result does not expose readable source evidence");
    }
    const readActions = requireRecord(record.readActions, "search result read actions");
    requireString(readActions.fileContentById, "fileContentById");
    requireString(readActions.fileContentByPath, "fileContentByPath");
    const matchedFields = validateStringEnumArray(
      record.matchedFields,
      SEARCH_MATCHED_FIELDS,
      "matched fields"
    );
    const evidenceTypes = validateStringEnumArray(
      record.evidenceTypes,
      SEARCH_EVIDENCE_TYPES,
      "evidence types"
    );
    if (!SEARCH_MATCH_TYPES.has(record.matchType)) {
      throw new Error("Comprehensive search result match type is invalid");
    }
    const sourceRead = sourceReads.get(sourceFileId);
    if (
      !sourceRead || sourceRead.matched !== true
      || sourceRead.byId?.status !== 200 || sourceRead.byPath?.status !== 200
      || sourceRead.byId.sha256 !== sourceRead.byPath.sha256
      || sourceRead.byId.byteCount !== sourceRead.byPath.byteCount
    ) {
      throw new Error(`Comprehensive search source read evidence is incomplete: ${sourceFileId}`);
    }
    return {
      rank: index + 1,
      sourceFileId,
      path: resultPath,
      matchedFields,
      evidenceTypes,
      matchType: record.matchType,
      contentAvailable: true,
      sourceReadEvidenceId: sourceFileId,
      sourceReadMatched: true
    };
  });
}

export function summarizeComprehensiveSearchLatencies(values) {
  const sorted = requireArray(values, "latencies").map((value) => {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("Comprehensive search latency is invalid");
    }
    return value;
  }).sort((left, right) => left - right);
  if (sorted.length === 0) throw new Error("Comprehensive search latencies are empty");
  const mean = sorted.reduce((total, value) => total + value, 0) / sorted.length;
  return {
    count: sorted.length,
    minimumMs: sorted[0],
    p50Ms: percentile(sorted, 0.5),
    p90Ms: percentile(sorted, 0.9),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maximumMs: sorted.at(-1),
    meanMs: mean
  };
}

export function parseRetryAfterMilliseconds(value, now = Date.now()) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return boundedRetryDelay(seconds * 1_000);
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return null;
  return boundedRetryDelay(timestamp - now);
}

export async function retryComprehensiveSearchOperation(operation, options = {}) {
  if (typeof operation !== "function") {
    throw new Error("Comprehensive search retry operation is invalid");
  }
  const maximumAttempts = options.maximumAttempts ?? 8;
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 12) {
    throw new Error("Comprehensive search retry attempt limit is invalid");
  }
  const sleep = options.sleep ?? ((milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let lastError;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === maximumAttempts || !isRetryableSearchError(error)) break;
      const delay = error?.status === 429
        ? boundedRetryDelay(error.retryAfterMs ?? 1_000)
        : Math.min(2_000, attempt * 250);
      await sleep(delay);
    }
  }
  throw lastError;
}

function isRetryableSearchError(error) {
  return error?.status === 429 || Number(error?.status) >= 500
    || error?.name === "TypeError";
}

function boundedRetryDelay(value) {
  if (!Number.isFinite(value)) return 1_000;
  return Math.min(60_000, Math.max(100, Math.ceil(value)));
}

function extractTitle(contents, sourcePath) {
  const frontmatter = contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1] ?? "";
  const frontmatterTitle = frontmatter.match(/^title:\s*(.+?)\s*$/imu)?.[1];
  if (frontmatterTitle) return stripQuotes(frontmatterTitle.trim());
  const body = removeFrontmatter(contents);
  const heading = body.match(/^#\s+(.+?)\s*$/mu)?.[1];
  if (heading) return cleanMarkdown(heading);
  const basename = sourcePath.split("/").at(-1)?.replace(/\.md$/iu, "") ?? "";
  return requireString(basename, "derived title");
}

function extractNaturalSentence(contents, fallback) {
  const body = removeFrontmatter(contents);
  const lines = body.split(/\r?\n/u)
    .filter((line) => !/^\s*#{1,6}\s/u.test(line))
    .map((line) => cleanMarkdown(line))
    .filter((line) => line && !/^[-*+|>`]/u.test(line));
  const candidate = lines.find(Boolean) ?? fallback;
  const sentence = candidate.match(/^(.{1,240}?[.!?。！？])(?:\s|$)/u)?.[1]
    ?? candidate.slice(0, 240).trim();
  return sentence || fallback;
}

function lexicalQuery(title, sentence) {
  const tokens = `${title} ${sentence}`.match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];
  const unique = [];
  const seen = new Set();
  for (const token of tokens) {
    const key = token.toLocaleLowerCase("en");
    if (LEXICAL_STOP_WORDS.has(key) || seen.has(key)) continue;
    seen.add(key);
    unique.push(token);
    if (unique.length === 6) break;
  }
  return unique.join(" ") || title;
}

function topicBoundNaturalSentence(title, sentence) {
  if (sentence.toLocaleLowerCase("en").includes(title.toLocaleLowerCase("en"))) {
    return sentence;
  }
  const separator = /[\p{Script=Han}]/u.test(title) ? "：" : ": ";
  return `${title}${separator}${sentence}`;
}

function removeFrontmatter(contents) {
  return contents.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "");
}

function cleanMarkdown(value) {
  return value
    .replace(/^#{1,6}\s+/u, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[`*_~]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function percentile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function validateStringEnumArray(value, allowed, field) {
  const items = requireArray(value, field);
  if (
    new Set(items).size !== items.length
    || items.some((item) => typeof item !== "string" || !allowed.has(item))
  ) {
    throw new Error(`Comprehensive search ${field} are invalid`);
  }
  return [...items];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireArray(value, field) {
  if (!Array.isArray(value)) throw new Error(`Comprehensive search ${field} are invalid`);
  return value;
}

function requireRecord(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Comprehensive search ${field} is invalid`);
  }
  return value;
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Comprehensive search ${field} is invalid`);
  }
  return value;
}

function requireSha256(value, field) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`Comprehensive search ${field} is invalid`);
  }
  return value;
}
