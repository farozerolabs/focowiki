import type {
  SourceFileRetryAcceptance,
  SourceFileRetryRepository
} from "../../application/ports/source-file-retry-repository.js";
import type { DatabaseClient } from "../../db/client.js";
import type { TransactionSql } from "postgres";

type RetrySourceRow = {
  id: string;
  active_revision_id: string;
  processing_status: string;
  terminal_failure_retry_kind: string | null;
  terminal_failure_correlation_id: string | null;
  deletion_intent_id: string | null;
  deleted_at: Date | null;
  task_deleted_at: Date | null;
};

type RetryJobRow = {
  id: string;
  status: string;
};

export function createPostgresSourceFileRetryRepository(
  sql: DatabaseClient
): SourceFileRetryRepository {
  return {
    async accept(input) {
      if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts <= 0) {
        throw new Error("maxAttempts must be a positive integer");
      }
      return sql.begin(async (transaction): Promise<SourceFileRetryAcceptance> => {
        const sources = await transaction<RetrySourceRow[]>`
          SELECT id, active_revision_id, processing_status,
                 terminal_failure_retry_kind, terminal_failure_correlation_id,
                 deletion_intent_id, deleted_at, task_deleted_at
          FROM focowiki.source_files
          WHERE id = ${input.sourceFileId}
            AND knowledge_base_id = ${input.knowledgeBaseId}
          FOR UPDATE
        `;
        const source = sources[0];
        if (!source || source.deleted_at || source.task_deleted_at) {
          return { outcome: "not_found" };
        }
        if (source.deletion_intent_id) {
          return { outcome: "resource_conflict" };
        }
        if (
          source.processing_status !== "failed"
          || !["source_processing", "publication"].includes(
            source.terminal_failure_retry_kind ?? ""
          )
        ) {
          return { outcome: "not_allowed" };
        }
        return source.terminal_failure_retry_kind === "publication"
          ? retryPublication(transaction, input, source)
          : retrySourceProcessing(transaction, input, source);
      });
    }
  };
}

async function retrySourceProcessing(
  transaction: TransactionSql,
  input: Parameters<SourceFileRetryRepository["accept"]>[0],
  source: RetrySourceRow
): Promise<SourceFileRetryAcceptance> {
  const jobs = await transaction<RetryJobRow[]>`
    SELECT id, status
    FROM focowiki.role_jobs
    WHERE role = 'source'
      AND source_revision_id = ${source.active_revision_id}
    FOR UPDATE
  `;
  const existing = jobs[0];
  if (existing?.status === "running") {
    return { outcome: "resource_conflict" };
  }
  const roleJobId = existing?.id ?? `role-job-source-${source.active_revision_id}`;
  if (existing?.status === "queued") {
    return {
      outcome: "accepted",
      kind: "source_processing",
      coalesced: true,
      roleJobId
    };
  }
  await transaction`
    UPDATE focowiki.source_files
    SET processing_status = 'queued', processing_stage = 'metadata_resolution',
        processing_started_at = NULL, processing_ended_at = NULL,
        terminal_failure_stage = NULL, terminal_failure_code = NULL,
        terminal_failure_message = NULL, terminal_failure_at = NULL,
        terminal_failure_retry_kind = NULL, terminal_failure_correlation_id = NULL,
        generated_output_status = 'pending', retry_count = retry_count + 1
    WHERE id = ${source.id} AND knowledge_base_id = ${input.knowledgeBaseId}
  `;
  await transaction`
    UPDATE focowiki.source_revisions
    SET processing_status = 'queued'
    WHERE id = ${source.active_revision_id}
      AND source_file_id = ${source.id}
  `;
  if (existing) {
    await transaction`
      UPDATE focowiki.role_jobs
      SET status = 'queued', run_after = ${input.runAfter}, attempt_count = 0,
          max_attempts = ${input.maxAttempts}, locked_by = NULL, locked_at = NULL,
          heartbeat_at = NULL, completed_at = NULL, failed_at = NULL,
          last_error_code = NULL, last_error_message = NULL, updated_at = ${input.runAfter}
      WHERE id = ${roleJobId}
    `;
  } else {
    await transaction`
      INSERT INTO focowiki.role_jobs (
        id, role, kind, knowledge_base_id, source_file_id, source_revision_id,
        payload_json, settings_snapshot_json, status, run_after, max_attempts,
        created_at, updated_at
      ) VALUES (
        ${roleJobId}, 'source', 'source_processing', ${input.knowledgeBaseId},
        ${source.id}, ${source.active_revision_id},
        jsonb_build_object('reason', 'manual_retry'), '{}'::jsonb,
        'queued', ${input.runAfter}, ${input.maxAttempts}, ${input.runAfter}, ${input.runAfter}
      )
    `;
  }
  await transaction`
    UPDATE focowiki.source_dispatch_markers
    SET status = 'dispatched', dispatched_at = ${input.runAfter},
        last_error_code = NULL, updated_at = ${input.runAfter}
    WHERE source_revision_id = ${source.active_revision_id}
  `;
  return {
    outcome: "accepted",
    kind: "source_processing",
    coalesced: false,
    roleJobId
  };
}

