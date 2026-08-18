import type { DatabaseClient } from "../../db/client.js";
import { isSearchProviderKind, type SearchProviderKind } from
  "../../application/ports/search-provider-runtime.js";
import type {
  StorageVnextBoundedMetadata,
  StorageVnextIdempotency,
  StorageVnextKnowledgeBaseId,
  StorageVnextPublicId,
  StorageVnextTimestamp
} from "../shared/types.js";
export type StorageVnextCleanupTarget = {
  publicId: StorageVnextPublicId;
  resourceKind: string;
  plane: "postgres" | "object_storage" | "search" | "redis" | "process";
  required: boolean;
  sequence: number;
};

export type StorageVnextCleanupAction = {
  publicId: StorageVnextPublicId;
  operationPublicId: StorageVnextPublicId;
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  domain: string;
  searchProviderKind: SearchProviderKind | null;
  target: StorageVnextCleanupTarget;
  state: "queued" | "running" | "retry";
  attempt: number;
  leaseOwner: string | null;
  leaseExpiresAt: StorageVnextTimestamp | null;
  safeErrorCode: string | null;
  notBefore: StorageVnextTimestamp;
  checkpoint: StorageVnextBoundedMetadata;
  idempotency: StorageVnextIdempotency;
};

export type StorageVnextCleanupActionSelector = {
  domain: string;
  plane: StorageVnextCleanupTarget["plane"];
  resourceKind: string;
  searchProviderKind?: SearchProviderKind;
};

export type StorageVnextCleanupActionRepository = {
  enqueue(action: StorageVnextCleanupAction): Promise<StorageVnextCleanupAction>;
  claim(input: {
    owner: string;
    limit: number;
    leaseExpiresAt: StorageVnextTimestamp;
    selector?: StorageVnextCleanupActionSelector;
  }): Promise<readonly StorageVnextCleanupAction[]>;
  recoverStale(input: {
    expiredBefore: StorageVnextTimestamp;
    notBefore: StorageVnextTimestamp;
    safeErrorCode: string;
    limit: number;
    selector?: StorageVnextCleanupActionSelector;
  }): Promise<number>;
  renew(input: {
    publicId: StorageVnextPublicId;
    owner: string;
    leaseExpiresAt: StorageVnextTimestamp;
  }): Promise<boolean>;
  saveCheckpoint(input: {
    publicId: StorageVnextPublicId;
    owner: string;
    checkpoint: StorageVnextBoundedMetadata;
  }): Promise<void>;
  releaseForRetry(input: {
    publicId: StorageVnextPublicId;
    owner: string;
    notBefore: StorageVnextTimestamp;
    safeErrorCode: string;
    checkpoint: StorageVnextBoundedMetadata;
  }): Promise<void>;
  complete(input: {
    publicId: StorageVnextPublicId;
    owner: string;
  }): Promise<boolean>;
};

export type StorageVnextCleanupActionRepositoryErrorCode =
  | "invalid_input"
  | "idempotency_conflict"
  | "lease_lost";

export class StorageVnextCleanupActionRepositoryError extends Error {
  public constructor(public readonly code: StorageVnextCleanupActionRepositoryErrorCode) {
    super(`Storage vNext cleanup action repository error: ${code}`);
    this.name = "StorageVnextCleanupActionRepositoryError";
  }
}

type CleanupActionRow = {
  public_id: string;
  operation_public_id: string;
  knowledge_base_id: string;
  action_kind: string;
  cleanup_plane: StorageVnextCleanupTarget["plane"];
  search_provider_kind: SearchProviderKind | null;
  resource_kind: string;
  resource_public_id: string;
  required: boolean;
  sequence_number: number | string;
  idempotency_key: string;
  request_hash: string;
  checkpoint: Record<string, boolean | number | string | null>;
  state: StorageVnextCleanupAction["state"];
  attempt_count: number | string;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  safe_error_code: string | null;
  not_before: Date | string;
};

const ACTION_COLUMNS = `
  public_id, operation_public_id, knowledge_base_id, action_kind,
  cleanup_plane, search_provider_kind, resource_kind, resource_public_id,
  required, sequence_number,
  idempotency_key, request_hash, checkpoint, state, attempt_count,
  lease_owner, lease_expires_at, safe_error_code, not_before
`;
const ACTION_RETURNING_COLUMNS = ACTION_COLUMNS
  .split(",")
  .map((column) => `action.${column.trim()}`)
  .join(", ");
