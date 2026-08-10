import { randomUUID } from "node:crypto";
import { graphRefForFile } from "@focowiki/okf";
import type { DatabaseClient } from "../../db/client.js";
import {
  conflict,
  createDeveloperOpenApiError,
  notFound,
  payloadTooLarge,
  repositoryUnavailable,
  validationError
} from "../../developer-openapi/errors.js";
import { SearchProviderError } from
  "../../application/ports/search-provider-runtime.js";
import { GENERATED_GRAPH_RESOURCES } from "../../okf/generated-graph-resources.js";
import type { StorageVnextCatalogRepository } from "../catalog/ports.js";
import { StorageVnextCatalogRepositoryError } from "../catalog/postgres-repository.js";
import type { StorageVnextReleaseReadPort } from "../release/ports.js";
import type { StorageVnextSearchQueryPort } from "../search/ports.js";
import { StorageVnextActiveSearchInputError } from "../search/active-search.js";
import type { StorageVnextSourceEventReadPort } from "../source-events/ports.js";
import { StorageVnextSourceEventRepositoryError } from
  "../source-events/postgres-repository.js";
import type { StorageVnextAdminCoreApplication } from "./admin-core-application.js";
import type { StorageVnextAdminReadApplication } from "./admin-read-application.js";
import type { StorageVnextAdminSourceApplication } from "./admin-source-application.js";
import type { StorageVnextAdminMutationApplication } from "./admin-mutation-application.js";
import type { DeveloperOpenApiApplication } from "./openapi-application.js";
import {
  assertOpenApiPublicFilePath,
  emptyOpenApiSearchResponse,
  openApiNoCandidateSearchHints,
  openApiNextRequestTemplates,
  openApiSearchQuery,
  presentOpenApiGeneratedFile,
  presentOpenApiGraphOverview,
  presentOpenApiKnowledgeBase,
  presentOpenApiRelationship,
  presentOpenApiSearchResult,
  presentOpenApiSourceEvent,
  presentOpenApiTreeEntry
} from "./openapi-presenters.js";
import {
  findStorageVnextGeneratedIdentity,
  listStorageVnextGraphExpansionRelationships,
  listStorageVnextRelationships,
  listStorageVnextSearchGraphContexts,
  readStorageVnextGraphSearchSummary,
  resolveStorageVnextGraphSeed,
  type StorageVnextOpenApiSearchGraphContext
} from "./postgres-openapi-read.js";
import type { createPostgresStorageVnextOpenApiWebhooks } from "./postgres-openapi-webhooks.js";
import type { StorageVnextKnowledgeBaseCreationPort } from
  "./postgres-knowledge-base-creation.js";

