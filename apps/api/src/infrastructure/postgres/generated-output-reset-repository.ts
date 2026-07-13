import type {
  GeneratedOutputResetRepository,
  GeneratedOutputResetState
} from "../../application/ports/generated-output-reset-repository.js";
import type { DatabaseClient } from "../../db/client.js";

type ResetRow = {
  state: GeneratedOutputResetState;
};

export function createPostgresGeneratedOutputResetRepository(
  sql: DatabaseClient
): GeneratedOutputResetRepository {
  return {
    async beginReset(input) {
      const rows = await sql<ResetRow[]>`
        UPDATE focowiki.generated_output_resets
        SET state = 'running',
            attempt_count = attempt_count + 1,
            started_at = COALESCE(started_at, ${input.startedAt}),
            error_code = NULL,
            error_message = NULL,
            updated_at = ${input.startedAt}
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND state <> 'completed'
        RETURNING state
      `;
      if (rows[0]) {
        return rows[0].state;
      }

      const existing = await sql<ResetRow[]>`
        SELECT state
        FROM focowiki.generated_output_resets
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
        LIMIT 1
      `;
      return existing[0]?.state ?? null;
    },

    async listPendingPrefixes(input) {
      const rows = await sql<Array<{ prefix: string }>>`
        SELECT prefix
        FROM focowiki.generated_output_reset_prefixes
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND deleted_at IS NULL
        ORDER BY prefix ASC
        LIMIT ${input.limit}
      `;
      return rows.map((row) => row.prefix);
    },

    async markPrefixDeleted(input) {
      await sql`
        UPDATE focowiki.generated_output_reset_prefixes
        SET deleted_at = COALESCE(deleted_at, ${input.deletedAt})
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND prefix = ${input.prefix}
      `;
    },

    async completeResetAndEnqueueRebuild(input) {
      await sql.begin(async (transaction) => {
        const pending = await transaction<Array<{ count: number }>>`
          SELECT count(*)::integer AS count
          FROM focowiki.generated_output_reset_prefixes
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND deleted_at IS NULL
        `;
        if ((pending[0]?.count ?? 0) > 0) {
          throw new Error("Generated output reset still has pending storage prefixes.");
        }

        const reset = await transaction<ResetRow[]>`
          UPDATE focowiki.generated_output_resets
          SET state = 'completed',
              completed_at = COALESCE(completed_at, ${input.completedAt}),
              error_code = NULL,
              error_message = NULL,
              updated_at = ${input.completedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND state <> 'completed'
          RETURNING state
        `;
        if (!reset[0]) {
          return;
        }

        await transaction`
          INSERT INTO focowiki.worker_jobs (
            id,
            kind,
            knowledge_base_id,
            source_file_id,
            payload_json,
            run_after,
            max_attempts
          )
          SELECT
            'worker-job-okf-rebuild-' || md5(${input.knowledgeBaseId}),
            'publication',
            ${input.knowledgeBaseId},
            NULL,
            jsonb_build_object('reason', 'bootstrap'),
            ${input.completedAt},
            ${input.publicationJobMaxAttempts}
          WHERE EXISTS (
            SELECT 1
            FROM focowiki.knowledge_bases
            WHERE id = ${input.knowledgeBaseId}
              AND deleted_at IS NULL
          )
          ON CONFLICT (id) DO NOTHING
        `;
      });
    },

    async failReset(input) {
      await sql`
        UPDATE focowiki.generated_output_resets
        SET state = 'failed',
            error_code = ${input.errorCode},
            error_message = ${input.errorMessage},
            updated_at = ${input.failedAt}
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND state <> 'completed'
      `;
    },

    async isResetPending(input) {
      const rows = await sql<Array<{ pending: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM focowiki.generated_output_resets
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND state <> 'completed'
        ) AS pending
      `;
      return rows[0]?.pending ?? false;
    }
  };
}
