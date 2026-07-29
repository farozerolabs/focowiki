import type {
  SearchProjectionDocumentRepository
} from "../application/ports/search-projection-document-repository.js";
import type {
  SearchIndexKind,
  SearchProjectionStateRepository
} from "../application/ports/search-projection-state-repository.js";
import { partitionSearchDocuments } from "./indexing-batch.js";
import {
  createSearchDocumentWork,
  createSearchLifecycleWork
} from "./search-indexing-plan.js";

export type SearchProjectionCoordinationResult = {
  status: "compatibility" | "pending" | "ready" | "failed";
  epoch: number | null;
};

export async function ensureSearchProjectionWork(input: {
  states: SearchProjectionStateRepository;
  documents: SearchProjectionDocumentRepository;
  knowledgeBaseId: string;
  generationId: string;
  maintenanceRequestId: string | null;
  forceCompatibilityCutover: boolean;
  forceFullRebuild?: boolean;
  scanBatchSize: number;
  indexBatchDocumentCount: number;
  indexBatchCompressedBytes: number;
  maxAttempts: number;
  contract: {
    contentSchemaVersion: string;
    graphSchemaVersion: string;
    contentSettingsChecksum: string;
    graphSettingsChecksum: string;
  };
  now: string;
}): Promise<SearchProjectionCoordinationResult> {
  assertPositiveInteger(input.scanBatchSize, "Search projection scan batch size");
  const current = await input.states.getState(input.knowledgeBaseId);
  if (!current) return { status: "failed", epoch: null };
  if (
    current.routeState === "meilisearch"
    && input.forceFullRebuild !== true
    && !current.maintenanceRequired
    && current.activeGenerationId === input.generationId
    && current.contentSchemaVersion === input.contract.contentSchemaVersion
    && current.graphSchemaVersion === input.contract.graphSchemaVersion
    && current.contentSettingsChecksum === input.contract.contentSettingsChecksum
    && current.graphSettingsChecksum === input.contract.graphSettingsChecksum
  ) {
    return { status: "ready", epoch: current.activeEpoch };
  }
  if (
    current.routeState === "postgres_compatibility"
    && current.activeGenerationId !== null
    && !input.forceCompatibilityCutover
  ) {
    return { status: "compatibility", epoch: null };
  }

  const reservation = await input.states.reservePendingEpoch({
    knowledgeBaseId: input.knowledgeBaseId,
    generationId: input.generationId,
    maintenanceRequestId: input.maintenanceRequestId,
    ...(input.forceFullRebuild === undefined
      ? {}
      : { forceFullRebuild: input.forceFullRebuild }),
    contract: input.contract,
    reservedAt: input.now
  });
  if (reservation.outcome === "not_found") {
    return { status: "failed", epoch: null };
  }
  let reservationOutcome: "reserved" | "existing" = reservation.outcome === "busy"
    ? "existing"
    : reservation.outcome;
  let state = reservation.state;
  if (reservation.outcome === "busy") {
    const epoch = reservation.state.pendingEpoch;
    if (epoch === null) return { status: "failed", epoch: null };
    const progress = await input.states.getEpochProgress({
      knowledgeBaseId: input.knowledgeBaseId,
      epoch
    });
    if (!hasTerminalWork(progress)) {
      return { status: "pending", epoch };
    }
    const rebased = await input.states.rebaseFailedEpoch({
      knowledgeBaseId: input.knowledgeBaseId,
      generationId: input.generationId,
      maintenanceRequestId: input.maintenanceRequestId,
      epoch,
      maxAttempts: input.maxAttempts,
      contract: input.contract,
      rebasedAt: input.now
    });
    if (!rebased) return { status: "pending", epoch };
    state = rebased;
    reservationOutcome = "reserved";
  }
  const epoch = state.pendingEpoch;
  if (epoch === null || state.pendingGenerationId !== input.generationId) {
    return { status: "failed", epoch: null };
  }
  if (reservationOutcome === "existing") {
    const existingProgress = await input.states.getEpochProgress({
      knowledgeBaseId: input.knowledgeBaseId,
      epoch
    });
    if (
      existingProgress.failed > 0
      || existingProgress.canceled > 0
      || existingProgress.superseded > 0
    ) {
      const restarted = await input.states.restartFailedEpoch({
        knowledgeBaseId: input.knowledgeBaseId,
        generationId: input.generationId,
        maintenanceRequestId: input.maintenanceRequestId,
        epoch,
        resetAll: requiresAnyPhysicalReplacement(state, input.contract),
        maxAttempts: input.maxAttempts,
        contract: input.contract,
        restartedAt: input.now
      });
      if (!restarted) return { status: "failed", epoch };
    }
  }

  for (const indexKind of ["content", "graph"] as const) {
    await input.states.createWork([
      createSearchLifecycleWork({
        ...input,
        epoch
      }, indexKind, "prepare_index")
    ]);
    await planDocumentWork({
      ...input,
      state: {
        activeGenerationId: state.activeGenerationId,
        activeEpoch: state.activeEpoch,
        pendingEpoch: epoch,
        fullRebuild: requiresPhysicalReplacement(state, indexKind)
      },
      indexKind
    });
  }
  await input.states.createWork([
    createSearchLifecycleWork({ ...input, epoch }, "content", "validate"),
    createSearchLifecycleWork({ ...input, epoch }, "graph", "validate"),
    createSearchLifecycleWork({ ...input, epoch }, "content", "activate"),
    createSearchLifecycleWork({ ...input, epoch }, "content", "cleanup"),
    createSearchLifecycleWork({ ...input, epoch }, "graph", "cleanup")
  ]);

  const progress = await input.states.getEpochProgress({
    knowledgeBaseId: input.knowledgeBaseId,
    epoch
  });
  if (progress.failed > 0 || progress.canceled > 0) {
    return { status: "failed", epoch };
  }
  return {
    status: progress.activationReady ? "ready" : "pending",
    epoch
  };
}

