import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseClient } from "../../db/client.js";
import { normalizeSourceRelativePath } from "../../domain/source-path.js";
import { SourceResourceError } from "../../domain/source-resource.js";
import type { RuntimeSettingsService } from "../../runtime-settings/service.js";
import type { StorageVnextCatalogRepository } from "../catalog/ports.js";
import type { StorageVnextSourceBodyReadPort } from "../catalog/s3-source-body-store.js";
import type { StorageVnextImmutableObjectWriter } from "../ownership/immutable-object-writer.js";
import type { StorageVnextAdminMutationApplication } from "./admin-mutation-application.js";
import type { StorageVnextAdminResourceRead } from "./postgres-admin-resources.js";
import type { StorageVnextOperationRead } from "./postgres-operation-read.js";
import { analyzeDocumentSourceMarkdown } from
  "../../document-indexing/domain/document-source-metadata.js";
import {
  createPostgresDocumentMove,
  createPostgresDocumentReplacement
} from
  "../../document-indexing/infrastructure/postgres-document-replacement.js";
import { createPostgresDocumentDeletionAcceptance } from
  "../../document-indexing/infrastructure/postgres-document-deletion-acceptance.js";
import { createPostgresDocumentDirectoryMove } from
  "../../document-indexing/infrastructure/postgres-document-directory-move.js";

const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";
const DAY_MILLISECONDS = 86_400_000;

