import type {
  ClaimedPublicationImpact,
  PublicationImpactRepository
} from "../../application/ports/publication-impact-repository.js";
import type { SerializableJson } from "../../application/ports/source-dispatch-repository.js";
import type { ChangeFactKind, ProjectionKind } from "../../domain/generation.js";
import type { PublicationProjectionInput } from "../../application/ports/publication-projection-input.js";
import type { DatabaseClient } from "../../db/client.js";

type ImpactRow = {
  id: string;
  knowledge_base_id: string;
  generation_id: string;
  change_fact_id: string;
  change_kind: string;
  source_file_id: string | null;
  source_revision_id: string | null;
  previous_path: string | null;
  path: string | null;
  resource_revision: number;
  projection_kind: string;
  projection_key: string;
  record_identity: string;
  action: string;
  retry_cursor_json: SerializableJson;
  attempt_count: number;
  max_attempts: number;
  projection_input_json: PublicationProjectionInput | null;
};

export function createPostgresPublicationImpactRepository(
  sql: DatabaseClient
): PublicationImpactRepository {
  return {
    async claimBatch(input) {
      return claimPublicationImpactBatch(sql, input);
    },

    async claimPartitionBatch(input) {
      return claimPublicationImpactBatch(sql, input);
    },

    async heartbeat(input) {
      if (input.impactIds.length === 0) {
        return 0;
      }
      const rows = await sql<Array<{ id: string }>>`
        UPDATE focowiki.publication_impacts
        SET heartbeat_at = ${input.heartbeatAt}, updated_at = ${input.heartbeatAt}
        WHERE id IN ${sql(input.impactIds)}
          AND status = 'running'
          AND claimed_by = ${input.workerId}
        RETURNING id
      `;
      return rows.length;
    },

    async release(input) {
      if (input.impactIds.length === 0) return 0;
      const rows = await sql<Array<{ id: string }>>`
        UPDATE focowiki.publication_impacts
        SET status = 'pending', claimed_by = NULL, claimed_at = NULL,
            heartbeat_at = NULL, attempt_count = greatest(0, attempt_count - 1),
            updated_at = ${input.releasedAt}
        WHERE id IN ${sql(input.impactIds)}
          AND status = 'running'
          AND claimed_by = ${input.workerId}
        RETURNING id
      `;
      return rows.length;
    },

    async complete(input) {
      assertNonNegativeInteger(input.touchedShardCount, "touchedShardCount");
      return (await completePublicationImpactBatch(sql, {
        knowledgeBaseId: input.knowledgeBaseId,
        generationId: input.generationId,
        workerId: input.workerId,
        completions: [{
          impactId: input.impactId,
          touchedShardCount: input.touchedShardCount
        }],
        completedAt: input.completedAt
      })) === 1;
    },

    async completeBatch(input) {
      for (const completion of input.completions) {
        assertNonNegativeInteger(completion.touchedShardCount, "touchedShardCount");
      }
      return completePublicationImpactBatch(sql, input);
    },

    async fail(input) {
      return sql.begin(async (transaction) => {
        const rows = await transaction<Array<{
          attempt_count: number;
          max_attempts: number;
        }>>`
          SELECT attempt_count, max_attempts
          FROM focowiki.publication_impacts
          WHERE id = ${input.impactId}
            AND knowledge_base_id = ${input.knowledgeBaseId}
            AND generation_id = ${input.generationId}
            AND status = 'running'
            AND claimed_by = ${input.workerId}
          FOR UPDATE
        `;
        const row = rows[0];
        if (!row) {
          throw new Error("Publication impact claim is no longer owned");
        }
        const terminal = row.attempt_count >= row.max_attempts;
        await transaction`
          UPDATE focowiki.publication_impacts
          SET status = ${terminal ? "failed" : "pending"},
              retry_cursor_json = ${transaction.json(input.retryCursor)},
              run_after = ${input.retryAt}, claimed_by = NULL, claimed_at = NULL,
              heartbeat_at = NULL, last_error_code = ${input.code},
              last_error_message = ${input.message.slice(0, 1_000)},
              updated_at = ${input.failedAt}
          WHERE id = ${input.impactId}
        `;
        return {
          terminal,
          attemptCount: row.attempt_count,
          maxAttempts: row.max_attempts
        };
      });
    },

    async countIncomplete(input) {
      const rows = await sql<Array<{
        pending: number;
        running: number;
        failed: number;
      }>>`
        SELECT
          count(*) FILTER (WHERE status = 'pending')::int AS pending,
          count(*) FILTER (WHERE status = 'running')::int AS running,
          count(*) FILTER (WHERE status = 'failed')::int AS failed
        FROM focowiki.publication_impacts
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND generation_id = ${input.generationId}
      `;
      return rows[0] ?? { pending: 0, running: 0, failed: 0 };
    },

    async countPartitionIncomplete(input) {
      const rows = await sql<Array<{
        pending: number;
        running: number;
        failed: number;
        completed: number;
      }>>`
        SELECT
          count(*) FILTER (WHERE status = 'pending')::int AS pending,
          count(*) FILTER (WHERE status = 'running')::int AS running,
          count(*) FILTER (WHERE status = 'failed')::int AS failed,
          count(*) FILTER (WHERE status = 'completed')::int AS completed
        FROM focowiki.publication_impacts
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND generation_id = ${input.generationId}
          AND physical_partition = ${input.physicalPartition}
      `;
      return rows[0] ?? { pending: 0, running: 0, failed: 0, completed: 0 };
    }
  };
}

