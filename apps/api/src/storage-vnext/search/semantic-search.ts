import { createHash } from "node:crypto";
import type { SearchProviderKind } from
  "../../application/ports/search-provider-runtime.js";
import { SEARCH_PROVIDER_MINIMUM_VECTOR_RELEVANCE_SCORE } from
  "../../application/ports/search-provider-runtime.js";
import type { SemanticActiveProjectionRecord } from
  "../../semantic/application/ports.js";
import { semanticVectorIndexUid } from
  "../../semantic/vector/projection-planner.js";
import {
  createOkfSearchSignals,
  matchesOkfSearchFilters
} from "./okf-signals.js";
import {
  StorageVnextActiveSearchInputError
} from "./active-search.js";
import type { StorageVnextSearchHydrationPort } from "./search-hydration.js";
import type {
  StorageVnextSearchQueryPort,
  StorageVnextSearchResult,
  StorageVnextSemanticSearchStatus
} from "./ports.js";
import { normalizeAndValidateSearchQuery } from "./query-contract.js";
import { createSemanticSearchPlan } from "../../semantic/search/query-plan.js";

type ActiveProjection = Pick<
  SemanticActiveProjectionRecord,
  | "publicId"
  | "knowledgeBaseId"
  | "embeddingConfigurationRevisionPublicId"
  | "searchProviderKind"
  | "resolvedDimension"
  | "mappingFingerprintSha256"
> & {
  normalization?: "none" | "l2";
  embeddingQueryPolicyRevisionPublicId?: string;
  minimumVectorRelevance?: number;
};

type SemanticItem = {
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  logicalPath: string;
  title: string;
  score: number;
  evidenceFamilies: readonly string[];
  matchedFields: readonly string[];
  evidenceTypes: readonly string[];
  sourceExcerpt: string | null;
  explanations: readonly string[];
};

type Cursor = { version: 1; scopeHash: string; offset: number };

