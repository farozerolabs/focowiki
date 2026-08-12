import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import {
  STORAGE_VNEXT_MAINTENANCE_PHASES,
  type StorageVnextMaintenanceAcceptance,
  type StorageVnextMaintenanceCheckpoint,
  type StorageVnextMaintenanceClaim,
  type StorageVnextMaintenanceRepository,
  type StorageVnextMaintenanceRequest,
  type StorageVnextMaintenanceTrigger
} from "./ports.js";
import { createStorageVnextMaintenanceStatusMapper } from "./status.js";
import { isSearchProviderKind, type SearchProviderKind } from
  "../../application/ports/search-provider-runtime.js";
import {
  SEMANTIC_EXTRACTION_CONTRACT_VERSION,
  SEMANTIC_GRAPH_SCHEMA_VERSION,
  SEMANTIC_PROMPT_CONTRACT_VERSION,
  SEMANTIC_VECTOR_ARTIFACT_SCHEMA_VERSION,
  SEMANTIC_VECTOR_SCHEMA_VERSION
} from "../../semantic/domain/contracts.js";

type ReadSql = DatabaseClient | TransactionSql;

type KnowledgeBaseRow = {
  public_id: string;
  revision: number | string;
  deleted_at: Date | string | null;
};

type IdempotencyRow = {
  operation_public_id: string;
  request_hash: string;
};

type ActiveOperationRow = {
  public_id: string;
};

type ForegroundWorkRow = {
  work_kind: "upload" | "mutation" | "publication" | "deletion";
};

type ClaimRow = {
  knowledge_base_id: string;
  operation_public_id: string;
  search_provider_kind: SearchProviderKind | null;
  state: "queued" | "running" | "retry";
  attempt_count: number | string;
  lease_owner: string | null;
  safe_error_code: string | null;
  checkpoint: unknown;
};

type LiveStatusRow = {
  operation_public_id: string;
  search_provider_kind: SearchProviderKind | null;
  work_state: "queued" | "running" | "retry";
  attempt_count: number | string;
  safe_error_code: string | null;
  checkpoint: unknown;
};

type TerminalStatusRow = {
  operation_public_id: string;
  terminal_state: "completed" | "failed" | "superseded";
  result_code: string;
  result_summary: unknown;
  completed_at: Date | string;
};

export type StorageVnextMaintenanceRepositoryErrorCode =
  | "invalid_input"
  | "not_found"
  | "knowledge_base_deleted"
  | "knowledge_base_deleting"
  | "revision_conflict"
  | "idempotency_conflict"
  | "operation_conflict"
  | "lease_lost";

export class StorageVnextMaintenanceRepositoryError extends Error {
  public constructor(
    public readonly code: StorageVnextMaintenanceRepositoryErrorCode
  ) {
    super(`Storage vNext maintenance repository error: ${code}`);
    this.name = "StorageVnextMaintenanceRepositoryError";
  }
}

