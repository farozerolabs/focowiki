import type {
  ActiveGenerationPage,
  ActiveGenerationProjection,
  ActiveGenerationScoredCursor
} from "../application/ports/active-generation-read-repository.js";
import type { DatabaseClient } from "../db/client.js";
import {
  loadActiveSearchHydrationRecords
} from "../infrastructure/postgres/search-hydration-repository.js";
import {
  loadActiveAcceptedGraphEdges
} from "../infrastructure/postgres/search-graph-edge-repository.js";
import type { TransactionSql } from "postgres";
import {
  fuseSearchCandidates,
  type SearchFusionCandidate,
  type SearchFusionCursor
} from "./rank-fusion.js";
import {
  hydrateSearchCandidates
} from "./search-hydration.js";
import type {
  SearchRetrieval,
  SearchRetrievalCandidate,
  SearchRetrievalPage
} from "./search-retrieval.js";
import { expandGraphRetrievalPage } from "./search-graph-retrieval.js";

type ReadSql = DatabaseClient | TransactionSql;

export type ActiveSearch = {
  search(input: {
    sql: ReadSql;
    knowledgeBaseId: string;
    generationId: string;
    activeEpoch: number;
    query: string;
    mode: "file" | "graph" | "hybrid";
    scope?: "all" | "path" | "metadata";
    fileKind?: string | null;
    graphDepth?: 0 | 1 | 2;
    limit: number;
    cursor: ActiveGenerationScoredCursor | null;
  }): Promise<ActiveGenerationPage<
    ActiveGenerationProjection,
    ActiveGenerationScoredCursor
  >>;
};

export type ActiveSearchSettings = {
  overfetchFactor: number;
  fusedCandidateLimit: number;
  graphNeighborLimit: number;
  requestTimeoutMs: number;
};

export function createActiveSearch(input: {
  retrieval: SearchRetrieval;
  overfetchFactor?: number;
  fusedCandidateLimit?: number;
  graphNeighborLimit?: number;
  requestTimeoutMs?: number;
  getSettings?: () => Promise<ActiveSearchSettings>;
}): ActiveSearch {
  if (!input.getSettings) validateSettings(readStaticSettings(input));

  return {
    async search(searchInput) {
      const settings = input.getSettings
        ? await input.getSettings()
        : readStaticSettings(input);
      validateSettings(settings);
      const candidateLimit = Math.min(
        settings.fusedCandidateLimit,
        Math.max(searchInput.limit + 1, (searchInput.limit + 1) * settings.overfetchFactor)
      );
      if (
        searchInput.fileKind !== undefined
        && searchInput.fileKind !== null
        && searchInput.fileKind !== "page"
      ) {
        return { items: [], nextCursor: null };
      }
      const cursor = toFusionCursor(searchInput.cursor);
      const page = await withTimeout(
        searchInput.mode === "file"
          ? input.retrieval.searchContent({
              ...searchInput,
              limit: candidateLimit,
              cursor
            })
          : searchInput.mode === "graph"
            ? retrieveExpandedGraph(input.retrieval, {
                ...searchInput,
                limit: candidateLimit,
                cursor,
                neighborLimitPerSeed: settings.graphNeighborLimit,
                depth: searchInput.graphDepth ?? 1
              })
            : retrieveHybrid(input.retrieval, {
                ...searchInput,
                limit: candidateLimit,
                cursor,
                neighborLimitPerSeed: settings.graphNeighborLimit,
                depth: searchInput.graphDepth ?? 1
              }),
        settings.requestTimeoutMs
      );
      const hydrated = await hydrateSearchCandidates({
        generationId: searchInput.generationId,
        candidates: page.items,
        limit: searchInput.limit + 1,
        load: (sourceFileIds) => loadActiveSearchHydrationRecords({
          sql: searchInput.sql,
          knowledgeBaseId: searchInput.knowledgeBaseId,
          sourceFileIds,
          projection: searchInput.mode === "graph" ? "graph_node" : "search"
        })
      });
      const visible = hydrated.items.slice(0, searchInput.limit);
      const last = visible.at(-1);
      const lastCandidate = last?.sourceFileId
        ? page.items.find((candidate) => candidate.sourceFileId === last.sourceFileId)
        : null;
      return {
        items: visible,
        nextCursor: last && lastCandidate
          && (hydrated.items.length > searchInput.limit || page.nextCursor)
          ? {
              score: lastCandidate.fusedScore,
              exactPriority: lastCandidate.exactPriority,
              recordId: lastCandidate.sourceFileId
            }
          : null
      };
    }
  };
}

