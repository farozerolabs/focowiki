import type { DatabaseClient } from "../../db/client.js";
import type {
  StorageVnextSearchCleanupLease,
  StorageVnextSearchCleanupRepository
} from "./cleanup-repository.js";
import {
  storageVnextSearchRepositoryError as repositoryError
} from "./postgres-repository-errors.js";

type CleanupLeaseRow = {
  public_id: string;
  provider_index_uid: string;
  correlation_public_id: string;
  provider_task_uid: number | string | null;
};

export function createPostgresStorageVnextSearchCleanupRepository(
  sql: DatabaseClient
): StorageVnextSearchCleanupRepository {
  return {
    async claimFailedCandidate(input) {
      assertTimestamp(input.failedBefore);
      assertId(input.correlationPublicId);
      const rows = await sql<CleanupLeaseRow[]>`
        WITH eligible AS (
          SELECT public_id
          FROM focowiki.search_projections
          WHERE projection_role = 'candidate'
            AND state = 'failed'
            AND (
              (
                correlation_public_id IS NULL
                AND updated_at <= ${input.failedBefore}
              )
              OR correlation_public_id = ${input.correlationPublicId}
            )
          ORDER BY
            (correlation_public_id = ${input.correlationPublicId}) DESC,
            updated_at,
            public_id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE focowiki.search_projections AS projection
        SET correlation_public_id = ${input.correlationPublicId},
            revision = revision + CASE
              WHEN correlation_public_id IS NULL THEN 1 ELSE 0 END,
            updated_at = now()
        FROM eligible
        WHERE projection.public_id = eligible.public_id
        RETURNING projection.public_id, projection.provider_index_uid,
                  projection.correlation_public_id, projection.provider_task_uid
      `;
      return rows[0] ? mapLease(rows[0]) : null;
    },

    async listRetainedProviderIndexUids(providerIndexUids) {
      if (providerIndexUids.length === 0) return [];
      assertIdBatch(providerIndexUids);
      const rows = await sql<Array<{ provider_index_uid: string }>>`
        SELECT provider_index_uid
        FROM focowiki.search_projections
        WHERE provider_index_uid = ANY(${providerIndexUids as string[]})
        ORDER BY provider_index_uid COLLATE "C"
      `;
      return rows.map((row) => row.provider_index_uid);
    },

    async claimActiveCompaction(input) {
      assertTimestamp(input.compactedBefore);
      assertId(input.correlationPublicId);
      const rows = await sql<CleanupLeaseRow[]>`
        WITH eligible AS (
          SELECT active.public_id
          FROM focowiki.search_projections AS active
          WHERE active.projection_role = 'active'
            AND active.state = 'ready'
            AND (
              active.last_compacted_at IS NULL
              OR active.last_compacted_at <= ${input.compactedBefore}
            )
            AND (
              active.correlation_public_id IS NULL
              OR active.correlation_public_id = ${input.correlationPublicId}
            )
            AND NOT EXISTS (
              SELECT 1
              FROM focowiki.search_projections AS candidate
              WHERE candidate.knowledge_base_id = active.knowledge_base_id
                AND candidate.projection_role = 'candidate'
                AND candidate.state IN ('preparing', 'indexing', 'validating', 'ready')
            )
          ORDER BY
            (active.correlation_public_id = ${input.correlationPublicId}) DESC,
            active.last_compacted_at NULLS FIRST,
            active.public_id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE focowiki.search_projections AS projection
        SET correlation_public_id = ${input.correlationPublicId},
            revision = revision + CASE
              WHEN correlation_public_id IS NULL THEN 1 ELSE 0 END,
            updated_at = now()
        FROM eligible
        WHERE projection.public_id = eligible.public_id
        RETURNING projection.public_id, projection.provider_index_uid,
                  projection.correlation_public_id, projection.provider_task_uid
      `;
      return rows[0] ? mapLease(rows[0]) : null;
    },

    async recordCleanupTask(input) {
      assertTaskInput(input);
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.search_projections
        SET provider_task_uid = ${input.providerTaskUid},
            revision = revision + CASE
              WHEN provider_task_uid IS NULL THEN 1 ELSE 0 END,
            updated_at = now()
        WHERE public_id = ${input.projectionPublicId}
          AND correlation_public_id = ${input.correlationPublicId}
          AND (provider_task_uid IS NULL OR provider_task_uid = ${input.providerTaskUid})
          AND (
            (projection_role = 'candidate' AND state = 'failed')
            OR (projection_role = 'active' AND state = 'ready')
          )
        RETURNING public_id
      `;
      if (!rows[0]) throw repositoryError("cleanup_conflict");
    },

    async clearCleanupTask(input) {
      assertTaskInput(input);
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.search_projections
        SET provider_task_uid = NULL, revision = revision + 1, updated_at = now()
        WHERE public_id = ${input.projectionPublicId}
          AND correlation_public_id = ${input.correlationPublicId}
          AND provider_task_uid = ${input.providerTaskUid}
        RETURNING public_id
      `;
      if (!rows[0]) throw repositoryError("cleanup_conflict");
    },

    async completeFailedCandidateCleanup(input) {
      assertId(input.candidatePublicId);
      assertId(input.correlationPublicId);
      const rows = await sql<Array<{ public_id: string }>>`
        DELETE FROM focowiki.search_projections
        WHERE public_id = ${input.candidatePublicId}
          AND projection_role = 'candidate'
          AND state = 'failed'
          AND correlation_public_id = ${input.correlationPublicId}
        RETURNING public_id
      `;
      if (!rows[0]) throw repositoryError("cleanup_conflict");
    },

    async completeCompaction(input) {
      assertId(input.projectionPublicId);
      assertId(input.correlationPublicId);
      assertBytes(input.databaseSizeBytes);
      assertBytes(input.usedDatabaseSizeBytes);
      if (input.usedDatabaseSizeBytes > input.databaseSizeBytes) {
        throw repositoryError("invalid_input");
      }
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.search_projections
        SET correlation_public_id = NULL, provider_task_uid = NULL,
            last_compacted_at = now(),
            last_compaction_database_size_bytes = ${input.databaseSizeBytes},
            last_compaction_used_database_size_bytes = ${input.usedDatabaseSizeBytes},
            revision = revision + 1, updated_at = now()
        WHERE public_id = ${input.projectionPublicId}
          AND projection_role = 'active'
          AND state = 'ready'
          AND correlation_public_id = ${input.correlationPublicId}
        RETURNING public_id
      `;
      if (!rows[0]) throw repositoryError("cleanup_conflict");
    }
  };
}

function mapLease(row: CleanupLeaseRow): StorageVnextSearchCleanupLease {
  return {
    publicId: row.public_id,
    providerIndexUid: row.provider_index_uid,
    correlationPublicId: row.correlation_public_id,
    providerTaskUid: row.provider_task_uid === null
      ? null : toSafeNumber(row.provider_task_uid)
  };
}

function assertTaskInput(input: {
  projectionPublicId: string;
  correlationPublicId: string;
  providerTaskUid: number;
}) {
  assertId(input.projectionPublicId);
  assertId(input.correlationPublicId);
  assertBytes(input.providerTaskUid);
}

function assertIdBatch(values: readonly string[]) {
  if (values.length > 1_000 || new Set(values).size !== values.length) {
    throw repositoryError("invalid_input");
  }
  for (const value of values) assertId(value);
}

function assertTimestamp(value: string) {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw repositoryError("invalid_input");
  }
}

function assertId(value: string) {
  if (!value || Buffer.byteLength(value) > 255) {
    throw repositoryError("invalid_input");
  }
}

function assertBytes(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw repositoryError("invalid_input");
  }
}

function toSafeNumber(value: number | string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw repositoryError("cleanup_conflict");
  }
  return result;
}
