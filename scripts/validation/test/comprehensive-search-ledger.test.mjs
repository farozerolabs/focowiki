import assert from "node:assert/strict";
import test from "node:test";

import {
  buildApplicableOkfFilterVariants,
  buildComprehensiveSearchCases,
  buildComprehensiveSearchVariants,
  evaluateExpectedRerankerOutcome,
  evaluateComprehensiveSearchObservation,
  evaluateComprehensiveReturnedItems,
  parseRetryAfterMilliseconds,
  reconcileComprehensiveCurrentSourceFiles,
  reconcileComprehensiveSearchProviderReport,
  retryComprehensiveSearchOperation,
  summarizeComprehensiveSearchLatencies
} from "../lib/comprehensive-search-ledger.mjs";

test("reconciles search ownership to the final visible source identities after CRUD", () => {
  const input = {
    corpusFiles: {
      "official-001": {
        family: "official",
        sourceFileId: "source-file-before-crud"
      }
    },
    knowledgeBases: { official: "knowledge-base-official" },
    lifecycleSummary: {
      kind: "focowiki-comprehensive-crud-summary",
      version: 1,
      ok: true,
      complete: true,
      planned: { files: 1 }
    },
    lifecycleState: {
      kind: "focowiki-comprehensive-crud-execution-state",
      version: 1,
      files: {
        "official-001": {
          sourceFileId: "source-file-after-crud",
          knowledgeBaseId: "knowledge-base-official",
          originalRelativePath: "official/acme/revenue.md",
          currentRelativePath: "official/acme/revenue.md",
          state: "visible"
        }
      }
    }
  };

  assert.deepEqual(reconcileComprehensiveCurrentSourceFiles(input), {
    "official-001": {
      family: "official",
      sourceFileId: "source-file-after-crud"
    }
  });

  assert.throws(() => reconcileComprehensiveCurrentSourceFiles({
    ...input,
    lifecycleState: {
      ...input.lifecycleState,
      files: {
        "official-001": {
          ...input.lifecycleState.files["official-001"],
          currentRelativePath: "official/acme/stale.md"
        }
      }
    }
  }), /path does not match/u);
});

