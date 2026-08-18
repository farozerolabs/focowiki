import type { StorageVnextImmutableBodyStore } from
  "../../storage-vnext/ownership/s3-immutable-body-store.js";
import type { StorageVnextImmutableObjectDescriptor } from
  "../../storage-vnext/ownership/content-address.js";
import type { ClaimedDocumentArtifactWork } from
  "../application/document-work-port.js";
import type { PreparedDocument } from "./production-document-types.js";
import type { createPostgresDocumentReceiptRepository } from
  "./postgres-document-receipt-repository.js";
import type { createPostgresDocumentWorkContext } from
  "./postgres-document-work-context.js";

export type PreparedSnapshotReceipt = {
  schemaVersion: "document-prepared-receipt-v1";
  contentContractSha256: string;
  sourceObjectId: string;
  sourceChecksumSha256: string;
  sourceLogicalPath: string;
  sourceLinkBaseLogicalPath?: string;
  preparedSnapshot: {
    objectId: string;
    storageKey: string;
    checksumSha256: string;
    byteCount: number;
    contentType: string;
    objectFormat: "okf-generated-json-v1";
  };
};

export type PreparedSnapshot = Omit<
  PreparedDocument,
  "context" | "sourceLinkBaseLogicalPath"
> & {
  schemaVersion: "document-prepared-source-v1";
  sourceLinkBaseLogicalPath?: string;
};

export function createDocumentPreparedSourceLoader(input: {
  contexts: ReturnType<typeof createPostgresDocumentWorkContext>;
  receipts: ReturnType<typeof createPostgresDocumentReceiptRepository>;
  bodies: StorageVnextImmutableBodyStore;
  maximumSnapshotBytes: number;
}) {
  return async (request: {
    claimed: ClaimedDocumentArtifactWork;
    signal: AbortSignal;
  }): Promise<PreparedDocument> => {
    const [context, receipt] = await Promise.all([
      input.contexts.read(request.claimed),
      input.receipts.findForRevision({
        knowledgeBaseId: request.claimed.knowledgeBaseId,
        sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
        kind: "parsed_source",
        key: "source"
      })
    ]);
    if (!receipt) throw loaderError("prepared_receipt_missing");
    const value = readPreparedSnapshotReceipt(receipt.value);
    if (value.sourceObjectId !== context.source.objectId
      || value.sourceChecksumSha256 !== context.source.checksumSha256) {
      throw loaderError("prepared_receipt_stale");
    }
    const descriptor: StorageVnextImmutableObjectDescriptor = {
      objectId: value.preparedSnapshot.objectId,
      storageKey: value.preparedSnapshot.storageKey,
      checksum: value.preparedSnapshot.checksumSha256,
      byteCount: value.preparedSnapshot.byteCount,
      contentType: value.preparedSnapshot.contentType,
      objectFormat: value.preparedSnapshot.objectFormat
    };
    const bytes = await input.bodies.readVerified({
      descriptor,
      maximumBytes: input.maximumSnapshotBytes,
      signal: request.signal
    });
    const snapshot = decodePreparedSnapshot(bytes);
    return {
      body: snapshot.body,
      metadata: snapshot.metadata,
      parsedMetadata: snapshot.parsedMetadata,
      resolvedMetadata: snapshot.resolvedMetadata,
      contentProfile: snapshot.contentProfile,
      structureProfile: snapshot.structureProfile,
      referenceProfile: snapshot.referenceProfile,
      artifacts: snapshot.artifacts,
      sourceLinkBaseLogicalPath: snapshot.sourceLinkBaseLogicalPath
        ?? value.sourceLinkBaseLogicalPath
        ?? value.sourceLogicalPath,
      context: {
        source: context.source,
        runtimeSettings: context.runtimeSettings
      }
    };
  };
}

export function readPreparedSnapshotReceipt(
  value: Readonly<Record<string, unknown>>
): PreparedSnapshotReceipt {
  const snapshot = value.preparedSnapshot;
  if (value.schemaVersion !== "document-prepared-receipt-v1"
    || typeof value.contentContractSha256 !== "string"
    || typeof value.sourceObjectId !== "string"
    || typeof value.sourceChecksumSha256 !== "string"
    || typeof value.sourceLogicalPath !== "string"
    || !isRecord(snapshot)
    || typeof snapshot.objectId !== "string"
    || typeof snapshot.storageKey !== "string"
    || typeof snapshot.checksumSha256 !== "string"
    || typeof snapshot.byteCount !== "number"
    || snapshot.contentType !== "application/json; charset=utf-8"
    || snapshot.objectFormat !== "okf-generated-json-v1") {
    throw loaderError("prepared_receipt_invalid");
  }
  return value as PreparedSnapshotReceipt;
}

export function decodePreparedSnapshot(bytes: Uint8Array): PreparedSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw loaderError("prepared_snapshot_invalid");
  }
  if (!isRecord(value)
    || value.schemaVersion !== "document-prepared-source-v1"
    || typeof value.body !== "string" || !value.body.trim()
    || !isRecord(value.metadata) || !isRecord(value.parsedMetadata)
    || !isRecord(value.resolvedMetadata) || !isRecord(value.contentProfile)
    || !isRecord(value.structureProfile) || !isRecord(value.referenceProfile)
    || !isRecord(value.artifacts)) {
    throw loaderError("prepared_snapshot_invalid");
  }
  return value as unknown as PreparedSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loaderError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Prepared source loader error: ${code}`), { code });
}
