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
  let previousCleanupSignature: string | null = null;
  const write = (event: string, fields: Record<string, unknown>) =>
    input.write({ level: "info", event, fields });
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
      optionalToken(fields.errorCode, "error code");
      optionalToken(fields.errorConstraint, "error constraint");
      validateDiagnosticPath(fields.errorResource);
      validateDiagnosticPath(fields.errorTarget);
      write(`worker.document_work_${fields.event}`, {
        ...fields, attemptCount: metric(fields.attemptCount)
      });
    },
    queue(fields: { waiting: number; oldestAgeMs: number }) {
      const waiting = metric(fields.waiting);
      if (previousQueueDepth === waiting) return;
      previousQueueDepth = waiting;
      write("worker.queue_metrics", {
        waiting, oldestAgeMs: metric(fields.oldestAgeMs)
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
      optionalToken(fields.errorCode, "error code");
      write(`worker.document_${fields.event}`, {
        ...fields,
        attemptCount: metric(fields.attemptCount),
        queueAgeMs: metric(fields.queueAgeMs),
        serviceTimeMs: fields.serviceTimeMs === null
          ? null : metric(fields.serviceTimeMs)
      });
    },
    provider(fields: {
      resource: DocumentResourceKind;
      waitTimeMs: number;
      serviceTimeMs: number;
      outcome: "success" | "failure";
    }) {
      write("worker.provider_metrics", {
        ...fields,
        waitTimeMs: metric(fields.waitTimeMs),
        serviceTimeMs: metric(fields.serviceTimeMs)
      });
    },
    providerFailure(fields: ProviderRequestFailureDiagnostic) {
      input.write({ level: "error", event: "provider.request_failed",
        fields: { ...fields } });
    },
    ingestionFailure(fields: IngestionFailureFields) {
      input.write({ level: "error", event: "ingestion.stage_failed",
        fields: { ...fields } });
    },
    activation(fields: { attempt: number; outcome: "committed" | "conflict" }) {
      write("worker.activation_attempt", {
        attempt: metric(fields.attempt), outcome: fields.outcome
      });
    },
    publication(fields: {
      event: "claimed" | "manifest_persisted" | "activated"
        | "retrying" | "failed";
      knowledgeBaseId: string;
      jobPublicId: string;
      itemCount: number;
      attemptCount: number;
      durationMs: number;
      objectPutCount: number;
      objectReuseCount: number;
      objectRequestCount: number;
      objectAttemptedBytes: number;
      errorCode: string | null;
    }) {
      identity(fields.knowledgeBaseId);
      identity(fields.jobPublicId);
      optionalToken(fields.errorCode, "error code");
      write(`worker.publication_job_${fields.event}`, {
        ...fields,
        itemCount: metric(fields.itemCount),
        attemptCount: metric(fields.attemptCount),
        durationMs: metric(fields.durationMs),
        objectPutCount: metric(fields.objectPutCount),
        objectReuseCount: metric(fields.objectReuseCount),
        objectRequestCount: metric(fields.objectRequestCount),
        objectAttemptedBytes: metric(fields.objectAttemptedBytes)
      });
    },
    publicationRuntime(fields: {
      event: "failed" | "recovered";
      errorCode: string;
      failureCount: number;
      suppressedFailureCount: number;
      durationMs: number;
    }) {
      optionalToken(fields.errorCode, "error code");
      const event = `worker.publication_runtime_${fields.event}`;
      input.write({
        level: fields.event === "failed" ? "error" : "info",
        event,
        fields: {
          ...fields,
          failureCount: metric(fields.failureCount),
          suppressedFailureCount: metric(fields.suppressedFailureCount),
          durationMs: metric(fields.durationMs)
        }
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
      optionalToken(fields.errorCode, "error code");
      write("worker.storage_request", {
        ...fields, durationMs: metric(Math.round(fields.durationMs))
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
}

function metric(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0
    || value > Number.MAX_SAFE_INTEGER) {
    throw new Error("Document worker metric value is invalid");
  }
  return value;
}

function identity(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(value)) {
    throw new Error("Document worker identity is invalid");
  }
}

function optionalToken(
  value: string | null | undefined,
  label: string
): void {
  if (value !== undefined && value !== null
    && !/^[A-Za-z0-9_:-]{1,128}$/u.test(value)) {
    throw new Error(`Document worker ${label} is invalid`);
  }
}

function validateDiagnosticPath(value: string | null | undefined): void {
  if (value !== undefined && value !== null
    && (value.length > 512 || !/^[A-Za-z0-9._/%\-]+$/u.test(value))) {
    throw new Error("Document worker diagnostic path is invalid");
  }
}
