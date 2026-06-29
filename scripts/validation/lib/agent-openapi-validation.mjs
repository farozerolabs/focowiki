export const MIN_AGENT_VALIDATION_SAMPLE_COUNT = 50;
export const DEFAULT_AGENT_PROCESSING_TIMEOUT_MS = 1_800_000;
export const AGENT_PROCESSING_TIMEOUT_PER_SAMPLE_MS = 90_000;
export const AGENT_PERSONAS = ["generic", "domain"];
export const AGENT_SCENARIO_TYPES = [
  "precise_lookup",
  "metadata_check",
  "comparison",
  "topic_or_source_exploration",
  "related_file_traversal",
  "insufficient_evidence"
];

const INTERNAL_EVIDENCE_FIELDS = [
  "internalDatabaseRowsUsed",
  "s3ObjectKeyUsed",
  "localFixtureBodyUsed",
  "expectedAnswerKeyUsed",
  "manualTargetFileUsed"
];

export function requireValidationSampleCount(samples) {
  if (!Array.isArray(samples) || samples.length < MIN_AGENT_VALIDATION_SAMPLE_COUNT) {
    throw new Error(`Agent OpenAPI exploration validation requires at least 50 Markdown samples.`);
  }
}

export function defaultAgentProcessingTimeoutMs(sampleCount) {
  const normalizedCount = Number.isSafeInteger(sampleCount) && sampleCount > 0
    ? sampleCount
    : MIN_AGENT_VALIDATION_SAMPLE_COUNT;
  return Math.max(
    DEFAULT_AGENT_PROCESSING_TIMEOUT_MS,
    normalizedCount * AGENT_PROCESSING_TIMEOUT_PER_SAMPLE_MS
  );
}

export function buildAgentScenarioPlan(samples) {
  requireValidationSampleCount(samples);
  const byTitleLength = [...samples].sort((left, right) => right.title.length - left.title.length);
  const duplicated = firstDuplicatedTitleSamples(samples);
  const topical = samples.find((sample) => sample.category || sample.type) ?? samples[3];
  const related = samples.find((sample) => sample.status && sample.type) ?? samples[4];
  const baseScenarios = [
    {
      scenarioType: "precise_lookup",
      sample: samples[0],
      question: `Find the generated knowledge file for "${samples[0].title}" and cite the visible file evidence.`,
      expectedVisibleClues: [samples[0].title]
    },
    {
      scenarioType: "metadata_check",
      sample: samples[1],
      question: `Check visible metadata for "${samples[1].title}" using generated files only.`,
      expectedVisibleClues: [samples[1].title, samples[1].status || samples[1].publicationDate || samples[1].type]
    },
    {
      scenarioType: "comparison",
      sample: duplicated[0] ?? byTitleLength[0],
      compareSample: duplicated[1] ?? byTitleLength[1],
      question: `Compare the visible metadata and generated file evidence for "${(duplicated[0] ?? byTitleLength[0]).title}" and "${(duplicated[1] ?? byTitleLength[1]).title}".`,
      expectedVisibleClues: [(duplicated[0] ?? byTitleLength[0]).title, (duplicated[1] ?? byTitleLength[1]).title]
    },
    {
      scenarioType: "topic_or_source_exploration",
      sample: topical,
      question: `Explore topic or source clues for "${topical.title}" and identify supporting generated files.`,
      expectedVisibleClues: [topical.title, topical.category || topical.type]
    },
    {
      scenarioType: "related_file_traversal",
      sample: related,
      question: `Start from "${related.title}" and follow visible graph or related-file evidence to another generated page.`,
      expectedVisibleClues: [related.title, related.type]
    },
    {
      scenarioType: "insufficient_evidence",
      sample: samples[0],
      question: "Determine whether the knowledge base contains a document titled __focowiki_validation_missing_document__.",
      expectedVisibleClues: ["__focowiki_validation_missing_document__"],
      expectsNoAnswer: true
    }
  ];

  return AGENT_PERSONAS.flatMap((persona) =>
    baseScenarios.map((scenario) => ({
      persona,
      ...scenario,
      question: persona === "domain"
        ? `${scenario.question} Use the document's visible title, metadata, source clues, and related files before answering.`
        : scenario.question
    }))
  );
}

