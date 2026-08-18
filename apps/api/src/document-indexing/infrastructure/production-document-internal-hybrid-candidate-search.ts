import type { RuntimeConfig } from "../../config.js";
import type { DatabaseClient } from "../../db/client.js";
import type { EmbeddingGateway } from "../../semantic/embedding/gateway.js";
import type { EmbeddingConfigurationRepository } from
  "../../semantic/embedding/repository.js";
import { semanticVectorIndexUid } from
  "../../semantic/vector/projection-planner.js";
import {
  STORAGE_VNEXT_CONTENT_SCHEMA_VERSION,
  STORAGE_VNEXT_GRAPH_SEED_SCHEMA_VERSION
} from "../../storage-vnext/search/documents.js";
import type { SearchProviderRuntime } from
  "../../application/ports/search-provider-runtime.js";
import {
  fuseDocumentInternalHybridCandidates,
  hydrateDocumentInternalHybridCandidates,
  type DocumentInternalHybridFamily,
  type DocumentInternalHybridHit
} from "../application/document-internal-hybrid-candidates.js";
import type { createPostgresDocumentReferenceFactRepository } from
  "./postgres-document-reference-fact-repository.js";
import {
  readSearchProjection,
  readVectorProjection
} from "./production-document-processor-support.js";

const INTERNAL_CANDIDATE_DEADLINE_MS = 10_000;
const INTERNAL_CANDIDATE_VECTOR_MINIMUM_RELEVANCE = 0.45;
const MAXIMUM_LEXICAL_DISCOVERY_QUERIES = 4;
const MAXIMUM_METADATA_DISCOVERY_QUERIES = 2;
const MAXIMUM_JIEBA_DISCOVERY_QUERIES = 2;
const MAXIMUM_VECTOR_QUERY_BYTES = 2_048;

export function createProductionDocumentInternalHybridCandidateSearch(input: {
  sql: DatabaseClient;
  config: RuntimeConfig;
  provider: Pick<SearchProviderRuntime, "kind" | "query" | "vector">;
  embeddingConfigurations: EmbeddingConfigurationRepository;
  embeddingGateway: EmbeddingGateway;
  referenceFacts: ReturnType<typeof createPostgresDocumentReferenceFactRepository>;
}) {
  return {
    async find(request: {
      knowledgeBaseId: string;
      sourceFilePublicId: string;
      sourceRevisionPublicId: string;
      semanticGenerationPublicId: string;
      embeddingConfigurationRevisionPublicId: string;
      terms: readonly string[];
      limit: number;
      signal: AbortSignal;
    }) {
      request.signal.throwIfAborted();
      const terms = boundedTerms(request.terms);
      if (terms.length === 0) return [];
      const searchProjection = await readSearchProjection(input.sql, {
        knowledgeBaseId: request.knowledgeBaseId,
        providerKind: input.provider.kind
      });
      const laneLimit = Math.min(256, Math.max(30, request.limit * 3));
      const titleQuery = terms[0]!;
      const discoveryQueries = terms.slice(1);
      const lexicalQueries = (discoveryQueries.length > 0
        ? discoveryQueries : [titleQuery]).slice(0, MAXIMUM_LEXICAL_DISCOVERY_QUERIES);
      const metadataQueries = (discoveryQueries.length > 0
        ? discoveryQueries : [titleQuery]).slice(0, MAXIMUM_METADATA_DISCOVERY_QUERIES);
      const jiebaQueries = terms.filter((term) => /\p{Script=Han}/u.test(term))
        .slice(0, MAXIMUM_JIEBA_DISCOVERY_QUERIES);
      const vectorQuery = boundedSemanticQuery(terms);
      const lanes = await Promise.all([
        rankedLane("exact", [titleQuery], ["title", "logicalPath"],
          ["exact"], "all", "content"),
        rankedLane("lexical", lexicalQueries,
          ["title", "logicalPath", "searchText"],
          ["text", "phrase", "typo"], "last", "content"),
        rankedLane("jieba", jiebaQueries, ["title", "searchText"],
          ["jieba"], "all", "content"),
        rankedLane("metadata", metadataQueries,
          ["title", "logicalPath", "searchText"],
          ["text", "phrase"], "last", "graph_seed"),
        vectorLane(vectorQuery)
      ]);
      const fused = fuseDocumentInternalHybridCandidates({
        currentSourceFilePublicId: request.sourceFilePublicId,
        limit: request.limit,
        lanes
      });
      if (fused.length === 0) return [];
      const eligible = await input.referenceFacts.hydrateEligible({
        knowledgeBaseId: request.knowledgeBaseId,
        candidates: fused,
        limit: request.limit
      });
      return hydrateDocumentInternalHybridCandidates({
        candidates: fused,
        eligible: eligible.map((source) => ({
          sourceFilePublicId: source.sourceFilePublicId,
          sourceRevisionPublicId: source.sourceRevisionPublicId,
          logicalPath: source.normalizedPath,
          title: source.title,
          kind: source.sourceType ?? "document"
        }))
      });

      async function rankedLane(
        family: DocumentInternalHybridFamily,
        laneQueries: readonly string[],
        searchFields: readonly string[],
        evidenceFamilies: readonly ("exact" | "text" | "phrase" | "typo" | "jieba")[],
        matchingStrategy: "all" | "last",
        documentKind: "content" | "graph_seed"
      ) {
        const results = await Promise.all(laneQueries.map((laneQuery) =>
          input.provider.query.query({
            indexUid: searchProjection.providerIndexUid,
            query: laneQuery,
            evidenceFamilies,
            filters: {
              kind: "and",
              operands: [
                { kind: "equals", field: "knowledgeBaseId", value: request.knowledgeBaseId },
                { kind: "equals", field: "documentKind", value: documentKind },
                { kind: "equals", field: "schemaVersion", value: documentKind === "content"
                  ? STORAGE_VNEXT_CONTENT_SCHEMA_VERSION
                  : STORAGE_VNEXT_GRAPH_SEED_SCHEMA_VERSION },
                { kind: "equals", field: "fileKind", value: "page" }
              ]
            },
            searchFields,
            returnFields: [
              "id", "sourceFilePublicId", "sourceRevisionPublicId",
              "logicalPath", "title", "searchText", "rankingTerms"
            ],
            limit: laneLimit,
            continuation: null,
            cropLength: 1_200,
            deadlineMs: INTERNAL_CANDIDATE_DEADLINE_MS,
            matchingStrategy,
            distinctBy: "sourceFilePublicId"
          })));
        return {
          family,
          hits: interleaveProviderHits(results.map((result) =>
            result.hits.map(providerHit)), laneLimit)
        };
      }

      async function vectorLane(laneQuery: string) {
        if (!input.provider.vector || !input.config.search) {
          return { family: "content_vector" as const, hits: [] };
        }
        const configuration = await input.embeddingConfigurations.getRevision(
          request.embeddingConfigurationRevisionPublicId
        );
        if (!configuration || configuration.resolvedDimension === null
          || configuration.validationStatus !== "valid") {
          throw new Error("Document internal hybrid embedding configuration is unavailable");
        }
        const contract = await readVectorProjection(input.sql, {
          knowledgeBaseId: request.knowledgeBaseId,
          semanticGenerationPublicId: request.semanticGenerationPublicId,
          embeddingConfigurationRevisionPublicId:
            configuration.vectorProducingRevisionPublicId,
          providerKind: input.provider.kind
        });
        const [vector] = await input.embeddingGateway.embed({
          configuration,
          inputs: [laneQuery],
          signal: request.signal
        });
        if (!vector) throw new Error("Document internal hybrid query vector is unavailable");
        const result = await input.provider.vector.query({
          indexUid: semanticVectorIndexUid({
            indexPrefix: input.config.search.indexPrefix,
            knowledgeBaseId: request.knowledgeBaseId,
            semanticGenerationPublicId: request.semanticGenerationPublicId,
            mappingFingerprintSha256: contract.mappingFingerprintSha256
          }),
          knowledgeBaseId: request.knowledgeBaseId,
          semanticGenerationPublicId: request.semanticGenerationPublicId,
          embeddingConfigurationRevisionPublicId:
            configuration.vectorProducingRevisionPublicId,
          family: "content",
          fileKind: "page",
          dimension: configuration.resolvedDimension,
          vector,
          limit: laneLimit,
          minimumRelevance: INTERNAL_CANDIDATE_VECTOR_MINIMUM_RELEVANCE,
          deadlineMs: INTERNAL_CANDIDATE_DEADLINE_MS
        });
        return {
          family: "content_vector" as const,
          hits: result.hits.map((hit) => ({
            sourceFilePublicId: hit.sourceFilePublicId,
            sourceRevisionPublicId: hit.sourceRevisionPublicId,
            logicalPath: hit.evidenceTargetPath,
            title: hit.evidenceTargetPath.split("/").at(-1)?.replace(/\.md$/iu, "")
              || hit.sourceFilePublicId,
            evidenceExcerpt: hit.sourceExcerpt,
            rankingTerms: []
          }))
        };
      }
    }
  };
}

