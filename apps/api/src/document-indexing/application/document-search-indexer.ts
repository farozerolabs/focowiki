import { createHash } from "node:crypto";
import type { SearchProviderKind, SearchProviderDocument } from
  "../../application/ports/search-provider-runtime.js";
import {
  createStorageVnextContentDocument,
  createStorageVnextFileRelationshipDocument,
  createStorageVnextGraphSeedDocument
} from
  "../../storage-vnext/search/documents.js";
import { createOkfSearchSignals } from
  "../../storage-vnext/search/okf-signals.js";
import type { StorageVnextStructuredMetadata } from
  "../../storage-vnext/shared/types.js";
import type { DocumentSearchDocument } from
  "./document-search-preparation.js";

const PUBLIC_SOURCE_FILE_KIND = "page";

export function createDocumentSearchIndexer(input: {
  batchSize: number;
  provider: {
    kind: SearchProviderKind;
    writeAcknowledged(request: {
      indexUid: string;
      batchOrdinal: number;
      documents: readonly SearchProviderDocument[];
      correlation: string;
      signal: AbortSignal;
    }): Promise<{
      acknowledgementPublicId: string;
      documentIds: readonly string[];
    }>;
    makeVisible(request: {
      indexUid: string;
      signal: AbortSignal;
    }): Promise<void>;
  };
  owners: {
    stageAcknowledged(request: {
      knowledgeBaseId: string;
      sourceFilePublicId: string;
      sourceRevisionPublicId: string;
      searchProjectionPublicId: string;
      providerKind: SearchProviderKind;
      acknowledgementPublicId: string;
      documents: readonly {
        providerDocumentId: string;
        documentKind: "file" | "segment" | "graph_seed" | "file_relationship";
        checksumSha256: string;
      }[];
      stagedAt: string;
    }): Promise<number>;
  };
}) {
  if (!Number.isSafeInteger(input.batchSize)
    || input.batchSize < 1 || input.batchSize > 10_000) {
    throw searchIndexerError("batch_size_invalid");
  }
  return async (request: {
    knowledgeBaseId: string;
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
    searchProjectionPublicId: string;
    providerIndexUid: string;
    documents: readonly DocumentSearchDocument[];
    stagedAt: string;
    signal: AbortSignal;
  }) => {
    validateRequest(request);
    let batchCount = 0;
    let acknowledgedDocumentCount = 0;
    const documentIds: string[] = [];
    for (let offset = 0; offset < request.documents.length;
      offset += input.batchSize) {
      throwIfAborted(request.signal);
      const batch = request.documents.slice(offset, offset + input.batchSize);
      const providerDocuments = batch.map(toProviderDocument);
      const batchOrdinal = offset / input.batchSize;
      const correlation = `document-search-${createHash("sha256")
        .update(JSON.stringify([
          request.knowledgeBaseId, request.sourceRevisionPublicId,
          input.provider.kind, batchOrdinal,
          batch.map((item) => item.publicId)
        ])).digest("hex")}`;
      const acknowledgement = await input.provider.writeAcknowledged({
        indexUid: request.providerIndexUid,
        batchOrdinal,
        documents: providerDocuments,
        correlation,
        signal: request.signal
      });
      const expectedIds = providerDocuments.map((item) => item.id).sort();
      const acknowledgedIds = [...new Set(acknowledgement.documentIds)].sort();
      if (!acknowledgement.acknowledgementPublicId
        || expectedIds.length !== acknowledgedIds.length
        || expectedIds.some((id, index) => id !== acknowledgedIds[index])) {
        throw searchIndexerError("provider_acknowledgement_invalid");
      }
      const staged = await input.owners.stageAcknowledged({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFilePublicId: request.sourceFilePublicId,
        sourceRevisionPublicId: request.sourceRevisionPublicId,
        searchProjectionPublicId: request.searchProjectionPublicId,
        providerKind: input.provider.kind,
        acknowledgementPublicId: acknowledgement.acknowledgementPublicId,
        documents: providerDocuments.map((document, index) => ({
          providerDocumentId: document.id,
          documentKind: batch[index]!.documentKind,
          checksumSha256: checksum(document)
        })),
        stagedAt: request.stagedAt
      });
      if (staged !== batch.length) {
        throw searchIndexerError("ownership_staging_invalid");
      }
      batchCount += 1;
      acknowledgedDocumentCount += batch.length;
      documentIds.push(...providerDocuments.map((document) => document.id));
    }
    throwIfAborted(request.signal);
    await input.provider.makeVisible({
      indexUid: request.providerIndexUid,
      signal: request.signal
    });
    return { batchCount, acknowledgedDocumentCount, documentIds };
  };
}

