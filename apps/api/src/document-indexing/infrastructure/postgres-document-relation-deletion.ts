import type { TransactionSql } from "postgres";

export async function obsoleteOrphanRelations(
  sql: TransactionSql,
  knowledgeBaseId: string,
  now: string
): Promise<void> {
  await sql`
    UPDATE focowiki.canonical_file_relations relation
    SET active = false, retired_at = ${now}
    WHERE relation.knowledge_base_id = ${knowledgeBaseId}
      AND relation.active AND relation.retired_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.relation_directed_evidence evidence
        WHERE evidence.knowledge_base_id = relation.knowledge_base_id
          AND evidence.pair_public_id = relation.pair_public_id
          AND evidence.active AND evidence.retired_at IS NULL
      )
  `;
}
