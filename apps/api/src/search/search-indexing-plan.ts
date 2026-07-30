import { createHash } from "node:crypto";
import type {
  SearchEngineDocument
} from "../application/ports/search-engine-transport.js";
import type {
  SearchIndexKind,
  SearchProjectionWorkDraft,
  SearchWorkKind
} from "../application/ports/search-projection-state-repository.js";
import { partitionSearchDocuments } from "./indexing-batch.js";

const CHECKPOINT_BYTE_LIMIT = 65_536;

type SearchWorkIdentityInput = {
  knowledgeBaseId: string;
  generationId: string;
  maintenanceRequestId: string | null;
  epoch: number;
  maxAttempts: number;
};

export function createSearchLifecycleWork(
  input: SearchWorkIdentityInput,
  indexKind: SearchIndexKind,
  workKind: Exclude<SearchWorkKind, "documents" | "delete_documents">
): SearchProjectionWorkDraft {
  assertWorkIdentity(input);
  const payloadChecksum = hash(stableJson({
    knowledgeBaseId: input.knowledgeBaseId,
    generationId: input.generationId,
    epoch: input.epoch,
    indexKind,
    workKind
  }));
  return createWork(input, {
    indexKind,
    workKind,
    batchOrdinal: 0,
    payloadChecksum,
    documentCount: 0,
    compressedBytes: 0,
    checkpoint: {}
  });
}

export function createSearchDocumentWork(input: SearchWorkIdentityInput & {
  indexKind: SearchIndexKind;
  batchOrdinal: number;
  recordKeys: string[];
  documents: SearchEngineDocument[];
}): SearchProjectionWorkDraft {
  assertWorkIdentity(input);
  const checkpoint = { recordKeys: input.recordKeys };
  assertCheckpointBound(checkpoint);
  const [batch] = partitionSearchDocuments({
    documents: input.documents,
    maxDocuments: Math.max(1, input.documents.length),
    maxCompressedBytes: Number.MAX_SAFE_INTEGER
  });
  if (!batch || batch.documents.length !== input.recordKeys.length) {
    throw new Error("Search work record and document counts are inconsistent");
  }
  return createWork(input, {
    indexKind: input.indexKind,
    workKind: "documents",
    batchOrdinal: input.batchOrdinal,
    payloadChecksum: batch.checksum,
    documentCount: batch.documents.length,
    compressedBytes: batch.compressedBytes,
    checkpoint
  });
}

function createWork(
  input: SearchWorkIdentityInput,
  work: Pick<
    SearchProjectionWorkDraft,
    | "indexKind"
    | "workKind"
    | "batchOrdinal"
    | "payloadChecksum"
    | "documentCount"
    | "compressedBytes"
  > & { checkpoint: Record<string, unknown> }
): SearchProjectionWorkDraft {
  const identity = hash(stableJson({
    knowledgeBaseId: input.knowledgeBaseId,
    generationId: input.generationId,
    epoch: input.epoch,
    indexKind: work.indexKind,
    workKind: work.workKind,
    batchOrdinal: work.batchOrdinal,
    payloadChecksum: work.payloadChecksum
  }));
  const id = `search-work-${identity.slice(0, 40)}`;
  return {
    id,
    knowledgeBaseId: input.knowledgeBaseId,
    epoch: input.epoch,
    generationId: input.generationId,
    maintenanceRequestId: input.maintenanceRequestId,
    indexKind: work.indexKind,
    workKind: work.workKind,
    batchOrdinal: work.batchOrdinal,
    payloadChecksum: work.payloadChecksum,
    documentCount: work.documentCount,
    compressedBytes: work.compressedBytes,
    taskCorrelation: id,
    checkpoint: work.checkpoint,
    maxAttempts: input.maxAttempts
  };
}

function assertCheckpointBound(checkpoint: Record<string, unknown>): void {
  if (Buffer.byteLength(JSON.stringify(checkpoint), "utf8") > CHECKPOINT_BYTE_LIMIT) {
    throw new Error("Search work checkpoint exceeds the durable byte limit");
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertWorkIdentity(input: SearchWorkIdentityInput): void {
  assertPositiveInteger(input.epoch, "Search epoch");
  assertPositiveInteger(input.maxAttempts, "Search work retry limit");
}
