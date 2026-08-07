import type {
  StorageVnextBoundedResult,
  StorageVnextLiveWork,
  StorageVnextWorkKind
} from "./ports.js";
import { isSearchProviderKind, type SearchProviderKind } from
  "../../application/ports/search-provider-runtime.js";

export type StorageVnextWorkflowRepositoryErrorCode =
  | "invalid_input"
  | "invalid_cursor"
  | "idempotency_conflict"
  | "operation_conflict"
  | "lease_lost";

export class StorageVnextWorkflowRepositoryError extends Error {
  public constructor(public readonly code: StorageVnextWorkflowRepositoryErrorCode) {
    super(`Storage vNext workflow repository error: ${code}`);
    this.name = "StorageVnextWorkflowRepositoryError";
  }
}

export type StorageVnextLiveWorkRow = {
  operation_public_id: string;
  knowledge_base_id: string;
  work_kind: StorageVnextWorkKind;
  search_provider_kind: SearchProviderKind | null;
  state: "queued" | "running" | "retry";
  operation_revision: number | string;
  settings_revision_public_id: string;
  attempt_count: number | string;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  next_attempt_at: Date | string | null;
  safe_error_code: string | null;
  checkpoint: Record<string, boolean | number | string | null>;
  idempotency_key: string;
  request_hash: string;
  idempotency_expires_at: Date | string;
};

export type StorageVnextResultRow = {
  public_id: string;
  knowledge_base_id: string;
  operation_kind: StorageVnextWorkKind;
  terminal_state: StorageVnextBoundedResult["state"];
  result_code: string;
  safe_message: string | null;
  result_summary: Record<string, boolean | number | string | null>;
  correlation_public_id: string | null;
  completed_at: Date | string;
  expires_at: Date | string;
};

type ResultCursor = {
  version: 1;
  knowledgeBaseId: string;
  completedAt: string;
  publicId: string;
};

export const STORAGE_VNEXT_WORK_KINDS: readonly StorageVnextWorkKind[] = [
  "upload",
  "source",
  "graph",
  "publication",
  "search",
  "mutation",
  "deletion",
  "maintenance",
  "reconciliation",
  "webhook"
];

const LIVE_STATES: readonly StorageVnextLiveWork["state"][] = [
  "queued",
  "running",
  "retry"
];

const TERMINAL_STATES: readonly StorageVnextBoundedResult["state"][] = [
  "completed",
  "failed",
  "cancelled",
  "superseded",
  "timed_out",
  "deleted"
];

export function mapStorageVnextLiveWork(
  row: StorageVnextLiveWorkRow
): StorageVnextLiveWork {
  if (!STORAGE_VNEXT_WORK_KINDS.includes(row.work_kind) || !LIVE_STATES.includes(row.state)) {
    throw storageVnextWorkflowRepositoryError("operation_conflict");
  }
  assertSearchProviderOwnership(
    row.work_kind,
    row.search_provider_kind,
    "operation_conflict"
  );
  return {
    publicId: row.operation_public_id,
    knowledgeBaseId: row.knowledge_base_id,
    kind: row.work_kind,
    searchProviderKind: row.search_provider_kind,
    state: row.state,
    operationRevision: toSafeInteger(row.operation_revision),
    settingsRevisionPublicId: row.settings_revision_public_id,
    attempt: toSafeInteger(row.attempt_count),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: nullableTimestamp(row.lease_expires_at),
    nextAttemptAt: nullableTimestamp(row.next_attempt_at),
    safeErrorCode: row.safe_error_code,
    checkpoint: row.checkpoint,
    idempotency: {
      key: row.idempotency_key,
      requestHash: row.request_hash,
      expiresAt: timestamp(row.idempotency_expires_at)
    }
  };
}

export function mapStorageVnextResult(
  row: StorageVnextResultRow
): StorageVnextBoundedResult {
  if (
    !STORAGE_VNEXT_WORK_KINDS.includes(row.operation_kind)
    || !TERMINAL_STATES.includes(row.terminal_state)
  ) {
    throw storageVnextWorkflowRepositoryError("operation_conflict");
  }
  return {
    publicId: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    kind: row.operation_kind,
    state: row.terminal_state,
    resultCode: row.result_code,
    safeMessage: row.safe_message,
    summary: row.result_summary,
    correlationPublicId: row.correlation_public_id,
    completedAt: timestamp(row.completed_at),
    expiresAt: timestamp(row.expires_at)
  };
}

export function assertStorageVnextLiveWork(work: StorageVnextLiveWork): void {
  assertStorageVnextIdentifier(work.publicId, 255);
  assertStorageVnextIdentifier(work.knowledgeBaseId, 255);
  assertStorageVnextIdentifier(work.settingsRevisionPublicId, 255);
  if (!STORAGE_VNEXT_WORK_KINDS.includes(work.kind) || !LIVE_STATES.includes(work.state)) {
    throw storageVnextWorkflowRepositoryError("invalid_input");
  }
  assertSearchProviderOwnership(work.kind, work.searchProviderKind, "invalid_input");
  if (!Number.isSafeInteger(work.operationRevision) || work.operationRevision < 0) {
    throw storageVnextWorkflowRepositoryError("invalid_input");
  }
  if (!Number.isSafeInteger(work.attempt) || work.attempt < 0) {
    throw storageVnextWorkflowRepositoryError("invalid_input");
  }
  const hasLease = work.leaseOwner !== null && work.leaseExpiresAt !== null;
  if ((work.state === "running") !== hasLease) {
    throw storageVnextWorkflowRepositoryError("invalid_input");
  }
  if (work.leaseOwner) assertStorageVnextIdentifier(work.leaseOwner, 255);
  if (work.leaseExpiresAt) assertStorageVnextTimestamp(work.leaseExpiresAt);
  if (work.nextAttemptAt) assertStorageVnextTimestamp(work.nextAttemptAt);
  if (work.safeErrorCode) assertStorageVnextIdentifier(work.safeErrorCode, 128);
  assertStorageVnextMetadata(work.checkpoint, 32_768);
  assertStorageVnextIdentifier(work.idempotency.key, 255);
  assertStorageVnextChecksum(work.idempotency.requestHash);
  const expiresAt = assertStorageVnextTimestamp(work.idempotency.expiresAt);
  if (expiresAt.getTime() <= Date.now()) {
    throw storageVnextWorkflowRepositoryError("invalid_input");
  }
}

