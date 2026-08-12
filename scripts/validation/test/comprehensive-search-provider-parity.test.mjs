import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildComprehensiveSearchProviderParity
} from "../lib/comprehensive-search-provider-parity.mjs";

const BASE_VARIANTS = [
  "exact_path_file",
  "exact_title_file",
  "lexical_file",
  "natural_sentence_hybrid",
  "natural_sentence_hybrid_omitted",
  "exact_title_graph",
  "exact_path_scope_path",
  "exact_title_scope_metadata",
  "natural_sentence_hybrid_reranked"
];

test("builds one independently evidenced parity row for all 2,061 provider queries", () => {
  const opensearch = report("opensearch");
  const meilisearch = report("meilisearch");
  const degraded = opensearch.rows[0].queries.find((query) =>
    query.variant === "natural_sentence_hybrid_reranked");
  degraded.rerankerStatus = { state: "degraded", safeCode: "RERANKER_TIMEOUT" };
  const semanticDegraded = opensearch.rows[1].queries.find((query) =>
    query.variant === "natural_sentence_hybrid");
  semanticDegraded.semanticStatus = {
    state: "degraded",
    safeCode: "SEMANTIC_LANE_PARTIAL_FAILURE"
  };
  semanticDegraded.evidenceStatus = {
    completedFamilies: ["exact_path", "lexical"],
    degradedFamilies: ["content_vector"]
  };
  const result = buildComprehensiveSearchProviderParity({
    opensearch,
    meilisearch,
    providerStates: {
      opensearch: { provider: "opensearch", ok: true, cluster: { indexes: [1, 2] } },
      meilisearch: { provider: "meilisearch", ok: true, cluster: { indexes: [1, 2, 3] } }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.coverageMode, "exhaustive");
  assert.equal(result.summary.fileCount, 200);
  assert.equal(result.summary.queryCount, 2_061);
  assert.equal(result.summary.manualPassCount, 2_061);
  assert.equal(result.summary.candidateOrderingDifferenceCount, 2_061);
  assert.equal(result.summary.rerankerStateDifferenceCount, 1);
  assert.equal(result.summary.semanticStateDifferenceCount, 1);
  assert.equal(result.summary.evidenceStateDifferenceCount, 1);
  assert.ok(result.rows.every((row) => row.manualStatus === "pass"));
  assert.ok(result.rows.every((row) => row.evidenceHash.length === 64));
  const semanticParity = result.rows.find((row) =>
    row.id === "search-parity:official-002:natural_sentence_hybrid");
  assert.equal(semanticParity.observed.opensearchSemanticStatus.state, "degraded");
  assert.equal(semanticParity.observed.meilisearchSemanticStatus.state, "ready");
  assert.deepEqual(semanticParity.observed.opensearchEvidenceStatus.degradedFamilies, [
    "content_vector"
  ]);
  assert.deepEqual(semanticParity.observed.meilisearchEvidenceStatus.degradedFamilies, []);
  assert.equal(result.providerSpecificOperations.opensearch.provider, "opensearch");
  assert.equal(result.providerSpecificOperations.meilisearch.provider, "meilisearch");
});

test("fails closed when any provider query or source read is incomplete", () => {
  const opensearch = report("opensearch");
  const meilisearch = report("meilisearch");
  meilisearch.rows[0].queries.pop();
  meilisearch.counts.completedQueries -= 1;

  assert.throws(
    () => buildComprehensiveSearchProviderParity({ opensearch, meilisearch }),
    /2,061|query coverage|provider report/u
  );

  const restored = report("meilisearch");
  restored.rows[0].sourceRead.matched = false;
  assert.throws(
    () => buildComprehensiveSearchProviderParity({
      opensearch,
      meilisearch: restored
    }),
    /source read|manual parity/u
  );

  const invalidOpenSearch = report("opensearch");
  const invalidMeilisearch = report("meilisearch");
  for (const invalidReport of [invalidOpenSearch, invalidMeilisearch]) {
    invalidReport.rows[0].queries[0].semanticStatus = {
      state: "pretend_ready",
      safeCode: null
    };
  }
  assert.throws(
    () => buildComprehensiveSearchProviderParity({
      opensearch: invalidOpenSearch,
      meilisearch: invalidMeilisearch
    }),
    /semantic status/u
  );
});

function report(provider) {
  const rows = Array.from({ length: 200 }, (_, index) => row(provider, index));
  return {
    format: "focowiki-comprehensive-search-provider-e2e-v1",
    provider,
    ok: true,
    corpus: {
      expectedFileCount: 200,
      observedFileCount: 200,
      manifestSha256: "a".repeat(64)
    },
    counts: {
      expectedFiles: 200,
      completedFiles: 200,
      expectedQueries: 2_061,
      completedQueries: 2_061,
      successfulQueries: 2_061,
      sourceReads: 400,
      failures: 0,
      expectedFilterDispositions: 600,
      completedFilterDispositions: 600
    },
    latencyMs: { count: 2_061, p95Ms: provider === "opensearch" ? 100 : 90 },
    rows,
    failures: []
  };
}

function row(provider, index) {
  const alias = index < 53
    ? `official-${String(index + 1).padStart(3, "0")}`
    : `legacy-${String(index - 52).padStart(3, "0")}`;
  const sourceFileId = `source-file-${String(index + 1).padStart(3, "0")}`;
  const path = `pages/${alias}.md`;
  const variants = [...BASE_VARIANTS, "filter_okf_trust_tier"];
  if (index < 54) variants.push("filter_okf_status");
  if (index < 7) variants.push("filter_okf_freshness");
  return {
    alias,
    family: index < 53 ? "official" : "legacy",
    knowledgeBaseId: index < 53 ? "knowledge-base-official" : "knowledge-base-legacy",
    sourceFileId,
    sourcePath: `${alias}.md`,
    expectedGeneratedPath: path,
    sourceChecksumSha256: hash(`source:${alias}`),
    filterDispositions: [
      disposition("okfStatus", index < 54),
      disposition("okfTrustTier", true),
      disposition("okfFreshness", index < 7)
    ],
    sourceRead: {
      byId: { status: 200, byteCount: 100 + index, sha256: hash(`body:${alias}`) },
      byPath: { status: 200, byteCount: 100 + index, sha256: hash(`body:${alias}`) },
      matched: true
    },
    queries: variants.map((variant) => query(provider, alias, sourceFileId, path, variant)),
    ok: true
  };
}

function query(provider, alias, sourceFileId, path, variant) {
  const reranked = variant === "natural_sentence_hybrid_reranked";
  const graph = variant === "exact_title_graph";
  const hybrid = variant.startsWith("natural_sentence_hybrid");
  const mode = graph ? "graph" : hybrid ? "hybrid" : "file";
  return {
    variant,
    querySha256: hash(`${alias}:${variant}`),
    qrels: [{ sourceFileId, relevance: 3 }],
    parameters: { mode, rerank: String(reranked) },
    status: 200,
    latencyMs: provider === "opensearch" ? 20 : 18,
    resultCount: 2,
    returnedSourceFileIds: provider === "opensearch"
      ? [sourceFileId, `open-${alias}`]
      : [sourceFileId, `meili-${alias}`],
    found: true,
    rank: 1,
    pathMatched: true,
    modeMatches: true,
    scopeMatches: true,
    rerankerMatches: true,
    searchMode: mode,
    semanticStatus: { state: "ready", safeCode: null },
    evidenceStatus: { completedFamilies: ["lexical"], degradedFamilies: [] },
    rerankerStatus: reranked
      ? { state: "applied", safeCode: null }
      : { state: "skipped", safeCode: "RERANKER_DISABLED" },
    graphStatus: mode === "file" ? "disabled_for_file_mode" : "available",
    fileContentById: `/files/${sourceFileId}/content`,
    fileContentByPath: `/files/content?path=${encodeURIComponent(path)}`
  };
}

function disposition(field, applicable) {
  return applicable
    ? { field, status: "applicable", value: "value" }
    : { field, status: "not_applicable", reason: "missing_valid_signal" };
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
