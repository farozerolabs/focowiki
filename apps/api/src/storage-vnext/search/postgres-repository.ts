import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import { isSearchProviderKind, type SearchProviderKind } from
  "../../application/ports/search-provider-runtime.js";
import type {
  StorageVnextSearchProjectionRecord,
  StorageVnextSearchProjectionRepository
} from "./projection-repository.js";
import {
  createPostgresStorageVnextSearchValidationState
} from "./postgres-validation-state.js";
import {
  storageVnextSearchRepositoryError as repositoryError
} from "./postgres-repository-errors.js";

export type {
  StorageVnextSearchProjectionRepositoryErrorCode
} from "./postgres-repository-errors.js";
export {
  StorageVnextSearchProjectionRepositoryError
} from "./postgres-repository-errors.js";

type ReadSql = DatabaseClient | TransactionSql;

type ProjectionRow = {
  public_id: string;
  knowledge_base_id: string;
  provider_kind: SearchProviderKind;
  provider_index_uid: string;
  schema_checksum_sha256: string;
  settings_checksum_sha256: string;
  document_checksum_sha256: string | null;
  state: StorageVnextSearchProjectionRecord["state"];
  document_count: number | string;
  next_batch_ordinal: number | string;
  last_batch_ordinal: number | string | null;
  last_batch_checksum_sha256: string | null;
  correlation_public_id: string | null;
  provider_operation_ref: string | null;
  revision: number | string;
};