export function createPostgresStorageVnextAdminMutation(input: {
  sql: DatabaseClient;
  catalog: StorageVnextCatalogRepository;
  resources: StorageVnextAdminResourceRead;
  operations: StorageVnextOperationRead;
  sourceBodies: StorageVnextSourceBodyReadPort;
  objectWriter: StorageVnextImmutableObjectWriter;
  runtimeSettings: RuntimeSettingsService;
  maximumSourceBytes: number;
}): StorageVnextAdminMutationApplication {
  const acceptDocumentReplacement = createPostgresDocumentReplacement(input.sql);
  const acceptDocumentMove = createPostgresDocumentMove(input.sql);
  const acceptDocumentDeletion = createPostgresDocumentDeletionAcceptance(input.sql);
  const directoryMove = createPostgresDocumentDirectoryMove(input.sql);
  return {
    available: () => true,

    async updateKnowledgeBase(request) {
      let knowledgeBase;
      try {
        knowledgeBase = await input.catalog.updateKnowledgeBase({
          knowledgeBaseId: request.knowledgeBaseId,
          revisionCheck: { expectedRevision: request.expectedResourceRevision },
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.description === undefined ? {} : { description: request.description })
        });
      } catch (error) {
        throw mapStorageVnextMutationError(error);
      }
      const activationRevision = await readActivationRevision(
        input.sql,
        request.knowledgeBaseId
      );
      return {
        knowledgeBase: {
          id: knowledgeBase.publicId,
          name: knowledgeBase.name,
          description: knowledgeBase.description,
          activeContentRevision: activationRevision,
          resourceRevision: knowledgeBase.revision,
          createdAt: knowledgeBase.createdAt,
          updatedAt: knowledgeBase.updatedAt
        }
      };
    },

    async deleteKnowledgeBase(request) {
      const counts = await deletionCounts(input.sql, request.knowledgeBaseId, "knowledge_base", null);
      const operation = await acceptDeletion(input, acceptDocumentDeletion, {
        kind: "knowledge_base",
        knowledgeBaseId: request.knowledgeBaseId,
        targetPublicId: request.knowledgeBaseId,
        expectedResourceRevision: request.expectedResourceRevision,
        idempotencyKey: request.idempotencyKey
      });
      return { operation, ...counts };
    },

    async getKnowledgeBase(request) {
      const knowledgeBase = await input.catalog.getKnowledgeBase(request);
      if (!knowledgeBase) return null;
      const activationRevision = await readActivationRevision(
        input.sql,
        request.knowledgeBaseId
      );
      return {
        id: knowledgeBase.publicId,
        name: knowledgeBase.name,
        description: knowledgeBase.description,
        activeContentRevision: activationRevision,
        resourceRevision: knowledgeBase.revision,
        createdAt: knowledgeBase.createdAt,
        updatedAt: knowledgeBase.updatedAt
      };
    },

    listDirectories: (request) => input.resources.listDirectories(request),
    getDirectory: (request) => input.resources.getDirectory(request),
    listSourceFiles: (request) => input.resources.listSourceFiles(request),
    getSourceFile: (request) => input.resources.getSourceFile(request),

    async moveSourceDirectory(request) {
      const destinationParentPublicId = await resolveParentDirectory(input.sql, {
        knowledgeBaseId: request.knowledgeBaseId,
        logicalPath: request.relativePath
      });
      const context = await workflowContext(input.runtimeSettings);
      const snapshot = await input.runtimeSettings.getSnapshot();
      try {
        const accepted = await directoryMove.accept({
          knowledgeBaseId: request.knowledgeBaseId,
          sourceDirectoryPublicId: request.targetId,
          destinationParentPublicId,
          destinationLogicalPath: request.relativePath,
          expectedResourceRevision: request.expectedResourceRevision,
          operationPublicId: operationIdentity("directory-move"),
          idempotencyKey: request.idempotencyKey,
          settingsRevisionPublicId: context.settingsRevisionPublicId,
          maximumAttempts: snapshot.worker.jobMaxAttempts,
          acceptedAt: context.createdAt,
          expiresAt: context.expiresAt
        });
        const operation = await input.operations.get({
          knowledgeBaseId: request.knowledgeBaseId,
          operationId: accepted.operationPublicId
        });
        if (!operation) throw new Error("Accepted directory move is missing");
        return { operation };
      } catch (error) {
        throw mapStorageVnextMutationError(error);
      }
    },

    async deleteSourceDirectory(request) {
      const counts = await deletionCounts(
        input.sql,
        request.knowledgeBaseId,
        "source_directory",
        request.directoryId
      );
      const operation = await acceptDeletion(input, acceptDocumentDeletion, {
        kind: "source_directory",
        knowledgeBaseId: request.knowledgeBaseId,
        targetPublicId: request.directoryId,
        expectedResourceRevision: request.expectedResourceRevision,
        idempotencyKey: request.idempotencyKey ?? operationIdentity("delete-directory")
      });
      return {
        operation,
        effectiveDirectoryId: request.directoryId,
        ...counts
      };
    },

    async readSourceContent(request) {
      const source = await readEditableReplacementSource(input.sql, {
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFileId: request.sourceFileId
      });
      if (!source) return null;
      const content = await readAll(input.sourceBodies, {
        objectId: source.objectId,
        checksum: source.checksumSha256,
        byteCount: source.byteCount,
        contentType: source.contentType,
        maxBytes: input.maximumSourceBytes
      });
      return {
        content: copyArrayBuffer(content),
        contentType: source.contentType,
        resourceRevision: source.resourceRevision,
        contentRevision: source.contentRevision
      };
    },

    async moveSourceFile(request) {
      const destinationDirectoryPublicId = await resolveParentDirectory(input.sql, {
        knowledgeBaseId: request.knowledgeBaseId,
        logicalPath: request.relativePath
      });
      const current = await readActiveReplacementSource(input.sql, {
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFileId: request.targetId
      });
      if (!current) throw new SourceResourceError("RESOURCE_NOT_FOUND");
      if (current.relativePath === request.relativePath) {
        throw new SourceResourceError("INVALID_RESOURCE_MUTATION");
      }
      const context = await workflowContext(input.runtimeSettings);
      const snapshot = await input.runtimeSettings.getSnapshot();
      let acceptance;
      try {
        acceptance = await acceptDocumentMove({
          knowledgeBaseId: request.knowledgeBaseId,
          sourceFilePublicId: request.targetId,
          operationPublicId: operationIdentity("source-move"),
          idempotencyKey: request.idempotencyKey,
          expectedResourceRevision: request.expectedResourceRevision,
          runtimeSettingsRevisionPublicId: context.settingsRevisionPublicId,
          maximumAttempts: snapshot.worker.jobMaxAttempts,
          objectId: current.objectId,
          checksumSha256: current.checksumSha256,
          byteCount: current.byteCount,
          contentType: current.contentType,
          logicalPath: request.relativePath,
          directoryPublicId: destinationDirectoryPublicId,
          title: movedSourceTitle(
            current.title,
            current.relativePath,
            request.relativePath
          ),
          metadata: current.metadata,
          activeSourceRevisionPublicId: current.activeSourceRevisionPublicId,
          acceptedAt: context.createdAt,
          expiresAt: context.expiresAt
        });
      } catch (error) {
        throw mapStorageVnextMutationError(error);
      }
      return {
        operation: {
          id: acceptance.operationPublicId,
          knowledgeBaseId: request.knowledgeBaseId,
          kind: "source_file_move",
          state: "processing",
          expectedResourceRevision: request.expectedResourceRevision,
          result: {
            documentJobId: acceptance.documentJobPublicId,
            sourceRevisionId: acceptance.sourceRevisionPublicId,
            reusedSourceRevisionId: current.activeSourceRevisionPublicId
          },
          errorCode: null,
          createdAt: context.createdAt,
          updatedAt: context.createdAt,
          completedAt: null,
          targetKind: "source_file",
          targetId: request.targetId,
          candidateRelativePath: request.relativePath
        }
      };
    },

    async replaceSourceFileContent(request) {
      if (request.bytes.byteLength > input.maximumSourceBytes) {
        throw new SourceResourceError("RESOURCE_CONTENT_TOO_LARGE");
      }
      const checksum = createHash("sha256").update(request.bytes).digest("hex");
      const replay = await readReplacementReplay(input.sql, {
        knowledgeBaseId: request.knowledgeBaseId,
        idempotencyKey: request.idempotencyKey
      });
      if (replay) {
        const relativePath = request.relativePath ?? replay.logicalPath;
        const analyzed = analyzeReplacementSource(relativePath, request.bytes);
        if (
          replay.operationKind !== "source_replace"
          || replay.expectedResourceRevision !== request.expectedResourceRevision
          || replay.targetPublicId !== request.sourceFileId
          || replay.checksumSha256 !== checksum
          || replay.normalizedPath !== normalizeSourceRelativePath(relativePath).pathKey
          || replay.title !== analyzed.resolvedMetadata.title
          || !isDeepStrictEqual(replay.metadata, analyzed.metadata)
        ) {
          throw new SourceResourceError("IDEMPOTENCY_CONFLICT");
        }
        const operation = await input.operations.get({
          knowledgeBaseId: request.knowledgeBaseId,
          operationId: replay.operationPublicId
        });
        if (!operation) throw new Error("Replacement operation is unavailable");
        return { operation };
      }
      const current = await readEditableReplacementSource(input.sql, {
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFileId: request.sourceFileId
      });
      if (!current) {
        const existing = await readReplacementSourceState(input.sql, {
          knowledgeBaseId: request.knowledgeBaseId,
          sourceFileId: request.sourceFileId
        });
        throw new SourceResourceError(existing ? "RESOURCE_BUSY" : "RESOURCE_NOT_FOUND");
      }
      if (checksum === current.checksumSha256) {
        throw new SourceResourceError("RESOURCE_CONTENT_UNCHANGED");
      }
      const relativePath = request.relativePath ?? current.relativePath;
      const analyzed = analyzeReplacementSource(relativePath, request.bytes);
      const createdAt = new Date().toISOString();
      const stored = await input.objectWriter.putVerified({
        bytes: request.bytes,
        objectFormat: "source-markdown-v1",
        writeAttemptPublicId: operationIdentity("write"),
        createdAt
      });
      const destinationDirectoryPublicId = request.relativePath
        ? await resolveParentDirectory(input.sql, {
            knowledgeBaseId: request.knowledgeBaseId,
            logicalPath: request.relativePath
          })
        : current.directoryId;
      const context = await workflowContext(input.runtimeSettings);
      const snapshot = await input.runtimeSettings.getSnapshot();
      const operationPublicId = operationIdentity("source-replace");
      let acceptance;
      try {
        acceptance = await acceptDocumentReplacement({
          knowledgeBaseId: request.knowledgeBaseId,
          sourceFilePublicId: request.sourceFileId,
          operationPublicId,
          expectedResourceRevision: request.expectedResourceRevision,
          idempotencyKey: request.idempotencyKey,
          runtimeSettingsRevisionPublicId: context.settingsRevisionPublicId,
          maximumAttempts: snapshot.worker.jobMaxAttempts,
          objectId: stored.objectId,
          checksumSha256: stored.checksum,
          byteCount: stored.byteCount,
          contentType: MARKDOWN_CONTENT_TYPE,
          logicalPath: relativePath,
          directoryPublicId: destinationDirectoryPublicId,
          title: analyzed.resolvedMetadata.title,
          metadata: analyzed.metadata,
          acceptedAt: context.createdAt,
          expiresAt: context.expiresAt
        });
      } catch (error) {
        throw mapStorageVnextMutationError(error);
      }
      return {
        operation: {
          id: acceptance.operationPublicId,
          knowledgeBaseId: request.knowledgeBaseId,
          kind: "source_file_replace",
          state: "processing",
          expectedResourceRevision: request.expectedResourceRevision,
          result: {
            documentJobId: acceptance.documentJobPublicId,
            sourceRevisionId: acceptance.sourceRevisionPublicId
          },
          errorCode: null,
          createdAt: context.createdAt,
          updatedAt: context.createdAt,
          completedAt: null,
          targetKind: "source_file",
          targetId: request.sourceFileId,
          candidateRelativePath: relativePath
        }
      };
    },

    async deleteSourceFile(request) {
      return {
        operation: await acceptDeletion(input, acceptDocumentDeletion, {
          kind: "source_file",
          knowledgeBaseId: request.knowledgeBaseId,
          targetPublicId: request.sourceFileId,
          expectedResourceRevision: request.expectedResourceRevision,
          idempotencyKey: request.idempotencyKey
        })
      };
    },

    listOperations: (request) => input.operations.list(request),
    getOperation: (request) => input.operations.get(request)
  };
}