export function createStorageVnextSemanticSearch(input: {
  semanticGenerations: {
    getActiveProjection(knowledgeBaseId: string): Promise<ActiveProjection | null>;
  };
  resolveActiveRerankerRevision?: () => Promise<string | null>;
  lexicalProjections?: {
    getActiveProjection(knowledgeBaseId: string): Promise<{
      providerKind: SearchProviderKind;
      providerIndexUid: string;
    } | null>;
  };
  semantic: {
    search(request: {
      knowledgeBaseId: string;
      query: string;
      mode: "file" | "graph" | "hybrid";
      scope: "all" | "path" | "metadata";
      fileKind: string | null;
      okfFilters: Parameters<typeof matchesOkfSearchFilters>[1];
      limit: number;
      rerank: boolean;
      rerankTopK: number | null;
      rerankScoreThreshold: number | null;
      overallDeadlineMs: number;
      laneCutoffMs: number;
      projection: {
        semanticGenerationPublicId: string;
        embeddingConfigurationRevisionPublicId: string;
        vectorIndexUid: string;
        dimension: number;
        normalization?: "none" | "l2";
        embeddingQueryPolicyRevisionPublicId?: string;
        minimumVectorRelevance?: number;
      };
      signal: AbortSignal | null;
    }): Promise<{
      items: readonly SemanticItem[];
      semanticStatus: StorageVnextSemanticSearchStatus;
      evidenceStatus?: {
        completedFamilies: readonly string[];
        degradedFamilies: readonly string[];
      };
      rerankerStatus?: {
        state: "not_configured" | "skipped" | "applied" | "degraded";
        safeCode: string | null;
      };
      hasMore?: boolean;
    }>;
  };
  fallback: StorageVnextSearchQueryPort;
  hydration: StorageVnextSearchHydrationPort;
  providerKind: SearchProviderKind;
  vectorIndexPrefix: string;
  maxPageSize: number;
  resolveRuntimeSettings(): Promise<{
    requestTimeoutMs: number;
    searchLaneCutoffMs: number;
  }>;
}): StorageVnextSearchQueryPort {
  return {
    async search(rawRequest) {
      const request = {
        ...rawRequest,
        scope: rawRequest.scope ?? "all" as const,
        fileKind: rawRequest.fileKind === undefined ? "page" : rawRequest.fileKind,
        rerank: rawRequest.rerank ?? false,
        rerankTopK: rawRequest.rerankTopK ?? null,
        rerankScoreThreshold: rawRequest.rerankScoreThreshold ?? null,
        okfFilters: rawRequest.okfFilters ?? {
          status: null,
          trustTier: null,
          freshness: null,
          requestEpochDay: null
        }
      };
      assertRequest(request, input.maxPageSize);
      const [projection, lexicalProjection] = await Promise.all([
        input.semanticGenerations.getActiveProjection(request.knowledgeBaseId),
        input.lexicalProjections?.getActiveProjection(request.knowledgeBaseId)
          ?? Promise.resolve(null)
      ]);
      if (
        !projection
        || projection.knowledgeBaseId !== request.knowledgeBaseId
        || projection.searchProviderKind !== input.providerKind
        || input.lexicalProjections !== undefined && !lexicalProjection
        || lexicalProjection && lexicalProjection.providerKind !== input.providerKind
      ) {
        const page = await input.fallback.search(request);
        return {
          ...page,
          semanticStatus: {
            state: "unavailable",
            safeCode: unavailableCode({
              projection,
              lexicalProjection,
              lexicalProjectionRequired: input.lexicalProjections !== undefined
            })
          },
          evidenceStatus: fallbackEvidenceStatus(request, page.evidenceStatus),
          rerankerStatus: page.rerankerStatus ?? rerankerUnavailableStatus(
            request.rerank
          )
        };
      }
      const normalizedQuery = normalizeAndValidateSearchQuery(request.query);
      if (!normalizedQuery.ok) {
        throw new StorageVnextActiveSearchInputError("INVALID_SEARCH_INPUT");
      }
      const activeRerankerRevisionPublicId = await resolveRerankerRevision(
        request.rerank,
        input.resolveActiveRerankerRevision
      );
      const scopeHash = hash({
        knowledgeBaseId: request.knowledgeBaseId,
        query: normalizedQuery.value,
        kinds: [...request.kinds].sort(),
        scope: request.scope,
        fileKind: request.fileKind,
        okfFilters: request.okfFilters,
        rerank: request.rerank,
        rerankTopK: request.rerankTopK,
        rerankScoreThreshold: request.rerankScoreThreshold,
        activeRerankerRevisionPublicId,
        semanticGenerationPublicId: projection.publicId,
        embeddingConfigurationRevisionPublicId:
          projection.embeddingConfigurationRevisionPublicId,
        embeddingQueryPolicyRevisionPublicId:
          projection.embeddingQueryPolicyRevisionPublicId
            ?? projection.embeddingConfigurationRevisionPublicId,
        minimumVectorRelevance: projection.minimumVectorRelevance
          ?? SEARCH_PROVIDER_MINIMUM_VECTOR_RELEVANCE_SCORE,
        mappingFingerprintSha256: projection.mappingFingerprintSha256,
        lexicalIndexUid: lexicalProjection?.providerIndexUid ?? null
      });
      const cursor = decodeCursor(request.cursor, scopeHash);
      const settings = await input.resolveRuntimeSettings();
      const semanticLimit = Math.min(1_000, cursor.offset + request.limit);
      try {
        const result = await input.semantic.search({
          knowledgeBaseId: request.knowledgeBaseId,
          query: normalizedQuery.value,
          mode: mode(request.kinds),
          scope: request.scope,
          fileKind: request.fileKind,
          okfFilters: request.okfFilters,
          limit: semanticLimit,
          rerank: request.rerank,
          rerankTopK: request.rerankTopK,
          rerankScoreThreshold: request.rerankScoreThreshold,
          overallDeadlineMs: settings.requestTimeoutMs,
          laneCutoffMs: Math.min(
            settings.searchLaneCutoffMs,
            settings.requestTimeoutMs
          ),
          projection: {
            semanticGenerationPublicId: projection.publicId,
            embeddingConfigurationRevisionPublicId:
              projection.embeddingConfigurationRevisionPublicId,
            vectorIndexUid: semanticVectorIndexUid({
              indexPrefix: input.vectorIndexPrefix,
              knowledgeBaseId: request.knowledgeBaseId,
              semanticGenerationPublicId: projection.publicId,
              mappingFingerprintSha256: projection.mappingFingerprintSha256
            }),
            ...(lexicalProjection
              ? { lexicalIndexUid: lexicalProjection.providerIndexUid }
              : {}),
            dimension: projection.resolvedDimension,
            normalization: projection.normalization ?? "l2",
            embeddingQueryPolicyRevisionPublicId:
              projection.embeddingQueryPolicyRevisionPublicId
                ?? projection.embeddingConfigurationRevisionPublicId,
            minimumVectorRelevance: projection.minimumVectorRelevance
              ?? SEARCH_PROVIDER_MINIMUM_VECTOR_RELEVANCE_SCORE
          },
          signal: null
        });
        const hydrated = await input.hydration.hydrateCurrentSources({
          knowledgeBaseId: request.knowledgeBaseId,
          sourceFilePublicIds: result.items.map((item) => item.sourceFilePublicId)
        });
        const current = new Map(hydrated.map((source) => [
          source.sourceFilePublicId,
          source
        ]));
        const valid = result.items.flatMap((item) => {
          const source = current.get(item.sourceFilePublicId);
          return source
            && source.sourceRevisionPublicId === item.sourceRevisionPublicId
            && source.logicalPath === item.logicalPath
            && (request.fileKind === null || request.fileKind === "page")
            && matchesOkfSearchFilters(
              createOkfSearchSignals(source.metadata),
              request.okfFilters
            )
            ? [{ item, source }]
            : [];
        });
        const selected = valid.slice(cursor.offset, cursor.offset + request.limit);
        const nextOffset = cursor.offset + selected.length;
        return {
          items: selected.map(({ item, source }): StorageVnextSearchResult => ({
            publicId: source.sourceFilePublicId,
            sourceFilePublicId: source.sourceFilePublicId,
            logicalPath: source.logicalPath,
            title: source.title,
            snippet: item.explanations[0]?.slice(0, 1_200) ?? null,
            score: item.score,
            kind: "file",
            metadata: structuredClone(source.metadata),
            evidenceFamilies: [...item.evidenceFamilies],
            matchedFields: [...item.matchedFields],
            evidenceTypes: [...item.evidenceTypes],
            sourceExcerpt: item.sourceExcerpt
          })),
          nextCursor: (valid.length > nextOffset || result.hasMore === true)
            && nextOffset < 1_000
            ? encodeCursor({ version: 1, scopeHash, offset: nextOffset })
            : null,
          semanticStatus: result.semanticStatus,
          evidenceStatus: result.evidenceStatus ?? {
            completedFamilies: [],
            degradedFamilies: []
          },
          rerankerStatus: result.rerankerStatus ?? {
            state: "skipped",
            safeCode: "RERANKER_DISABLED"
          }
        };
      } catch (error) {
        if (error instanceof StorageVnextActiveSearchInputError) throw error;
        const page = await input.fallback.search(request);
        return {
          ...page,
          semanticStatus: {
            state: "degraded",
            safeCode: "SEMANTIC_SEARCH_UNAVAILABLE"
          },
          evidenceStatus: fallbackEvidenceStatus(request, page.evidenceStatus),
          rerankerStatus: page.rerankerStatus ?? rerankerUnavailableStatus(
            request.rerank
          )
        };
      }
    }
  };
}

