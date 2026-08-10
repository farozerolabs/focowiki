import type {
  SearchProviderVectorFamily,
  SearchProviderVectorPort
} from "../../application/ports/search-provider-runtime.js";
import {
  SEARCH_PROVIDER_MINIMUM_VECTOR_RELEVANCE_SCORE
} from "../../application/ports/search-provider-runtime.js";
import { generatedPagePath } from "../../domain/source-path.js";
import type { OkfSearchFilters } from
  "../../storage-vnext/search/okf-signals.js";
import { normalizeAndValidateSearchQuery } from
  "../../storage-vnext/search/query-contract.js";
import { createSemanticSearchPlan } from "./query-plan.js";
import {
  observeSemanticRanks,
  type SemanticRankObserver
} from "./rank-observer.js";
import type {
  RerankerCandidate,
  RerankerStatus
} from "../reranker/gateway.js";

export type SemanticRankedLane =
  | "exact_path" | "exact_title" | "lexical" | "jieba" | "file_graph";
export type SemanticVectorLane =
  | "content_vector" | "entity_vector"
  | "relationship_vector" | "community_vector";
export type SemanticSearchLane = SemanticRankedLane | SemanticVectorLane;

export type SemanticLaneCandidate = {
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  evidenceTargetPath: string;
  rank: number;
  normalizedScore?: number;
  bodyGrounded: boolean;
  snippet: string | null;
  semanticDocumentId?: string;
  semanticOwnerPublicId?: string;
  semanticFamily?: SearchProviderVectorFamily;
};

type SourceRecord = {
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  logicalPath: string;
  title: string;
};

type SemanticSearchResultItem = {
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  logicalPath: string;
  title: string;
  score: number;
  priority: RerankerCandidate["priority"];
  evidenceFamilies: readonly SemanticSearchLane[];
  matchedFields: readonly string[];
  evidenceTypes: readonly string[];
  sourceExcerpt: string | null;
  explanations: readonly string[];
};

const WEIGHTS: Record<SemanticSearchLane, number> = {
  exact_path: 16,
  exact_title: 12,
  lexical: 5,
  jieba: 4,
  file_graph: 3,
  content_vector: 5,
  entity_vector: 4,
  relationship_vector: 4,
  community_vector: 2
};
const RRF_CONSTANT = 60;

