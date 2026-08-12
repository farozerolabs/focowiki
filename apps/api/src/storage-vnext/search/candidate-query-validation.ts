import type { SearchFilterExpression, SearchProviderQueryPort } from
  "../../application/ports/search-provider-runtime.js";
import {
  STORAGE_VNEXT_CONTENT_SCHEMA_VERSION,
  STORAGE_VNEXT_GRAPH_SEED_SCHEMA_VERSION
} from "./documents.js";
import type {
  StorageVnextSearchValidationCase,
  StorageVnextSearchValidationKind
} from "./ports.js";
import type { StorageVnextSearchHydrationPort } from "./search-hydration.js";
import { assertStorageVnextSearchHydration } from "./search-hydration.js";
import { candidateValidationError } from "./candidate-validation-errors.js";
import {
  normalizeOkfSearchFilterContract,
  type OkfSearchFilters
} from "./okf-signals.js";

const REQUIRED_KINDS: readonly StorageVnextSearchValidationKind[] = [
  "exact", "title", "path", "content", "multi_term", "phrase", "typo",
  "chinese", "mixed_script", "graph_seed", "ranking"
];

export async function validateStorageVnextSearchQueries(input: {
  query: SearchProviderQueryPort;
  hydration: StorageVnextSearchHydrationPort;
  indexUid: string;
  knowledgeBaseId: string;
  candidatePublicId: string;
  cases: readonly StorageVnextSearchValidationCase[];
  maxP95ProcessingTimeMs: number;
}): Promise<void> {
  assertMatrix(input.cases, input.maxP95ProcessingTimeMs);
  const processingTimes: number[] = [];
  for (const validationCase of input.cases) {
    const request = searchRequest(input, validationCase);
    const first = await input.query.query(request);
    const second = await input.query.query(request);
    const firstCandidates = candidateIdentities(first.hits);
    const secondCandidates = candidateIdentities(second.hits);
    if (
      JSON.stringify(firstCandidates) !== JSON.stringify(secondCandidates)
    ) throw candidateValidationError("candidate_order_nondeterministic");
    await hydrateCandidates(input, firstCandidates);
    assertQuality(validationCase, firstCandidates.map((item) => item.sourceFilePublicId));
    if (!Number.isFinite(first.processingTimeMs) || first.processingTimeMs < 0) {
      throw candidateValidationError("candidate_latency_exceeded");
    }
    processingTimes.push(first.processingTimeMs);
  }
  processingTimes.sort((left, right) => left - right);
  const p95Index = Math.max(0, Math.ceil(processingTimes.length * 0.95) - 1);
  if (processingTimes[p95Index]! > input.maxP95ProcessingTimeMs) {
    throw candidateValidationError("candidate_latency_exceeded");
  }
}

function searchRequest(
  input: Parameters<typeof validateStorageVnextSearchQueries>[0],
  validationCase: StorageVnextSearchValidationCase
) {
  const schemaVersion = validationCase.documentKind === "content"
    ? STORAGE_VNEXT_CONTENT_SCHEMA_VERSION
    : STORAGE_VNEXT_GRAPH_SEED_SCHEMA_VERSION;
  const operands: SearchFilterExpression[] = [{
    kind: "equals",
    field: "knowledgeBaseId",
    value: input.knowledgeBaseId
  }, {
    kind: "equals",
    field: "documentKind",
    value: validationCase.documentKind
  }, {
    kind: "equals",
    field: "schemaVersion",
    value: schemaVersion
  }];
  appendOkfFilters(operands, validationCase.okfFilters);
  return {
    indexUid: input.indexUid,
    query: validationCase.query,
    evidenceFamilies: evidenceFamilies(
      validationCase.kind,
      validationCase.query
    ),
    filters: {
      kind: "and" as const,
      operands
    },
    limit: validationCase.limit,
    searchFields: [...validationCase.attributesToSearchOn],
    returnFields: [
      "sourceFilePublicId", "sourceRevisionPublicId", "logicalPath"
    ],
    continuation: null,
    cropLength: 1,
    deadlineMs: input.maxP95ProcessingTimeMs,
    matchingStrategy: "all" as const,
    distinctBy: "sourceFilePublicId" as const
  };
}

function appendOkfFilters(
  operands: SearchFilterExpression[],
  filters: OkfSearchFilters | undefined
): void {
  if (!filters) return;
  const normalized = normalizeOkfSearchFilterContract(filters);
  if (normalized.status !== null) operands.push({
    kind: "equals", field: "okfSignals.status", value: normalized.status
  });
  if (normalized.trustTier !== null) operands.push({
    kind: "equals", field: "okfSignals.trustTier", value: normalized.trustTier
  });
  if (normalized.freshness !== null && normalized.requestEpochDay !== null) {
    operands.push({
      kind: "range",
      field: "okfSignals.staleAfterEpochDay",
      operator: normalized.freshness === "stale" ? "lte" : "gt",
      value: normalized.requestEpochDay
    });
  }
}

function candidateIdentities(hits: Awaited<ReturnType<
  SearchProviderQueryPort["query"]
>>["hits"]) {
  const unique = new Map<string, {
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
    logicalPath: string;
  }>();
  for (const hit of hits) {
    const sourceFilePublicId = requiredString(hit.sourceFilePublicId);
    const candidate = {
      sourceFilePublicId,
      sourceRevisionPublicId: requiredString(hit.sourceRevisionPublicId),
      logicalPath: requiredString(hit.logicalPath)
    };
    if (!unique.has(sourceFilePublicId)) unique.set(sourceFilePublicId, candidate);
  }
  return [...unique.values()];
}

type ValidationEvidenceFamily =
  | "exact" | "text" | "phrase" | "typo" | "jieba" | "graph";