export function createPostgresStorageVnextMaintenanceRepository(
  sql: DatabaseClient,
  options: { selectedSearchProviderKind: SearchProviderKind }
): StorageVnextMaintenanceRepository {
  assertSearchProviderKind(options.selectedSearchProviderKind);
  const statusMapper = createStorageVnextMaintenanceStatusMapper();
  return {
    async acceptMaintenance(input) {
      validateAcceptanceInput(input);
      return sql.begin(async (transaction) => {
        const knowledgeBaseRows = await transaction<KnowledgeBaseRow[]>`
          SELECT public_id, revision, deleted_at
          FROM focowiki.knowledge_bases AS knowledge_base
          WHERE public_id = ${input.knowledgeBaseId}
          FOR UPDATE OF knowledge_base
        `;
        const knowledgeBase = knowledgeBaseRows[0];
        if (!knowledgeBase) throw repositoryError("not_found");
        if (knowledgeBase.deleted_at !== null) {
          throw repositoryError("knowledge_base_deleted");
        }

        const idempotent = await readIdempotency(transaction, input);
        if (idempotent) {
          if (idempotent.request_hash !== input.requestHash) {
            throw repositoryError("idempotency_conflict");
          }
          return acceptance("replayed", idempotent.operation_public_id, "active");
        }

        const foreground = await transaction<ForegroundWorkRow[]>`
          SELECT work.work_kind
          FROM focowiki.operation_work_items AS work
          JOIN focowiki.operations AS operation
            ON operation.knowledge_base_id = work.knowledge_base_id
           AND operation.public_id = work.operation_public_id
          WHERE work.knowledge_base_id = ${input.knowledgeBaseId}
            AND work.work_kind IN ('upload', 'mutation', 'publication', 'deletion')
            AND work.state IN ('queued', 'running', 'retry')
          ORDER BY CASE WHEN work.work_kind = 'deletion' THEN 0 ELSE 1 END,
                   work.operation_public_id
          FOR UPDATE OF work, operation
          LIMIT 1
        `;
        if (foreground[0]?.work_kind === "deletion") {
          throw repositoryError("knowledge_base_deleting");
        }
        if (foreground[0]) {
          return acceptance(
            "deferred",
            null,
            "deferred",
            "FOREGROUND_WORK_ACTIVE"
          );
        }

        const active = await readActiveMaintenance(
          transaction,
          input.knowledgeBaseId
        );
        if (active) return acceptance("already_active", active.public_id, "active");
        if (toSafeInteger(knowledgeBase.revision) !== input.expectedResourceRevision) {
          throw repositoryError("revision_conflict");
        }

        await transaction`
          INSERT INTO focowiki.operations (
            public_id, knowledge_base_id, operation_kind, state,
            expected_resource_revision, target_kind, target_public_id,
            created_at, updated_at
          ) VALUES (
            ${input.operationPublicId}, ${input.knowledgeBaseId}, 'maintenance',
            'accepted', ${input.expectedResourceRevision}, 'knowledge_base',
            ${input.knowledgeBaseId}, ${input.requestedAt}, ${input.requestedAt}
          )
        `;
        await transaction`
          INSERT INTO focowiki.operation_work_items (
            operation_public_id, knowledge_base_id, work_kind, state, operation_revision,
            settings_revision_public_id, search_provider_kind, attempt_count,
            next_attempt_at, checkpoint
          ) VALUES (
            ${input.operationPublicId}, ${input.knowledgeBaseId}, 'maintenance',
            'queued', 0, ${input.settingsRevisionPublicId},
            ${input.searchProviderKind}, 0,
            ${input.requestedAt}, ${transaction.json(input.initialCheckpoint)}
          )
        `;
        await transaction`
          INSERT INTO focowiki.operation_idempotency (
            public_id, knowledge_base_id, idempotency_key, request_hash,
            operation_public_id, expires_at, created_at
          ) VALUES (
            ${input.operationPublicId}, ${input.knowledgeBaseId},
            ${input.idempotencyKey}, ${input.requestHash},
            ${input.operationPublicId}, ${input.expiresAt}, ${input.requestedAt}
          )
        `;
        return acceptance("queued", input.operationPublicId, "queued");
      });
    },

    async claimOne(input) {
      assertId(input.workerId);
      assertTimestamp(input.leaseExpiresAt);
      assertSearchProviderKind(input.searchProviderKind);
      return sql.begin(async (transaction) => {
        const rows = await transaction<ClaimRow[]>`
          WITH candidate AS MATERIALIZED (
            SELECT work.operation_public_id
            FROM focowiki.operation_work_items AS work
            JOIN focowiki.operations AS operation
              ON operation.knowledge_base_id = work.knowledge_base_id
             AND operation.public_id = work.operation_public_id
            WHERE work.work_kind = 'maintenance'
              AND work.search_provider_kind = ${input.searchProviderKind}
              AND work.state IN ('queued', 'retry')
              AND (work.next_attempt_at IS NULL OR work.next_attempt_at <= now())
              AND operation.operation_kind = 'maintenance'
              AND operation.state IN ('accepted', 'validating', 'processing', 'publishing')
            ORDER BY work.next_attempt_at NULLS FIRST,
                     work.updated_at,
                     work.operation_public_id
            FOR UPDATE OF work SKIP LOCKED
            LIMIT 1
          ), claimed AS (
            UPDATE focowiki.operation_work_items AS work
            SET state = 'running', lease_owner = ${input.workerId},
                lease_expires_at = ${input.leaseExpiresAt},
                next_attempt_at = NULL, safe_error_code = NULL,
                updated_at = now()
            FROM candidate
            WHERE work.operation_public_id = candidate.operation_public_id
            RETURNING work.knowledge_base_id, work.operation_public_id,
                      work.search_provider_kind,
                      work.state, work.attempt_count, work.lease_owner,
                      work.safe_error_code, work.checkpoint
          )
          SELECT * FROM claimed
        `;
        const row = rows[0];
        if (!row) return null;
        await transaction`
          UPDATE focowiki.operations
          SET state = 'processing', updated_at = now()
          WHERE public_id = ${row.operation_public_id}
            AND knowledge_base_id = ${row.knowledge_base_id}
        `;
        return mapClaim(row);
      });
    },

    async saveProgress(input) {
      assertId(input.operationPublicId);
      assertId(input.leaseOwner);
      validateCheckpoint(input.checkpoint);
      await sql.begin(async (transaction) => {
        const terminal = await transaction<Array<{ public_id: string }>>`
          SELECT public_id FROM focowiki.operation_results
          WHERE public_id = ${input.operationPublicId}
        `;
        if (terminal[0]) {
          await transaction`
            DELETE FROM focowiki.operation_work_items
            WHERE operation_public_id = ${input.operationPublicId}
              AND work_kind = 'maintenance'
          `;
          return;
        }
        const rows = await transaction<Array<{ operation_public_id: string }>>`
          UPDATE focowiki.operation_work_items
          SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL,
              next_attempt_at = now(), attempt_count = 0, safe_error_code = NULL,
              checkpoint = ${transaction.json(input.checkpoint)}, updated_at = now()
          WHERE operation_public_id = ${input.operationPublicId}
            AND work_kind = 'maintenance' AND state = 'running'
            AND lease_owner = ${input.leaseOwner}
            AND search_provider_kind = ${input.checkpoint.searchProviderKind}
          RETURNING operation_public_id
        `;
        if (!rows[0]) throw repositoryError("lease_lost");
        await transaction`
          UPDATE focowiki.operations
          SET state = 'accepted', updated_at = now()
          WHERE public_id = ${input.operationPublicId}
            AND operation_kind = 'maintenance'
        `;
      });
    },

    async releaseForRetry(input) {
      assertId(input.operationPublicId);
      assertId(input.leaseOwner);
      assertSafeCode(input.safeErrorCode);
      return sql.begin(async (transaction) => {
        const terminal = await transaction<Array<{ public_id: string }>>`
          SELECT public_id FROM focowiki.operation_results
          WHERE public_id = ${input.operationPublicId}
        `;
        if (terminal[0]) {
          await transaction`
            DELETE FROM focowiki.operation_work_items
            WHERE operation_public_id = ${input.operationPublicId}
              AND work_kind = 'maintenance'
          `;
          return "exhausted" as const;
        }
        const rows = await transaction<Array<{
          attempt_count: number | string;
          max_attempts: number | string;
        }>>`
          SELECT attempt_count,
                 (checkpoint ->> 'maxAttempts')::integer AS max_attempts
          FROM focowiki.operation_work_items
          WHERE operation_public_id = ${input.operationPublicId}
            AND work_kind = 'maintenance' AND state = 'running'
            AND lease_owner = ${input.leaseOwner}
          FOR UPDATE
        `;
        const row = rows[0];
        if (!row) throw repositoryError("lease_lost");
        const attempt = toSafeInteger(row.attempt_count) + 1;
        const exhausted = attempt >= toSafeInteger(row.max_attempts);
        if (exhausted) {
          await transaction`
            UPDATE focowiki.operation_work_items
            SET state = 'running', attempt_count = ${attempt},
                safe_error_code = ${input.safeErrorCode}, updated_at = now()
            WHERE operation_public_id = ${input.operationPublicId}
              AND work_kind = 'maintenance' AND state = 'running'
              AND lease_owner = ${input.leaseOwner}
          `;
        } else {
          await transaction`
            UPDATE focowiki.operation_work_items
            SET state = 'retry', attempt_count = ${attempt},
                lease_owner = NULL, lease_expires_at = NULL,
                next_attempt_at = now(), safe_error_code = ${input.safeErrorCode},
                updated_at = now()
            WHERE operation_public_id = ${input.operationPublicId}
              AND work_kind = 'maintenance' AND state = 'running'
              AND lease_owner = ${input.leaseOwner}
          `;
          await transaction`
            UPDATE focowiki.operations
            SET state = 'accepted', updated_at = now()
            WHERE public_id = ${input.operationPublicId}
              AND operation_kind = 'maintenance'
          `;
        }
        return exhausted ? "exhausted" as const : "retry" as const;
      });
    },

    async complete(input) {
      assertId(input.operationPublicId);
      assertId(input.leaseOwner);
      assertSafeCode(input.resultCode);
      await sql.begin(async (transaction) => {
        const existing = await transaction<Array<{ public_id: string }>>`
          SELECT public_id FROM focowiki.operation_results
          WHERE public_id = ${input.operationPublicId}
        `;
        if (existing[0]) {
          await transaction`
            DELETE FROM focowiki.operation_work_items
            WHERE operation_public_id = ${input.operationPublicId}
              AND work_kind = 'maintenance'
          `;
          return;
        }
        const rows = await transaction<Array<{
          knowledge_base_id: string;
          expires_at: Date | string;
        }>>`
          SELECT work.knowledge_base_id, idempotency.expires_at
          FROM focowiki.operation_work_items AS work
          JOIN focowiki.operation_idempotency AS idempotency
            ON idempotency.knowledge_base_id = work.knowledge_base_id
           AND idempotency.operation_public_id = work.operation_public_id
          WHERE work.operation_public_id = ${input.operationPublicId}
            AND work.work_kind = 'maintenance' AND work.state = 'running'
            AND work.lease_owner = ${input.leaseOwner}
          FOR UPDATE OF work
        `;
        const row = rows[0];
        if (!row) throw repositoryError("lease_lost");
        const completedAt = new Date().toISOString();
        const expiresAt = timestamp(row.expires_at);
        if (Date.parse(expiresAt) <= Date.parse(completedAt)) {
          throw repositoryError("operation_conflict");
        }
        await transaction`
          UPDATE focowiki.operations
          SET state = ${input.state}, completed_at = ${completedAt}, updated_at = ${completedAt}
          WHERE public_id = ${input.operationPublicId}
            AND knowledge_base_id = ${row.knowledge_base_id}
            AND operation_kind = 'maintenance'
        `;
        await transaction`
          INSERT INTO focowiki.operation_results (
            public_id, knowledge_base_id, operation_kind, terminal_state,
            result_code, safe_message, result_summary, correlation_public_id,
            completed_at, expires_at
          ) VALUES (
            ${input.operationPublicId}, ${row.knowledge_base_id}, 'maintenance',
            ${input.state}, ${input.resultCode}, NULL,
            ${transaction.json(input.summary ?? {})}, NULL,
            ${completedAt}, ${expiresAt}
          )
        `;
        await transaction`
          DELETE FROM focowiki.operation_work_items
          WHERE operation_public_id = ${input.operationPublicId}
            AND work_kind = 'maintenance'
        `;
      });
    },

    async recoverStale(input) {
      assertTimestamp(input.expiredBefore);
      assertTimestamp(input.retryAt);
      assertLimit(input.limit);
      return sql.begin(async (transaction) => {
        const rows = await transaction<Array<{ operation_public_id: string }>>`
          WITH stale AS MATERIALIZED (
            SELECT work.operation_public_id
            FROM focowiki.operation_work_items AS work
            JOIN focowiki.operations AS operation
              ON operation.knowledge_base_id = work.knowledge_base_id
             AND operation.public_id = work.operation_public_id
            WHERE work.work_kind = 'maintenance' AND work.state = 'running'
              AND work.lease_expires_at <= ${input.expiredBefore}
              AND operation.state IN ('accepted', 'validating', 'processing', 'publishing')
            ORDER BY work.lease_expires_at, work.operation_public_id
            FOR UPDATE OF work SKIP LOCKED
            LIMIT ${input.limit}
          )
          UPDATE focowiki.operation_work_items AS work
          SET state = 'retry',
              lease_owner = NULL,
              lease_expires_at = NULL,
              next_attempt_at = ${input.retryAt},
              safe_error_code = 'MAINTENANCE_LEASE_EXPIRED',
              updated_at = now()
          FROM stale
          WHERE work.operation_public_id = stale.operation_public_id
          RETURNING work.operation_public_id
        `;
        const operationPublicIds = rows.map((row) => row.operation_public_id);
        if (operationPublicIds.length > 0) {
          await transaction`
            UPDATE focowiki.operations
            SET state = 'accepted', updated_at = now()
            WHERE public_id = ANY(${operationPublicIds})
          `;
        }
        return rows.length;
      });
    },

    async cancel(input) {
      assertId(input.knowledgeBaseId);
      assertId(input.operationPublicId);
      assertTimestamp(input.canceledAt);
      return sql.begin(async (transaction) => {
        const rows = await transaction<Array<{
          expires_at: Date | string;
          work_state: "queued" | "running" | "retry";
        }>>`
          SELECT idempotency.expires_at, work.state AS work_state
          FROM focowiki.operations operation
          JOIN focowiki.operation_work_items work
            ON work.knowledge_base_id = operation.knowledge_base_id
           AND work.operation_public_id = operation.public_id
           AND work.work_kind = 'maintenance'
          JOIN focowiki.operation_idempotency idempotency
            ON idempotency.knowledge_base_id = operation.knowledge_base_id
           AND idempotency.operation_public_id = operation.public_id
          WHERE operation.knowledge_base_id = ${input.knowledgeBaseId}
            AND operation.public_id = ${input.operationPublicId}
            AND operation.operation_kind = 'maintenance'
            AND operation.state IN (
              'accepted', 'validating', 'processing', 'publishing'
            )
          FOR UPDATE OF operation, work
        `;
        const row = rows[0];
        if (!row) return "not_active" as const;
        const expiresAt = timestamp(row.expires_at);
        if (Date.parse(expiresAt) <= Date.parse(input.canceledAt)) {
          throw repositoryError("operation_conflict");
        }
        await transaction`
          UPDATE focowiki.operations
          SET state = 'superseded', completed_at = ${input.canceledAt},
              updated_at = ${input.canceledAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND public_id = ${input.operationPublicId}
        `;
        await transaction`
          INSERT INTO focowiki.operation_results (
            public_id, knowledge_base_id, operation_kind, terminal_state,
            result_code, safe_message, result_summary,
            correlation_public_id, completed_at, expires_at
          ) VALUES (
            ${input.operationPublicId}, ${input.knowledgeBaseId},
            'maintenance', 'superseded', 'MAINTENANCE_CANCELLED', NULL,
            '{}'::jsonb, NULL, ${input.canceledAt}, ${expiresAt}
          )
          ON CONFLICT (public_id) DO NOTHING
        `;
        if (row.work_state !== "running") {
          await transaction`
            DELETE FROM focowiki.operation_work_items
            WHERE operation_public_id = ${input.operationPublicId}
              AND knowledge_base_id = ${input.knowledgeBaseId}
              AND work_kind = 'maintenance'
          `;
        }
        return "cancelled" as const;
      });
    },

    async getStatus(input) {
      assertId(input.knowledgeBaseId);
      const liveRows = await sql<LiveStatusRow[]>`
        SELECT work.operation_public_id, work.state AS work_state,
               work.search_provider_kind, work.attempt_count,
               work.safe_error_code, work.checkpoint
        FROM focowiki.operation_work_items AS work
        JOIN focowiki.operations AS operation
          ON operation.knowledge_base_id = work.knowledge_base_id
         AND operation.public_id = work.operation_public_id
        WHERE work.knowledge_base_id = ${input.knowledgeBaseId}
          AND work.work_kind = 'maintenance'
          AND work.state IN ('queued', 'running', 'retry')
          AND operation.operation_kind = 'maintenance'
          AND operation.state IN ('accepted', 'validating', 'processing', 'publishing')
        ORDER BY operation.created_at DESC, operation.public_id DESC
        LIMIT 1
      `;
      const live = liveRows[0];
      if (live) {
        const checkpoint = validateCheckpoint(live.checkpoint);
        assertMatchingSearchProvider(
          live.search_provider_kind,
          checkpoint.searchProviderKind
        );
        return statusMapper.mapLive({
          operationPublicId: live.operation_public_id,
          workState: live.work_state,
          retryCount: toSafeInteger(live.attempt_count),
          safeErrorCode: live.safe_error_code,
          checkpoint
        });
      }
      const profileRows = await sql<Array<{
        navigation_profile_version: number | string;
        provider_kind: SearchProviderKind;
        semantic_maintenance_required: boolean;
      }>>`
        SELECT root.navigation_profile_version, search.provider_kind,
               (
                 generation.public_id IS NULL
                 OR semantic_contract.public_id IS NULL
                 OR active_model.active_count <> 1
                 OR active_embedding.active_count <> 1
                 OR generation.generation_model_configuration_public_id
                    IS DISTINCT FROM active_model.public_id
                 OR generation.generation_model_configuration_revision
                    IS DISTINCT FROM active_model.revision
                 OR generation.extraction_contract_version
                    IS DISTINCT FROM ${SEMANTIC_EXTRACTION_CONTRACT_VERSION}
                 OR generation.graph_schema_version
                    IS DISTINCT FROM ${SEMANTIC_GRAPH_SCHEMA_VERSION}
                 OR generation.prompt_contract_version
                    IS DISTINCT FROM ${SEMANTIC_PROMPT_CONTRACT_VERSION}
                 OR semantic_contract.embedding_configuration_revision_public_id
                    IS DISTINCT FROM
                      active_embedding.vector_producing_revision_public_id
                 OR semantic_contract.embedding_query_policy_revision_public_id
                    IS DISTINCT FROM active_embedding.query_policy_revision_public_id
                 OR semantic_contract.minimum_vector_relevance
                    IS DISTINCT FROM active_embedding.minimum_vector_relevance
                 OR semantic_contract.resolved_dimension
                    IS DISTINCT FROM active_embedding.resolved_dimension
                 OR semantic_contract.normalization
                    IS DISTINCT FROM active_embedding.normalization
                 OR semantic_contract.artifact_schema_version
                    IS DISTINCT FROM ${SEMANTIC_VECTOR_ARTIFACT_SCHEMA_VERSION}
                 OR semantic_contract.vector_schema_version
                    IS DISTINCT FROM ${SEMANTIC_VECTOR_SCHEMA_VERSION}
                 OR semantic_contract.search_provider_kind
                    IS DISTINCT FROM ${options.selectedSearchProviderKind}
               ) AS semantic_maintenance_required
        FROM focowiki.active_snapshots snapshot
        JOIN focowiki.release_roots root
          ON root.knowledge_base_id = snapshot.knowledge_base_id
         AND root.public_id = snapshot.release_root_public_id
        JOIN focowiki.search_projections search
          ON search.knowledge_base_id = snapshot.knowledge_base_id
         AND search.public_id = snapshot.search_projection_public_id
        LEFT JOIN focowiki.semantic_generations generation
          ON generation.knowledge_base_id = snapshot.knowledge_base_id
         AND generation.generation_role = 'active'
         AND generation.state = 'active'
         AND generation.deleted_at IS NULL
        LEFT JOIN focowiki.semantic_projection_contracts semantic_contract
          ON semantic_contract.knowledge_base_id = generation.knowledge_base_id
         AND semantic_contract.semantic_generation_public_id = generation.public_id
        LEFT JOIN LATERAL (
          SELECT count(*)::integer AS active_count,
                 min(model.public_id) AS public_id,
                 min(model.revision) AS revision
          FROM focowiki.model_configs model
          WHERE model.knowledge_base_id IS NULL
            AND model.enabled = true
            AND model.config ->> 'status' = 'active'
        ) active_model ON true
        LEFT JOIN LATERAL (
          SELECT count(*)::integer AS active_count,
                 min(revision.vector_producing_revision_public_id)
                   AS vector_producing_revision_public_id,
                 min(revision.public_id) AS query_policy_revision_public_id,
                 min(revision.minimum_vector_relevance)
                   AS minimum_vector_relevance,
                 min(revision.resolved_dimension) AS resolved_dimension,
                 min(revision.normalization) AS normalization
          FROM focowiki.embedding_configurations configuration
          JOIN focowiki.embedding_configuration_revisions revision
            ON revision.configuration_public_id = configuration.public_id
           AND revision.public_id = configuration.active_revision_public_id
          WHERE configuration.lifecycle_status = 'active'
            AND configuration.deleted_at IS NULL
            AND revision.validation_status = 'valid'
        ) active_embedding ON true
        WHERE snapshot.knowledge_base_id = ${input.knowledgeBaseId}
        LIMIT 1
      `;
      const profileMaintenanceRequired = Number(
        profileRows[0]?.navigation_profile_version ?? 1
      ) < 1 || (
        profileRows[0] !== undefined
        && (
          profileRows[0].provider_kind !== options.selectedSearchProviderKind
          || profileRows[0].semantic_maintenance_required
        )
      );
      const terminalRows = await sql<TerminalStatusRow[]>`
        SELECT result.public_id AS operation_public_id, result.terminal_state,
               result.result_code, result.result_summary, result.completed_at
        FROM focowiki.operation_results AS result
        WHERE result.knowledge_base_id = ${input.knowledgeBaseId}
          AND result.operation_kind = 'maintenance'
          AND result.expires_at > now()
        ORDER BY result.completed_at DESC, result.public_id DESC
        LIMIT 1
      `;
      const terminal = terminalRows[0];
      if (!terminal) return statusMapper.mapIdle(profileMaintenanceRequired);
      const terminalStatus = statusMapper.mapTerminal({
        operationPublicId: terminal.operation_public_id,
        terminalState: terminal.terminal_state,
        resultCode: terminal.result_code,
        completedAt: timestamp(terminal.completed_at),
        summary: terminal.result_summary
      });
      return {
        ...terminalStatus,
        maintenanceRequired: terminalStatus.maintenanceRequired
          || profileMaintenanceRequired
      };
    }
  };
}

