import { createHash } from "node:crypto";

export function freezeBenchmarkCollection(input) {
  const corpus = normalizeCorpus(input?.corpus);
  const queries = normalizeQueries(input?.queries);
  const qrels = normalizeQrels(input?.qrels, corpus, queries);
  const seed = requireInteger(input?.seed, "seed", 0);
  const developmentQueryIds = [];
  const testQueryIds = [];
  const categories = Map.groupBy(queries, (query) => query.category);

  for (const [category, categoryQueries] of [...categories.entries()]
    .sort(([left], [right]) => left.localeCompare(right))) {
    const ranked = [...categoryQueries].sort((left, right) =>
      seededRank(seed, category, left._id).localeCompare(
        seededRank(seed, category, right._id)
      ) || left._id.localeCompare(right._id)
    );
    const developmentCount = ranked.length < 2
      ? 0
      : Math.max(1, Math.floor(ranked.length * 0.2));
    developmentQueryIds.push(...ranked.slice(0, developmentCount).map((query) => query._id));
    testQueryIds.push(...ranked.slice(developmentCount).map((query) => query._id));
  }

  developmentQueryIds.sort();
  testQueryIds.sort();
  const collectionSha256 = sha256({ corpus, queries, qrels, seed });
  return deepFreeze({
    format: "focowiki-vector-retrieval-collection-v1",
    corpus,
    queries,
    qrels,
    seed,
    developmentQueryIds,
    testQueryIds,
    collectionSha256
  });
}

export function evaluateRetrievalRun(input) {
  const queryIds = requireUniqueStrings(input?.queryIds, "queryIds");
  const cutoffs = [...new Set((input?.cutoffs ?? []).map((value) =>
    requireInteger(value, "cutoff", 1)
  ))].sort((left, right) => left - right);
  if (cutoffs.length === 0) throw new Error("At least one retrieval cutoff is required");

  const knownQueries = new Set(queryIds);
  const qrelsByQuery = new Map(queryIds.map((queryId) => [queryId, new Map()]));
  for (const qrel of input?.qrels ?? []) {
    const queryId = requireSafeIdentifier(qrel?.queryId, "qrel queryId");
    const corpusId = requireSafeIdentifier(qrel?.corpusId, "qrel corpusId");
    const relevance = requireFiniteNumber(qrel?.relevance, "qrel relevance", 0);
    if (!knownQueries.has(queryId)) throw new Error(`Unknown qrel query: ${queryId}`);
    const queryQrels = qrelsByQuery.get(queryId);
    if (queryQrels.has(corpusId)) {
      throw new Error(`Duplicate qrel for ${queryId}/${corpusId}`);
    }
    queryQrels.set(corpusId, relevance);
  }

  const runs = input?.runs;
  if (!runs || typeof runs !== "object" || Array.isArray(runs)) {
    throw new Error("Retrieval runs must be an object keyed by query ID");
  }
  for (const runQueryId of Object.keys(runs)) {
    if (!knownQueries.has(runQueryId)) throw new Error(`Unknown run query: ${runQueryId}`);
  }

  const rankedByQuery = new Map();
  for (const queryId of queryIds) {
    rankedByQuery.set(
      queryId,
      requireUniqueStrings(runs[queryId] ?? [], `run ${queryId}`)
    );
  }

  const relevantQueryIds = queryIds.filter((queryId) =>
    [...qrelsByQuery.get(queryId).values()].some((relevance) => relevance > 0)
  );
  const noResultQueryIds = queryIds.filter((queryId) =>
    !relevantQueryIds.includes(queryId)
  );
  const falsePositiveCount = noResultQueryIds.filter((queryId) =>
    rankedByQuery.get(queryId).length > 0
  ).length;
  const perQuery = {};
  const metrics = {};

  for (const cutoff of cutoffs) {
    const values = relevantQueryIds.map((queryId) => queryMetricsAtCutoff({
      rankedIds: rankedByQuery.get(queryId),
      qrels: qrelsByQuery.get(queryId),
      cutoff
    }));
    metrics[cutoff] = {
      ndcg: mean(values.map((value) => value.ndcg)),
      recall: mean(values.map((value) => value.recall)),
      precision: mean(values.map((value) => value.precision)),
      map: mean(values.map((value) => value.map)),
      mrr: mean(values.map((value) => value.mrr))
    };
    perQuery[cutoff] = Object.fromEntries(relevantQueryIds.map((queryId, index) =>
      [queryId, values[index]]
    ));
  }

  return deepFreeze({
    metrics,
    perQuery,
    evaluatedQueryCount: relevantQueryIds.length,
    noResultQueryCount: noResultQueryIds.length,
    noResultFalsePositiveRate: noResultQueryIds.length === 0
      ? 0
      : falsePositiveCount / noResultQueryIds.length
  });
}

