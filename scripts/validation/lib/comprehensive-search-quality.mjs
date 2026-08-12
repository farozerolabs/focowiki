import {
  evaluateRetrievalRun
} from "./vector-retrieval-benchmark.mjs";

const CUT_OFFS = Object.freeze([1, 5, 10, 20, 50]);
const EXPECTED_SOURCE_FILES = 200;
const EXPECTED_QUERIES = 2_061;
const EXPECTED_SPECIAL_CASES = 2_358;

export function buildComprehensiveSearchQualitySummary(input) {
  const providerReport = requireProviderReport(input?.providerReport);
  const providerReportSha256 = requireSha256(
    input?.providerReportSha256,
    "provider report fingerprint"
  );
  const specialCaseReport = requireSpecialCaseReport(
    input?.specialCaseReport,
    providerReport,
    providerReportSha256
  );
  const vectorOracleReport = requireVectorOracleReport(
    input?.vectorOracleReport,
    providerReport.provider
  );
  const failures = [];
  const queries = [];
  const queryIds = new Set();

  for (const row of providerReport.rows) {
    if (row.sourceRead?.matched !== true) {
      failures.push(failure(`${row.alias}:source-read`, "source_read_mismatch"));
    }
    for (const query of row.queries) {
      const queryId = `${row.alias}:${query.variant}`;
      if (queryIds.has(queryId)) {
        throw new Error(`Comprehensive search quality has duplicate query: ${queryId}`);
      }
      queryIds.add(queryId);
      const qrels = requireArray(query.qrels, `qrels ${queryId}`);
      const returnedSourceFileIds = requireUniqueStrings(
        query.returnedSourceFileIds,
        `returned sources ${queryId}`
      );
      const relevantSourceFileIds = qrels.filter((qrel) =>
        Number.isFinite(qrel?.relevance) && qrel.relevance > 0)
        .map((qrel) => requireString(qrel.sourceFileId, `qrel source ${queryId}`));
      if (relevantSourceFileIds.length === 0) {
        throw new Error(`Comprehensive search quality query has no relevant source: ${queryId}`);
      }
      if (relevantSourceFileIds.some((sourceFileId) =>
        !returnedSourceFileIds.includes(sourceFileId))) {
        failures.push(failure(queryId, "required_source_missing"));
      }
      if (
        query.status !== 200 || query.found !== true
        || query.pathMatched !== true || query.modeMatches !== true
        || query.scopeMatches !== true || query.rerankerMatches !== true
      ) {
        failures.push(failure(queryId, "query_contract_failed"));
      }
      queries.push({
        queryId,
        variant: query.variant,
        qrels: qrels.map((qrel) => ({
          queryId,
          corpusId: requireString(qrel.sourceFileId, `qrel source ${queryId}`),
          relevance: qrel.relevance
        })),
        returnedSourceFileIds,
        latencyMs: requireNonnegativeNumber(query.latencyMs, `latency ${queryId}`),
        semanticState: query.semanticStatus?.state ?? null
      });
    }
  }
  if (queries.length !== EXPECTED_QUERIES) {
    throw new Error(
      `Comprehensive search quality requires ${EXPECTED_QUERIES} queries; got ${queries.length}`
    );
  }

  const overall = evaluateQueries(queries);
  const variants = Object.fromEntries([...Map.groupBy(queries, (query) => query.variant)]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([variant, variantQueries]) => [variant, {
      queryCount: variantQueries.length,
      metrics: evaluateQueries(variantQueries).metrics
    }]));
  const noResultCases = specialCaseReport.cases.filter((item) =>
    item.category === "no_result");
  if (noResultCases.length === 0) {
    throw new Error("Comprehensive search quality requires no-result cases");
  }
  const noResultFalsePositiveCount = noResultCases.filter((item) =>
    item.ok !== true || item.observation?.returnedItemCount !== 0).length;
  for (const item of noResultCases.filter((value) =>
    value.ok !== true || value.observation?.returnedItemCount !== 0)) {
    failures.push(failure(item.caseId, "no_result_false_positive"));
  }
  if (vectorOracleReport.querySummary.annRecall.minimum !== 1) {
    failures.push(failure("vector-oracle", "ann_recall_below_one"));
  }
  const wallDurationMs = new Date(providerReport.finishedAt).getTime()
    - new Date(providerReport.startedAt).getTime();
  if (!Number.isFinite(wallDurationMs) || wallDurationMs <= 0) {
    throw new Error("Comprehensive search quality provider duration is invalid");
  }
  const metrics = overall.metrics;
  if (metrics[50].recall !== 1) {
    failures.push(failure("all-queries@50", "recall_below_one"));
  }

  return {
    schemaVersion: 1,
    format: "focowiki-comprehensive-search-quality-summary-v1",
    provider: providerReport.provider,
    providerReportSha256,
    ok: failures.length === 0,
    counts: {
      sourceFiles: providerReport.rows.length,
      queries: queries.length,
      specialCases: specialCaseReport.cases.length,
      noResultCases: noResultCases.length,
      vectorQueries: vectorOracleReport.counts.vectorQueries,
      semanticallyReadyQueries: queries.filter((query) =>
        query.semanticState === "ready").length,
      safelyDegradedQueries: queries.filter((query) =>
        query.semanticState === "degraded").length
    },
    metrics,
    variants,
    noResultFalsePositiveRate: noResultFalsePositiveCount / noResultCases.length,
    annRecall: structuredClone(vectorOracleReport.querySummary.annRecall),
    latencyMs: structuredClone(providerReport.latencyMs),
    wallDurationMs,
    successfulQueriesPerSecond: queries.length / (wallDurationMs / 1_000),
    failures
  };
}