async function claimPublicationImpactBatch(
  sql: DatabaseClient,
  input: Parameters<PublicationImpactRepository["claimBatch"]>[0] & {
    physicalPartition?: string;
  }
): Promise<ClaimedPublicationImpact[]> {
      assertPositiveInteger(input.limit, "limit");
      return sql.begin(async (transaction) => {
        await transaction`
          UPDATE focowiki.publication_impacts
          SET status = 'pending', claimed_by = NULL, claimed_at = NULL,
              heartbeat_at = NULL, updated_at = ${input.now}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND generation_id = ${input.generationId}
            AND (${input.physicalPartition ?? null}::text IS NULL
              OR physical_partition = ${input.physicalPartition ?? null})
            AND status = 'running'
            AND heartbeat_at < ${input.staleBefore}
        `;
        const rows = await transaction<ImpactRow[]>`
          WITH candidates AS (
            SELECT impact.id
            FROM focowiki.publication_impacts impact
            JOIN focowiki.publication_generations generation
              ON generation.id = impact.generation_id
             AND generation.knowledge_base_id = impact.knowledge_base_id
            WHERE impact.knowledge_base_id = ${input.knowledgeBaseId}
              AND impact.generation_id = ${input.generationId}
              AND (${input.physicalPartition ?? null}::text IS NULL
                OR impact.physical_partition = ${input.physicalPartition ?? null})
              AND impact.status = 'pending'
              AND impact.run_after <= ${input.now}
              AND generation.state IN ('frozen', 'building')
            ORDER BY impact.created_at, impact.projection_kind,
                     impact.projection_key, impact.record_identity, impact.id
            LIMIT ${input.limit}
            FOR UPDATE OF impact SKIP LOCKED
          ), claimed AS (
            UPDATE focowiki.publication_impacts impact
            SET status = 'running', claimed_by = ${input.workerId},
                claimed_at = ${input.now}, heartbeat_at = ${input.now},
                attempt_count = impact.attempt_count + 1,
                last_error_code = NULL, last_error_message = NULL,
                updated_at = ${input.now}
            FROM candidates
            WHERE impact.id = candidates.id
            RETURNING impact.*
          )
          SELECT claimed.id, claimed.knowledge_base_id, claimed.generation_id,
                 fact.id AS change_fact_id, fact.kind AS change_kind,
                 fact.source_file_id, fact.source_revision_id,
                 fact.previous_path, fact.path, fact.resource_revision,
                 claimed.projection_kind, claimed.projection_key,
                 claimed.record_identity, claimed.action,
                 claimed.retry_cursor_json, claimed.attempt_count, claimed.max_attempts,
                 projection_input.payload_json AS projection_input_json
          FROM claimed
          JOIN LATERAL (
            SELECT fact.*
            FROM focowiki.publication_impact_causes cause
            JOIN focowiki.publication_change_facts fact
              ON fact.id = cause.change_fact_id
            WHERE cause.impact_id = claimed.id
            ORDER BY fact.resource_revision DESC, fact.created_at DESC, fact.id DESC
            LIMIT 1
          ) fact ON true
          LEFT JOIN focowiki.publication_projection_inputs projection_input
            ON projection_input.generation_id = claimed.generation_id
           AND projection_input.input_key = claimed.projection_input_key
          ORDER BY claimed.created_at, claimed.projection_kind,
                   claimed.projection_key, claimed.record_identity, claimed.id
        `;
        return rows.map(mapImpact);
      });
}

