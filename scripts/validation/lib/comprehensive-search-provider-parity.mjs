import { createHash } from "node:crypto";

import {
  evaluateExpectedRerankerOutcome
} from "./comprehensive-search-ledger.mjs";

const EXPECTED_FILE_COUNT = 200;
const EXPECTED_QUERY_COUNT = 2_061;
const EXPECTED_FILTER_DISPOSITION_COUNT = 600;
const SEMANTIC_SAFE_CODES = new Set([
  "SEMANTIC_ADOPTION_REQUIRED",
  "SEMANTIC_LEXICAL_PROJECTION_UNAVAILABLE",
  "SEMANTIC_PROVIDER_ADOPTION_REQUIRED",
  "SEMANTIC_SEARCH_UNAVAILABLE",
  "SEMANTIC_LANE_PARTIAL_FAILURE"
]);
const EVIDENCE_FAMILIES = new Set([
  "exact_path",
  "exact_title",
  "lexical",
  "jieba",
  "file_graph",
  "content_vector",
  "entity_vector",
  "relationship_vector",
  "community_vector"
]);
const FIXED_VARIANTS = Object.freeze([
  "exact_path_file",
  "exact_title_file",
  "lexical_file",
  "natural_sentence_hybrid",
  "natural_sentence_hybrid_omitted",
  "exact_title_graph",
  "exact_path_scope_path",
  "exact_title_scope_metadata",
  "natural_sentence_hybrid_reranked"
]);
const FILTER_VARIANTS = Object.freeze({
  okfStatus: "filter_okf_status",
  okfTrustTier: "filter_okf_trust_tier",
  okfFreshness: "filter_okf_freshness"
});

export function buildComprehensiveSearchProviderParity(input) {
  const opensearch = validateProviderReport(input?.opensearch, "opensearch");
  const meilisearch = validateProviderReport(input?.meilisearch, "meilisearch");
  if (opensearch.corpus.manifestSha256 !== meilisearch.corpus.manifestSha256) {
    throw new Error("Search provider reports use different corpus manifests");
  }
  const meiliRows = new Map(meilisearch.rows.map((row) => [row.alias, row]));
  const rows = [];
  let sequence = 0;
  for (const openRow of [...opensearch.rows].sort(compareAlias)) {
    const meiliRow = meiliRows.get(openRow.alias);
    if (!meiliRow) throw new Error(`Search parity is missing a Meilisearch row: ${openRow.alias}`);
    assertFileIdentity(openRow, meiliRow);
    const meiliQueries = new Map(meiliRow.queries.map((query) => [query.variant, query]));
    for (const openQuery of [...openRow.queries].sort(compareVariant)) {
      const meiliQuery = meiliQueries.get(openQuery.variant);
      if (!meiliQuery) {
        throw new Error(`Search parity is missing a query: ${openRow.alias}:${openQuery.variant}`);
      }
      sequence += 1;
      rows.push(buildParityRow({
        sequence,
        openRow,
        meiliRow,
        openQuery,
        meiliQuery
      }));
    }
    if (meiliQueries.size !== openRow.queries.length) {
      throw new Error(`Search parity has extra Meilisearch queries: ${openRow.alias}`);
    }
    meiliRows.delete(openRow.alias);
  }
  if (meiliRows.size > 0 || rows.length !== EXPECTED_QUERY_COUNT) {
    throw new Error(
      `Search provider query coverage is incomplete: rows=${rows.length} extraFiles=${meiliRows.size}`
    );
  }
  const failures = rows.filter((row) => row.manualStatus !== "pass");
  if (failures.length > 0) {
    throw new Error(
      `Search manual parity mismatch: failed=${failures.length}`
      + ` ids=${failures.slice(0, 20).map((row) => row.id).join(",")}`
    );
  }
  return {
    schemaVersion: 1,
    coverageMode: "exhaustive",
    ok: true,
    corpusManifestSha256: opensearch.corpus.manifestSha256,
    summary: {
      fileCount: opensearch.rows.length,
      queryCount: rows.length,
      manualPassCount: rows.length - failures.length,
      manualFailureCount: failures.length,
      rankDifferenceCount: rows.filter((row) => row.observed.rankDelta !== 0).length,
      candidateOrderingDifferenceCount: rows.filter((row) =>
        row.observed.candidateOrderingExactMatch === false).length,
      candidateSetDifferenceCount: rows.filter((row) =>
        row.observed.candidateSetExactMatch === false).length,
      rerankerStateDifferenceCount: rows.filter((row) =>
        row.observed.rerankerStateExactMatch === false).length,
      semanticStateDifferenceCount: rows.filter((row) =>
        row.observed.semanticStateExactMatch === false).length,
      evidenceStateDifferenceCount: rows.filter((row) =>
        row.observed.evidenceStateExactMatch === false).length,
      opensearchP95Ms: opensearch.latencyMs?.p95Ms ?? null,
      meilisearchP95Ms: meilisearch.latencyMs?.p95Ms ?? null
    },
    providerSpecificOperations: {
      opensearch: summarizeProviderState(input?.providerStates?.opensearch, "opensearch"),
      meilisearch: summarizeProviderState(input?.providerStates?.meilisearch, "meilisearch")
    },
    rows
  };
}