export function assertAgentEvidenceBoundary(record) {
  const unsafe = INTERNAL_EVIDENCE_FIELDS.filter((field) => Boolean(record?.[field]));
  if (unsafe.length > 0) {
    throw new Error(`Agent exploration used internal evidence: ${unsafe.join(", ")}`);
  }
}

export function requireQuantifiedFindings(findings) {
  for (const finding of findings) {
    const metricCount = Object.keys(finding.metrics || {}).length;
    const evidenceCount = Array.isArray(finding.evidence) ? finding.evidence.length : 0;
    const roundCount = Array.isArray(finding.rounds) ? finding.rounds.length : 0;
    if (metricCount === 0 && evidenceCount === 0 && roundCount === 0) {
      throw new Error(`Finding is not quantified: ${finding.claim || "unknown claim"}`);
    }
  }
}

export function scorePersonaResults(results) {
  const grouped = {};
  for (const persona of AGENT_PERSONAS) {
    const personaResults = results.filter((result) => result.persona === persona);
    grouped[persona] = scoreGroup(personaResults);
  }
  grouped.combined = scoreGroup(results);
  return grouped;
}

export function summarizeReportStagingPolicy() {
  return {
    reportRoot: "ReferenceDocs",
    commitScope: "local-only",
    mustStageReports: false
  };
}

export function normalizeItems(data) {
  if (!data || typeof data !== "object") return [];
  if (Array.isArray(data)) return data;
  for (const key of ["items", "files", "documents", "entries"]) {
    if (Array.isArray(data[key])) return data[key];
  }
  return [];
}

export function extractContent(data) {
  if (!data || typeof data !== "object") return "";
  if (typeof data.content === "string") return data.content;
  if (data.file && typeof data.file === "object" && typeof data.file.content === "string") {
    return data.file.content;
  }
  return "";
}

export function parseJsonContent(content, label) {
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`Generated file is not valid JSON: ${label}`);
  }
}

export function parseJsonlContent(content, label) {
  const rows = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return rows.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`Generated file is not valid JSONL at ${label}:${index + 1}`);
    }
  });
}

export function parseFrontmatter(markdown) {
  if (!markdown.startsWith("---\n")) return {};
  const end = markdown.indexOf("\n---\n", 4);
  if (end === -1) return {};
  const metadata = {};
  for (const line of markdown.slice(4, end).split("\n")) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");
    metadata[key] = value;
  }
  return metadata;
}

export function extractSearchEntries(content) {
  const parsed = parseJsonContent(content, "_index/search.json");
  return normalizeItems(parsed);
}

