import type { DatabaseClient } from "../../db/client.js";

type ActiveFileRelationshipHit = {
  documentId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  targetSourceFilePublicId: string;
  targetSourceRevisionPublicId: string;
};

export function createPostgresActiveFileRelationshipHitRepository(
  sql: DatabaseClient
) {
  return {
    async resolveActive(input: {
      knowledgeBaseId: string;
      documents: readonly ActiveFileRelationshipHit[];
      limit: number;
    }): Promise<readonly string[]> {
      assertInput(input);
      if (input.documents.length === 0) return [];
      const rows = await sql<Array<{ provider_document_id: string }>>`
        WITH requested AS (
          SELECT item."documentId", item."sourceFilePublicId",
                 item."sourceRevisionPublicId", item."targetSourceFilePublicId",
                 item."targetSourceRevisionPublicId"
          FROM jsonb_to_recordset(${sql.json(input.documents as never)}) AS item(
            "documentId" text, "sourceFilePublicId" text,
            "sourceRevisionPublicId" text, "targetSourceFilePublicId" text,
            "targetSourceRevisionPublicId" text
          )
        )
        SELECT owner.provider_document_id
        FROM requested
        JOIN focowiki.search_document_owners owner
          ON owner.knowledge_base_id = ${input.knowledgeBaseId}
         AND owner.provider_document_id = requested."documentId"
         AND owner.document_kind = 'file_relationship'
         AND owner.source_file_public_id = requested."sourceFilePublicId"
         AND owner.source_revision_public_id = requested."sourceRevisionPublicId"
         AND owner.state = 'active'
        JOIN focowiki.source_files source
         ON source.knowledge_base_id = owner.knowledge_base_id
         AND source.public_id = owner.source_file_public_id
         AND source.deleted_at IS NULL
        JOIN focowiki.source_file_active_revisions source_revision
          ON source_revision.knowledge_base_id = source.knowledge_base_id
         AND source_revision.source_file_public_id = source.public_id
         AND source_revision.active_source_revision_public_id
           = owner.source_revision_public_id
        JOIN focowiki.source_files target
         ON target.knowledge_base_id = owner.knowledge_base_id
         AND target.public_id = requested."targetSourceFilePublicId"
         AND target.deleted_at IS NULL
        JOIN focowiki.source_file_active_revisions target_revision
          ON target_revision.knowledge_base_id = target.knowledge_base_id
         AND target_revision.source_file_public_id = target.public_id
         AND target_revision.active_source_revision_public_id
           = requested."targetSourceRevisionPublicId"
        ORDER BY owner.provider_document_id COLLATE "C"
        LIMIT ${input.limit + 1}
      `;
      if (rows.length > input.limit) throw repositoryError("active_hit_limit");
      return rows.map((row) => row.provider_document_id);
    }
  };
}

function assertInput(input: {
  knowledgeBaseId: string;
  documents: readonly ActiveFileRelationshipHit[];
  limit: number;
}): void {
  if (!input.knowledgeBaseId
    || !Number.isSafeInteger(input.limit) || input.limit < 0 || input.limit > 4_000
    || input.documents.length > input.limit
    || new Set(input.documents.map((item) => item.documentId)).size
      !== input.documents.length
    || input.documents.some((item) => !item.documentId
      || !item.sourceFilePublicId || !item.sourceRevisionPublicId
      || !item.targetSourceFilePublicId || !item.targetSourceRevisionPublicId)) {
    throw repositoryError("invalid_active_hit_input");
  }
}

function repositoryError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Active file relationship hit repository error: ${code}`),
    { code }
  );
}
