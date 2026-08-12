import assert from "node:assert/strict";
import test from "node:test";

import {
  buildComprehensiveSearchQualitySummary
} from "../lib/comprehensive-search-quality.mjs";

test("summarizes all 2,061 item-level queries without hiding a miss", () => {
  const providerReport = report();
  const summary = buildComprehensiveSearchQualitySummary({
    providerReport,
    providerReportSha256: "a".repeat(64),
    specialCaseReport: specialCaseReport(),
    vectorOracleReport: vectorOracleReport()
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.counts.sourceFiles, 200);
  assert.equal(summary.counts.queries, 2_061);
  assert.equal(summary.metrics[50].recall, 1);
  assert.equal(summary.metrics[50].ndcg, 1);
  assert.equal(summary.metrics[50].map, 1);
  assert.equal(summary.metrics[50].mrr, 1);
  assert.equal(summary.noResultFalsePositiveRate, 0);
  assert.equal(summary.annRecall.minimum, 1);
  assert.equal(summary.failures.length, 0);

  const missed = structuredClone(providerReport);
  missed.rows[0].queries[0].returnedSourceFileIds = [];
  const failed = buildComprehensiveSearchQualitySummary({
    providerReport: missed,
    providerReportSha256: "a".repeat(64),
    specialCaseReport: specialCaseReport(),
    vectorOracleReport: vectorOracleReport()
  });
  assert.equal(failed.ok, false);
  assert.ok(failed.failures.some((item) => item.code === "required_source_missing"));
});

test("rejects stale special-case or vector-oracle evidence", () => {
  assert.throws(() => buildComprehensiveSearchQualitySummary({
    providerReport: report(),
    providerReportSha256: "a".repeat(64),
    specialCaseReport: { ...specialCaseReport(), providerReportSha256: "b".repeat(64) },
    vectorOracleReport: vectorOracleReport()
  }), /provider report fingerprint/u);

  const staleOracle = vectorOracleReport();
  staleOracle.querySummary.annRecall.minimum = 0.99;
  const failed = buildComprehensiveSearchQualitySummary({
    providerReport: report(),
    providerReportSha256: "a".repeat(64),
    specialCaseReport: specialCaseReport(),
    vectorOracleReport: staleOracle
  });
  assert.equal(failed.ok, false);
  assert.ok(failed.failures.some((item) => item.code === "ann_recall_below_one"));
});

function report() {
  const fixedVariants = Array.from({ length: 9 }, (_, index) => `fixed-${index + 1}`);
  const rows = Array.from({ length: 200 }, (_, index) => {
    const sourceFileId = `source-file-${index + 1}`;
    const variants = [
      ...fixedVariants,
      "filter-primary",
      ...(index < 61 ? ["filter-secondary"] : [])
    ];
    return {
      alias: `source-${String(index + 1).padStart(3, "0")}`,
      sourceFileId,
      sourceRead: { matched: true },
      queries: variants.map((variant) => ({
        variant,
        status: 200,
        latencyMs: 10,
        qrels: [{ sourceFileId, relevance: 3 }],
        returnedSourceFileIds: [sourceFileId],
        found: true,
        pathMatched: true,
        modeMatches: true,
        scopeMatches: true,
        rerankerMatches: true
      }))
    };
  });
  return {
    format: "focowiki-comprehensive-search-provider-e2e-v1",
    provider: "opensearch",
    startedAt: "2026-08-12T00:00:00.000Z",
    finishedAt: "2026-08-12T00:00:10.000Z",
    ok: true,
    counts: {
      expectedFiles: 200,
      completedFiles: 200,
      expectedQueries: 2_061,
      completedQueries: 2_061,
      successfulQueries: 2_061,
      failures: 0
    },
    latencyMs: {
      count: 2_061,
      minimumMs: 10,
      p50Ms: 10,
      p90Ms: 10,
      p95Ms: 10,
      p99Ms: 10,
      maximumMs: 10,
      meanMs: 10
    },
    rows,
    failures: []
  };
}

function specialCaseReport() {
  return {
    format: "focowiki-comprehensive-search-special-case-e2e-v1",
    provider: "opensearch",
    providerReportSha256: "a".repeat(64),
    ok: true,
    counts: {
      expectedCases: 2_358,
      completedCases: 2_358,
      passedCases: 2_358,
      failedCases: 0
    },
    cases: [
      noResultCase("one"),
      noResultCase("two"),
      ...Array.from({ length: 2_356 }, (_, index) => ({
        caseId: `search-special:nested_path:${index + 1}`,
        category: "nested_path",
        ok: true,
        observation: { returnedItemCount: 1 }
      }))
    ],
    failures: []
  };
}

function noResultCase(id) {
  return {
    caseId: `search-special:no_result:${id}`,
    category: "no_result",
    ok: true,
    observation: { returnedItemCount: 0 }
  };
}

function vectorOracleReport() {
  return {
    format: "focowiki-comprehensive-vector-oracle-v1",
    provider: "opensearch",
    ok: true,
    counts: {
      vectorQueries: 641,
      successfulVectorQueries: 641,
      failedVectorQueries: 0
    },
    querySummary: {
      total: 641,
      passed: 641,
      failed: 0,
      annRecall: { minimum: 1, p50: 1, p95: 1, mean: 1 }
    },
    failures: []
  };
}
