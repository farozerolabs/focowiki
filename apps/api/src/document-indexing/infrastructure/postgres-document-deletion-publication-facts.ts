import type { TransactionSql } from "postgres";

export async function writePostgresDocumentDeletionPublicationFacts(input: {
  transaction: TransactionSql;
  knowledgeBaseId: string;
  operationPublicId: string;
  createdAt: string;
}): Promise<number> {
  const sql = input.transaction;
  await sql`
    INSERT INTO focowiki.knowledge_base_publication_heads (
      knowledge_base_id, updated_at
    ) VALUES (${input.knowledgeBaseId}, ${input.createdAt})
    ON CONFLICT (knowledge_base_id) DO NOTHING
  `;
  await sql`
    SELECT knowledge_base_id
    FROM focowiki.knowledge_base_publication_heads
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
    FOR UPDATE
  `;
  const inserted = await sql<Array<{
    public_id: string;
    readiness_sequence: number | string;
  }>>`
    WITH base AS (
      SELECT greatest(head.active_readiness_sequence,
                      head.latest_readiness_sequence)
               AS maximum_readiness_sequence
      FROM focowiki.knowledge_base_publication_heads head
      WHERE head.knowledge_base_id = ${input.knowledgeBaseId}
    ), desired AS (
      SELECT source.public_id AS source_file_public_id,
             active.active_source_revision_public_id
               AS source_revision_public_id,
             record.logical_path AS prior_logical_path,
             row_number() OVER (
               ORDER BY source.public_id COLLATE "C"
             ) AS readiness_offset
      FROM document_deletion_sources deletion
      JOIN focowiki.source_files source
        ON source.knowledge_base_id = ${input.knowledgeBaseId}
       AND source.public_id = deletion.public_id
      JOIN focowiki.source_file_active_revisions active
        ON active.knowledge_base_id = source.knowledge_base_id
       AND active.source_file_public_id = source.public_id
      JOIN focowiki.document_projection_records record
        ON record.knowledge_base_id = source.knowledge_base_id
       AND record.source_revision_public_id
             = active.active_source_revision_public_id
      WHERE active.active_source_revision_public_id IS NOT NULL
    )
    INSERT INTO focowiki.publication_items (
      public_id, mutation_public_id, knowledge_base_id,
      document_job_public_id, source_file_public_id,
      source_revision_public_id, operation, prior_logical_path,
      next_logical_path, affected_evidence, readiness_sequence,
      created_at, updated_at
    )
    SELECT 'publication-delete-item-' || md5(
             ${input.operationPublicId} || chr(31)
               || desired.source_file_public_id
           ),
           'publication-delete-mutation-' || md5(
             ${input.operationPublicId} || chr(31)
               || desired.source_file_public_id
           ),
           ${input.knowledgeBaseId}, NULL, desired.source_file_public_id,
           desired.source_revision_public_id, 'delete',
           desired.prior_logical_path, NULL,
           jsonb_build_object(
             'deletionOperationPublicId', ${input.operationPublicId}::text
           ),
           base.maximum_readiness_sequence + desired.readiness_offset,
           ${input.createdAt}, ${input.createdAt}
    FROM desired CROSS JOIN base
    ON CONFLICT (knowledge_base_id, mutation_public_id) DO NOTHING
    RETURNING public_id, readiness_sequence
  `;
  if (inserted.length > 0) {
    const latestReadinessSequence = Math.max(...inserted.map((item) =>
      Number(item.readiness_sequence)));
    await sql`
      UPDATE focowiki.knowledge_base_publication_heads
      SET latest_readiness_sequence = greatest(
            latest_readiness_sequence, ${latestReadinessSequence}
          ),
          pending_item_count = pending_item_count + ${inserted.length},
          oldest_pending_at = least(
            coalesce(oldest_pending_at, ${input.createdAt}),
            ${input.createdAt}
          ),
          latest_pending_at = greatest(
            coalesce(latest_pending_at, ${input.createdAt}),
            ${input.createdAt}
          ),
          updated_at = ${input.createdAt}
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
    `;
  }
  return inserted.length;
}

export async function isPostgresDocumentDeletionPublicationActive(input: {
  transaction: TransactionSql;
  knowledgeBaseId: string;
  operationPublicId: string;
}): Promise<boolean> {
  const rows = await input.transaction<Array<{
    item_count: number | string;
    committed_count: number | string;
  }>>`
    SELECT count(*) AS item_count,
           count(*) FILTER (WHERE outcome = 'committed') AS committed_count
    FROM focowiki.publication_items
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND affected_evidence->>'deletionOperationPublicId'
            = ${input.operationPublicId}
  `;
  const row = rows[0];
  return Boolean(row && Number(row.item_count) > 0
    && Number(row.item_count) === Number(row.committed_count));
}