export function createPostgresStorageVnextOpenApiApplication(input: {
  sql: DatabaseClient;
  catalog: StorageVnextCatalogRepository;
  releases: StorageVnextReleaseReadPort;
  adminRead: StorageVnextAdminReadApplication;
  adminCore: StorageVnextAdminCoreApplication;
  resources: StorageVnextAdminMutationApplication;
  sourceEvents: StorageVnextSourceEventReadPort;
  source: StorageVnextAdminSourceApplication;
  search: StorageVnextSearchQueryPort | null;
  webhooks: ReturnType<typeof createPostgresStorageVnextOpenApiWebhooks>;
  knowledgeBaseCreation?: StorageVnextKnowledgeBaseCreationPort;
}): DeveloperOpenApiApplication {
  return {
    async createKnowledgeBase(request) {
      const name = request.name.trim();
      if (!name) throw validationError("Knowledge base name is required.", { field: "name" });
      const record = await (input.knowledgeBaseCreation ?? {
        create: input.catalog.createKnowledgeBase.bind(input.catalog)
      }).create({
        publicId: `knowledge-base-${randomUUID()}`,
        name,
        description: request.description?.trim() || null
      });
      return { knowledgeBase: presentOpenApiKnowledgeBase(record, null) };
    },

    async listKnowledgeBases(request) {
      let page;
      try {
        page = await input.catalog.listKnowledgeBases(request);
      } catch (error) {
        if (
          error instanceof StorageVnextCatalogRepositoryError
          && error.code === "invalid_cursor"
        ) {
          throw validationError("Pagination cursor is invalid.", { field: "cursor" });
        }
        throw error;
      }
      const items = await Promise.all(page.items.map(async (record) =>
        presentOpenApiKnowledgeBase(record, await input.releases.getActiveRoot(record.publicId))
      ));
      return { items, nextCursor: page.nextCursor };
    },

    async getKnowledgeBase(knowledgeBaseId) {
      const record = await input.catalog.getKnowledgeBase({ knowledgeBaseId });
      if (!record) throw notFound();
      return {
        knowledgeBase: presentOpenApiKnowledgeBase(
          record,
          await input.releases.getActiveRoot(knowledgeBaseId)
        )
      };
    },

    getSourceFile: (request) => input.resources.getSourceFile(request),

    async readSourceContent(request) {
      const result = await input.resources.readSourceContent(request);
      if (!result) throw notFound("Uploaded Markdown content was not found.");
      return result;
    },

    async listSourceFileEvents(request) {
      const source = await input.resources.getSourceFile(request);
      if (!source) throw notFound();
      try {
        const page = await input.sourceEvents.list(request);
        return {
          items: page.items.map(presentOpenApiSourceEvent),
          nextCursor: page.nextCursor
        };
      } catch (error) {
        if (
          error instanceof StorageVnextSourceEventRepositoryError
          && error.code === "invalid_cursor"
        ) {
          throw validationError("Pagination cursor is invalid.", { field: "cursor" });
        }
        throw repositoryUnavailable();
      }
    },

    async retrySourceFile(request) {
      const result = await input.source.retrySourceFile(request);
      if (result.ok) return result.value.retry;
      if (result.code === "NOT_FOUND") throw notFound();
      if (result.code === "DATABASE_REPOSITORY_UNAVAILABLE") throw repositoryUnavailable();
      if (result.code === "SOURCE_FILE_RETRY_NOT_ALLOWED") {
        throw conflict("This source-file failure cannot be retried.");
      }
      throw conflict("The source file is being changed or deleted. Retry is unavailable.");
    },

    async listTree(request) {
      const result = await input.adminRead.listTree({
        knowledgeBaseId: request.knowledgeBaseId,
        parentPath: request.parentPath,
        entryType: request.entryType,
        query: request.query,
        limit: request.limit,
        cursor: request.cursor
      });
      if (!result.ok) {
        if (result.code === "NOT_FOUND") throw notFound();
        if (result.code === "INVALID_PAGINATION") {
          throw validationError("Pagination cursor is invalid.", { field: "cursor" });
        }
        throw repositoryUnavailable();
      }
      const root = await input.releases.getActiveRoot(request.knowledgeBaseId);
      return {
        generationId: root?.publicId ?? null,
        items: result.value.items.map((entry) => presentOpenApiTreeEntry(
          request.knowledgeBaseId,
          root?.publicId ?? null,
          entry
        )),
        nextCursor: result.value.nextCursor
      };
    },

    async searchFiles(request) {
      if (!input.search) throw repositoryUnavailable();
      const root = await input.releases.getActiveRoot(request.knowledgeBaseId);
      if (!root) return emptyOpenApiSearchResponse(request, null);
      const normalizedQuery = request.query;
      if (!normalizedQuery) throw validationError("Search query is required.", { field: "query" });
      if (request.fileKind !== null && request.fileKind !== "page") {
        throw validationError("Search file kind is invalid.", { field: "fileKind" });
      }
      const kinds = request.mode === "file" ? ["file" as const]
        : request.mode === "graph" ? ["graph" as const]
          : ["file" as const, "graph" as const];
      let page;
      try {
        page = await input.search.search({
          knowledgeBaseId: request.knowledgeBaseId,
          query: normalizedQuery,
          kinds,
          scope: request.scope,
          fileKind: request.fileKind,
          limit: request.limit,
          rerank: request.rerank,
          rerankTopK: request.rerankTopK,
          rerankScoreThreshold: request.rerankScoreThreshold,
          cursor: request.cursor,
          okfFilters: request.okfFilters ?? {
            status: null,
            trustTier: null,
            freshness: null,
            requestEpochDay: null
          }
        });
      } catch (error) {
        throw mapSearchError(error);
      }
      const [graphContexts, graphSummary] = request.mode === "file"
        ? [new Map<string, StorageVnextOpenApiSearchGraphContext>(), {
            indexedDocumentCount: 0,
            indexedRelationshipCount: 0
          }] as const
        : await Promise.all([
            listStorageVnextSearchGraphContexts(input.sql, {
              knowledgeBaseId: request.knowledgeBaseId,
              sourceFileIds: page.items.map((item) => item.sourceFilePublicId),
              depth: request.graphDepth,
              limitPerSource: request.graphFanout
            }),
            readStorageVnextGraphSearchSummary(input.sql, request.knowledgeBaseId)
          ]);
      const items = page.items.map((item) => {
        const graph = graphContexts.get(item.sourceFilePublicId);
        return presentOpenApiSearchResult({
          knowledgeBaseId: request.knowledgeBaseId,
          generationId: root.publicId,
          mode: request.mode,
          depth: request.graphDepth,
          nodePublicId: graph?.nodePublicId ?? null,
          item,
          relationships: graph?.relationships ?? []
        });
      });
      return {
        generationId: root.publicId,
        query: openApiSearchQuery(request, normalizedQuery),
        items,
        nextCursor: page.nextCursor,
        ...(page.semanticStatus ? { semanticStatus: page.semanticStatus } : {}),
        ...(page.evidenceStatus ? { evidenceStatus: page.evidenceStatus } : {}),
        ...(page.rerankerStatus ? { rerankerStatus: page.rerankerStatus } : {}),
        searchStatus: items.length > 0 ? "ok" : "no_candidates",
        searchMode: request.mode,
        graphStatus: request.mode === "file" ? "disabled_for_file_mode" : "available",
        graphSummary: {
          available: request.mode !== "file",
          indexedDocumentCount: graphSummary.indexedDocumentCount,
          indexedRelationshipCount: graphSummary.indexedRelationshipCount,
          depth: request.graphDepth,
          fanout: request.graphFanout
        },
        resultSummary: {
          resultCount: items.length,
          hasMore: Boolean(page.nextCursor),
          sort: ["relevance_desc", "logical_path_asc", "source_file_id_asc"],
          meaning: items.length > 0
            ? "Results match the current published knowledge base."
            : "No current published files matched the search."
        },
        nextRequestTemplates: openApiNextRequestTemplates(request.knowledgeBaseId),
        ...(items.length > 0 ? {} : openApiNoCandidateSearchHints())
      };
    },

    async getFileById(request) {
      const identity = await findStorageVnextGeneratedIdentity(input.sql, request);
      if (!identity) throw notFound();
      const content = await readGenerated(input.adminCore, {
        knowledgeBaseId: request.knowledgeBaseId,
        logicalPath: identity.logical_path,
        includeRelationships: false
      });
      return {
        file: presentOpenApiGeneratedFile(
          request.knowledgeBaseId,
          await activeRootId(input.releases, request.knowledgeBaseId),
          content.file
        )
      };
    },

    async listRelatedFiles(request) {
      const identity = await findStorageVnextGeneratedIdentity(input.sql, request);
      if (!identity) throw notFound();
      if (!identity.source_file_public_id) {
        throw conflict("Only published files created from uploaded Markdown can return related files.");
      }
      const rootId = await activeRootId(input.releases, request.knowledgeBaseId);
      const page = await listStorageVnextRelationships(input.sql, {
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFileId: identity.source_file_public_id,
        limit: request.limit,
        cursor: request.cursor
      });
      return {
        generationId: rootId,
        fileId: request.fileId,
        sourceFileId: identity.source_file_public_id,
        items: page.items.map((item) => presentOpenApiRelationship(
          request.knowledgeBaseId,
          rootId,
          item
        )),
        nextCursor: page.nextCursor
      };
    },

    async expandGraph(request) {
      const seed = await resolveStorageVnextGraphSeed(input.sql, request);
      if (!seed) throw notFound();
      const rootId = await activeRootId(input.releases, request.knowledgeBaseId);
      const page = await listStorageVnextGraphExpansionRelationships(input.sql, {
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFileId: seed.sourceFileId,
        depth: request.depth,
        fanout: request.fanout,
        limit: request.limit,
        cursor: request.cursor
      });
      const seedIdentity = await findStorageVnextGeneratedIdentity(input.sql, {
        knowledgeBaseId: request.knowledgeBaseId,
        fileId: seed.sourceFileId
      });
      const seedContent = seedIdentity
        ? await readGenerated(input.adminCore, {
            knowledgeBaseId: request.knowledgeBaseId,
            logicalPath: seedIdentity.logical_path,
            includeRelationships: false
          })
        : null;
      return {
        generationId: rootId,
        query: {
          fileId: request.fileId,
          nodeId: request.nodeId,
          edgeId: request.edgeId,
          query: request.query,
          normalizedQuery: request.query?.trim() || null,
          depth: request.depth,
          fanout: request.fanout,
          limit: request.limit,
          cursorProvided: Boolean(request.cursor)
        },
        seedFile: seedContent
          ? presentOpenApiGeneratedFile(request.knowledgeBaseId, rootId, seedContent.file)
          : null,
        seedResults: [],
        relationships: page.items.map((item) => presentOpenApiRelationship(
          request.knowledgeBaseId,
          rootId,
          item
        )),
        graphPaths: [...new Set([
          seed.sourceFileId,
          ...page.items.flatMap((item) => [
            item.from_source_file_public_id ?? seed.sourceFileId,
            item.source_file_public_id
          ])
        ])]
          .map(graphRefForFile),
        nextCursor: page.nextCursor,
        resultSummary: {
          seedCount: seedContent ? 1 : 0,
          relationshipCount: page.items.length,
          hasMore: Boolean(page.nextCursor),
          depth: request.depth,
          fanout: request.fanout,
          meaning: "Relationships connect source-backed files in the current published version."
        }
      };
    },

    async getGraphOverview(request) {
      const rootId = await activeRootId(input.releases, request.knowledgeBaseId);
      const rows = await input.sql<Array<{
        node_count: number | string;
        edge_count: number | string;
        graph_index_available: boolean;
      }>>`
        SELECT
          (SELECT count(*) FROM focowiki.graph_nodes
           WHERE knowledge_base_id = ${request.knowledgeBaseId}) AS node_count,
          (SELECT count(*) FROM focowiki.graph_edges
           WHERE knowledge_base_id = ${request.knowledgeBaseId}) AS edge_count,
          EXISTS (
            SELECT 1 FROM focowiki.release_roots root
            CROSS JOIN LATERAL focowiki.resolve_release_catalog(root.public_id) entry
            WHERE root.knowledge_base_id = ${request.knowledgeBaseId}
              AND root.root_role = 'active'
              AND entry.logical_path = ${GENERATED_GRAPH_RESOURCES.index.path}
          ) AS graph_index_available
      `;
      const summary = rows[0];
      const nodeCount = safeCount(summary?.node_count ?? 0);
      const edgeCount = safeCount(summary?.edge_count ?? 0);
      const available = Boolean(summary?.graph_index_available);
      return presentOpenApiGraphOverview({
        knowledgeBaseId: request.knowledgeBaseId,
        generationId: rootId,
        nodeCount,
        edgeCount,
        graphIndexAvailable: available
      });
    },

    async getFileContentById(request) {
      const identity = await findStorageVnextGeneratedIdentity(input.sql, request);
      if (!identity) throw notFound();
      return generatedContentResponse(input, request.knowledgeBaseId, identity.logical_path);
    },

    async getFileContentByPath(request) {
      assertOpenApiPublicFilePath(request.path);
      return generatedContentResponse(input, request.knowledgeBaseId, request.path);
    },

    createWebhook: (request) => input.webhooks.create(request),
    listWebhooks: (request) => input.webhooks.list(request),
    deleteWebhook: (webhookId) => input.webhooks.remove(webhookId),
    listWebhookDeliveries: (request) => input.webhooks.listDeliveries(request),
    redeliverWebhook: (deliveryId) => input.webhooks.redeliver(deliveryId)
  };
}

