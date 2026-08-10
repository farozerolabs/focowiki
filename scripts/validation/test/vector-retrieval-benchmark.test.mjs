import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  annRecallAtK,
  annThresholdAgreementAtK,
  benchmarkFingerprint,
  deterministicBootstrapInterval,
  evaluateRetrievalRun,
  exactCosineNeighbors,
  freezeBenchmarkCollection,
  compareSparseIndexingQuality,
  projectLargeCorpusIndexing,
  summarizePerformanceSamples
} from "../lib/vector-retrieval-benchmark.mjs";
import {
  compareBenchmarkRun,
  promoteAcceptedBenchmarkBaseline,
  writeBenchmarkRunReport
} from "../lib/vector-retrieval-report.mjs";

test("freezes immutable BEIR/TREC collection records and stable stratified splits", () => {
  const collection = freezeBenchmarkCollection({
    corpus: [
      { _id: "d1", title: "Alpha", text: "First source" },
      { _id: "d2", title: "Beta", text: "Second source" }
    ],
    queries: Array.from({ length: 10 }, (_, index) => ({
      _id: `q${index + 1}`,
      text: `Question ${index + 1}`,
      category: index % 2 === 0 ? "lexical" : "semantic"
    })),
    qrels: Array.from({ length: 10 }, (_, index) => ({
      queryId: `q${index + 1}`,
      corpusId: index % 2 === 0 ? "d1" : "d2",
      relevance: 2
    })),
    seed: 20260809
  });

  assert.equal(collection.developmentQueryIds.length, 2);
  assert.equal(collection.testQueryIds.length, 8);
  assert.deepEqual(
    new Set([...collection.developmentQueryIds, ...collection.testQueryIds]),
    new Set(collection.queries.map((query) => query._id))
  );
  assert.match(collection.collectionSha256, /^[0-9a-f]{64}$/u);
  assert.throws(() => collection.corpus.push({}), TypeError);
});

test("rejects qrel grades outside the frozen 0/1/2 contract", () => {
  assert.throws(() => freezeBenchmarkCollection({
    corpus: [{ _id: "d1", title: "Alpha", text: "First source" }],
    queries: [{ _id: "q1", text: "Question", category: "semantic" }],
    qrels: [{ queryId: "q1", corpusId: "d1", relevance: 3 }],
    seed: 20260809
  }), /qrel relevance is outside the accepted range/u);
});

test("calculates nDCG, Recall, Precision, MAP, MRR and no-result rate at every cutoff", () => {
  const result = evaluateRetrievalRun({
    queryIds: ["q1", "q2", "q3"],
    qrels: [
      { queryId: "q1", corpusId: "d1", relevance: 2 },
      { queryId: "q1", corpusId: "d2", relevance: 1 },
      { queryId: "q2", corpusId: "d3", relevance: 2 }
    ],
    runs: {
      q1: ["d1", "d3", "d2"],
      q2: ["d3", "d1"],
      q3: []
    },
    cutoffs: [1, 3, 5, 10, 20, 50]
  });

  assert.equal(result.metrics[1].ndcg, 1);
  assert.equal(result.metrics[1].recall, 0.75);
  assert.equal(result.metrics[1].precision, 1);
  assert.equal(result.metrics[3].map, 0.9166666666666666);
  assert.equal(result.metrics[10].mrr, 1);
  assert.equal(result.noResultFalsePositiveRate, 0);
  assert.deepEqual(Object.keys(result.metrics), ["1", "3", "5", "10", "20", "50"]);
});

test("produces repeatable deterministic bootstrap confidence intervals", () => {
  const values = [0.7, 0.8, 0.9, 1];
  const first = deterministicBootstrapInterval({
    values, confidence: 0.95, iterations: 2_000, seed: 42
  });
  const second = deterministicBootstrapInterval({
    values, confidence: 0.95, iterations: 2_000, seed: 42
  });
  assert.deepEqual(first, second);
  assert.ok(first.lower <= first.mean && first.mean <= first.upper);
});

test("compares approximate neighbors with an exact normalized cosine oracle", () => {
  const exact = exactCosineNeighbors({
    queryVector: [1, 0],
    documents: [
      { id: "d1", vector: [1, 0] },
      { id: "d2", vector: [0.8, 0.2] },
      { id: "d3", vector: [0, 1] }
    ],
    minimumRelevance: 0.5,
    limit: 3
  });
  assert.deepEqual(exact.map((item) => item.id), ["d1", "d2"]);
  assert.equal(annRecallAtK({ expected: exact, actualIds: ["d2", "d1"], k: 2 }), 1);
  assert.equal(annRecallAtK({ expected: exact, actualIds: ["d1", "d3"], k: 2 }), 0.5);
  assert.deepEqual(annThresholdAgreementAtK({
    expected: [],
    actualIds: ["d3"],
    k: 2,
    exactSetComplete: true
  }), {
    evaluated: true,
    passed: false,
    unexpectedHitCount: 1
  });
  assert.deepEqual(annThresholdAgreementAtK({
    expected: exact,
    actualIds: ["d2", "d1"],
    k: 2,
    exactSetComplete: true
  }), {
    evaluated: true,
    passed: true,
    unexpectedHitCount: 0
  });
});

