import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import { deriveSourceFileLifecycle } from "../../domain/source-file-lifecycle.js";
import type { StorageVnextCatalogRepository } from "../catalog/ports.js";
import type {
  StorageVnextImmutableBodyStore,
  StorageVnextImmutableBodyWriteResult
} from "../ownership/s3-immutable-body-store.js";
import type {
  StorageVnextSourceEventReadPort,
  StorageVnextSourceEventSummary
} from "../source-events/ports.js";
import { presentRelatedFiles } from
  "../../document-indexing/application/document-related-file-presentation.js";
import { StorageVnextSourceEventRepositoryError } from
  "../source-events/postgres-repository.js";
import type { StorageVnextAdminCoreApplication } from "./admin-core-application.js";
import type { StorageVnextAdminMutationApplication } from "./admin-mutation-application.js";
import type { StorageVnextAdminResourceRead } from "./postgres-admin-resources.js";
import type { StorageVnextKnowledgeBaseCreationPort } from
  "./postgres-knowledge-base-creation.js";

type GeneratedRow = {
  logical_path: string;
  entry_kind: "source" | "index" | "directory" | "log" | "graph";
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
      return success(toKnowledgeBase(record, 0));
    },

    async getKnowledgeBase(request) {
      const record = await input.catalog.getKnowledgeBase(request);
      if (!record) return notFound();
      return success(toKnowledgeBase(record, await readActivationRevision(
        input.sql,
        request.knowledgeBaseId
      )));
    },

    async deleteKnowledgeBase(request) {
      const record = await input.catalog.getKnowledgeBase(request);
      if (!record) return notFound();
      const result = await input.mutations.deleteKnowledgeBase({
        knowledgeBaseId: request.knowledgeBaseId,
        idempotencyKey: `admin-delete-${request.knowledgeBaseId}-${record.revision}`,
        expectedResourceRevision: record.revision
      });
      return success({
        accepted: true,
        operationId: result.operation.id,
        affectedDirectoryCount: result.affectedDirectoryCount,
        affectedFileCount: result.affectedFileCount
      });
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
        file: generatedFile(row, bytes),
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
        SELECT page.source_file_public_id AS public_id, source.revision
        FROM focowiki.generated_page_heads page
        LEFT JOIN focowiki.source_files source
          ON source.knowledge_base_id = page.knowledge_base_id
         AND source.public_id = page.source_file_public_id
         AND source.deleted_at IS NULL
        WHERE page.knowledge_base_id = ${request.knowledgeBaseId}
          AND page.logical_path = ${request.logicalPath}
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) return notFound();
      if (!row.public_id || row.revision === null) return notDeletable();
      const result = await input.mutations.deleteSourceFile({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFileId: row.public_id,
        idempotencyKey: `admin-delete-${row.public_id}-${row.revision}`,
        expectedResourceRevision: count(row.revision)
      });
      return success({
        accepted: true,
        operationId: result.operation.id
      });
    },

    async listFiles(request) {
      const mappedFilters = {
        pathQuery: request.filters.fileNameQuery ?? null,
        sourceFileIdPrefix: request.filters.fileIdQuery ?? null,
        state: request.filters.state ?? null,
        blockingWorkKind: null,
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
        refreshAfterMs: items.some((item) =>
          item.state === "waiting" || item.state === "processing"
          || item.state === "deleting")
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
    SELECT page.logical_path, page.entry_kind, page.source_file_public_id,
           page.checksum_sha256, page.object_id, page.byte_count,
           registration.storage_key, registration.content_type,
           registration.object_format, source.title AS source_title,
           source.metadata AS source_metadata,
           focowiki.public_generated_file_id(
             page.knowledge_base_id,
             page.logical_path
           ) AS generated_file_public_id
    FROM focowiki.generated_page_heads page
    JOIN focowiki.object_registrations registration
      ON registration.object_id = page.object_id
     AND registration.state = 'verified'
    LEFT JOIN focowiki.source_files source
      ON source.knowledge_base_id = page.knowledge_base_id
     AND source.public_id = page.source_file_public_id
     AND source.deleted_at IS NULL
    WHERE page.knowledge_base_id = ${input.knowledgeBaseId}
      AND page.logical_path = ${input.logicalPath}
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
    relation_public_id: string;
    source_file_public_id: string;
    logical_path: string;
    title: string;
    relation_kind: "references" | "related";
    evidence_public_id: string;
    evidence_source_file_public_id: string;
    evidence_kind: "markdown_link" | "okf_metadata" | "stable_alias" | "semantic";
    evidence: Record<string, unknown>;
  }>>`
    SELECT relation.public_id AS relation_public_id,
           CASE WHEN relation.first_source_file_public_id = ${input.sourceFileId}
             THEN relation.second_source_file_public_id
             ELSE relation.first_source_file_public_id END AS source_file_public_id,
           page.logical_path, presentation.title,
           relation.relation_kind, evidence.public_id AS evidence_public_id,
           evidence.source_file_public_id AS evidence_source_file_public_id,
           CASE evidence.evidence_kind
             WHEN 'explicit_reference' THEN 'markdown_link'
             WHEN 'title_alias' THEN 'stable_alias'
             ELSE 'semantic'
           END AS evidence_kind,
           evidence.evidence
    FROM focowiki.canonical_file_relations relation
    JOIN focowiki.relation_directed_evidence evidence
      ON evidence.knowledge_base_id = relation.knowledge_base_id
     AND evidence.pair_public_id = relation.pair_public_id
     AND evidence.active AND evidence.retired_at IS NULL
    JOIN focowiki.source_files source
      ON source.knowledge_base_id = relation.knowledge_base_id
     AND source.public_id = CASE
       WHEN relation.first_source_file_public_id = ${input.sourceFileId}
         THEN relation.second_source_file_public_id
       ELSE relation.first_source_file_public_id END
     AND source.deleted_at IS NULL
    JOIN focowiki.source_file_active_revisions active
      ON active.knowledge_base_id = source.knowledge_base_id
     AND active.source_file_public_id = source.public_id
     AND active.active_source_revision_public_id IS NOT NULL
    JOIN focowiki.source_revision_presentations presentation
      ON presentation.knowledge_base_id = active.knowledge_base_id
     AND presentation.source_file_public_id = active.source_file_public_id
     AND presentation.source_revision_public_id
       = active.active_source_revision_public_id
    JOIN focowiki.generated_page_heads page
      ON page.knowledge_base_id = active.knowledge_base_id
     AND page.source_file_public_id = active.source_file_public_id
     AND page.source_revision_public_id = active.active_source_revision_public_id
     AND page.entry_kind = 'source'
    WHERE relation.knowledge_base_id = ${input.knowledgeBaseId}
      AND relation.active AND relation.retired_at IS NULL
      AND EXISTS (
        SELECT 1 FROM focowiki.source_file_active_revisions endpoint
        WHERE endpoint.knowledge_base_id = relation.knowledge_base_id
          AND endpoint.source_file_public_id
            = relation.first_source_file_public_id
          AND endpoint.active_source_revision_public_id
            = relation.first_source_revision_public_id
      )
      AND EXISTS (
        SELECT 1 FROM focowiki.source_file_active_revisions endpoint
        WHERE endpoint.knowledge_base_id = relation.knowledge_base_id
          AND endpoint.source_file_public_id
            = relation.second_source_file_public_id
          AND endpoint.active_source_revision_public_id
            = relation.second_source_revision_public_id
      )
      AND (${input.sourceFileId} IN (
        relation.first_source_file_public_id,
        relation.second_source_file_public_id
      ))
    ORDER BY (CASE WHEN relation.first_source_file_public_id = ${input.sourceFileId}
      THEN relation.second_source_file_public_id
      ELSE relation.first_source_file_public_id END) COLLATE "C",
      evidence.public_id COLLATE "C"
  `;
  const related = presentRelatedFiles({
    sourceFilePublicId: input.sourceFileId,
    evidence: rows.map((row) => ({
      relationPublicId: row.relation_public_id,
      targetSourceFilePublicId: row.source_file_public_id,
      direction: row.evidence_source_file_public_id === input.sourceFileId
        ? "outgoing" as const : "incoming" as const,
      evidencePublicId: row.evidence_public_id,
      evidenceKind: row.evidence_kind,
      evidence: row.evidence
    }))
  });
  const details = new Map(rows.map((row) => [row.source_file_public_id, row]));
  return related.slice(0, input.limit).map((item) => {
    const detail = details.get(item.targetSourceFilePublicId);
    if (!detail) throw new Error("Related file presentation lost its source row");
    const reason = item.evidence.find((evidence) =>
      typeof evidence.value.reason === "string")?.value.reason;
    return {
      fileId: item.targetSourceFilePublicId,
      sourceFileId: item.targetSourceFilePublicId,
      generatedFileId: item.targetSourceFilePublicId,
      path: detail.logical_path,
      title: detail.title,
      relationType: detail.relation_kind,
      direction: item.direction,
      weight: 1,
      reason: typeof reason === "string" ? reason : "Source-backed file relation",
      source: "graph",
      contentAvailable: true
    };
  });
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
    objectFormat: row.object_format as StorageVnextImmutableBodyWriteResult["objectFormat"],
    requests: {
      put: 0,
      head: 0,
      verification: 0,
      attemptedBytes: 0,
      retries: 0,
      latencyMilliseconds: 0
    }
  };
}

