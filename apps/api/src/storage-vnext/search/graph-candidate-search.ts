import {
  SearchProviderError,
  type SearchProviderRuntime
} from "../../application/ports/search-provider-runtime.js";
import type { StorageVnextGraphNodeFact } from "../graph/ports.js";
import {
  STORAGE_VNEXT_GRAPH_SEED_SCHEMA_VERSION
} from "./documents.js";
import type {
  StorageVnextActiveSearchProjectionRepository
} from "./active-projection-repository.js";
import type {
  StorageVnextSearchProjectionRepository
} from "./projection-repository.js";

const SEARCH_ATTRIBUTES = ["title", "logicalPath", "searchText", "rankingTerms"];
const RESULT_ATTRIBUTES = [
  "sourceFilePublicId",
  "sourceRevisionPublicId",
  "logicalPath"
];
const MAXIMUM_QUERY_BYTES = 4_096;

export type StorageVnextGraphCandidateSearchPort = {
  findCandidates(input: {
    knowledgeBaseId: string;
    sourceFilePublicId: string;
    terms: readonly string[];
    limit: number;
  }): Promise<readonly StorageVnextGraphNodeFact[]>;
};

type CandidateSearchDeadline =
  | { deadlineMs: number; resolveDeadlineMs?: never }
  | { deadlineMs?: never; resolveDeadlineMs(): Promise<number> };

type CandidateSearchRetry = {
  retry?: {
    maximumAttempts: number;
    delayMs: number;
    sleep?(delayMs: number): Promise<void>;
  };
};

export function createStorageVnextGraphCandidateSearch(input: {
  projections: StorageVnextActiveSearchProjectionRepository;
  provider: Pick<SearchProviderRuntime, "kind" | "query">;
  graph: {
    listNodesBySourceFiles(request: {
      knowledgeBaseId: string;
      sourceFilePublicIds: readonly string[];
      limit: number;
    }): Promise<readonly StorageVnextGraphNodeFact[]>;
  };
} & CandidateSearchDeadline & CandidateSearchRetry): StorageVnextGraphCandidateSearchPort {
  return createGraphCandidateSearch({
    provider: input.provider,
    resolveDeadlineMs: deadlineResolver(input),
    graph: input.graph,
    retry: normalizeRetry(input.retry),
    resolveProjection: (knowledgeBaseId) =>
      input.projections.getActiveProjection(knowledgeBaseId)
  });
}

export function createStorageVnextGraphCandidateSearchForProjection(input: {
  searchProjectionPublicId: string;
  projections: Pick<StorageVnextSearchProjectionRepository, "getCandidate">;
  provider: Pick<SearchProviderRuntime, "kind" | "query">;
  deadlineMs: number;
  graph: {
    listNodesBySourceFiles(request: {
      knowledgeBaseId: string;
      sourceFilePublicIds: readonly string[];
      limit: number;
    }): Promise<readonly StorageVnextGraphNodeFact[]>;
  };
} & CandidateSearchRetry): StorageVnextGraphCandidateSearchPort {
  if (!input.searchProjectionPublicId) throw candidateSearchError("invalid_input");
  return createGraphCandidateSearch({
    provider: input.provider,
    resolveDeadlineMs: async () => input.deadlineMs,
    graph: input.graph,
    retry: normalizeRetry(input.retry),
    async resolveProjection(knowledgeBaseId) {
      const projection = await input.projections.getCandidate(
        input.searchProjectionPublicId
      );
      if (!projection || projection.state === "preparing" || projection.state === "failed") {
        return null;
      }
      if (projection.knowledgeBaseId !== knowledgeBaseId) {
        throw candidateSearchError("projection_scope_conflict");
      }
      return projection;
    }
  });
}