export function deterministicBootstrapInterval(input) {
  const values = (input?.values ?? []).map((value) =>
    requireFiniteNumber(value, "bootstrap value")
  );
  if (values.length === 0) throw new Error("Bootstrap values must not be empty");
  const confidence = requireFiniteNumber(input?.confidence, "confidence", 0, 1);
  if (confidence === 0 || confidence === 1) {
    throw new Error("Bootstrap confidence must be between zero and one");
  }
  const iterations = requireInteger(input?.iterations, "iterations", 1);
  const seed = requireInteger(input?.seed, "seed", 0);
  const random = createDeterministicRandom(seed);
  const sampledMeans = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) {
      total += values[Math.floor(random() * values.length)];
    }
    sampledMeans.push(total / values.length);
  }
  sampledMeans.sort((left, right) => left - right);
  const tail = (1 - confidence) / 2;
  return deepFreeze({
    mean: mean(values),
    lower: quantile(sampledMeans, tail),
    upper: quantile(sampledMeans, 1 - tail),
    confidence,
    iterations,
    seed
  });
}

export function exactCosineNeighbors(input) {
  const queryVector = requireVector(input?.queryVector, "queryVector");
  const minimumRelevance = requireFiniteNumber(
    input?.minimumRelevance,
    "minimumRelevance",
    -1,
    1
  );
  const limit = requireInteger(input?.limit, "limit", 1);
  const queryNorm = vectorNorm(queryVector);
  if (queryNorm === 0) throw new Error("Query vector must have a nonzero norm");
  const documentIds = new Set();
  const neighbors = (input?.documents ?? []).map((document) => {
    const id = requireSafeIdentifier(document?.id, "document id");
    if (documentIds.has(id)) throw new Error(`Duplicate vector document: ${id}`);
    documentIds.add(id);
    const vector = requireVector(document?.vector, `document vector ${id}`);
    if (vector.length !== queryVector.length) {
      throw new Error(`Vector dimension mismatch for ${id}`);
    }
    const norm = vectorNorm(vector);
    if (norm === 0) throw new Error(`Document vector must have a nonzero norm: ${id}`);
    let dot = 0;
    for (let index = 0; index < vector.length; index += 1) {
      dot += queryVector[index] * vector[index];
    }
    return { id, score: dot / (queryNorm * norm) };
  }).filter((item) => item.score >= minimumRelevance)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit);
  return deepFreeze(neighbors);
}

export function annRecallAtK(input) {
  const cutoff = requireInteger(input?.k, "k", 1);
  const expectedIds = (input?.expected ?? []).slice(0, cutoff).map((item) =>
    requireSafeIdentifier(typeof item === "string" ? item : item?.id, "expected id")
  );
  if (expectedIds.length === 0) return 1;
  const actualIds = new Set((input?.actualIds ?? []).slice(0, cutoff).map((id) =>
    requireSafeIdentifier(id, "actual id")
  ));
  return expectedIds.filter((id) => actualIds.has(id)).length / expectedIds.length;
}

export function annThresholdAgreementAtK(input) {
  const cutoff = requireInteger(input?.k, "k", 1);
  const exactSetComplete = requireBoolean(
    input?.exactSetComplete,
    "exactSetComplete"
  );
  const expectedIds = requireUniqueStrings(
    (input?.expected ?? []).map((item) =>
      requireSafeIdentifier(
        typeof item === "string" ? item : item?.id,
        "expected id"
      )
    ),
    "expected"
  );
  if (exactSetComplete && expectedIds.length > cutoff) {
    throw new Error("A complete exact threshold set must fit inside the cutoff");
  }
  if (!exactSetComplete) {
    return deepFreeze({
      evaluated: false,
      passed: true,
      unexpectedHitCount: 0
    });
  }
  const expected = new Set(expectedIds);
  const actualIds = requireUniqueStrings(
    (input?.actualIds ?? []).slice(0, cutoff),
    "actualIds"
  );
  const unexpectedHitCount = actualIds.filter((id) => !expected.has(id)).length;
  return deepFreeze({
    evaluated: true,
    passed: unexpectedHitCount === 0,
    unexpectedHitCount
  });
}

