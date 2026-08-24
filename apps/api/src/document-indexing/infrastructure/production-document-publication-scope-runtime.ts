import type { DatabaseClient } from "../../db/client.js";
import { totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";
import {
  DOCUMENT_PUBLICATION_SCOPE_EXECUTION_TIMEOUT_MS,
  createDocumentPublicationScopeGenerationExecutor
} from
  "../application/document-publication-scope-generation-runtime.js";
import { createDocumentPublicationScopeRuntime } from
  "../application/document-publication-scope-runtime.js";
import {
  decideDocumentPublicationRecovery,
  limitDocumentPublicationRecovery
} from
  "../application/document-publication-recovery.js";
import { createPostgresDocumentPublicationSnapshot } from
  "./postgres-document-publication-snapshot.js";
import { createPostgresDocumentScopeGenerationRepository } from
  "./postgres-document-scope-generation-repository.js";
import type { createProductionDocumentScopeRenderer } from
  "./production-document-scope-renderer.js";
import { safeErrorCode } from
  "./production-document-error-diagnostic.js";
import { waitForDocumentWork } from
  "./production-document-fixed-runtime-support.js";
import type { DocumentWorkerObservability } from
  "../application/document-worker-observability.js";
import { DOCUMENT_PUBLICATION_RENDERER_CONTRACT_VERSION } from
  "../application/document-publication-renderer-contract.js";
import { hasDocumentPublicationMemoryHeadroom } from
  "../application/document-resource-capacity.js";

export function createProductionDocumentPublicationScopeRuntime(input: {
  sql: DatabaseClient;
  workerId: string;
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
  maximumConcurrency: number;
  renderer: ReturnType<typeof createProductionDocumentScopeRenderer>;
  observability?: Pick<DocumentWorkerObservability,
    "publicationScope" | "publicationScopeStage" | "publicationStorage"
      | "publicationProjection" | "publicationResourcePressure">;
}) {
  const workerId = `${input.workerId}:publication-scope`;
  const repository = createPostgresDocumentScopeGenerationRepository(input.sql);
  const executor = createDocumentPublicationScopeGenerationExecutor({
    snapshots: createPostgresDocumentPublicationSnapshot(input.sql),
    outputs: repository,
    leases: repository,
    leaseDurationMs: input.leaseDurationMs,
    heartbeatIntervalMs: input.heartbeatIntervalMs,
    maximumExecutionMs: DOCUMENT_PUBLICATION_SCOPE_EXECUTION_TIMEOUT_MS,
    supportedRendererContractVersion:
      DOCUMENT_PUBLICATION_RENDERER_CONTRACT_VERSION,
    now: () => new Date().toISOString(),
    render: (snapshot, signal, checkpoint) =>
      input.renderer.renderPublication(snapshot, signal, checkpoint),
    onPersisted(event) {
      input.observability?.publicationStorage({
        knowledgeBaseId: event.snapshot.knowledgeBaseId,
        generationPublicId: event.snapshot.publicationGenerationPublicId,
        objectPutCount: event.objectPutCount,
        objectReuseCount: event.objectReuseCount,
        putByteCount: event.putByteCount
      });
      input.observability?.publicationProjection({
        knowledgeBaseId: event.snapshot.knowledgeBaseId,
        generationPublicId: event.snapshot.publicationGenerationPublicId,
        planningMode: event.snapshot.planningMode,
        rendererContractVersion: event.snapshot.rendererContractVersion,
        affectedSourceCount:
          event.snapshot.affectedSourceFilePublicIds.length,
        basePageCount: event.snapshot.basePages.length,
        recordsRendered: event.recordsRendered,
        objectPutCount: event.objectPutCount,
        objectReuseCount: event.objectReuseCount,
        putByteCount: event.putByteCount,
        renewalCount: event.renewalCount,
        maximumHeartbeatAgeMs: event.maximumHeartbeatAgeMs,
        heapUsedBytes: event.heapUsedBytes,
        heapLimitBytes: event.heapLimitBytes,
        rssBytes: event.rssBytes,
        changedRecordCount: event.changedRecordCount,
        chunkCount: event.chunkCount,
        peakBufferedRecordCount: event.peakBufferedRecordCount,
        touchedShardCount: event.touchedShardCount
      });
    },
    onStage(event) {
      const snapshot = event.snapshot;
      input.observability?.publicationScopeStage({
        knowledgeBaseId: snapshot?.knowledgeBaseId ?? null,
        generationPublicId: snapshot?.publicationGenerationPublicId ?? null,
        scopeGenerationPublicId: event.scopeGenerationPublicId,
        stage: event.stage,
        outcome: event.outcome,
        durationMs: event.durationMs,
        errorCode: event.errorCode,
        heapUsedBytes: event.heapUsedBytes,
        heapLimitBytes: event.heapLimitBytes,
        rssBytes: event.rssBytes
      });
    }
  });
  let runtime: ReturnType<typeof createDocumentPublicationScopeRuntime>;
  runtime = createDocumentPublicationScopeRuntime({
    workerId,
    leaseDurationMs: input.leaseDurationMs,
    maximumConcurrency: input.maximumConcurrency,
    repository,
    execute: (request) => executor.execute(request),
    now: () => new Date().toISOString(),
    wait: waitForDocumentWork,
    canClaim() {
      const memory = process.memoryUsage();
      const constrained = process.constrainedMemory?.() ?? 0;
      return hasDocumentPublicationMemoryHeadroom({
        heapUsedBytes: memory.heapUsed,
        heapLimitBytes: getHeapStatistics().heap_size_limit,
        rssBytes: memory.rss,
        residentLimitBytes: constrained > 0
          ? Math.min(totalmem(), constrained) : totalmem()
      });
    },
    onAdmissionDeferred() {
      const memory = process.memoryUsage();
      input.observability?.publicationResourcePressure({
        heapUsedBytes: memory.heapUsed,
        heapLimitBytes: getHeapStatistics().heap_size_limit,
        rssBytes: memory.rss,
        activeScopeCount: runtime.activeCount(),
        maximumScopeConcurrency: input.maximumConcurrency
      });
    },
    classifyError(error, claim) {
      const code = safeErrorCode(error);
      const decision = decideDocumentPublicationRecovery(code);
      return {
        code,
        recoveryAction: decision.action === "inspect_or_reclaim"
          ? decision.action
          : limitDocumentPublicationRecovery({
              decision,
              attempt: Number(claim.leaseGeneration)
            })
      };
    },
    onClaim: ({ claim }) => observeScope(input.observability, {
      event: "claimed", claim, durationMs: 0, errorCode: null
    }),
    onComplete: ({ claim, durationMs }) => observeScope(input.observability, {
      event: "completed", claim, durationMs, errorCode: null
    }),
    onFailure: ({ claim, code, recoveryAction }) => observeScope(
      input.observability,
      {
        event: recoveryAction === "inspect_or_reclaim" ? "fenced" : "failed",
        claim,
        durationMs: 0,
        errorCode: code
      }
    )
  });
  return runtime;
}

function observeScope(
  observability: Pick<DocumentWorkerObservability, "publicationScope">
    | undefined,
  input: Readonly<{
    event: "claimed" | "completed" | "failed" | "fenced" | "recovered";
    claim: Readonly<{
      knowledgeBaseId?: string;
      publicationGenerationPublicId?: string;
      scopeKind?: string;
      safeScopeKeyHash?: string;
      targetFactEpoch?: number;
      activeFactEpoch?: number;
      scopeGeneration?: number;
      leaseGeneration: number;
      leaseLossCount?: number;
    }>;
    durationMs: number;
    errorCode: string | null;
  }>
): void {
  const claim = input.claim;
  if (!observability || claim.knowledgeBaseId === undefined
    || claim.publicationGenerationPublicId === undefined
    || claim.scopeKind === undefined || claim.safeScopeKeyHash === undefined
    || claim.targetFactEpoch === undefined || claim.activeFactEpoch === undefined
    || claim.scopeGeneration === undefined) return;
  observability.publicationScope({
    event: input.event,
    knowledgeBaseId: claim.knowledgeBaseId,
    generationPublicId: claim.publicationGenerationPublicId,
    scopeKind: claim.scopeKind,
    safeScopeKeyHash: claim.safeScopeKeyHash,
    targetFactEpoch: claim.targetFactEpoch,
    activeFactEpoch: claim.activeFactEpoch,
    scopeGeneration: claim.scopeGeneration,
    leaseGeneration: Number(claim.leaseGeneration),
    leaseLossCount: claim.leaseLossCount ?? 0,
    durationMs: input.durationMs,
    errorCode: input.errorCode
  });
}
