import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { generatedPagePath } from "../../domain/source-path.js";
import type {
  StorageVnextCatalogReadPort,
  StorageVnextCurrentSourceFact
} from "../catalog/ports.js";
import type {
  StorageVnextSourceBodyReadPort
} from "../catalog/s3-source-body-store.js";
import type {
  StorageVnextGraphNodeFact,
  StorageVnextGraphReadPort
} from "../graph/ports.js";
import type { StorageVnextStructuredMetadata } from "../shared/types.js";
import {
  createStorageVnextContentDocument,
  createStorageVnextGraphSeedDocument,
  type StorageVnextSearchDocument
} from "./documents.js";
import { createOkfSearchSignals } from "./okf-signals.js";
import { segmentStorageVnextMarkdown } from "./markdown-segmentation.js";
import {
  createStorageVnextSearchDocumentSetAccumulator
} from "./document-set-checksum.js";
import {
  createStorageVnextCandidateQueryMatrix
} from "./candidate-query-matrix.js";
import { readStorageVnextGraphSeedProfile } from "./graph-seed-profile.js";
import type {
  StorageVnextSearchProjectionPort,
  StorageVnextSearchValidationCase
} from "./ports.js";

export type StorageVnextSearchCandidateBuildResult = {
  sourceCount: number;
  graphSeedCount: number;
  documentCount: number;
  batchCount: number;
  compressedBytes: number;
  documentChecksum: string;
  queryCases: readonly StorageVnextSearchValidationCase[];
};

export async function buildStorageVnextSearchCandidate(input: {
  knowledgeBaseId: string;
  candidatePublicId: string;
  operationPublicId: string;
  catalog: Pick<
    StorageVnextCatalogReadPort,
    "listCurrentSources" | "listSourceFilesByPublicIds"
  >;
  sourceBodies: StorageVnextSourceBodyReadPort;
  graph: Pick<StorageVnextGraphReadPort, "listNodes">;
  projection: Pick<StorageVnextSearchProjectionPort, "writeDocumentBatch">;
  sourcePageSize: number;
  graphPageSize: number;
  sourceReadConcurrency: number;
  maxInFlightSourceBytes: number;
  maxSourceBytes: number;
  maxSegmentBytes: number;
  maxBatchDocuments: number;
  maxBatchCompressedBytes: number;
  resumeFromBatchOrdinal?: number;
  signal?: AbortSignal;
}): Promise<StorageVnextSearchCandidateBuildResult> {
  assertIdentifier(input.knowledgeBaseId, "Knowledge base");
  assertIdentifier(input.candidatePublicId, "Candidate");
  assertIdentifier(input.operationPublicId, "Operation");
  assertPositiveInteger(input.sourcePageSize, "Source page size", 1_000);
  assertPositiveInteger(input.graphPageSize, "Graph page size", 1_000);
  assertPositiveInteger(input.sourceReadConcurrency, "Source read concurrency", 32);
  assertPositiveInteger(input.maxInFlightSourceBytes, "In-flight source byte limit");
  assertPositiveInteger(input.maxSourceBytes, "Source byte limit");
  assertPositiveInteger(input.maxSegmentBytes, "Segment byte limit");
  assertPositiveInteger(input.maxBatchDocuments, "Search batch document limit");
  assertPositiveInteger(input.maxBatchCompressedBytes, "Search batch byte limit");
  const resumeFromBatchOrdinal = input.resumeFromBatchOrdinal ?? 0;
  assertNonnegativeInteger(
    resumeFromBatchOrdinal,
    "Search candidate resume ordinal"
  );

  const result: StorageVnextSearchCandidateBuildResult = {
    sourceCount: 0,
    graphSeedCount: 0,
    documentCount: 0,
    batchCount: 0,
    compressedBytes: 0,
    documentChecksum: "",
    queryCases: []
  };
  const documentChecksum = createStorageVnextSearchDocumentSetAccumulator();
  const queryMatrix = createStorageVnextCandidateQueryMatrix();
  let documents: StorageVnextSearchDocument[] = [];

  const writeBatch = async (
    batchDocuments: StorageVnextSearchDocument[],
    batch: ReturnType<typeof describeBatch>
  ): Promise<void> => {
    if (result.batchCount >= resumeFromBatchOrdinal) {
      await input.projection.writeDocumentBatch({
        candidatePublicId: input.candidatePublicId,
        operationPublicId: input.operationPublicId,
        batchOrdinal: result.batchCount,
        payloadChecksum: batch.payloadChecksum,
        compressedBytes: batch.compressedBytes,
        documents: batchDocuments
      });
    }
    result.batchCount += 1;
    result.compressedBytes += batch.compressedBytes;
  };

  const flush = async (force: boolean): Promise<void> => {
    while (documents.length > 0) {
      const batch = describeBatch(documents);
      if (batch.compressedBytes <= input.maxBatchCompressedBytes) {
        if (!force && documents.length < input.maxBatchDocuments) return;
        const completeBatch = documents;
        documents = [];
        await writeBatch(completeBatch, batch);
        return;
      }
      const prefix = findLargestCompressedPrefix(
        documents,
        input.maxBatchCompressedBytes
      );
      if (!prefix) {
        throw new Error(
          `Search document ${documents[0]!.id} exceeds the compressed byte budget`
        );
      }
      const completeBatch = documents.slice(0, prefix.length);
      documents = documents.slice(prefix.length);
      await writeBatch(completeBatch, prefix.batch);
      if (!force && documents.length < input.maxBatchDocuments) return;
    }
  };

  for await (const document of iterateCandidateDocuments(input, result)) {
    throwIfAborted(input.signal);
    if (documents.length >= input.maxBatchDocuments) await flush(false);
    documents.push(document);
    documentChecksum.add(document);
    queryMatrix.observe(document);
    result.documentCount += 1;
  }
  await flush(true);
  if (resumeFromBatchOrdinal > result.batchCount) {
    throw new Error(
      "Search candidate resume ordinal exceeds deterministic batch count"
    );
  }
  result.documentChecksum = documentChecksum.digest();
  result.queryCases = queryMatrix.finish();
  return result;
}

