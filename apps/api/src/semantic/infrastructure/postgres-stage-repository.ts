import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import type {
  SemanticStageRepositoryPort,
  SemanticStageWorkClaim
} from "../application/stage-ports.js";
import type {
  SemanticStageKind,
  SemanticStageSettingsSnapshot
} from "../application/stage-orchestration.js";

type ClaimRow = {
  public_id: string;
  knowledge_base_id: string;
  operation_public_id: string;
  semantic_generation_public_id: string;
  source_file_public_id: string;
  source_revision_public_id: string;
  stage_kind: SemanticStageKind;
  partition_key: string;
  extraction_contract_version: string;
  embedding_configuration_revision_public_id: string;
  settings_snapshot: unknown;
  state: "running";
  attempt_count: number | string;
  maximum_attempts: number | string;
  checkpoint: unknown;
  lease_owner: string;
  lease_expires_at: Date | string;
  cancellation_requested_at: Date | string | null;
  revision: number | string;
};

type FinalizedStageRow = {
  public_id: string;
  knowledge_base_id: string;
  source_file_public_id: string;
  source_revision_public_id: string;
  state: "completed" | "retry" | "failed" | "cancelled" | "superseded";
  safe_error_code: string | null;
};

const STAGE_KINDS: readonly SemanticStageKind[] = [
  "extraction", "reconciliation", "community", "embedding",
  "vector", "publication", "validation", "cleanup"
];