function readStaticSettings(input: {
  overfetchFactor?: number;
  fusedCandidateLimit?: number;
  graphNeighborLimit?: number;
  requestTimeoutMs?: number;
}): ActiveSearchSettings {
  return {
    overfetchFactor: input.overfetchFactor ?? 0,
    fusedCandidateLimit: input.fusedCandidateLimit ?? 0,
    graphNeighborLimit: input.graphNeighborLimit ?? 0,
    requestTimeoutMs: input.requestTimeoutMs ?? 3_000
  };
}

function validateSettings(settings: ActiveSearchSettings): void {
  assertBound(settings.overfetchFactor, 1, 10, "Search overfetch factor");
  assertBound(settings.fusedCandidateLimit, 1, 2_000, "Search fused candidate limit");
  assertBound(settings.graphNeighborLimit, 1, 1_000, "Graph neighbor limit");
  assertBound(settings.requestTimeoutMs, 100, 30_000, "Search request timeout");
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new ActiveSearchTimeoutError());
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class ActiveSearchTimeoutError extends Error {
  public readonly code = "SEARCH_SERVICE_TIMEOUT";

  public constructor() {
    super("Search service timed out");
    this.name = "ActiveSearchTimeoutError";
  }
}

async function retrieveHybrid(
  retrieval: SearchRetrieval,
  input: {
    knowledgeBaseId: string;
    sql: ReadSql;
    activeEpoch: number;
    query: string;
    limit: number;
    cursor: SearchFusionCursor | null;
    neighborLimitPerSeed: number;
    depth: 0 | 1 | 2;
    scope?: "all" | "path" | "metadata";
    fileKind?: string | null;
  }
): Promise<SearchRetrievalPage> {
  const [content, graph] = await Promise.all([
    retrieval.searchContent({ ...input, cursor: null }),
    retrieveExpandedGraph(retrieval, { ...input, cursor: null })
  ]);
  const evidence = new Map<string, SearchRetrievalCandidate>();
  const candidates: SearchFusionCandidate[] = [];
  appendFamilyCandidates(content.items, evidence, candidates);
  appendFamilyCandidates(graph.items, evidence, candidates);
  const fused = fuseSearchCandidates({
    candidates,
    limit: input.limit,
    cursor: input.cursor
  });
  return {
    items: fused.items.flatMap((item) => {
      const candidate = evidence.get(item.sourceFileId);
      return candidate
        ? [{
            ...candidate,
            exactPriority: item.exactPriority,
            fusedScore: item.fusedScore,
            families: item.families,
            relationshipReasons: item.relationshipReasons
          }]
        : [];
    }),
    nextCursor: fused.nextCursor
  };
}

async function retrieveExpandedGraph(
  retrieval: SearchRetrieval,
  input: {
    sql: ReadSql;
    knowledgeBaseId: string;
    activeEpoch: number;
    query: string;
    limit: number;
    cursor: SearchFusionCursor | null;
    neighborLimitPerSeed: number;
    depth: 0 | 1 | 2;
    scope?: "all" | "path" | "metadata";
    fileKind?: string | null;
  }
): Promise<SearchRetrievalPage> {
  const seeds = await retrieval.searchGraphSeeds({
    knowledgeBaseId: input.knowledgeBaseId,
    activeEpoch: input.activeEpoch,
    query: input.query,
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    ...(input.fileKind === undefined ? {} : { fileKind: input.fileKind }),
    limit: input.limit,
    cursor: null
  });
  return expandGraphRetrievalPage({
    seeds,
    neighborLimitPerSeed: input.neighborLimitPerSeed,
    depth: input.depth,
    limit: input.limit,
    cursor: input.cursor,
    listAcceptedEdges: (seedSourceFileIds, limitPerSeed) =>
      loadActiveAcceptedGraphEdges({
        sql: input.sql,
        knowledgeBaseId: input.knowledgeBaseId,
        seedSourceFileIds,
        limitPerSeed
      })
  });
}

function appendFamilyCandidates(
  items: SearchRetrievalCandidate[],
  evidence: Map<string, SearchRetrievalCandidate>,
  candidates: SearchFusionCandidate[]
): void {
  for (const [index, item] of items.entries()) {
    if (!evidence.has(item.sourceFileId)) evidence.set(item.sourceFileId, item);
    for (const family of item.families) {
      candidates.push({
        sourceFileId: item.sourceFileId,
        family,
        familyRank: index + 1,
        familyScore: 1
      });
    }
  }
}

function toFusionCursor(
  cursor: ActiveGenerationScoredCursor | null
): SearchFusionCursor | null {
  return cursor
    ? {
        exactPriority: cursor.exactPriority ?? 0,
        fusedScore: cursor.score,
        sourceFileId: cursor.recordId
      }
    : null;
}

function assertBound(
  value: number,
  minimum: number,
  maximum: number,
  label: string
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
}
