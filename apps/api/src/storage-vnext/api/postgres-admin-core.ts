import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import { deriveSourceFileLifecycle } from "../../domain/source-file-lifecycle.js";
import type { StorageVnextCatalogRepository } from "../catalog/ports.js";
import type {
  StorageVnextImmutableBodyStore,
  StorageVnextImmutableBodyWriteResult
} from "../ownership/s3-immutable-body-store.js";
import type { StorageVnextReleaseReadPort } from "../release/ports.js";
import type {
  StorageVnextSourceEventReadPort,
  StorageVnextSourceEventSummary
} from "../source-events/ports.js";
import { StorageVnextSourceEventRepositoryError } from
  "../source-events/postgres-repository.js";
import type { StorageVnextAdminCoreApplication } from "./admin-core-application.js";
import type { StorageVnextAdminMutationApplication } from "./admin-mutation-application.js";
import type { StorageVnextAdminResourceRead } from "./postgres-admin-resources.js";
import type { StorageVnextKnowledgeBaseCreationPort } from
  "./postgres-knowledge-base-creation.js";

type GeneratedRow = {
  logical_path: string;
  entry_kind: "source" | "index" | "directory" | "schema" | "log" | "graph";
  source_file_public_id: string | null;
  checksum_sha256: string;
  object_id: string;
  byte_count: number | string;
  storage_key: string;
  content_type: string;
  object_format: string;
  source_title: string | null;
  source_metadata: Record<string, boolean | number | string | null> | null;
  generated_file_public_id: string;
};

type MetadataRow = {
  public_id: string;
  metadata: Record<string, boolean | number | string | null>;
};