function assertSearchProviderOwnership(
  workKind: StorageVnextWorkKind,
  providerKind: SearchProviderKind | null,
  errorCode: StorageVnextWorkflowRepositoryErrorCode
): void {
  const needsProvider = workKind === "search" || workKind === "maintenance";
  const validProvider = isSearchProviderKind(providerKind);
  if (needsProvider !== validProvider) {
    throw storageVnextWorkflowRepositoryError(errorCode);
  }
}

export function assertStorageVnextBoundedResult(result: StorageVnextBoundedResult): void {
  assertStorageVnextIdentifier(result.publicId, 255);
  assertStorageVnextIdentifier(result.knowledgeBaseId, 255);
  if (
    !STORAGE_VNEXT_WORK_KINDS.includes(result.kind)
    || !TERMINAL_STATES.includes(result.state)
  ) {
    throw storageVnextWorkflowRepositoryError("invalid_input");
  }
  assertStorageVnextIdentifier(result.resultCode, 128);
  if (result.safeMessage !== null && Buffer.byteLength(result.safeMessage, "utf8") > 2_048) {
    throw storageVnextWorkflowRepositoryError("invalid_input");
  }
  if (result.correlationPublicId !== null) {
    assertStorageVnextIdentifier(result.correlationPublicId, 255);
  }
  assertStorageVnextMetadata(result.summary, 32_768);
  const completedAt = assertStorageVnextTimestamp(result.completedAt);
  const expiresAt = assertStorageVnextTimestamp(result.expiresAt);
  if (expiresAt.getTime() <= completedAt.getTime()) {
    throw storageVnextWorkflowRepositoryError("invalid_input");
  }
}

export function sameStorageVnextResult(
  left: StorageVnextBoundedResult,
  right: StorageVnextBoundedResult
): boolean {
  return left.publicId === right.publicId
    && left.knowledgeBaseId === right.knowledgeBaseId
    && left.kind === right.kind
    && left.state === right.state
    && left.resultCode === right.resultCode
    && left.safeMessage === right.safeMessage
    && left.correlationPublicId === right.correlationPublicId
    && left.completedAt === right.completedAt
    && left.expiresAt === right.expiresAt
    && stableMetadata(left.summary) === stableMetadata(right.summary);
}

export function assertStorageVnextWorkflowLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw storageVnextWorkflowRepositoryError("invalid_input");
  }
  return limit;
}

export function assertStorageVnextIdentifier(value: string, maxBytes: number): void {
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw storageVnextWorkflowRepositoryError("invalid_input");
  }
}

export function assertStorageVnextChecksum(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw storageVnextWorkflowRepositoryError("invalid_input");
  }
}

export function assertStorageVnextMetadata(value: object, maxBytes: number): void {
  if (
    Array.isArray(value)
    || value === null
    || Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes
  ) {
    throw storageVnextWorkflowRepositoryError("invalid_input");
  }
}

export function assertStorageVnextTimestamp(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw storageVnextWorkflowRepositoryError("invalid_input");
  }
  return parsed;
}

export function encodeStorageVnextResultCursor(cursor: ResultCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeStorageVnextResultCursor(
  value: string | null,
  knowledgeBaseId: string
): ResultCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as ResultCursor;
    if (
      parsed.version !== 1
      || parsed.knowledgeBaseId !== knowledgeBaseId
      || typeof parsed.publicId !== "string"
      || typeof parsed.completedAt !== "string"
    ) {
      throw storageVnextWorkflowRepositoryError("invalid_cursor");
    }
    assertStorageVnextTimestamp(parsed.completedAt);
    assertStorageVnextIdentifier(parsed.publicId, 255);
    return parsed;
  } catch (error) {
    if (error instanceof StorageVnextWorkflowRepositoryError) throw error;
    throw storageVnextWorkflowRepositoryError("invalid_cursor");
  }
}

export function storageVnextWorkflowRepositoryError(
  code: StorageVnextWorkflowRepositoryErrorCode
): StorageVnextWorkflowRepositoryError {
  return new StorageVnextWorkflowRepositoryError(code);
}

function timestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw storageVnextWorkflowRepositoryError("operation_conflict");
  }
  return parsed.toISOString();
}

function nullableTimestamp(value: Date | string | null): string | null {
  return value === null ? null : timestamp(value);
}

function toSafeInteger(value: number | string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw storageVnextWorkflowRepositoryError("operation_conflict");
  }
  return parsed;
}

function stableMetadata(value: Record<string, boolean | number | string | null>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right, "en")
  )));
}
