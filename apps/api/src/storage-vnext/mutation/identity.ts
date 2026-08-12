import { createHash } from "node:crypto";
import type {
  StorageVnextMutationRequest,
  StorageVnextMutationTargetKind
} from "./ports.js";

export function createStorageVnextMutationRequestHash(input: {
  request: StorageVnextMutationRequest;
  targetKind: StorageVnextMutationTargetKind;
  candidateLogicalPath?: string;
  normalizedCandidatePath?: string;
}): string {
  const request = input.request;
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    kind: request.kind,
    knowledgeBaseId: request.knowledgeBaseId,
    targetKind: input.targetKind,
    targetPublicId: request.targetPublicId,
    expectedResourceRevision: request.expectedResourceRevision,
    candidateLogicalPath: input.candidateLogicalPath ?? null,
    normalizedCandidatePath: input.normalizedCandidatePath ?? null,
    mutation: mutationPayload(request)
  })).digest("hex");
}

function mutationPayload(request: StorageVnextMutationRequest) {
  switch (request.kind) {
    case "knowledge_base_metadata":
      return {
        name: request.name ?? null,
        description: request.description ?? null
      };
    case "source_file_metadata":
      return {
        title: request.title ?? null,
        metadata: Object.fromEntries(Object.entries(request.metadata).sort())
      };
    case "source_file_move":
      return { destinationDirectoryPublicId: request.destinationDirectoryPublicId };
    case "source_directory_move":
      return { destinationParentPublicId: request.destinationParentPublicId };
    case "source_replace":
      return {
        checksumSha256: request.checksumSha256,
        byteCount: request.byteCount,
        contentType: request.contentType,
        candidateTitle: request.candidateTitle,
        candidateMetadata: Object.fromEntries(
          Object.entries(request.candidateMetadata).sort()
        ),
        destinationDirectoryPublicId: request.destinationDirectoryPublicId ?? null
      };
  }
}