async function* iterateCandidateDocuments(
  input: {
    knowledgeBaseId: string;
    catalog: Pick<
      StorageVnextCatalogReadPort,
      "listCurrentSources" | "listSourceFilesByPublicIds"
    >;
    sourceBodies: StorageVnextSourceBodyReadPort;
    graph: Pick<StorageVnextGraphReadPort, "listNodes">;
    sourcePageSize: number;
    graphPageSize: number;
    sourceReadConcurrency: number;
    maxInFlightSourceBytes: number;
    maxSourceBytes: number;
    maxSegmentBytes: number;
    signal?: AbortSignal;
  },
  result: StorageVnextSearchCandidateBuildResult
): AsyncGenerator<StorageVnextSearchDocument> {
  let sourceCursor: string | null = null;
  do {
    throwIfAborted(input.signal);
    const page = await input.catalog.listCurrentSources({
      knowledgeBaseId: input.knowledgeBaseId,
      limit: input.sourcePageSize,
      cursor: sourceCursor
    });
    for (const group of sourceReadGroups(
      page.items,
      input.sourceReadConcurrency,
      input.maxInFlightSourceBytes
    )) {
      const documentGroups = await Promise.all(group.map((current) =>
        readCurrentSourceDocuments(input, current)
      ));
      for (const sourceDocuments of documentGroups) {
        for (const document of sourceDocuments) yield document;
        result.sourceCount += 1;
      }
    }
    sourceCursor = nextCursor(sourceCursor, page.nextCursor, "source");
  } while (sourceCursor !== null);

  let graphCursor: string | null = null;
  do {
    throwIfAborted(input.signal);
    const page = await input.graph.listNodes({
      knowledgeBaseId: input.knowledgeBaseId,
      limit: input.graphPageSize,
      cursor: graphCursor
    });
    const sourceFiles = page.items.length === 0
      ? []
      : await input.catalog.listSourceFilesByPublicIds({
          knowledgeBaseId: input.knowledgeBaseId,
          publicIds: [...new Set(page.items.map((node) => node.sourceFilePublicId))],
          limit: page.items.length
        });
    const sourceFilesByPublicId = new Map(
      sourceFiles.map((sourceFile) => [sourceFile.publicId, sourceFile])
    );
    for (const node of page.items) {
      assertCurrentGraphNode(input.knowledgeBaseId, node);
      const sourceFile = sourceFilesByPublicId.get(node.sourceFilePublicId);
      if (!sourceFile) throw new Error("Current graph seed source is unavailable");
      assertCurrentGraphSource(node, sourceFile);
      const profile = readStorageVnextGraphSeedProfile(node);
      yield createStorageVnextGraphSeedDocument({
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFilePublicId: node.sourceFilePublicId,
        sourceRevisionPublicId: node.sourceRevisionPublicId,
        logicalPath: node.logicalPath,
        title: node.label,
        searchText: profile.searchText,
        rankingTerms: profile.rankingTerms,
        okfSignals: createOkfSearchSignals(sourceFile.metadata)
      });
      result.graphSeedCount += 1;
    }
    graphCursor = nextCursor(graphCursor, page.nextCursor, "graph");
  } while (graphCursor !== null);
}