export function createPostgresStorageVnextAdminCore(input: {
  sql: DatabaseClient;
  catalog: StorageVnextCatalogRepository;
  releases: StorageVnextReleaseReadPort;
  resources: StorageVnextAdminResourceRead;
  sourceEvents: StorageVnextSourceEventReadPort;
  mutations: StorageVnextAdminMutationApplication;
  bodies: StorageVnextImmutableBodyStore;
  maximumGeneratedBytes: number;
  knowledgeBaseCreation?: StorageVnextKnowledgeBaseCreationPort;
}): StorageVnextAdminCoreApplication {
  return {
    async createKnowledgeBase(request) {
      const record = await (input.knowledgeBaseCreation ?? {
        create: input.catalog.createKnowledgeBase.bind(input.catalog)
      }).create({
        publicId: `knowledge-base-${randomUUID()}`,
        name: request.name,
        description: request.description
      });
      return success(toKnowledgeBase(record, null));
    },

    async getKnowledgeBase(request) {
      const record = await input.catalog.getKnowledgeBase(request);
      if (!record) return notFound();
      return success(toKnowledgeBase(
        record,
        await input.releases.getActiveRoot(request.knowledgeBaseId)
      ));
    },

    async deleteKnowledgeBase(request) {
      const record = await input.catalog.getKnowledgeBase(request);
      if (!record) return notFound();
      await input.mutations.deleteKnowledgeBase({
        knowledgeBaseId: request.knowledgeBaseId,
        idempotencyKey: `admin-delete-${request.knowledgeBaseId}-${record.revision}`,
        expectedResourceRevision: record.revision
      });
      return success({ deleted: true });
    },

    async readGeneratedContent(request) {
      const row = await readGeneratedRow(input.sql, request);
      if (!row) return notFound();
      if (count(row.byte_count) > input.maximumGeneratedBytes) {
        return success(contentTooLarge());
      }
      const bytes = await input.bodies.readVerified({
        descriptor: generatedDescriptor(row),
        maximumBytes: input.maximumGeneratedBytes
      });
      return success({
        file: generatedFile(row),
        relationships: request.includeRelationships && row.source_file_public_id
          ? await readRelationships(input.sql, {
              knowledgeBaseId: request.knowledgeBaseId,
              sourceFileId: row.source_file_public_id,
              limit: 8
            })
          : [],
        content: new TextDecoder().decode(bytes),
        readOnly: true
      });
    },

    async deleteSourceFile(request) {
      const rows = await input.sql<Array<{
        public_id: string | null;
        revision: number | string | null;
      }>>`
        SELECT entry.source_file_public_id AS public_id, source.revision
        FROM focowiki.release_roots root
        CROSS JOIN LATERAL focowiki.resolve_release_catalog(root.public_id) entry
        LEFT JOIN focowiki.source_files source
          ON source.knowledge_base_id = root.knowledge_base_id
         AND source.public_id = entry.source_file_public_id
         AND source.deleted_at IS NULL
        WHERE root.knowledge_base_id = ${request.knowledgeBaseId}
          AND root.root_role = 'active'
          AND entry.logical_path = ${request.logicalPath}
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) return notFound();
      if (!row.public_id || row.revision === null) return notDeletable();
      await input.mutations.deleteSourceFile({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFileId: row.public_id,
        idempotencyKey: `admin-delete-${row.public_id}-${row.revision}`,
        expectedResourceRevision: count(row.revision)
      });
      return success({ deleted: true, publicationQueued: true });
    },

    async listFiles(request) {
      const mappedFilters = {
        pathQuery: request.filters.fileNameQuery ?? null,
        sourceFileIdPrefix: request.filters.fileIdQuery ?? null,
        state: request.filters.state ?? null,
        currentStage: request.filters.currentStage ?? null,
        generatedOutputStatus: request.filters.generatedOutputStatus ?? null,
        modelInvocationStatus: request.filters.modelInvocationStatus ?? null,
        startedFrom: request.filters.startedFrom ?? null,
        startedTo: request.filters.startedTo ?? null,
        endedFrom: request.filters.endedFrom ?? null,
        endedTo: request.filters.endedTo ?? null,
        errorState: request.filters.errorState ?? null,
        errorCodeQuery: request.filters.errorCodeQuery ?? null,
        actionState: request.filters.actionState ?? null
      };
      let page;
      try {
        page = await input.resources.listSourceFiles({
          knowledgeBaseId: request.knowledgeBaseId,
          directoryId: undefined,
          filters: mappedFilters,
          limit: request.limit,
          cursor: request.cursor
        });
      } catch {
        return request.cursor ? invalidPagination() : unavailable();
      }
      const metadata = await readMetadata(
        input.sql,
        request.knowledgeBaseId,
        page.items.map((item) => item.id)
      );
      const items = page.items.map((item) => adminSourceFile(item, metadata.get(item.id) ?? {}));
      return success({
        items,
        nextCursor: page.nextCursor,
        refreshAfterMs: items.some((item) => item.state === "queued" || item.state === "running")
          ? 2_000
          : 30_000
      });
    },

    async getFile(request) {
      const file = await input.resources.getSourceFile({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFileId: request.sourceFileId
      });
      if (!file) return notFound();
      const metadata = await readMetadata(input.sql, request.knowledgeBaseId, [file.id]);
      let events;
      try {
        events = await input.sourceEvents.list(request);
      } catch (error) {
        if (
          error instanceof StorageVnextSourceEventRepositoryError
          && error.code === "invalid_cursor"
        ) {
          return invalidPagination();
        }
        return unavailable();
      }
      return success({
        file: adminSourceFile(file, metadata.get(file.id) ?? {}),
        events: {
          items: events.items.map(adminSourceEvent),
          nextCursor: events.nextCursor
        }
      });
    }
  };
}

async function readGeneratedRow(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; logicalPath: string }
) {
  const rows = await sql<GeneratedRow[]>`
    SELECT entry.logical_path, entry.entry_kind, entry.source_file_public_id,
           entry.checksum_sha256, entry.object_id, entry.byte_count,
           registration.storage_key, registration.content_type,
           registration.object_format, source.title AS source_title,
           source.metadata AS source_metadata,
           focowiki.public_generated_file_id(
             root.knowledge_base_id,
             entry.logical_path
           ) AS generated_file_public_id
    FROM focowiki.release_roots root
    CROSS JOIN LATERAL focowiki.resolve_release_catalog(root.public_id) entry
    JOIN focowiki.object_registrations registration
      ON registration.object_id = entry.object_id
     AND registration.state = 'verified'
    LEFT JOIN focowiki.source_files source
      ON source.knowledge_base_id = root.knowledge_base_id
     AND source.public_id = entry.source_file_public_id
     AND source.deleted_at IS NULL
    WHERE root.knowledge_base_id = ${input.knowledgeBaseId}
      AND root.root_role = 'active'
      AND entry.logical_path = ${input.logicalPath}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function readMetadata(
  sql: DatabaseClient,
  knowledgeBaseId: string,
  publicIds: string[]
) {
  if (publicIds.length === 0) return new Map<string, MetadataRow["metadata"]>();
  const rows = await sql<MetadataRow[]>`
    SELECT public_id, metadata FROM focowiki.source_files
    WHERE knowledge_base_id = ${knowledgeBaseId}
      AND public_id = ANY(${publicIds}) AND deleted_at IS NULL
  `;
  return new Map(rows.map((row) => [row.public_id, row.metadata]));
}

async function readRelationships(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; sourceFileId: string; limit: number }
) {
  const rows = await sql<Array<{
    source_file_public_id: string;
    logical_path: string;
    title: string;
    relation: string;
    weight: number | string;
    reason: string | null;
    direction: "incoming" | "outgoing";
  }>>`
    WITH seeds AS (
      SELECT public_id FROM focowiki.graph_nodes
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND source_file_public_id = ${input.sourceFileId}
    )
    SELECT related.source_file_public_id, generated.logical_path,
           related.label AS title, edge.relation, edge.weight, edge.reason,
           CASE WHEN edge.from_node_public_id IN (SELECT public_id FROM seeds)
             THEN 'outgoing' ELSE 'incoming' END AS direction
    FROM focowiki.graph_edges edge
    JOIN focowiki.graph_nodes related
      ON related.knowledge_base_id = edge.knowledge_base_id
     AND related.public_id = CASE
       WHEN edge.from_node_public_id IN (SELECT public_id FROM seeds)
         THEN edge.to_node_public_id ELSE edge.from_node_public_id END
    JOIN focowiki.release_roots root
      ON root.knowledge_base_id = related.knowledge_base_id
     AND root.root_role = 'active'
    JOIN LATERAL focowiki.resolve_release_catalog(root.public_id) generated
      ON generated.source_file_public_id = related.source_file_public_id
    WHERE edge.knowledge_base_id = ${input.knowledgeBaseId}
      AND (edge.from_node_public_id IN (SELECT public_id FROM seeds)
        OR edge.to_node_public_id IN (SELECT public_id FROM seeds))
    ORDER BY edge.weight DESC, related.source_file_public_id
    LIMIT ${input.limit}
  `;
  return rows.map((row) => ({
    fileId: row.source_file_public_id,
    sourceFileId: row.source_file_public_id,
    generatedFileId: row.source_file_public_id,
    path: row.logical_path,
    title: row.title,
    relationType: row.relation,
    direction: row.direction,
    weight: Number(row.weight),
    reason: row.reason ?? "Related source-backed file",
    source: "graph",
    contentAvailable: true
  }));
}

function generatedDescriptor(row: GeneratedRow): StorageVnextImmutableBodyWriteResult {
  if (![
    "source-markdown-v1", "okf-generated-markdown-v1", "okf-generated-json-v1"
  ].includes(row.object_format)) throw new Error("Invalid generated object format");
  return {
    outcome: "reused",
    objectId: row.object_id,
    storageKey: row.storage_key,
    checksum: row.checksum_sha256,
    byteCount: count(row.byte_count),
    contentType: row.content_type,
    objectFormat: row.object_format as StorageVnextImmutableBodyWriteResult["objectFormat"]
  };
}

function generatedFile(row: GeneratedRow) {
  const metadata = row.source_metadata ?? {};
  return {
    id: row.source_file_public_id ?? row.generated_file_public_id,
    sourceFileId: row.source_file_public_id,
    fileKind: generatedKind(row.entry_kind, row.logical_path),
    logicalPath: row.logical_path,
    contentType: row.content_type,
    sizeBytes: count(row.byte_count),
    okfType: typeof metadata.type === "string" ? metadata.type : null,
    title: row.source_title ?? nameOf(row.logical_path),
    description: typeof metadata.description === "string" ? metadata.description : null,
    tags: [],
    frontmatter: metadata,
    deletable: row.entry_kind === "source" && Boolean(row.source_file_public_id)
  };
}

function adminSourceFile(
  file: Awaited<ReturnType<StorageVnextAdminResourceRead["getSourceFile"]>> extends infer T
    ? Exclude<T, null> : never,
  metadata: MetadataRow["metadata"]
) {
  const lifecycle = deriveSourceFileLifecycle({
    processingStatus: file.processingStatus,
    processingStage: file.currentStage,
    generatedOutputStatus: file.generatedOutputStatus,
    generatedPath: file.generatedPath,
    failure: file.terminalFailure
  });
  return {
    id: file.id,
    name: file.name,
    relativePath: file.relativePath,
    resourceRevision: file.resourceRevision,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    metadata,
    modelSuggestions: null,
    processingStartedAt: file.createdAt,
    processingEndedAt: file.processingStatus === "completed" || file.processingStatus === "failed"
      ? file.updatedAt ?? file.createdAt
      : null,
    retryCount: 0,
    modelInvocationStatus: file.modelInvocationStatus ?? null,
    modelInvocationModelName: file.modelInvocationModelName ?? null,
    modelInvocationStartedAt: file.modelInvocationStartedAt ?? null,
    modelInvocationEndedAt: file.modelInvocationEndedAt ?? null,
    modelInvocationWarningCount: file.modelInvocationWarningCount ?? null,
    modelInvocationErrorCode: file.modelInvocationErrorCode ?? null,
    generatedOutputStatus: file.generatedOutputStatus,
    generatedFileAvailable: file.generatedOutputStatus === "visible",
    generatedFilePath: file.generatedPath,
    generatedFileId: file.generatedPath ? file.id : null,
    graphSummary: null,
    state: lifecycle.state,
    currentStage: lifecycle.currentStage,
    failure: lifecycle.failure,
    actions: lifecycle.actions.map((kind) => ({
      kind,
      method: kind === "view_failure_details" ? null : kind === "open_generated_file" ? "GET" : "POST",
      href: kind === "view_failure_details" ? null
        : kind === "open_generated_file" && file.generatedPath
          ? `/admin/api/knowledge-bases/${encodeURIComponent(file.knowledgeBaseId)}`
            + `/files/content?path=${encodeURIComponent(file.generatedPath)}`
          : `/admin/api/knowledge-bases/${encodeURIComponent(file.knowledgeBaseId)}`
            + `/source-files/${encodeURIComponent(file.id)}/retry`,
      scope: kind === "retry_publication" ? "knowledge_base_publication" : "source_file"
    })),
    createdAt: file.createdAt
  };
}

function adminSourceEvent(event: StorageVnextSourceEventSummary) {
  return {
    id: event.publicId,
    sourceFileId: event.sourceFilePublicId,
    stageKey: event.stageKey,
    messageKey: event.messageKey,
    startedAt: event.startedAt,
    endedAt: event.endedAt,
    severity: event.severity,
    createdAt: event.createdAt
  };
}

function toKnowledgeBase(
  record: { publicId: string; name: string; description: string | null; revision: number; createdAt: string; updatedAt: string },
  root: Awaited<ReturnType<StorageVnextReleaseReadPort["getActiveRoot"]>>
) {
  return {
    id: record.publicId,
    name: record.name,
    description: record.description,
    activeGenerationId: root?.publicId ?? null,
    resourceRevision: record.revision,
    catalogGeneration: root?.revision ?? 0,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function generatedKind(kind: GeneratedRow["entry_kind"], path: string) {
  if (kind === "source") return "page";
  if (path.startsWith("_graph/")) return "graph_index";
  if (path.startsWith("_index/")) return "search_index";
  return "index";
}

function contentTooLarge() {
  return new Response(
    JSON.stringify({ error: { code: "GENERATED_CONTENT_TOO_LARGE" } }),
    { status: 413, headers: { "content-type": "application/json" } }
  );
}

function nameOf(path: string) {
  return path.split("/").at(-1) ?? path;
}

function count(value: number | string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("Invalid storage vNext count");
  return result;
}

function success<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

function unavailable() {
  return { ok: false as const, code: "DATABASE_REPOSITORY_UNAVAILABLE" as const };
}

function invalidPagination() {
  return { ok: false as const, code: "INVALID_PAGINATION" as const };
}

function notFound() {
  return { ok: false as const, code: "NOT_FOUND" as const };
}

function notDeletable() {
  return { ok: false as const, code: "FILE_NOT_DELETABLE" as const };
}
