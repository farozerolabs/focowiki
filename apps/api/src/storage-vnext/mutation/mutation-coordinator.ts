import {
  normalizeSourceDirectoryPath,
  normalizeSourceRelativePath
} from "../../domain/source-path.js";
import { createStorageVnextMutationRequestHash } from "./identity.js";
import type {
  StorageVnextMutationRepository,
  StorageVnextMutationRequest,
  StorageVnextMutationTargetKind
} from "./ports.js";

const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/u;

export function createStorageVnextMutationCoordinator(input: {
  repository: StorageVnextMutationRepository;
}) {
  return {
    async acceptMutation(request: StorageVnextMutationRequest) {
      validateBaseRequest(request);
      const targetKind = mutationTargetKind(request.kind);
      const path = normalizeCandidatePath(request);
      const requestHash = createStorageVnextMutationRequestHash({
        request,
        targetKind,
        ...path
      });
      return input.repository.acceptMutation({
        ...request,
        targetKind,
        requestHash,
        ...path
      });
    }
  };
}

function mutationTargetKind(
  kind: StorageVnextMutationRequest["kind"]
): StorageVnextMutationTargetKind {
  if (kind === "knowledge_base_metadata") return "knowledge_base";
  if (kind === "source_directory_move") return "source_directory";
  return "source_file";
}

function normalizeCandidatePath(
  request: StorageVnextMutationRequest
): { candidateLogicalPath?: string; normalizedCandidatePath?: string } {
  if (request.kind === "source_file_move") {
    const path = normalizeSourceRelativePath(request.destinationLogicalPath);
    return {
      candidateLogicalPath: path.relativePath,
      normalizedCandidatePath: path.pathKey
    };
  }
  if (request.kind === "source_directory_move") {
    const path = normalizeSourceDirectoryPath(request.destinationLogicalPath);
    return {
      candidateLogicalPath: path.relativePath,
      normalizedCandidatePath: path.pathKey
    };
  }
  if (request.kind === "source_replace" && request.destinationLogicalPath) {
    const path = normalizeSourceRelativePath(request.destinationLogicalPath);
    return {
      candidateLogicalPath: path.relativePath,
      normalizedCandidatePath: path.pathKey
    };
  }
  return {};
}

function validateBaseRequest(request: StorageVnextMutationRequest): void {
  for (const value of [
    request.knowledgeBaseId,
    request.operationPublicId,
    request.targetPublicId,
    request.idempotencyKey,
    request.settingsRevisionPublicId
  ]) {
    if (!value || Buffer.byteLength(value) > 255) {
      throw mutationError("invalid_input");
    }
  }
  if (!Number.isSafeInteger(request.expectedResourceRevision)
    || request.expectedResourceRevision < 0) {
    throw mutationError("invalid_input");
  }
  const createdAt = new Date(request.createdAt);
  const expiresAt = new Date(request.expiresAt);
  if (!Number.isFinite(createdAt.getTime())
    || !Number.isFinite(expiresAt.getTime())
    || expiresAt <= createdAt) {
    throw mutationError("invalid_input");
  }
  if (request.kind === "source_replace" && (
    !request.candidateRevisionPublicId
    || !request.objectId
    || !CHECKSUM_PATTERN.test(request.checksumSha256)
    || !Number.isSafeInteger(request.byteCount)
    || request.byteCount < 0
    || request.contentType !== MARKDOWN_CONTENT_TYPE
    || !request.candidateTitle
    || !request.candidateMetadata
  )) throw mutationError("invalid_input");
}

function mutationError(code: string): Error {
  return Object.assign(new Error(`Storage vNext mutation error: ${code}`), { code });
}
