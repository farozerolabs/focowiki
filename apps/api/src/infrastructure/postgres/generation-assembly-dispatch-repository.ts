import type { GenerationAssemblyDispatchRepository } from "../../application/ports/generation-assembly-dispatch-repository.js";
import type { DatabaseClient } from "../../db/client.js";

export function createPostgresGenerationAssemblyDispatchRepository(
  sql: DatabaseClient
): GenerationAssemblyDispatchRepository {
  return {
    async dispatchPending(input) {
      if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
        throw new Error("Generation assembly dispatch limit must be a positive integer");
      }
      try {
        const rows = await sql<Array<{ dispatched_count: number }>>`
          WITH candidates AS MATERIALIZED (
            SELECT fact.knowledge_base_id, min(fact.created_at) AS first_created_at
            FROM focowiki.publication_change_facts fact
            JOIN focowiki.knowledge_bases knowledge_base
              ON knowledge_base.id = fact.knowledge_base_id
            WHERE fact.generation_id IS NULL
              AND fact.assembly_state = 'pending'
            GROUP BY fact.knowledge_base_id
            ORDER BY min(fact.created_at), fact.knowledge_base_id
            LIMIT ${input.limit}
          ), dispatch_inputs AS MATERIALIZED (
            SELECT candidate.knowledge_base_id, candidate.first_created_at,
                   latest.settings_snapshot_json,
                   latest.publication_max_attempts
            FROM candidates candidate
            CROSS JOIN LATERAL (
              SELECT fact.settings_snapshot_json, fact.publication_max_attempts
              FROM focowiki.publication_change_facts fact
              WHERE fact.knowledge_base_id = candidate.knowledge_base_id
                AND fact.generation_id IS NULL
                AND fact.assembly_state = 'pending'
              ORDER BY fact.created_at DESC, fact.id DESC
              LIMIT 1
            ) latest
          ), dispatched AS (
            INSERT INTO focowiki.role_jobs (
              id, role, kind, knowledge_base_id, source_file_id, source_revision_id,
              generation_id, payload_json, settings_snapshot_json, status,
              run_after, max_attempts, created_at, updated_at
            )
            SELECT 'role-job-generation-assembly-' || input.knowledge_base_id,
                   'publication', 'generation_assembly', input.knowledge_base_id,
                   NULL, NULL, NULL,
                   jsonb_build_object('knowledgeBaseId', input.knowledge_base_id),
                   input.settings_snapshot_json, 'queued',
                   least(input.first_created_at, ${input.now}::timestamptz),
                   input.publication_max_attempts,
                   least(input.first_created_at, ${input.now}::timestamptz),
                   ${input.now}::timestamptz
            FROM dispatch_inputs input
            ON CONFLICT (id) DO UPDATE
            SET status = 'queued',
                run_after = least(focowiki.role_jobs.run_after, EXCLUDED.run_after),
                settings_snapshot_json = EXCLUDED.settings_snapshot_json,
                max_attempts = greatest(
                  focowiki.role_jobs.max_attempts,
                  EXCLUDED.max_attempts
                ),
                attempt_count = 0,
                locked_by = NULL,
                locked_at = NULL,
                heartbeat_at = NULL,
                completed_at = NULL,
                failed_at = NULL,
                last_error_code = NULL,
                last_error_message = NULL,
                updated_at = EXCLUDED.updated_at
            WHERE focowiki.role_jobs.status NOT IN ('queued', 'running')
            RETURNING id
          )
          SELECT count(*)::int AS dispatched_count FROM dispatched
        `;
        return rows[0]?.dispatched_count ?? 0;
      } catch (error) {
        if (isDeletedKnowledgeBaseDispatchRace(error)) {
          return 0;
        }
        throw error;
      }
    }
  };
}

export function isDeletedKnowledgeBaseDispatchRace(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const candidate = error as { code?: unknown; constraint_name?: unknown };
  return (
    candidate.code === "23503" &&
    candidate.constraint_name === "role_jobs_knowledge_base_id_fkey"
  );
}
