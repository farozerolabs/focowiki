import { createHash } from "node:crypto";
import type { StorageVnextSearchCandidateBuildResult } from
  "../search/streaming-builder.js";
import type { StorageVnextSearchValidationCase } from "../search/ports.js";
import { createStorageVnextMaintenanceCandidatePublicId } from "./identity.js";
import type {
  StorageVnextMaintenancePhaseResult,
  StorageVnextMaintenancePhaseRunner
} from "./ports.js";
import type { SemanticMaintenanceTarget } from
  "../../semantic/domain/contracts.js";
import type { SemanticStageSettingsSnapshot } from
  "../../semantic/application/stage-orchestration.js";

type Candidate = {
  publicId: string;
  knowledgeBaseId: string;
  operationPublicId: string;
  expectedActiveRootPublicId: string | null;
  expectedActiveRevision: number;
};

type CompletePage = {
  outcome: "progress" | "phase_completed";
  cursor: string | null;
  completedDelta: number;
  expectedCount: number;
  processedBytesDelta: number;
  batchOrdinalDelta?: number;
};

export function createStorageVnextMaintenanceProductionPhases(input: {
  semanticAdoption?: {
    planSourcePage(input: {
      knowledgeBaseId: string;
      operationPublicId: string;
      expectedPredecessorPublicId: string | null;
      target: SemanticMaintenanceTarget;
      settingsSnapshot: SemanticStageSettingsSnapshot;
      cursor: string | null;
      pageSize: number;
      maximumAttempts: number;
      enqueuedAt: string;
    }): Promise<{
      sourceCount: number;
      stageCount: number;
      nextCursor: string | null;
    }>;
    validateCandidate(input: {
      knowledgeBaseId: string;
      operationPublicId: string;
    }): Promise<{
      outcome: "pending" | "ready";
      summary: { totalCount: number; completedCount: number };
    }>;
    activateCandidate(input: {
      knowledgeBaseId: string;
      operationPublicId: string;
      activatedAt: string;
    }): Promise<unknown>;
    adoptQueryPolicy?(input: {
      knowledgeBaseId: string;
      semanticGenerationPublicId: string;
      expectedGenerationRevision: number;
      target: SemanticMaintenanceTarget;
    }): Promise<unknown>;
  };
  semanticProviderAdoption?: {
    planSourcePage(input: {
      knowledgeBaseId: string;
      semanticGenerationPublicId: string;
      target: SemanticMaintenanceTarget;
      cursor: string | null;
      pageSize: number;
      signal?: AbortSignal;
    }): Promise<{
      sourceCount: number;
      documentCount: number;
      nextCursor: string | null;
      candidateIndexUid: string;
    }>;
    validate(input: {
      knowledgeBaseId: string;
      semanticGenerationPublicId: string;
      target: SemanticMaintenanceTarget;
    }): Promise<unknown>;
    activate(input: {
      knowledgeBaseId: string;
      semanticGenerationPublicId: string;
      expectedGenerationRevision: number;
      target: SemanticMaintenanceTarget;
    }): Promise<void>;
  };
  providerAdoption?: {
    activate(input: {
      knowledgeBaseId: string;
      operationPublicId: string;
      candidatePublicId: string;
      expectedResourceRevision: number;
      activatedAt: string;
      cleanupNotBefore: string;
    }): Promise<{ outcome: "activated" | "stale" | "not_ready" }>;
  };
  planner: {
    plan(request: {
      knowledgeBaseId: string;
      operationPublicId: string;
      expectedResourceRevision: number;
      createdAt: string;
    }): Promise<{
      candidatePublicId: string;
      candidateRootPublicId: string;
      sourceCount: number;
      directoryCount: number;
    }>;
  };
  catalog: {
    getKnowledgeBase(input: { knowledgeBaseId: string }): Promise<{
      publicId: string;
      revision: number;
      visibility: "current" | "deleted";
    } | null>;
  };
  releases: {
    hasCandidateCatalogEntries(candidatePublicId: string): Promise<boolean>;
    getActiveRoot(knowledgeBaseId: string): Promise<{
      publicId: string;
      revision: number;
    } | null>;
    getLiveCandidate(knowledgeBaseId: string): Promise<Candidate | null>;
    activateCandidate(input: {
      knowledgeBaseId: string;
      candidatePublicId: string;
      expectedActiveRootPublicId: string | null;
      expectedActiveRevision: number;
      searchProjectionPublicId: string;
      rollbackExpiresAt: string | null;
      eventPublicId: string;
      eventExpiresAt: string;
      activatedAt: string;
    }): Promise<{
      outcome: "activated" | "stale" | "rollback_pending" | "not_ready";
    }>;
  };
  pipeline: {
    schemaChecksum: string;
    settingsChecksum: string;
    searchLifecycle: {
      prepareCandidate(input: {
        knowledgeBaseId: string;
        candidatePublicId: string;
        schemaChecksum: string;
        settingsChecksum: string;
      }): Promise<void>;
    };
    searchValidation: {
      validateCandidate(input: {
        candidatePublicId: string;
        expectedDocumentCount: number;
        documentChecksum: string;
        schemaChecksum: string;
        settingsChecksum: string;
        queryCases: readonly StorageVnextSearchValidationCase[];
        maxP95ProcessingTimeMs: number;
      }): Promise<void>;
    };
    buildSearchCandidate(input: {
      knowledgeBaseId: string;
      candidatePublicId: string;
      operationPublicId: string;
      signal?: AbortSignal;
    }): Promise<StorageVnextSearchCandidateBuildResult>;
    graphReconciler: {
      reconcile(input: {
        knowledgeBaseId: string;
        candidatePublicId: string;
        operationPublicId: string;
        searchProjectionPublicId: string;
        signal: AbortSignal;
      }): Promise<{ sourceCount: number; edgeCount: number }>;
    };
    artifacts: {
      publish(input: {
        knowledgeBaseId: string;
        candidatePublicId: string;
        operationPublicId: string;
        searchProjectionPublicId: string;
        signal: AbortSignal;
      }): Promise<{ artifactCount: number }>;
    };
    releaseValidation: {
      validate(input: {
        knowledgeBaseId: string;
        candidatePublicId: string;
        searchProjectionPublicId: string;
      }): Promise<unknown>;
    };
  };
  objectReconciliation: {
    runPage(input: { cursor: string | null }): Promise<CompletePage>;
  };
  candidateObjectCleanup: {
    runPage(input: {
      knowledgeBaseId: string;
      operationPublicId: string;
      signal: AbortSignal;
    }): Promise<CompletePage>;
  };
  clock(): string;
  rollbackRetentionMilliseconds: number;
  resultRetentionMilliseconds: number;
  maxP95ProcessingTimeMs?: number;
}): StorageVnextMaintenancePhaseRunner {
  assertDuration(input.rollbackRetentionMilliseconds);
  assertDuration(input.resultRetentionMilliseconds);
  const maxP95ProcessingTimeMs = input.maxP95ProcessingTimeMs ?? 30_000;
  assertDuration(maxP95ProcessingTimeMs);
  return {
    async runPhase(request) {
      assertUnifiedSearch(request.searchProjection);
      throwIfAborted(request.signal);
      const candidatePublicId = createStorageVnextMaintenanceCandidatePublicId(request);
      const identity = {
        knowledgeBaseId: request.knowledgeBaseId,
        candidatePublicId,
        operationPublicId: request.operationPublicId,
        searchProjectionPublicId: candidatePublicId,
        signal: request.signal
      };
      const providerAdoption =
        request.checkpoint.maintenanceKind === "provider_adoption";
      const semanticSnapshot = request.checkpoint.semanticAdoption ?? null;
      if (semanticSnapshot?.mode === "query_policy_only") {
        if (!semanticSnapshot.expectedPredecessorPublicId
          || !input.semanticAdoption?.adoptQueryPolicy) {
          throw phaseError("semantic_query_policy_adoption_unavailable");
        }
        if (request.checkpoint.phase === "activation") {
          await input.semanticAdoption.adoptQueryPolicy({
            knowledgeBaseId: request.knowledgeBaseId,
            semanticGenerationPublicId:
              semanticSnapshot.expectedPredecessorPublicId,
            expectedGenerationRevision:
              semanticSnapshot.expectedPredecessorRevision,
            target: semanticSnapshot.target
          });
          return completed(1, 1, 0);
        }
        return completed(0, 0, 0);
      }

      switch (request.checkpoint.phase) {
        case "planning": {
          if (providerAdoption) {
            await prepareSearchCandidate(input, request.knowledgeBaseId, candidatePublicId);
            if (!semanticSnapshot) return completed(0, 0, 0);
          } else if (request.checkpoint.batchOrdinal === 0) {
            const plan = await input.planner.plan({
              knowledgeBaseId: request.knowledgeBaseId,
              operationPublicId: request.operationPublicId,
              expectedResourceRevision: request.checkpoint.baseResourceRevision,
              createdAt: request.checkpoint.startedAt
            });
            if (plan.candidatePublicId !== candidatePublicId) {
              throw phaseError("candidate_identity_conflict");
            }
            await prepareSearchCandidate(
              input,
              request.knowledgeBaseId,
              candidatePublicId
            );
            if (!semanticSnapshot) {
              const count = plan.sourceCount + plan.directoryCount;
              return completed(count, count, 0);
            }
          }
          if (semanticSnapshot?.mode === "provider_only") {
            if (
              !input.semanticProviderAdoption
              || !semanticSnapshot.expectedPredecessorPublicId
            ) throw phaseError("semantic_provider_adoption_unavailable");
            const semantic = await input.semanticProviderAdoption.planSourcePage({
              knowledgeBaseId: request.knowledgeBaseId,
              semanticGenerationPublicId:
                semanticSnapshot.expectedPredecessorPublicId,
              target: semanticSnapshot.target,
              cursor: request.checkpoint.cursor,
              pageSize: semanticSnapshot.sourcePageSize,
              signal: request.signal
            });
            return semantic.nextCursor
              ? progress(
                  semantic.nextCursor,
                  semantic.sourceCount,
                  semantic.sourceCount,
                  0
                )
              : completed(
                  semantic.sourceCount,
                  semantic.sourceCount,
                  0
                );
          }
          if (!semanticSnapshot || !input.semanticAdoption) {
            throw phaseError("semantic_adoption_unavailable");
          }
          const semantic = await input.semanticAdoption.planSourcePage({
            knowledgeBaseId: request.knowledgeBaseId,
            operationPublicId: request.operationPublicId,
            expectedPredecessorPublicId:
              semanticSnapshot.expectedPredecessorPublicId,
            target: semanticSnapshot.target,
            settingsSnapshot: semanticSnapshot.stageSettings,
            cursor: request.checkpoint.cursor,
            pageSize: semanticSnapshot.sourcePageSize,
            maximumAttempts: request.checkpoint.maxAttempts,
            enqueuedAt: request.checkpoint.startedAt
          });
          return semantic.nextCursor
            ? progress(
                semantic.nextCursor,
                semantic.sourceCount,
                semantic.sourceCount,
                0
              )
            : completed(
                semantic.sourceCount,
                semantic.sourceCount,
                0
              );
        }
        case "search_rebuild": {
          const semanticSnapshot = request.checkpoint.semanticAdoption ?? null;
          if (semanticSnapshot?.mode === "full") {
            if (!input.semanticAdoption) {
              throw phaseError("semantic_adoption_unavailable");
            }
            const semantic = await input.semanticAdoption.validateCandidate({
              knowledgeBaseId: request.knowledgeBaseId,
              operationPublicId: request.operationPublicId
            });
            const semanticProgress = semanticStageProgress(
              request.checkpoint,
              semantic.summary
            );
            if (semantic.outcome === "pending") {
              return progress(
                semanticProgress.cursor,
                semanticProgress.completedDelta,
                semanticProgress.expectedCount,
                0,
                0
              );
            }
            const search = await buildAndValidateSearchCandidate(
              input,
              identity,
              candidatePublicId,
              maxP95ProcessingTimeMs
            );
            const searchCount = search.sourceCount + search.graphSeedCount;
            return completed(
              semanticProgress.completedDelta + searchCount,
              semanticProgress.expectedCount + searchCount,
              search.compressedBytes,
              search.batchCount
            );
          }
          const search = await buildAndValidateSearchCandidate(
            input,
            identity,
            candidatePublicId,
            maxP95ProcessingTimeMs
          );
          return completed(
            search.sourceCount + search.graphSeedCount,
            search.sourceCount + search.graphSeedCount,
            search.compressedBytes,
            search.batchCount
          );
        }
        case "projection_repair": {
          if (providerAdoption) return completed(0, 0, 0);
          const graphAlreadyReconciled = await input.releases
            .hasCandidateCatalogEntries(candidatePublicId);
          const graph = graphAlreadyReconciled
            ? { sourceCount: 0, edgeCount: 0 }
            : await input.pipeline.graphReconciler.reconcile(identity);
          const artifacts = await input.pipeline.artifacts.publish(identity);
          const count = graph.sourceCount + graph.edgeCount + artifacts.artifactCount;
          return completed(count, count, 0);
        }
        case "object_reconciliation": {
          if (providerAdoption) return completed(0, 0, 0);
          const page = await input.objectReconciliation.runPage({
            cursor: request.checkpoint.cursor
          });
          return normalizePage(page);
        }
        case "catch_up": {
          const knowledgeBase = await input.catalog.getKnowledgeBase({
            knowledgeBaseId: request.knowledgeBaseId
          });
          if (
            !knowledgeBase
            || knowledgeBase.visibility !== "current"
            || knowledgeBase.revision !== request.checkpoint.baseResourceRevision
          ) throw phaseError(knowledgeBase ? "stale_plan" : "knowledge_base_deleted");
          if (request.checkpoint.semanticAdoption) {
            const semanticSnapshot = request.checkpoint.semanticAdoption;
            if (semanticSnapshot.mode === "provider_only") {
              if (
                !input.semanticProviderAdoption
                || !semanticSnapshot.expectedPredecessorPublicId
              ) throw phaseError("semantic_provider_adoption_unavailable");
              await input.semanticProviderAdoption.validate({
                knowledgeBaseId: request.knowledgeBaseId,
                semanticGenerationPublicId:
                  semanticSnapshot.expectedPredecessorPublicId,
                target: semanticSnapshot.target
              });
              return completed(1, 1, 0);
            }
            if (!input.semanticAdoption) {
              throw phaseError("semantic_adoption_unavailable");
            }
            const semantic = await input.semanticAdoption.validateCandidate({
              knowledgeBaseId: request.knowledgeBaseId,
              operationPublicId: request.operationPublicId
            });
            if (semantic.outcome === "pending") {
              return progress(
                "semantic-stages-pending",
                0,
                semantic.summary.totalCount,
                0,
                0
              );
            }
          }
          return completed(0, 0, 0);
        }
        case "validation":
          if (providerAdoption) return completed(1, 1, 0);
          await input.pipeline.releaseValidation.validate({
            knowledgeBaseId: request.knowledgeBaseId,
            candidatePublicId,
            searchProjectionPublicId: candidatePublicId
          });
          return completed(1, 1, 0);
        case "activation":
          if (request.checkpoint.semanticAdoption) {
            const semanticSnapshot = request.checkpoint.semanticAdoption;
            if (semanticSnapshot.mode === "provider_only") {
              if (
                !input.semanticProviderAdoption
                || !semanticSnapshot.expectedPredecessorPublicId
              ) throw phaseError("semantic_provider_adoption_unavailable");
              await input.semanticProviderAdoption.activate({
                knowledgeBaseId: request.knowledgeBaseId,
                semanticGenerationPublicId:
                  semanticSnapshot.expectedPredecessorPublicId,
                expectedGenerationRevision:
                  semanticSnapshot.expectedPredecessorRevision,
                target: semanticSnapshot.target
              });
            } else if (!input.semanticAdoption) {
              throw phaseError("semantic_adoption_unavailable");
            } else {
              await input.semanticAdoption.activateCandidate({
                knowledgeBaseId: request.knowledgeBaseId,
                operationPublicId: request.operationPublicId,
                activatedAt: input.clock()
              });
            }
          }
          if (providerAdoption) {
            await activateProviderAdoption(input, request);
            return completed(1, 1, 0);
          }
          await activate(input, request.knowledgeBaseId, request.operationPublicId);
          return completed(1, 1, 0);
        case "cleanup":
          if (providerAdoption) return completed(0, 0, 0);
          return normalizePage(await input.candidateObjectCleanup.runPage({
            knowledgeBaseId: request.knowledgeBaseId,
            operationPublicId: request.operationPublicId,
            signal: request.signal
          }));
      }
    }
  };
}