async function completePublicationImpactBatch(
  sql: DatabaseClient,
  input: Parameters<PublicationImpactRepository["completeBatch"]>[0]
): Promise<number> {
  if (input.completions.length === 0) return 0;
  return sql.begin(async (transaction) => {
    const rows = await transaction<Array<{ completed_count: number | string }>>`
      WITH requested AS MATERIALIZED (
        SELECT item."impactId" AS impact_id,
               item."touchedShardCount" AS touched_shard_count
        FROM jsonb_to_recordset(${transaction.json(input.completions as never)}) AS item(
          "impactId" text,
          "touchedShardCount" integer
        )
      ), completed AS MATERIALIZED (
        UPDATE focowiki.publication_impacts impact
        SET status = 'completed', completed_at = ${input.completedAt},
            claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL,
            last_error_code = NULL, last_error_message = NULL,
            updated_at = ${input.completedAt}
        FROM requested
        WHERE impact.id = requested.impact_id
          AND impact.knowledge_base_id = ${input.knowledgeBaseId}
          AND impact.generation_id = ${input.generationId}
          AND impact.status = 'running'
          AND impact.claimed_by = ${input.workerId}
        RETURNING impact.id, requested.touched_shard_count
      ), totals AS MATERIALIZED (
        SELECT count(*)::bigint AS completed_count,
               coalesce(sum(touched_shard_count), 0)::bigint AS touched_shard_count
        FROM completed
      ), progress AS (
        UPDATE focowiki.publication_progress publication_progress
        SET stage = 'projection',
            processed_impact_count = publication_progress.processed_impact_count
              + totals.completed_count,
            remaining_impact_count = greatest(
              0,
              publication_progress.remaining_impact_count - totals.completed_count
            ),
            touched_shard_count = publication_progress.touched_shard_count
              + totals.touched_shard_count,
            heartbeat_at = ${input.completedAt},
            updated_at = ${input.completedAt}
        FROM totals
        WHERE publication_progress.knowledge_base_id = ${input.knowledgeBaseId}
          AND publication_progress.generation_id = ${input.generationId}
          AND totals.completed_count > 0
      )
      SELECT completed_count FROM totals
    `;
    return Number(rows[0]?.completed_count ?? 0);
  });
}

function mapImpact(row: ImpactRow): ClaimedPublicationImpact {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    generationId: row.generation_id,
    changeFactId: row.change_fact_id,
    changeKind: row.change_kind as ChangeFactKind,
    sourceFileId: row.source_file_id,
    sourceRevisionId: row.source_revision_id,
    previousPath: row.previous_path,
    path: row.path,
    resourceRevision: Number(row.resource_revision),
    projectionKind: row.projection_kind as ProjectionKind,
    projectionKey: row.projection_key,
    recordIdentity: row.record_identity,
    action: row.action as ClaimedPublicationImpact["action"],
    retryCursor: row.retry_cursor_json,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    projectionInput: row.projection_input_json
  };
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}
