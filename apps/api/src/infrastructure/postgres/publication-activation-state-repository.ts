import type { PublicationActivationStateRepository } from "../../application/ports/publication-activation-state-repository.js";
import type { DatabaseClient } from "../../db/client.js";

export function createPostgresPublicationActivationStateRepository(
  sql: DatabaseClient
): PublicationActivationStateRepository {
  return {
    async getActivationContext(input) {
      const rows = await sql<Array<{
        state: "building" | "validating" | "active" | "failed" | "superseded";
        predecessor_generation_id: string | null;
      }>>`
        SELECT state, predecessor_generation_id
        FROM focowiki.publication_generations
        WHERE id = ${input.generationId}
          AND knowledge_base_id = ${input.knowledgeBaseId}
          AND state IN ('building', 'validating', 'active', 'failed', 'superseded')
        LIMIT 1
      `;
      return rows[0] ? {
        state: rows[0].state,
        predecessorGenerationId: rows[0].predecessor_generation_id
      } : null;
    }
  };
}