function createGraphCandidateSearch(input: {
  resolveProjection(knowledgeBaseId: string): Promise<{
    knowledgeBaseId: string;
    providerKind: "meilisearch" | "opensearch";
    providerIndexUid: string;
  } | null>;
  provider: Pick<SearchProviderRuntime, "kind" | "query">;
  resolveDeadlineMs(): Promise<number>;
  graph: {
    listNodesBySourceFiles(request: {
      knowledgeBaseId: string;
      sourceFilePublicIds: readonly string[];
      limit: number;
    }): Promise<readonly StorageVnextGraphNodeFact[]>;
  };
  retry: Required<NonNullable<CandidateSearchRetry["retry"]>>;
}): StorageVnextGraphCandidateSearchPort {
  return {
    async findCandidates(request) {
      const query = normalizeQuery(request);
      if (!query) return [];
      const projection = await input.resolveProjection(request.knowledgeBaseId);
      if (!projection) return [];
      if (projection.knowledgeBaseId !== request.knowledgeBaseId) {
        throw candidateSearchError("projection_scope_conflict");
      }
      if (projection.providerKind !== input.provider.kind) {
        throw candidateSearchError("projection_provider_conflict");
      }
      const result = await withRetry(async () => input.provider.query.query({
          indexUid: projection.providerIndexUid,
          query,
          evidenceFamilies: ["graph", "text", "jieba"],
          filters: {
            kind: "and",
            operands: [{
              kind: "equals",
              field: "knowledgeBaseId",
              value: request.knowledgeBaseId
            }, {
              kind: "equals",
              field: "documentKind",
              value: "graph_seed"
            }, {
              kind: "equals",
              field: "schemaVersion",
              value: STORAGE_VNEXT_GRAPH_SEED_SCHEMA_VERSION
            }]
          },
          limit: Math.min(1_000, request.limit + 1),
          searchFields: SEARCH_ATTRIBUTES,
          returnFields: RESULT_ATTRIBUTES,
          continuation: null,
          cropLength: 0,
          deadlineMs: await input.resolveDeadlineMs(),
          matchingStrategy: "last",
          distinctBy: "sourceFilePublicId"
        }), input.retry);
      const candidates = uniqueHits(result.hits, request.sourceFilePublicId)
        .slice(0, request.limit);
      if (candidates.length === 0) return [];
      const nodes = await input.graph.listNodesBySourceFiles({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFilePublicIds: candidates.map((candidate) => candidate.sourceFilePublicId),
        limit: request.limit
      });
      const currentBySource = new Map(nodes.map((node) => [node.sourceFilePublicId, node]));
      return candidates.flatMap((candidate) => {
        const node = currentBySource.get(candidate.sourceFilePublicId);
        return node
          && node.knowledgeBaseId === request.knowledgeBaseId
          && node.sourceRevisionPublicId === candidate.sourceRevisionPublicId
          && node.logicalPath === candidate.logicalPath
          ? [node]
          : [];
      });
    }
  };
}

function normalizeRetry(
  retry: CandidateSearchRetry["retry"]
): Required<NonNullable<CandidateSearchRetry["retry"]>> {
  const normalized = {
    maximumAttempts: retry?.maximumAttempts ?? 3,
    delayMs: retry?.delayMs ?? 100,
    sleep: retry?.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    }))
  };
  if (
    !Number.isSafeInteger(normalized.maximumAttempts)
    || normalized.maximumAttempts < 1
    || normalized.maximumAttempts > 10
    || !Number.isSafeInteger(normalized.delayMs)
    || normalized.delayMs < 0
    || normalized.delayMs > 10_000
  ) throw candidateSearchError("invalid_retry_policy");
  return normalized;
}

async function withRetry<T>(
  operation: () => Promise<T>,
  retry: Required<NonNullable<CandidateSearchRetry["retry"]>>
): Promise<T> {
  for (let attempt = 1; attempt <= retry.maximumAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (
        !(error instanceof SearchProviderError)
        || !error.retryable
        || attempt === retry.maximumAttempts
      ) throw error;
      await retry.sleep(retry.delayMs * attempt);
    }
  }
  throw candidateSearchError("retry_exhausted");
}

function deadlineResolver(input: CandidateSearchDeadline): () => Promise<number> {
  return input.resolveDeadlineMs ?? (async () => input.deadlineMs);
}

function normalizeQuery(input: {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  terms: readonly string[];
  limit: number;
}): string {
  if (
    !input.knowledgeBaseId
    || !input.sourceFilePublicId
    || !Number.isSafeInteger(input.limit)
    || input.limit < 1
    || input.limit > 1_000
    || input.terms.length > 100
  ) throw candidateSearchError("invalid_input");
  const terms = [...new Set(input.terms.map((term) => term.trim()).filter(Boolean))];
  const bounded: string[] = [];
  let queryBytes = 0;
  for (const term of terms) {
    const termBytes = Buffer.byteLength(term, "utf8");
    const separatorBytes = bounded.length > 0 ? 1 : 0;
    if (queryBytes + separatorBytes + termBytes > MAXIMUM_QUERY_BYTES) continue;
    bounded.push(term);
    queryBytes += separatorBytes + termBytes;
  }
  return bounded.join(" ");
}

function uniqueHits(
  hits: Awaited<ReturnType<SearchProviderRuntime["query"]["query"]>>["hits"],
  excludedSourceFilePublicId: string
): Array<{
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  logicalPath: string;
}> {
  const output = new Map<string, {
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
    logicalPath: string;
  }>();
  for (const hit of hits) {
    const sourceFilePublicId = readString(hit.sourceFilePublicId);
    const sourceRevisionPublicId = readString(hit.sourceRevisionPublicId);
    const logicalPath = readString(hit.logicalPath);
    if (
      !sourceFilePublicId
      || sourceFilePublicId === excludedSourceFilePublicId
      || !sourceRevisionPublicId
      || !logicalPath
      || output.has(sourceFilePublicId)
    ) continue;
    output.set(sourceFilePublicId, {
      sourceFilePublicId,
      sourceRevisionPublicId,
      logicalPath
    });
  }
  return [...output.values()];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function candidateSearchError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext graph candidate search error: ${code}`),
    { code }
  );
}
