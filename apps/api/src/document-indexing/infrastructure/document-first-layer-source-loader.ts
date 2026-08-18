import type { StorageVnextImmutableBodyStore } from
  "../../storage-vnext/ownership/s3-immutable-body-store.js";
import type { StorageVnextImmutableObjectDescriptor } from
  "../../storage-vnext/ownership/content-address.js";
import type { ClaimedDocumentArtifactWork } from
  "../application/document-work-port.js";
import type { createPostgresDocumentReceiptRepository } from
  "./postgres-document-receipt-repository.js";
import type { DocumentFirstLayerSnapshot } from
  "./production-document-first-layer-work-handler.js";

export function createDocumentFirstLayerSourceLoader(input: {
  receipts: ReturnType<typeof createPostgresDocumentReceiptRepository>;
  bodies: StorageVnextImmutableBodyStore;
  maximumSnapshotBytes: number;
}) {
  return async (request: {
    claimed: ClaimedDocumentArtifactWork;
    signal: AbortSignal;
  }): Promise<DocumentFirstLayerSnapshot> => {
    const receipt = await input.receipts.findForRevision({
      knowledgeBaseId: request.claimed.knowledgeBaseId,
      sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
      kind: "first_layer",
      key: "mandatory"
    });
    if (!receipt) throw loaderError("first_layer_receipt_missing");
    const pointer = snapshotPointer(receipt.value);
    const descriptor: StorageVnextImmutableObjectDescriptor = {
      objectId: pointer.objectId,
      storageKey: pointer.storageKey,
      checksum: pointer.checksumSha256,
      byteCount: pointer.byteCount,
      contentType: pointer.contentType,
      objectFormat: pointer.objectFormat
    };
    const bytes = await input.bodies.readVerified({
      descriptor,
      maximumBytes: input.maximumSnapshotBytes,
      signal: request.signal
    });
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw loaderError("first_layer_snapshot_invalid");
    }
    return validateSnapshot(value);
  };
}

function snapshotPointer(value: Readonly<Record<string, unknown>>): {
  objectId: string;
  storageKey: string;
  checksumSha256: string;
  byteCount: number;
  contentType: "application/json; charset=utf-8";
  objectFormat: "okf-generated-json-v1";
} {
  const snapshot = value.snapshot;
  if (value.schemaVersion !== "document-first-layer-receipt-v1"
    || !isRecord(snapshot)
    || typeof snapshot.objectId !== "string"
    || typeof snapshot.storageKey !== "string"
    || typeof snapshot.checksumSha256 !== "string"
    || typeof snapshot.byteCount !== "number"
    || snapshot.contentType !== "application/json; charset=utf-8"
    || snapshot.objectFormat !== "okf-generated-json-v1") {
    throw loaderError("first_layer_receipt_invalid");
  }
  return snapshot as ReturnType<typeof snapshotPointer>;
}

function validateSnapshot(value: unknown): DocumentFirstLayerSnapshot {
  if (!isRecord(value)
    || value.schemaVersion !== "document-first-layer-source-v1"
    || !isRecord(value.contentProfile)
    || !Array.isArray(value.warnings)
    || !isRecord(value.plan)) {
    throw loaderError("first_layer_snapshot_invalid");
  }
  return value as unknown as DocumentFirstLayerSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loaderError(code: string): Error & { code: string } {
  return Object.assign(new Error(`First-layer source loader error: ${code}`), { code });
}