function rerankerUnavailableStatus(rerank: boolean) {
  return rerank
    ? { state: "skipped" as const, safeCode: "RERANKER_RETRIEVAL_UNAVAILABLE" }
    : { state: "skipped" as const, safeCode: "RERANKER_DISABLED" };
}

function fallbackEvidenceStatus(
  request: Parameters<StorageVnextSearchQueryPort["search"]>[0],
  status: {
    completedFamilies: readonly string[];
    degradedFamilies: readonly string[];
  } | undefined
) {
  const plan = createSemanticSearchPlan({
    mode: mode(request.kinds),
    scope: request.scope ?? "all",
    resultLimit: request.limit
  });
  const completedFamilies = [...new Set(status?.completedFamilies ?? [])];
  const eligibleFamilies = [
    ...plan.rankedLanes,
    ...plan.vectorLanes.map(({ lane }) => lane)
  ];
  return {
    completedFamilies,
    degradedFamilies: [...new Set([
      ...(status?.degradedFamilies ?? []),
      ...eligibleFamilies.filter((family) => !completedFamilies.includes(family))
    ])]
  };
}

async function resolveRerankerRevision(
  rerank: boolean,
  resolve: (() => Promise<string | null>) | undefined
): Promise<string | null> {
  if (!rerank || !resolve) return null;
  try {
    return await resolve();
  } catch {
    return "reranker-revision-unavailable";
  }
}