export function createSemanticSearchOrchestrator(input: {
  queryEmbedding: {
    embed(request: {
      knowledgeBaseId: string;
      semanticGenerationPublicId: string;
      embeddingConfigurationRevisionPublicId: string;
      dimension: number;
      normalization: "none" | "l2";
      query: string;
      deadlineMs: number;
      signal: AbortSignal | null;
    }): Promise<readonly number[]>;
  };
  rankedLanes: {
    run(request: {
      lane: SemanticRankedLane;
      indexUid: string;
      knowledgeBaseId: string;
      query: string;
      scope?: "all" | "path" | "metadata";
      fileKind?: string | null;
      okfFilters?: OkfSearchFilters;
      limit: number;
      deadlineMs: number;
      signal: AbortSignal;
    }): Promise<readonly SemanticLaneCandidate[]>;
  };
  vectors: Pick<SearchProviderVectorPort, "query">;
  vectorDocuments: {
    resolveActive(request: {
      knowledgeBaseId: string;
      semanticGenerationPublicId: string;
      documents: readonly {
        documentId: string;
        ownerPublicId: string;
        family: SearchProviderVectorFamily;
        sourceFilePublicId: string;
        sourceRevisionPublicId: string;
        evidenceTargetPath: string;
      }[];
      limit: number;
      signal: AbortSignal;
    }): Promise<readonly string[]>;
  };
  sources: {
    resolve(request: {
      knowledgeBaseId: string;
      sourceFilePublicIds: readonly string[];
      fileKind: string | null;
      okfFilters: OkfSearchFilters;
      limit: number;
      signal: AbortSignal;
    }): Promise<readonly SourceRecord[]>;
  };
  reranker?: {
    rerank(request: {
      query: string;
      knowledgeBaseId: string;
      candidates: readonly RerankerCandidate[];
      rerankTopK: number;
      rerankScoreThreshold: number;
      limit: number;
      signal: AbortSignal | null;
    }): Promise<{
      candidates: readonly RerankerCandidate[];
      status: RerankerStatus;
      hasMore?: boolean;
    }>;
  };
  observer?: SemanticRankObserver;
}) {
  return {
    async search(rawRequest: {
      knowledgeBaseId: string;
      query: string;
      mode: "file" | "graph" | "hybrid";
      scope?: "all" | "path" | "metadata";
      fileKind?: string | null;
      okfFilters?: OkfSearchFilters;
      limit: number;
      rerank?: boolean;
      rerankTopK?: number | null;
      rerankScoreThreshold?: number | null;
      overallDeadlineMs: number;
      laneCutoffMs: number;
      projection: {
        semanticGenerationPublicId: string;
        embeddingConfigurationRevisionPublicId: string;
        vectorIndexUid: string;
        lexicalIndexUid?: string;
        dimension: number;
        normalization?: "none" | "l2";
        embeddingQueryPolicyRevisionPublicId?: string;
        minimumVectorRelevance?: number;
      };
      signal: AbortSignal | null;
    }) {
      const request = {
        ...rawRequest,
        scope: rawRequest.scope ?? "all" as const,
        fileKind: rawRequest.fileKind === undefined ? "page" : rawRequest.fileKind,
        okfFilters: rawRequest.okfFilters ?? {
          status: null,
          trustTier: null,
          freshness: null,
          requestEpochDay: null
        },
        rerank: rawRequest.rerank ?? false,
        rerankTopK: rawRequest.rerankTopK ?? null,
        rerankScoreThreshold: rawRequest.rerankScoreThreshold ?? null,
        projection: {
          ...rawRequest.projection,
          normalization: rawRequest.projection.normalization ?? "l2" as const,
          embeddingQueryPolicyRevisionPublicId:
            rawRequest.projection.embeddingQueryPolicyRevisionPublicId
              ?? rawRequest.projection.embeddingConfigurationRevisionPublicId,
          minimumVectorRelevance: rawRequest.projection.minimumVectorRelevance
            ?? SEARCH_PROVIDER_MINIMUM_VECTOR_RELEVANCE_SCORE
        }
      };
      const normalized = normalizeRequest(request);
      const root = new AbortController();
      const abortFromCaller = () => root.abort(
        request.signal?.reason ?? searchError("semantic_search_cancelled")
      );
      request.signal?.addEventListener("abort", abortFromCaller, { once: true });
      if (request.signal?.aborted) abortFromCaller();
      const overallTimer = setTimeout(
        () => root.abort(searchError("semantic_search_deadline")),
        request.overallDeadlineMs
      );
      overallTimer.unref?.();
      const startedAt = Date.now();
      try {
        const plan = createSemanticSearchPlan({
          mode: request.mode,
          scope: request.scope,
          resultLimit: request.limit
        });
        const laneLimit = plan.candidateLimitPerLane;
        const ranked = plan.rankedLanes.map((lane) =>
          runLane(lane, request.laneCutoffMs, root.signal, (signal) =>
            input.rankedLanes.run({
              lane,
              indexUid: request.projection.lexicalIndexUid
                ?? request.projection.vectorIndexUid,
              knowledgeBaseId: request.knowledgeBaseId,
              query: normalized,
              scope: request.scope,
              fileKind: request.fileKind,
              okfFilters: request.okfFilters,
              limit: laneLimit,
              deadlineMs: request.laneCutoffMs,
              signal
            })));
        const vectorDefinitions = plan.vectorLanes;
        const embedding = vectorDefinitions.length === 0 ? null : withDeadline({
          deadlineMs: request.laneCutoffMs,
          parent: root.signal,
          operation: (signal) => input.queryEmbedding.embed({
            knowledgeBaseId: request.knowledgeBaseId,
            semanticGenerationPublicId:
              request.projection.semanticGenerationPublicId,
            embeddingConfigurationRevisionPublicId:
              request.projection.embeddingConfigurationRevisionPublicId,
            dimension: request.projection.dimension,
            normalization: request.projection.normalization,
            query: normalized,
            deadlineMs: request.laneCutoffMs,
            signal
          })
        });
        const vectors = vectorDefinitions.map(({ lane, family }) =>
          runLane(lane, request.laneCutoffMs, root.signal, async () => {
            if (!embedding) throw searchError("semantic_query_embedding_unavailable");
            const vector = await embedding;
            const result = await input.vectors.query({
              indexUid: request.projection.vectorIndexUid,
              knowledgeBaseId: request.knowledgeBaseId,
              semanticGenerationPublicId:
                request.projection.semanticGenerationPublicId,
              embeddingConfigurationRevisionPublicId:
                request.projection.embeddingConfigurationRevisionPublicId,
              family,
              fileKind: request.fileKind,
              okfFilters: request.okfFilters,
              minimumRelevance: request.projection.minimumVectorRelevance,
              dimension: request.projection.dimension,
              vector,
              limit: laneLimit,
              deadlineMs: request.laneCutoffMs
            });
            return result.hits.map((hit) => ({
              sourceFilePublicId: hit.sourceFilePublicId,
              sourceRevisionPublicId: hit.sourceRevisionPublicId,
              evidenceTargetPath: hit.evidenceTargetPath,
              rank: hit.rank,
              bodyGrounded: true,
              snippet: hit.sourceExcerpt,
              semanticDocumentId: hit.documentId,
              semanticOwnerPublicId: hit.ownerPublicId,
              semanticFamily: hit.family
            }));
          }));
        const outcomes = await Promise.all([...ranked, ...vectors]);
        const completed = outcomes.flatMap((outcome) =>
          outcome.state === "completed" ? [outcome] : []);
        const failures = outcomes.flatMap((outcome) =>
          outcome.state === "failed" ? [outcome.lane] : []);
        const candidates = completed.flatMap((outcome) =>
          validateLaneCandidates(outcome.lane, outcome.candidates));
        const uniqueSourceIds = [...new Set(candidates.map(
          (candidate) => candidate.sourceFilePublicId
        ))].sort((left, right) => left.localeCompare(right, "en"));
        const remainingMs = request.overallDeadlineMs
          - Math.max(0, Date.now() - startedAt);
        if (remainingMs < 1 || root.signal.aborted) {
          throw searchError("semantic_search_deadline");
        }
        const semanticDocuments = uniqueSemanticDocuments(candidates);
        const [sources, activeSemanticDocumentIds] = await Promise.all([
          withDeadline({
            deadlineMs: remainingMs,
            parent: root.signal,
            operation: (signal) => input.sources.resolve({
              knowledgeBaseId: request.knowledgeBaseId,
              sourceFilePublicIds: uniqueSourceIds,
              fileKind: request.fileKind,
              okfFilters: request.okfFilters,
              limit: uniqueSourceIds.length,
              signal
            })
          }),
          withDeadline({
            deadlineMs: remainingMs,
            parent: root.signal,
            operation: (signal) => input.vectorDocuments.resolveActive({
              knowledgeBaseId: request.knowledgeBaseId,
              semanticGenerationPublicId:
                request.projection.semanticGenerationPublicId,
              documents: semanticDocuments,
              limit: semanticDocuments.length,
              signal
            })
          })
        ]);
        const active = new Map(sources.map((source) => [
          source.sourceFilePublicId, source
        ]));
        const activeSemantic = new Set(activeSemanticDocumentIds);
        const eligibleCandidates = candidates.filter((candidate) => {
          if (candidate.semanticDocumentId
            && !activeSemantic.has(candidate.semanticDocumentId)) return false;
          const source = active.get(candidate.sourceFilePublicId);
          return source?.sourceRevisionPublicId === candidate.sourceRevisionPublicId
            && source.logicalPath === candidatePublicPath(candidate);
        });
        for (const lane of [...plan.rankedLanes, ...plan.vectorLanes.map(
          (definition) => definition.lane
        )]) {
          observeSemanticRanks(
            input.observer,
            lane,
            eligibleCandidates
              .filter((candidate) => candidate.lane === lane)
              .map((candidate) => candidate.sourceFilePublicId)
          );
        }
        const fusedCandidates = fuse(eligibleCandidates, active);
        observeSemanticRanks(
          input.observer,
          "fused",
          fusedCandidates.map((candidate) => candidate.sourceFilePublicId)
        );
        const diversifiedCandidates = diversify(
          fusedCandidates,
          eligibleCandidates
        );
        observeSemanticRanks(
          input.observer,
          "diversified",
          diversifiedCandidates.map((candidate) => candidate.sourceFilePublicId)
        );
        const reranked = await applyReranker({
          reranker: input.reranker,
          request: {
            query: normalized,
            knowledgeBaseId: request.knowledgeBaseId,
            rerank: request.rerank,
            rerankTopK: request.rerankTopK,
            rerankScoreThreshold: request.rerankScoreThreshold,
            limit: request.limit,
            signal: root.signal,
            deadlineMs: Math.max(
              1,
              request.overallDeadlineMs - Math.max(0, Date.now() - startedAt)
            )
          },
          candidates: diversifiedCandidates
        });
        if (reranked.status.state === "applied") {
          observeSemanticRanks(
            input.observer,
            "reranked",
            reranked.items.map((candidate) => candidate.sourceFilePublicId)
          );
        }
        return {
          items: reranked.items,
          semanticStatus: failures.length === 0
            ? { state: "ready" as const, safeCode: null }
            : {
                state: "degraded" as const,
                safeCode: "SEMANTIC_LANE_PARTIAL_FAILURE"
              },
          evidenceStatus: {
            completedFamilies: completed.map((outcome) => outcome.lane)
              .sort((left, right) => left.localeCompare(right, "en")),
            degradedFamilies: failures.sort((left, right) =>
              left.localeCompare(right, "en"))
          },
          rerankerStatus: reranked.status,
          hasMore: reranked.hasMore,
          failedLanes: failures.sort((left, right) => left.localeCompare(right, "en"))
        };
      } finally {
        clearTimeout(overallTimer);
        request.signal?.removeEventListener("abort", abortFromCaller);
      }
    }
  };
}

