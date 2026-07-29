import type {
  SearchEngineTransport
} from "../application/ports/search-engine-transport.js";
import type {
  SearchProjectionDocumentRepository
} from "../application/ports/search-projection-document-repository.js";
import type {
  KnowledgeBaseSearchState,
  SearchProjectionStateRepository,
  SearchProjectionWork
} from "../application/ports/search-projection-state-repository.js";
import {
  createSearchIndexDefinition
} from "./index-definitions.js";
import {
  createSearchIndexManager
} from "./search-index-manager.js";
import {
  processSearchIndexingWork,
  type SearchIndexingFailureEvent,
  type SearchIndexingWorkOutcome
} from "./search-indexing-worker.js";

export type SearchIndexingRuntimeSettings = {
  engineSearchCutoffMs: number;
  taskPollIntervalMs: number;
  taskTimeoutMs: number;
  retryDelayMs: number;
  maxDocumentCount: number;
  maxCompressedBytes: number;
  engineQueueLatencyLimitMs: number;
  engineResidentMemoryLimitBytes: number;
  engineDatabaseSizeLimitBytes: number;
  engineTaskQueueSizeLimitBytes: number;
};

export type SearchIndexingPressureReason =
  | "queue_latency"
  | "resident_memory"
  | "database_size"
  | "task_queue_size"
  | "pressure_unavailable";

export type SearchIndexingCycleResult = {
  claimed: number;
  submitted: number;
  processing: number;
  succeeded: number;
  retried: number;
  failed: number;
  lost: number;
  submissionPaused: boolean;
  pressureReasons: SearchIndexingPressureReason[];
};

export async function runSearchIndexingCycle(input: {
  workerId: string;
  leaseTokenPrefix: string;
  states: SearchProjectionStateRepository;
  documents: SearchProjectionDocumentRepository;
  transport: SearchEngineTransport;
  indexPrefix: string;
  settings: SearchIndexingRuntimeSettings & {
    maxInFlightTasks: number;
  };
  leaseDurationMs: number;
  now?: () => Date;
  onFailure?: (
    event: SearchIndexingFailureEvent,
    error?: unknown
  ) => void;
}): Promise<SearchIndexingCycleResult> {
  const pressureReasons = await readPressureReasons(
    input.transport,
    input.settings
  );
  const submissionPaused = pressureReasons.length > 0;
  const claimedAt = input.now?.() ?? new Date();
  const work = await input.states.claimWork({
    workerId: input.workerId,
    leaseTokenPrefix: input.leaseTokenPrefix,
    limit: input.settings.maxInFlightTasks,
    maxInFlightTasks: input.settings.maxInFlightTasks,
    allowNewSubmissions: !submissionPaused,
    now: claimedAt.toISOString(),
    leaseExpiresAt: new Date(
      claimedAt.getTime() + input.leaseDurationMs
    ).toISOString()
  });
  const outcomes = await Promise.all(work.map((item) =>
    processClaimedSearchWork({
      work: item,
      states: input.states,
      documents: input.documents,
      transport: input.transport,
      indexPrefix: input.indexPrefix,
      settings: input.settings,
      leaseDurationMs: input.leaseDurationMs,
      ...(input.onFailure ? { onFailure: input.onFailure } : {}),
      ...(input.now ? { now: input.now } : {})
    })
  ));
  return {
    claimed: work.length,
    submitted: count(outcomes, "submitted"),
    processing: count(outcomes, "processing"),
    succeeded: count(outcomes, "succeeded"),
    retried: count(outcomes, "retry"),
    failed: count(outcomes, "failed"),
    lost: count(outcomes, "lost"),
    submissionPaused,
    pressureReasons
  };
}

async function readPressureReasons(
  transport: SearchEngineTransport,
  settings: SearchIndexingRuntimeSettings
): Promise<SearchIndexingPressureReason[]> {
  try {
    const pressure = await transport.getPressure();
    const reasons: SearchIndexingPressureReason[] = [];
    if (pressure.queueLatencyMs > settings.engineQueueLatencyLimitMs) {
      reasons.push("queue_latency");
    }
    if (pressure.residentMemoryBytes > settings.engineResidentMemoryLimitBytes) {
      reasons.push("resident_memory");
    }
    if (pressure.databaseSizeBytes > settings.engineDatabaseSizeLimitBytes) {
      reasons.push("database_size");
    }
    if (pressure.taskQueueSizeBytes > settings.engineTaskQueueSizeLimitBytes) {
      reasons.push("task_queue_size");
    }
    return reasons;
  } catch {
    return ["pressure_unavailable"];
  }
}

