import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { generatedPagePath } from "../../domain/source-path.js";
import type {
  StorageVnextCatalogReadPort,
  StorageVnextCurrentSourceFact
} from "../catalog/ports.js";
import type { StorageVnextSourceBodyReadPort } from
  "../catalog/s3-source-body-store.js";
import type { StorageVnextGraphNodeFact, StorageVnextGraphReadPort } from
  "../graph/ports.js";
import type { StorageVnextStructuredMetadata } from "../shared/types.js";
import {
  createStorageVnextContentDocument,
  createStorageVnextGraphSeedDocument,
  type StorageVnextSearchDocument
} from "../search/documents.js";
import { segmentStorageVnextMarkdown } from "../search/markdown-segmentation.js";
import { readStorageVnextGraphSeedProfile } from
  "../search/graph-seed-profile.js";
import type { StorageVnextSearchProjectionPort } from "../search/ports.js";

type SearchRebuildCursor = {
  version: 1;
  stage: "source" | "graph";
  cursor: string | null;
};

type SearchRebuildLimits = {
  sourcePageSize: number;
  graphPageSize: number;
  maxSourceBytes: number;
  maxSegmentBytes: number;
  maxBatchDocuments: number;
  maxBatchCompressedBytes: number;
};

export function createStorageVnextMaintenanceSearchRebuild(input: {
  catalog: Pick<StorageVnextCatalogReadPort, "listCurrentSources">;
  sourceBodies: StorageVnextSourceBodyReadPort;
  graph: Pick<StorageVnextGraphReadPort, "listNodes">;
  projection: Pick<StorageVnextSearchProjectionPort, "writeDocumentBatch">;
  limits: SearchRebuildLimits;
}) {
  validateLimits(input.limits);
  return {
    async runPage(request: {
      knowledgeBaseId: string;
      candidatePublicId: string;
      operationPublicId: string;
      cursor: string | null;
      batchOrdinal: number;
      signal?: AbortSignal;
    }) {
      validateRequest(request);
      const cursor = decodeCursor(request.cursor) ?? {
        version: 1 as const,
        stage: "source" as const,
        cursor: null
      };
      return cursor.stage === "source"
        ? rebuildSourcePage(input, request, cursor.cursor)
        : rebuildGraphPage(input, request, cursor.cursor);
    }
  };
}

async function rebuildSourcePage(
  input: Parameters<typeof createStorageVnextMaintenanceSearchRebuild>[0],
  request: {
    knowledgeBaseId: string;
    candidatePublicId: string;
    operationPublicId: string;
    cursor: string | null;
    batchOrdinal: number;
    signal?: AbortSignal;
  },
  sourceCursor: string | null
) {
  throwIfAborted(request.signal);
  const page = await input.catalog.listCurrentSources({
    knowledgeBaseId: request.knowledgeBaseId,
    limit: input.limits.sourcePageSize,
    cursor: sourceCursor
  });
  const documents: StorageVnextSearchDocument[] = [];
  let processedBytes = 0;
  for (const current of page.items) {
    assertCurrentSource(request.knowledgeBaseId, current);
    const logicalPath = generatedPagePath(current.sourceFile.logicalPath);
    documents.push(createStorageVnextContentDocument({
      knowledgeBaseId: request.knowledgeBaseId,
      sourceFilePublicId: current.sourceFile.publicId,
      sourceRevisionPublicId: current.sourceRevision.publicId,
      logicalPath,
      fileKind: "page",
      title: current.sourceFile.title,
      contentKind: "file",
      segmentOrdinal: null,
      headingAncestors: [],
      searchText: stableMetadataText(current.sourceFile.metadata)
    }));
    const chunks = await input.sourceBodies.readVerifiedStream({
      objectId: current.sourceRevision.objectId,
      checksum: current.sourceRevision.checksum,
      byteCount: current.sourceRevision.byteCount,
      contentType: current.sourceRevision.contentType,
      maxBytes: input.limits.maxSourceBytes,
      ...(request.signal ? { signal: request.signal } : {})
    });
    for await (const segment of segmentStorageVnextMarkdown({
      chunks,
      maxSegmentBytes: input.limits.maxSegmentBytes,
      sourceRevisionPublicId: current.sourceRevision.publicId
    })) {
      throwIfAborted(request.signal);
      documents.push(createStorageVnextContentDocument({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFilePublicId: current.sourceFile.publicId,
        sourceRevisionPublicId: current.sourceRevision.publicId,
        logicalPath,
        fileKind: "page",
        title: current.sourceFile.title,
        contentKind: "segment",
        segmentOrdinal: segment.ordinal,
        headingAncestors: segment.headingAncestors,
        searchText: segment.searchText
      }));
    }
    processedBytes += current.sourceRevision.byteCount;
  }
  const batchCount = await writeBatches(input, request, documents);
  const next = page.nextCursor === null
    ? encodeCursor({ version: 1, stage: "graph", cursor: null })
    : encodeCursor({ version: 1, stage: "source", cursor: page.nextCursor });
  return {
    outcome: "progress" as const,
    cursor: next,
    completedDelta: page.items.length,
    expectedCount: page.items.length,
    processedBytesDelta: processedBytes,
    batchOrdinalDelta: batchCount
  };
}

