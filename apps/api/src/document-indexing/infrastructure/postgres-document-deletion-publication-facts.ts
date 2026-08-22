import type { TransactionSql } from "postgres";

export async function writePostgresDocumentDeletionPublicationFacts(input: {
  transaction: TransactionSql;
  knowledgeBaseId: string;
  operationPublicId: string;
  createdAt: string;
}): Promise<number> {
  const sql = input.transaction;
  await sql`
    INSERT INTO focowiki.knowledge_base_projection_heads (knowledge_base_id)
    VALUES (${input.knowledgeBaseId})
    ON CONFLICT (knowledge_base_id) DO NOTHING
  `;
  await sql`
    SELECT knowledge_base_id
    FROM focowiki.knowledge_base_projection_heads
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
    FOR UPDATE
  `;
  const inserted = await sql<Array<{ fact_epoch: number | string }>>`
    WITH base AS (
      SELECT coalesce(max(fact_epoch), 0) AS maximum_fact_epoch
      FROM focowiki.projection_fact_epochs
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
    ), desired AS (
      SELECT source.public_id AS source_file_public_id,
             active.active_source_revision_public_id
               AS source_revision_public_id,
             row_number() OVER (
               ORDER BY source.public_id COLLATE "C"
             ) AS fact_offset
      FROM document_deletion_sources deletion
      JOIN focowiki.source_files source
        ON source.knowledge_base_id = ${input.knowledgeBaseId}
       AND source.public_id = deletion.public_id
      JOIN focowiki.source_file_active_revisions active
        ON active.knowledge_base_id = source.knowledge_base_id
       AND active.source_file_public_id = source.public_id
      WHERE active.active_source_revision_public_id IS NOT NULL
    )
    INSERT INTO focowiki.projection_fact_epochs (
      knowledge_base_id, fact_epoch, mutation_public_id,
      mutation_group_public_id, source_file_public_id,
      source_revision_public_id, fact_kind, state, created_at
    )
    SELECT ${input.knowledgeBaseId},
           base.maximum_fact_epoch + desired.fact_offset,
           'projection-delete-fact-' || md5(
             ${input.operationPublicId} || chr(31)
               || desired.source_file_public_id
           ),
           ${input.operationPublicId}, desired.source_file_public_id,
           desired.source_revision_public_id, 'delete', 'ready',
           ${input.createdAt}
    FROM desired CROSS JOIN base
    ON CONFLICT (knowledge_base_id, mutation_public_id) DO NOTHING
    RETURNING fact_epoch
  `;
  return inserted.length;
}

export async function isPostgresDocumentDeletionPublicationActive(input: {
  transaction: TransactionSql;
  knowledgeBaseId: string;
  operationPublicId: string;
}): Promise<boolean> {
  const rows = await input.transaction<Array<{
    fact_count: number | string;
    maximum_fact_epoch: number | string | null;
    active_fact_epoch: number | string;
  }>>`
    SELECT count(epoch.fact_epoch) AS fact_count,
           max(epoch.fact_epoch) AS maximum_fact_epoch,
           head.active_fact_epoch
    FROM focowiki.knowledge_base_projection_heads head
    LEFT JOIN focowiki.projection_fact_epochs epoch
      ON epoch.knowledge_base_id = head.knowledge_base_id
     AND epoch.mutation_group_public_id = ${input.operationPublicId}
     AND epoch.fact_kind = 'delete'
    WHERE head.knowledge_base_id = ${input.knowledgeBaseId}
    GROUP BY head.active_fact_epoch
  `;
  const row = rows[0];
  return Boolean(row && Number(row.fact_count) > 0
    && Number(row.active_fact_epoch) >= Number(row.maximum_fact_epoch));
}
