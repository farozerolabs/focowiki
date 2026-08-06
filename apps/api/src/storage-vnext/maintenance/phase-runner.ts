import { createStorageVnextMaintenanceCandidatePublicId } from "./identity.js";
import type {
  StorageVnextMaintenanceCheckpoint,
  StorageVnextMaintenancePhase,
  StorageVnextMaintenancePhaseResult,
  StorageVnextMaintenancePhaseRunner
} from "./ports.js";

type MaintenancePageResult = {
  outcome: "progress" | "phase_completed";
  cursor: string | null;
  completedDelta: number;
  expectedCount: number;
  processedBytesDelta: number;
  batchOrdinalDelta?: number;
};

type CandidatePageRunner = {
  runPage(input: {
    knowledgeBaseId: string;
    candidatePublicId: string;
    operationPublicId: string;
    cursor: string | null;
    batchOrdinal: number;
    signal?: AbortSignal;
  }): Promise<MaintenancePageResult>;
};

type ReconciliationPageRunner = {
  runPage(input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    cursor: string | null;
    signal?: AbortSignal;
  }): Promise<MaintenancePageResult>;
};

type LifecyclePhase = Exclude<
  StorageVnextMaintenancePhase,
  "search_rebuild" | "projection_repair" | "object_reconciliation"
>;

type LifecycleRunner = {
  runPhase(input: {
    phase: LifecyclePhase;
    knowledgeBaseId: string;
    candidatePublicId: string;
    operationPublicId: string;
    checkpoint: StorageVnextMaintenanceCheckpoint;
    searchProjection: {
      activeRole: "active";
      candidateRole: "candidate";
      documentKinds: readonly ["content", "graph_seed"];
    };
    signal: AbortSignal;
  }): Promise<StorageVnextMaintenancePhaseResult>;
};

export function createStorageVnextMaintenancePhaseRunner(input: {
  searchRebuild: CandidatePageRunner;
  projectionRepair: CandidatePageRunner;
  objectReconciliation: ReconciliationPageRunner;
  lifecycle: LifecycleRunner;
}): StorageVnextMaintenancePhaseRunner {
  return {
    async runPhase(request) {
      assertUnifiedSearchProjection(request.searchProjection);
      const candidatePublicId = createStorageVnextMaintenanceCandidatePublicId({
        knowledgeBaseId: request.knowledgeBaseId,
        operationPublicId: request.operationPublicId
      });
      if (request.checkpoint.phase === "search_rebuild") {
        return normalizePageResult(await input.searchRebuild.runPage({
          knowledgeBaseId: request.knowledgeBaseId,
          candidatePublicId,
          operationPublicId: request.operationPublicId,
          cursor: request.checkpoint.cursor,
          batchOrdinal: request.checkpoint.batchOrdinal,
          signal: request.signal
        }));
      }
      if (request.checkpoint.phase === "projection_repair") {
        return normalizePageResult(await input.projectionRepair.runPage({
          knowledgeBaseId: request.knowledgeBaseId,
          candidatePublicId,
          operationPublicId: request.operationPublicId,
          cursor: request.checkpoint.cursor,
          batchOrdinal: request.checkpoint.batchOrdinal,
          signal: request.signal
        }));
      }
      if (request.checkpoint.phase === "object_reconciliation") {
        return normalizePageResult(await input.objectReconciliation.runPage({
          knowledgeBaseId: request.knowledgeBaseId,
          operationPublicId: request.operationPublicId,
          cursor: request.checkpoint.cursor,
          signal: request.signal
        }));
      }
      return input.lifecycle.runPhase({
        phase: request.checkpoint.phase,
        knowledgeBaseId: request.knowledgeBaseId,
        candidatePublicId,
        operationPublicId: request.operationPublicId,
        checkpoint: request.checkpoint,
        searchProjection: request.searchProjection,
        signal: request.signal
      });
    }
  };
}

function normalizePageResult(
  result: MaintenancePageResult
): StorageVnextMaintenancePhaseResult {
  if (result.outcome === "progress") {
    if (!result.cursor) throw maintenancePhaseRunnerError("invalid_page_result");
    return {
      outcome: "progress",
      cursor: result.cursor,
      completedDelta: result.completedDelta,
      expectedCount: result.expectedCount,
      processedBytesDelta: result.processedBytesDelta,
      ...(result.batchOrdinalDelta === undefined
        ? {}
        : { batchOrdinalDelta: result.batchOrdinalDelta })
    };
  }
  return {
    outcome: "phase_completed",
    completedDelta: result.completedDelta,
    expectedCount: result.expectedCount,
    processedBytesDelta: result.processedBytesDelta,
    ...(result.batchOrdinalDelta === undefined
      ? {}
      : { batchOrdinalDelta: result.batchOrdinalDelta })
  };
}

function assertUnifiedSearchProjection(input: {
  activeRole: "active";
  candidateRole: "candidate";
  documentKinds: readonly ["content", "graph_seed"];
}): void {
  if (
    input.activeRole !== "active"
    || input.candidateRole !== "candidate"
    || input.documentKinds.length !== 2
    || input.documentKinds[0] !== "content"
    || input.documentKinds[1] !== "graph_seed"
  ) throw maintenancePhaseRunnerError("split_search_projection");
}

function maintenancePhaseRunnerError(code: string): Error {
  return Object.assign(
    new Error(`Storage vNext maintenance phase runner error: ${code}`),
    { code }
  );
}