const CLEANUP_PLANES: readonly StorageVnextCleanupTarget["plane"][] = [
  "postgres",
  "object_storage",
  "search",
  "redis",
  "process"
];
const LIVE_STATES: readonly StorageVnextCleanupAction["state"][] = [
  "queued",
  "running",
  "retry"
];
const DEFAULT_MAXIMUM_ATTEMPTS = 10;

export function createPostgresStorageVnextCleanupActionRepository(
  sql: DatabaseClient
): StorageVnextCleanupActionRepository {
  return {
    async enqueue(action) {
      assertAction(action);
      await sql`
        INSERT INTO focowiki.cleanup_actions
          (public_id, operation_public_id, knowledge_base_id, action_kind,
           cleanup_plane, resource_kind, resource_public_id, required, sequence_number,
           search_provider_kind,
           idempotency_key, request_hash, checkpoint, state, attempt_count,
           maximum_attempts, lease_owner, lease_expires_at, safe_error_code, not_before)
        VALUES
          (${action.publicId}, ${action.operationPublicId}, ${action.knowledgeBaseId},
           ${action.domain}, ${action.target.plane}, ${action.target.resourceKind},
           ${action.target.publicId}, ${action.target.required}, ${action.target.sequence},
           ${action.searchProviderKind},
           ${action.idempotency.key}, ${action.idempotency.requestHash},
           ${sql.json(action.checkpoint)}, ${action.state}, ${action.attempt},
           ${DEFAULT_MAXIMUM_ATTEMPTS},
           ${action.leaseOwner}, ${action.leaseExpiresAt}, ${action.safeErrorCode},
           ${action.notBefore})
        ON CONFLICT ON CONSTRAINT cleanup_actions_idempotency_key DO NOTHING
      `;
      const rows = await sql<CleanupActionRow[]>`
        SELECT ${sql.unsafe(ACTION_COLUMNS)}
        FROM focowiki.cleanup_actions
        WHERE operation_public_id = ${action.operationPublicId}
          AND action_kind = ${action.domain}
          AND cleanup_plane = ${action.target.plane}
          AND search_provider_kind IS NOT DISTINCT FROM ${action.searchProviderKind}
          AND resource_kind = ${action.target.resourceKind}
          AND resource_public_id = ${action.target.publicId}
          AND idempotency_key = ${action.idempotency.key}
        LIMIT 1
      `;
      const existing = rows[0] ? mapAction(rows[0]) : null;
      if (!existing || !sameAction(existing, action)) throw repositoryError("idempotency_conflict");
      return existing;
    },

    async claim(input) {
      assertIdentifier(input.owner, 255);
      const limit = assertLimit(input.limit);
      const leaseExpiresAt = assertTimestamp(input.leaseExpiresAt);
      const selector = input.selector ? assertSelector(input.selector) : null;
      if (leaseExpiresAt.getTime() <= Date.now()) throw repositoryError("invalid_input");
      const rows = await sql<CleanupActionRow[]>`
        WITH candidates AS (
          SELECT public_id
          FROM focowiki.cleanup_actions
          WHERE state IN ('queued', 'retry')
            AND attempt_count < maximum_attempts
            AND not_before <= now()
            ${selector ? sql`
              AND action_kind = ${selector.domain}
              AND cleanup_plane = ${selector.plane}
              AND search_provider_kind IS NOT DISTINCT FROM ${selector.searchProviderKind ?? null}
              AND resource_kind = ${selector.resourceKind}
            ` : sql``}
          ORDER BY not_before, sequence_number, updated_at, public_id
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        UPDATE focowiki.cleanup_actions AS action
        SET state = 'running', attempt_count = action.attempt_count + 1,
            lease_owner = ${input.owner}, lease_expires_at = ${input.leaseExpiresAt},
            safe_error_code = NULL, updated_at = now()
        FROM candidates
        WHERE action.public_id = candidates.public_id
        RETURNING ${sql.unsafe(ACTION_RETURNING_COLUMNS)}
      `;
      return rows.map(mapAction);
    },

    async recoverStale(input) {
      assertTimestamp(input.expiredBefore);
      assertTimestamp(input.notBefore);
      assertIdentifier(input.safeErrorCode, 128);
      const limit = assertLimit(input.limit);
      const selector = input.selector ? assertSelector(input.selector) : null;
      const rows = await sql<Array<{ public_id: string }>>`
        WITH stale AS (
          SELECT public_id
          FROM focowiki.cleanup_actions
          WHERE state = 'running'
            AND lease_expires_at <= ${input.expiredBefore}
            ${selector ? sql`
              AND action_kind = ${selector.domain}
              AND cleanup_plane = ${selector.plane}
              AND search_provider_kind IS NOT DISTINCT FROM ${selector.searchProviderKind ?? null}
              AND resource_kind = ${selector.resourceKind}
            ` : sql``}
          ORDER BY lease_expires_at, public_id
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        UPDATE focowiki.cleanup_actions AS action
        SET state = CASE
              WHEN attempt_count < maximum_attempts THEN 'retry'
              ELSE 'failed'
            END,
            completed_at = CASE
              WHEN attempt_count < maximum_attempts THEN NULL
              ELSE now()
            END,
            lease_owner = NULL, lease_expires_at = NULL,
            not_before = ${input.notBefore},
            safe_error_code = ${input.safeErrorCode}, updated_at = now()
        FROM stale
        WHERE action.public_id = stale.public_id
        RETURNING action.public_id
      `;
      return rows.length;
    },

    async renew(input) {
      assertIdentifier(input.publicId, 255);
      assertIdentifier(input.owner, 255);
      const leaseExpiresAt = assertTimestamp(input.leaseExpiresAt);
      if (leaseExpiresAt.getTime() <= Date.now()) throw repositoryError("invalid_input");
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.cleanup_actions
        SET lease_expires_at = ${input.leaseExpiresAt}, updated_at = now()
        WHERE public_id = ${input.publicId}
          AND state = 'running'
          AND lease_owner = ${input.owner}
          AND lease_expires_at > now()
        RETURNING public_id
      `;
      return rows.length === 1;
    },

    async saveCheckpoint(input) {
      assertIdentifier(input.publicId, 255);
      assertIdentifier(input.owner, 255);
      assertMetadata(input.checkpoint);
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.cleanup_actions
        SET checkpoint = ${sql.json(input.checkpoint)}, updated_at = now()
        WHERE public_id = ${input.publicId}
          AND state = 'running'
          AND lease_owner = ${input.owner}
          AND lease_expires_at > now()
        RETURNING public_id
      `;
      if (rows.length !== 1) throw repositoryError("lease_lost");
    },

    async releaseForRetry(input) {
      assertIdentifier(input.publicId, 255);
      assertIdentifier(input.owner, 255);
      assertIdentifier(input.safeErrorCode, 128);
      assertTimestamp(input.notBefore);
      assertMetadata(input.checkpoint);
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.cleanup_actions
        SET state = 'retry', lease_owner = NULL, lease_expires_at = NULL,
            not_before = ${input.notBefore}, safe_error_code = ${input.safeErrorCode},
            checkpoint = ${sql.json(input.checkpoint)}, updated_at = now()
        WHERE public_id = ${input.publicId}
          AND state = 'running'
          AND lease_owner = ${input.owner}
          AND lease_expires_at > now()
        RETURNING public_id
      `;
      if (rows.length !== 1) throw repositoryError("lease_lost");
    },

    async complete(input) {
      assertIdentifier(input.publicId, 255);
      assertIdentifier(input.owner, 255);
      const rows = await sql<Array<{ public_id: string }>>`
        DELETE FROM focowiki.cleanup_actions
        WHERE public_id = ${input.publicId}
          AND state = 'running'
          AND lease_owner = ${input.owner}
          AND lease_expires_at > now()
        RETURNING public_id
      `;
      return rows.length === 1;
    }
  };
}

function mapAction(row: CleanupActionRow): StorageVnextCleanupAction {
  if (!CLEANUP_PLANES.includes(row.cleanup_plane) || !LIVE_STATES.includes(row.state)) {
    throw repositoryError("idempotency_conflict");
  }
  return {
    publicId: row.public_id,
    operationPublicId: row.operation_public_id,
    knowledgeBaseId: row.knowledge_base_id,
    domain: row.action_kind,
    searchProviderKind: row.search_provider_kind,
    target: {
      publicId: row.resource_public_id,
      resourceKind: row.resource_kind,
      plane: row.cleanup_plane,
      required: row.required,
      sequence: toSafeInteger(row.sequence_number)
    },
    state: row.state,
    attempt: toSafeInteger(row.attempt_count),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: nullableTimestamp(row.lease_expires_at),
    safeErrorCode: row.safe_error_code,
    notBefore: timestamp(row.not_before),
    checkpoint: row.checkpoint,
    idempotency: { key: row.idempotency_key, requestHash: row.request_hash }
  };
}

function assertAction(action: StorageVnextCleanupAction): void {
  assertIdentifier(action.publicId, 255);
  assertIdentifier(action.operationPublicId, 255);
  assertIdentifier(action.knowledgeBaseId, 255);
  assertIdentifier(action.domain, 128);
  assertIdentifier(action.target.publicId, 255);
  assertIdentifier(action.target.resourceKind, 128);
  if (
    !CLEANUP_PLANES.includes(action.target.plane)
    || typeof action.target.required !== "boolean"
    || !LIVE_STATES.includes(action.state)
  ) {
    throw repositoryError("invalid_input");
  }
  assertSearchProviderOwnership(action.target.plane, action.searchProviderKind);
  assertIdentifier(action.idempotency.key, 255);
  assertChecksum(action.idempotency.requestHash);
  if (!Number.isSafeInteger(action.target.sequence) || action.target.sequence < 0) {
    throw repositoryError("invalid_input");
  }
  if (!Number.isSafeInteger(action.attempt) || action.attempt < 0) {
    throw repositoryError("invalid_input");
  }
  const hasLease = action.leaseOwner !== null && action.leaseExpiresAt !== null;
  if ((action.state === "running") !== hasLease) throw repositoryError("invalid_input");
  if (action.leaseOwner) assertIdentifier(action.leaseOwner, 255);
  if (action.leaseExpiresAt) assertTimestamp(action.leaseExpiresAt);
  if (action.safeErrorCode) assertIdentifier(action.safeErrorCode, 128);
  assertTimestamp(action.notBefore);
  assertMetadata(action.checkpoint);
}

function assertSelector(
  selector: StorageVnextCleanupActionSelector
): StorageVnextCleanupActionSelector {
  assertIdentifier(selector.domain, 128);
  assertIdentifier(selector.resourceKind, 128);
  if (!CLEANUP_PLANES.includes(selector.plane)) {
    throw repositoryError("invalid_input");
  }
  assertSearchProviderOwnership(
    selector.plane,
    selector.searchProviderKind ?? null
  );
  return selector;
}

function sameAction(left: StorageVnextCleanupAction, right: StorageVnextCleanupAction): boolean {
  return left.knowledgeBaseId === right.knowledgeBaseId
    && left.searchProviderKind === right.searchProviderKind
    && left.idempotency.requestHash === right.idempotency.requestHash;
}

function assertSearchProviderOwnership(
  plane: StorageVnextCleanupTarget["plane"],
  providerKind: SearchProviderKind | null
): void {
  const validProvider = isSearchProviderKind(providerKind);
  if ((plane === "search") !== validProvider) {
    throw repositoryError("invalid_input");
  }
}

function assertMetadata(value: object): void {
  if (value === null || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 32_768) {
    throw repositoryError("invalid_input");
  }
}

function assertIdentifier(value: string, maxBytes: number): void {
  if (value.length === 0 || Buffer.byteLength(value) > maxBytes) {
    throw repositoryError("invalid_input");
  }
}

function assertChecksum(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw repositoryError("invalid_input");
}

function assertLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw repositoryError("invalid_input");
  }
  return value;
}

function assertTimestamp(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw repositoryError("invalid_input");
  }
  return parsed;
}

function timestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw repositoryError("idempotency_conflict");
  return parsed.toISOString();
}

function nullableTimestamp(value: Date | string | null): string | null {
  return value === null ? null : timestamp(value);
}

function toSafeInteger(value: number | string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw repositoryError("idempotency_conflict");
  return parsed;
}

function repositoryError(code: StorageVnextCleanupActionRepositoryErrorCode) {
  return new StorageVnextCleanupActionRepositoryError(code);
}
