import type { DocumentState } from "../domain/contracts.js";
import type { DocumentResourceKind } from "./document-resource-permits.js";
import type { DocumentWorkKind } from "../domain/document-work-graph.js";
import type { DocumentResourceLane } from "./document-fixed-dag-scheduler.js";
import type { ProviderRequestFailureDiagnostic } from
  "../../semantic/provider-request-failure.js";
import type { IngestionFailureFields } from
  "../../runtime/ingestion-failure.js";

type WorkerLogEvent = {
  level: "info" | "error";
  event: string;
  fields: Record<string, unknown>;
};

export type DocumentWorkerObservability = ReturnType<
  typeof createDocumentWorkerObservability
>;

export function createDocumentWorkerObservability(input: {
  write(event: WorkerLogEvent): void;
}) {
  let previousQueueDepth: number | null = null;
  const previousPublicationBacklog = new Map<string, string>();
  let previousCleanupSignature: string | null = null;

  return {
    work(fields: {
      event: "claimed" | "completed" | "waiting_on_projection"
        | "deferred" | "failed";
      workPublicId: string;
      documentJobPublicId: string;
      workKind: DocumentWorkKind;
      resourceLane: DocumentResourceLane;
      attemptCount: number;
      errorCode: string | null;
      errorConstraint?: string | null;
      errorResource?: string | null;
      errorTarget?: string | null;
    }) {
      identity(fields.workPublicId);
      identity(fields.documentJobPublicId);
      if (fields.errorCode !== null && !/^[A-Za-z0-9_]{1,128}$/u.test(
        fields.errorCode
      )) throw new Error("Document worker error code is invalid");
      if (fields.errorConstraint !== undefined
        && fields.errorConstraint !== null
        && !/^[A-Za-z0-9_]{1,128}$/u.test(fields.errorConstraint)) {
        throw new Error("Document worker error constraint is invalid");
      }
      validateDiagnosticPath(fields.errorResource);
      validateDiagnosticPath(fields.errorTarget);
      write(`worker.document_work_${fields.event}`, {
        workPublicId: fields.workPublicId,
        documentJobPublicId: fields.documentJobPublicId,
        workKind: fields.workKind,
        resourceLane: fields.resourceLane,
        attemptCount: metric(fields.attemptCount),
        errorCode: fields.errorCode,
        ...(fields.errorConstraint === undefined
          ? {} : { errorConstraint: fields.errorConstraint }),
        ...(fields.errorResource === undefined
          ? {} : { errorResource: fields.errorResource }),
        ...(fields.errorTarget === undefined
          ? {} : { errorTarget: fields.errorTarget })
      });
    },
    queue(fields: { waiting: number; oldestAgeMs: number }) {
      const waiting = metric(fields.waiting);
      const oldestAgeMs = metric(fields.oldestAgeMs);
      if (previousQueueDepth === waiting) return;
      previousQueueDepth = waiting;
      write("worker.queue_metrics", {
        waiting,
        oldestAgeMs
      });
    },
    job(fields: {
      event: "started" | "work_changed" | "available" | "failed";
      jobPublicId: string;
      state: DocumentState;
      blockingWorkKind: DocumentWorkKind | null;
      attemptCount: number;
      queueAgeMs: number;
      serviceTimeMs: number | null;
      errorCode: string | null;
    }) {
      identity(fields.jobPublicId);
      if (fields.errorCode !== null && !/^[A-Za-z0-9_]{1,128}$/u.test(
        fields.errorCode
      )) {
        throw new Error("Document worker error code is invalid");
      }
      write(`worker.document_${fields.event}`, {
        jobPublicId: fields.jobPublicId,
        state: fields.state,
        blockingWorkKind: fields.blockingWorkKind,
        attemptCount: metric(fields.attemptCount),
        queueAgeMs: metric(fields.queueAgeMs),
        serviceTimeMs: fields.serviceTimeMs === null
          ? null : metric(fields.serviceTimeMs),
        errorCode: fields.errorCode
      });
    },
    provider(fields: {
      resource: DocumentResourceKind;
      waitTimeMs: number;
      serviceTimeMs: number;
      outcome: "success" | "failure";
    }) {
      write("worker.provider_metrics", {
        resource: fields.resource,
        waitTimeMs: metric(fields.waitTimeMs),
        serviceTimeMs: metric(fields.serviceTimeMs),
        outcome: fields.outcome
      });
    },
    providerFailure(fields: ProviderRequestFailureDiagnostic) {
      input.write({
        level: "error",
        event: "provider.request_failed",
        fields: { ...fields }
      });
    },
    ingestionFailure(fields: IngestionFailureFields) {
      input.write({
        level: "error",
        event: "ingestion.stage_failed",
        fields: { ...fields }
      });
    },
    activation(fields: {
      attempt: number;
      outcome: "committed" | "conflict";
    }) {
      write("worker.activation_attempt", {
        attempt: metric(fields.attempt),
        outcome: fields.outcome
      });
    },
    publication(fields: {
      event: "planned" | "validated" | "activated" | "deferred"
        | "superseded" | "scope_failed";
      knowledgeBaseId: string;
      generationPublicId: string;
      scopeKind: string | null;
      waitingCount: number;
      durationMs: number;
      contentionCount: number;
      objectPutCount: number;
      objectReuseCount: number;
      errorCode: string | null;
    }) {
      identity(fields.knowledgeBaseId);
      identity(fields.generationPublicId);
      if (fields.scopeKind !== null
        && !/^[A-Za-z0-9_:-]{1,128}$/u.test(fields.scopeKind)) {
        throw new Error("Document publication scope kind is invalid");
      }
      if (fields.errorCode !== null
        && !/^[A-Za-z0-9_]{1,128}$/u.test(fields.errorCode)) {
        throw new Error("Document publication error code is invalid");
      }
      write(`worker.publication_${fields.event}`, {
        knowledgeBaseId: fields.knowledgeBaseId,
        generationPublicId: fields.generationPublicId,
        scopeKind: fields.scopeKind,
        waitingCount: metric(fields.waitingCount),
        durationMs: metric(fields.durationMs),
        contentionCount: metric(fields.contentionCount),
        objectPutCount: metric(fields.objectPutCount),
        objectReuseCount: metric(fields.objectReuseCount),
        errorCode: fields.errorCode
      });
    },
    publicationBacklog(fields: {
      knowledgeBaseId: string;
      waitingScopeCount: number;
      runningScopeCount: number;
      dirtyFactCount: number;
      oldestAgeMs: number;
      statusRegressionCount: number;
    }) {
      identity(fields.knowledgeBaseId);
      const normalized = {
        knowledgeBaseId: fields.knowledgeBaseId,
        waitingScopeCount: metric(fields.waitingScopeCount),
        runningScopeCount: metric(fields.runningScopeCount),
        dirtyFactCount: metric(fields.dirtyFactCount),
        oldestAgeMs: metric(fields.oldestAgeMs),
        statusRegressionCount: metric(fields.statusRegressionCount)
      };
      const signature = JSON.stringify(normalized);
      if (previousPublicationBacklog.get(fields.knowledgeBaseId) === signature) {
        return;
      }
      previousPublicationBacklog.set(fields.knowledgeBaseId, signature);
      write("worker.publication_backlog", normalized);
    },
    publicationRecovery(fields: {
      generationCount: number;
      releasedFactCount: number;
      supersededScopeCount: number;
    }) {
      write("worker.publication_recovery", {
        generationCount: metric(fields.generationCount),
        releasedFactCount: metric(fields.releasedFactCount),
        supersededScopeCount: metric(fields.supersededScopeCount)
      });
    },
    publicationScope(fields: {
      event: "claimed" | "completed" | "failed" | "fenced" | "recovered";
      knowledgeBaseId: string;
      generationPublicId: string;
      scopeKind: string;
      safeScopeKeyHash: string;
      targetFactEpoch: number;
      activeFactEpoch: number;
      scopeGeneration: number;
      leaseGeneration: number;
      durationMs: number;
      errorCode: string | null;
    }) {
      identity(fields.knowledgeBaseId);
      identity(fields.generationPublicId);
      safeToken(fields.scopeKind, "scope kind");
      if (!/^[0-9a-f]{64}$/u.test(fields.safeScopeKeyHash)) {
        throw new Error("Document publication scope key hash is invalid");
      }
      if (fields.errorCode !== null) safeToken(fields.errorCode, "error code");
      const targetFactEpoch = metric(fields.targetFactEpoch);
      const activeFactEpoch = metric(fields.activeFactEpoch);
      write(`worker.publication_scope_${fields.event}`, {
        knowledgeBaseId: fields.knowledgeBaseId,
        generationPublicId: fields.generationPublicId,
        scopeKind: fields.scopeKind,
        safeScopeKeyHash: fields.safeScopeKeyHash,
        targetFactEpoch,
        activeFactEpoch,
        scopeLag: Math.max(0, targetFactEpoch - activeFactEpoch),
        scopeGeneration: metric(fields.scopeGeneration),
        leaseGeneration: metric(fields.leaseGeneration),
        durationMs: metric(fields.durationMs),
        errorCode: fields.errorCode
      });
    },
    publicationScopeStage(fields: {
      knowledgeBaseId: string | null;
      generationPublicId: string | null;
      scopeGenerationPublicId: string;
      stage: "snapshot_load" | "render" | "database_persist";
      outcome: "completed" | "failed";
      durationMs: number;
      errorCode: string | null;
    }) {
      if (fields.knowledgeBaseId !== null) identity(fields.knowledgeBaseId);
      if (fields.generationPublicId !== null) identity(fields.generationPublicId);
      identity(fields.scopeGenerationPublicId);
      if (fields.errorCode !== null) safeToken(fields.errorCode, "error code");
      write("worker.publication_scope_stage", {
        ...fields,
        durationMs: metric(fields.durationMs)
      });
    },
    publicationStorage(fields: {
      knowledgeBaseId: string;
      generationPublicId: string;
      objectPutCount: number;
      objectReuseCount: number;
      putByteCount: number;
    }) {
      identity(fields.knowledgeBaseId);
      identity(fields.generationPublicId);
      write("worker.publication_storage", {
        knowledgeBaseId: fields.knowledgeBaseId,
        generationPublicId: fields.generationPublicId,
        objectPutCount: metric(fields.objectPutCount),
        objectReuseCount: metric(fields.objectReuseCount),
        putByteCount: metric(fields.putByteCount)
      });
    },
    storageRequest(fields: {
      operation: "put" | "head" | "get";
      safeObjectKeyHash: string;
      durationMs: number;
      outcome: "completed" | "failed";
      errorCode: string | null;
    }) {
      if (!/^[0-9a-f]{64}$/u.test(fields.safeObjectKeyHash)) {
        throw new Error("Storage object key hash is invalid");
      }
      if (fields.errorCode !== null) safeToken(fields.errorCode, "error code");
      write("worker.storage_request", {
        ...fields,
        durationMs: metric(Math.round(fields.durationMs))
      });
    },
    cleanup(fields: {
      claimed: number;
      completed: number;
      retried: number;
      failed: number;
      backlogDepth?: number;
      oldestAgeMs?: number;
      verifiedReservationDebt?: number;
    }) {
      const normalized = {
        claimed: metric(fields.claimed),
        completed: metric(fields.completed),
        retried: metric(fields.retried),
        failed: metric(fields.failed),
        ...(fields.backlogDepth === undefined ? {}
          : { backlogDepth: metric(fields.backlogDepth) }),
        ...(fields.oldestAgeMs === undefined ? {}
          : { oldestAgeMs: metric(fields.oldestAgeMs) }),
        ...(fields.verifiedReservationDebt === undefined ? {}
          : { verifiedReservationDebt: metric(fields.verifiedReservationDebt) })
      };
      const signature = JSON.stringify(normalized);
      if (signature === previousCleanupSignature && fields.claimed === 0) return;
      previousCleanupSignature = signature;
      write("worker.cleanup_metrics", normalized);
    }
  };

  function write(event: string, fields: Record<string, unknown>): void {
    input.write({ level: "info", event, fields });
  }
}

function metric(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error("Document worker metric value is invalid");
  }
  return value;
}

function identity(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(value)) {
    throw new Error("Document worker identity is invalid");
  }
}

function safeToken(value: string, label: string): void {
  if (!/^[A-Za-z0-9_:-]{1,128}$/u.test(value)) {
    throw new Error(`Document publication ${label} is invalid`);
  }
}

function validateDiagnosticPath(value: string | null | undefined): void {
  if (value !== undefined && value !== null
    && (value.length > 512 || !/^[A-Za-z0-9._/%\-]+$/u.test(value))) {
    throw new Error("Document worker diagnostic path is invalid");
  }
}