test("summarizes cold/warm latency, service time, throughput, errors, CPU, and RSS", () => {
  const summary = summarizePerformanceSamples({
    durationMs: 1_000,
    samples: [
      { latencyMs: 10, serviceTimeMs: 8, ok: true, cpuPercent: 20, rssBytes: 100 },
      { latencyMs: 20, serviceTimeMs: 15, ok: true, cpuPercent: 30, rssBytes: 120 },
      { latencyMs: 30, serviceTimeMs: 25, ok: false, cpuPercent: 25, rssBytes: 110 }
    ]
  });
  assert.deepEqual(summary.latencyMs, { p50: 20, p90: 30, p95: 30, p99: 30 });
  assert.equal(summary.successfulQueriesPerSecond, 2);
  assert.equal(summary.errorRate, 1 / 3);
  assert.equal(summary.peakCpuPercent, 30);
  assert.equal(summary.peakRssBytes, 120);
});

test("rejects sparse indexing when any complete-coverage or recorded quality metric regresses", () => {
  const baseline = indexingQuality();
  const candidate = structuredClone(baseline);
  assert.equal(compareSparseIndexingQuality({ baseline, candidate }).passed, true);

  candidate.coverage.contentVector = 199;
  candidate.categories.general.ndcg = 0.899_998;
  const failed = compareSparseIndexingQuality({ baseline, candidate });
  assert.equal(failed.passed, false);
  assert.deepEqual(failed.failures, [
    "coverage.contentVector",
    "categories.general.ndcg"
  ]);
});

test("projects 20,000-file completion from measured stage distributions and enforces both speed gates", () => {
  const result = projectLargeCorpusIndexing({
    sampleFileCount: 100,
    targetFileCount: 20_000,
    baselineProjectedMs: 20 * 24 * 60 * 60 * 1_000,
    maximumProjectedMs: 24 * 60 * 60 * 1_000,
    minimumSpeedup: 20,
    stages: [
      { stage: "base", completedUnits: 100, serviceTimeMs: 100_000, concurrency: 4 },
      { stage: "generation", completedUnits: 5, serviceTimeMs: 300_000, concurrency: 2 },
      { stage: "embedding", completedUnits: 300, serviceTimeMs: 150_000, concurrency: 4 },
      { stage: "publication", completedUnits: 2, serviceTimeMs: 20_000, concurrency: 1 }
    ],
    observedCounts: {
      sourceRevisions: 100,
      selectedSources: 5,
      completeCoverageSources: 100,
      sourceModelGenerationRequests: 0,
      graphRagGenerationRequests: 5,
      nonSelectedGenerationRequests: 0,
      embeddingInputs: 300,
      embeddingRequests: 19,
      publicationBuilds: 2
    },
    peakCpuPercent: 180,
    peakRssBytes: 700_000_000
  });

  assert.equal(result.passed, true);
  assert.ok(result.speedup >= 20);
  assert.ok(result.projectedCompletionMs <= 24 * 60 * 60 * 1_000);
  assert.equal(result.projectedCounts.selectedSources, 1_000);
  assert.equal(result.selectedSourceRatio, 0.05);
  assert.deepEqual(result.resources, {
    peakCpuPercent: 180,
    peakRssBytes: 700_000_000
  });
});