function providerHit(
  hit: Awaited<ReturnType<SearchProviderRuntime["query"]["query"]>>["hits"][number]
): DocumentInternalHybridHit {
  const rankingTerms = Array.isArray(hit.document.rankingTerms)
    ? hit.document.rankingTerms.filter((value): value is string =>
        typeof value === "string" && value.trim().length > 0
        && Buffer.byteLength(value, "utf8") <= 512)
    : [];
  return {
    sourceFilePublicId: hit.sourceFilePublicId,
    sourceRevisionPublicId: hit.sourceRevisionPublicId,
    logicalPath: hit.logicalPath,
    title: hit.title,
    evidenceExcerpt: hit.snippets[0] ?? "",
    rankingTerms: [...new Set(rankingTerms)].slice(0, 100)
  };
}

function boundedTerms(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.normalize("NFKC").trim())
    .filter((value) => value && Buffer.byteLength(value, "utf8") <= 512))]
    .slice(0, 32);
}

function boundedSemanticQuery(terms: readonly string[]): string {
  const selected: string[] = [];
  let bytes = 0;
  for (const term of terms.slice(0, 8)) {
    const added = Buffer.byteLength(term, "utf8") + (selected.length > 0 ? 1 : 0);
    if (bytes + added > MAXIMUM_VECTOR_QUERY_BYTES) break;
    selected.push(term);
    bytes += added;
  }
  return selected.join("\n");
}

function interleaveProviderHits(
  groups: readonly (readonly DocumentInternalHybridHit[])[],
  limit: number
): DocumentInternalHybridHit[] {
  const hits: DocumentInternalHybridHit[] = [];
  const seen = new Set<string>();
  const maximumRank = Math.max(0, ...groups.map((group) => group.length));
  for (let rank = 0; rank < maximumRank && hits.length < limit; rank += 1) {
    for (const group of groups) {
      const hit = group[rank];
      if (!hit) continue;
      const key = `${hit.sourceFilePublicId}\0${hit.sourceRevisionPublicId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(hit);
      if (hits.length >= limit) break;
    }
  }
  return hits;
}
