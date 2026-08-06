import { createHash } from "node:crypto";
import type { StorageVnextActiveSnapshot } from "../transactions/ports.js";
import {
  MAX_STORAGE_VNEXT_RELEASE_PAGE_SIZE,
  MAX_STORAGE_VNEXT_RELEASE_WRITE_BATCH,
  type StorageVnextCandidateChangedFact,
  type StorageVnextCandidateDelta,
  type StorageVnextCandidateDependency,
  type StorageVnextCandidateValidationReceipt,
  type StorageVnextDirectorySummary,
  type StorageVnextKnowledgeBaseSummary,
  type StorageVnextReleaseCatalogEntry,
  type StorageVnextReleaseEventSummary,
  type StorageVnextReleaseRoot,
  type StorageVnextShardDescriptor
} from "./ports.js";

export type StorageVnextReleaseRepositoryErrorCode =
  | "invalid_input"
  | "invalid_cursor"
  | "scope_conflict"
  | "stale_active_root"
  | "live_candidate_exists"
  | "candidate_not_writable"
  | "candidate_limit_exceeded"
  | "object_not_verified"
  | "descriptor_conflict";

export class StorageVnextReleaseRepositoryError extends Error {
  public constructor(public readonly code: StorageVnextReleaseRepositoryErrorCode) {
    super(`Storage vNext release repository error: ${code}`);
    this.name = "StorageVnextReleaseRepositoryError";
  }
}

export type StorageVnextReleaseRootRow = {
  public_id: string;
  knowledge_base_id: string;
  root_role: "active" | "candidate" | "rollback";
  manifest_checksum_sha256: string | null;
  revision: number | string;
  created_at: Date | string;
  expires_at: Date | string | null;
};

