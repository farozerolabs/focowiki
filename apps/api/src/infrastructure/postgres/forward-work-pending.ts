import type { TransactionSql } from "postgres";

export async function hasPendingForwardWork(
  transaction: TransactionSql<Record<string, never>>,
  knowledgeBaseId: string
): Promise<boolean> {
  const rows = await transaction<Array<{ pending: boolean }>>`
    SELECT (
      EXISTS (
        SELECT 1
        FROM focowiki.resource_operations operation
        WHERE operation.knowledge_base_id = ${knowledgeBaseId}
          AND operation.state IN (
            'accepted', 'validating', 'processing', 'publishing'
          )
      )
      OR EXISTS (
        SELECT 1
        FROM focowiki.source_files source
        WHERE source.knowledge_base_id = ${knowledgeBaseId}
          AND source.processing_status IN ('queued', 'running')
      )
      OR EXISTS (
        SELECT 1
        FROM focowiki.source_dispatch_markers marker
        WHERE marker.knowledge_base_id = ${knowledgeBaseId}
          AND marker.status IN ('pending', 'claimed')
      )
      OR EXISTS (
        SELECT 1
        FROM focowiki.publication_change_facts fact
        WHERE fact.knowledge_base_id = ${knowledgeBaseId}
          AND fact.assembly_state IN ('pending', 'claimed')
      )
      OR EXISTS (
        SELECT 1
        FROM focowiki.publication_generations generation
        WHERE generation.knowledge_base_id = ${knowledgeBaseId}
          AND generation.generation_kind = 'normal'
          AND generation.state IN ('frozen', 'building', 'validating')
      )
      OR EXISTS (
        SELECT 1
        FROM focowiki.deletion_intents intent
        WHERE intent.knowledge_base_id = ${knowledgeBaseId}
          AND intent.state IN ('accepted', 'running')
      )
      OR EXISTS (
        SELECT 1
        FROM focowiki.upload_sessions upload
        WHERE upload.knowledge_base_id = ${knowledgeBaseId}
          AND upload.state = 'finalizing'
      )
      OR EXISTS (
        SELECT 1
        FROM focowiki.role_jobs job
        WHERE job.knowledge_base_id = ${knowledgeBaseId}
          AND job.role IN ('source', 'publication')
          AND job.status IN ('queued', 'running')
      )
    ) AS pending
  `;
  return rows[0]?.pending ?? false;
}
