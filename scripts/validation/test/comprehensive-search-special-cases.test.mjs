import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  COMPREHENSIVE_SEARCH_SPECIAL_CATEGORIES,
  buildComprehensiveSearchSpecialCasePlan,
  evaluateComprehensiveExistingSpecialCase,
  evaluateComprehensiveLiveSpecialCase,
  validateComprehensiveSearchSpecialCaseInputs,
  validateComprehensiveSearchSpecialCasePlan
} from "../lib/comprehensive-search-special-cases.mjs";

test("builds explicit special-search cases without category or source substitution", () => {
  const plan = buildComprehensiveSearchSpecialCasePlan({
    providerReport: report(),
    manifestRows: manifestRows()
  });

  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.coverageMode, "item_by_item");
  assert.equal(plan.providerReportSha256, hash(JSON.stringify(report())));
  assert.deepEqual(
    [...new Set(plan.cases.map((item) => item.category))].sort(),
    [...COMPREHENSIVE_SEARCH_SPECIAL_CATEGORIES].sort()
  );
  assert.ok(plan.cases.every((item) => item.querySha256 === hash(item.query)));
  assert.ok(plan.cases.every((item) => item.sourceAliases.length > 0));
  assert.ok(plan.cases.some((item) =>
    item.category === "duplicate_title" && item.sourceAliases.length === 2));
  assert.ok(plan.cases.some((item) =>
    item.category === "similar_file" && item.sourceAliases.length === 2));
  assert.equal(
    plan.cases.filter((item) => item.category === "cross_knowledge_base").length,
    4
  );
  assert.equal(validateComprehensiveSearchSpecialCasePlan(plan).ok, true);
});

test("keeps item-level semantic cases when a provider lane safely degrades", () => {
  const providerReport = report();
  const row = providerReport.rows.find((item) => item.alias === "legacy-001");
  const query = row.queries.find((item) => item.variant === "natural_sentence_hybrid");
  query.semanticStatus = {
    state: "degraded",
    safeCode: "SEMANTIC_LANE_PARTIAL_FAILURE"
  };
  query.evidenceStatus = {
    completedFamilies: ["exact_path", "exact_title", "file_graph", "jieba", "lexical"],
    degradedFamilies: [
      "community_vector", "content_vector", "entity_vector", "relationship_vector"
    ]
  };

  const plan = buildComprehensiveSearchSpecialCasePlan({
    providerReport,
    manifestRows: manifestRows()
  });
  const semanticCases = plan.cases.filter((item) =>
    item.sourceAliases.includes("legacy-001")
      && ["entity", "relationship", "community_theme"].includes(item.category));

  assert.equal(semanticCases.length, 3);
  assert.ok(semanticCases.every((item) =>
    item.expectation.kind === "semantic_family_degrades_safely"));
  assert.ok(semanticCases.every((item) =>
    evaluateComprehensiveExistingSpecialCase({ item, providerReport }).ok === true));
});

test("rejects a missing category, duplicate row, or unhashed query", () => {
  const plan = buildComprehensiveSearchSpecialCasePlan({
    providerReport: report(),
    manifestRows: manifestRows()
  });
  const missing = structuredClone(plan);
  missing.cases = missing.cases.filter((item) => item.category !== "cursor");
  assert.throws(
    () => validateComprehensiveSearchSpecialCasePlan(missing),
    /missing category: cursor/u
  );

  const duplicate = structuredClone(plan);
  duplicate.cases.push(structuredClone(duplicate.cases[0]));
  assert.throws(
    () => validateComprehensiveSearchSpecialCasePlan(duplicate),
    /duplicate case ID/u
  );

  const unhashed = structuredClone(plan);
  unhashed.cases[0].querySha256 = "0".repeat(64);
  assert.throws(
    () => validateComprehensiveSearchSpecialCasePlan(unhashed),
    /query hash/u
  );

  const staleProvider = structuredClone(plan);
  staleProvider.providerReportSha256 = "0".repeat(63);
  assert.throws(
    () => validateComprehensiveSearchSpecialCasePlan(staleProvider),
    /provider report hash/u
  );
});