export async function processClaimedSearchWork(input: {
  work: SearchProjectionWork;
  states: SearchProjectionStateRepository;
  documents: SearchProjectionDocumentRepository;
  transport: SearchEngineTransport;
  indexPrefix: string;
  settings: SearchIndexingRuntimeSettings;
  leaseDurationMs: number;
  now?: () => Date;
  onFailure?: (
    event: SearchIndexingFailureEvent,
    error?: unknown
  ) => void;
}): Promise<SearchIndexingWorkOutcome> {
  const state = await requireCurrentState(input.states, input.work);
  if (
    input.work.workKind === "activate"
    && isActivatedWork(state, input.work)
  ) {
    const persisted = await input.states.markSucceeded({
      work: input.work,
      completedAt: (input.now?.() ?? new Date()).toISOString()
    });
    return persisted ? "succeeded" : "lost";
  }
  const definition = createSearchIndexDefinition({
    indexPrefix: input.indexPrefix,
    knowledgeBaseId: input.work.knowledgeBaseId,
    kind: input.work.indexKind,
    pendingEpoch: input.work.epoch,
    searchCutoffMs: input.settings.engineSearchCutoffMs
  });
  const manager = createSearchIndexManager({
    transport: input.transport,
    pollIntervalMs: input.settings.taskPollIntervalMs,
    taskTimeoutMs: input.settings.taskTimeoutMs
  });
  const replacementRequired = requiresPhysicalReplacement(
    state,
    input.work.indexKind
  );
  const targetIndexUid = replacementRequired
    ? definition.stagingUid
    : definition.activeUid;

  return processSearchIndexingWork({
    work: input.work,
    repository: input.states,
    transport: input.transport,
    resolveIndexUid: () => targetIndexUid,
    loadDocuments: async (work) => {
      const recordKeys = readRecordKeys(work);
      const records = await input.documents.loadRecords({
        knowledgeBaseId: work.knowledgeBaseId,
        generationId: requireGenerationId(work),
        activeGenerationId: state.activeGenerationId,
        activeEpoch: replacementRequired ? 0 : state.activeEpoch,
        pendingEpoch: work.epoch,
        indexKind: work.indexKind,
        recordKeys
      });
      return records.map((record) => record.document);
    },
    lifecycle: {
      async prepareIndex() {
        assertSettingsChecksum(state, input.work, definition.settingsChecksum);
        if (replacementRequired) {
          await manager.prepareStagingIndex({
            indexUid: definition.stagingUid,
            primaryKey: definition.primaryKey,
            settings: definition.settings,
            settingsChecksum: definition.settingsChecksum,
            buildId: buildId(definition.stagingUid, input.work)
          });
          return;
        }
        await manager.assertActiveIndex({
          indexUid: definition.activeUid,
          primaryKey: definition.primaryKey,
          settingsChecksum: definition.settingsChecksum
        });
      },
      async validateIndex() {
        const health = await input.transport.health();
        if (!health.available) throw runtimeError(
          "SEARCH_INDEX_VALIDATION_FAILED",
          "Search index validation could not complete"
        );
        const index = await input.transport.getIndex({
          indexUid: targetIndexUid
        });
        if (!index || index.primaryKey !== definition.primaryKey) {
          throw runtimeError(
            "SEARCH_INDEX_VALIDATION_FAILED",
            "Search index validation could not complete"
          );
        }
        const settings = await input.transport.getSettings(targetIndexUid);
        const checksum = manager.settingsChecksum(settings);
        assertSettingsChecksum(state, input.work, checksum);
        await input.transport.search({
          indexUid: targetIndexUid,
          query: "",
          filter: visibilityFilter(input.work, state),
          limit: 1,
          attributesToRetrieve: ["id", "sourceFileId", "sourceRevisionId"],
          attributesToCrop: [],
          cropLength: 1,
          matchingStrategy: "all",
          distinct: "sourceFileId"
        });
      },
      async activateIndex() {
        const activationStartedAt = (input.now?.() ?? new Date()).toISOString();
        const activationStarted = await input.states.beginActivation({
          knowledgeBaseId: input.work.knowledgeBaseId,
          generationId: requireGenerationId(input.work),
          epoch: input.work.epoch,
          startedAt: activationStartedAt
        });
        if (!activationStarted) {
          throw runtimeError(
            "SEARCH_EPOCH_ACTIVATION_BUSY",
            "Search activation is waiting for completed indexing work"
          );
        }
        const activations = searchIndexActivations(input, state);
        if (activations.length > 0) {
          const task = await manager.submitStagingIndexActivation(activations);
          if (task) return task;
          await manager.assertStagingIndexesActivated(activations);
        }
        await activateMaintenanceEpoch(input, state);
      },
      async completeSubmittedTask(work) {
        if (work.workKind !== "activate") return;
        const activations = searchIndexActivations(input, state);
        await manager.assertStagingIndexesActivated(activations);
        await activateMaintenanceEpoch(input, state);
      },
      async cleanupIndex() {
        const current = await input.states.getState(input.work.knowledgeBaseId);
        if (!current) {
          throw runtimeError(
            "SEARCH_CLEANUP_PENDING",
            "Search cleanup is waiting for activation"
          );
        }
        if (current.activeEpoch < input.work.epoch) {
          const progress = await input.states.getEpochProgress({
            knowledgeBaseId: input.work.knowledgeBaseId,
            epoch: input.work.epoch
          });
          if (
            progress.failed === 0
            && progress.canceled === 0
            && progress.superseded === 0
          ) {
            throw runtimeError(
              "SEARCH_CLEANUP_PENDING",
              "Search cleanup is waiting for activation"
            );
          }
          if (replacementRequired) {
            await manager.deleteIndexIfPresent(definition.stagingUid);
          }
          return;
        }
        const staging = await input.transport.getIndex({
          indexUid: definition.stagingUid
        });
        if (staging) {
          await manager.deleteIndexIfPresent(definition.stagingUid);
          return;
        }
        const task = await input.transport.deleteDocuments({
          indexUid: definition.activeUid,
          filter: [
            `knowledgeBaseId = ${JSON.stringify(input.work.knowledgeBaseId)}`,
            `visibleUntilEpoch <= ${input.work.epoch}`
          ].join(" AND "),
          correlation: input.work.taskCorrelation
        });
        await manager.waitForTask(task.taskUid);
      }
    },
    ...(input.now ? { now: input.now } : {}),
    leaseDurationMs: input.leaseDurationMs,
    retryDelayMs: input.settings.retryDelayMs,
    maxDocumentCount: input.settings.maxDocumentCount,
    maxCompressedBytes: input.settings.maxCompressedBytes,
    ...(input.onFailure ? { onFailure: input.onFailure } : {})
  });
}