async function buildAndValidateSearchCandidate(
  input: Parameters<typeof createStorageVnextMaintenanceProductionPhases>[0],
  identity: {
    knowledgeBaseId: string;
    candidatePublicId: string;
    operationPublicId: string;
    searchProjectionPublicId: string;
    signal: AbortSignal;
  },
  candidatePublicId: string,
  maxP95ProcessingTimeMs: number
): Promise<StorageVnextSearchCandidateBuildResult> {
  const search = await input.pipeline.buildSearchCandidate(identity);
  await input.pipeline.searchValidation.validateCandidate({
    candidatePublicId,
    expectedDocumentCount: search.documentCount,
    documentChecksum: search.documentChecksum,
    schemaChecksum: input.pipeline.schemaChecksum,
    settingsChecksum: input.pipeline.settingsChecksum,
    queryCases: search.queryCases,
    maxP95ProcessingTimeMs
  });
  return search;
}

function semanticStageProgress(
  checkpoint: { cursor: string | null; completedCount: number },
  summary: { totalCount: number; completedCount: number }
): {
  cursor: string;
  completedDelta: number;
  expectedCount: number;
} {
  if (!Number.isSafeInteger(summary.totalCount) || summary.totalCount < 0
    || !Number.isSafeInteger(summary.completedCount)
    || summary.completedCount < 0
    || summary.completedCount > summary.totalCount) {
    throw phaseError("semantic_progress_invalid");
  }
  const prior = decodeSemanticStageProgress(checkpoint.cursor);
  const baseCompletedCount = prior?.baseCompletedCount
    ?? checkpoint.completedCount;
  const priorSemanticCompletedCount = prior?.semanticCompletedCount ?? 0;
  if (summary.completedCount < priorSemanticCompletedCount) {
    throw phaseError("semantic_progress_regressed");
  }
  return {
    cursor: encodeSemanticStageProgress(
      baseCompletedCount,
      summary.completedCount
    ),
    completedDelta: summary.completedCount - priorSemanticCompletedCount,
    expectedCount: baseCompletedCount + summary.totalCount
  };
}