test("buildComprehensiveSearchVariants enumerates every fixed retrieval and reranker mode", () => {
  const variants = buildComprehensiveSearchVariants();

  assert.deepEqual(variants.map((variant) => variant.id), [
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
  assert.equal(variants.at(-1).parameters.rerank, "true");
  assert.equal(variants.at(-1).parameters.rerankScoreThreshold, "0");
});

test("buildApplicableOkfFilterVariants itemizes applicable and absent trust filters", () => {
  const complete = buildApplicableOkfFilterVariants({
    effectiveStatus: "stable",
    trustTier: "human-reviewed",
    isStale: false,
    staleAfter: "2027-01-01"
  });
  assert.deepEqual(complete.variants.map((variant) => variant.id), [
    "filter_okf_status",
    "filter_okf_trust_tier",
    "filter_okf_freshness"
  ]);
  assert.deepEqual(complete.dispositions.map((item) => item.status), [
    "applicable", "applicable", "applicable"
  ]);

  const absent = buildApplicableOkfFilterVariants(null);
  assert.equal(absent.variants.length, 0);
  assert.deepEqual(absent.dispositions.map((item) => item.status), [
    "not_applicable", "not_applicable", "not_applicable"
  ]);
});

test("buildComprehensiveSearchCases preserves one immutable row per corpus file", () => {
  const rows = buildComprehensiveSearchCases({
    manifestRows: [{
      alias: "official-001",
      family: "official",
      checksumSha256: "a".repeat(64),
      pathHash: "532394b88a86b83372035bd9a0c0e1ddd7378d7f92c281f5587e84e6a9cf939d"
    }],
    workspaceFiles: [{
      path: "official/acme/metrics/revenue.md",
      checksumSha256: "a".repeat(64),
      stagedPath: "/private/run/revenue.md",
      contents: `---\ntitle: Revenue Metric\n---\n# Revenue Metric\n\nRevenue is recognized after delivery is complete.\n`
    }],
    corpusFiles: {
      "official-001": {
        family: "official",
        sourceFileId: "source-file-001"
      }
    },
    knowledgeBases: {
      official: "knowledge-base-official"
    }
  });

  assert.deepEqual(rows, [{
    alias: "official-001",
    family: "official",
    knowledgeBaseId: "knowledge-base-official",
    sourceFileId: "source-file-001",
    sourcePath: "official/acme/metrics/revenue.md",
    expectedGeneratedPath: "pages/official/acme/metrics/revenue.md",
    stagedPath: "/private/run/revenue.md",
    checksumSha256: "a".repeat(64),
    queries: {
      exactPath: "pages/official/acme/metrics/revenue.md",
      exactTitle: "Revenue Metric",
      lexical: "Revenue Metric recognized delivery complete",
      naturalSentence: "Revenue Metric: Revenue is recognized after delivery is complete."
    },
    qrels: {
      exactPath: [{ sourceFileId: "source-file-001", relevance: 3 }],
      exactTitle: [{ sourceFileId: "source-file-001", relevance: 3 }],
      lexical: [{ sourceFileId: "source-file-001", relevance: 3 }],
      naturalSentence: [{ sourceFileId: "source-file-001", relevance: 3 }]
    }
  }]);
});

test("buildComprehensiveSearchCases keeps the document topic in a generic body sentence", () => {
  const rows = buildComprehensiveSearchCases({
    manifestRows: [{
      alias: "legacy-001",
      family: "legacy",
      checksumSha256: "b".repeat(64),
      pathHash: "73ce32fcb731cbf293bb03f88120ac9f6236399f684459261ccc06e2febdc97a"
    }],
    workspaceFiles: [{
      path: "legacy/law/example.md",
      checksumSha256: "b".repeat(64),
      stagedPath: "/private/run/example.md",
      contents: `---\ntitle: 示例条例\n---\n# 示例条例\n\n（2026年8月1日通过）\n`
    }],
    corpusFiles: {
      "legacy-001": { family: "legacy", sourceFileId: "source-file-legacy" }
    },
    knowledgeBases: { legacy: "knowledge-base-legacy" }
  });

  assert.equal(rows[0].queries.naturalSentence, "示例条例：（2026年8月1日通过）");
});

test("buildComprehensiveSearchCases rejects missing and duplicate corpus ownership", () => {
  const common = {
    manifestRows: [{
      alias: "official-001",
      family: "official",
      checksumSha256: "a".repeat(64),
      pathHash: "532394b88a86b83372035bd9a0c0e1ddd7378d7f92c281f5587e84e6a9cf939d"
    }],
    workspaceFiles: [{
      path: "official/acme/metrics/revenue.md",
      checksumSha256: "a".repeat(64),
      stagedPath: "/private/run/revenue.md",
      contents: "# Revenue\n\nRevenue is recognized.\n"
    }],
    knowledgeBases: { official: "knowledge-base-official" }
  };

  assert.throws(
    () => buildComprehensiveSearchCases({ ...common, corpusFiles: {} }),
    /missing corpus file/u
  );
  assert.throws(
    () => buildComprehensiveSearchCases({
      ...common,
      manifestRows: [common.manifestRows[0], common.manifestRows[0]],
      corpusFiles: {
        "official-001": { family: "official", sourceFileId: "source-file-001" }
      }
    }),
    /duplicate alias/u
  );
});

test("evaluateComprehensiveSearchObservation requires grounded source read actions", () => {
  const result = evaluateComprehensiveSearchObservation({
    expected: {
      knowledgeBaseId: "knowledge-base-official",
      sourceFileId: "source-file-001",
      expectedGeneratedPath: "pages/official/acme/metrics/revenue.md"
    },
    response: {
      items: [{
        knowledgeBaseId: "knowledge-base-official",
        sourceFileId: "source-file-001",
        path: "pages/official/acme/metrics/revenue.md",
        contentAvailable: true,
        readActions: {
          fileContentById: "/files/source-file-001/content",
          fileContentByPath: "/files/content?path=revenue.md"
        }
      }],
      semanticStatus: { state: "ready", safeCode: null },
      evidenceStatus: { completedFamilies: ["lexical"], degradedFamilies: [] },
      rerankerStatus: { state: "skipped", safeCode: "RERANKER_DISABLED" }
    }
  });

  assert.equal(result.found, true);
  assert.equal(result.rank, 1);
  assert.equal(result.pathMatched, true);
  assert.equal(result.searchResponseContainedOriginalBody, false);
  assert.equal(result.fileContentById, "/files/source-file-001/content");
  assert.equal(result.fileContentByPath, "/files/content?path=revenue.md");
  assert.equal(result.okfSignals, null);

  assert.throws(
    () => evaluateComprehensiveSearchObservation({
      expected: {
        knowledgeBaseId: "knowledge-base-official",
        sourceFileId: "source-file-001",
        expectedGeneratedPath: "pages/official/acme/metrics/revenue.md"
      },
      response: {
        items: [{
          knowledgeBaseId: "knowledge-base-official",
          sourceFileId: "source-file-001",
          path: "pages/official/acme/metrics/revenue.md",
          content: "complete source body",
          contentAvailable: true,
          readActions: {
            fileContentById: "/files/source-file-001/content",
            fileContentByPath: "/files/content?path=revenue.md"
          }
        }]
      }
    }),
    /embedded original body/u
  );
});

test("evaluateComprehensiveReturnedItems records every ranked candidate and joined source read", () => {
  const result = evaluateComprehensiveReturnedItems({
    knowledgeBaseId: "knowledge-base-official",
    items: [
      searchItem("source-file-001", "pages/official/a.md", ["title"], ["path"]),
      searchItem("source-file-002", "pages/official/b.md", ["content"], ["community"])
    ],
    sourceReads: new Map([
      ["source-file-001", sourceRead("source-file-001")],
      ["source-file-002", sourceRead("source-file-002")]
    ])
  });

  assert.deepEqual(result.map((item) => ({
    rank: item.rank,
    sourceFileId: item.sourceFileId,
    matchedFields: item.matchedFields,
    evidenceTypes: item.evidenceTypes,
    sourceReadEvidenceId: item.sourceReadEvidenceId
  })), [
    {
      rank: 1,
      sourceFileId: "source-file-001",
      matchedFields: ["title"],
      evidenceTypes: ["path"],
      sourceReadEvidenceId: "source-file-001"
    },
    {
      rank: 2,
      sourceFileId: "source-file-002",
      matchedFields: ["content"],
      evidenceTypes: ["community"],
      sourceReadEvidenceId: "source-file-002"
    }
  ]);
  assert.ok(result.every((item) => item.sourceReadMatched === true));

  assert.throws(
    () => evaluateComprehensiveReturnedItems({
      knowledgeBaseId: "knowledge-base-official",
      items: [{ ...searchItem("source-file-001", "pages/official/a.md", ["title"], ["path"]), knowledgeBaseId: "knowledge-base-other" }],
      sourceReads: new Map([["source-file-001", sourceRead("source-file-001")]])
    }),
    /crossed knowledge-base scope/u
  );
  assert.throws(
    () => evaluateComprehensiveReturnedItems({
      knowledgeBaseId: "knowledge-base-official",
      items: [searchItem("source-file-001", "pages/official/a.md", ["title"], ["path"])],
      sourceReads: new Map()
    }),
    /source read evidence/u
  );
});

test("summarizeComprehensiveSearchLatencies reports exact percentile cardinality", () => {
  assert.deepEqual(summarizeComprehensiveSearchLatencies([10, 30, 20, 40]), {
    count: 4,
    minimumMs: 10,
    p50Ms: 20,
    p90Ms: 40,
    p95Ms: 40,
    p99Ms: 40,
    maximumMs: 40,
    meanMs: 25
  });
});

test("parseRetryAfterMilliseconds accepts bounded delta seconds and HTTP dates", () => {
  assert.equal(parseRetryAfterMilliseconds("2", 1_000), 2_000);
  assert.equal(
    parseRetryAfterMilliseconds("Thu, 01 Jan 1970 00:00:03 GMT", 1_000),
    2_000
  );
  assert.equal(parseRetryAfterMilliseconds("invalid", 1_000), null);
});

test("retryComprehensiveSearchOperation honors Retry-After before bounded retry", async () => {
  const delays = [];
  let attempts = 0;
  const result = await retryComprehensiveSearchOperation(async () => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error("rate limited");
      error.status = 429;
      error.retryAfterMs = 2_000;
      throw error;
    }
    return "ready";
  }, {
    sleep: async (milliseconds) => delays.push(milliseconds)
  });

  assert.equal(result, "ready");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [2_000, 2_000]);
});