type ReplacementReplay = {
  operationPublicId: string;
  operationKind: string;
  expectedResourceRevision: number | null;
  targetPublicId: string | null;
  checksumSha256: string | null;
  logicalPath: string;
  normalizedPath: string | null;
  title: string | null;
  metadata: Readonly<Record<string, unknown>> | null;
};

async function readReplacementReplay(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; idempotencyKey: string }
): Promise<ReplacementReplay | null> {
  const rows = await sql<Array<{
    operation_public_id: string;
    operation_kind: string;
    expected_resource_revision: number | string | null;
    target_public_id: string | null;
    checksum_sha256: string | null;
    logical_path: string | null;
    normalized_path: string | null;
    title: string | null;
    metadata: Record<string, unknown> | null;
  }>>`
    SELECT idempotency.operation_public_id, operation.operation_kind,
           operation.expected_resource_revision, operation.target_public_id,
           revision.checksum_sha256, presentation.logical_path,
           presentation.normalized_path, presentation.title,
           presentation.metadata
    FROM focowiki.operation_idempotency idempotency
    JOIN focowiki.operations operation
      ON operation.knowledge_base_id = idempotency.knowledge_base_id
     AND operation.public_id = idempotency.operation_public_id
    LEFT JOIN focowiki.document_processing_jobs job
      ON job.knowledge_base_id = operation.knowledge_base_id
     AND job.operation_public_id = operation.public_id
    LEFT JOIN focowiki.source_revisions revision
      ON revision.knowledge_base_id = job.knowledge_base_id
     AND revision.source_file_public_id = job.source_file_public_id
     AND revision.public_id = job.source_revision_public_id
    LEFT JOIN focowiki.source_revision_presentations presentation
      ON presentation.knowledge_base_id = revision.knowledge_base_id
     AND presentation.source_file_public_id = revision.source_file_public_id
     AND presentation.source_revision_public_id = revision.public_id
    WHERE idempotency.knowledge_base_id = ${input.knowledgeBaseId}
      AND idempotency.idempotency_key = ${input.idempotencyKey}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    operationPublicId: row.operation_public_id,
    operationKind: row.operation_kind,
    expectedResourceRevision: row.expected_resource_revision === null
      ? null
      : Number(row.expected_resource_revision),
    targetPublicId: row.target_public_id,
    checksumSha256: row.checksum_sha256,
    logicalPath: row.logical_path ?? "",
    normalizedPath: row.normalized_path,
    title: row.title,
    metadata: row.metadata
  };
}

async function readReplacementSourceState(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; sourceFileId: string }
): Promise<boolean> {
  const rows = await sql<Array<{ public_id: string }>>`
    SELECT source.public_id
    FROM focowiki.source_files source
    JOIN focowiki.knowledge_bases knowledge_base
      ON knowledge_base.public_id = source.knowledge_base_id
     AND knowledge_base.deleted_at IS NULL
    WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
      AND source.public_id = ${input.sourceFileId}
      AND source.deleted_at IS NULL
    LIMIT 1
  `;
  return Boolean(rows[0]);
}

function analyzeReplacementSource(relativePath: string, bytes: Uint8Array) {
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return analyzeDocumentSourceMarkdown({
      fileName: relativePath.split("/").at(-1) ?? relativePath,
      content
    });
  } catch {
    throw new SourceResourceError("INVALID_RESOURCE_MUTATION");
  }
}

async function acceptDeletion(
  input: Parameters<typeof createPostgresStorageVnextAdminMutation>[0],
  accept: ReturnType<typeof createPostgresDocumentDeletionAcceptance>,
  request: {
    kind: "source_file" | "source_directory" | "knowledge_base";
    knowledgeBaseId: string;
    targetPublicId: string;
    expectedResourceRevision: number;
    idempotencyKey: string;
  }
) {
  try {
    const context = await deletionWorkflowContext(input.runtimeSettings);
    const accepted = await accept({
      knowledgeBaseId: request.knowledgeBaseId,
      targetKind: request.kind,
      targetPublicId: request.targetPublicId,
      expectedResourceRevision: request.expectedResourceRevision,
      operationPublicId: operationIdentity("deletion"),
      idempotencyKey: request.idempotencyKey,
      maximumAttempts: context.maximumAttempts,
      requestedAt: context.requestedAt,
      expiresAt: context.expiresAt
    });
    const operation = await input.operations.get({
      knowledgeBaseId: request.knowledgeBaseId,
      operationId: accepted.operationPublicId
    });
    if (!operation) throw new Error("Accepted storage vNext deletion is missing");
    return operation;
  } catch (error) {
    throw mapStorageVnextMutationError(error);
  }
}

async function workflowContext(runtimeSettings: RuntimeSettingsService) {
  const now = new Date();
  const snapshot = await runtimeSettings.getSnapshot();
  const revision = await runtimeSettings.getCurrentRevision();
  return {
    settingsRevisionPublicId: revision.publicId,
    deletionMaximumAttempts: snapshot.maintenance.hardDeleteMaxAttempts,
    createdAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + snapshot.worker.completedJobRetentionDays * DAY_MILLISECONDS
    ).toISOString()
  };
}

async function readActiveReplacementSource(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; sourceFileId: string }
): Promise<{
  relativePath: string;
  directoryId: string | null;
  checksumSha256: string;
  objectId: string;
  byteCount: number;
  contentType: string;
  resourceRevision: number;
  contentRevision: number;
  title: string;
  metadata: Readonly<Record<string, unknown>>;
  activeSourceRevisionPublicId: string;
} | null> {
  const rows = await sql<Array<{
    logical_path: string;
    directory_public_id: string | null;
    checksum_sha256: string;
    object_id: string;
    byte_count: number | string;
    content_type: string;
    resource_revision: number | string;
    content_revision: number | string;
    title: string;
    metadata: Record<string, unknown>;
    active_source_revision_public_id: string;
  }>>`
    SELECT source.logical_path, source.directory_public_id,
           revision.checksum_sha256, revision.object_id,
           revision.byte_count, revision.content_type,
           source.revision AS resource_revision,
           active.activation_sequence AS content_revision,
           source.title, source.metadata,
           active.active_source_revision_public_id
    FROM focowiki.source_files source
    JOIN focowiki.source_file_active_revisions active
      ON active.knowledge_base_id = source.knowledge_base_id
     AND active.source_file_public_id = source.public_id
     AND active.active_source_revision_public_id IS NOT NULL
    JOIN focowiki.source_revisions revision
      ON revision.knowledge_base_id = active.knowledge_base_id
     AND revision.source_file_public_id = active.source_file_public_id
     AND revision.public_id = active.active_source_revision_public_id
     AND revision.deleted_at IS NULL
    WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
      AND source.public_id = ${input.sourceFileId}
      AND source.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM focowiki.knowledge_bases knowledge_base
        WHERE knowledge_base.public_id = source.knowledge_base_id
          AND knowledge_base.deleted_at IS NULL
      )
  `;
  const row = rows[0];
  return row ? {
    relativePath: row.logical_path,
    directoryId: row.directory_public_id,
    checksumSha256: row.checksum_sha256,
    objectId: row.object_id,
    byteCount: Number(row.byte_count),
    contentType: row.content_type,
    resourceRevision: Number(row.resource_revision),
    contentRevision: Number(row.content_revision),
    title: row.title,
    metadata: row.metadata,
    activeSourceRevisionPublicId: row.active_source_revision_public_id
  } : null;
}

async function readEditableReplacementSource(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; sourceFileId: string }
): Promise<{
  relativePath: string;
  directoryId: string | null;
  checksumSha256: string;
  objectId: string;
  byteCount: number;
  contentType: string;
  resourceRevision: number;
  contentRevision: number;
  title: string;
  metadata: Readonly<Record<string, unknown>>;
} | null> {
  const rows = await sql<Array<{
    logical_path: string;
    directory_public_id: string | null;
    checksum_sha256: string;
    object_id: string;
    byte_count: number | string;
    content_type: string;
    resource_revision: number | string;
    content_revision: number | string;
    title: string;
    metadata: Record<string, unknown>;
  }>>`
    SELECT presentation.logical_path, presentation.directory_public_id,
           revision.checksum_sha256, revision.object_id,
           revision.byte_count, revision.content_type,
           source.revision AS resource_revision,
           active.activation_sequence AS content_revision,
           presentation.title, presentation.metadata
    FROM focowiki.source_files source
    JOIN focowiki.source_file_active_revisions active
      ON active.knowledge_base_id = source.knowledge_base_id
     AND active.source_file_public_id = source.public_id
     AND active.current_source_revision_public_id IS NOT NULL
    JOIN focowiki.source_revisions revision
      ON revision.knowledge_base_id = active.knowledge_base_id
     AND revision.source_file_public_id = active.source_file_public_id
     AND revision.public_id = active.current_source_revision_public_id
     AND revision.deleted_at IS NULL
    JOIN focowiki.source_revision_presentations presentation
      ON presentation.knowledge_base_id = revision.knowledge_base_id
     AND presentation.source_file_public_id = revision.source_file_public_id
     AND presentation.source_revision_public_id = revision.public_id
    LEFT JOIN focowiki.document_processing_jobs job
      ON job.knowledge_base_id = revision.knowledge_base_id
     AND job.source_file_public_id = revision.source_file_public_id
     AND job.source_revision_public_id = revision.public_id
    WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
      AND source.public_id = ${input.sourceFileId}
      AND source.deleted_at IS NULL
      AND (
        active.current_source_revision_public_id = active.active_source_revision_public_id
        OR job.state = 'error'
      )
      AND EXISTS (
        SELECT 1 FROM focowiki.knowledge_bases knowledge_base
        WHERE knowledge_base.public_id = source.knowledge_base_id
          AND knowledge_base.deleted_at IS NULL
      )
  `;
  const row = rows[0];
  return row ? {
    relativePath: row.logical_path,
    directoryId: row.directory_public_id,
    checksumSha256: row.checksum_sha256,
    objectId: row.object_id,
    byteCount: Number(row.byte_count),
    contentType: row.content_type,
    resourceRevision: Number(row.resource_revision),
    contentRevision: Number(row.content_revision),
    title: row.title,
    metadata: row.metadata
  } : null;
}

async function deletionWorkflowContext(runtimeSettings: RuntimeSettingsService) {
  const context = await workflowContext(runtimeSettings);
  return {
    settingsRevisionPublicId: context.settingsRevisionPublicId,
    maximumAttempts: context.deletionMaximumAttempts,
    requestedAt: context.createdAt,
    expiresAt: context.expiresAt
  };
}

async function resolveParentDirectory(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; logicalPath: string }
): Promise<string | null> {
  const parentPath = input.logicalPath.split("/").slice(0, -1).join("/");
  if (!parentPath) return null;
  const rows = await sql<Array<{ public_id: string }>>`
    SELECT public_id FROM focowiki.source_directories
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND logical_path = ${parentPath} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!rows[0]) throw new SourceResourceError("RESOURCE_NOT_FOUND");
  return rows[0].public_id;
}

