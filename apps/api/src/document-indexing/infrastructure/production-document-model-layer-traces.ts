import type { DocumentJobContext } from
  "../application/document-job-context.js";
import { createDocumentModelLayerExecutionIdentity } from
  "../application/document-model-layer-execution.js";
import type { SemanticDocument } from "./production-document-types.js";
import { createPostgresDocumentModelLayerExecutionRepository } from
  "./postgres-document-model-layer-execution.js";
import { now } from "./production-document-processor-support.js";

type Repository = ReturnType<
  typeof createPostgresDocumentModelLayerExecutionRepository
>;

export async function recordEvaluationLayers(input: {
  repository: Repository;
  job: DocumentJobContext;
  modelName: string;
  execution: NonNullable<SemanticDocument["modelExecution"]>;
  warningCount: number;
  recordCandidateDelta?: boolean;
}): Promise<void> {
  const endedAt = now();
  await recordCompleted(input.repository, input.job, {
    layer: "first_layer",
    ownerIdentity: input.execution.firstLayer.ownerIdentity,
    modelName: input.modelName,
    selected: null,
    reused: input.execution.firstLayer.reused,
    providerRequestCount: input.execution.firstLayer.providerRequestCount,
    waitTimeMs: input.execution.firstLayer.waitTimeMs,
    serviceTimeMs: input.execution.firstLayer.serviceTimeMs,
    providerObservations: input.execution.firstLayer.providerObservations ?? [],
    warningCount: input.warningCount,
    endedAt
  });
  if (input.recordCandidateDelta === false) return;
  await recordCompleted(input.repository, input.job, {
    layer: "candidate_delta",
    ownerIdentity: input.execution.candidateDelta.ownerIdentity,
    modelName: input.modelName,
    selected: null,
    reused: input.execution.candidateDelta.providerRequestCount === 0,
    providerRequestCount: input.execution.candidateDelta.providerRequestCount,
    waitTimeMs: input.execution.candidateDelta.waitTimeMs,
    serviceTimeMs: input.execution.candidateDelta.serviceTimeMs,
    providerObservations: input.execution.candidateDelta.providerObservations ?? [],
    warningCount: input.warningCount,
    endedAt
  });
}

export async function recordCandidateDeltaLayer(input: {
  repository: Repository;
  job: DocumentJobContext;
  modelName: string;
  execution: NonNullable<SemanticDocument["modelExecution"]>["candidateDelta"];
  warningCount: number;
}): Promise<void> {
  await recordCompleted(input.repository, input.job, {
    layer: "candidate_delta",
    ownerIdentity: input.execution.ownerIdentity,
    modelName: input.modelName,
    selected: null,
    reused: input.execution.providerRequestCount === 0,
    providerRequestCount: input.execution.providerRequestCount,
    waitTimeMs: input.execution.waitTimeMs,
    serviceTimeMs: input.execution.serviceTimeMs,
    providerObservations: input.execution.providerObservations ?? [],
    warningCount: input.warningCount,
    endedAt: now()
  });
}

export async function recordFirstLayerFailure(input: {
  repository: Repository;
  job: DocumentJobContext;
  modelName: string;
  execution: FailedFirstLayerExecution;
  errorCode: string;
}): Promise<void> {
  const identity = createDocumentModelLayerExecutionIdentity({
    documentJobPublicId: input.job.publicId,
    layer: "first_layer",
    ownerIdentity: failedAttemptIdentity(
      input.execution.ownerIdentity,
      input.job.attemptCount
    )
  });
  const endedAt = now();
  await input.repository.record({
    ...identity,
    knowledgeBaseId: input.job.knowledgeBaseId,
    documentJobPublicId: input.job.publicId,
    sourceRevisionPublicId: input.job.sourceRevisionPublicId,
    layer: "first_layer",
    status: "failed",
    modelName: input.modelName,
    selected: null,
    reused: false,
    providerRequestCount: input.execution.providerRequestCount,
    waitTimeMs: input.execution.waitTimeMs,
    serviceTimeMs: input.execution.serviceTimeMs,
    providerObservations: input.execution.providerObservations,
    warningCount: 0,
    errorCode: input.errorCode,
    startedAt: startedAt(endedAt, input.execution),
    endedAt
  });
}