export type StorageVnextReleaseCandidateRow = {
  public_id: string;
  knowledge_base_id: string;
  operation_public_id: string;
  candidate_root_public_id: string;
  expected_active_root_public_id: string | null;
  expected_active_revision: number | string;
  state: "building" | "validating" | "ready";
  changed_fact_count: number | string;
  affected_dependency_count: number | string;
  manifest_checksum_sha256: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export type StorageVnextReleaseShardRow = {
  public_id: string;
  logical_kind: string;
  first_logical_path: string;
  last_logical_path: string;
  record_count: number | string;
  byte_count: number | string;
  checksum_sha256: string;
  object_id: string;
  ordinal: number | string;
};

export type StorageVnextReleaseCatalogRow = {
  logical_path: string;
  entry_kind: StorageVnextReleaseCatalogEntry["kind"];
  source_file_public_id: string | null;
  checksum_sha256: string;
  object_id: string;
  byte_count: number | string;
  ordinal: number | string;
};

export type StorageVnextReleaseDirectorySummaryRow = {
  directory_public_id: string | null;
  logical_path: string;
  first_leaf_path: string | null;
  direct_file_count: number | string;
  descendant_file_count: number | string;
  ordinal: number | string;
};

export type StorageVnextReleaseKnowledgeBaseSummaryRow = {
  source_file_count: number | string;
  directory_count: number | string;
  generated_entry_count: number | string;
  graph_node_count: number | string;
  graph_edge_count: number | string;
  generated_byte_count: number | string;
};

export type StorageVnextReleaseEventRow = {
  public_id: string;
  knowledge_base_id: string;
  operation_public_id: string;
  candidate_public_id: string;
  release_root_public_id: string | null;
  outcome: StorageVnextReleaseEventSummary["outcome"];
  result_code: string;
  safe_message: string | null;
  revision: number | string;
  created_at: Date | string;
  expires_at: Date | string;
};

type ReleaseCursor = {
  kind: "candidate_dependency" | "candidate_fact" | "candidate_shard"
    | "directory_summary" | "release_event" | "root_catalog";
  scope: string;
  sort: string;
  publicId: string;
};

export function assertStorageVnextExpectedActive(
  active: StorageVnextActiveSnapshot | null,
  input: { expectedActiveRootPublicId: string | null; expectedActiveRevision: number }
): void {
  if (
    (active?.releaseRootPublicId ?? null) !== input.expectedActiveRootPublicId
    || (active?.revision ?? 0) !== input.expectedActiveRevision
  ) {
    throw new StorageVnextReleaseRepositoryError("stale_active_root");
  }
}

export function storageVnextStaleResult(active: StorageVnextActiveSnapshot | null) {
  return {
    outcome: "stale" as const,
    activeRootPublicId: active?.releaseRootPublicId ?? null,
    activeRevision: active?.revision ?? 0
  };
}

export function validateStorageVnextCandidateCreation(input: {
  publicId: string;
  knowledgeBaseId: string;
  operationPublicId: string;
  candidateRootPublicId: string;
  expectedActiveRevision: number;
  changedFacts: readonly StorageVnextCandidateChangedFact[];
  dependencies: readonly StorageVnextCandidateDependency[];
  idempotency: { key: string; requestHash: string };
  createdAt: string;
}): void {
  if (
    !input.publicId
    || !input.knowledgeBaseId
    || !input.operationPublicId
    || !input.candidateRootPublicId
    || input.publicId === input.candidateRootPublicId
    || !Number.isSafeInteger(input.expectedActiveRevision)
    || input.expectedActiveRevision < 0
    || !input.idempotency.key
    || !/^[0-9a-f]{64}$/u.test(input.idempotency.requestHash)
    || !isStorageVnextReleaseTimestamp(input.createdAt)
  ) {
    throw new StorageVnextReleaseRepositoryError("invalid_input");
  }
  validateStorageVnextFactBatch(input.changedFacts, input.dependencies);
}

export function validateStorageVnextFactBatch(
  facts: readonly StorageVnextCandidateChangedFact[],
  dependencies: readonly StorageVnextCandidateDependency[]
): void {
  if (
    facts.length > MAX_STORAGE_VNEXT_RELEASE_WRITE_BATCH
    || dependencies.length > MAX_STORAGE_VNEXT_RELEASE_WRITE_BATCH
  ) {
    throw new StorageVnextReleaseRepositoryError("candidate_limit_exceeded");
  }
  const factKeys = new Set<string>();
  for (const fact of facts) {
    const key = `${fact.kind}\u0000${fact.publicId}`;
    if (!fact.publicId || factKeys.has(key)) {
      throw new StorageVnextReleaseRepositoryError("invalid_input");
    }
    factKeys.add(key);
  }
  const dependencyKeys = new Set<string>();
  for (const dependency of dependencies) {
    const key = `${dependency.kind}\u0000${dependency.publicId}`;
    if (
      !dependency.publicId
      || !dependency.reasonCode
      || dependency.reasonCode.length > 128
      || dependencyKeys.has(key)
    ) {
      throw new StorageVnextReleaseRepositoryError("invalid_input");
    }
    dependencyKeys.add(key);
  }
}

export function validateStorageVnextShardBatch(
  shards: readonly StorageVnextShardDescriptor[]
): void {
  if (shards.length > MAX_STORAGE_VNEXT_RELEASE_WRITE_BATCH) {
    throw new StorageVnextReleaseRepositoryError("candidate_limit_exceeded");
  }
  const publicIds = new Set<string>();
  const slots = new Set<string>();
  for (const shard of shards) {
    const slot = shard.logicalKind === "directory_navigation"
      ? `${shard.logicalKind}\u0000${shard.firstLogicalPath}\u0000${shard.ordinal}`
      : `${shard.logicalKind}\u0000${shard.ordinal}`;
    if (
      !shard.publicId
      || !shard.logicalKind
      || !shard.firstLogicalPath
      || shard.firstLogicalPath > shard.lastLogicalPath
      || !Number.isSafeInteger(shard.recordCount)
      || shard.recordCount < 0
      || !Number.isSafeInteger(shard.byteCount)
      || shard.byteCount < 0
      || !Number.isSafeInteger(shard.ordinal)
      || shard.ordinal < 0
      || !shard.objectId
      || !/^[0-9a-f]{64}$/u.test(shard.checksum)
      || publicIds.has(shard.publicId)
      || slots.has(slot)
    ) {
      throw new StorageVnextReleaseRepositoryError("invalid_input");
    }
    publicIds.add(shard.publicId);
    slots.add(slot);
  }
}

export function validateStorageVnextCatalogBatch(
  entries: readonly StorageVnextReleaseCatalogEntry[]
): void {
  if (entries.length > MAX_STORAGE_VNEXT_RELEASE_WRITE_BATCH) {
    throw new StorageVnextReleaseRepositoryError("candidate_limit_exceeded");
  }
  const paths = new Set<string>();
  const ordinals = new Set<number>();
  for (const entry of entries) {
    if (
      !entry.logicalPath
      || !entry.objectId
      || !/^[0-9a-f]{64}$/u.test(entry.checksum)
      || !Number.isSafeInteger(entry.byteCount)
      || entry.byteCount < 0
      || !Number.isSafeInteger(entry.ordinal)
      || entry.ordinal < 0
      || (entry.kind === "source") !== Boolean(entry.sourceFilePublicId)
      || paths.has(entry.logicalPath)
      || ordinals.has(entry.ordinal)
    ) {
      throw new StorageVnextReleaseRepositoryError("invalid_input");
    }
    paths.add(entry.logicalPath);
    ordinals.add(entry.ordinal);
  }
}

export function validateStorageVnextCatalogTombstones(
  logicalPaths: readonly string[]
): void {
  if (
    logicalPaths.length > MAX_STORAGE_VNEXT_RELEASE_WRITE_BATCH
    || new Set(logicalPaths).size !== logicalPaths.length
    || logicalPaths.some((logicalPath) =>
      !logicalPath || Buffer.byteLength(logicalPath, "utf8") > 4_096)
  ) {
    throw new StorageVnextReleaseRepositoryError("invalid_input");
  }
}

export function validateStorageVnextSummaries(
  directories: readonly StorageVnextDirectorySummary[],
  knowledgeBase: StorageVnextKnowledgeBaseSummary
): void {
  const directoryIds = new Set<string>();
  const directoryPaths = new Set<string>();
  const ordinals = new Set<number>();
  for (const item of directories) {
    if (
      !item.logicalPath
      || (item.directoryPublicId === null && item.logicalPath !== "pages")
      || !isStorageVnextNonnegativeInteger(item.directFileCount)
      || !isStorageVnextNonnegativeInteger(item.descendantFileCount)
      || item.descendantFileCount < item.directFileCount
      || !isStorageVnextNonnegativeInteger(item.ordinal)
      || (item.directoryPublicId !== null && directoryIds.has(item.directoryPublicId))
      || directoryPaths.has(item.logicalPath)
      || ordinals.has(item.ordinal)
    ) {
      throw new StorageVnextReleaseRepositoryError("invalid_input");
    }
    if (item.directoryPublicId !== null) directoryIds.add(item.directoryPublicId);
    directoryPaths.add(item.logicalPath);
    ordinals.add(item.ordinal);
  }
  if (!Object.values(knowledgeBase).every(isStorageVnextNonnegativeInteger)) {
    throw new StorageVnextReleaseRepositoryError("invalid_input");
  }
}

export function validateStorageVnextActivation(input: {
  knowledgeBaseId: string;
  candidatePublicId: string;
  expectedActiveRevision: number;
  searchProjectionPublicId: string;
  rollbackExpiresAt: string | null;
  eventPublicId: string;
  eventExpiresAt: string;
  activatedAt: string;
}): void {
  if (
    !input.knowledgeBaseId
    || !input.candidatePublicId
    || !input.searchProjectionPublicId
    || !input.eventPublicId
    || !isStorageVnextNonnegativeInteger(input.expectedActiveRevision)
    || !isStorageVnextReleaseTimestamp(input.activatedAt)
    || !isStorageVnextReleaseTimestamp(input.eventExpiresAt)
    || new Date(input.eventExpiresAt) <= new Date(input.activatedAt)
    || (
      input.rollbackExpiresAt !== null
      && (
        !isStorageVnextReleaseTimestamp(input.rollbackExpiresAt)
        || new Date(input.rollbackExpiresAt) <= new Date(input.activatedAt)
      )
    )
  ) {
    throw new StorageVnextReleaseRepositoryError("invalid_input");
  }
}

export function validateStorageVnextCandidateValidationReceipt(
  input: StorageVnextCandidateValidationReceipt
): void {
  assertStorageVnextReleaseChecksum(input.manifestChecksum);
  if (
    !input.candidatePublicId
    || !input.searchProjectionPublicId
    || !isStorageVnextReleaseTimestamp(input.validatedAt)
    || ![
      input.objectOwnerCount,
      input.searchDocumentCount,
      input.graphNodeCount,
      input.graphEdgeCount,
      input.linkCount,
      input.generatedEntryCount
    ].every(isStorageVnextNonnegativeInteger)
  ) {
    throw new StorageVnextReleaseRepositoryError("invalid_input");
  }
}

export function storageVnextCandidateValidationPassed(
  input: StorageVnextCandidateValidationReceipt
): boolean {
  return input.objectValidationPassed === true
    && input.searchValidationPassed === true
    && input.graphValidationPassed === true
    && input.linkValidationPassed === true
    && input.countValidationPassed === true
    && input.pathValidationPassed === true;
}

export function validateStorageVnextTerminalInput(input: {
  knowledgeBaseId: string;
  candidatePublicId: string;
  reasonCode: string;
  safeMessage: string | null;
  eventPublicId: string;
  eventExpiresAt: string;
  terminatedAt: string;
}): void {
  if (
    !input.knowledgeBaseId
    || !input.candidatePublicId
    || !input.eventPublicId
    || !input.reasonCode
    || input.reasonCode.length > 128
    || (input.safeMessage?.length ?? 0) > 2_048
  ) {
    throw new StorageVnextReleaseRepositoryError("invalid_input");
  }
  assertStorageVnextTimestampOrder(input.terminatedAt, input.eventExpiresAt);
}

export function assertStorageVnextTimestampOrder(
  createdAt: string,
  expiresAt: string
): void {
  if (
    !isStorageVnextReleaseTimestamp(createdAt)
    || !isStorageVnextReleaseTimestamp(expiresAt)
    || new Date(expiresAt) <= new Date(createdAt)
  ) {
    throw new StorageVnextReleaseRepositoryError("invalid_input");
  }
}

export function assertStorageVnextReleaseChecksum(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new StorageVnextReleaseRepositoryError("invalid_input");
  }
}

export function assertStorageVnextReleasePageLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_STORAGE_VNEXT_RELEASE_PAGE_SIZE) {
    throw new StorageVnextReleaseRepositoryError("invalid_input");
  }
  return limit;
}

export function encodeStorageVnextReleaseCursor(cursor: ReleaseCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeStorageVnextReleaseCursor(
  cursor: string | null,
  kind: ReleaseCursor["kind"],
  scope: string
): ReleaseCursor | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || value.kind !== kind
      || value.scope !== scope
      || typeof value.sort !== "string"
      || typeof value.publicId !== "string"
      || !value.publicId
    ) {
      throw new Error("invalid cursor");
    }
    return value as ReleaseCursor;
  } catch {
    throw new StorageVnextReleaseRepositoryError("invalid_cursor");
  }
}

export function storageVnextReleasePage<T>(
  items: T[],
  hasMore: boolean,
  encode: (item: T) => string
): { items: readonly T[]; nextCursor: string | null } {
  return {
    items,
    nextCursor: hasMore && items.at(-1) ? encode(items.at(-1)!) : null
  };
}

export function mapStorageVnextReleaseRoot(
  row: StorageVnextReleaseRootRow
): StorageVnextReleaseRoot {
  return {
    publicId: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    role: row.root_role,
    manifestChecksum: row.manifest_checksum_sha256,
    revision: Number(row.revision),
    createdAt: storageVnextReleaseTimestamp(row.created_at),
    expiresAt: row.expires_at ? storageVnextReleaseTimestamp(row.expires_at) : null
  };
}