function encodeSemanticStageProgress(
  baseCompletedCount: number,
  semanticCompletedCount: number
): string {
  return `semantic-stages:${baseCompletedCount}:${semanticCompletedCount}`;
}

function decodeSemanticStageProgress(cursor: string | null): {
  baseCompletedCount: number;
  semanticCompletedCount: number;
} | null {
  if (!cursor) return null;
  const match = /^semantic-stages:(\d+):(\d+)$/u.exec(cursor);
  if (!match) throw phaseError("semantic_progress_cursor_invalid");
  const baseCompletedCount = Number(match[1]);
  const semanticCompletedCount = Number(match[2]);
  if (!Number.isSafeInteger(baseCompletedCount)
    || !Number.isSafeInteger(semanticCompletedCount)) {
    throw phaseError("semantic_progress_cursor_invalid");
  }
  return { baseCompletedCount, semanticCompletedCount };
}

async function prepareSearchCandidate(
  input: Parameters<typeof createStorageVnextMaintenanceProductionPhases>[0],
  knowledgeBaseId: string,
  candidatePublicId: string
): Promise<void> {
  await input.pipeline.searchLifecycle.prepareCandidate({
    knowledgeBaseId,
    candidatePublicId,
    schemaChecksum: input.pipeline.schemaChecksum,
    settingsChecksum: input.pipeline.settingsChecksum
  });
}

