import type {
  SearchProjectionDocumentRepository
} from "../application/ports/search-projection-document-repository.js";
import type {
  SearchProjectionStateRepository,
  SearchProjectionWork
} from "../application/ports/search-projection-state-repository.js";
import { partitionSearchDocuments } from "./indexing-batch.js";
import { createSearchDocumentWork } from "./search-indexing-plan.js";

export async function planSearchDocumentPage(input: {
  work: SearchProjectionWork;
  states: SearchProjectionStateRepository;
  documents: SearchProjectionDocumentRepository;
  activeGenerationId: string | null;
  activeEpoch: number;
  scanBatchSize: number;
  maxDocuments: number;
  maxCompressedBytes: number;
  now: string;
}): Promise<"continued" | "completed" | "lost"> {
  const generationId = requireGenerationId(input.work);
  const checkpoint = readPlanningCheckpoint(input.work);
  const page = await input.documents.listRecords({
    knowledgeBaseId: input.work.knowledgeBaseId,
    generationId,
    activeGenerationId: input.activeGenerationId,
    activeEpoch: input.activeEpoch,
    pendingEpoch: input.work.epoch,
    indexKind: input.work.indexKind,
    cursor: checkpoint.cursor,
    limit: input.scanBatchSize
  });
  if (page.nextCursor !== null && page.nextCursor === checkpoint.cursor) {
    throw new Error("Search projection planning cursor did not advance");
  }

  const recordByDocumentId = new Map(
    page.records.map((record) => [record.document.id, record])
  );
  const batches = partitionSearchDocuments({
    documents: page.records.map((record) => record.document),
    maxDocuments: input.maxDocuments,
    maxCompressedBytes: input.maxCompressedBytes
  });
  const work = batches.map((batch, index) => {
    const recordKeys = batch.documents.map((document) => {
      const record = recordByDocumentId.get(document.id);
      if (!record) throw new Error("Search projection record is unavailable");
      return record.key;
    });
    return createSearchDocumentWork({
      knowledgeBaseId: input.work.knowledgeBaseId,
      generationId,
      maintenanceRequestId: input.work.maintenanceRequestId,
      epoch: input.work.epoch,
      maxAttempts: input.work.maxAttempts,
      indexKind: input.work.indexKind,
      batchOrdinal: checkpoint.batchOrdinal + index,
      recordKeys,
      documents: batch.documents
    });
  });
  if (work.length > 0) await input.states.createWork(work);

  if (page.nextCursor === null) {
    const completed = await input.states.markSucceeded({
      work: input.work,
      completedAt: input.now
    });
    return completed ? "completed" : "lost";
  }
  const continued = await input.states.continuePlanning({
    work: input.work,
    checkpoint: {
      cursor: page.nextCursor,
      batchOrdinal: checkpoint.batchOrdinal + work.length
    },
    continuedAt: input.now
  });
  return continued ? "continued" : "lost";
}

function readPlanningCheckpoint(work: SearchProjectionWork): {
  cursor: string | null;
  batchOrdinal: number;
} {
  const cursor = work.checkpoint.cursor;
  const batchOrdinal = work.checkpoint.batchOrdinal;
  if (
    cursor !== undefined
    && (typeof cursor !== "string" || cursor.length === 0)
  ) {
    throw new Error("Search projection planning cursor is invalid");
  }
  if (
    batchOrdinal !== undefined
    && (!Number.isSafeInteger(batchOrdinal) || Number(batchOrdinal) < 0)
  ) {
    throw new Error("Search projection planning batch ordinal is invalid");
  }
  return {
    cursor: typeof cursor === "string" ? cursor : null,
    batchOrdinal: typeof batchOrdinal === "number" ? batchOrdinal : 0
  };
}

function requireGenerationId(work: SearchProjectionWork): string {
  if (!work.generationId) {
    throw new Error("Search projection generation is unavailable");
  }
  return work.generationId;
}