async function readCurrentSourceDocuments(
  input: {
    knowledgeBaseId: string;
    sourceBodies: StorageVnextSourceBodyReadPort;
    maxSourceBytes: number;
    maxSegmentBytes: number;
    signal?: AbortSignal;
  },
  current: StorageVnextCurrentSourceFact
): Promise<StorageVnextSearchDocument[]> {
  assertCurrentSource(input.knowledgeBaseId, current);
  const logicalPath = generatedPagePath(current.sourceFile.logicalPath);
  const okfSignals = createOkfSearchSignals(current.sourceFile.metadata);
  const documents: StorageVnextSearchDocument[] = [
    createStorageVnextContentDocument({
      knowledgeBaseId: input.knowledgeBaseId,
      sourceFilePublicId: current.sourceFile.publicId,
      sourceRevisionPublicId: current.sourceRevision.publicId,
      logicalPath,
      fileKind: "page",
      title: current.sourceFile.title,
      contentKind: "file",
      segmentOrdinal: null,
      headingAncestors: [],
      searchText: stableMetadataText(current.sourceFile.metadata),
      okfSignals
    })
  ];
  const chunks = await input.sourceBodies.readVerifiedStream({
    objectId: current.sourceRevision.objectId,
    checksum: current.sourceRevision.checksum,
    byteCount: current.sourceRevision.byteCount,
    contentType: current.sourceRevision.contentType,
    maxBytes: input.maxSourceBytes,
    ...(input.signal ? { signal: input.signal } : {})
  });
  for await (const segment of segmentStorageVnextMarkdown({
    chunks,
    maxSegmentBytes: input.maxSegmentBytes,
    sourceRevisionPublicId: current.sourceRevision.publicId
  })) {
    throwIfAborted(input.signal);
    documents.push(createStorageVnextContentDocument({
      knowledgeBaseId: input.knowledgeBaseId,
      sourceFilePublicId: current.sourceFile.publicId,
      sourceRevisionPublicId: current.sourceRevision.publicId,
      logicalPath,
      fileKind: "page",
      title: current.sourceFile.title,
      contentKind: "segment",
      segmentOrdinal: segment.ordinal,
      headingAncestors: segment.headingAncestors,
      searchText: segment.searchText,
      okfSignals
    }));
  }
  return documents;
}

