import { createHash } from "node:crypto";
import type { SourceResourceRepository } from "./ports/source-resource-repository.js";
import type { ApplicationRuntime } from "./ports/runtime.js";
import { SourceResourceError } from "../domain/source-resource.js";
import {
  normalizeSourceDirectoryPath,
  normalizeSourceRelativePath
} from "../domain/source-path.js";

export function createSourceResourceService(
  repository: SourceResourceRepository,
  runtime: ApplicationRuntime
) {
  return {
    updateKnowledgeBase: repository.updateKnowledgeBase,
    listDirectories: repository.listDirectories,
    getDirectory: repository.getDirectory,
    listSourceFiles: repository.listSourceFiles,
    getSourceFile: repository.getSourceFile,
    getSourceFileContentDescriptor: repository.getSourceFileContentDescriptor,
    getOperation: repository.getOperation,
    listOperations: repository.listOperations,
    deleteDirectory: async (input: {
      knowledgeBaseId: string;
      directoryId: string;
      idempotencyKey: string;
      expectedResourceRevision: number;
    }) => {
      if (!input.idempotencyKey.trim() || input.expectedResourceRevision < 1) {
        throw new SourceResourceError("INVALID_RESOURCE_MUTATION");
      }
      const requestFingerprint = createHash("sha256")
        .update(JSON.stringify({
          kind: "source_directory_delete",
          directoryId: input.directoryId,
          expectedResourceRevision: input.expectedResourceRevision
        }))
        .digest("hex");
      return repository.acceptDirectoryDeletion({
        operationId: runtime.ids.create("resource-operation"),
        deletionIntentId: runtime.ids.create("deletion-intent"),
        knowledgeBaseId: input.knowledgeBaseId,
        directoryId: input.directoryId,
        idempotencyKey: input.idempotencyKey.trim(),
        requestFingerprint,
        expectedResourceRevision: input.expectedResourceRevision,
        deletedAt: runtime.clock.now().toISOString()
      });
    },
    deleteSourceFile: async (input: {
      knowledgeBaseId: string;
      sourceFileId: string;
      idempotencyKey: string;
      expectedResourceRevision: number;
    }) => {
      const requestFingerprint = mutationFingerprint({
        kind: "source_file_delete",
        sourceFileId: input.sourceFileId,
        expectedResourceRevision: input.expectedResourceRevision
      });
      return repository.acceptSourceFileDeletion({
        operationId: runtime.ids.create("resource-operation"),
        deletionIntentId: runtime.ids.create("deletion-intent"),
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFileId: input.sourceFileId,
        idempotencyKey: requireMutationKey(input.idempotencyKey),
        requestFingerprint,
        expectedResourceRevision: input.expectedResourceRevision,
        deletedAt: runtime.clock.now().toISOString()
      });
    },
    deleteKnowledgeBase: async (input: {
      knowledgeBaseId: string;
      idempotencyKey: string;
      expectedResourceRevision: number;
    }) => {
      const requestFingerprint = mutationFingerprint({
        kind: "knowledge_base_delete",
        knowledgeBaseId: input.knowledgeBaseId,
        expectedResourceRevision: input.expectedResourceRevision
      });
      return repository.acceptKnowledgeBaseDeletion({
        operationId: runtime.ids.create("resource-operation"),
        deletionIntentId: runtime.ids.create("deletion-intent"),
        knowledgeBaseId: input.knowledgeBaseId,
        idempotencyKey: requireMutationKey(input.idempotencyKey),
        requestFingerprint,
        expectedResourceRevision: input.expectedResourceRevision,
        deletedAt: runtime.clock.now().toISOString()
      });
    },
    acceptOperation: async (input: {
      knowledgeBaseId: string;
      kind:
        | "source_file_replace"
        | "source_file_move"
        | "source_directory_move"
        | "source_file_delete"
        | "source_directory_delete"
        | "knowledge_base_delete";
      idempotencyKey: string;
      expectedResourceRevision: number | null;
      targetKind: "source_file" | "source_directory" | "knowledge_base";
      targetId: string;
      payload: Record<string, unknown>;
    }) => {
      if (!input.idempotencyKey.trim()) {
        throw new SourceResourceError("INVALID_RESOURCE_MUTATION");
      }
      const payload = normalizeOperationPayload(input.kind, input.payload);
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({
          kind: input.kind,
          targetKind: input.targetKind,
          targetId: input.targetId,
          expectedResourceRevision: input.expectedResourceRevision,
          payload
        }))
        .digest("hex");
      return repository.createOperation({
        operationId: runtime.ids.create("resource-operation"),
        knowledgeBaseId: input.knowledgeBaseId,
        kind: input.kind,
        idempotencyKey: input.idempotencyKey.trim(),
        requestFingerprint: fingerprint,
        expectedResourceRevision: input.expectedResourceRevision,
        targetKind: input.targetKind,
        targetId: input.targetId,
        request: payload
      });
    }
  };
}

function mutationFingerprint(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requireMutationKey(value: string): string {
  const key = value.trim();
  if (!key) throw new SourceResourceError("INVALID_RESOURCE_MUTATION");
  return key;
}

function normalizeOperationPayload(
  kind: "source_file_replace" | "source_file_move" | "source_directory_move" | "source_file_delete" | "source_directory_delete" | "knowledge_base_delete",
  payload: Record<string, unknown>
): Record<string, unknown> {
  if (kind === "source_file_move") {
    return { relativePath: normalizeSourceRelativePath(readPath(payload.relativePath)).relativePath };
  }
  if (kind === "source_directory_move") {
    return { relativePath: normalizeSourceDirectoryPath(readPath(payload.relativePath)).relativePath };
  }
  if (kind !== "source_file_replace") return {};

  const revisionId = readRequiredString(payload.revisionId);
  const objectKey = readRequiredString(payload.objectKey);
  const checksumSha256 = readRequiredString(payload.checksumSha256);
  const sizeBytes = payload.sizeBytes;
  if (!Number.isSafeInteger(sizeBytes) || Number(sizeBytes) < 0) {
    throw new SourceResourceError("INVALID_RESOURCE_MUTATION");
  }
  const relativePath = payload.relativePath === undefined
    ? undefined
    : normalizeSourceRelativePath(readPath(payload.relativePath)).relativePath;
  return {
    revisionId,
    objectKey,
    checksumSha256,
    sizeBytes,
    contentType: "text/markdown; charset=utf-8",
    ...(relativePath ? { relativePath } : {})
  };
}

function readPath(value: unknown): string {
  return readRequiredString(value);
}

function readRequiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SourceResourceError("INVALID_RESOURCE_MUTATION");
  }
  return value.trim();
}
