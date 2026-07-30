import type {
  SearchProjectionStateRepository
} from "../application/ports/search-projection-state-repository.js";
import {
  createSearchLifecycleWork
} from "./search-indexing-plan.js";

export type SearchProjectionCoordinationResult = {
  status: "compatibility" | "pending" | "ready" | "failed";
  epoch: number | null;
};

export async function ensureSearchProjectionWork(input: {
  states: SearchProjectionStateRepository;
  knowledgeBaseId: string;
  generationId: string;
  maintenanceRequestId: string | null;
  forceCompatibilityCutover: boolean;
  forceFullRebuild?: boolean;
  maxAttempts: number;
  contract: {
    contentSchemaVersion: string;
    graphSchemaVersion: string;
    contentSettingsChecksum: string;
    graphSettingsChecksum: string;
  };
  now: string;
}): Promise<SearchProjectionCoordinationResult> {
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
    if (!rebased) {
      const failedGenerationId = reservation.state.pendingGenerationId;
      if (failedGenerationId) {
        await ensureFailedEpochCleanup({
          ...input,
          generationId: failedGenerationId,
          epoch
        });
      }
      return { status: "pending", epoch };
    }
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
      if (!restarted) {
        await ensureFailedEpochCleanup({
          ...input,
          epoch
        });
        return { status: "pending", epoch };
      }
    }
  }

  for (const indexKind of ["content", "graph"] as const) {
    await input.states.createWork([
      createSearchLifecycleWork({ ...input, epoch }, indexKind, "prepare_index"),
      createSearchLifecycleWork({ ...input, epoch }, indexKind, "plan_documents")
    ]);
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

async function ensureFailedEpochCleanup(input: {
  states: SearchProjectionStateRepository;
  knowledgeBaseId: string;
  generationId: string;
  maintenanceRequestId: string | null;
  epoch: number;
  maxAttempts: number;
  now: string;
}): Promise<void> {
  await input.states.createWork(
    (["content", "graph"] as const).map((indexKind) =>
      createSearchLifecycleWork(input, indexKind, "cleanup")
    )
  );
  await input.states.retryFailedCleanup({
    knowledgeBaseId: input.knowledgeBaseId,
    generationId: input.generationId,
    maintenanceRequestId: input.maintenanceRequestId,
    epoch: input.epoch,
    maxAttempts: input.maxAttempts,
    retriedAt: input.now
  });
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
