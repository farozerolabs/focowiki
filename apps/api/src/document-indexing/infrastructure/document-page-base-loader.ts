import type { StorageVnextImmutableBodyStore } from
  "../../storage-vnext/ownership/s3-immutable-body-store.js";
import type { GeneratedPageBase } from
  "./postgres-generated-page-base-repository.js";
import type { DocumentPageBaseSnapshot } from
  "./production-document-page-base.js";

export function createDocumentPageBaseLoader(input: {
  bodies: StorageVnextImmutableBodyStore;
  maximumBytes: number;
}) {
  return async (request: {
    base: GeneratedPageBase;
    signal: AbortSignal;
  }): Promise<DocumentPageBaseSnapshot> => {
    const bytes = await input.bodies.readVerified({
      descriptor: {
        objectId: request.base.object.objectId,
        storageKey: request.base.object.storageKey,
        checksum: request.base.object.checksumSha256,
        byteCount: request.base.object.byteCount,
        contentType: request.base.object.contentType,
        objectFormat: request.base.object.objectFormat
      },
      maximumBytes: input.maximumBytes,
      signal: request.signal
    });
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw loaderError("generated_page_base_invalid");
    }
    if (!isRecord(value)
      || value.schemaVersion !== "document-page-base-v1"
      || value.sourceFilePublicId !== request.base.sourceFilePublicId
      || value.sourceRevisionPublicId !== request.base.sourceRevisionPublicId
      || typeof value.logicalPath !== "string"
      || typeof value.title !== "string"
      || typeof value.body !== "string"
      || !isRecord(value.metadata)
      || !isRecord(value.sourceMetadata)
      || !Array.isArray(value.semanticEntities)) {
      throw loaderError("generated_page_base_invalid");
    }
    return value as unknown as DocumentPageBaseSnapshot;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loaderError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Generated page base loader error: ${code}`), { code });
}