test("evaluateExpectedRerankerOutcome separates applied, safe external degradation, and defects", () => {
  assert.deepEqual(evaluateExpectedRerankerOutcome({
    requested: true,
    status: { state: "applied", safeCode: null }
  }), {
    matched: true,
    outcome: "applied",
    externalClassification: null
  });
  assert.deepEqual(evaluateExpectedRerankerOutcome({
    requested: true,
    status: { state: "degraded", safeCode: "RERANKER_TIMEOUT" }
  }), {
    matched: true,
    outcome: "safe_degraded",
    externalClassification: "transient_external_dependency"
  });
  assert.equal(evaluateExpectedRerankerOutcome({
    requested: true,
    status: { state: "degraded", safeCode: "RERANKER_AUTHENTICATION_FAILED" }
  }).matched, false);
  assert.equal(evaluateExpectedRerankerOutcome({
    requested: false,
    status: { state: "skipped", safeCode: "RERANKER_DISABLED" }
  }).matched, true);
});

test("reconcileComprehensiveSearchProviderReport preserves safe degradation without hiding defects", () => {
  const safe = reconcileComprehensiveSearchProviderReport(reconciliationReport(
    "RERANKER_TIMEOUT"
  ));
  assert.equal(safe.ok, true);
  assert.equal(safe.counts.successfulQueries, 1);
  assert.equal(safe.counts.rerankerSafeDegradedQueries, 1);
  assert.equal(safe.rows[0].queries[0].rerankerOutcome, "safe_degraded");
  assert.equal(safe.reconciliation.originalFailureCount, 1);

  const unsafe = reconcileComprehensiveSearchProviderReport(reconciliationReport(
    "RERANKER_AUTHENTICATION_FAILED"
  ));
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.counts.failures, 1);
  assert.equal(unsafe.failures[0].code, "reranker_not_applied");
});