export function chooseCandidates(entries, scenario, limit = 5) {
  const terms = scenario.expectedVisibleClues
    .filter(Boolean)
    .flatMap((clue) => tokenize(clue))
    .slice(0, 12);
  const scored = entries.map((entry) => ({
    entry,
    score: scoreEntry(entry, terms)
  }));
  return scored
    .filter((item) => scenario.expectsNoAnswer ? item.score > 6 : item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((item) => item.entry);
}

export function createRound(input) {
  assertAgentEvidenceBoundary(input.boundary || {});
  return {
    round: input.round,
    persona: input.persona,
    scenarioType: input.scenarioType,
    action: input.action,
    routeOrFile: input.routeOrFile,
    visibleInput: input.visibleInput || {},
    outputSummary: input.outputSummary || "",
    extractedClues: input.extractedClues || [],
    nextStepDecision: input.nextStepDecision || "stop",
    advancedAnswer: Boolean(input.advancedAnswer),
    metrics: {
      filesDiscovered: input.metrics?.filesDiscovered ?? 0,
      filesRead: input.metrics?.filesRead ?? 0,
      graphFilesRead: input.metrics?.graphFilesRead ?? 0,
      relatedFilesFollowed: input.metrics?.relatedFilesFollowed ?? 0,
      evidenceItemsFound: input.metrics?.evidenceItemsFound ?? 0,
      routeFailures: input.metrics?.routeFailures ?? 0,
      latencyMs: input.metrics?.latencyMs ?? 0,
      scoreContribution: input.metrics?.scoreContribution ?? 0
    }
  };
}

export function classifyScenarioResult(scenario, evidence, rounds, stopReason = "") {
  if (scenario.expectsNoAnswer) {
    return {
      answerability: evidence.length === 0 ? "answered" : "partially_answered",
      stopReason: evidence.length === 0 ? "insufficient-evidence-confirmed" : "unexpected-evidence",
      score: evidence.length === 0 ? 90 : 45
    };
  }

  const graphRound = rounds.some((round) => round.metrics.graphFilesRead > 0 || round.metrics.relatedFilesFollowed > 0);
  if (evidence.length >= 2 && graphRound) {
    return { answerability: "answered", stopReason: "evidence-collected", score: 90 };
  }
  if (evidence.length > 0) {
    return { answerability: "partially_answered", stopReason: "partial-evidence-collected", score: 65 };
  }
  return { answerability: stopReason === "blocked" ? "blocked" : "not_answered", stopReason: stopReason || "no-visible-evidence", score: 20 };
}

export function aggregateCounts(results) {
  const counts = {
    scenarioCount: results.length,
    roundCount: results.reduce((sum, item) => sum + item.rounds.length, 0),
    evidenceCount: results.reduce((sum, item) => sum + item.evidence.length, 0),
    routeFailureCount: results.reduce(
      (sum, item) => sum + item.rounds.reduce((inner, round) => inner + round.metrics.routeFailures, 0),
      0
    ),
    answerability: {},
    stopStages: {},
    scenarioTypes: {},
    personas: {}
  };

  for (const result of results) {
    increment(counts.answerability, result.answerability);
    increment(counts.stopStages, result.stopStage || "completed");
    increment(counts.scenarioTypes, result.scenarioType);
    increment(counts.personas, result.persona);
  }

  return counts;
}

export function latencySummary(latencies) {
  const sorted = latencies.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (sorted.length === 0) return { count: 0, medianMs: 0, maxMs: 0 };
  const median = sorted[Math.floor(sorted.length / 2)];
  return {
    count: sorted.length,
    medianMs: median,
    maxMs: sorted[sorted.length - 1]
  };
}

function scoreGroup(results) {
  if (results.length === 0) {
    return {
      count: 0,
      score: 0,
      answerability: {}
    };
  }
  const score = Math.round(results.reduce((sum, result) => sum + result.score, 0) / results.length);
  const answerability = {};
  for (const result of results) increment(answerability, result.answerability);
  return { count: results.length, score, answerability };
}

function firstDuplicatedTitleSamples(samples) {
  const byTitle = new Map();
  for (const sample of samples) {
    const key = sample.title?.trim();
    if (!key) continue;
    const group = byTitle.get(key) ?? [];
    group.push(sample);
    byTitle.set(key, group);
  }
  return [...byTitle.values()].find((group) => group.length > 1) ?? [];
}

function scoreEntry(entry, terms) {
  const haystack = JSON.stringify(entry).toLowerCase();
  return terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
}

function tokenize(value) {
  const text = String(value ?? "").toLowerCase();
  const asciiTerms = text.match(/[a-z0-9_]{3,}/g) ?? [];
  const cjkTerms = text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const cjkChunks = cjkTerms.flatMap((term) => {
    const chunks = [];
    for (let index = 0; index < term.length - 1; index += 2) {
      chunks.push(term.slice(index, index + 4));
    }
    return chunks;
  });
  return [...new Set([...asciiTerms, ...cjkTerms, ...cjkChunks].filter(Boolean))];
}

function increment(target, key) {
  target[key] = (target[key] ?? 0) + 1;
}