export function summarizePerformanceSamples(input) {
  const durationMs = requireFiniteNumber(input?.durationMs, "durationMs", 0);
  if (durationMs === 0) throw new Error("Performance duration must be positive");
  const samples = (input?.samples ?? []).map((sample, index) => ({
    latencyMs: requireFiniteNumber(sample?.latencyMs, `sample ${index} latencyMs`, 0),
    serviceTimeMs: requireFiniteNumber(
      sample?.serviceTimeMs,
      `sample ${index} serviceTimeMs`,
      0
    ),
    ok: requireBoolean(sample?.ok, `sample ${index} ok`),
    cpuPercent: requireFiniteNumber(sample?.cpuPercent, `sample ${index} cpuPercent`, 0),
    rssBytes: requireFiniteNumber(sample?.rssBytes, `sample ${index} rssBytes`, 0)
  }));
  if (samples.length === 0) throw new Error("Performance samples must not be empty");
  const successfulCount = samples.filter((sample) => sample.ok).length;
  return deepFreeze({
    sampleCount: samples.length,
    successfulCount,
    failedCount: samples.length - successfulCount,
    durationMs,
    latencyMs: percentileSummary(samples.map((sample) => sample.latencyMs)),
    serviceTimeMs: percentileSummary(samples.map((sample) => sample.serviceTimeMs)),
    successfulQueriesPerSecond: successfulCount / (durationMs / 1_000),
    errorRate: (samples.length - successfulCount) / samples.length,
    peakCpuPercent: Math.max(...samples.map((sample) => sample.cpuPercent)),
    peakRssBytes: Math.max(...samples.map((sample) => sample.rssBytes))
  });
}

export function compareSparseIndexingQuality(input) {
  const precision = requireInteger(input?.decimalPlaces ?? 6, "decimalPlaces", 0);
  if (precision > 12) throw new Error("decimalPlaces is outside the accepted range");
  const baseline = requireIndexingQuality(input?.baseline, "baseline");
  const candidate = requireIndexingQuality(input?.candidate, "candidate");
  const failures = [];
  if (candidate.sourceCount !== baseline.sourceCount) failures.push("sourceCount");
  for (const [lane, count] of Object.entries(candidate.coverage)) {
    if (count !== candidate.sourceCount) failures.push(`coverage.${lane}`);
  }
  compareQualityRecord(
    baseline.metrics,
    candidate.metrics,
    "metrics",
    precision,
    failures
  );
  const categoryNames = new Set([
    ...Object.keys(baseline.categories),
    ...Object.keys(candidate.categories)
  ]);
  for (const category of [...categoryNames].sort()) {
    const baselineCategory = baseline.categories[category];
    const candidateCategory = candidate.categories[category];
    if (!baselineCategory || !candidateCategory) {
      failures.push(`categories.${category}`);
      continue;
    }
    compareQualityRecord(
      baselineCategory,
      candidateCategory,
      `categories.${category}`,
      precision,
      failures
    );
  }
  return deepFreeze({ passed: failures.length === 0, failures });
}