async function generatedContentResponse(
  input: Parameters<typeof createPostgresStorageVnextOpenApiApplication>[0],
  knowledgeBaseId: string,
  logicalPath: string
) {
  const content = await readGenerated(input.adminCore, {
    knowledgeBaseId,
    logicalPath,
    includeRelationships: false
  });
  return {
    file: presentOpenApiGeneratedFile(
      knowledgeBaseId,
      await activeRootId(input.releases, knowledgeBaseId),
      content.file
    ),
    content: content.content
  };
}

async function readGenerated(
  core: StorageVnextAdminCoreApplication,
  request: Parameters<StorageVnextAdminCoreApplication["readGeneratedContent"]>[0]
) {
  const result = await core.readGeneratedContent(request);
  if (!result.ok) {
    if (result.code === "NOT_FOUND") throw notFound();
    throw repositoryUnavailable();
  }
  if (result.value instanceof Response) {
    if (result.value.status === 413) {
      throw payloadTooLarge("The requested file exceeds the configured content read limit.");
    }
    throw repositoryUnavailable();
  }
  const file = record(result.value.file);
  if (!file || typeof result.value.content !== "string") throw repositoryUnavailable();
  return { file, content: result.value.content };
}

async function activeRootId(releases: StorageVnextReleaseReadPort, knowledgeBaseId: string) {
  const root = await releases.getActiveRoot(knowledgeBaseId);
  if (!root) throw notFound();
  return root.publicId;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeCount(value: number | string) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid graph count");
  return count;
}

function mapSearchError(error: unknown) {
  if (error instanceof StorageVnextActiveSearchInputError) {
    return validationError(
      error.code === "INVALID_SEARCH_CURSOR"
        ? "Pagination cursor is invalid."
        : "File search query is invalid.",
      { field: error.code === "INVALID_SEARCH_CURSOR" ? "cursor" : "query" }
    );
  }
  if (error instanceof SearchProviderError) {
    if (error.code === "SEARCH_ENGINE_TIMEOUT") {
      return createDeveloperOpenApiError(
        "SEARCH_TIMEOUT",
        504,
        "Search exceeded the configured response deadline."
      );
    }
    if (error.code === "SEARCH_ENGINE_OVERLOADED") {
      return createDeveloperOpenApiError(
        "SEARCH_OVERLOADED",
        503,
        "Search is temporarily overloaded. Retry after a short delay."
      );
    }
    return createDeveloperOpenApiError(
      "SEARCH_UNAVAILABLE",
      503,
      "Search is temporarily unavailable. Retry after the service recovers."
    );
  }
  return repositoryUnavailable();
}