function movedSourceTitle(
  currentTitle: string,
  currentPath: string,
  destinationPath: string
): string {
  const currentStem = currentPath.split("/").at(-1)?.replace(/\.md$/iu, "") ?? "";
  if (currentTitle !== currentStem) return currentTitle;
  return destinationPath.split("/").at(-1)?.replace(/\.md$/iu, "") ?? currentTitle;
}

async function deletionCounts(
  sql: DatabaseClient,
  knowledgeBaseId: string,
  kind: "knowledge_base" | "source_directory",
  directoryId: string | null
) {
  const rows = await sql<Array<{
    affected_directory_count: number | string;
    affected_file_count: number | string;
  }>>`
    SELECT
      (SELECT count(*) FROM focowiki.source_directories directory
       WHERE directory.knowledge_base_id = ${knowledgeBaseId}
         AND directory.deleted_at IS NULL
         AND (${kind} = 'knowledge_base' OR directory.public_id = ${directoryId}
           OR directory.normalized_path LIKE (
             SELECT normalized_path || '/%' FROM focowiki.source_directories
             WHERE knowledge_base_id = ${knowledgeBaseId} AND public_id = ${directoryId}
           ))) AS affected_directory_count,
      (SELECT count(*) FROM focowiki.source_files source
       WHERE source.knowledge_base_id = ${knowledgeBaseId}
         AND source.deleted_at IS NULL
         AND (${kind} = 'knowledge_base' OR source.normalized_path LIKE (
           SELECT normalized_path || '/%' FROM focowiki.source_directories
           WHERE knowledge_base_id = ${knowledgeBaseId} AND public_id = ${directoryId}
         ))) AS affected_file_count
  `;
  return {
    affectedDirectoryCount: safeCount(rows[0]?.affected_directory_count ?? 0),
    affectedFileCount: safeCount(rows[0]?.affected_file_count ?? 0)
  };
}

