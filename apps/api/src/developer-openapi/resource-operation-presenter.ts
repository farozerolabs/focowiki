import type { ResourceOperationRecord } from "../domain/source-resource.js";

const PROGRESS_FIELDS = [
  "totalCount",
  "waitingCount",
  "processingCount",
  "availableCount",
  "failedCount",
  "deletingCount",
  "cancelledCount",
  "supersededCount"
] as const;

export function presentDeveloperResourceOperation(
  operation: ResourceOperationRecord
) {
  const base = `/openapi/v2/knowledge-bases/${operation.knowledgeBaseId}`;
  const state = publicOperationState(operation.state);
  return {
    operationId: operation.id,
    knowledgeBaseId: operation.knowledgeBaseId,
    kind: operation.kind,
    state,
    expectedResourceRevision: operation.expectedResourceRevision,
    targetKind: operation.targetKind ?? null,
    targetId: operation.targetId ?? null,
    candidateRelativePath: operation.candidateRelativePath ?? null,
    result: presentOperationResult(operation),
    errorCode: operation.errorCode,
    retryGuidance: isProgressing(state)
      ? "Check this change again after a short delay."
      : null,
    actions: { self: `${base}/operations/${operation.id}` },
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    completedAt: state === "processing" ? null : operation.completedAt
  };
}

function publicOperationState(
  state: ResourceOperationRecord["state"]
): "processing" | "completed" | "failed" | "cancelled" | "superseded" {
  switch (state) {
    case "accepted":
    case "validating":
    case "processing":
      return "processing";
    case "completed":
    case "failed":
    case "cancelled":
    case "superseded":
      return state;
  }
}

function presentOperationResult(
  operation: ResourceOperationRecord
): Record<string, number> | null {
  if (!["upload", "source_directory_move"].includes(operation.kind)) {
    return null;
  }
  const result = operation.result ?? {};
  return Object.fromEntries(PROGRESS_FIELDS.map((field) => [
    field,
    publicCount(result[field])
  ]));
}

function publicCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Invalid public operation progress count");
  }
  return parsed;
}

function isProgressing(state: ReturnType<typeof publicOperationState>): boolean {
  return state === "processing";
}