export function createPostgresSemanticStageRepository(
  sql: DatabaseClient
): SemanticStageRepositoryPort {
  return {
    async enqueue(input) {
      assertBatch(input.items);
      assertTimestamp(input.enqueuedAt);
      if (input.items.length === 0) return 0;
      return sql.begin((transaction) => enqueueSemanticStagesInTransaction(
        transaction,
        input
      ));
    },
    async claim(input) {
      const kinds = uniqueKinds(input.stageKinds);
      const excludedKnowledgeBaseIds = uniqueKnowledgeBaseIds(
        input.excludedKnowledgeBaseIds ?? []
      );
      assertOwner(input.owner);
      assertLimit(input.limit);
      const maximumParallelStagesPerKnowledgeBase =
        input.maximumParallelStagesPerKnowledgeBase ?? input.limit;
      assertLimit(maximumParallelStagesPerKnowledgeBase);
      assertTimestamp(input.now);
      assertTimestamp(input.leaseExpiresAt);
      const rows = await sql<ClaimRow[]>`
        WITH eligible AS (
          SELECT work.public_id, work.knowledge_base_id,
                 CASE work.stage_kind
                   WHEN 'extraction' THEN 1 WHEN 'cleanup' THEN 1
                   WHEN 'reconciliation' THEN 2 WHEN 'community' THEN 3
                   WHEN 'embedding' THEN 4 WHEN 'vector' THEN 5
                   WHEN 'publication' THEN 6 WHEN 'validation' THEN 7
                   ELSE 100 END AS stage_order,
                 row_number() OVER (
                   PARTITION BY work.knowledge_base_id, work.stage_kind
                   ORDER BY work.next_attempt_at, work.created_at,
                     work.public_id COLLATE "C"
                 ) AS wave_ordinal,
                 (
                   SELECT count(*)
                   FROM focowiki.semantic_stage_work_items active_work
                   WHERE active_work.knowledge_base_id = work.knowledge_base_id
                     AND active_work.state = 'running'
                 ) AS active_stage_count
          FROM focowiki.semantic_stage_work_items work
          JOIN focowiki.semantic_generations generation
            ON generation.knowledge_base_id = work.knowledge_base_id
           AND generation.public_id = work.semantic_generation_public_id
           AND (
             generation.generation_role = 'candidate'
               AND generation.state IN ('building', 'validating')
             OR generation.generation_role = 'active'
               AND generation.state = 'active'
           )
           AND generation.deleted_at IS NULL
          JOIN focowiki.operations owning_operation
            ON owning_operation.knowledge_base_id = work.knowledge_base_id
           AND owning_operation.public_id = work.operation_public_id
          WHERE work.stage_kind = ANY(${kinds})
            AND NOT (work.knowledge_base_id = ANY(${excludedKnowledgeBaseIds}))
            AND work.state IN ('queued', 'retry')
            AND (
              NOT EXISTS (
                SELECT 1
                FROM focowiki.semantic_stage_work_items active_work
                WHERE active_work.knowledge_base_id = work.knowledge_base_id
                  AND active_work.state = 'running'
              )
              OR (
                work.stage_kind IN (
                  'extraction', 'reconciliation', 'community',
                  'embedding', 'vector', 'publication'
                )
                AND (
                  SELECT count(*)
                  FROM focowiki.semantic_stage_work_items active_work
                  WHERE active_work.knowledge_base_id = work.knowledge_base_id
                    AND active_work.state = 'running'
                ) < ${maximumParallelStagesPerKnowledgeBase}
                AND NOT EXISTS (
                  SELECT 1
                  FROM focowiki.semantic_stage_work_items active_work
                  WHERE active_work.knowledge_base_id = work.knowledge_base_id
                    AND active_work.state = 'running'
                    AND active_work.stage_kind <> work.stage_kind
                )
              )
            )
            AND work.next_attempt_at <= ${input.now}
            AND work.cancellation_requested_at IS NULL
            AND work.attempt_count < work.maximum_attempts
            AND (
              owning_operation.operation_kind <> 'source_processing'
              OR owning_operation.state = 'completed'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM focowiki.semantic_stage_work_items predecessor
              WHERE predecessor.operation_public_id = work.operation_public_id
                AND predecessor.public_id <> work.public_id
                AND CASE predecessor.stage_kind
                  WHEN 'extraction' THEN 1 WHEN 'cleanup' THEN 1
                  WHEN 'reconciliation' THEN 2 WHEN 'community' THEN 3
                  WHEN 'embedding' THEN 4 WHEN 'vector' THEN 5
                  WHEN 'publication' THEN 6 WHEN 'validation' THEN 7
                  ELSE 100 END
                < CASE work.stage_kind
                  WHEN 'extraction' THEN 1 WHEN 'cleanup' THEN 1
                  WHEN 'reconciliation' THEN 2 WHEN 'community' THEN 3
                  WHEN 'embedding' THEN 4 WHEN 'vector' THEN 5
                  WHEN 'publication' THEN 6 WHEN 'validation' THEN 7
                  ELSE 100 END
                AND predecessor.state <> 'completed'
            )
        ), candidates AS (
          SELECT work.public_id
          FROM focowiki.semantic_stage_work_items work
          JOIN eligible ON eligible.public_id = work.public_id
          WHERE NOT EXISTS (
              SELECT 1
              FROM eligible earlier
              WHERE earlier.knowledge_base_id = eligible.knowledge_base_id
                AND earlier.stage_order < eligible.stage_order
            )
            AND (
              work.stage_kind IN (
                'extraction', 'reconciliation', 'community',
                'embedding', 'vector', 'publication'
              )
                AND eligible.wave_ordinal
                  <= ${maximumParallelStagesPerKnowledgeBase}
                    - eligible.active_stage_count
              OR work.stage_kind NOT IN (
                'extraction', 'reconciliation', 'community',
                'embedding', 'vector', 'publication'
              )
                AND eligible.wave_ordinal = 1
            )
            AND pg_try_advisory_xact_lock(
              hashtextextended(work.knowledge_base_id, 0)
            )
          ORDER BY eligible.stage_order, work.next_attempt_at, work.created_at,
            work.public_id COLLATE "C"
          LIMIT ${input.limit}
          FOR UPDATE OF work SKIP LOCKED
        )
        UPDATE focowiki.semantic_stage_work_items work
        SET state = 'running', attempt_count = work.attempt_count + 1,
            lease_owner = ${input.owner}, lease_expires_at = ${input.leaseExpiresAt},
            execution_started_at = ${input.now},
            safe_error_code = NULL, revision = work.revision + 1,
            updated_at = ${input.now}
        FROM candidates
        WHERE work.public_id = candidates.public_id
          AND work.state IN ('queued', 'retry')
        RETURNING work.*
      `;
      return rows.map(mapClaim);
    },
    async isOwned(input) {
      const rows = await sql<Array<{ owned: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM focowiki.semantic_stage_work_items work
          JOIN focowiki.semantic_generations generation
            ON generation.knowledge_base_id = work.knowledge_base_id
           AND generation.public_id = work.semantic_generation_public_id
          WHERE work.public_id = ${input.claim.publicId}
            AND work.state = 'running'
            AND work.lease_owner = ${input.claim.leaseOwner}
            AND work.revision = ${input.claim.revision}
            AND work.cancellation_requested_at IS NULL
            AND (
              generation.generation_role = 'candidate'
                AND generation.state IN ('building', 'validating')
              OR generation.generation_role = 'active'
                AND generation.state = 'active'
            )
            AND generation.deleted_at IS NULL
        ) AS owned
      `;
      return rows[0]?.owned === true;
    },
    async renew(input) {
      assertTimestamp(input.leaseExpiresAt);
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.semantic_stage_work_items
        SET lease_expires_at = ${input.leaseExpiresAt}, updated_at = now()
        WHERE public_id = ${input.claim.publicId}
          AND state = 'running' AND lease_owner = ${input.claim.leaseOwner}
          AND revision = ${input.claim.revision}
          AND cancellation_requested_at IS NULL
        RETURNING public_id
      `;
      return Boolean(rows[0]);
    },
    async saveCheckpoint(input) {
      assertSnapshot(input.checkpoint);
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.semantic_stage_work_items
        SET checkpoint = ${sql.json(input.checkpoint)}, updated_at = now()
        WHERE public_id = ${input.claim.publicId}
          AND state = 'running' AND lease_owner = ${input.claim.leaseOwner}
          AND revision = ${input.claim.revision}
          AND cancellation_requested_at IS NULL
        RETURNING public_id
      `;
      return Boolean(rows[0]);
    },
    async finish(input) {
      assertTimestamp(input.nextAttemptAt);
      assertTimestamp(input.completedAt);
      if (input.safeCode !== null && (!input.safeCode || input.safeCode.length > 128)) {
        throw stageError("invalid_safe_code");
      }
      const retry = input.outcome === "retry";
      return sql.begin(async (transaction) => {
        const rows = await transaction<FinalizedStageRow[]>`
          UPDATE focowiki.semantic_stage_work_items
          SET state = CASE
                WHEN ${retry} AND attempt_count >= maximum_attempts THEN 'failed'
                ELSE ${input.outcome}
              END,
              service_time_milliseconds = service_time_milliseconds
                + floor(greatest(0, extract(epoch FROM (
                    ${input.completedAt}::timestamptz - execution_started_at
                  )) * 1000))::bigint,
              lease_owner = NULL, lease_expires_at = NULL,
              execution_started_at = NULL,
              next_attempt_at = ${input.nextAttemptAt},
              safe_error_code = ${input.safeCode},
              completed_at = CASE
                WHEN ${retry} AND attempt_count < maximum_attempts THEN NULL
                ELSE ${input.completedAt}::timestamptz
              END,
              revision = revision + 1, updated_at = ${input.completedAt}
          WHERE public_id = ${input.claim.publicId}
            AND state = 'running' AND lease_owner = ${input.claim.leaseOwner}
            AND revision = ${input.claim.revision}
          RETURNING public_id, knowledge_base_id, source_file_public_id,
                    source_revision_public_id, state, safe_error_code
        `;
        await failCurrentSourcesForTerminalStages(
          transaction,
          rows,
          input.completedAt
        );
        return Boolean(rows[0]);
      });
    },
    async requestCancellation(input) {
      assertTimestamp(input.requestedAt);
      if (input.sourceFilePublicIds !== null && input.sourceFilePublicIds.length === 0) return 0;
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.semantic_stage_work_items
        SET cancellation_requested_at = ${input.requestedAt},
            state = CASE WHEN state IN ('queued', 'retry') THEN 'cancelled' ELSE state END,
            completed_at = CASE WHEN state IN ('queued', 'retry')
              THEN ${input.requestedAt}::timestamptz ELSE completed_at END,
            revision = revision + 1, updated_at = ${input.requestedAt}
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND semantic_generation_public_id = ${input.semanticGenerationPublicId}
          AND state IN ('queued', 'running', 'retry')
          AND (${input.sourceFilePublicIds}::text[] IS NULL
            OR source_file_public_id = ANY(${input.sourceFilePublicIds}))
          AND (${input.exceptOperationPublicId ?? null}::text IS NULL
            OR operation_public_id <> ${input.exceptOperationPublicId ?? null})
        RETURNING public_id
      `;
      return rows.length;
    },
    async recoverExpired(input) {
      assertTimestamp(input.expiredBefore);
      assertTimestamp(input.nextAttemptAt);
      assertLimit(input.limit);
      return sql.begin(async (transaction) => {
        const rows = await transaction<FinalizedStageRow[]>`
          WITH expired AS (
            SELECT public_id
            FROM focowiki.semantic_stage_work_items
            WHERE state = 'running' AND lease_expires_at <= ${input.expiredBefore}
            ORDER BY lease_expires_at, public_id COLLATE "C"
            LIMIT ${input.limit}
            FOR UPDATE SKIP LOCKED
          )
          UPDATE focowiki.semantic_stage_work_items work
          SET state = CASE
                WHEN work.cancellation_requested_at IS NOT NULL THEN 'cancelled'
                WHEN work.attempt_count >= work.maximum_attempts THEN 'failed'
                ELSE 'retry'
              END,
              service_time_milliseconds = work.service_time_milliseconds
                + floor(greatest(0, extract(epoch FROM (
                    ${input.expiredBefore}::timestamptz - work.execution_started_at
                  )) * 1000))::bigint,
              lease_owner = NULL, lease_expires_at = NULL,
              execution_started_at = NULL,
              next_attempt_at = ${input.nextAttemptAt},
              safe_error_code = CASE
                WHEN work.cancellation_requested_at IS NOT NULL
                  THEN 'semantic_stage_cancelled'
                ELSE 'semantic_stage_lease_expired'
              END,
              completed_at = CASE
                WHEN work.cancellation_requested_at IS NOT NULL
                  OR work.attempt_count >= work.maximum_attempts
                THEN ${input.expiredBefore}::timestamptz ELSE NULL END,
              revision = work.revision + 1, updated_at = ${input.expiredBefore}
          FROM expired
          WHERE work.public_id = expired.public_id
          RETURNING work.public_id, work.knowledge_base_id,
                    work.source_file_public_id,
                    work.source_revision_public_id, work.state,
                    work.safe_error_code
        `;
        await failCurrentSourcesForTerminalStages(
          transaction,
          rows,
          input.expiredBefore
        );
        return rows.length;
      });
    },
    async summarizeOperation(input) {
      assertOwner(input.knowledgeBaseId);
      assertOwner(input.operationPublicId);
      assertOwner(input.semanticGenerationPublicId);
      const rows = await sql<Array<{
        total_count: number | string;
        completed_count: number | string;
        pending_count: number | string;
        failed_count: number | string;
        cancelled_count: number | string;
        superseded_count: number | string;
        reused_artifact_count: number | string;
      }>>`
        SELECT count(*) AS total_count,
               count(*) FILTER (WHERE state = 'completed') AS completed_count,
               count(*) FILTER (
                 WHERE state IN ('queued', 'running', 'retry')
               ) AS pending_count,
               count(*) FILTER (WHERE state = 'failed') AS failed_count,
               count(*) FILTER (WHERE state = 'cancelled') AS cancelled_count,
               count(*) FILTER (WHERE state = 'superseded') AS superseded_count,
               coalesce(sum(
                 CASE WHEN state = 'completed'
                   THEN coalesce((checkpoint->>'reusedArtifactCount')::integer, 0)
                   ELSE 0 END
               ), 0) AS reused_artifact_count
        FROM focowiki.semantic_stage_work_items
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND operation_public_id = ${input.operationPublicId}
          AND semantic_generation_public_id = ${input.semanticGenerationPublicId}
      `;
      const row = rows[0];
      return {
        totalCount: Number(row?.total_count ?? 0),
        completedCount: Number(row?.completed_count ?? 0),
        pendingCount: Number(row?.pending_count ?? 0),
        failedCount: Number(row?.failed_count ?? 0),
        cancelledCount: Number(row?.cancelled_count ?? 0),
        supersededCount: Number(row?.superseded_count ?? 0),
        reusedArtifactCount: Number(row?.reused_artifact_count ?? 0)
      };
    }
  };
}