async function retryPublication(
  transaction: TransactionSql,
  input: Parameters<SourceFileRetryRepository["accept"]>[0],
  source: RetrySourceRow
): Promise<SourceFileRetryAcceptance> {
  const generationId = source.terminal_failure_correlation_id;
  if (!generationId) return { outcome: "not_allowed" };
  const jobs = await transaction<RetryJobRow[]>`
    SELECT job.id, job.status
    FROM focowiki.publication_generations generation
    JOIN focowiki.role_jobs job
      ON job.generation_id = generation.id AND job.role = 'publication'
    WHERE generation.id = ${generationId}
      AND generation.knowledge_base_id = ${input.knowledgeBaseId}
      AND generation.state = 'failed'
      AND EXISTS (
        SELECT 1
        FROM focowiki.publication_change_facts fact
        WHERE fact.generation_id = generation.id
          AND fact.source_file_id = ${source.id}
      )
    FOR UPDATE OF generation, job
  `;
  const job = jobs[0];
  if (!job) return { outcome: "not_allowed" };
  if (job.status === "running") return { outcome: "resource_conflict" };
  if (job.status === "queued") {
    return {
      outcome: "accepted",
      kind: "publication",
      coalesced: true,
      roleJobId: job.id
    };
  }
  await transaction`
    UPDATE focowiki.publication_impacts
    SET status = 'pending', run_after = ${input.runAfter}, attempt_count = 0,
        claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL,
        completed_at = NULL, last_error_code = NULL, last_error_message = NULL,
        updated_at = ${input.runAfter}
    WHERE generation_id = ${generationId}
      AND status IN ('failed', 'cancelled')
  `;
  await transaction`
    UPDATE focowiki.publication_progress
    SET stage = 'pending', completed_at = NULL, safe_error_code = NULL,
        safe_error_message = NULL, heartbeat_at = ${input.runAfter},
        processed_impact_count = (
          SELECT count(*) FROM focowiki.publication_impacts impact
          WHERE impact.generation_id = ${generationId} AND impact.status = 'completed'
        ),
        updated_at = ${input.runAfter}
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND generation_id = ${generationId}
  `;
  await transaction`
    UPDATE focowiki.role_jobs
    SET status = 'queued', run_after = ${input.runAfter}, attempt_count = 0,
        max_attempts = ${input.maxAttempts}, locked_by = NULL, locked_at = NULL,
        heartbeat_at = NULL, completed_at = NULL, failed_at = NULL,
        last_error_code = NULL, last_error_message = NULL, updated_at = ${input.runAfter}
    WHERE id = ${job.id}
  `;
  await transaction`
    UPDATE focowiki.source_files source
    SET processing_status = 'completed', processing_stage = 'projection_generation',
        processing_ended_at = ${input.runAfter},
        terminal_failure_stage = NULL, terminal_failure_code = NULL,
        terminal_failure_message = NULL, terminal_failure_at = NULL,
        terminal_failure_retry_kind = NULL, terminal_failure_correlation_id = NULL,
        generated_output_status = 'pending', retry_count = retry_count + 1
    FROM focowiki.publication_change_facts fact
    WHERE fact.generation_id = ${generationId}
      AND fact.source_file_id = source.id
      AND source.knowledge_base_id = ${input.knowledgeBaseId}
      AND source.deleted_at IS NULL AND source.deletion_intent_id IS NULL
  `;
  return {
    outcome: "accepted",
    kind: "publication",
    coalesced: false,
    roleJobId: job.id
  };
}