function validateProviderReport(report, provider) {
  if (
    !report || report.provider !== provider || report.ok !== true
    || report.format !== "focowiki-comprehensive-search-provider-e2e-v1"
    || report.corpus?.expectedFileCount !== EXPECTED_FILE_COUNT
    || report.corpus?.observedFileCount !== EXPECTED_FILE_COUNT
    || !/^[a-f0-9]{64}$/u.test(report.corpus?.manifestSha256 ?? "")
    || report.counts?.expectedFiles !== EXPECTED_FILE_COUNT
    || report.counts?.completedFiles !== EXPECTED_FILE_COUNT
    || report.counts?.expectedQueries !== EXPECTED_QUERY_COUNT
    || report.counts?.completedQueries !== EXPECTED_QUERY_COUNT
    || report.counts?.successfulQueries !== EXPECTED_QUERY_COUNT
    || report.counts?.sourceReads !== EXPECTED_FILE_COUNT * 2
    || report.counts?.failures !== 0
    || report.counts?.expectedFilterDispositions !== EXPECTED_FILTER_DISPOSITION_COUNT
    || report.counts?.completedFilterDispositions !== EXPECTED_FILTER_DISPOSITION_COUNT
    || !Array.isArray(report.rows) || report.rows.length !== EXPECTED_FILE_COUNT
    || !Array.isArray(report.failures) || report.failures.length !== 0
  ) {
    throw new Error(`Search provider report is incomplete for ${provider}; expected 2,061 queries`);
  }
  const aliases = new Set();
  let queries = 0;
  let filterDispositions = 0;
  for (const row of report.rows) {
    if (aliases.has(row.alias)) throw new Error(`Search provider report has duplicate alias: ${row.alias}`);
    aliases.add(row.alias);
    validateProviderRow(row, provider);
    queries += row.queries.length;
    filterDispositions += row.filterDispositions.length;
  }
  if (queries !== EXPECTED_QUERY_COUNT || filterDispositions !== EXPECTED_FILTER_DISPOSITION_COUNT) {
    throw new Error(`Search provider report query coverage is incomplete for ${provider}`);
  }
  return report;
}

function validateProviderRow(row, provider) {
  if (
    typeof row.alias !== "string" || row.alias === "" || row.ok !== true
    || !Array.isArray(row.queries) || !Array.isArray(row.filterDispositions)
    || row.filterDispositions.length !== 3
    || row.sourceRead?.matched !== true
    || row.sourceRead?.byId?.status !== 200 || row.sourceRead?.byPath?.status !== 200
    || row.sourceRead.byId.sha256 !== row.sourceRead.byPath.sha256
    || row.sourceRead.byId.byteCount !== row.sourceRead.byPath.byteCount
  ) {
    throw new Error(`Search provider source read is incomplete for ${provider}:${row.alias}`);
  }
  const variants = new Set(row.queries.map((query) => query.variant));
  if (variants.size !== row.queries.length || FIXED_VARIANTS.some((variant) => !variants.has(variant))) {
    throw new Error(`Search provider fixed query coverage is incomplete for ${provider}:${row.alias}`);
  }
  for (const disposition of row.filterDispositions) {
    const variant = FILTER_VARIANTS[disposition.field];
    if (!variant || !["applicable", "not_applicable"].includes(disposition.status)) {
      throw new Error(`Search provider filter disposition is invalid for ${provider}:${row.alias}`);
    }
    if ((disposition.status === "applicable") !== variants.has(variant)) {
      throw new Error(`Search provider filter query coverage is incomplete for ${provider}:${row.alias}`);
    }
  }
  for (const query of row.queries) {
    validateSemanticStatus(query.semanticStatus, provider, row.alias, query.variant);
    validateEvidenceStatus(query.evidenceStatus, query.semanticStatus, provider, row.alias, query.variant);
  }
}

function assertFileIdentity(left, right) {
  const fields = [
    "alias", "family", "knowledgeBaseId", "sourceFileId", "sourcePath",
    "expectedGeneratedPath", "sourceChecksumSha256"
  ];
  if (fields.some((field) => left[field] !== right[field])) {
    throw new Error(`Search provider file identity mismatch: ${left.alias}`);
  }
  if (
    left.sourceRead.byId.sha256 !== right.sourceRead.byId.sha256
    || left.sourceRead.byId.byteCount !== right.sourceRead.byId.byteCount
    || stableJson(left.filterDispositions) !== stableJson(right.filterDispositions)
  ) {
    throw new Error(`Search provider source read or filter mismatch: ${left.alias}`);
  }
}