test("rejects a special-case plan built from a different provider report", () => {
  const providerReport = report();
  const plan = buildComprehensiveSearchSpecialCasePlan({
    providerReport,
    manifestRows: manifestRows()
  });
  const changedReport = structuredClone(providerReport);
  changedReport.finishedAt = "2026-08-12T00:00:00.000Z";

  assert.throws(
    () => validateComprehensiveSearchSpecialCaseInputs({
      plan,
      providerReport: changedReport
    }),
    /do not share one green provider run/u
  );
});

test("evaluates each existing-report special case from its own source and query evidence", () => {
  const providerReport = report();
  const plan = buildComprehensiveSearchSpecialCasePlan({
    providerReport,
    manifestRows: manifestRows()
  });
  const existingCases = plan.cases.filter((item) => item.execution === "existing_report");
  const results = existingCases.map((item) =>
    evaluateComprehensiveExistingSpecialCase({ item, providerReport }));

  assert.ok(results.length > 0);
  assert.ok(results.every((item) => item.ok === true));
  assert.ok(results.every((item) => item.caseId && item.evidenceHash.length === 64));

  const cjk = structuredClone(plan.cases.find((item) => item.category === "cjk_jieba"));
  const invalidReport = structuredClone(providerReport);
  const row = invalidReport.rows.find((item) => item.alias === cjk.sourceAliases[0]);
  row.queries.find((item) => item.variant === cjk.existingVariant)
    .evidenceStatus.completedFamilies = ["lexical"];
  assert.throws(
    () => evaluateComprehensiveExistingSpecialCase({ item: cjk, providerReport: invalidReport }),
    /required evidence family/u
  );
});

test("evaluates pagination, cursor, no-result, and cross-scope live pages independently", () => {
  const providerReport = report();
  const plan = buildComprehensiveSearchSpecialCasePlan({
    providerReport,
    manifestRows: manifestRows()
  });
  const reads = new Map(providerReport.rows.map((row) => [
    row.sourceFileId,
    liveSourceRead(row.sourceFileId, row.expectedGeneratedPath)
  ]));
  const pagination = plan.cases.find((item) => item.category === "pagination");
  const cursor = plan.cases.find((item) => item.category === "cursor");
  const noResult = plan.cases.find((item) => item.category === "no_result");
  const crossScope = plan.cases.find((item) => item.category === "cross_knowledge_base");
  const duplicateIds = pagination.expectation.requiredSourceFileIds;
  const pages = [
    livePage(pagination.knowledgeBaseId, duplicateIds[0], "pages/legacy/rules/example-a.md", "cursor-1"),
    livePage(pagination.knowledgeBaseId, duplicateIds[1], "pages/legacy/rules/example-b.md", null, true)
  ];

  assert.equal(evaluateComprehensiveLiveSpecialCase({
    item: pagination,
    pages: pages.slice(0, 1),
    sourceReads: reads
  }).ok, true);
  assert.equal(evaluateComprehensiveLiveSpecialCase({
    item: cursor,
    pages,
    sourceReads: reads
  }).ok, true);
  assert.equal(evaluateComprehensiveLiveSpecialCase({
    item: noResult,
    pages: [emptyLivePage(noResult.knowledgeBaseId)],
    sourceReads: reads
  }).ok, true);
  assert.equal(evaluateComprehensiveLiveSpecialCase({
    item: crossScope,
    pages: [emptyLivePage(crossScope.knowledgeBaseId)],
    sourceReads: reads
  }).ok, true);

  assert.throws(
    () => evaluateComprehensiveLiveSpecialCase({
      item: cursor,
      pages: [pages[0], pages[0]],
      sourceReads: reads
    }),
    /duplicate source|cursor/u
  );
});

