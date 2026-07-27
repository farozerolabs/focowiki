import type { TransactionSql } from "postgres";

export async function advanceProjectionVersionOwnership(
  transaction: TransactionSql,
  input: {
    knowledgeBaseId: string;
    activeGenerationId: string;
    updatedAt: string;
  }
): Promise<void> {
  await transaction`
    UPDATE focowiki.knowledge_base_projection_versions
    SET active_generation_id = ${input.activeGenerationId},
        updated_at = ${input.updatedAt}
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND active_generation_id <> ${input.activeGenerationId}
  `;
}
