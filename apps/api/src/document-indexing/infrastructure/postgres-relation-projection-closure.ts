import type { DatabaseClient } from "../../db/client.js";

export type RelationProjectionClosureEntry = {
  pairPublicId: string;
  relationPublicId: string;
  neighborSourceFilePublicId: string;
};

export async function listPostgresRelationProjectionClosure(
  sql: DatabaseClient,
  input: {
    knowledgeBaseId: string;
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
    limit: number;
  }
): Promise<readonly RelationProjectionClosureEntry[]> {
  const knowledgeBaseId = requireIdentity(input.knowledgeBaseId);
  const sourceFilePublicId = requireIdentity(input.sourceFilePublicId);
  const sourceRevisionPublicId = requireIdentity(input.sourceRevisionPublicId);
  const limit = requireLimit(input.limit);
  const rows = await sql<Array<{
    pair_public_id: string;
    relation_public_id: string;
    neighbor_source_file_public_id: string;
  }>>`
    WITH closure AS (
      SELECT relation.*
      FROM focowiki.canonical_file_relations relation
      WHERE relation.knowledge_base_id = ${knowledgeBaseId}
        AND relation.active AND relation.retired_at IS NULL
        AND (
          (relation.first_source_file_public_id = ${sourceFilePublicId}
            AND relation.first_source_revision_public_id
              = ${sourceRevisionPublicId})
          OR
          (relation.second_source_file_public_id = ${sourceFilePublicId}
            AND relation.second_source_revision_public_id
              = ${sourceRevisionPublicId})
        )
      UNION ALL
      SELECT relation.*
      FROM focowiki.canonical_file_relations relation
      WHERE relation.knowledge_base_id = ${knowledgeBaseId}
        AND NOT relation.active AND relation.retired_at IS NULL
        AND (
          (relation.first_source_file_public_id = ${sourceFilePublicId}
            AND relation.first_source_revision_public_id
              = ${sourceRevisionPublicId})
          OR
          (relation.second_source_file_public_id = ${sourceFilePublicId}
            AND relation.second_source_revision_public_id
              = ${sourceRevisionPublicId})
        )
    )
    SELECT closure.pair_public_id,
           closure.public_id AS relation_public_id,
           CASE
             WHEN closure.first_source_file_public_id = ${sourceFilePublicId}
             THEN closure.second_source_file_public_id
             ELSE closure.first_source_file_public_id
           END AS neighbor_source_file_public_id
    FROM closure
    ORDER BY closure.public_id COLLATE "C"
    LIMIT ${limit + 1}
  `;
  if (rows.length > limit) {
    throw projectionClosureError("relation_projection_closure_limit_exceeded");
  }
  return rows.map((row) => ({
    pairPublicId: row.pair_public_id,
    relationPublicId: row.relation_public_id,
    neighborSourceFilePublicId: row.neighbor_source_file_public_id
  }));
}

function requireIdentity(value: string): string {
  if (!value || Buffer.byteLength(value, "utf8") > 255) {
    throw projectionClosureError("invalid_input");
  }
  return value;
}

function requireLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw projectionClosureError("invalid_input");
  }
  return value;
}

function projectionClosureError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Relation projection closure error: ${code}`), {
    code
  });
}