export function projectLargeCorpusIndexing(input) {
  const sampleFileCount = requireInteger(
    input?.sampleFileCount,
    "sampleFileCount",
    1
  );
  const targetFileCount = requireInteger(
    input?.targetFileCount,
    "targetFileCount",
    sampleFileCount
  );
  const baselineProjectedMs = requireFiniteNumber(
    input?.baselineProjectedMs,
    "baselineProjectedMs",
    Number.EPSILON
  );
  const maximumProjectedMs = requireFiniteNumber(
    input?.maximumProjectedMs,
    "maximumProjectedMs",
    Number.EPSILON
  );
  const minimumSpeedup = requireFiniteNumber(
    input?.minimumSpeedup,
    "minimumSpeedup",
    1
  );
  if (!Array.isArray(input?.stages) || input.stages.length === 0) {
    throw new Error("Measured indexing stages must not be empty");
  }
  const stageNames = new Set();
  const stages = input.stages.map((stage, index) => {
    const name = requireSafeIdentifier(stage?.stage, `stage ${index}`);
    if (stageNames.has(name)) throw new Error(`Duplicate indexing stage: ${name}`);
    stageNames.add(name);
    const completedUnits = requireInteger(
      stage?.completedUnits,
      `${name} completedUnits`,
      1
    );
    const serviceTimeMs = requireFiniteNumber(
      stage?.serviceTimeMs,
      `${name} serviceTimeMs`,
      Number.EPSILON
    );
    const concurrency = requireInteger(stage?.concurrency, `${name} concurrency`, 1);
    const projectedUnits = completedUnits / sampleFileCount * targetFileCount;
    const projectedWallMs = serviceTimeMs / completedUnits
      * projectedUnits / concurrency;
    return {
      stage: name,
      completedUnits,
      serviceTimeMs,
      concurrency,
      unitsPerSource: completedUnits / sampleFileCount,
      projectedUnits,
      projectedWallMs
    };
  });
  const projectedCompletionMs = stages.reduce(
    (total, stage) => total + stage.projectedWallMs,
    0
  );
  const speedup = baselineProjectedMs / projectedCompletionMs;
  const observedCounts = requireNonnegativeNumberRecord(
    input?.observedCounts,
    "observedCounts"
  );
  const projectedCounts = Object.fromEntries(Object.entries(observedCounts).map(
    ([name, value]) => [name, value / sampleFileCount * targetFileCount]
  ));
  const selectedSources = observedCounts.selectedSources;
  const sourceRevisions = observedCounts.sourceRevisions;
  const completeCoverageSources = observedCounts.completeCoverageSources;
  const sourceModelGenerationRequests = observedCounts.sourceModelGenerationRequests;
  const graphRagGenerationRequests = observedCounts.graphRagGenerationRequests;
  const nonSelectedGenerationRequests = observedCounts.nonSelectedGenerationRequests;
  if (selectedSources === undefined || sourceRevisions === undefined
    || completeCoverageSources === undefined
    || sourceModelGenerationRequests === undefined
    || graphRagGenerationRequests === undefined
    || nonSelectedGenerationRequests === undefined
    || sourceRevisions !== sampleFileCount || selectedSources > sourceRevisions) {
    throw new Error("Observed source selection counts are invalid");
  }
  const resources = {
    peakCpuPercent: requireFiniteNumber(
      input?.peakCpuPercent,
      "peakCpuPercent",
      0
    ),
    peakRssBytes: requireFiniteNumber(input?.peakRssBytes, "peakRssBytes", 0)
  };
  const failures = [];
  if (speedup < minimumSpeedup) failures.push("minimumSpeedup");
  if (projectedCompletionMs > maximumProjectedMs) {
    failures.push("maximumProjectedCompletion");
  }
  if (completeCoverageSources !== sourceRevisions
    || sourceModelGenerationRequests !== 0) {
    failures.push("completeCoverageGenerationSelection");
  }
  if (nonSelectedGenerationRequests !== 0) {
    failures.push("nonSelectedGenerationRequests");
  }
  return deepFreeze({
    passed: failures.length === 0,
    failures,
    sampleFileCount,
    targetFileCount,
    baselineProjectedMs,
    projectedCompletionMs,
    speedup,
    selectedSourceRatio: selectedSources / sourceRevisions,
    projectedCounts,
    stages,
    resources
  });
}

