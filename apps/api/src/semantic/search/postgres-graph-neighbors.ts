import type { DatabaseClient } from "../../db/client.js";
import { generatedPagePath } from "../../domain/source-path.js";
import type { SemanticLaneCandidate } from "./orchestrator.js";

type NeighborRow = {
  source_file_public_id: string;
  source_revision_public_id: string;
  logical_path: string;
};

export function createPostgresSemanticGraphNeighborRepository(
  sql: DatabaseClient
) {
  return {
    async expand(input: {
      knowledgeBaseId: string;
      seedSourceFilePublicIds: readonly string[];
      neighborsPerSeed: number;
      limit: number;
      signal: AbortSignal;
    }): Promise<readonly SemanticLaneCandidate[]> {
      assertInput(input);
      if (input.signal.aborted) throw input.signal.reason;
      if (input.seedSourceFilePublicIds.length === 0) return [];
      const rows = await sql<NeighborRow[]>`
        WITH seeds AS (
          SELECT seed.source_file_public_id, seed.ordinality
          FROM unnest(${[...input.seedSourceFilePublicIds]}::text[])
            WITH ORDINALITY AS seed(source_file_public_id, ordinality)
        ), bounded_neighbors AS (
          SELECT seeds.ordinality, neighbor.relation_public_id,
                 neighbor.source_file_public_id,
                 neighbor.source_revision_public_id
          FROM seeds
          CROSS JOIN LATERAL (
            SELECT relation.public_id AS relation_public_id,
                   CASE
                     WHEN relation.first_source_file_public_id
                       = seeds.source_file_public_id
                     THEN relation.second_source_file_public_id
                     ELSE relation.first_source_file_public_id
                   END AS source_file_public_id,
                   CASE
                     WHEN relation.first_source_file_public_id
                       = seeds.source_file_public_id
                     THEN relation.second_source_revision_public_id
                     ELSE relation.first_source_revision_public_id
                   END AS source_revision_public_id
            FROM focowiki.canonical_file_relations relation
            WHERE relation.knowledge_base_id = ${input.knowledgeBaseId}
              AND relation.active
              AND relation.retired_at IS NULL
              AND (
                relation.first_source_file_public_id
                  = seeds.source_file_public_id
                OR relation.second_source_file_public_id
                  = seeds.source_file_public_id
              )
            ORDER BY relation.public_id COLLATE "C"
            LIMIT ${input.neighborsPerSeed}
          ) neighbor
        ), unique_neighbors AS (
          SELECT DISTINCT ON (source_file_public_id)
                 source_file_public_id, source_revision_public_id,
                 ordinality, relation_public_id
          FROM bounded_neighbors
          WHERE source_file_public_id
            <> ALL(${[...input.seedSourceFilePublicIds]}::text[])
          ORDER BY source_file_public_id, ordinality,
                   relation_public_id COLLATE "C"
        )
        SELECT neighbor.source_file_public_id,
               neighbor.source_revision_public_id,
               presentation.logical_path
        FROM unique_neighbors neighbor
        JOIN focowiki.source_files source
          ON source.knowledge_base_id = ${input.knowledgeBaseId}
         AND source.public_id = neighbor.source_file_public_id
         AND source.deleted_at IS NULL
        JOIN focowiki.source_file_active_revisions active
          ON active.knowledge_base_id = source.knowledge_base_id
         AND active.source_file_public_id = source.public_id
         AND active.active_source_revision_public_id
           = neighbor.source_revision_public_id
        JOIN focowiki.source_revision_presentations presentation
          ON presentation.knowledge_base_id = active.knowledge_base_id
         AND presentation.source_file_public_id = active.source_file_public_id
         AND presentation.source_revision_public_id
           = active.active_source_revision_public_id
        ORDER BY neighbor.ordinality, neighbor.relation_public_id COLLATE "C",
                 neighbor.source_file_public_id COLLATE "C"
        LIMIT ${input.limit}
      `;
      if (input.signal.aborted) throw input.signal.reason;
      return rows.map((row, index) => ({
        sourceFilePublicId: row.source_file_public_id,
        sourceRevisionPublicId: row.source_revision_public_id,
        evidenceTargetPath: generatedPagePath(row.logical_path),
        rank: index + 1,
        bodyGrounded: true,
        snippet: null
      }));
    }
  };
}

function assertInput(input: {
  knowledgeBaseId: string;
  seedSourceFilePublicIds: readonly string[];
  neighborsPerSeed: number;
  limit: number;
}): void {
  if (
    !input.knowledgeBaseId
    || input.seedSourceFilePublicIds.length > 5
    || new Set(input.seedSourceFilePublicIds).size
      !== input.seedSourceFilePublicIds.length
    || input.seedSourceFilePublicIds.some((value) => !value)
    || !Number.isSafeInteger(input.neighborsPerSeed)
    || input.neighborsPerSeed < 1
    || input.neighborsPerSeed > 5
    || !Number.isSafeInteger(input.limit)
    || input.limit < 1
    || input.limit > 25
  ) throw new Error("Semantic graph expansion request is invalid");
}
