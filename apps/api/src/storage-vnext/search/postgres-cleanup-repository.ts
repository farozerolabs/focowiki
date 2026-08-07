import type { DatabaseClient } from "../../db/client.js";
import { isSearchProviderKind, type SearchProviderKind } from
  "../../application/ports/search-provider-runtime.js";
import type {
  StorageVnextSearchCleanupLease,
  StorageVnextSearchCleanupRepository
} from "./cleanup-repository.js";
import {
  storageVnextSearchRepositoryError as repositoryError
} from "./postgres-repository-errors.js";

type CleanupLeaseRow = {
  public_id: string;
  provider_kind: SearchProviderKind;
  provider_index_uid: string;
  correlation_public_id: string;
  provider_operation_ref: string | null;
};

export function createPostgresStorageVnextSearchCleanupRepository(
  sql: DatabaseClient
): StorageVnextSearchCleanupRepository {
  return {
    async claimFailedCandidate(input) {
      assertTimestamp(input.failedBefore);
      assertId(input.correlationPublicId);
      assertProviderKind(input.providerKind);
      const rows = await sql<CleanupLeaseRow[]>`
        WITH eligible AS (
          SELECT public_id
          FROM focowiki.search_projections
          WHERE projection_role = 'candidate'
            AND provider_kind = ${input.providerKind}
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
        RETURNING projection.public_id, projection.provider_kind,
                  projection.provider_index_uid,
                  projection.correlation_public_id,
                  projection.provider_operation_ref
      `;
      return rows[0] ? mapLease(rows[0]) : null;
    },

    async listRetainedProviderIndexUids(input) {
      if (input.providerIndexUids.length === 0) return [];
      assertProviderKind(input.providerKind);
      assertIdBatch(input.providerIndexUids);
      const rows = await sql<Array<{ provider_index_uid: string }>>`
        SELECT provider_index_uid
        FROM focowiki.search_projections
        WHERE provider_kind = ${input.providerKind}
          AND provider_index_uid = ANY(${input.providerIndexUids as string[]})
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
          LEFT JOIN focowiki.meilisearch_projection_maintenance AS maintenance
            ON maintenance.projection_public_id = active.public_id
          WHERE active.projection_role = 'active'
            AND active.provider_kind = 'meilisearch'
            AND active.state = 'ready'
            AND (
              maintenance.last_compacted_at IS NULL
              OR maintenance.last_compacted_at <= ${input.compactedBefore}
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
            maintenance.last_compacted_at NULLS FIRST,
            active.public_id
          LIMIT 1
          FOR UPDATE OF active SKIP LOCKED
        )
        UPDATE focowiki.search_projections AS projection
        SET correlation_public_id = ${input.correlationPublicId},
            revision = revision + CASE
              WHEN correlation_public_id IS NULL THEN 1 ELSE 0 END,
            updated_at = now()
        FROM eligible
        WHERE projection.public_id = eligible.public_id
        RETURNING projection.public_id, projection.provider_kind,
                  projection.provider_index_uid,
                  projection.correlation_public_id,
                  projection.provider_operation_ref
      `;
      return rows[0] ? mapLease(rows[0]) : null;
    },

    async recordCleanupOperation(input) {
      assertTaskInput(input);
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.search_projections
        SET provider_operation_ref = ${input.providerOperationRef},
            revision = revision + CASE
              WHEN provider_operation_ref IS NULL THEN 1 ELSE 0 END,
            updated_at = now()
        WHERE public_id = ${input.projectionPublicId}
          AND correlation_public_id = ${input.correlationPublicId}
          AND (provider_operation_ref IS NULL
            OR provider_operation_ref = ${input.providerOperationRef})
          AND (
            (projection_role = 'candidate' AND state = 'failed')
            OR (projection_role = 'active' AND state = 'ready')
          )
        RETURNING public_id
      `;
      if (!rows[0]) throw repositoryError("cleanup_conflict");
    },

    async clearCleanupOperation(input) {
      assertTaskInput(input);
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.search_projections
        SET provider_operation_ref = NULL,
            revision = revision + 1, updated_at = now()
        WHERE public_id = ${input.projectionPublicId}
          AND correlation_public_id = ${input.correlationPublicId}
          AND provider_operation_ref = ${input.providerOperationRef}
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
      const rows = await sql.begin(async (transaction) => {
        const released = await transaction<Array<{ public_id: string }>>`
          UPDATE focowiki.search_projections
          SET correlation_public_id = NULL, provider_operation_ref = NULL,
              revision = revision + 1, updated_at = now()
          WHERE public_id = ${input.projectionPublicId}
            AND provider_kind = 'meilisearch'
            AND projection_role = 'active'
            AND state = 'ready'
            AND correlation_public_id = ${input.correlationPublicId}
          RETURNING public_id
        `;
        if (!released[0]) return released;
        await transaction`
          INSERT INTO focowiki.meilisearch_projection_maintenance (
            projection_public_id, last_compacted_at,
            last_database_size_bytes, last_used_database_size_bytes
          ) VALUES (
            ${input.projectionPublicId}, now(), ${input.databaseSizeBytes},
            ${input.usedDatabaseSizeBytes}
          )
          ON CONFLICT (projection_public_id) DO UPDATE
          SET last_compacted_at = EXCLUDED.last_compacted_at,
              last_database_size_bytes = EXCLUDED.last_database_size_bytes,
              last_used_database_size_bytes = EXCLUDED.last_used_database_size_bytes
        `;
        return released;
      });
      if (!rows[0]) throw repositoryError("cleanup_conflict");
    }
  };
}

function mapLease(row: CleanupLeaseRow): StorageVnextSearchCleanupLease {
  return {
    publicId: row.public_id,
    providerKind: row.provider_kind,
    providerIndexUid: row.provider_index_uid,
    correlationPublicId: row.correlation_public_id,
    providerOperationRef: row.provider_operation_ref
  };
}

function assertTaskInput(input: {
  projectionPublicId: string;
  correlationPublicId: string;
  providerOperationRef: string;
}) {
  assertId(input.projectionPublicId);
  assertId(input.correlationPublicId);
  assertOperationRef(input.providerOperationRef);
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