function evaluateQueries(queries) {
  return evaluateRetrievalRun({
    queryIds: queries.map((query) => query.queryId),
    qrels: queries.flatMap((query) => query.qrels),
    runs: Object.fromEntries(queries.map((query) => [
      query.queryId,
      query.returnedSourceFileIds
    ])),
    cutoffs: CUT_OFFS
  });
}

function requireProviderReport(report) {
  if (
    !report || report.format !== "focowiki-comprehensive-search-provider-e2e-v1"
    || report.ok !== true || typeof report.provider !== "string"
    || report.counts?.expectedFiles !== EXPECTED_SOURCE_FILES
    || report.counts?.completedFiles !== EXPECTED_SOURCE_FILES
    || report.counts?.expectedQueries !== EXPECTED_QUERIES
    || report.counts?.completedQueries !== EXPECTED_QUERIES
    || report.counts?.successfulQueries !== EXPECTED_QUERIES
    || report.counts?.failures !== 0
    || !Array.isArray(report.rows) || report.rows.length !== EXPECTED_SOURCE_FILES
    || !Array.isArray(report.failures) || report.failures.length !== 0
  ) {
    throw new Error("Comprehensive search quality provider report is incomplete");
  }
  return report;
}

function requireSpecialCaseReport(report, providerReport, providerReportSha256) {
  if (
    !report || report.format !== "focowiki-comprehensive-search-special-case-e2e-v1"
    || report.ok !== true || report.provider !== providerReport.provider
    || report.providerReportSha256 !== providerReportSha256
  ) {
    throw new Error("Comprehensive search quality special-case provider report fingerprint differs");
  }
  if (
    report.counts?.expectedCases !== EXPECTED_SPECIAL_CASES
    || report.counts?.completedCases !== EXPECTED_SPECIAL_CASES
    || report.counts?.passedCases !== EXPECTED_SPECIAL_CASES
    || report.counts?.failedCases !== 0
    || !Array.isArray(report.cases) || report.cases.length !== EXPECTED_SPECIAL_CASES
    || !Array.isArray(report.failures) || report.failures.length !== 0
  ) {
    throw new Error("Comprehensive search quality special-case report is incomplete");
  }
  return report;
}

function requireVectorOracleReport(report, provider) {
  if (
    !report || report.format !== "focowiki-comprehensive-vector-oracle-v1"
    || report.ok !== true || report.provider !== provider
    || !Number.isInteger(report.counts?.vectorQueries)
    || report.counts.vectorQueries <= 0
    || report.counts.successfulVectorQueries !== report.counts.vectorQueries
    || report.counts.failedVectorQueries !== 0
    || report.querySummary?.total !== report.counts.vectorQueries
    || report.querySummary?.passed !== report.counts.vectorQueries
    || report.querySummary?.failed !== 0
    || !report.querySummary?.annRecall
    || !Array.isArray(report.failures) || report.failures.length !== 0
  ) {
    throw new Error("Comprehensive search quality vector-oracle report is incomplete");
  }
  return report;
}

function failure(id, code) {
  return { id, code };
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requireUniqueStrings(value, label) {
  const values = requireArray(value, label).map((item) => requireString(item, label));
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} contains duplicates`);
  }
  return values;
}

function requireString(value, label) {
  if (typeof value !== "string" || value === "") throw new Error(`${label} is required`);
  return value;
}

function requireSha256(value, label) {
  if (!/^[a-f0-9]{64}$/u.test(value ?? "")) throw new Error(`${label} is invalid`);
  return value;
}

function requireNonnegativeNumber(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}