export function mapStorageVnextCandidate(
  row: StorageVnextReleaseCandidateRow
): StorageVnextCandidateDelta {
  return {
    publicId: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    operationPublicId: row.operation_public_id,
    candidateRootPublicId: row.candidate_root_public_id,
    expectedActiveRootPublicId: row.expected_active_root_public_id,
    expectedActiveRevision: Number(row.expected_active_revision),
    state: row.state,
    changedFactCount: Number(row.changed_fact_count),
    affectedDependencyCount: Number(row.affected_dependency_count),
    manifestChecksum: row.manifest_checksum_sha256,
    createdAt: storageVnextReleaseTimestamp(row.created_at),
    updatedAt: storageVnextReleaseTimestamp(row.updated_at)
  };
}

export function mapStorageVnextShard(
  row: StorageVnextReleaseShardRow
): StorageVnextShardDescriptor {
  return {
    publicId: row.public_id,
    logicalKind: row.logical_kind,
    firstLogicalPath: row.first_logical_path,
    lastLogicalPath: row.last_logical_path,
    recordCount: Number(row.record_count),
    byteCount: Number(row.byte_count),
    checksum: row.checksum_sha256,
    objectId: row.object_id,
    ordinal: Number(row.ordinal)
  };
}

export function mapStorageVnextCatalogEntry(
  row: StorageVnextReleaseCatalogRow
): StorageVnextReleaseCatalogEntry {
  return {
    logicalPath: row.logical_path,
    kind: row.entry_kind,
    sourceFilePublicId: row.source_file_public_id,
    checksum: row.checksum_sha256,
    objectId: row.object_id,
    byteCount: Number(row.byte_count),
    ordinal: Number(row.ordinal)
  };
}