async function failCurrentSourcesForTerminalStages(
  transaction: TransactionSql,
  stages: readonly FinalizedStageRow[],
  failedAt: string
): Promise<void> {
  const failed = stages.filter((stage) => stage.state === "failed");
  if (failed.length === 0) return;
  await transaction`
    UPDATE focowiki.source_files source
    SET status = 'failed',
        safe_error_code = failure.safe_error_code,
        safe_error_message = NULL,
        revision = source.revision + 1,
        updated_at = ${failedAt}
    FROM jsonb_to_recordset(${transaction.json(failed as never)}) AS failure(
      knowledge_base_id text,
      source_file_public_id text,
      source_revision_public_id text,
      safe_error_code text
    )
    JOIN focowiki.source_file_current_revisions current_revision
      ON current_revision.knowledge_base_id = failure.knowledge_base_id
     AND current_revision.source_file_public_id = failure.source_file_public_id
     AND current_revision.source_revision_public_id
       = failure.source_revision_public_id
    WHERE source.knowledge_base_id = failure.knowledge_base_id
      AND source.public_id = failure.source_file_public_id
      AND source.deleted_at IS NULL
      AND source.status IN ('pending', 'processing')
  `;
}

export async function enqueueSemanticStagesInTransaction(
  sql: TransactionSql,
  input: Parameters<SemanticStageRepositoryPort["enqueue"]>[0]
): Promise<number> {
  assertBatch(input.items);
  assertTimestamp(input.enqueuedAt);
  if (input.items.length === 0) return 0;
  const rows = await sql<Array<{ public_id: string }>>`
    INSERT INTO focowiki.semantic_stage_work_items AS work (
      public_id, knowledge_base_id, operation_public_id,
      semantic_generation_public_id, source_file_public_id,
      source_revision_public_id, stage_kind, partition_key,
      extraction_contract_version,
      embedding_configuration_revision_public_id, settings_snapshot,
      state, attempt_count, maximum_attempts, checkpoint,
      next_attempt_at, revision, created_at, updated_at
    )
    SELECT item."publicId", item."knowledgeBaseId", item."operationPublicId",
           item."semanticGenerationPublicId", item."sourceFilePublicId",
           item."sourceRevisionPublicId", item."stageKind", item."partitionKey",
           item."extractionContractVersion",
           item."embeddingConfigurationRevisionPublicId", item."settingsSnapshot",
           'queued', 0, item."maximumAttempts", '{}'::jsonb,
           ${input.enqueuedAt}, 0, ${input.enqueuedAt}, ${input.enqueuedAt}
    FROM jsonb_to_recordset(${sql.json(input.items as never)}) AS item(
      "publicId" text, "knowledgeBaseId" text, "operationPublicId" text,
      "semanticGenerationPublicId" text, "sourceFilePublicId" text,
      "sourceRevisionPublicId" text, "stageKind" text, "partitionKey" text,
      "extractionContractVersion" text,
      "embeddingConfigurationRevisionPublicId" text,
      "settingsSnapshot" jsonb, "maximumAttempts" integer
    )
    ON CONFLICT (operation_public_id, stage_kind, partition_key) DO UPDATE SET
      public_id = work.public_id
    WHERE work.public_id = excluded.public_id
      AND work.knowledge_base_id = excluded.knowledge_base_id
      AND work.semantic_generation_public_id
        = excluded.semantic_generation_public_id
      AND work.source_file_public_id = excluded.source_file_public_id
      AND work.source_revision_public_id = excluded.source_revision_public_id
      AND work.extraction_contract_version
        = excluded.extraction_contract_version
      AND work.embedding_configuration_revision_public_id
        = excluded.embedding_configuration_revision_public_id
      AND work.settings_snapshot = excluded.settings_snapshot
      AND work.maximum_attempts = excluded.maximum_attempts
    RETURNING public_id
  `;
  if (rows.length !== input.items.length) throw stageError("enqueue_conflict");
  return rows.length;
}

