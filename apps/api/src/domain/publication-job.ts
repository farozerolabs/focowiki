export type PublicationJobMode = "batch" | "manual" | "per_file";

export type PublicationJobReason =
  | "bootstrap"
  | "batch_threshold"
  | "batch_interval"
  | "manual"
  | "per_file"
  | "metadata"
  | "deletion";

export type PublicationJobPayload = {
  reason: PublicationJobReason;
  targetCatalogGeneration: number;
};

const PUBLICATION_JOB_REASONS = new Set<PublicationJobReason>([
  "bootstrap",
  "batch_threshold",
  "batch_interval",
  "manual",
  "per_file",
  "metadata",
  "deletion"
]);

const REASON_PRIORITY: Record<PublicationJobReason, number> = {
  batch_interval: 0,
  bootstrap: 1,
  batch_threshold: 2,
  per_file: 3,
  manual: 4,
  metadata: 5,
  deletion: 6
};

export function createPublicationJobPayload(
  reason: PublicationJobReason,
  targetCatalogGeneration: number
): PublicationJobPayload {
  return parsePublicationJobPayload({ reason, targetCatalogGeneration });
}

export function parsePublicationJobPayload(value: unknown): PublicationJobPayload {
  if (!isRecord(value)) {
    throw invalidPayload();
  }

  const keys = Object.keys(value);
  if (
    keys.length !== 2
    || !keys.includes("reason")
    || !keys.includes("targetCatalogGeneration")
    || !isPublicationJobReason(value.reason)
    || !Number.isSafeInteger(value.targetCatalogGeneration)
    || (value.targetCatalogGeneration as number) < 0
  ) {
    throw invalidPayload();
  }

  return {
    reason: value.reason,
    targetCatalogGeneration: value.targetCatalogGeneration as number
  };
}

export function mergePublicationJobReason(
  current: PublicationJobReason,
  requested: PublicationJobReason
): PublicationJobReason {
  return REASON_PRIORITY[requested] > REASON_PRIORITY[current] ? requested : current;
}

function isPublicationJobReason(value: unknown): value is PublicationJobReason {
  return typeof value === "string" && PUBLICATION_JOB_REASONS.has(value as PublicationJobReason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidPayload(): Error {
  return new Error("Invalid publication job payload.");
}