function unavailableCode(input: {
  projection: ActiveProjection | null;
  lexicalProjection: { providerKind: SearchProviderKind } | null;
  lexicalProjectionRequired: boolean;
}): string {
  if (!input.projection) return "SEMANTIC_ADOPTION_REQUIRED";
  if (input.lexicalProjectionRequired && !input.lexicalProjection) {
    return "SEMANTIC_LEXICAL_PROJECTION_UNAVAILABLE";
  }
  return "SEMANTIC_PROVIDER_ADOPTION_REQUIRED";
}

function assertRequest(
  request: Parameters<StorageVnextSearchQueryPort["search"]>[0],
  maximumPageSize: number
): void {
  const query = normalizeAndValidateSearchQuery(request.query);
  if (
    !request.knowledgeBaseId
    || !query.ok
    || !Number.isSafeInteger(request.limit)
    || request.limit < 1
    || request.limit > maximumPageSize
    || request.kinds.length < 1
    || !["all", "path", "metadata"].includes(request.scope ?? "all")
    || typeof request.rerank !== "boolean"
    || request.rerank && (
      !Number.isSafeInteger(request.rerankTopK)
      || Number(request.rerankTopK) < request.limit
      || Number(request.rerankTopK) > 50
      || !Number.isFinite(request.rerankScoreThreshold)
      || Number(request.rerankScoreThreshold) < 0
      || Number(request.rerankScoreThreshold) > 1
    )
    || !request.rerank && (
      request.rerankTopK !== null
      || request.rerankScoreThreshold !== null
    )
  ) throw new StorageVnextActiveSearchInputError("INVALID_SEARCH_INPUT");
}

function mode(kinds: readonly ("file" | "graph")[]) {
  return kinds.length > 1 ? "hybrid" as const
    : kinds[0] === "graph" ? "graph" as const : "file" as const;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function encodeCursor(value: Cursor): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor(value: string | null, scopeHash: string): Cursor {
  if (!value) return { version: 1, scopeHash, offset: 0 };
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
    if (
      decoded.version !== 1
      || decoded.scopeHash !== scopeHash
      || !Number.isSafeInteger(decoded.offset)
      || decoded.offset < 1
      || decoded.offset > 1_000
    ) throw new Error("invalid");
    return decoded;
  } catch {
    throw new StorageVnextActiveSearchInputError("INVALID_SEARCH_CURSOR");
  }
}