function reconciliationReport(safeCode) {
  return {
    format: "focowiki-comprehensive-search-provider-e2e-v1",
    provider: "opensearch",
    ok: false,
    counts: {
      expectedFiles: 1,
      completedFiles: 1,
      expectedQueries: 1,
      completedQueries: 1,
      successfulQueries: 0,
      sourceReads: 2,
      failures: 1,
      expectedFilterDispositions: 3,
      completedFilterDispositions: 3
    },
    rows: [{
      alias: "official-001",
      queries: [{
        variant: "natural_sentence_hybrid_reranked",
        parameters: { rerank: "true" },
        found: true,
        pathMatched: true,
        modeMatches: true,
        scopeMatches: true,
        rerankerMatches: false,
        rerankerStatus: { state: "degraded", safeCode }
      }],
      filterDispositions: [{}, {}, {}],
      sourceRead: { matched: true },
      ok: false
    }],
    failures: [{
      alias: "official-001",
      variant: "natural_sentence_hybrid_reranked",
      code: "reranker_not_applied"
    }]
  };
}

function searchItem(sourceFileId, path, matchedFields, evidenceTypes) {
  return {
    knowledgeBaseId: "knowledge-base-official",
    sourceFileId,
    path,
    generatedFilePath: path,
    matchedFields,
    evidenceTypes,
    matchType: "hybrid",
    contentAvailable: true,
    readActions: {
      fileContentById: `/files/${sourceFileId}/content`,
      fileContentByPath: `/files/content?path=${encodeURIComponent(path)}`
    }
  };
}

function sourceRead(sourceFileId) {
  return {
    id: sourceFileId,
    byId: { status: 200, byteCount: 12, sha256: "a".repeat(64) },
    byPath: { status: 200, byteCount: 12, sha256: "a".repeat(64) },
    matched: true
  };
}