function generatedFile(row: GeneratedRow, bytes: Uint8Array) {
  const metadata = row.source_metadata ?? {};
  const portable = portableJsonPresentation(row, bytes);
  return {
    id: row.source_file_public_id ?? row.generated_file_public_id,
    sourceFileId: row.source_file_public_id,
    fileKind: generatedKind(row.entry_kind, row.logical_path),
    logicalPath: row.logical_path,
    contentType: row.content_type,
    sizeBytes: count(row.byte_count),
    okfType: typeof metadata.type === "string" ? metadata.type : null,
    title: row.source_title ?? portable.title ?? nameOf(row.logical_path),
    portableScopePath: portable.scopePath,
    description: typeof metadata.description === "string" ? metadata.description : null,
    tags: [],
    frontmatter: metadata,
    deletable: row.entry_kind === "source" && Boolean(row.source_file_public_id)
  };
}

function portableJsonPresentation(
  row: Pick<GeneratedRow, "content_type" | "logical_path">,
  bytes: Uint8Array
): { title: string | null; scopePath: string | null } {
  if (!row.content_type.toLocaleLowerCase("en-US").includes("json")
    && !row.logical_path.toLocaleLowerCase("en-US").endsWith(".json")) {
    return { title: null, scopePath: null };
  }
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { title: null, scopePath: null };
    }
    const record = value as Record<string, unknown>;
    return {
      title: typeof record.title === "string" && record.title.trim()
        ? record.title : null,
      scopePath: typeof record.scopePath === "string" && record.scopePath.trim()
        ? record.scopePath
        : typeof record.prefix === "string" && record.prefix.trim()
          ? record.prefix
          : typeof record.path === "string" && record.path.trim()
            ? record.path : null
    };
  } catch {
    return { title: null, scopePath: null };
  }
}