function candidatePublicPath(candidate: SemanticLaneCandidate): string {
  return candidate.semanticDocumentId
    ? generatedPagePath(candidate.evidenceTargetPath)
    : candidate.evidenceTargetPath;
}

function uniqueSemanticDocuments(
  candidates: readonly (SemanticLaneCandidate & { lane: SemanticSearchLane })[]
) {
  const documents = new Map<string, {
    documentId: string;
    ownerPublicId: string;
    family: SearchProviderVectorFamily;
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
    evidenceTargetPath: string;
  }>();
  for (const candidate of candidates) {
    if (!candidate.semanticDocumentId) continue;
    if (!candidate.semanticOwnerPublicId || !candidate.semanticFamily) {
      throw searchError("semantic_search_vector_hit_invalid");
    }
    const document = {
      documentId: candidate.semanticDocumentId,
      ownerPublicId: candidate.semanticOwnerPublicId,
      family: candidate.semanticFamily,
      sourceFilePublicId: candidate.sourceFilePublicId,
      sourceRevisionPublicId: candidate.sourceRevisionPublicId,
      evidenceTargetPath: candidate.evidenceTargetPath
    };
    const prior = documents.get(document.documentId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(document)) {
      throw searchError("semantic_search_vector_hit_conflict");
    }
    documents.set(document.documentId, document);
  }
  if (documents.size > 4_000) {
    throw searchError("semantic_search_vector_hit_limit");
  }
  return [...documents.values()].sort((left, right) =>
    left.documentId.localeCompare(right.documentId, "en"));
}

