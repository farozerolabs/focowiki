import { createHash, randomUUID } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import { SourceResourceError } from "../../domain/source-resource.js";
import type { RuntimeSettingsService } from "../../runtime-settings/service.js";
import type { StorageVnextCatalogRepository } from "../catalog/ports.js";
import type { StorageVnextSourceBodyReadPort } from "../catalog/s3-source-body-store.js";
import type { createStorageVnextDeletionCoordinator } from "../deletion/deletion-coordinator.js";
import type { createStorageVnextMutationCoordinator } from "../mutation/mutation-coordinator.js";
import type { StorageVnextMutationRequest } from "../mutation/ports.js";
import type { StorageVnextImmutableObjectWriter } from "../ownership/immutable-object-writer.js";
import type { StorageVnextReleaseReadPort } from "../release/ports.js";
import type { StorageVnextAdminMutationApplication } from "./admin-mutation-application.js";
import type { StorageVnextAdminResourceRead } from "./postgres-admin-resources.js";
import type { StorageVnextOperationRead } from "./postgres-operation-read.js";
import { analyzeStorageVnextSourceMarkdown } from
  "../source-processing/source-metadata.js";

const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";
const DAY_MILLISECONDS = 86_400_000;

export function createPostgresStorageVnextAdminMutation(input: {
  sql: DatabaseClient;
  catalog: StorageVnextCatalogRepository;
  releases: StorageVnextReleaseReadPort;
  resources: StorageVnextAdminResourceRead;
  operations: StorageVnextOperationRead;
  mutations: ReturnType<typeof createStorageVnextMutationCoordinator>;
  deletions: ReturnType<typeof createStorageVnextDeletionCoordinator>;
  sourceBodies: StorageVnextSourceBodyReadPort;
  objectWriter: StorageVnextImmutableObjectWriter;
  runtimeSettings: RuntimeSettingsService;
  maximumSourceBytes: number;
}): StorageVnextAdminMutationApplication {
  return {
    available: () => true,

    async updateKnowledgeBase(request) {
      const knowledgeBase = await input.catalog.getKnowledgeBase(request);
      if (!knowledgeBase) throw new SourceResourceError("RESOURCE_NOT_FOUND");
      const operationId = operationIdentity("metadata");
      try {
        await input.mutations.acceptMutation({
          kind: "knowledge_base_metadata",
          knowledgeBaseId: request.knowledgeBaseId,
          operationPublicId: operationId,
          targetPublicId: request.knowledgeBaseId,
          expectedResourceRevision: request.expectedResourceRevision,
          idempotencyKey: metadataIdempotency(request),
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.description === undefined ? {} : { description: request.description }),
          ...await workflowContext(input.runtimeSettings)
        });
      } catch (error) {
      throw mapStorageVnextMutationError(error);
      }
      const active = await input.releases.getActiveRoot(request.knowledgeBaseId);
      return {
        knowledgeBase: {
          id: knowledgeBase.publicId,
          name: request.name ?? knowledgeBase.name,
          description: request.description === undefined
            ? knowledgeBase.description
            : request.description,
          activeGenerationId: active?.publicId ?? null,
          resourceRevision: request.expectedResourceRevision + 1,
          catalogGeneration: active?.revision ?? 0,
          createdAt: knowledgeBase.createdAt,
          updatedAt: new Date().toISOString()
        },
        publicationQueued: true
      };
    },

    async deleteKnowledgeBase(request) {
      const counts = await deletionCounts(input.sql, request.knowledgeBaseId, "knowledge_base", null);
      const operation = await acceptDeletion(input, {
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
      const active = await input.releases.getActiveRoot(request.knowledgeBaseId);
      return {
        id: knowledgeBase.publicId,
        name: knowledgeBase.name,
        description: knowledgeBase.description,
        activeGenerationId: active?.publicId ?? null,
        resourceRevision: knowledgeBase.revision,
        catalogGeneration: active?.revision ?? 0,
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
      const acceptance = await acceptMutation(input, {
        kind: "source_directory_move",
        knowledgeBaseId: request.knowledgeBaseId,
        targetPublicId: request.targetId,
        expectedResourceRevision: request.expectedResourceRevision,
        idempotencyKey: request.idempotencyKey,
        destinationParentPublicId,
        destinationLogicalPath: request.relativePath
      });
      return { operation: acceptance };
    },

    async deleteSourceDirectory(request) {
      const counts = await deletionCounts(
        input.sql,
        request.knowledgeBaseId,
        "source_directory",
        request.directoryId
      );
      const operation = await acceptDeletion(input, {
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
      const source = await input.resources.getSourceFile(request);
      if (!source) return null;
      const revision = await input.catalog.getCurrentSourceRevision({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFilePublicId: request.sourceFileId
      });
      if (!revision) return null;
      const content = await readAll(input.sourceBodies, {
        objectId: revision.objectId,
        checksum: revision.checksum,
        byteCount: revision.byteCount,
        contentType: revision.contentType,
        maxBytes: input.maximumSourceBytes
      });
      return {
        content: copyArrayBuffer(content),
        contentType: revision.contentType,
        resourceRevision: source.resourceRevision,
        contentRevision: source.contentRevision
      };
    },

    async moveSourceFile(request) {
      const destinationDirectoryPublicId = await resolveParentDirectory(input.sql, {
        knowledgeBaseId: request.knowledgeBaseId,
        logicalPath: request.relativePath
      });
      return {
        operation: await acceptMutation(input, {
          kind: "source_file_move",
          knowledgeBaseId: request.knowledgeBaseId,
          targetPublicId: request.targetId,
          expectedResourceRevision: request.expectedResourceRevision,
          idempotencyKey: request.idempotencyKey,
          destinationDirectoryPublicId,
          destinationLogicalPath: request.relativePath
        })
      };
    },

    async replaceSourceFileContent(request) {
      const current = await input.resources.getSourceFile({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFileId: request.sourceFileId
      });
      if (!current) throw new SourceResourceError("RESOURCE_NOT_FOUND");
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
      return {
        operation: await acceptMutation(input, {
          kind: "source_replace",
          knowledgeBaseId: request.knowledgeBaseId,
          targetPublicId: request.sourceFileId,
          expectedResourceRevision: request.expectedResourceRevision,
          idempotencyKey: request.idempotencyKey,
          candidateRevisionPublicId: operationIdentity("revision"),
          objectId: stored.objectId,
          checksumSha256: stored.checksum,
          byteCount: stored.byteCount,
          contentType: MARKDOWN_CONTENT_TYPE,
          candidateTitle: analyzed.resolvedMetadata.title,
          candidateMetadata: analyzed.metadata,
          ...(request.relativePath ? {
              destinationDirectoryPublicId,
              destinationLogicalPath: request.relativePath
            } : {})
        })
      };
    },

    async deleteSourceFile(request) {
      return {
        operation: await acceptDeletion(input, {
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

function analyzeReplacementSource(relativePath: string, bytes: Uint8Array) {
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return analyzeStorageVnextSourceMarkdown({
      fileName: relativePath.split("/").at(-1) ?? relativePath,
      content
    });
  } catch {
    throw new SourceResourceError("INVALID_RESOURCE_MUTATION");
  }
}

async function acceptMutation(
  input: Parameters<typeof createPostgresStorageVnextAdminMutation>[0],
  request: PendingMutationRequest
) {
  const operationPublicId = operationIdentity("mutation");
  try {
    const accepted = await input.mutations.acceptMutation({
      ...request,
      operationPublicId,
      ...await workflowContext(input.runtimeSettings)
    });
    const operation = await input.operations.get({
      knowledgeBaseId: request.knowledgeBaseId,
      operationId: accepted.operationPublicId
    });
    if (!operation) throw new Error("Accepted storage vNext mutation is missing");
    return operation;
  } catch (error) {
      throw mapStorageVnextMutationError(error);
  }
}

type WithoutWorkflowContext<T extends StorageVnextMutationRequest> =
  T extends StorageVnextMutationRequest
    ? Omit<T, "operationPublicId" | "settingsRevisionPublicId" | "createdAt" | "expiresAt">
    : never;

type PendingMutationRequest = WithoutWorkflowContext<StorageVnextMutationRequest>;

async function acceptDeletion(
  input: Parameters<typeof createPostgresStorageVnextAdminMutation>[0],
  request: {
    kind: "source_file" | "source_directory" | "knowledge_base";
    knowledgeBaseId: string;
    targetPublicId: string;
    expectedResourceRevision: number;
    idempotencyKey: string;
  }
) {
  try {
    const accepted = await input.deletions.acceptDeletion({
      ...request,
      operationPublicId: operationIdentity("deletion"),
      ...await deletionWorkflowContext(input.runtimeSettings)
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
    createdAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + snapshot.worker.completedJobRetentionDays * DAY_MILLISECONDS
    ).toISOString()
  };
}

async function deletionWorkflowContext(runtimeSettings: RuntimeSettingsService) {
  const context = await workflowContext(runtimeSettings);
  return {
    settingsRevisionPublicId: context.settingsRevisionPublicId,
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
  return rows[0]?.public_id ?? null;
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

function metadataIdempotency(request: {
  knowledgeBaseId: string;
  expectedResourceRevision: number;
  name?: string;
  description?: string | null;
}) {
  return `metadata:${createHash("sha256").update(JSON.stringify(request)).digest("hex")}`;
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
    || code === "content_unchanged"
  ) {
    return new SourceResourceError("RESOURCE_PATH_CONFLICT");
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
