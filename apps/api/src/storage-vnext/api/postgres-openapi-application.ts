import { randomUUID } from "node:crypto";
import { portableByFileGraphPath } from "@focowiki/okf";
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
import type { StorageVnextSearchQueryPort } from "../search/ports.js";
import { StorageVnextActiveSearchInputError } from "../search/active-search.js";
import type { StorageVnextAdminCoreApplication } from "./admin-core-application.js";
import type { StorageVnextAdminReadApplication } from "./admin-read-application.js";
import type { StorageVnextAdminSourceApplication } from "./admin-source-application.js";
import type { StorageVnextAdminMutationApplication } from "./admin-mutation-application.js";
import type { DeveloperOpenApiApplication } from "./openapi-application.js";
import {
  assertOpenApiPublicFilePath,
  emptyOpenApiSearchResponse,
  openApiNoCandidateSearchHints,
  openApiSearchQuery,
  presentOpenApiGeneratedFile,
  presentOpenApiGraphOverview,
  presentOpenApiKnowledgeBase,
  presentOpenApiRelationship,
  presentOpenApiSearchResult,
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
import {
  readKnowledgeBaseDescription,
  readKnowledgeBaseName
} from "../../developer-openapi/knowledge-base-input.js";

export function createPostgresStorageVnextOpenApiApplication(input: {
  sql: DatabaseClient;
  catalog: StorageVnextCatalogRepository;
  adminRead: StorageVnextAdminReadApplication;
  adminCore: StorageVnextAdminCoreApplication;
  resources: StorageVnextAdminMutationApplication;
  source: StorageVnextAdminSourceApplication;
  search: StorageVnextSearchQueryPort | null;
  webhooks: ReturnType<typeof createPostgresStorageVnextOpenApiWebhooks>;
  knowledgeBaseCreation?: StorageVnextKnowledgeBaseCreationPort;
}): DeveloperOpenApiApplication {
  return {
    async createKnowledgeBase(request) {
      const name = readKnowledgeBaseName(request.name);
      const description = readKnowledgeBaseDescription(request.description);
      let record;
      try {
        record = await (input.knowledgeBaseCreation ?? {
          create: input.catalog.createKnowledgeBase.bind(input.catalog)
        }).create({
          publicId: `knowledge-base-${randomUUID()}`,
          name,
          description
        });
      } catch (error) {
        if (readErrorCode(error) === "invalid_input") {
          throw validationError("Knowledge-base fields are invalid.");
        }
        throw error;
      }
      return { knowledgeBase: presentOpenApiKnowledgeBase(record, 0) };
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
      const activationRevisions = await readActivationRevisions(
        input.sql,
        page.items.map((record) => record.publicId)
      );
      const items = page.items.map((record) => presentOpenApiKnowledgeBase(
        record,
        activationRevisions.get(record.publicId) ?? 0
      ));
      return { items, nextCursor: page.nextCursor };
    },

    async getKnowledgeBase(knowledgeBaseId) {
      const record = await input.catalog.getKnowledgeBase({ knowledgeBaseId });
      if (!record) throw notFound();
      return {
        knowledgeBase: presentOpenApiKnowledgeBase(
          record,
          await readActivationRevision(input.sql, knowledgeBaseId)
        )
      };
    },

    getSourceFile: (request) => input.resources.getSourceFile(request),

    async readSourceContent(request) {
      const result = await input.resources.readSourceContent(request);
      if (!result) throw notFound("Uploaded Markdown content was not found.");
      return result;
    },

    async retrySourceFile(request) {
      const result = await input.source.retrySourceFile(request);
      if (result.ok) return result.value.retry;
      if (result.code === "NOT_FOUND") throw notFound();
      if (result.code === "DATABASE_REPOSITORY_UNAVAILABLE") throw repositoryUnavailable();
      if (result.code === "SOURCE_FILE_RETRY_ALREADY_RUNNING") {
        throw conflict("This source file is already queued or being processed.");
      }
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
      const activationRevision = await readActivationRevision(
        input.sql,
        request.knowledgeBaseId
      );
      const activeContentRevision = activeContentRevisionFor(activationRevision);
      return {
        activeContentRevision,
        items: result.value.items.map((entry) => presentOpenApiTreeEntry(
          request.knowledgeBaseId,
          activeContentRevision,
          entry
        )),
        nextCursor: result.value.nextCursor
      };
    },

    async searchFiles(request) {
      if (!input.search) throw repositoryUnavailable();
      const normalizedQuery = request.query;
      if (!normalizedQuery) throw validationError("Search query is required.", { field: "query" });
      if (request.fileKind !== null && request.fileKind !== "page") {
        throw validationError("Search file kind is invalid.", { field: "fileKind" });
      }
      const activationRevision = await readActivationRevision(
        input.sql,
        request.knowledgeBaseId
      );
      const activeContentRevision = activeContentRevisionFor(activationRevision);
      if (!activeContentRevision) return emptyOpenApiSearchResponse(request, null);
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
          activeContentRevision,
          mode: request.mode,
          depth: request.graphDepth,
          item,
          relationships: graph?.relationships ?? []
        });
      });
      return {
        activeContentRevision,
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
            ? "Results match the current readable knowledge base."
            : "No current readable files matched the search."
        },
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
          await requireActiveContentRevision(input.sql, request.knowledgeBaseId),
          content.file,
          content.content
        )
      };
    },

    async listRelatedFiles(request) {
      const identity = await findStorageVnextGeneratedIdentity(input.sql, request);
      if (!identity) throw notFound();
      if (!identity.source_file_public_id) {
        throw conflict("Only readable files created from uploaded Markdown can return related files.");
      }
      const rootId = await requireActiveContentRevision(input.sql, request.knowledgeBaseId);
      const page = await listStorageVnextRelationships(input.sql, {
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFileId: identity.source_file_public_id,
        limit: request.limit,
        cursor: request.cursor
      });
      return {
        activeContentRevision: rootId,
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
      const rootId = await requireActiveContentRevision(input.sql, request.knowledgeBaseId);
      const seed = await resolveStorageVnextGraphSeed(input.sql, request);
      if (!seed) throw notFound();
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
        activeContentRevision: rootId,
        seedFile: seedContent
          ? presentOpenApiGeneratedFile(
              request.knowledgeBaseId,
              rootId,
              seedContent.file,
              seedContent.content
            )
          : null,
        relationships: page.items.map((item) => presentOpenApiRelationship(
          request.knowledgeBaseId,
          rootId,
          item
        )),
        graphPaths: [...new Set([
          ...(seedIdentity ? [seedIdentity.logical_path] : []),
          ...page.items.map((item) => item.logical_path)
        ])]
          .map(portableByFileGraphPath),
        nextCursor: page.nextCursor,
        resultSummary: {
          relationshipCount: page.items.length,
          hasMore: Boolean(page.nextCursor),
          depth: request.depth,
          fanout: request.fanout,
          meaning: "Relationships connect readable source-backed files in the current knowledge-base version."
        }
      };
    },

    async getGraphOverview(request) {
      const rootId = await requireActiveContentRevision(input.sql, request.knowledgeBaseId);
      const [graphSummary, rows] = await Promise.all([
        readStorageVnextGraphSearchSummary(input.sql, request.knowledgeBaseId),
        input.sql<Array<{
        graph_index_available: boolean;
        }>>`
        SELECT
          EXISTS (
            SELECT 1 FROM focowiki.generated_page_heads page
            WHERE page.knowledge_base_id = ${request.knowledgeBaseId}
              AND page.logical_path = ${GENERATED_GRAPH_RESOURCES.index.path}
          ) AS graph_index_available
        `
      ]);
      const summary = rows[0];
      const available = Boolean(summary?.graph_index_available);
      return presentOpenApiGraphOverview({
        knowledgeBaseId: request.knowledgeBaseId,
        activeContentRevision: rootId,
        nodeCount: graphSummary.indexedDocumentCount,
        edgeCount: graphSummary.indexedRelationshipCount,
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
  const generated = await readGenerated(input.adminCore, {
    knowledgeBaseId,
    logicalPath,
    includeRelationships: false
  });
  const sourceFileId = typeof generated.file.sourceFileId === "string"
    ? generated.file.sourceFileId
    : null;
  const content = sourceFileId
    ? await readSourceMarkdown(input, { knowledgeBaseId, sourceFileId })
    : generated.content;
  return {
    file: presentOpenApiGeneratedFile(
      knowledgeBaseId,
      await requireActiveContentRevision(input.sql, knowledgeBaseId),
      generated.file,
      content
    ),
    content
  };
}

async function readSourceMarkdown(
  input: Parameters<typeof createPostgresStorageVnextOpenApiApplication>[0],
  request: { knowledgeBaseId: string; sourceFileId: string }
): Promise<string> {
  const source = await input.resources.readSourceContent(request);
  if (!source) throw notFound("Uploaded Markdown content was not found.");
  try {
    const bytes = await new Response(source.content).arrayBuffer();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw repositoryUnavailable();
  }
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

async function readActivationRevision(
  sql: DatabaseClient,
  knowledgeBaseId: string
): Promise<number> {
  return (await readActivationRevisions(sql, [knowledgeBaseId]))
    .get(knowledgeBaseId) ?? 0;
}

async function readActivationRevisions(
  sql: DatabaseClient,
  knowledgeBaseIds: readonly string[]
): Promise<Map<string, number>> {
  if (knowledgeBaseIds.length === 0) return new Map();
  const rows = await sql<Array<{
    knowledge_base_id: string;
    activation_revision: number | string;
  }>>`
    SELECT knowledge_base_id, current_sequence AS activation_revision
    FROM focowiki.knowledge_base_sequences
    WHERE knowledge_base_id = ANY(${knowledgeBaseIds}::text[])
  `;
  const values = new Map<string, number>();
  for (const row of rows) {
    const revision = Number(row.activation_revision);
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw repositoryUnavailable();
    }
    values.set(row.knowledge_base_id, revision);
  }
  return values;
}

function activeContentRevisionFor(activationRevision: number): number | null {
  return activationRevision > 0 ? activationRevision : null;
}

async function requireActiveContentRevision(
  sql: DatabaseClient,
  knowledgeBaseId: string
): Promise<number> {
  const activeContentRevision = activeContentRevisionFor(
    await readActivationRevision(sql, knowledgeBaseId)
  );
  if (!activeContentRevision) throw notFound();
  return activeContentRevision;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readErrorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error
    && typeof error.code === "string"
    ? error.code
    : null;
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