function searchIndexActivations(
  input: {
    work: SearchProjectionWork;
    indexPrefix: string;
    settings: SearchIndexingRuntimeSettings;
  },
  state: KnowledgeBaseSearchState
) {
  return (["content", "graph"] as const).flatMap((kind) => {
    if (!requiresPhysicalReplacement(state, kind)) return [];
    const target = createSearchIndexDefinition({
      indexPrefix: input.indexPrefix,
      knowledgeBaseId: input.work.knowledgeBaseId,
      kind,
      pendingEpoch: input.work.epoch,
      searchCutoffMs: input.settings.engineSearchCutoffMs
    });
    return [{
      activeUid: target.activeUid,
      stagingUid: target.stagingUid,
      primaryKey: target.primaryKey,
      buildId: buildId(target.stagingUid, input.work)
    }];
  });
}

async function activateMaintenanceEpoch(
  input: {
    work: SearchProjectionWork;
    states: SearchProjectionStateRepository;
    now?: () => Date;
  },
  state: KnowledgeBaseSearchState
): Promise<void> {
  if (!input.work.maintenanceRequestId) return;
  const activated = await input.states.activateEpoch({
    knowledgeBaseId: input.work.knowledgeBaseId,
    generationId: requireGenerationId(input.work),
    epoch: input.work.epoch,
    contentSchemaVersion: requireString(
      state.pendingContentSchemaVersion,
      "Pending content search schema is unavailable"
    ),
    graphSchemaVersion: requireString(
      state.pendingGraphSchemaVersion,
      "Pending graph search schema is unavailable"
    ),
    contentSettingsChecksum: requireString(
      state.pendingContentSettingsChecksum,
      "Pending content search settings are unavailable"
    ),
    graphSettingsChecksum: requireString(
      state.pendingGraphSettingsChecksum,
      "Pending graph search settings are unavailable"
    ),
    activatedAt: (input.now?.() ?? new Date()).toISOString()
  });
  if (!activated) {
    throw runtimeError(
      "SEARCH_EPOCH_ACTIVATION_BUSY",
      "Search activation is waiting for completed indexing work"
    );
  }
}

