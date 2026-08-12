import type { DatabaseClient } from "../../db/client.js";

export function createPostgresSemanticPublicationCoalescingReadiness(
  sql: DatabaseClient
) {
  return {
    async inspect(input: { knowledgeBaseId: string }): Promise<
      | { state: "ready" }
      | { state: "pending" }
    > {
      if (!input.knowledgeBaseId || Buffer.byteLength(input.knowledgeBaseId) > 255) {
        throw new Error("Semantic publication readiness scope is invalid");
      }
      const rows = await sql<Array<{ pending: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM focowiki.semantic_stage_work_items stage
          JOIN focowiki.source_file_current_revisions current_revision
            ON current_revision.knowledge_base_id = stage.knowledge_base_id
           AND current_revision.source_file_public_id = stage.source_file_public_id
           AND current_revision.source_revision_public_id
             = stage.source_revision_public_id
          JOIN focowiki.semantic_generations generation
            ON generation.knowledge_base_id = stage.knowledge_base_id
           AND generation.public_id = stage.semantic_generation_public_id
           AND (
             generation.generation_role = 'candidate'
               AND generation.state IN ('building', 'validating')
             OR generation.generation_role = 'active'
               AND generation.state = 'active'
           )
           AND generation.deleted_at IS NULL
          WHERE stage.knowledge_base_id = ${input.knowledgeBaseId}
            AND stage.stage_kind IN (
              'extraction', 'reconciliation', 'community',
              'embedding', 'vector', 'publication'
            )
            AND stage.state IN ('queued', 'running', 'retry')
        ) AS pending
      `;
      return rows[0]?.pending === true
        ? { state: "pending" }
        : { state: "ready" };
    }
  };
}