async function activateProviderAdoption(
  input: Parameters<typeof createStorageVnextMaintenanceProductionPhases>[0],
  request: Parameters<StorageVnextMaintenancePhaseRunner["runPhase"]>[0]
): Promise<void> {
  if (!input.providerAdoption) throw phaseError("provider_adoption_unavailable");
  const activatedAt = input.clock();
  assertTimestamp(activatedAt);
  const activation = await input.providerAdoption.activate({
    knowledgeBaseId: request.knowledgeBaseId,
    operationPublicId: request.operationPublicId,
    candidatePublicId: createStorageVnextMaintenanceCandidatePublicId(request),
    expectedResourceRevision: request.checkpoint.baseResourceRevision,
    activatedAt,
    cleanupNotBefore: addMilliseconds(
      activatedAt,
      input.rollbackRetentionMilliseconds
    )
  });
  if (activation.outcome === "activated") return;
  if (activation.outcome === "stale") throw phaseError("stale_plan");
  throw phaseError("candidate_not_ready");
}

async function activate(
  input: Parameters<typeof createStorageVnextMaintenanceProductionPhases>[0],
  knowledgeBaseId: string,
  operationPublicId: string
): Promise<void> {
  const candidatePublicId = createStorageVnextMaintenanceCandidatePublicId({
    knowledgeBaseId,
    operationPublicId
  });
  const [candidate, active] = await Promise.all([
    input.releases.getLiveCandidate(knowledgeBaseId),
    input.releases.getActiveRoot(knowledgeBaseId)
  ]);
  if (candidate && (
    candidate.publicId !== candidatePublicId
    || candidate.knowledgeBaseId !== knowledgeBaseId
    || candidate.operationPublicId !== operationPublicId
  )) throw phaseError("stale_plan");
  const activatedAt = input.clock();
  assertTimestamp(activatedAt);
  const activation = await input.releases.activateCandidate({
    knowledgeBaseId,
    candidatePublicId,
    expectedActiveRootPublicId: candidate?.expectedActiveRootPublicId
      ?? active?.publicId
      ?? null,
    expectedActiveRevision: candidate?.expectedActiveRevision ?? active?.revision ?? 0,
    searchProjectionPublicId: candidatePublicId,
    rollbackExpiresAt: active
      ? addMilliseconds(activatedAt, input.rollbackRetentionMilliseconds)
      : null,
    eventPublicId: eventPublicId(operationPublicId, "activated"),
    eventExpiresAt: addMilliseconds(activatedAt, input.resultRetentionMilliseconds),
    activatedAt
  });
  if (activation.outcome === "activated") return;
  if (activation.outcome === "stale") throw phaseError("stale_plan");
  throw phaseError(
    activation.outcome === "rollback_pending"
      ? "rollback_pending"
      : "candidate_not_ready"
  );
}