function sourceReadGroups(
  items: readonly StorageVnextCurrentSourceFact[],
  concurrency: number,
  maximumBytes: number
): StorageVnextCurrentSourceFact[][] {
  const groups: StorageVnextCurrentSourceFact[][] = [];
  let group: StorageVnextCurrentSourceFact[] = [];
  let bytes = 0;
  for (const current of items) {
    const sourceBytes = current.sourceRevision.byteCount;
    if (sourceBytes > maximumBytes) {
      throw new Error("Current search source exceeds the in-flight byte budget");
    }
    if (group.length >= concurrency || (group.length > 0 && bytes + sourceBytes > maximumBytes)) {
      groups.push(group);
      group = [];
      bytes = 0;
    }
    group.push(current);
    bytes += sourceBytes;
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

function describeBatch(documents: readonly StorageVnextSearchDocument[]): {
  payloadChecksum: string;
  compressedBytes: number;
} {
  const serialized = JSON.stringify(documents);
  return {
    payloadChecksum: createHash("sha256").update(serialized).digest("hex"),
    compressedBytes: gzipSync(Buffer.from(serialized, "utf8")).byteLength
  };
}

function findLargestCompressedPrefix(
  documents: readonly StorageVnextSearchDocument[],
  maximumCompressedBytes: number
): { length: number; batch: ReturnType<typeof describeBatch> } | null {
  let lower = 1;
  let upper = documents.length;
  let best: { length: number; batch: ReturnType<typeof describeBatch> } | null = null;
  while (lower <= upper) {
    const length = Math.floor((lower + upper) / 2);
    const batch = describeBatch(documents.slice(0, length));
    if (batch.compressedBytes <= maximumCompressedBytes) {
      best = { length, batch };
      lower = length + 1;
    } else {
      upper = length - 1;
    }
  }
  return best;
}

function stableMetadataText(
  metadata: StorageVnextStructuredMetadata
): string {
  const lines: string[] = [];
  for (const key of ["type", "title", "description", "tags"] as const) {
    appendSearchableMetadataValue(lines, key, metadata[key]);
  }
  return lines.join("\n");
}

function appendSearchableMetadataValue(
  lines: string[],
  key: string,
  value: StorageVnextStructuredMetadata[string] | undefined
): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) appendSearchableMetadataValue(lines, key, item);
    return;
  }
  if (typeof value === "object") return;
  const text = typeof value === "string"
    ? value.trim().replace(/\s+/gu, " ")
    : String(value);
  if (!text) return;
  lines.push(`${key}: ${text}`);
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
  ) {
    throw new Error("Current search source fact is inconsistent");
  }
}

function assertCurrentGraphNode(
  knowledgeBaseId: string,
  node: StorageVnextGraphNodeFact
): void {
  if (node.knowledgeBaseId !== knowledgeBaseId) {
    throw new Error("Current graph seed fact is outside the search scope");
  }
}

function assertCurrentGraphSource(
  node: StorageVnextGraphNodeFact,
  sourceFile: StorageVnextCurrentSourceFact["sourceFile"]
): void {
  if (
    sourceFile.knowledgeBaseId !== node.knowledgeBaseId
    || sourceFile.publicId !== node.sourceFilePublicId
    || sourceFile.currentRevisionPublicId !== node.sourceRevisionPublicId
    || sourceFile.visibility !== "current"
    || generatedPagePath(sourceFile.logicalPath) !== node.logicalPath
  ) {
    throw new Error("Current graph seed source fact is inconsistent");
  }
}

function nextCursor(
  previous: string | null,
  next: string | null,
  kind: string
): string | null {
  if (next !== null && next === previous) {
    throw new Error(`Storage vNext ${kind} cursor did not advance`);
  }
  return next;
}

function assertIdentifier(value: string, label: string): void {
  if (!value || value.trim() !== value) throw new Error(`${label} identity is invalid`);
}

function assertPositiveInteger(value: number, label: string, maximum?: number): void {
  if (
    !Number.isSafeInteger(value)
    || value < 1
    || (maximum !== undefined && value > maximum)
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function assertNonnegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid`);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Search candidate build aborted");
}