export function createPostgresStorageVnextSearchProjectionRepository(
  sql: DatabaseClient
): StorageVnextSearchProjectionRepository {
  const validationState = createPostgresStorageVnextSearchValidationState(sql);
  return {
    async reserveCandidate(input) {
      assertId(input.publicId);
      assertId(input.knowledgeBaseId);
      assertProviderKind(input.providerKind);
      assertId(input.providerIndexUid);
      assertChecksum(input.schemaChecksum);
      assertChecksum(input.settingsChecksum);
      try {
        return await sql.begin(async (transaction) => {
          const byId = await readProjection(transaction, input.publicId, true);
          if (byId) return exactReservation(byId, input);
          const live = await transaction<ProjectionRow[]>`
            SELECT ${transaction(projectionColumnNames)}
            FROM focowiki.search_projections
            WHERE knowledge_base_id = ${input.knowledgeBaseId}
              AND projection_role = 'candidate'
            FOR UPDATE
          `;
          if (live[0]) throw repositoryError("candidate_exists");
          const rows = await transaction<ProjectionRow[]>`
            INSERT INTO focowiki.search_projections (
              public_id, knowledge_base_id, projection_role, provider_kind,
              provider_index_uid,
              schema_checksum_sha256, settings_checksum_sha256, revision,
              document_count, state
            ) VALUES (
              ${input.publicId}, ${input.knowledgeBaseId}, 'candidate',
              ${input.providerKind},
              ${input.providerIndexUid}, ${input.schemaChecksum},
              ${input.settingsChecksum}, 0, 0, 'preparing'
            )
            RETURNING ${transaction(projectionColumnNames)}
          `;
          return { outcome: "created" as const, projection: mapProjection(rows[0]!) };
        });
      } catch (error) {
        if (!isReservationConflict(error)) throw error;
        const byId = await readProjection(sql, input.publicId, false);
        if (byId) return exactReservation(byId, input);
        const live = await readCandidateForKnowledgeBase(sql, input.knowledgeBaseId);
        if (live?.publicId === input.publicId) return exactReservation(live, input);
        if (live) throw repositoryError("candidate_exists");
        throw repositoryError("projection_conflict");
      }
    },

    async getCandidate(candidatePublicId) {
      assertId(candidatePublicId);
      const projection = await readProjection(sql, candidatePublicId, false);
      return projection?.role === "candidate" ? projection.record : null;
    },

    async beginProviderOperation(input) {
      assertId(input.candidatePublicId);
      assertId(input.correlationPublicId);
      return sql.begin(async (transaction) => {
        const candidate = await requireCandidate(transaction, input.candidatePublicId);
        if (candidate.state !== "preparing") throw repositoryError("invalid_state");
        return beginTask(transaction, candidate, input.correlationPublicId);
      });
    },

    async recordProviderOperation(input) {
      assertId(input.candidatePublicId);
      assertId(input.correlationPublicId);
      assertOperationRef(input.providerOperationRef);
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.search_projections
        SET provider_operation_ref = ${input.providerOperationRef},
            revision = revision + 1,
            updated_at = now()
        WHERE public_id = ${input.candidatePublicId}
          AND projection_role = 'candidate'
          AND correlation_public_id = ${input.correlationPublicId}
          AND (provider_operation_ref IS NULL
            OR provider_operation_ref = ${input.providerOperationRef})
        RETURNING public_id
      `;
      if (!rows[0]) throw repositoryError("task_conflict");
    },

    async completeProviderOperation(input) {
      assertId(input.candidatePublicId);
      assertId(input.correlationPublicId);
      const rows = await clearTask(sql, input);
      if (!rows[0]) throw repositoryError("task_conflict");
    },

    async markCandidateIndexing(candidatePublicId) {
      assertId(candidatePublicId);
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.search_projections
        SET state = 'indexing',
            revision = revision + CASE WHEN state = 'preparing' THEN 1 ELSE 0 END,
            updated_at = now()
        WHERE public_id = ${candidatePublicId}
          AND projection_role = 'candidate'
          AND state IN ('preparing', 'indexing')
          AND correlation_public_id IS NULL
          AND provider_operation_ref IS NULL
        RETURNING public_id
      `;
      if (!rows[0]) throw repositoryError("invalid_state");
    },

    async beginDocumentBatch(input) {
      assertBatchInput(input);
      return sql.begin(async (transaction) => {
        const candidate = await requireCandidate(transaction, input.candidatePublicId);
        if (candidate.state !== "indexing") throw repositoryError("invalid_state");
        if (
          input.batchOrdinal === candidate.nextBatchOrdinal - 1
          && candidate.lastBatchOrdinal === input.batchOrdinal
        ) {
          if (candidate.lastBatchChecksum !== input.payloadChecksum) {
            throw repositoryError("batch_conflict");
          }
          return { outcome: "completed" as const, providerOperationRef: null };
        }
        if (input.batchOrdinal !== candidate.nextBatchOrdinal) {
          throw repositoryError("batch_conflict");
        }
        return beginTask(transaction, candidate, input.correlationPublicId);
      });
    },

    async completeDocumentBatch(input) {
      assertBatchInput(input);
      assertOrdinal(input.documentCount);
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.search_projections
        SET document_count = document_count + ${input.documentCount},
            next_batch_ordinal = next_batch_ordinal + 1,
            last_batch_ordinal = ${input.batchOrdinal},
            last_batch_checksum_sha256 = ${input.payloadChecksum},
            correlation_public_id = NULL, provider_operation_ref = NULL,
            revision = revision + 1, updated_at = now()
        WHERE public_id = ${input.candidatePublicId}
          AND projection_role = 'candidate' AND state = 'indexing'
          AND next_batch_ordinal = ${input.batchOrdinal}
          AND correlation_public_id = ${input.correlationPublicId}
        RETURNING public_id
      `;
      if (!rows[0]) throw repositoryError("batch_conflict");
    },
    ...validationState
  };
}

const projectionColumnNames = [
  "public_id", "knowledge_base_id", "provider_kind", "provider_index_uid",
  "schema_checksum_sha256", "settings_checksum_sha256",
  "document_checksum_sha256", "state",
  "document_count", "next_batch_ordinal", "last_batch_ordinal",
  "last_batch_checksum_sha256", "correlation_public_id",
  "provider_operation_ref", "revision"
];

async function beginTask(
  sql: TransactionSql,
  candidate: StorageVnextSearchProjectionRecord,
  correlationPublicId: string
) {
  if (
    candidate.correlationPublicId
    && candidate.correlationPublicId !== correlationPublicId
  ) throw repositoryError("task_conflict");
  if (!candidate.correlationPublicId) {
    await sql`
      UPDATE focowiki.search_projections
      SET correlation_public_id = ${correlationPublicId}, revision = revision + 1,
          updated_at = now()
      WHERE public_id = ${candidate.publicId}
    `;
    return { outcome: "start" as const, providerOperationRef: null };
  }
  return {
    outcome: candidate.providerOperationRef === null
      ? "start" as const : "resume" as const,
    providerOperationRef: candidate.providerOperationRef
  };
}

async function clearTask(sql: ReadSql, input: {
  candidatePublicId: string;
  correlationPublicId: string;
}) {
  return sql<Array<{ public_id: string }>>`
    UPDATE focowiki.search_projections
    SET correlation_public_id = NULL, provider_operation_ref = NULL,
        revision = revision + 1, updated_at = now()
    WHERE public_id = ${input.candidatePublicId}
      AND projection_role = 'candidate'
      AND correlation_public_id = ${input.correlationPublicId}
    RETURNING public_id
  `;
}

async function requireCandidate(
  sql: TransactionSql,
  publicId: string
): Promise<StorageVnextSearchProjectionRecord> {
  const projection = await readProjection(sql, publicId, true);
  if (!projection) throw repositoryError("projection_not_found");
  if (projection.role !== "candidate") throw repositoryError("projection_conflict");
  return projection.record;
}

async function readProjection(sql: ReadSql, publicId: string, lock: boolean) {
  const rows = await sql<Array<ProjectionRow & { projection_role: string }>>`
    SELECT ${sql(projectionColumnNames)}, projection_role
    FROM focowiki.search_projections
    WHERE public_id = ${publicId}
    ${lock ? sql`FOR UPDATE` : sql``}
  `;
  return rows[0] ? { role: rows[0].projection_role, record: mapProjection(rows[0]) } : null;
}

async function readCandidateForKnowledgeBase(sql: ReadSql, knowledgeBaseId: string) {
  const rows = await sql<ProjectionRow[]>`
    SELECT ${sql(projectionColumnNames)}
    FROM focowiki.search_projections
    WHERE knowledge_base_id = ${knowledgeBaseId} AND projection_role = 'candidate'
  `;
  return rows[0] ? mapProjection(rows[0]) : null;
}

function exactReservation(
  existing: { role: string; record: StorageVnextSearchProjectionRecord }
    | StorageVnextSearchProjectionRecord,
  input: {
    publicId: string; knowledgeBaseId: string; providerKind: SearchProviderKind;
    providerIndexUid: string;
    schemaChecksum: string; settingsChecksum: string;
  }
) {
  const role = "role" in existing ? existing.role : "candidate";
  const record = "record" in existing ? existing.record : existing;
  if (
    role !== "candidate" || record.knowledgeBaseId !== input.knowledgeBaseId
    || record.providerKind !== input.providerKind
    || record.schemaChecksum !== input.schemaChecksum
    || record.settingsChecksum !== input.settingsChecksum
  ) throw repositoryError("projection_conflict");
  return { outcome: "existing" as const, projection: record };
}

function mapProjection(row: ProjectionRow): StorageVnextSearchProjectionRecord {
  assertProviderKind(row.provider_kind);
  return {
    publicId: row.public_id, knowledgeBaseId: row.knowledge_base_id,
    providerKind: row.provider_kind,
    providerIndexUid: row.provider_index_uid,
    schemaChecksum: row.schema_checksum_sha256,
    settingsChecksum: row.settings_checksum_sha256,
    documentChecksum: row.document_checksum_sha256, state: row.state,
    documentCount: toSafeNumber(row.document_count),
    nextBatchOrdinal: toSafeNumber(row.next_batch_ordinal),
    lastBatchOrdinal: row.last_batch_ordinal === null
      ? null : toSafeNumber(row.last_batch_ordinal),
    lastBatchChecksum: row.last_batch_checksum_sha256,
    correlationPublicId: row.correlation_public_id,
    providerOperationRef: row.provider_operation_ref,
    revision: toSafeNumber(row.revision)
  };
}

function assertBatchInput(input: {
  candidatePublicId: string; batchOrdinal: number; payloadChecksum: string;
  correlationPublicId: string;
}) {
  assertId(input.candidatePublicId); assertOrdinal(input.batchOrdinal);
  assertChecksum(input.payloadChecksum); assertId(input.correlationPublicId);
}

function assertId(value: string) {
  if (!value || Buffer.byteLength(value) > 255) throw repositoryError("invalid_input");
}

function assertChecksum(value: string) {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw repositoryError("invalid_input");
}

function assertOrdinal(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw repositoryError("invalid_input");
}

function assertProviderKind(value: SearchProviderKind) {
  if (!isSearchProviderKind(value)) {
    throw repositoryError("invalid_input");
  }
}

function assertOperationRef(value: string) {
  if (!value || Buffer.byteLength(value) > 2_048) {
    throw repositoryError("invalid_input");
  }
}

function toSafeNumber(value: number | string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw repositoryError("projection_conflict");
  return result;
}

function isReservationConflict(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error
    && error.code === "23505");
}
