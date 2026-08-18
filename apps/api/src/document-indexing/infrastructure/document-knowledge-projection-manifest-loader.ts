import type { StorageVnextImmutableBodyStore } from
  "../../storage-vnext/ownership/s3-immutable-body-store.js";
import type {
  DocumentKnowledgeProjectionManifest,
  DocumentKnowledgeProjectionManifestPointer
} from "../application/document-knowledge-projection-manifest.js";

export function createDocumentKnowledgeProjectionManifestLoader(input: {
  bodies: StorageVnextImmutableBodyStore;
  maximumBytes: number;
}) {
  return async (request: {
    pointer: DocumentKnowledgeProjectionManifestPointer;
    signal: AbortSignal;
  }): Promise<DocumentKnowledgeProjectionManifest> => {
    const bytes = await input.bodies.readVerified({
      descriptor: {
        objectId: request.pointer.objectId,
        storageKey: request.pointer.storageKey,
        checksum: request.pointer.checksumSha256,
        byteCount: request.pointer.byteCount,
        contentType: request.pointer.contentType,
        objectFormat: request.pointer.objectFormat
      },
      maximumBytes: input.maximumBytes,
      signal: request.signal
    });
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw manifestError("document_projection_manifest_invalid");
    }
    if (!isRecord(value)
      || value.schemaVersion !== "document-knowledge-projection-manifest-v1"
      || typeof value.knowledgeBaseId !== "string"
      || typeof value.documentJobPublicId !== "string"
      || typeof value.sourceFilePublicId !== "string"
      || typeof value.sourceRevisionPublicId !== "string"
      || typeof value.readinessSequence !== "number"
      || !isRecord(value.presentation)
      || !Array.isArray(value.affectedSourceFilePublicIds)
      || !Array.isArray(value.relationPublicIds)
      || !Array.isArray(value.searchFamilyPublicIds)
      || !Array.isArray(value.relationshipSearchDocumentPublicIds)
      || !Array.isArray(value.pageCandidates)
      || !Array.isArray(value.removedPageNormalizedPaths)
      || !Array.isArray(value.navigationMutations)
      || !Array.isArray(value.dirtyScopes)
      || !Array.isArray(value.activationOwners)
      || typeof value.projectedAt !== "string") {
      throw manifestError("document_projection_manifest_invalid");
    }
    return value as unknown as DocumentKnowledgeProjectionManifest;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function manifestError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document projection manifest error: ${code}`), {
    code
  });
}
