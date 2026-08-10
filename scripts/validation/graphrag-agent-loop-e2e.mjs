import fs from "node:fs";
import path from "node:path";

const openApiBaseUrl = process.env.FOCOWIKI_AGENT_LOOP_OPENAPI_BASE_URL?.trim()
  || "http://127.0.0.1:43200";
const authorization = loadAuthorization(
  requiredEnv("FOCOWIKI_AGENT_LOOP_AUTHORIZATION_FILE")
);
const knowledgeBaseIds = requiredEnv("FOCOWIKI_AGENT_LOOP_KNOWLEDGE_BASE_IDS")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const collectionPaths = requiredEnv("FOCOWIKI_AGENT_LOOP_COLLECTIONS")
  .split(",")
  .map((value) => path.resolve(value.trim()))
  .filter(Boolean);
const qualityReport = JSON.parse(fs.readFileSync(
  path.resolve(requiredEnv("FOCOWIKI_AGENT_LOOP_QUALITY_REPORT")),
  "utf8"
));
const provider = process.env.FOCOWIKI_AGENT_LOOP_PROVIDER?.trim()
  || qualityReport.provider;
const reportPath = path.resolve(
  process.env.FOCOWIKI_AGENT_LOOP_REPORT?.trim()
    || "ReferenceDocs/benchmarks/vector-retrieval/agent-loop-e2e.json"
);

assert(
  knowledgeBaseIds.length === collectionPaths.length && knowledgeBaseIds.length > 0,
  "Agent-loop knowledge-base and collection counts must match"
);

const report = {
  kind: "focowiki-source-grounded-agent-loop-e2e",
  createdAt: new Date().toISOString(),
  maximumAgentRounds: 2,
  provider,
  ok: false,
  degradedRerankerEvidenceProvider: qualityReport.provider,
  degradedRerankerEvidence: summarizeDegradedRerankerEvidence(qualityReport),
  corpora: []
};

assert(
  report.degradedRerankerEvidence.count > 0
    && report.degradedRerankerEvidence.safeCodes.every((code) =>
      code === "RERANKER_UNAVAILABLE" || code === "RERANKER_ABORTED"
    ),
  "The bounded quality run did not retain safe degraded-reranker evidence"
);

for (let index = 0; index < knowledgeBaseIds.length; index += 1) {
  const knowledgeBaseId = knowledgeBaseIds[index];
  const collection = JSON.parse(fs.readFileSync(collectionPaths[index], "utf8"));
  report.corpora.push(await runCorpus({
    knowledgeBaseId,
    collection,
    corpusLabel: collection.queries[0]?._id?.split("-")[0] || `corpus-${index + 1}`
  }));
}

report.ok = true;
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

async function runCorpus(input) {
  const naturalLanguage = input.collection.queries.find((query) =>
    input.collection.testQueryIds.includes(query._id)
      && query.category === "natural_language"
  );
  assert(naturalLanguage, "Agent-loop collection lacks a natural-language test query");

  const first = await search(input.knowledgeBaseId, {
    query: naturalLanguage.text,
    mode: "hybrid",
    graphDepth: "2",
    limit: "50",
    rerank: "false"
  });
  assert(first.items.length > 0, "Natural-language Agent search returned no source candidates");
  assertSearchEnvelope(first, input.knowledgeBaseId);
  assert(
    first.rerankerStatus?.state === "skipped"
      && first.rerankerStatus.safeCode === "RERANKER_DISABLED",
    "Disabled reranking did not preserve the deterministic fused result"
  );

  const firstEvidence = await readEvidence(first.items[0]);
  const second = await search(input.knowledgeBaseId, {
    query: first.items[0].title,
    mode: "hybrid",
    graphDepth: "1",
    limit: "10",
    rerank: "false"
  });
  assertSearchEnvelope(second, input.knowledgeBaseId);
  assert(
    second.items.some((item) => item.sourceFileId === first.items[0].sourceFileId),
    "The second Agent round lost the source selected in the first round"
  );
  const secondTarget = second.items.find((item) =>
    item.sourceFileId !== first.items[0].sourceFileId
  ) || second.items[0];
  const secondEvidence = await readEvidence(secondTarget);

  const threshold = await search(input.knowledgeBaseId, {
    query: first.items[0].title,
    mode: "hybrid",
    graphDepth: "2",
    limit: "10",
    rerank: "true",
    rerankTopK: "50",
    rerankScoreThreshold: "1"
  });
  assertSearchEnvelope(threshold, input.knowledgeBaseId);
  assert(
    threshold.items.some((item) =>
      item.sourceFileId === first.items[0].sourceFileId
        && item.matchedFields.includes("title")
    ),
    "The reranker score threshold removed exact-title evidence"
  );
  assert(
    ["applied", "degraded"].includes(threshold.rerankerStatus?.state)
      || threshold.rerankerStatus?.state === "skipped"
        && threshold.rerankerStatus.safeCode === "RERANKER_NO_CANDIDATES",
    `Enabled reranking did not apply or use its safe fused fallback: ${JSON.stringify(threshold.rerankerStatus)}`
  );

  return {
    corpus: input.corpusLabel,
    rounds: 2,
    firstRoundResultCount: first.items.length,
    secondRoundResultCount: second.items.length,
    sourceReads: 2,
    readByIdAndPathMatched: firstEvidence.matched && secondEvidence.matched,
    contentBytesRead: firstEvidence.bytes + secondEvidence.bytes,
    graphExpansionCount: firstEvidence.graphCount + secondEvidence.graphCount,
    disabledRerankerStatus: first.rerankerStatus,
    thresholdRerankerStatus: threshold.rerankerStatus,
    thresholdExactEvidencePreserved: true,
    searchResponsesContainedOriginalBodies: false
  };
}

