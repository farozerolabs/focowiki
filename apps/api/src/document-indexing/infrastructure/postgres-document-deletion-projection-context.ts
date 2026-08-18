import type { DatabaseClient } from "../../db/client.js";
import type { DocumentResourceDeletionAction } from
  "../application/document-resource-deletion-worker.js";
import type { CanonicalFileRelation, FileRelationEvidenceKind } from
  "../domain/file-relation.js";

export type DeletedProjectionSource = {
  sourceFilePublicId: string;
  logicalPath: string;
};

export function createPostgresDocumentDeletionProjectionContext(
  sql: DatabaseClient
) {
  return {
    async countActiveSources(knowledgeBaseId: string): Promise<number> {
      const rows = await sql<Array<{ count: number | string }>>`
        SELECT count(*) AS count
        FROM focowiki.source_files source
        JOIN focowiki.source_file_active_revisions active
          ON active.knowledge_base_id = source.knowledge_base_id
         AND active.source_file_public_id = source.public_id
         AND active.active_source_revision_public_id IS NOT NULL
        WHERE source.knowledge_base_id = ${knowledgeBaseId}
          AND source.deleted_at IS NULL
      `;
      return Number(rows[0]?.count ?? 0);
    },

    async countActiveRelations(knowledgeBaseId: string): Promise<number> {
      const rows = await sql<Array<{ count: number | string }>>`
        SELECT count(*) AS count
        FROM focowiki.canonical_file_relations
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND active AND retired_at IS NULL
      `;
      return Number(rows[0]?.count ?? 0);
    },

    async read(input: {
      action: DocumentResourceDeletionAction;
      maximumSources: number;
      maximumRelations: number;
    }): Promise<{
      deletedSources: readonly DeletedProjectionSource[];
      deletedDirectoryPaths: readonly string[];
      affectedSurvivorSourceFilePublicIds: readonly string[];
      obsoleteRelationPublicIds: readonly string[];
    }> {
      assertLimit(input.maximumSources);
      assertLimit(input.maximumRelations);
      const deleted = await readDeletedSources(sql, input.action,
        input.maximumSources);
      const deletedIds = deleted.map((source) => source.source_file_public_id);
      const deletedDirectoryPaths = await readDeletedDirectoryPaths(
        sql, input.action, input.maximumSources
      );
      if (deletedIds.length === 0) return {
        deletedSources: [],
        deletedDirectoryPaths,
        affectedSurvivorSourceFilePublicIds: [],
        obsoleteRelationPublicIds: []
      };
      const relations = await sql<Array<{
        public_id: string;
        first_source_file_public_id: string;
        second_source_file_public_id: string;
      }>>`
        SELECT relation.public_id, relation.first_source_file_public_id,
               relation.second_source_file_public_id
        FROM focowiki.canonical_file_relations relation
        JOIN focowiki.operations deletion_operation
          ON deletion_operation.knowledge_base_id = relation.knowledge_base_id
         AND deletion_operation.public_id = ${input.action.operationPublicId}
        WHERE relation.knowledge_base_id = ${input.action.knowledgeBaseId}
          AND (
            (relation.active AND relation.retired_at IS NULL)
            OR (NOT relation.active
              AND relation.retired_at = deletion_operation.created_at)
          )
          AND (relation.first_source_file_public_id
              = ANY(${deletedIds}::text[])
            OR relation.second_source_file_public_id
              = ANY(${deletedIds}::text[]))
        ORDER BY relation.public_id COLLATE "C"
        LIMIT ${input.maximumRelations + 1}
      `;
      if (relations.length > input.maximumRelations) {
        throw deletionProjectionContextError("relation_limit_exceeded");
      }
      const candidates = [...new Set(relations.flatMap((relation) => [
        relation.first_source_file_public_id,
        relation.second_source_file_public_id
      ]).filter((sourceFilePublicId) => !deletedIds.includes(sourceFilePublicId)))];
      const survivors = candidates.length === 0 ? [] : await sql<Array<{
        public_id: string;
      }>>`
        SELECT source.public_id
        FROM focowiki.source_files source
        JOIN focowiki.source_file_active_revisions active
          ON active.knowledge_base_id = source.knowledge_base_id
         AND active.source_file_public_id = source.public_id
         AND active.active_source_revision_public_id IS NOT NULL
        WHERE source.knowledge_base_id = ${input.action.knowledgeBaseId}
          AND source.public_id IN ${sql(candidates)}
          AND source.deleted_at IS NULL
        ORDER BY source.public_id COLLATE "C"
        LIMIT ${input.maximumSources + 1}
      `;
      if (survivors.length > input.maximumSources) {
        throw deletionProjectionContextError("source_limit_exceeded");
      }
      return {
        deletedSources: deleted.map((source) => ({
          sourceFilePublicId: source.source_file_public_id,
          logicalPath: source.logical_path
        })),
        deletedDirectoryPaths,
        affectedSurvivorSourceFilePublicIds:
          survivors.map((source) => source.public_id),
        obsoleteRelationPublicIds: relations.map((relation) => relation.public_id)
      };
    },

    async readActiveRelations(input: {
      knowledgeBaseId: string;
      affectedSourceFilePublicIds: readonly string[];
      limit: number;
    }): Promise<readonly CanonicalFileRelation[]> {
      assertLimit(input.limit);
      const affected = [...new Set(input.affectedSourceFilePublicIds)];
      if (affected.length === 0) return [];
      if (affected.length > input.limit) {
        throw deletionProjectionContextError("source_limit_exceeded");
      }
      const rows = await sql<Array<{
        relation_public_id: string;
        first_source_file_public_id: string;
        second_source_file_public_id: string;
        relation_kind: "references" | "related";
        evidence_public_id: string;
        source_file_public_id: string;
        source_revision_public_id: string;
        direction: "first_to_second" | "second_to_first";
        evidence_kind: FileRelationEvidenceKind;
        evidence_checksum_sha256: string;
        evidence: Readonly<Record<string, unknown>>;
      }>>`
        SELECT relation.public_id AS relation_public_id,
               relation.first_source_file_public_id,
               relation.second_source_file_public_id,
               relation.relation_kind,
               evidence.public_id AS evidence_public_id,
               evidence.source_file_public_id,
               evidence.source_revision_public_id,
               CASE WHEN evidence.source_file_public_id
                 = relation.first_source_file_public_id
                 THEN 'first_to_second' ELSE 'second_to_first' END AS direction,
               CASE evidence.evidence_kind
                 WHEN 'explicit_reference' THEN 'markdown_link'
                 WHEN 'title_alias' THEN 'stable_alias'
                 ELSE 'semantic'
               END AS evidence_kind,
               evidence.evidence_fingerprint_sha256
                 AS evidence_checksum_sha256,
               evidence.evidence
        FROM focowiki.canonical_file_relations relation
        JOIN focowiki.relation_directed_evidence evidence
          ON evidence.knowledge_base_id = relation.knowledge_base_id
         AND evidence.pair_public_id = relation.pair_public_id
         AND evidence.active AND evidence.retired_at IS NULL
        JOIN focowiki.source_file_active_revisions active_evidence
          ON active_evidence.knowledge_base_id = evidence.knowledge_base_id
         AND active_evidence.source_file_public_id = evidence.source_file_public_id
         AND active_evidence.active_source_revision_public_id
           = evidence.source_revision_public_id
        WHERE relation.knowledge_base_id = ${input.knowledgeBaseId}
          AND relation.active AND relation.retired_at IS NULL
          AND EXISTS (
            SELECT 1 FROM focowiki.source_file_active_revisions endpoint
            WHERE endpoint.knowledge_base_id = relation.knowledge_base_id
              AND endpoint.source_file_public_id
                = relation.first_source_file_public_id
              AND endpoint.active_source_revision_public_id
                = relation.first_source_revision_public_id
          )
          AND EXISTS (
            SELECT 1 FROM focowiki.source_file_active_revisions endpoint
            WHERE endpoint.knowledge_base_id = relation.knowledge_base_id
              AND endpoint.source_file_public_id
                = relation.second_source_file_public_id
              AND endpoint.active_source_revision_public_id
                = relation.second_source_revision_public_id
          )
          AND (relation.first_source_file_public_id IN ${sql(affected)}
            OR relation.second_source_file_public_id IN ${sql(affected)})
        ORDER BY relation.public_id COLLATE "C", evidence.public_id COLLATE "C"
        LIMIT ${input.limit + 1}
      `;
      if (rows.length > input.limit) {
        throw deletionProjectionContextError("relation_limit_exceeded");
      }
      return rows.map((row) => ({
        publicId: row.relation_public_id,
        knowledgeBaseId: input.knowledgeBaseId,
        firstSourceFilePublicId: row.first_source_file_public_id,
        secondSourceFilePublicId: row.second_source_file_public_id,
        relationKind: row.relation_kind,
        evidence: {
          publicId: row.evidence_public_id,
          sourceFilePublicId: row.source_file_public_id,
          sourceRevisionPublicId: row.source_revision_public_id,
          direction: row.direction,
          evidenceKind: row.evidence_kind,
          evidenceChecksumSha256: row.evidence_checksum_sha256,
          value: row.evidence
        }
      }));
    }
  };
}