async function readIdempotency(
  sql: ReadSql,
  input: Pick<StorageVnextMaintenanceRequest, "knowledgeBaseId" | "idempotencyKey"> & {
    requestHash: string;
  }
): Promise<IdempotencyRow | null> {
  const rows = await sql<IdempotencyRow[]>`
    SELECT operation_public_id, request_hash
    FROM focowiki.operation_idempotency
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND idempotency_key = ${input.idempotencyKey}
      AND expires_at > now()
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function readActiveMaintenance(
  sql: ReadSql,
  knowledgeBaseId: string
): Promise<ActiveOperationRow | null> {
  const rows = await sql<ActiveOperationRow[]>`
    SELECT public_id
    FROM focowiki.operations
    WHERE knowledge_base_id = ${knowledgeBaseId}
      AND operation_kind = 'maintenance'
      AND state IN ('accepted', 'validating', 'processing', 'publishing')
    ORDER BY created_at, public_id
    LIMIT 1
  `;
  return rows[0] ?? null;
}

function acceptance(
  outcome: StorageVnextMaintenanceAcceptance["outcome"],
  operationPublicId: string | null,
  state: StorageVnextMaintenanceAcceptance["state"],
  reasonCode: string | null = null
): StorageVnextMaintenanceAcceptance {
  return { outcome, operationPublicId, state, reasonCode };
}

function mapClaim(row: ClaimRow): StorageVnextMaintenanceClaim {
  const checkpoint = validateCheckpoint(row.checkpoint);
  assertMatchingSearchProvider(
    row.search_provider_kind,
    checkpoint.searchProviderKind
  );
  return {
    knowledgeBaseId: row.knowledge_base_id,
    operationPublicId: row.operation_public_id,
    state: row.state,
    attempt: toSafeInteger(row.attempt_count),
    maxAttempts: checkpoint.maxAttempts,
    leaseOwner: row.lease_owner,
    safeErrorCode: row.safe_error_code,
    checkpoint
  };
}

function validateAcceptanceInput(input: StorageVnextMaintenanceRequest & {
  requestHash: string;
  initialCheckpoint: StorageVnextMaintenanceCheckpoint;
}): void {
  for (const value of [
    input.knowledgeBaseId,
    input.operationPublicId,
    input.idempotencyKey,
    input.settingsRevisionPublicId
  ]) assertId(value);
  if (!/^[0-9a-f]{64}$/u.test(input.requestHash)) {
    throw repositoryError("invalid_input");
  }
  assertTimestamp(input.requestedAt);
  assertTimestamp(input.expiresAt);
  assertSearchProviderKind(input.searchProviderKind);
  if (input.semanticAdoption && input.trigger !== "manual") {
    throw repositoryError("invalid_input");
  }
  if (input.semanticAdoption
    && input.semanticAdoption.target.knowledgeBaseId !== input.knowledgeBaseId) {
    throw repositoryError("invalid_input");
  }
  const checkpoint = validateCheckpoint(input.initialCheckpoint);
  assertMatchingSearchProvider(input.searchProviderKind, checkpoint.searchProviderKind);
}

function validateCheckpoint(value: unknown): StorageVnextMaintenanceCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw repositoryError("operation_conflict");
  }
  const item = value as Partial<StorageVnextMaintenanceCheckpoint>;
  if (
    item.version !== 1
    || !isSearchProviderKind(item.searchProviderKind)
    || !isTrigger(item.trigger)
    || !["standard", "provider_adoption"].includes(item.maintenanceKind as string)
    || !STORAGE_VNEXT_MAINTENANCE_PHASES.includes(item.phase as never)
    || (item.cursor !== null && typeof item.cursor !== "string")
    || !isNonnegativeInteger(item.batchOrdinal)
    || !isNonnegativeInteger(item.baseResourceRevision)
    || !isNonnegativeInteger(item.completedCount)
    || !isNonnegativeInteger(item.expectedCount)
    || !isNonnegativeInteger(item.processedBytes)
    || !isNonnegativeInteger(item.elapsedActiveMs)
    || typeof item.throughputPerSecond !== "number"
    || !Number.isFinite(item.throughputPerSecond)
    || item.throughputPerSecond < 0
    || (
      item.estimatedCompletionAt !== null
      && typeof item.estimatedCompletionAt !== "string"
    )
    || !isPositiveInteger(item.maxAttempts)
    || typeof item.startedAt !== "string"
    || typeof item.lastProgressAt !== "string"
    || typeof item.resultExpiresAt !== "string"
  ) throw repositoryError("operation_conflict");
  assertTimestamp(item.startedAt);
  assertTimestamp(item.lastProgressAt);
  assertTimestamp(item.resultExpiresAt);
  if (item.estimatedCompletionAt !== null) {
    assertTimestamp(item.estimatedCompletionAt);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 32_768) {
    throw repositoryError("operation_conflict");
  }
  validateSemanticAdoption(item.semanticAdoption, item.searchProviderKind);
  return value as StorageVnextMaintenanceCheckpoint;
}

function validateSemanticAdoption(
  value: StorageVnextMaintenanceCheckpoint["semanticAdoption"],
  searchProviderKind: SearchProviderKind
): void {
  if (value === undefined || value === null) return;
  if (
    typeof value !== "object"
    || ![
      "full", "embedding_only", "provider_only", "query_policy_only"
    ].includes(value.mode)
    || !value.target
    || value.target.searchProviderKind !== searchProviderKind
    || value.target.knowledgeBaseId === ""
    || typeof value.stageSettings !== "object"
    || value.stageSettings === null
    || !Number.isSafeInteger(value.expectedPredecessorRevision)
    || value.expectedPredecessorRevision < 0
    || !Number.isSafeInteger(value.sourcePageSize)
    || value.sourcePageSize < 1
    || value.sourcePageSize > 100
    || value.expectedPredecessorPublicId !== null
      && (
        !value.expectedPredecessorPublicId
        || Buffer.byteLength(value.expectedPredecessorPublicId) > 255
      )
  ) throw repositoryError("operation_conflict");
}

function assertSearchProviderKind(value: unknown): asserts value is SearchProviderKind {
  if (!isSearchProviderKind(value)) throw repositoryError("invalid_input");
}

function assertMatchingSearchProvider(
  persisted: unknown,
  checkpoint: SearchProviderKind
): asserts persisted is SearchProviderKind {
  if (!isSearchProviderKind(persisted) || persisted !== checkpoint) {
    throw repositoryError("operation_conflict");
  }
}

function isTrigger(value: unknown): value is StorageVnextMaintenanceTrigger {
  return value === "manual" || value === "automatic";
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function assertId(value: string): void {
  if (!value || Buffer.byteLength(value) > 255) {
    throw repositoryError("invalid_input");
  }
}

function assertSafeCode(value: string): void {
  if (!value || Buffer.byteLength(value) > 128) {
    throw repositoryError("invalid_input");
  }
}

function assertTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw repositoryError("invalid_input");
}

function assertLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw repositoryError("invalid_input");
  }
}

function toSafeInteger(value: number | string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw repositoryError("operation_conflict");
  }
  return result;
}

function timestamp(value: Date | string): string {
  const result = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(result.getTime())) throw repositoryError("operation_conflict");
  return result.toISOString();
}

function repositoryError(
  code: StorageVnextMaintenanceRepositoryErrorCode
): StorageVnextMaintenanceRepositoryError {
  return new StorageVnextMaintenanceRepositoryError(code);
}