export function benchmarkFingerprint(input) {
  const fingerprint = {
    format: "focowiki-vector-retrieval-fingerprint-v1",
    corpusSha256: requireSha256(input?.corpusSha256, "corpusSha256"),
    queryQrelsSha256: requireSha256(input?.queryQrelsSha256, "queryQrelsSha256"),
    codeRevision: requireSafeFingerprint(input?.codeRevision, "codeRevision"),
    generationModelFingerprint: requireSafeFingerprint(
      input?.generationModelFingerprint,
      "generationModelFingerprint"
    ),
    embeddingModelFingerprint: requireSafeFingerprint(
      input?.embeddingModelFingerprint,
      "embeddingModelFingerprint"
    ),
    rerankerModelFingerprint: requireSafeFingerprint(
      input?.rerankerModelFingerprint,
      "rerankerModelFingerprint"
    ),
    dimension: requireInteger(input?.dimension, "dimension", 1),
    provider: requireSafeFingerprint(input?.provider, "provider"),
    providerVersion: requireSafeFingerprint(input?.providerVersion, "providerVersion"),
    providerSettingsSha256: requireSha256(
      input?.providerSettingsSha256,
      "providerSettingsSha256"
    ),
    hostFingerprint: requireSafeFingerprint(input?.hostFingerprint, "hostFingerprint"),
    containerBudgetSha256: requireSha256(
      input?.containerBudgetSha256,
      "containerBudgetSha256"
    ),
    warmup: requireInteger(input?.warmup, "warmup", 0),
    repetitions: requireInteger(input?.repetitions, "repetitions", 1),
    concurrency: requireInteger(input?.concurrency, "concurrency", 1),
    seed: requireInteger(input?.seed, "seed", 0)
  };
  return deepFreeze({ ...fingerprint, sha256: sha256(fingerprint) });
}

function normalizeCorpus(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Benchmark corpus must not be empty");
  }
  const ids = new Set();
  return value.map((document) => {
    const _id = requireSafeIdentifier(document?._id, "corpus _id");
    if (ids.has(_id)) throw new Error(`Duplicate corpus document: ${_id}`);
    ids.add(_id);
    return {
      _id,
      title: requireText(document?.title, `corpus title ${_id}`),
      text: requireText(document?.text, `corpus text ${_id}`)
    };
  }).sort((left, right) => left._id.localeCompare(right._id));
}