function toProviderDocument(input: DocumentSearchDocument): SearchProviderDocument {
  if (input.documentKind === "file_relationship") {
    return createStorageVnextFileRelationshipDocument({
      knowledgeBaseId: input.knowledgeBaseId,
      sourceFilePublicId: input.sourceFilePublicId,
      sourceRevisionPublicId: input.sourceRevisionPublicId,
      logicalPath: input.logicalPath,
      fileKind: PUBLIC_SOURCE_FILE_KIND,
      title: input.title,
      relationPublicId: requiredString(input.relationPublicId),
      evidencePublicId: requiredString(input.evidencePublicId),
      targetSourceFilePublicId: requiredString(input.targetSourceFilePublicId),
      targetSourceRevisionPublicId:
        requiredString(input.targetSourceRevisionPublicId),
      targetLogicalPath: requiredString(input.targetLogicalPath),
      targetTitle: requiredString(input.targetTitle),
      relationKind: input.relationKind === "references" ? "references" : "related",
      direction: input.direction === "incoming" ? "incoming"
        : input.direction === "bidirectional" ? "bidirectional" : "outgoing",
      searchText: input.searchText,
      rankingTerms: input.rankingTerms ?? [],
      okfSignals: createOkfSearchSignals(
        input.metadata as StorageVnextStructuredMetadata
      )
    });
  }
  if (input.documentKind === "graph_seed") {
    return createStorageVnextGraphSeedDocument({
      knowledgeBaseId: input.knowledgeBaseId,
      sourceFilePublicId: input.sourceFilePublicId,
      sourceRevisionPublicId: input.sourceRevisionPublicId,
      logicalPath: input.logicalPath,
      fileKind: PUBLIC_SOURCE_FILE_KIND,
      title: input.title,
      searchText: input.searchText,
      rankingTerms: input.rankingTerms ?? [],
      okfSignals: createOkfSearchSignals(
        input.metadata as StorageVnextStructuredMetadata
      )
    });
  }
  return createStorageVnextContentDocument({
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFilePublicId: input.sourceFilePublicId,
    sourceRevisionPublicId: input.sourceRevisionPublicId,
    logicalPath: input.logicalPath,
    fileKind: PUBLIC_SOURCE_FILE_KIND,
    title: input.title,
    contentKind: input.documentKind,
    segmentOrdinal: input.segmentOrdinal,
    headingAncestors: input.headingAncestors,
    searchText: input.searchText,
    okfSignals: createOkfSearchSignals(
      input.metadata as StorageVnextStructuredMetadata
    )
  });
}

function requiredString(value: string | undefined): string {
  if (!value) throw searchIndexerError("relationship_document_invalid");
  return value;
}

function checksum(document: SearchProviderDocument): string {
  return createHash("sha256").update(JSON.stringify(document)).digest("hex");
}

function validateRequest(input: {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  searchProjectionPublicId: string;
  providerIndexUid: string;
  documents: readonly DocumentSearchDocument[];
  stagedAt: string;
}): void {
  if ([input.knowledgeBaseId, input.sourceFilePublicId,
    input.sourceRevisionPublicId, input.searchProjectionPublicId,
    input.providerIndexUid].some((value) => !value)
    || !Number.isFinite(Date.parse(input.stagedAt))
    || input.documents.length > 10_000
    || new Set(input.documents.map((item) => item.publicId)).size
      !== input.documents.length
    || input.documents.some((document) =>
      document.knowledgeBaseId !== input.knowledgeBaseId
      || document.sourceFilePublicId !== input.sourceFilePublicId
      || document.sourceRevisionPublicId !== input.sourceRevisionPublicId)) {
    throw searchIndexerError("input_invalid");
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? searchIndexerError("cancelled");
}

function searchIndexerError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document search indexer error: ${code}`), { code });
}
