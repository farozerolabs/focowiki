import { createIngestionFailureFields } from "../../runtime/ingestion-failure.js";
import type {
  DocumentWorkRuntimeEvent
} from "../application/document-fixed-dag-runtime.js";
import type { DocumentProjectionScopeClaim } from
  "../application/document-scope-projector-runtime.js";
import type { DocumentWorkerObservability } from
  "../application/document-worker-observability.js";

type FailureObservability = Pick<
  DocumentWorkerObservability,
  "work" | "ingestionFailure"
>;

export function observeProductionDocumentWorkEvent(
  observability: FailureObservability | undefined,
  event: DocumentWorkRuntimeEvent
): void {
  if (event.event === "failed" && event.error !== undefined) {
    observability?.ingestionFailure(createIngestionFailureFields({
      stage: event.work.kind,
      error: event.error,
      errorCode: event.errorCode,
      retryable: event.retryable ?? null,
      attemptCount: event.work.attemptCount,
      knowledgeBaseId: event.work.knowledgeBaseId,
      documentJobPublicId: event.work.documentJobPublicId,
      workPublicId: event.work.publicId
    }));
    return;
  }
  observability?.work({
    event: event.event,
    workPublicId: event.work.publicId,
    documentJobPublicId: event.work.documentJobPublicId,
    workKind: event.work.kind,
    resourceLane: event.work.resourceLane,
    attemptCount: event.work.attemptCount,
    errorCode: event.errorCode,
    ...(event.errorConstraint === undefined
      ? {} : { errorConstraint: event.errorConstraint }),
    ...(event.errorResource === undefined
      ? {} : { errorResource: event.errorResource }),
    ...(event.errorTarget === undefined
      ? {} : { errorTarget: event.errorTarget })
  });
}

export function observeProductionScopeFailure(
  observability: Pick<DocumentWorkerObservability, "ingestionFailure"> | undefined,
  failure: {
    scope: DocumentProjectionScopeClaim;
    error: unknown;
    errorCode: string;
    retryable: boolean;
  }
): void {
  observability?.ingestionFailure(createIngestionFailureFields({
    stage: "scope_projection",
    error: failure.error,
    errorCode: failure.errorCode,
    retryable: failure.retryable,
    knowledgeBaseId: failure.scope.knowledgeBaseId,
    scopePublicId: failure.scope.publicId
  }));
}
