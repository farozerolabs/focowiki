import type { TransactionSql } from "postgres";

export async function transferSharedGeneratedPageCandidates(input: {
  sql: TransactionSql;
  knowledgeBaseId: string;
  sourceFilePublicIds: readonly string[];
  ownerOperationPublicId: string;
}): Promise<void> {
  if (input.sourceFilePublicIds.length === 0) return;
  await input.sql`
    UPDATE focowiki.generated_page_candidates candidate
    SET source_work_public_id = NULL,
        source_revision_public_id = NULL,
        source_file_public_id = NULL,
        page_source_file_public_id = CASE
          WHEN candidate.page_source_file_public_id
            = ANY(${input.sourceFilePublicIds}::text[])
            THEN NULL
          ELSE candidate.page_source_file_public_id
        END,
        page_source_revision_public_id = CASE
          WHEN candidate.page_source_file_public_id
            = ANY(${input.sourceFilePublicIds}::text[])
            THEN NULL
          ELSE candidate.page_source_revision_public_id
        END,
        owner_operation_public_id = ${input.ownerOperationPublicId}
    WHERE candidate.knowledge_base_id = ${input.knowledgeBaseId}
      AND (
        candidate.source_file_public_id = ANY(${input.sourceFilePublicIds}::text[])
        OR candidate.page_source_file_public_id
          = ANY(${input.sourceFilePublicIds}::text[])
      )
      AND EXISTS (
        SELECT 1 FROM focowiki.generated_page_heads head
        WHERE head.knowledge_base_id = candidate.knowledge_base_id
          AND head.page_candidate_public_id = candidate.public_id
      )
  `;
}