export async function readSearchProjectionCoordinationStatus(input: {
  states: SearchProjectionStateRepository;
  knowledgeBaseId: string;
  generationId: string;
}): Promise<SearchProjectionCoordinationResult> {
  const state = await input.states.getState(input.knowledgeBaseId);
  if (!state) return { status: "failed", epoch: null };
  if (state.pendingEpoch === null) {
    return state.routeState === "postgres_compatibility"
      && state.activeGenerationId !== null
      ? { status: "compatibility", epoch: null }
      : { status: "pending", epoch: null };
  }
  if (state.pendingGenerationId !== input.generationId) {
    if (
      state.routeState === "postgres_compatibility"
      && state.activeGenerationId !== null
    ) {
      return { status: "compatibility", epoch: null };
    }
    return { status: "pending", epoch: state.pendingEpoch };
  }
  const progress = await input.states.getEpochProgress({
    knowledgeBaseId: input.knowledgeBaseId,
    epoch: state.pendingEpoch
  });
  if (
    progress.failed > 0
    || progress.canceled > 0
    || progress.superseded > 0
  ) {
    return { status: "failed", epoch: state.pendingEpoch };
  }
  return {
    status: progress.activationReady ? "ready" : "pending",
    epoch: state.pendingEpoch
  };
}

async function planDocumentWork(input: {
  states: SearchProjectionStateRepository;
  documents: SearchProjectionDocumentRepository;
  knowledgeBaseId: string;
  generationId: string;
  maintenanceRequestId: string | null;
  scanBatchSize: number;
  indexBatchDocumentCount: number;
  indexBatchCompressedBytes: number;
  maxAttempts: number;
  state: {
    activeGenerationId: string | null;
    activeEpoch: number;
    pendingEpoch: number;
    fullRebuild: boolean;
  };
  indexKind: SearchIndexKind;
}): Promise<void> {
  let cursor: string | null = null;
  let batchOrdinal = 0;
  do {
    const page = await input.documents.listRecords({
      knowledgeBaseId: input.knowledgeBaseId,
      generationId: input.generationId,
      activeGenerationId: input.state.activeGenerationId,
      activeEpoch: input.state.fullRebuild ? 0 : input.state.activeEpoch,
      pendingEpoch: input.state.pendingEpoch,
      indexKind: input.indexKind,
      cursor,
      limit: input.scanBatchSize
    });
    const recordByDocumentId = new Map(
      page.records.map((record) => [record.document.id, record])
    );
    const batches = partitionSearchDocuments({
      documents: page.records.map((record) => record.document),
      maxDocuments: input.indexBatchDocumentCount,
      maxCompressedBytes: input.indexBatchCompressedBytes
    });
    for (const batch of batches) {
      const recordKeys = batch.documents.map((document) => {
        const record = recordByDocumentId.get(document.id);
        if (!record) throw new Error("Search projection record is unavailable");
        return record.key;
      });
      await input.states.createWork([
        createSearchDocumentWork({
          knowledgeBaseId: input.knowledgeBaseId,
          generationId: input.generationId,
          maintenanceRequestId: input.maintenanceRequestId,
          epoch: input.state.pendingEpoch,
          maxAttempts: input.maxAttempts,
          indexKind: input.indexKind,
          batchOrdinal,
          recordKeys,
          documents: batch.documents
        })
      ]);
      batchOrdinal += 1;
    }
    if (page.nextCursor !== null && page.nextCursor === cursor) {
      throw new Error("Search projection scan cursor did not advance");
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
}

function requiresPhysicalReplacement(
  state: {
    activeEpoch: number;
    pendingFullRebuild: boolean;
    contentSchemaVersion: string | null;
    graphSchemaVersion: string | null;
    contentSettingsChecksum: string | null;
    graphSettingsChecksum: string | null;
    pendingContentSchemaVersion: string | null;
    pendingGraphSchemaVersion: string | null;
    pendingContentSettingsChecksum: string | null;
    pendingGraphSettingsChecksum: string | null;
  },
  indexKind: SearchIndexKind
): boolean {
  if (state.activeEpoch === 0 || state.pendingFullRebuild) return true;
  return indexKind === "content"
    ? state.contentSchemaVersion !== state.pendingContentSchemaVersion
      || state.contentSettingsChecksum !== state.pendingContentSettingsChecksum
    : state.graphSchemaVersion !== state.pendingGraphSchemaVersion
      || state.graphSettingsChecksum !== state.pendingGraphSettingsChecksum;
}

function requiresAnyPhysicalReplacement(
  state: {
    activeEpoch: number;
    pendingFullRebuild: boolean;
    contentSchemaVersion: string | null;
    graphSchemaVersion: string | null;
    contentSettingsChecksum: string | null;
    graphSettingsChecksum: string | null;
  },
  contract: {
    contentSchemaVersion: string;
    graphSchemaVersion: string;
    contentSettingsChecksum: string;
    graphSettingsChecksum: string;
  }
): boolean {
  return state.activeEpoch === 0
    || state.pendingFullRebuild
    || state.contentSchemaVersion !== contract.contentSchemaVersion
    || state.graphSchemaVersion !== contract.graphSchemaVersion
    || state.contentSettingsChecksum !== contract.contentSettingsChecksum
    || state.graphSettingsChecksum !== contract.graphSettingsChecksum;
}

function hasTerminalWork(progress: {
  failed: number;
  canceled: number;
  superseded: number;
}): boolean {
  return progress.failed > 0
    || progress.canceled > 0
    || progress.superseded > 0;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}