function adminSourceFile(
  file: Awaited<ReturnType<StorageVnextAdminResourceRead["getSourceFile"]>> extends infer T
    ? Exclude<T, null> : never,
  metadata: MetadataRow["metadata"]
) {
  const lifecycle = deriveSourceFileLifecycle({
    processingStatus: file.processingStatus,
    blockingWorkKind: file.blockingWorkKind,
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
    processingStartedAt: file.processingStartedAt,
    processingEndedAt: file.processingEndedAt,
    retryCount: file.retryCount ?? 0,
    modelInvocationStatus: file.modelInvocationStatus ?? null,
    modelInvocationModelName: file.modelInvocationModelName ?? null,
    modelInvocationStartedAt: file.modelInvocationStartedAt ?? null,
    modelInvocationEndedAt: file.modelInvocationEndedAt ?? null,
    modelInvocationWarningCount: file.modelInvocationWarningCount ?? null,
    modelInvocationErrorCode: file.modelInvocationErrorCode ?? null,
    modelLayerExecutions: file.modelLayerExecutions ?? [],
    generatedOutputStatus: file.generatedOutputStatus,
    generatedFileAvailable: file.generatedOutputStatus === "current_available"
      || file.generatedOutputStatus === "previous_available",
    generatedFilePath: file.generatedPath,
    generatedFileId: file.generatedPath ? file.id : null,
    state: lifecycle.state,
    requiredWorkCount: file.requiredWorkCount,
    completedWorkCount: file.completedWorkCount,
    activeWorkKinds: file.activeWorkKinds,
    blockingWorkKind: lifecycle.blockingWorkKind,
    retryingWorkKind: file.retryingWorkKind,
    failure: lifecycle.failure,
    actions: lifecycle.actions.map((kind) => ({
      kind,
      method: kind === "view_failure_details" ? null
        : kind === "open_generated_file" ? "GET"
          : kind === "replace_source_content" ? "PUT" : "POST",
      href: kind === "view_failure_details" ? null
        : kind === "open_generated_file" && file.generatedPath
          ? `/admin/api/knowledge-bases/${encodeURIComponent(file.knowledgeBaseId)}`
            + `/files/content?path=${encodeURIComponent(file.generatedPath)}`
          : kind === "replace_source_content"
            ? `/admin/api/knowledge-bases/${encodeURIComponent(file.knowledgeBaseId)}`
              + `/source-files/${encodeURIComponent(file.id)}/content`
          : `/admin/api/knowledge-bases/${encodeURIComponent(file.knowledgeBaseId)}`
            + `/source-files/${encodeURIComponent(file.id)}/retry`,
      scope: "source_file"
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

async function readActivationRevision(sql: DatabaseClient, knowledgeBaseId: string) {
  const rows = await sql<Array<{ activation_revision: number | string }>>`
    SELECT current_sequence AS activation_revision
    FROM focowiki.knowledge_base_sequences
    WHERE knowledge_base_id = ${knowledgeBaseId}
  `;
  return rows[0] ? count(rows[0].activation_revision) : 0;
}

function toKnowledgeBase(
  record: { publicId: string; name: string; description: string | null; revision: number; createdAt: string; updatedAt: string },
  activationRevision: number
) {
  return {
    id: record.publicId,
    name: record.name,
    description: record.description,
    activeContentRevision: activationRevision,
    resourceRevision: record.revision,
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