export async function recordGraphRagLayer(input: {
  repository: Repository;
  job: DocumentJobContext;
  modelName: string;
  selected: boolean;
  decisionSha256: string;
  providerRequestCount: number;
  waitTimeMs: number;
  serviceTimeMs: number;
  warningCount: number;
  reused: boolean;
  startedAt: string;
  errorCode: string | null;
}): Promise<void> {
  const identity = createDocumentModelLayerExecutionIdentity({
    documentJobPublicId: input.job.publicId,
    layer: "graphrag",
    ownerIdentity: input.errorCode === null
      ? input.decisionSha256
      : failedAttemptIdentity(input.decisionSha256, input.job.attemptCount)
  });
  await input.repository.record({
    ...identity,
    knowledgeBaseId: input.job.knowledgeBaseId,
    documentJobPublicId: input.job.publicId,
    sourceRevisionPublicId: input.job.sourceRevisionPublicId,
    layer: "graphrag",
    status: input.errorCode === null ? "completed" : "failed",
    modelName: input.modelName,
    selected: input.selected,
    reused: input.reused,
    providerRequestCount: input.providerRequestCount,
    waitTimeMs: input.waitTimeMs,
    serviceTimeMs: input.serviceTimeMs,
    providerObservations: [],
    warningCount: input.warningCount,
    errorCode: input.errorCode,
    startedAt: input.startedAt,
    endedAt: now()
  });
}

function failedAttemptIdentity(ownerIdentity: string, attemptCount: number): string {
  if (!ownerIdentity || !Number.isSafeInteger(attemptCount) || attemptCount < 1) {
    throw Object.assign(new Error("Document model failure identity is invalid"), {
      code: "document_model_failure_identity_invalid"
    });
  }
  return `${ownerIdentity}\u001ffailed-attempt:${attemptCount}`;
}

export function modelLayerErrorCode(error: unknown): string {
  const value = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  return typeof value === "string" && /^[A-Za-z0-9_]{1,128}$/u.test(value)
    ? value
    : "GRAPHRAG_MODEL_FAILED";
}

type FailedFirstLayerExecution = {
  ownerIdentity: string;
  providerRequestCount: number;
  waitTimeMs: number;
  serviceTimeMs: number;
  providerObservations: NonNullable<NonNullable<
    SemanticDocument["modelExecution"]
  >["firstLayer"]["providerObservations"]>;
};

export function failedFirstLayerExecution(
  error: unknown
): FailedFirstLayerExecution | null {
  if (typeof error !== "object" || error === null || !("execution" in error)) {
    return null;
  }
  const value = (error as { execution?: unknown }).execution;
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return typeof record.ownerIdentity === "string"
    && [record.providerRequestCount, record.waitTimeMs, record.serviceTimeMs]
      .every((item) => Number.isSafeInteger(item) && Number(item) >= 0)
    ? {
        ownerIdentity: record.ownerIdentity,
        providerRequestCount: Number(record.providerRequestCount),
        waitTimeMs: Number(record.waitTimeMs),
        serviceTimeMs: Number(record.serviceTimeMs),
        providerObservations: Array.isArray(record.providerObservations)
          ? record.providerObservations as FailedFirstLayerExecution["providerObservations"]
          : []
      }
    : null;
}

async function recordCompleted(
  repository: Repository,
  job: DocumentJobContext,
  input: {
    layer: "first_layer" | "candidate_delta";
    ownerIdentity: string;
    modelName: string;
    selected: null;
    reused: boolean;
    providerRequestCount: number;
    waitTimeMs: number;
    serviceTimeMs: number;
    providerObservations: NonNullable<NonNullable<
      SemanticDocument["modelExecution"]
    >["firstLayer"]["providerObservations"]>;
    warningCount: number;
    endedAt: string;
  }
): Promise<void> {
  const identity = createDocumentModelLayerExecutionIdentity({
    documentJobPublicId: job.publicId,
    layer: input.layer,
    ownerIdentity: input.ownerIdentity
  });
  await repository.record({
    ...identity,
    knowledgeBaseId: job.knowledgeBaseId,
    documentJobPublicId: job.publicId,
    sourceRevisionPublicId: job.sourceRevisionPublicId,
    layer: input.layer,
    status: "completed",
    modelName: input.modelName,
    selected: input.selected,
    reused: input.reused,
    providerRequestCount: input.providerRequestCount,
    waitTimeMs: input.waitTimeMs,
    serviceTimeMs: input.serviceTimeMs,
    providerObservations: input.providerObservations,
    warningCount: input.warningCount,
    errorCode: null,
    startedAt: startedAt(input.endedAt, input),
    endedAt: input.endedAt
  });
}

function startedAt(
  endedAt: string,
  input: { waitTimeMs: number; serviceTimeMs: number }
): string {
  return new Date(Date.parse(endedAt)
    - input.waitTimeMs - input.serviceTimeMs).toISOString();
}