function report() {
  return {
    format: "focowiki-comprehensive-search-provider-e2e-v1",
    provider: "opensearch",
    ok: true,
    corpus: {
      manifestSha256: "f".repeat(64),
      expectedFileCount: 4,
      observedFileCount: 4
    },
    rows: [
      row({
        alias: "official-001",
        family: "official",
        knowledgeBaseId: "knowledge-base-official",
        sourceFileId: "source-file-official-001",
        sourcePath: "official/catalog/metric-revenue.md",
        title: "Revenue Metric",
        lexical: "Revenue Metric recognized delivery",
        filters: { status: true, trust: true, freshness: true }
      }),
      row({
        alias: "official-002",
        family: "official",
        knowledgeBaseId: "knowledge-base-official",
        sourceFileId: "source-file-official-002",
        sourcePath: "official/catalog/metric-revenues.md",
        title: "Revenue Metrics",
        lexical: "Revenue Metrics recognized accrual",
        filters: { status: true, trust: true, freshness: false }
      }),
      row({
        alias: "legacy-001",
        family: "legacy",
        knowledgeBaseId: "knowledge-base-legacy",
        sourceFileId: "source-file-legacy-001",
        sourcePath: "legacy/rules/example-a.md",
        title: "示例规定",
        lexical: "示例规定 生效 条件",
        filters: { status: false, trust: true, freshness: false }
      }),
      row({
        alias: "legacy-002",
        family: "legacy",
        knowledgeBaseId: "knowledge-base-legacy",
        sourceFileId: "source-file-legacy-002",
        sourcePath: "legacy/rules/example-b.md",
        title: "示例规定",
        lexical: "示例规定 适用 范围",
        filters: { status: false, trust: true, freshness: false }
      })
    ],
    failures: []
  };
}

function row(input) {
  const expectedGeneratedPath = `pages/${input.sourcePath}`;
  const exactTitleIds = input.title === "示例规定"
    ? ["source-file-legacy-001", "source-file-legacy-002"]
    : [input.sourceFileId];
  const commonEvidence = {
    completedFamilies: [
      "community_vector",
      "content_vector",
      "entity_vector",
      "exact_path",
      "exact_title",
      "file_graph",
      "jieba",
      "lexical",
      "relationship_vector"
    ],
    degradedFamilies: []
  };
  const query = (variant, text, parameters, returnedSourceFileIds = [input.sourceFileId]) => ({
    variant,
    query: text,
    querySha256: hash(text),
    parameters,
    status: 200,
    resultCount: returnedSourceFileIds.length,
    returnedSourceFileIds,
    found: true,
    rank: 1,
    pathMatched: true,
    modeMatches: true,
    scopeMatches: true,
    rerankerMatches: true,
    semanticStatus: { state: "ready", safeCode: null },
    evidenceStatus: commonEvidence,
    rerankerStatus: parameters.rerank === "true"
      ? { state: "applied", safeCode: null }
      : { state: "skipped", safeCode: "RERANKER_DISABLED" },
    graphStatus: parameters.mode === "file" ? "disabled_for_file_mode" : "available"
  });
  const queries = [
    query("exact_path_file", expectedGeneratedPath, {
      mode: "file", graphDepth: "0", limit: "20", rerank: "false"
    }),
    query("exact_title_file", input.title, {
      mode: "file", graphDepth: "0", limit: "20", rerank: "false"
    }, exactTitleIds),
    query("lexical_file", input.lexical, {
      mode: "file", graphDepth: "0", limit: "20", rerank: "false"
    }),
    query("natural_sentence_hybrid", `${input.title}: ${input.lexical}`, {
      mode: "hybrid", graphDepth: "2", limit: "50", rerank: "false"
    }),
    query("exact_title_graph", input.title, {
      mode: "graph", graphDepth: "2", limit: "50", rerank: "false"
    }),
    query("natural_sentence_hybrid_reranked", `${input.title}: ${input.lexical}`, {
      mode: "hybrid",
      graphDepth: "2",
      limit: "50",
      rerank: "true",
      rerankTopK: "50",
      rerankScoreThreshold: "0"
    })
  ];
  const filterDispositions = [
    disposition("okfStatus", input.filters.status, "stable"),
    disposition("okfTrustTier", input.filters.trust, "human-reviewed"),
    disposition("okfFreshness", input.filters.freshness, "fresh")
  ];
  for (const item of filterDispositions.filter((value) => value.status === "applicable")) {
    const suffix = item.field === "okfStatus"
      ? "status"
      : item.field === "okfTrustTier"
        ? "trust_tier"
        : "freshness";
    queries.push(query(`filter_okf_${suffix}`, expectedGeneratedPath, {
      mode: "file",
      graphDepth: "0",
      limit: "20",
      rerank: "false",
      [item.field]: item.value
    }));
  }
  return {
    alias: input.alias,
    family: input.family,
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.sourceFileId,
    sourcePath: input.sourcePath,
    expectedGeneratedPath,
    sourceChecksumSha256: hash(input.alias),
    filterDispositions,
    queries,
    sourceRead: { matched: true },
    ok: true
  };
}