function requiresPhysicalReplacement(
  state: KnowledgeBaseSearchState,
  indexKind: "content" | "graph"
): boolean {
  if (state.activeEpoch === 0 || state.pendingFullRebuild) return true;
  return indexKind === "content"
    ? state.contentSchemaVersion !== state.pendingContentSchemaVersion
      || state.contentSettingsChecksum !== state.pendingContentSettingsChecksum
    : state.graphSchemaVersion !== state.pendingGraphSchemaVersion
      || state.graphSettingsChecksum !== state.pendingGraphSettingsChecksum;
}

function buildId(
  stagingUid: string,
  work: SearchProjectionWork
): string {
  return `${stagingUid}:${requireGenerationId(work)}`;
}

async function requireCurrentState(
  states: SearchProjectionStateRepository,
  work: SearchProjectionWork
): Promise<KnowledgeBaseSearchState> {
  const state = await states.getState(work.knowledgeBaseId);
  const pending = state
    && state.pendingEpoch === work.epoch
    && state.pendingGenerationId === work.generationId;
  const activated = state && isActivatedWork(state, work);
  if (!state || (!pending && !activated)) {
    throw runtimeError(
      "SEARCH_INDEX_WORK_SUPERSEDED",
      "Search indexing work is no longer current"
    );
  }
  return state;
}

function isActivatedWork(
  state: KnowledgeBaseSearchState,
  work: SearchProjectionWork
): boolean {
  return (
    (work.workKind === "activate" || work.workKind === "cleanup")
    && state.activeEpoch >= work.epoch
    && state.activeGenerationId === work.generationId
  );
}

function assertSettingsChecksum(
  state: KnowledgeBaseSearchState,
  work: SearchProjectionWork,
  actual: string
): void {
  const expected = work.indexKind === "content"
    ? state.pendingContentSettingsChecksum
    : state.pendingGraphSettingsChecksum;
  if (!expected || expected !== actual) {
    throw runtimeError(
      "SEARCH_INDEX_INCOMPATIBLE",
      "Search index settings are incompatible"
    );
  }
}

function readRecordKeys(work: SearchProjectionWork): string[] {
  const value = work.checkpoint.recordKeys;
  if (
    !Array.isArray(value)
    || value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw runtimeError(
      "SEARCH_INDEX_CHECKPOINT_INVALID",
      "Search indexing checkpoint is invalid"
    );
  }
  return value;
}

function requireGenerationId(work: SearchProjectionWork): string {
  return requireString(work.generationId, "Search generation is unavailable");
}

function requireString(value: string | null, message: string): string {
  if (!value) throw runtimeError("SEARCH_INDEX_STATE_INVALID", message);
  return value;
}

function visibilityFilter(
  work: SearchProjectionWork,
  state: KnowledgeBaseSearchState
): string {
  const schemaVersion = work.indexKind === "content"
    ? state.pendingContentSchemaVersion
    : state.pendingGraphSchemaVersion;
  return [
    `knowledgeBaseId = ${JSON.stringify(work.knowledgeBaseId)}`,
    `visibleFromEpoch <= ${work.epoch}`,
    `(visibleUntilEpoch IS NULL OR visibleUntilEpoch > ${work.epoch})`,
    `schemaVersion = ${JSON.stringify(requireString(
      schemaVersion,
      "Pending search schema is unavailable"
    ))}`
  ].join(" AND ");
}

function runtimeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function count(
  outcomes: SearchIndexingWorkOutcome[],
  outcome: SearchIndexingWorkOutcome
): number {
  return outcomes.filter((item) => item === outcome).length;
}