function normalizePage(page: CompletePage): StorageVnextMaintenancePhaseResult {
  if (page.outcome === "progress") {
    if (!page.cursor) throw phaseError("invalid_page_result");
    return {
      outcome: "progress",
      cursor: page.cursor,
      completedDelta: page.completedDelta,
      expectedCount: page.expectedCount,
      processedBytesDelta: page.processedBytesDelta,
      ...(page.batchOrdinalDelta === undefined
        ? {}
        : { batchOrdinalDelta: page.batchOrdinalDelta })
    };
  }
  return completed(
    page.completedDelta,
    page.expectedCount,
    page.processedBytesDelta,
    page.batchOrdinalDelta
  );
}

function completed(
  completedDelta: number,
  expectedCount: number,
  processedBytesDelta: number,
  batchOrdinalDelta?: number
): StorageVnextMaintenancePhaseResult {
  return {
    outcome: "phase_completed",
    completedDelta,
    expectedCount,
    processedBytesDelta,
    ...(batchOrdinalDelta === undefined ? {} : { batchOrdinalDelta })
  };
}

function progress(
  cursor: string,
  completedDelta: number,
  expectedCount: number,
  processedBytesDelta: number,
  batchOrdinalDelta = 1
): StorageVnextMaintenancePhaseResult {
  return {
    outcome: "progress",
    cursor,
    completedDelta,
    expectedCount,
    processedBytesDelta,
    batchOrdinalDelta
  };
}

function eventPublicId(operationPublicId: string, outcome: string): string {
  const digest = createHash("sha256")
    .update("storage-vnext-maintenance-release-event-v1")
    .update("\0")
    .update(operationPublicId)
    .update("\0")
    .update(outcome)
    .digest("hex");
  return `maintenance-release-event-${digest}`;
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) throw phaseError("invalid_clock");
  return new Date(value + milliseconds).toISOString();
}

function assertUnifiedSearch(input: {
  activeRole: "active";
  candidateRole: "candidate";
  documentKinds: readonly ["content", "graph_seed"];
}): void {
  if (
    input.activeRole !== "active"
    || input.candidateRole !== "candidate"
    || input.documentKinds[0] !== "content"
    || input.documentKinds[1] !== "graph_seed"
  ) throw phaseError("split_search_projection");
}

function assertDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw phaseError("invalid_configuration");
  }
}

function assertTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw phaseError("invalid_clock");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? phaseError("aborted");
}

function phaseError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext maintenance production phase error: ${code}`),
    { code }
  );
}
