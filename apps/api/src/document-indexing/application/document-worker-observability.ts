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
    cleanup(fields: {
      claimed: number;
      completed: number;
      retried: number;
      failed: number;
    }) {
      write("worker.cleanup_metrics", {
        claimed: metric(fields.claimed),
        completed: metric(fields.completed),
        retried: metric(fields.retried),
        failed: metric(fields.failed)
      });
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

function validateDiagnosticPath(value: string | null | undefined): void {
  if (value !== undefined && value !== null
    && (value.length > 512 || !/^[A-Za-z0-9._/%\-]+$/u.test(value))) {
    throw new Error("Document worker diagnostic path is invalid");
  }
}