function disposition(field, applicable, value) {
  return applicable
    ? { field, status: "applicable", value }
    : { field, status: "not_applicable", reason: "missing_valid_signal" };
}

function manifestRows() {
  return ["official-001", "official-002", "legacy-001", "legacy-002"].map((alias) => ({
    alias,
    metadataClassification: alias.startsWith("official") ? "native-v02" : "legacy-v01"
  }));
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function livePage(knowledgeBaseId, sourceFileId, path, nextCursor, cursorProvided = false) {
  return {
    status: 200,
    latencyMs: 10,
    body: {
      items: [liveSearchItem(knowledgeBaseId, sourceFileId, path)],
      nextCursor,
      searchStatus: "ok",
      searchMode: "file",
      query: { cursorProvided },
      semanticStatus: { state: "ready", safeCode: null },
      evidenceStatus: { completedFamilies: ["lexical"], degradedFamilies: [] },
      rerankerStatus: { state: "skipped", safeCode: "RERANKER_DISABLED" },
      graphStatus: "disabled_for_file_mode",
      resultSummary: { resultCount: 1, hasMore: nextCursor !== null }
    }
  };
}

function emptyLivePage(knowledgeBaseId) {
  return {
    status: 200,
    latencyMs: 5,
    body: {
      items: [],
      nextCursor: null,
      searchStatus: "no_candidates",
      searchMode: "file",
      query: { cursorProvided: false },
      semanticStatus: { state: "ready", safeCode: null },
      evidenceStatus: { completedFamilies: ["lexical"], degradedFamilies: [] },
      rerankerStatus: { state: "skipped", safeCode: "RERANKER_DISABLED" },
      graphStatus: "disabled_for_file_mode",
      resultSummary: { resultCount: 0, hasMore: false }
    }
  };
}

function liveSearchItem(knowledgeBaseId, sourceFileId, path) {
  return {
    knowledgeBaseId,
    fileId: sourceFileId,
    sourceFileId,
    path,
    matchedFields: ["title"],
    evidenceTypes: ["title"],
    matchType: "file_direct",
    contentAvailable: true,
    readActions: {
      fileContentById: `/files/${sourceFileId}/content`,
      fileContentByPath: `/files/content?path=${encodeURIComponent(path)}`
    }
  };
}

function liveSourceRead(sourceFileId, path) {
  const byIdPath = `/files/${sourceFileId}/content`;
  const byPathPath = `/files/content?path=${encodeURIComponent(path)}`;
  return {
    id: sourceFileId,
    readActionsSha256: hash(JSON.stringify({ byIdPath, byPathPath })),
    byId: { status: 200, byteCount: 12, sha256: "a".repeat(64) },
    byPath: { status: 200, byteCount: 12, sha256: "a".repeat(64) },
    matched: true
  };
}