function requireIndexingQuality(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} indexing quality is required`);
  }
  const sourceCount = requireInteger(value.sourceCount, `${name} sourceCount`, 1);
  const coverage = requireNonnegativeNumberRecord(value.coverage, `${name} coverage`);
  const metrics = requireNonnegativeNumberRecord(value.metrics, `${name} metrics`);
  if (!value.categories || typeof value.categories !== "object"
    || Array.isArray(value.categories)) {
    throw new Error(`${name} categories are required`);
  }
  const categories = Object.fromEntries(Object.entries(value.categories).map(
    ([category, categoryMetrics]) => [
      requireSafeIdentifier(category, `${name} category`),
      requireNonnegativeNumberRecord(
        categoryMetrics,
        `${name} category ${category}`
      )
    ]
  ));
  return { sourceCount, coverage, metrics, categories };
}

function requireNonnegativeNumberRecord(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    requireSafeIdentifier(key, `${name} key`),
    requireFiniteNumber(item, `${name}.${key}`, 0)
  ]));
}

function compareQualityRecord(baseline, candidate, path, precision, failures) {
  const metricNames = new Set([
    ...Object.keys(baseline),
    ...Object.keys(candidate)
  ]);
  for (const metric of [...metricNames].sort()) {
    if (baseline[metric] === undefined || candidate[metric] === undefined) {
      failures.push(`${path}.${metric}`);
      continue;
    }
    const baselineValue = roundTo(baseline[metric], precision);
    const candidateValue = roundTo(candidate[metric], precision);
    const lowerIsBetter = metric === "noResultFalsePositiveRate"
      || metric === "nominalErrorRate";
    if (lowerIsBetter ? candidateValue > baselineValue : candidateValue < baselineValue) {
      failures.push(`${path}.${metric}`);
    }
  }
}

function roundTo(value, precision) {
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function normalizeQueries(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Benchmark queries must not be empty");
  }
  const ids = new Set();
  return value.map((query) => {
    const _id = requireSafeIdentifier(query?._id, "query _id");
    if (ids.has(_id)) throw new Error(`Duplicate benchmark query: ${_id}`);
    ids.add(_id);
    return {
      _id,
      text: requireText(query?.text, `query text ${_id}`),
      category: requireSafeIdentifier(query?.category, `query category ${_id}`)
    };
  }).sort((left, right) => left._id.localeCompare(right._id));
}

function normalizeQrels(value, corpus, queries) {
  if (!Array.isArray(value)) throw new Error("Benchmark qrels must be an array");
  const corpusIds = new Set(corpus.map((document) => document._id));
  const queryIds = new Set(queries.map((query) => query._id));
  const identities = new Set();
  return value.map((qrel) => {
    const queryId = requireSafeIdentifier(qrel?.queryId, "qrel queryId");
    const corpusId = requireSafeIdentifier(qrel?.corpusId, "qrel corpusId");
    const relevance = requireInteger(qrel?.relevance, "qrel relevance", 0);
    if (relevance > 2) {
      throw new Error("qrel relevance is outside the accepted range");
    }
    if (!queryIds.has(queryId)) throw new Error(`Unknown qrel query: ${queryId}`);
    if (!corpusIds.has(corpusId)) throw new Error(`Unknown qrel document: ${corpusId}`);
    const identity = `${queryId}\u0000${corpusId}`;
    if (identities.has(identity)) throw new Error(`Duplicate qrel: ${queryId}/${corpusId}`);
    identities.add(identity);
    return { queryId, corpusId, relevance };
  }).sort((left, right) =>
    left.queryId.localeCompare(right.queryId)
    || left.corpusId.localeCompare(right.corpusId)
  );
}

function queryMetricsAtCutoff({ rankedIds, qrels, cutoff }) {
  const relevantEntries = [...qrels.entries()].filter(([, relevance]) => relevance > 0);
  const relevantIds = new Set(relevantEntries.map(([id]) => id));
  const top = rankedIds.slice(0, cutoff);
  let hits = 0;
  let averagePrecisionTotal = 0;
  let reciprocalRank = 0;
  let dcg = 0;
  for (let index = 0; index < top.length; index += 1) {
    const relevance = qrels.get(top[index]) ?? 0;
    if (relevance > 0) {
      hits += 1;
      averagePrecisionTotal += hits / (index + 1);
      if (reciprocalRank === 0) reciprocalRank = 1 / (index + 1);
    }
    dcg += gradedGain(relevance) / Math.log2(index + 2);
  }
  const ideal = relevantEntries.map(([, relevance]) => relevance)
    .sort((left, right) => right - left)
    .slice(0, cutoff);
  const idealDcg = ideal.reduce((total, relevance, index) =>
    total + gradedGain(relevance) / Math.log2(index + 2), 0
  );
  return {
    ndcg: idealDcg === 0 ? 0 : dcg / idealDcg,
    recall: hits / relevantIds.size,
    precision: hits / cutoff,
    map: averagePrecisionTotal / relevantIds.size,
    mrr: reciprocalRank
  };
}

function gradedGain(relevance) {
  return (2 ** relevance) - 1;
}

function percentileSummary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: nearestRank(sorted, 0.5),
    p90: nearestRank(sorted, 0.9),
    p95: nearestRank(sorted, 0.95),
    p99: nearestRank(sorted, 0.99)
  };
}

function nearestRank(sorted, percentile) {
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

function quantile(sorted, probability) {
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) return sorted[lowerIndex];
  const weight = position - lowerIndex;
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
}

function vectorNorm(vector) {
  return Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
}

function requireVector(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a nonempty vector`);
  }
  return value.map((item) => requireFiniteNumber(item, name));
}

function requireUniqueStrings(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const items = value.map((item) => requireSafeIdentifier(item, name));
  if (new Set(items).size !== items.length) throw new Error(`${name} contains duplicates`);
  return items;
}

function requireSafeIdentifier(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error(`${name} must be a nonempty bounded string`);
  }
  if (/\p{C}/u.test(value)) throw new Error(`${name} contains control characters`);
  return value;
}

function requireText(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be nonempty text`);
  }
  return value;
}

function requireSafeFingerprint(value, name) {
  const text = requireSafeIdentifier(value, name);
  if (/[\\/]|:\/\/|(?:api[_-]?key|password|secret|token)\s*=/iu.test(text)) {
    throw new Error(`${name} contains unsafe fingerprint text`);
  }
  return text;
}

function requireSha256(value, name) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireFiniteNumber(value, name, minimum = -Infinity, maximum = Infinity) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be finite`);
  }
  if (value < minimum || value > maximum) {
    throw new Error(`${name} is outside the accepted range`);
  }
  return value;
}

function requireInteger(value, name, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer of at least ${minimum}`);
  }
  return value;
}

function requireBoolean(value, name) {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
}

function mean(values) {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function seededRank(seed, category, id) {
  return createHash("sha256").update(`${seed}\u0000${category}\u0000${id}`).digest("hex");
}

function createDeterministicRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function sha256(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
