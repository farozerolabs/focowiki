import path from "node:path";
import type { StorageVnextImmutableBodyStore } from
  "../../storage-vnext/ownership/s3-immutable-body-store.js";
import type { StorageVnextImmutableObjectDescriptor } from
  "../../storage-vnext/ownership/content-address.js";
import {
  decodePreparedSnapshot,
  readPreparedSnapshotReceipt,
  type PreparedSnapshot
} from "./document-prepared-source-loader.js";
import type { createPostgresDocumentReceiptRepository } from
  "./postgres-document-receipt-repository.js";

export type DocumentPreparedSourceReuseInput = {
  operationKind: string;
  currentSourceChecksumSha256: string;
  currentSourceObjectId: string;
  currentContentContractSha256: string;
  currentLogicalPath: string;
  prior: {
    sourceChecksumSha256: string;
    sourceObjectId: string;
    contentContractSha256: string;
    sourceLogicalPath: string;
    parsedMetadata: Readonly<Record<string, unknown>>;
  };
};

export function isDocumentPathOnlyOperation(operationKind: string): boolean {
  return operationKind === "source_file_move"
    || operationKind === "source_directory_move";
}

export function canReuseDocumentPreparedSource(
  input: DocumentPreparedSourceReuseInput
): boolean {
  if (!isDocumentPathOnlyOperation(input.operationKind)
    || input.currentSourceChecksumSha256 !== input.prior.sourceChecksumSha256
    || input.currentSourceObjectId !== input.prior.sourceObjectId
    || input.currentContentContractSha256 !== input.prior.contentContractSha256) {
    return false;
  }
  const currentFileName = path.posix.basename(input.currentLogicalPath);
  const priorFileName = path.posix.basename(input.prior.sourceLogicalPath);
  if (currentFileName === priorFileName) return true;
  return typeof input.prior.parsedMetadata.title === "string"
    && input.prior.parsedMetadata.title.trim().length > 0;
}

export async function loadReusableDocumentPreparedSource(input: {
  operationKind: string;
  knowledgeBaseId: string;
  priorActiveSourceRevisionPublicId: string | null;
  currentSourceChecksumSha256: string;
  currentSourceObjectId: string;
  currentContentContractSha256: string;
  currentLogicalPath: string;
  receipts: ReturnType<typeof createPostgresDocumentReceiptRepository>;
  bodies: StorageVnextImmutableBodyStore;
  maximumSnapshotBytes: number;
  signal: AbortSignal;
}): Promise<(PreparedSnapshot & { sourceLinkBaseLogicalPath: string }) | null> {
  if (!isDocumentPathOnlyOperation(input.operationKind)
    || !input.priorActiveSourceRevisionPublicId) {
    return null;
  }
  const receipt = await input.receipts.findForRevision({
    knowledgeBaseId: input.knowledgeBaseId,
    sourceRevisionPublicId: input.priorActiveSourceRevisionPublicId,
    kind: "parsed_source",
    key: "source"
  });
  if (!receipt) return null;
  const value = readPreparedSnapshotReceipt(receipt.value);
  if (value.sourceChecksumSha256 !== input.currentSourceChecksumSha256
    || value.sourceObjectId !== input.currentSourceObjectId
    || value.contentContractSha256 !== input.currentContentContractSha256) {
    return null;
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
    signal: input.signal
  });
  const snapshot = decodePreparedSnapshot(bytes);
  return canReuseDocumentPreparedSource({
    operationKind: input.operationKind,
    currentSourceChecksumSha256: input.currentSourceChecksumSha256,
    currentSourceObjectId: input.currentSourceObjectId,
    currentContentContractSha256: input.currentContentContractSha256,
    currentLogicalPath: input.currentLogicalPath,
    prior: {
      sourceChecksumSha256: value.sourceChecksumSha256,
      sourceObjectId: value.sourceObjectId,
      contentContractSha256: value.contentContractSha256,
      sourceLogicalPath: value.sourceLogicalPath,
      parsedMetadata: snapshot.parsedMetadata
    }
  }) ? {
      ...snapshot,
      sourceLinkBaseLogicalPath: snapshot.sourceLinkBaseLogicalPath
        ?? value.sourceLinkBaseLogicalPath
        ?? value.sourceLogicalPath
    } : null;
}