async function readDeletedDirectoryPaths(
  sql: DatabaseClient,
  action: DocumentResourceDeletionAction,
  limit: number
): Promise<readonly string[]> {
  if (action.targetKind !== "source_directory") return [];
  const rows = await sql<Array<{ logical_path: string }>>`
    SELECT child.logical_path
    FROM focowiki.source_directories root
    JOIN focowiki.source_directories child
      ON child.knowledge_base_id = root.knowledge_base_id
     AND (child.public_id = root.public_id
       OR child.normalized_path LIKE root.normalized_path || '/%')
    WHERE root.knowledge_base_id = ${action.knowledgeBaseId}
      AND root.public_id = ${action.targetPublicId}
      AND child.deleted_at IS NOT NULL
    ORDER BY child.normalized_path COLLATE "C"
    LIMIT ${limit + 1}
  `;
  if (rows.length > limit) {
    throw deletionProjectionContextError("source_limit_exceeded");
  }
  return rows.map((row) => row.logical_path);
}

async function readDeletedSources(
  sql: DatabaseClient,
  action: DocumentResourceDeletionAction,
  limit: number
): Promise<Array<{
  source_file_public_id: string;
  logical_path: string;
}>> {
  const rows = action.targetKind === "source_file"
    ? await sql<Array<{ source_file_public_id: string; logical_path: string }>>`
        SELECT public_id AS source_file_public_id, logical_path
        FROM focowiki.source_files
        WHERE knowledge_base_id = ${action.knowledgeBaseId}
          AND public_id = ${action.targetPublicId}
          AND deleted_at IS NOT NULL
        LIMIT ${limit + 1}
      `
    : action.targetKind === "source_directory"
      ? await sql<Array<{ source_file_public_id: string; logical_path: string }>>`
          SELECT source.public_id AS source_file_public_id, source.logical_path
          FROM focowiki.source_files source
          JOIN focowiki.source_directories root
            ON root.knowledge_base_id = source.knowledge_base_id
           AND root.public_id = ${action.targetPublicId}
          WHERE source.knowledge_base_id = ${action.knowledgeBaseId}
            AND source.normalized_path LIKE root.normalized_path || '/%'
            AND source.deleted_at IS NOT NULL
          ORDER BY source.public_id COLLATE "C"
          LIMIT ${limit + 1}
        `
      : await sql<Array<{ source_file_public_id: string; logical_path: string }>>`
          SELECT public_id AS source_file_public_id, logical_path
          FROM focowiki.source_files
          WHERE knowledge_base_id = ${action.knowledgeBaseId}
            AND deleted_at IS NOT NULL
          ORDER BY public_id COLLATE "C"
          LIMIT ${limit + 1}
        `;
  if (rows.length > limit) {
    throw deletionProjectionContextError("source_limit_exceeded");
  }
  return rows;
}

function assertLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) {
    throw deletionProjectionContextError("invalid_input");
  }
}

function deletionProjectionContextError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Deletion projection context error: ${code}`), {
    code
  });
}