function evidenceFamilies(
  kind: StorageVnextSearchValidationKind,
  query: string
): readonly ValidationEvidenceFamily[] {
  if (kind.startsWith("okf_")) return ["exact", "text"];
  if (kind === "exact" || kind === "title" || kind === "path") return ["exact"];
  const families: readonly ValidationEvidenceFamily[] = kind === "ranking"
    ? ["exact", "text"]
    : kind === "phrase"
      ? ["phrase", "text"]
      : kind === "typo"
        ? ["typo", "text"]
        : kind === "chinese" || kind === "mixed_script"
          ? ["jieba", "text"]
          : kind === "graph_seed"
            ? ["graph", "text"]
            : ["text"];
  if (/\p{Script=Han}/u.test(query) && !families.includes("jieba")) {
    return ["jieba", ...families];
  }
  return families;
}

async function hydrateCandidates(
  input: Parameters<typeof validateStorageVnextSearchQueries>[0],
  candidates: ReturnType<typeof candidateIdentities>
) {
  const hydrated = await input.hydration.hydrateCurrentSources({
    knowledgeBaseId: input.knowledgeBaseId,
    candidatePublicId: input.candidatePublicId,
    sourceFilePublicIds: candidates.map((item) => item.sourceFilePublicId)
  });
  try {
    assertStorageVnextSearchHydration(candidates, hydrated);
  } catch {
    throw candidateValidationError("candidate_hydration_mismatch");
  }
}

function assertQuality(
  validationCase: StorageVnextSearchValidationCase,
  returned: readonly string[]
) {
  const relevance = new Map(validationCase.relevantSources.map((item) => [
    item.sourceFilePublicId, item.relevance
  ]));
  if (relevance.size === 0) {
    if (returned.length > 0) {
      throw candidateValidationError(
        "candidate_recall_below_minimum",
        validationCase.kind
      );
    }
    return;
  }
  const recalled = new Set(returned.filter((publicId) => relevance.has(publicId))).size;
  if (recalled / relevance.size < validationCase.minimumRecall) {
    throw candidateValidationError(
      "candidate_recall_below_minimum",
      validationCase.kind
    );
  }
  const actual = dcg(returned.map((publicId) => relevance.get(publicId) ?? 0));
  const ideal = dcg([...relevance.values()].sort((left, right) => right - left));
  if ((ideal === 0 ? 0 : actual / ideal) < validationCase.minimumNdcg) {
    throw candidateValidationError(
      "candidate_ndcg_below_minimum",
      validationCase.kind
    );
  }
}

function dcg(relevances: readonly number[]) {
  return relevances.reduce((total, relevance, index) =>
    total + (2 ** relevance - 1) / Math.log2(index + 2), 0);
}

function assertMatrix(
  cases: readonly StorageVnextSearchValidationCase[],
  maxP95ProcessingTimeMs: number
) {
  const kinds = new Set(cases.map((item) => item.kind));
  if (cases.length > 100 || REQUIRED_KINDS.some((kind) => !kinds.has(kind))) {
    throw candidateValidationError("candidate_query_matrix_incomplete");
  }
  if (
    !Number.isFinite(maxP95ProcessingTimeMs)
    || maxP95ProcessingTimeMs < 1 || maxP95ProcessingTimeMs > 60_000
  ) {
    throw candidateValidationError("candidate_query_matrix_incomplete");
  }
  for (const item of cases) {
    const relevantIds = item.relevantSources.map((source) => source.sourceFilePublicId);
    if (
      !item.query || Buffer.byteLength(item.query) > 4_096
      || item.attributesToSearchOn.length === 0
      || item.attributesToSearchOn.length > 10
      || !Number.isSafeInteger(item.limit) || item.limit < 1 || item.limit > 100
      || item.relevantSources.length === 0 && !item.kind.startsWith("okf_")
      || new Set(relevantIds).size !== relevantIds.length
      || item.relevantSources.length > item.limit
      || item.relevantSources.some((source) => !source.sourceFilePublicId
        || !Number.isFinite(source.relevance) || source.relevance <= 0)
      || !Number.isFinite(item.minimumRecall)
      || item.minimumRecall < 0 || item.minimumRecall > 1
      || !Number.isFinite(item.minimumNdcg)
      || item.minimumNdcg < 0 || item.minimumNdcg > 1
      || !hasRequiredQuerySemantics(item)
    ) throw candidateValidationError("candidate_query_matrix_incomplete");
  }
}

function hasRequiredQuerySemantics(item: StorageVnextSearchValidationCase) {
  const attributes = new Set(item.attributesToSearchOn);
  if (item.kind.startsWith("okf_")) {
    try {
      normalizeOkfSearchFilterContract(item.okfFilters);
    } catch {
      return false;
    }
    return item.documentKind === "content"
      && attributes.has("logicalPath")
      && item.okfFilters !== undefined;
  }
  if (item.kind === "graph_seed") {
    return item.documentKind === "graph_seed"
      && (attributes.has("searchText") || attributes.has("rankingTerms"));
  }
  if (item.documentKind !== "content") return false;
  if (item.kind === "exact" || item.kind === "title") return attributes.has("title");
  if (item.kind === "path") return attributes.has("logicalPath");
  if (item.kind === "ranking") return attributes.size > 0;
  if (!attributes.has("searchText")) return false;
  if (item.kind === "chinese") return /\p{Script=Han}/u.test(item.query);
  if (item.kind === "mixed_script") {
    return /\p{Script=Han}/u.test(item.query) && /[A-Za-z]/u.test(item.query);
  }
  return true;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value) {
    throw candidateValidationError("candidate_document_invalid");
  }
  return value;
}