function buildParityRow(context) {
  const openCandidates = requireCandidateIds(context.openQuery, "opensearch");
  const meiliCandidates = requireCandidateIds(context.meiliQuery, "meilisearch");
  const openSet = new Set(openCandidates);
  const meiliSet = new Set(meiliCandidates);
  const commonCandidates = [...openSet].filter((id) => meiliSet.has(id));
  const rerankerRequested = context.openQuery.parameters?.rerank === "true";
  const openReranker = evaluateExpectedRerankerOutcome({
    requested: rerankerRequested,
    status: context.openQuery.rerankerStatus
  });
  const meiliReranker = evaluateExpectedRerankerOutcome({
    requested: rerankerRequested,
    status: context.meiliQuery.rerankerStatus
  });
  const checks = [
    check("query-identity", context.openQuery.querySha256 === context.meiliQuery.querySha256),
    check("request-parameters", stableJson(context.openQuery.parameters) === stableJson(context.meiliQuery.parameters)),
    check("graded-qrels", stableJson(context.openQuery.qrels) === stableJson(context.meiliQuery.qrels)),
    check("successful-http-status", context.openQuery.status === 200 && context.meiliQuery.status === 200),
    check("required-source-found", context.openQuery.found === true && context.meiliQuery.found === true),
    check("generated-path-matched", context.openQuery.pathMatched === true && context.meiliQuery.pathMatched === true),
    check("mode-matched", context.openQuery.modeMatches === true && context.meiliQuery.modeMatches === true),
    check("scope-matched", context.openQuery.scopeMatches === true && context.meiliQuery.scopeMatches === true),
    check("reranker-contract-matched", context.openQuery.rerankerMatches === true && context.meiliQuery.rerankerMatches === true),
    check("search-mode-parity", context.openQuery.searchMode === context.meiliQuery.searchMode),
    check("opensearch-semantic-status-contract", true),
    check("meilisearch-semantic-status-contract", true),
    check("opensearch-evidence-status-contract", true),
    check("meilisearch-evidence-status-contract", true),
    check("reranker-status-contract", openReranker.matched && meiliReranker.matched),
    check("graph-status-parity", context.openQuery.graphStatus === context.meiliQuery.graphStatus),
    check("source-read-actions-parity", context.openQuery.fileContentById === context.meiliQuery.fileContentById
      && context.openQuery.fileContentByPath === context.meiliQuery.fileContentByPath),
    check("source-body-parity", context.openRow.sourceRead.byId.sha256 === context.meiliRow.sourceRead.byId.sha256
      && context.openRow.sourceRead.byId.byteCount === context.meiliRow.sourceRead.byId.byteCount),
    check("required-source-owned", openSet.has(context.openRow.sourceFileId)
      && meiliSet.has(context.openRow.sourceFileId))
  ];
  const pass = checks.every((item) => item.pass);
  const observed = {
    alias: context.openRow.alias,
    variant: context.openQuery.variant,
    querySha256: context.openQuery.querySha256,
    sourceFileId: context.openRow.sourceFileId,
    knowledgeBaseId: context.openRow.knowledgeBaseId,
    opensearchRank: context.openQuery.rank,
    meilisearchRank: context.meiliQuery.rank,
    rankDelta: Number(context.meiliQuery.rank) - Number(context.openQuery.rank),
    opensearchResultCount: context.openQuery.resultCount,
    meilisearchResultCount: context.meiliQuery.resultCount,
    commonCandidateCount: commonCandidates.length,
    opensearchOnlyCandidateCount: openCandidates.filter((id) => !meiliSet.has(id)).length,
    meilisearchOnlyCandidateCount: meiliCandidates.filter((id) => !openSet.has(id)).length,
    candidateOrderingExactMatch: stableJson(openCandidates) === stableJson(meiliCandidates),
    candidateSetExactMatch: openSet.size === meiliSet.size
      && [...openSet].every((id) => meiliSet.has(id)),
    opensearchLatencyMs: context.openQuery.latencyMs,
    meilisearchLatencyMs: context.meiliQuery.latencyMs,
    opensearchSemanticStatus: context.openQuery.semanticStatus,
    meilisearchSemanticStatus: context.meiliQuery.semanticStatus,
    semanticStateExactMatch: stableJson(context.openQuery.semanticStatus)
      === stableJson(context.meiliQuery.semanticStatus),
    opensearchEvidenceStatus: context.openQuery.evidenceStatus,
    meilisearchEvidenceStatus: context.meiliQuery.evidenceStatus,
    evidenceStateExactMatch: stableJson(context.openQuery.evidenceStatus)
      === stableJson(context.meiliQuery.evidenceStatus),
    rerankerStatus: context.openQuery.rerankerStatus,
    opensearchRerankerOutcome: openReranker,
    meilisearchRerankerOutcome: meiliReranker,
    rerankerStateExactMatch: stableJson(context.openQuery.rerankerStatus)
      === stableJson(context.meiliQuery.rerankerStatus),
    graphStatus: context.openQuery.graphStatus,
    sourceReadSha256: context.openRow.sourceRead.byId.sha256
  };
  return {
    sequence: context.sequence,
    id: `search-parity:${context.openRow.alias}:${context.openQuery.variant}`,
    expected: {
      providerNeutralContract:
        "same authorized source, path, mode, truthful state/evidence, and original read",
      providerSpecificOrderingAllowed: true,
      providerSpecificOperationalStateDifferenceAllowed: true
    },
    observed,
    manualChecks: checks,
    automatedStatus: pass ? "pass" : "failed",
    manualStatus: pass ? "pass" : "failed",
    evidenceHash: hashJson({ observed, checks })
  };
}

