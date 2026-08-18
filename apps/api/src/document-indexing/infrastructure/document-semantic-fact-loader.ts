import type { StorageVnextImmutableBodyStore } from
  "../../storage-vnext/ownership/s3-immutable-body-store.js";
import type { SemanticDesiredFactSet } from
  "../../semantic/domain/contracts.js";
import type { ClaimedDocumentArtifactWork } from
  "../application/document-work-port.js";
import type { createPostgresDocumentReceiptRepository } from
  "./postgres-document-receipt-repository.js";

export function createDocumentSemanticFactLoader(input: {
  receipts: ReturnType<typeof createPostgresDocumentReceiptRepository>;
  bodies: StorageVnextImmutableBodyStore;
  maximumBytes: number;
}) {
  return async (request: {
    claimed: ClaimedDocumentArtifactWork;
    signal: AbortSignal;
  }): Promise<SemanticDesiredFactSet> => {
    const receipt = await input.receipts.findForRevision({
      knowledgeBaseId: request.claimed.knowledgeBaseId,
      sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
      kind: "graphrag",
      key: "semantic"
    });
    const pointer = factPointer(receipt?.value);
    const bytes = await input.bodies.readVerified({
      descriptor: {
        objectId: pointer.objectId,
        storageKey: pointer.storageKey,
        checksum: pointer.checksumSha256,
        byteCount: pointer.byteCount,
        contentType: pointer.contentType,
        objectFormat: pointer.objectFormat
      },
      maximumBytes: input.maximumBytes,
      signal: request.signal
    });
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw loaderError("semantic_fact_snapshot_invalid");
    }
    if (!isRecord(value) || value.schemaVersion !== "document-semantic-facts-v1"
      || !isRecord(value.desiredFacts)) {
      throw loaderError("semantic_fact_snapshot_invalid");
    }
    return value.desiredFacts as unknown as SemanticDesiredFactSet;
  };
}

function factPointer(value: Readonly<Record<string, unknown>> | undefined) {
  const pointer = value?.factSnapshot;
  if (value?.schemaVersion !== "document-graphrag-receipt-v1"
    || !isRecord(pointer)
    || typeof pointer.objectId !== "string"
    || typeof pointer.storageKey !== "string"
    || typeof pointer.checksumSha256 !== "string"
    || typeof pointer.byteCount !== "number"
    || pointer.contentType !== "application/json; charset=utf-8"
    || pointer.objectFormat !== "okf-generated-json-v1") {
    throw loaderError("semantic_fact_receipt_invalid");
  }
  return pointer as {
    objectId: string;
    storageKey: string;
    checksumSha256: string;
    byteCount: number;
    contentType: "application/json; charset=utf-8";
    objectFormat: "okf-generated-json-v1";
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loaderError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Semantic fact loader error: ${code}`), { code });
}