function mapClaim(row: ClaimRow): SemanticStageWorkClaim {
  return {
    publicId: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    operationPublicId: row.operation_public_id,
    semanticGenerationPublicId: row.semantic_generation_public_id,
    sourceFilePublicId: row.source_file_public_id,
    sourceRevisionPublicId: row.source_revision_public_id,
    stageKind: row.stage_kind,
    partitionKey: row.partition_key,
    extractionContractVersion: row.extraction_contract_version,
    embeddingConfigurationRevisionPublicId:
      row.embedding_configuration_revision_public_id,
    settingsSnapshot: readSnapshot(row.settings_snapshot),
    maximumAttempts: Number(row.maximum_attempts),
    state: "running",
    attemptCount: Number(row.attempt_count),
    checkpoint: readSnapshot(row.checkpoint),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: new Date(row.lease_expires_at).toISOString(),
    cancellationRequestedAt: row.cancellation_requested_at
      ? new Date(row.cancellation_requested_at).toISOString() : null,
    revision: Number(row.revision)
  };
}

function uniqueKinds(values: readonly SemanticStageKind[]): SemanticStageKind[] {
  const result = [...new Set(values)];
  if (result.length === 0 || result.some((value) => !STAGE_KINDS.includes(value))) {
    throw stageError("invalid_stage_kind");
  }
  return result;
}

function uniqueKnowledgeBaseIds(values: readonly string[]): string[] {
  const unique = [...new Set(values)];
  if (unique.length > 32 || unique.some((value) => (
    !value || Buffer.byteLength(value) > 255
  ))) {
    throw new Error("Semantic stage knowledge-base exclusions are invalid");
  }
  return unique;
}

function readSnapshot(value: unknown): SemanticStageSettingsSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw stageError("invalid_snapshot");
  }
  return value as SemanticStageSettingsSnapshot;
}

function assertSnapshot(value: SemanticStageSettingsSnapshot): void {
  if (Buffer.byteLength(JSON.stringify(value)) > 32_768) throw stageError("snapshot_limit");
}

function assertBatch(values: readonly unknown[]): void {
  if (values.length > 1_000) throw stageError("batch_limit");
}

function assertLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw stageError("invalid_limit");
  }
}

function assertOwner(value: string): void {
  if (!value || value.length > 255) throw stageError("invalid_owner");
}

function assertTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw stageError("invalid_timestamp");
}

function stageError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Semantic stage repository error: ${code}`), { code });
}