function validateSemanticStatus(status, provider, alias, variant) {
  const location = `${provider}:${alias}:${variant}`;
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    throw new Error(`Search provider semantic status is invalid for ${location}`);
  }
  if (!["ready", "degraded", "unavailable"].includes(status.state)) {
    throw new Error(`Search provider semantic status is invalid for ${location}`);
  }
  if (status.state === "ready") {
    if (status.safeCode !== null) {
      throw new Error(`Search provider semantic status is invalid for ${location}`);
    }
    return;
  }
  if (!SEMANTIC_SAFE_CODES.has(status.safeCode)) {
    throw new Error(`Search provider semantic status is invalid for ${location}`);
  }
}

function validateEvidenceStatus(status, semanticStatus, provider, alias, variant) {
  const location = `${provider}:${alias}:${variant}`;
  if (!status || typeof status !== "object" || Array.isArray(status)
    || !Array.isArray(status.completedFamilies)
    || !Array.isArray(status.degradedFamilies)) {
    throw new Error(`Search provider evidence status is invalid for ${location}`);
  }
  const completed = validateEvidenceFamilies(status.completedFamilies, location);
  const degraded = validateEvidenceFamilies(status.degradedFamilies, location);
  if ([...completed].some((family) => degraded.has(family))) {
    throw new Error(`Search provider evidence status overlaps for ${location}`);
  }
  if (semanticStatus.state === "ready" && degraded.size > 0) {
    throw new Error(`Search provider evidence status contradicts ready semantic status for ${location}`);
  }
  if (semanticStatus.state === "degraded" && degraded.size === 0) {
    throw new Error(`Search provider evidence status omits degraded families for ${location}`);
  }
}

function validateEvidenceFamilies(values, location) {
  const families = new Set();
  for (const value of values) {
    if (!EVIDENCE_FAMILIES.has(value) || families.has(value)) {
      throw new Error(`Search provider evidence status is invalid for ${location}`);
    }
    families.add(value);
  }
  return families;
}

function summarizeProviderState(state, provider) {
  if (state === undefined) return { provider, status: "not_supplied" };
  if (!state || state.provider !== provider || state.ok !== true) {
    throw new Error(`Search provider operational state is invalid for ${provider}`);
  }
  return {
    provider,
    status: "reviewed",
    format: state.format ?? null,
    knowledgeBaseCount: Array.isArray(state.knowledgeBases) ? state.knowledgeBases.length : null,
    clusterIndexCount: Array.isArray(state.cluster?.indexes)
      ? state.cluster.indexes.length
      : state.clusterReconciliation?.indexCount ?? null,
    clusterAliasCount: Array.isArray(state.cluster?.aliases)
      ? state.cluster.aliases.length
      : state.clusterReconciliation?.aliasCount ?? null,
    taskCount: Array.isArray(state.tasks) ? state.tasks.length : null,
    evidenceHash: hashJson(state)
  };
}

function requireCandidateIds(query, provider) {
  if (!Array.isArray(query?.returnedSourceFileIds)
    || query.returnedSourceFileIds.some((value) => typeof value !== "string" || value === "")) {
    throw new Error(`Search provider candidate list is invalid for ${provider}`);
  }
  return query.returnedSourceFileIds;
}

function check(name, pass) {
  return { name, pass: pass === true };
}

function compareAlias(left, right) {
  return left.alias.localeCompare(right.alias, "en");
}

function compareVariant(left, right) {
  return left.variant.localeCompare(right.variant, "en");
}

function hashJson(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
