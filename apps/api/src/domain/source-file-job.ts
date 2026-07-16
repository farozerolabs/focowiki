export type SourceFileJobReason = "upload" | "retry" | "resource_operation";

export type SourceFileJobPayload = {
  reason: SourceFileJobReason;
};

export type SourceFilePublicationEligibility = "import" | "interactive";

const SOURCE_FILE_JOB_REASONS = new Set<SourceFileJobReason>([
  "upload",
  "retry",
  "resource_operation"
]);

export function createSourceFileJobPayload(reason: SourceFileJobReason): SourceFileJobPayload {
  return { reason };
}

export function parseSourceFileJobPayload(value: unknown): SourceFileJobPayload {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isSourceFileJobReason(value.reason)) {
    throw new Error("Invalid source-file worker job payload.");
  }

  return { reason: value.reason };
}

export function resolveSourceFilePublicationEligibility(
  reason: SourceFileJobReason
): SourceFilePublicationEligibility {
  return reason === "resource_operation" ? "interactive" : "import";
}

function isSourceFileJobReason(value: unknown): value is SourceFileJobReason {
  return typeof value === "string" && SOURCE_FILE_JOB_REASONS.has(value as SourceFileJobReason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
