import type {
  CurrentSourceRevisionContext,
  SourceRevisionContextRepository
} from "../../application/ports/source-revision-context-repository.js";
import type { DatabaseClient } from "../../db/client.js";

export function createPostgresSourceRevisionContextRepository(
  sql: DatabaseClient
): SourceRevisionContextRepository {
  return {
    async findCurrent(input) {
      const rows = await sql<Array<{
        knowledge_base_id: string;
        source_file_id: string;
        source_revision_id: string;
        revision: number;
        previous_relative_path: string | null;
        relative_path: string;
        resource_revision: number;
        operation_id: string | null;
      }>>`
        SELECT source.knowledge_base_id, source.id AS source_file_id,
               revision.id AS source_revision_id, revision.revision,
               CASE WHEN source.candidate_revision_id = revision.id
                 THEN source.relative_path ELSE NULL END AS previous_relative_path,
               CASE WHEN source.candidate_revision_id = revision.id
                 THEN source.candidate_relative_path ELSE source.relative_path END AS relative_path,
               source.resource_revision + CASE
                 WHEN source.candidate_revision_id = revision.id THEN 1 ELSE 0 END AS resource_revision,
               CASE WHEN source.candidate_revision_id = revision.id
                 THEN source.candidate_operation_id ELSE NULL END AS operation_id
        FROM focowiki.source_files source
        JOIN focowiki.knowledge_bases knowledge_base
          ON knowledge_base.id = source.knowledge_base_id
         AND knowledge_base.deleted_at IS NULL
        JOIN focowiki.source_revisions revision
          ON revision.id = CASE
            WHEN source.candidate_revision_id = ${input.sourceRevisionId}
              THEN source.candidate_revision_id
            ELSE source.active_revision_id
          END
         AND revision.source_file_id = source.id
        WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
          AND source.id = ${input.sourceFileId}
          AND revision.id = ${input.sourceRevisionId}
          AND source.deleted_at IS NULL
          AND source.task_deleted_at IS NULL
          AND source.deletion_intent_id IS NULL
        LIMIT 1
      `;
      const row = rows[0];
      return row ? mapRow(row) : null;
    }
  };
}

function mapRow(row: {
  knowledge_base_id: string;
  source_file_id: string;
  source_revision_id: string;
  revision: number;
  previous_relative_path: string | null;
  relative_path: string;
  resource_revision: number;
  operation_id: string | null;
}): CurrentSourceRevisionContext {
  return {
    knowledgeBaseId: row.knowledge_base_id,
    sourceFileId: row.source_file_id,
    sourceRevisionId: row.source_revision_id,
    revision: row.revision,
    previousRelativePath: row.previous_relative_path,
    relativePath: row.relative_path,
    resourceRevision: row.resource_revision,
    operationId: row.operation_id
  };
}