export function mapStorageVnextDirectorySummary(
  row: StorageVnextReleaseDirectorySummaryRow
): StorageVnextDirectorySummary {
  return {
    directoryPublicId: row.directory_public_id,
    logicalPath: row.logical_path,
    firstLeafPath: row.first_leaf_path,
    directFileCount: Number(row.direct_file_count),
    descendantFileCount: Number(row.descendant_file_count),
    ordinal: Number(row.ordinal)
  };
}

export function mapStorageVnextKnowledgeBaseSummary(
  row: StorageVnextReleaseKnowledgeBaseSummaryRow
): StorageVnextKnowledgeBaseSummary {
  return {
    sourceFileCount: Number(row.source_file_count),
    directoryCount: Number(row.directory_count),
    generatedEntryCount: Number(row.generated_entry_count),
    graphNodeCount: Number(row.graph_node_count),
    graphEdgeCount: Number(row.graph_edge_count),
    generatedByteCount: Number(row.generated_byte_count)
  };
}

export function mapStorageVnextReleaseEvent(
  row: StorageVnextReleaseEventRow
): StorageVnextReleaseEventSummary {
  return {
    publicId: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    operationPublicId: row.operation_public_id,
    candidatePublicId: row.candidate_public_id,
    releaseRootPublicId: row.release_root_public_id,
    outcome: row.outcome,
    resultCode: row.result_code,
    safeMessage: row.safe_message,
    revision: Number(row.revision),
    createdAt: storageVnextReleaseTimestamp(row.created_at),
    expiresAt: storageVnextReleaseTimestamp(row.expires_at)
  };
}

export function storageVnextRootOwnerPublicId(
  objectId: string,
  rootPublicId: string
): string {
  return `owner-${createHash("sha256")
    .update(`release-root\u0000${rootPublicId}\u0000${objectId}`)
    .digest("hex")}`;
}

export function isStorageVnextNonnegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function uniqueStorageVnextValues(values: string[]): string[] {
  return [...new Set(values)];
}

export function storageVnextReleaseTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function isStorageVnextReleaseTimestamp(value: string): boolean {
  return Boolean(value) && Number.isFinite(Date.parse(value));
}