async function rebuildGraphPage(
  input: Parameters<typeof createStorageVnextMaintenanceSearchRebuild>[0],
  request: {
    knowledgeBaseId: string;
    candidatePublicId: string;
    operationPublicId: string;
    cursor: string | null;
    batchOrdinal: number;
    signal?: AbortSignal;
  },
  graphCursor: string | null
) {
  throwIfAborted(request.signal);
  const page = await input.graph.listNodes({
    knowledgeBaseId: request.knowledgeBaseId,
    limit: input.limits.graphPageSize,
    cursor: graphCursor
  });
  const documents = page.items.map((node) => graphDocument(
    request.knowledgeBaseId,
    node
  ));
  const batchCount = await writeBatches(input, request, documents);
  const completed = page.nextCursor === null;
  return {
    outcome: completed ? "phase_completed" as const : "progress" as const,
    cursor: completed
      ? null
      : encodeCursor({ version: 1, stage: "graph", cursor: page.nextCursor }),
    completedDelta: page.items.length,
    expectedCount: page.items.length,
    processedBytesDelta: Buffer.byteLength(JSON.stringify(documents)),
    batchOrdinalDelta: batchCount
  };
}

async function writeBatches(
  input: Parameters<typeof createStorageVnextMaintenanceSearchRebuild>[0],
  request: {
    candidatePublicId: string;
    operationPublicId: string;
    batchOrdinal: number;
  },
  documents: readonly StorageVnextSearchDocument[]
): Promise<number> {
  let batch: StorageVnextSearchDocument[] = [];
  let batchCount = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const description = describeBatch(batch);
    await input.projection.writeDocumentBatch({
      candidatePublicId: request.candidatePublicId,
      operationPublicId: request.operationPublicId,
      batchOrdinal: request.batchOrdinal + batchCount,
      payloadChecksum: description.payloadChecksum,
      compressedBytes: description.compressedBytes,
      documents: batch
    });
    batch = [];
    batchCount += 1;
  };
  for (const document of documents) {
    const single = describeBatch([document]);
    if (single.compressedBytes > input.limits.maxBatchCompressedBytes) {
      throw maintenanceSearchError("document_too_large");
    }
    if (batch.length >= input.limits.maxBatchDocuments) await flush();
    const candidate = describeBatch([...batch, document]);
    if (
      batch.length > 0
      && candidate.compressedBytes > input.limits.maxBatchCompressedBytes
    ) await flush();
    batch.push(document);
  }
  await flush();
  return batchCount;
}

function graphDocument(
  knowledgeBaseId: string,
  node: StorageVnextGraphNodeFact
): StorageVnextSearchDocument {
  if (node.knowledgeBaseId !== knowledgeBaseId) {
    throw maintenanceSearchError("scope_conflict");
  }
  const profile = readStorageVnextGraphSeedProfile(node);
  return createStorageVnextGraphSeedDocument({
    knowledgeBaseId,
    sourceFilePublicId: node.sourceFilePublicId,
    sourceRevisionPublicId: node.sourceRevisionPublicId,
    logicalPath: node.logicalPath,
    title: node.label,
    searchText: profile.searchText,
    rankingTerms: profile.rankingTerms
  });
}

function assertCurrentSource(
  knowledgeBaseId: string,
  current: StorageVnextCurrentSourceFact
): void {
  if (
    current.sourceFile.knowledgeBaseId !== knowledgeBaseId
    || current.sourceRevision.knowledgeBaseId !== knowledgeBaseId
    || current.sourceRevision.sourceFilePublicId !== current.sourceFile.publicId
    || current.sourceFile.currentRevisionPublicId !== current.sourceRevision.publicId
    || current.sourceFile.visibility !== "current"
  ) throw maintenanceSearchError("scope_conflict");
}

function describeBatch(documents: readonly StorageVnextSearchDocument[]) {
  const serialized = JSON.stringify(documents);
  return {
    payloadChecksum: createHash("sha256").update(serialized).digest("hex"),
    compressedBytes: gzipSync(Buffer.from(serialized, "utf8")).byteLength
  };
}

function stableMetadataText(
  metadata: StorageVnextStructuredMetadata
): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(metadata).sort(([left], [right]) => left.localeCompare(right))
  ));
}

function encodeCursor(cursor: SearchRebuildCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | null): SearchRebuildCursor | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      decoded?.version === 1
      && (decoded.stage === "source" || decoded.stage === "graph")
      && (decoded.cursor === null || typeof decoded.cursor === "string")
    ) return decoded as SearchRebuildCursor;
  } catch {
    // Mapped to one stable input error below.
  }
  throw maintenanceSearchError("invalid_cursor");
}

function validateLimits(limits: SearchRebuildLimits): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw maintenanceSearchError("invalid_configuration");
    }
  }
  if (limits.sourcePageSize > 1_000 || limits.graphPageSize > 1_000) {
    throw maintenanceSearchError("invalid_configuration");
  }
}

function validateRequest(request: {
  knowledgeBaseId: string;
  candidatePublicId: string;
  operationPublicId: string;
  batchOrdinal: number;
}): void {
  for (const value of [
    request.knowledgeBaseId,
    request.candidatePublicId,
    request.operationPublicId
  ]) {
    if (!value || Buffer.byteLength(value) > 255) {
      throw maintenanceSearchError("invalid_input");
    }
  }
  if (!Number.isSafeInteger(request.batchOrdinal) || request.batchOrdinal < 0) {
    throw maintenanceSearchError("invalid_input");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? maintenanceSearchError("aborted");
}

function maintenanceSearchError(code: string): Error {
  return Object.assign(new Error(`Storage vNext maintenance search error: ${code}`), {
    code
  });
}
