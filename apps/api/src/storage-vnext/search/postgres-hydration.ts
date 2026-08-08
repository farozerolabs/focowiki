import type { DatabaseClient } from "../../db/client.js";
import { generatedPagePath } from "../../domain/source-path.js";
import {
  createPostgresStorageVnextCatalogRepository
} from "../catalog/postgres-repository.js";
import {
  createPostgresStorageVnextMutationCandidateCatalog,
  readPostgresStorageVnextMutationCandidateOverlay
} from "../mutation/postgres-candidate-overlay.js";
import type {
  StorageVnextSearchHydrationPort,
  StorageVnextSearchHydrationRecord
} from "./search-hydration.js";
import type { StorageVnextStructuredMetadata } from "../shared/types.js";

type HydrationRow = {
  public_id: string;
  source_revision_public_id: string;
  logical_path: string;
  title: string;
  metadata: StorageVnextStructuredMetadata;
};

type CandidateRow = {
  operation_public_id: string;
};

export function createPostgresStorageVnextSearchHydration(
  sql: DatabaseClient
): StorageVnextSearchHydrationPort {
  return {
    async hydrateCurrentSources(input) {
      const publicIds = [...new Set(input.sourceFilePublicIds)];
      if (
        !input.knowledgeBaseId || publicIds.length > 1_000
        || publicIds.some((publicId) => !publicId)
        || input.candidatePublicId !== undefined && !input.candidatePublicId
      ) throw new Error("Storage vNext search hydration input is invalid");
      if (publicIds.length === 0) return [];
      if (input.candidatePublicId) {
        const candidateRows = await sql<CandidateRow[]>`
          SELECT operation_public_id
          FROM focowiki.release_candidates
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND public_id = ${input.candidatePublicId}
          LIMIT 1
        `;
        const candidate = candidateRows[0];
        if (candidate) {
          const mutation = await readPostgresStorageVnextMutationCandidateOverlay(
            sql,
            {
              knowledgeBaseId: input.knowledgeBaseId,
              operationPublicId: candidate.operation_public_id,
              candidatePublicId: input.candidatePublicId
            }
          );
          if (mutation) {
            const catalog = createPostgresStorageVnextMutationCandidateCatalog({
              sql,
              mutation,
              catalog: createPostgresStorageVnextCatalogRepository(sql)
            });
            const sources = await catalog.listSourceFilesByPublicIds({
              knowledgeBaseId: input.knowledgeBaseId,
              publicIds,
              limit: publicIds.length
            });
            return sources.flatMap((source) => source.currentRevisionPublicId
              ? [{
                  sourceFilePublicId: source.publicId,
                  sourceRevisionPublicId: source.currentRevisionPublicId,
                  logicalPath: generatedPagePath(source.logicalPath),
                  title: source.title,
                  metadata: structuredClone(source.metadata)
                }]
              : []);
          }
        }
      }
      const rows = await sql<HydrationRow[]>`
        WITH requested AS (
          SELECT public_id, ordinal
          FROM unnest(${publicIds}::text[])
            WITH ORDINALITY AS item(public_id, ordinal)
        )
        SELECT source.public_id, current_revision.source_revision_public_id,
               source.logical_path, source.title, source.metadata
        FROM requested
        JOIN focowiki.source_files source
          ON source.public_id = requested.public_id
         AND source.knowledge_base_id = ${input.knowledgeBaseId}
         AND source.deleted_at IS NULL
        JOIN focowiki.source_file_current_revisions current_revision
          ON current_revision.knowledge_base_id = source.knowledge_base_id
         AND current_revision.source_file_public_id = source.public_id
        JOIN focowiki.knowledge_bases knowledge_base
          ON knowledge_base.public_id = source.knowledge_base_id
         AND knowledge_base.deleted_at IS NULL
        ORDER BY requested.ordinal
      `;
      return rows.map(mapHydration);
    }
  };
}

function mapHydration(row: HydrationRow): StorageVnextSearchHydrationRecord {
  return {
    sourceFilePublicId: row.public_id,
    sourceRevisionPublicId: row.source_revision_public_id,
    logicalPath: generatedPagePath(row.logical_path),
    title: row.title,
    metadata: structuredClone(row.metadata)
  };
}