async function runLane(
  lane: SemanticSearchLane,
  deadlineMs: number,
  parent: AbortSignal,
  operation: (signal: AbortSignal) => Promise<readonly SemanticLaneCandidate[]>
): Promise<
  | { state: "completed"; lane: SemanticSearchLane; candidates: readonly SemanticLaneCandidate[] }
  | { state: "failed"; lane: SemanticSearchLane }
> {
  try {
    const candidates = await withDeadline({ deadlineMs, parent, operation });
    return { state: "completed", lane, candidates };
  } catch {
    return { state: "failed", lane };
  }
}

async function withDeadline<T>(input: {
  deadlineMs: number;
  parent: AbortSignal;
  operation(signal: AbortSignal): Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(input.parent.reason);
  input.parent.addEventListener("abort", abortFromParent, { once: true });
  if (input.parent.aborted) abortFromParent();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = searchError("semantic_search_lane_timeout");
      controller.abort(error);
      reject(error);
    }, input.deadlineMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([input.operation(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    input.parent.removeEventListener("abort", abortFromParent);
  }
}

function validateLaneCandidates(
  lane: SemanticSearchLane,
  candidates: readonly SemanticLaneCandidate[]
): Array<SemanticLaneCandidate & { lane: SemanticSearchLane }> {
  if (candidates.length > 1_000) throw searchError("semantic_search_lane_limit");
  return candidates.flatMap((candidate, index) => {
    if (!candidate.sourceFilePublicId || !candidate.sourceRevisionPublicId
      || !candidate.evidenceTargetPath
      || candidate.rank !== index + 1
      || candidate.normalizedScore !== undefined
        && (!Number.isFinite(candidate.normalizedScore)
          || candidate.normalizedScore < 0 || candidate.normalizedScore > 1)
      || lane === "exact_title" && !candidate.bodyGrounded) return [];
    return [{ ...candidate, lane }];
  });
}

function fuse(
  candidates: readonly (SemanticLaneCandidate & { lane: SemanticSearchLane })[],
  sources: ReadonlyMap<string, SourceRecord>
) {
  const fused = new Map<string, {
    source: SourceRecord;
    score: number;
    priority: number;
    scoredLanes: Set<SemanticSearchLane>;
    evidenceFamilies: Set<SemanticSearchLane>;
    snippets: string[];
    sourceExcerpts: string[];
  }>();
  for (const candidate of candidates) {
    const source = sources.get(candidate.sourceFilePublicId);
    if (!source) continue;
    const current = fused.get(candidate.sourceFilePublicId) ?? {
      source,
      score: 0,
      priority: 2,
      scoredLanes: new Set<SemanticSearchLane>(),
      evidenceFamilies: new Set<SemanticSearchLane>(),
      snippets: [],
      sourceExcerpts: []
    };
    if (!current.scoredLanes.has(candidate.lane)) {
      current.score += WEIGHTS[candidate.lane] / (RRF_CONSTANT + candidate.rank);
      current.scoredLanes.add(candidate.lane);
    }
    current.priority = Math.min(current.priority,
      candidate.lane === "exact_path" ? 0
        : candidate.lane === "exact_title" ? 1 : 2);
    current.evidenceFamilies.add(candidate.lane);
    if (candidate.snippet && current.snippets.length < 3
      && !current.snippets.includes(candidate.snippet)) {
      current.snippets.push(candidate.snippet.slice(0, 1_200));
    }
    if (candidate.snippet && sourceExcerptLane(candidate.lane)
      && current.sourceExcerpts.length < 3
      && !current.sourceExcerpts.includes(candidate.snippet)) {
      current.sourceExcerpts.push(candidate.snippet.slice(0, 1_200));
    }
    fused.set(candidate.sourceFilePublicId, current);
  }
  return [...fused.values()].sort((left, right) =>
    left.priority - right.priority
    || right.score - left.score
    || left.source.sourceFilePublicId.localeCompare(
      right.source.sourceFilePublicId,
      "en"
    )
  ).map((value): SemanticSearchResultItem => {
    const evidenceFamilies = [...value.evidenceFamilies].sort((left, right) =>
      left.localeCompare(right, "en"));
    return {
    sourceFilePublicId: value.source.sourceFilePublicId,
    sourceRevisionPublicId: value.source.sourceRevisionPublicId,
    logicalPath: value.source.logicalPath,
    title: value.source.title,
    score: value.score,
    priority: value.priority === 0 ? "exact_path"
      : value.priority === 1 ? "exact_title" : "fused",
    evidenceFamilies,
    matchedFields: uniqueSorted(evidenceFamilies.flatMap(matchedFields)),
    evidenceTypes: uniqueSorted(evidenceFamilies.map(evidenceType)),
    sourceExcerpt: value.sourceExcerpts[0] ?? null,
    explanations: value.snippets
    };
  });
}

function sourceExcerptLane(lane: SemanticSearchLane): boolean {
  return lane === "lexical" || lane === "jieba" || lane.endsWith("_vector");
}

function diversify(
  candidates: readonly SemanticSearchResultItem[],
  laneCandidates: readonly (SemanticLaneCandidate & { lane: SemanticSearchLane })[]
): SemanticSearchResultItem[] {
  const communities = new Map<string, Set<string>>();
  for (const candidate of laneCandidates) {
    if (candidate.lane !== "community_vector" || !candidate.semanticOwnerPublicId) {
      continue;
    }
    const values = communities.get(candidate.sourceFilePublicId) ?? new Set<string>();
    values.add(candidate.semanticOwnerPublicId);
    communities.set(candidate.sourceFilePublicId, values);
  }
  const exact = candidates.filter((candidate) => candidate.priority !== "fused");
  const remaining = candidates.filter((candidate) => candidate.priority === "fused");
  const selected: SemanticSearchResultItem[] = [];
  const seenCommunities = new Set<string>();
  while (remaining.length > 0) {
    const diverseIndex = remaining.findIndex((candidate) => {
      const keys = communities.get(candidate.sourceFilePublicId);
      return !keys || keys.size === 0
        || [...keys].some((key) => !seenCommunities.has(key));
    });
    const [next] = remaining.splice(diverseIndex < 0 ? 0 : diverseIndex, 1);
    if (!next) break;
    selected.push(next);
    for (const key of communities.get(next.sourceFilePublicId) ?? []) {
      seenCommunities.add(key);
    }
  }
  return [...exact, ...selected];
}

async function applyReranker(input: {
  reranker: Parameters<typeof createSemanticSearchOrchestrator>[0]["reranker"];
  request: {
    query: string;
    knowledgeBaseId: string;
    rerank: boolean;
    rerankTopK: number | null;
    rerankScoreThreshold: number | null;
    limit: number;
    signal: AbortSignal;
    deadlineMs: number;
  };
  candidates: readonly SemanticSearchResultItem[];
}): Promise<{
  items: readonly SemanticSearchResultItem[];
  status: RerankerStatus;
  hasMore: boolean;
}> {
  const fallback = input.candidates.slice(0, input.request.limit);
  if (!input.request.rerank) {
    return {
      items: fallback,
      status: { state: "skipped", safeCode: "RERANKER_DISABLED" },
      hasMore: input.candidates.length > input.request.limit
    };
  }
  if (!input.reranker) {
    return {
      items: fallback,
      status: {
        state: "not_configured",
        safeCode: "RERANKER_NOT_CONFIGURED"
      },
      hasMore: input.candidates.length > input.request.limit
    };
  }
  const bySource = new Map(input.candidates.map((candidate) => [
    candidate.sourceFilePublicId,
    candidate
  ]));
  let result;
  try {
    result = await withDeadline({
      deadlineMs: input.request.deadlineMs,
      parent: input.request.signal,
      operation: (signal) => input.reranker!.rerank({
        query: input.request.query,
        knowledgeBaseId: input.request.knowledgeBaseId,
        candidates: input.candidates.map((candidate) => ({
          knowledgeBaseId: input.request.knowledgeBaseId,
          sourceFilePublicId: candidate.sourceFilePublicId,
          sourceRevisionPublicId: candidate.sourceRevisionPublicId,
          logicalPath: candidate.logicalPath,
          title: candidate.title,
          sourceExcerpt: candidate.sourceExcerpt ?? "",
          sourceGrounded: true,
          priority: candidate.priority,
          evidenceTypes: candidate.evidenceTypes
        })),
        rerankTopK: input.request.rerankTopK!,
        rerankScoreThreshold: input.request.rerankScoreThreshold!,
        limit: input.request.limit,
        signal
      })
    });
  } catch {
    return {
      items: fallback,
      status: { state: "degraded", safeCode: "RERANKER_UNAVAILABLE" },
      hasMore: input.candidates.length > input.request.limit
    };
  }
  return {
    items: result.candidates.flatMap((candidate) => {
      const value = bySource.get(candidate.sourceFilePublicId);
      return value ? [value] : [];
    }),
    status: result.status,
    hasMore: result.hasMore ?? false
  };
}

function matchedFields(lane: SemanticSearchLane): string[] {
  if (lane === "exact_path") return ["path"];
  if (lane === "exact_title") return ["title"];
  if (lane === "file_graph") return ["file_relationship"];
  return ["content"];
}

function evidenceType(lane: SemanticSearchLane): string {
  if (lane === "exact_path") return "path";
  if (lane === "exact_title") return "title";
  if (lane === "file_graph") return "file_relationship";
  if (lane === "entity_vector") return "entity";
  if (lane === "relationship_vector") return "relationship";
  if (lane === "community_vector") return "community";
  return "content";
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function normalizeRequest(input: {
  knowledgeBaseId: string;
  query: string;
  scope: "all" | "path" | "metadata";
  rerank: boolean;
  rerankTopK: number | null;
  rerankScoreThreshold: number | null;
  limit: number;
  overallDeadlineMs: number;
  laneCutoffMs: number;
  projection: { dimension: number; vectorIndexUid: string };
}): string {
  const query = normalizeAndValidateSearchQuery(input.query);
  if (!input.knowledgeBaseId || !query.ok
    || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000
    || !Number.isSafeInteger(input.overallDeadlineMs)
    || input.overallDeadlineMs < 1 || input.overallDeadlineMs > 3_000
    || !Number.isSafeInteger(input.laneCutoffMs) || input.laneCutoffMs < 1
    || input.laneCutoffMs > input.overallDeadlineMs
    || !input.projection.vectorIndexUid
    || !Number.isSafeInteger(input.projection.dimension)
    || input.projection.dimension < 1
    || !["all", "path", "metadata"].includes(input.scope)
    || typeof input.rerank !== "boolean"
    || input.rerank && (
      !Number.isSafeInteger(input.rerankTopK)
      || Number(input.rerankTopK) < input.limit
      || Number(input.rerankTopK) > 50
      || !Number.isFinite(input.rerankScoreThreshold)
      || Number(input.rerankScoreThreshold) < 0
      || Number(input.rerankScoreThreshold) > 1
    )
    || !input.rerank && (
      input.rerankTopK !== null || input.rerankScoreThreshold !== null
    )) throw searchError("semantic_search_invalid_input");
  return query.value;
}

function searchError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Semantic search failed: ${code}`), { code });
}