test("rejects a hidden mandatory per-source generation path", () => {
  const result = projectLargeCorpusIndexing({
    sampleFileCount: 100,
    targetFileCount: 20_000,
    baselineProjectedMs: 20 * 24 * 60 * 60 * 1_000,
    maximumProjectedMs: 24 * 60 * 60 * 1_000,
    minimumSpeedup: 20,
    stages: [{ stage: "base", completedUnits: 100, serviceTimeMs: 10_000, concurrency: 4 }],
    observedCounts: {
      sourceRevisions: 100,
      selectedSources: 5,
      completeCoverageSources: 100,
      sourceModelGenerationRequests: 100,
      graphRagGenerationRequests: 5,
      nonSelectedGenerationRequests: 95
    },
    peakCpuPercent: 100,
    peakRssBytes: 500_000_000
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.failures, [
    "completeCoverageGenerationSelection",
    "nonSelectedGenerationRequests"
  ]);
});

test("fingerprints safe reproducibility fields and enforces comparable regression budgets", () => {
  const fingerprint = benchmarkFingerprint({
    corpusSha256: "a".repeat(64),
    queryQrelsSha256: "b".repeat(64),
    codeRevision: "revision-a",
    generationModelFingerprint: "generation-a",
    embeddingModelFingerprint: "embedding-a",
    rerankerModelFingerprint: "reranker-a",
    dimension: 3,
    provider: "opensearch",
    providerVersion: "3.8.0",
    providerSettingsSha256: "c".repeat(64),
    hostFingerprint: "host-a",
    containerBudgetSha256: "d".repeat(64),
    warmup: 10,
    repetitions: 3,
    concurrency: 20,
    seed: 42
  });
  assert.match(fingerprint.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(fingerprint).includes("/Users/"), false);

  const comparison = compareBenchmarkRun({
    baseline: report(fingerprint, { ndcg10: 0.9, warmP95Ms: 100, throughput: 100 }),
    candidate: report(fingerprint, { ndcg10: 0.88, warmP95Ms: 112, throughput: 88 })
  });
  assert.equal(comparison.comparability, "comparable");
  assert.equal(comparison.passed, false);
  assert.deepEqual(comparison.failedBudgets.sort(), [
    "ndcg_at_10", "throughput", "warm_p95"
  ]);
});

test("enforces exact-path and no-result absolute retrieval gates", () => {
  const fingerprint = benchmarkFingerprint({
    corpusSha256: "a".repeat(64), queryQrelsSha256: "b".repeat(64),
    codeRevision: "revision-a", generationModelFingerprint: "generation-a",
    embeddingModelFingerprint: "embedding-a", rerankerModelFingerprint: "reranker-a",
    dimension: 3, provider: "opensearch", providerVersion: "3.8.0",
    providerSettingsSha256: "c".repeat(64), hostFingerprint: "host-a",
    containerBudgetSha256: "d".repeat(64), warmup: 10, repetitions: 3,
    concurrency: 20, seed: 42
  });
  const comparison = compareBenchmarkRun({
    baseline: report(fingerprint, {}),
    candidate: report(fingerprint, {
      exactPathRecall10: 0.99,
      noResultFalsePositiveRate: 0.051
    })
  });
  assert.equal(comparison.passed, false);
  assert.deepEqual(comparison.failedBudgets.sort(), [
    "exact_path_recall_at_10", "no_result_false_positive_rate"
  ]);
});

test("writes atomic redacted run evidence and promotes only explicit three-round green baselines", async () => {
  const root = await mkdtemp(join(tmpdir(), "focowiki-vector-benchmark-"));
  const fingerprint = benchmarkFingerprint({
    corpusSha256: "a".repeat(64), queryQrelsSha256: "b".repeat(64),
    codeRevision: "revision-a", generationModelFingerprint: "generation-a",
    embeddingModelFingerprint: "embedding-a", rerankerModelFingerprint: "reranker-a",
    dimension: 3, provider: "opensearch", providerVersion: "3.8.0",
    providerSettingsSha256: "c".repeat(64), hostFingerprint: "host-a",
    containerBudgetSha256: "d".repeat(64), warmup: 10, repetitions: 3,
    concurrency: 20, seed: 42
  });
  const rounds = [];
  for (let index = 1; index <= 3; index += 1) {
    rounds.push(await writeBenchmarkRunReport({
      root,
      runId: `round-${index}`,
      status: "passed",
      fingerprint,
      metrics: report(fingerprint, {}).metrics,
      thresholds: { ndcg10: 0.85 },
      comparisons: {},
      queryRegressions: [{ queryId: "q-opaque", delta: -0.001 }]
    }));
  }
  assert.equal(JSON.parse(await readFile(join(root, "latest.json"), "utf8")).runId,
    "round-3");
  await stat(join(root, "runs", "round-1", "summary.md"));
  await assert.rejects(() => promoteAcceptedBenchmarkBaseline({
    root, runIds: ["round-1", "round-2"]
  }));
  await promoteAcceptedBenchmarkBaseline({
    root, runIds: rounds.map((round) => round.runId)
  });
  const baseline = JSON.parse(await readFile(join(root, "accepted-baseline.json"), "utf8"));
  assert.equal(baseline.runId, "round-3");
  assert.equal(JSON.stringify(baseline).includes("private corpus text"), false);
});

function report(fingerprint, overrides) {
  return {
    status: "passed",
    fingerprint,
    metrics: {
      ndcg10: 0.9,
      recall20: 0.96,
      mrr10: 0.9,
      precision10: 0.8,
      map10: 0.85,
      annRecall10: 0.96,
      annRecall50: 0.96,
      warmP95Ms: 100,
      throughput: 100,
      peakCpuPercent: 50,
      peakRssBytes: 500,
      exactPathRecall10: 1,
      exactTitleRecall10: 1,
      noResultFalsePositiveRate: 0,
      nominalErrorRate: 0,
      ...overrides
    }
  };
}

function indexingQuality() {
  return {
    sourceCount: 200,
    coverage: {
      exactPath: 200,
      exactTitle: 200,
      lexical: 200,
      jieba: 200,
      contentVector: 200,
      fileGraph: 200,
      provider: 200,
      selectionOwnership: 200
    },
    metrics: { ndcg: 0.9, recall: 0.96, mrr: 0.91 },
    categories: {
      exact: { ndcg: 1, recall: 1, mrr: 1 },
      general: { ndcg: 0.9, recall: 0.96, mrr: 0.91 }
    }
  };
}