async function readAll(
  bodies: StorageVnextSourceBodyReadPort,
  request: Parameters<StorageVnextSourceBodyReadPort["readVerifiedStream"]>[0]
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  for await (const chunk of await bodies.readVerifiedStream(request)) {
    chunks.push(chunk);
    byteCount += chunk.byteLength;
  }
  const result = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function readActivationRevision(
  sql: DatabaseClient,
  knowledgeBaseId: string
): Promise<number> {
  const rows = await sql<Array<{ activation_revision: number | string }>>`
    SELECT current_sequence AS activation_revision
    FROM focowiki.knowledge_base_sequences
    WHERE knowledge_base_id = ${knowledgeBaseId}
  `;
  return rows[0] ? safeCount(rows[0].activation_revision) : 0;
}


function operationIdentity(kind: string): string {
  return `${kind}-${randomUUID()}`;
}

export function mapStorageVnextMutationError(error: unknown): Error {
  const code = error && typeof error === "object" && "code" in error
    ? error.code
    : null;
  if (code === "resource_missing") return new SourceResourceError("RESOURCE_NOT_FOUND");
  if (code === "revision_conflict") return new SourceResourceError("RESOURCE_REVISION_CONFLICT");
  if (
    code === "path_conflict"
    || code === "scope_conflict"
    || code === "destination_unchanged"
  ) {
    return new SourceResourceError("RESOURCE_PATH_CONFLICT");
  }
  if (code === "content_unchanged") {
    return new SourceResourceError("RESOURCE_CONTENT_UNCHANGED");
  }
  if (code === "idempotency_conflict") return new SourceResourceError("IDEMPOTENCY_CONFLICT");
  if (code === "deletion_conflict") return new SourceResourceError("RESOURCE_DELETING");
  if (typeof code === "string" && code.endsWith("_conflict")) {
    return new SourceResourceError("RESOURCE_BUSY");
  }
  return error instanceof Error ? error : new SourceResourceError("INVALID_RESOURCE_MUTATION");
}

function safeCount(value: number | string) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Invalid storage vNext deletion count");
  }
  return count;
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy.buffer;
}