async function search(knowledgeBaseId, parameters) {
  const pathname = `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
    + "/files/search";
  return requestJson(`${pathname}?${new URLSearchParams(parameters)}`);
}

function assertSearchEnvelope(value, knowledgeBaseId) {
  assert(Array.isArray(value.items), "Search response omitted its bounded item list");
  assert(
    value.semanticStatus?.state === "ready"
      && value.evidenceStatus?.degradedFamilies?.length === 0,
    "Search response did not complete all required evidence lanes"
  );
  assert(
    !("answer" in value) && !("generatedAnswer" in value),
    "Search response unexpectedly returned a generated answer"
  );
  for (const item of value.items) {
    assert(item.knowledgeBaseId === knowledgeBaseId, "Search crossed knowledge-base scope");
    assert(item.contentAvailable === true, "Search returned unreadable source evidence");
    assert(item.readActions?.fileContentById, "Search result omitted fileContentById");
    assert(item.readActions?.fileContentByPath, "Search result omitted fileContentByPath");
    assert(item.readActions?.graphExpansionByFileId, "Search result omitted graphExpansionByFileId");
    assert(
      !("content" in item) && !("body" in item) && !("markdown" in item),
      "Search response embedded the original document instead of a read action"
    );
  }
}

async function readEvidence(item) {
  const [byId, byPath, graph, related] = await Promise.all([
    requestContent(item.readActions.fileContentById),
    requestContent(item.readActions.fileContentByPath),
    requestJson(item.readActions.graphExpansionByFileId),
    requestJson(item.readActions.relatedFilesById)
  ]);
  assert(byId.length > 0 && byId === byPath, "Source reads by ID and path diverged");
  return {
    matched: true,
    bytes: Buffer.byteLength(byId),
    graphCount: countItems(graph) + countItems(related)
  };
}

async function requestJson(pathname) {
  const response = await fetch(`${openApiBaseUrl}${pathname}`, {
    headers: { authorization }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`OpenAPI returned HTTP ${response.status}`);
  return text ? JSON.parse(text) : null;
}

async function requestContent(pathname) {
  const response = await fetch(`${openApiBaseUrl}${pathname}`, {
    headers: { authorization }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`OpenAPI content read returned HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return text;
  const parsed = JSON.parse(text);
  assert(typeof parsed.content === "string", "Content response omitted Markdown content");
  return parsed.content;
}

function countItems(value) {
  for (const key of ["items", "nodes", "edges", "files"]) {
    if (Array.isArray(value?.[key])) return value[key].length;
  }
  return 0;
}

function summarizeDegradedRerankerEvidence(value) {
  const statuses = Object.values(value.results || {}).flatMap((corpus) =>
    corpus.variants?.reranked_hybrid?.statuses || []
  ).filter((status) => status.rerankerStatus?.state === "degraded");
  return {
    count: statuses.length,
    safeCodes: [...new Set(statuses.map((status) => status.rerankerStatus.safeCode))]
      .sort()
  };
}

function loadAuthorization(filePath) {
  const contents = fs.readFileSync(path.resolve(filePath), "utf8").trim();
  const match = contents.match(/^Authorization:\s+(Bearer\s+\S+)$/iu);
  if (!match?.[1]) throw new Error("Authorization file must contain one Bearer header");
  return match[1];
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
