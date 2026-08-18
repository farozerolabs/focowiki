import type { DatabaseClient } from "../../db/client.js";
import { canExposeRevisionArtifact } from
  "../../document-indexing/domain/revision-visibility.js";
import type {
  StorageVnextSearchHydrationPort,
  StorageVnextSearchHydrationRecord
} from "./search-hydration.js";
import type { StorageVnextStructuredMetadata } from "../shared/types.js";

type HydrationRow = {
  public_id: string;
  source_revision_public_id: string;
  artifact_source_revision_public_id: string;
  document_state: "available";
  source_deleted_at: Date | string | null;
  logical_path: string;
  title: string;
  metadata: StorageVnextStructuredMetadata;
};

export function createPostgresStorageVnextSearchHydration(
  sql: DatabaseClient
): StorageVnextSearchHydrationPort {
  return {
    async hydrateCurrentSources(input) {
      const publicIds = [...new Set(input.sourceFilePublicIds)];
      if (!input.knowledgeBaseId || publicIds.length > 1_000
        || publicIds.some((publicId) => !publicId)) {
        throw new Error("Storage vNext search hydration input is invalid");
      }
      if (input.candidatePublicId !== undefined) {
        throw new Error("Document indexing does not expose candidate hydration");
      }
      if (publicIds.length === 0) return [];
      const rows = await sql<HydrationRow[]>`
        WITH requested AS (
          SELECT public_id, ordinal
          FROM unnest(${publicIds}::text[])
            WITH ORDINALITY AS item(public_id, ordinal)
        )
        SELECT source.public_id,
               active.active_source_revision_public_id
                 AS source_revision_public_id,
               page.source_revision_public_id
                 AS artifact_source_revision_public_id,
               job.state AS document_state,
               source.deleted_at AS source_deleted_at,
               page.logical_path, source.title, source.metadata
        FROM requested
        JOIN focowiki.source_files source
          ON source.public_id = requested.public_id
         AND source.knowledge_base_id = ${input.knowledgeBaseId}
         AND source.deleted_at IS NULL
        JOIN focowiki.knowledge_bases knowledge_base
          ON knowledge_base.public_id = source.knowledge_base_id
         AND knowledge_base.deleted_at IS NULL
        JOIN focowiki.source_file_active_revisions active
          ON active.knowledge_base_id = source.knowledge_base_id
         AND active.source_file_public_id = source.public_id
         AND active.active_source_revision_public_id IS NOT NULL
        JOIN focowiki.document_processing_jobs job
          ON job.knowledge_base_id = active.knowledge_base_id
         AND job.source_file_public_id = active.source_file_public_id
         AND job.source_revision_public_id
           = active.active_source_revision_public_id
         AND job.state = 'available'
        JOIN focowiki.source_revisions revision
          ON revision.knowledge_base_id = active.knowledge_base_id
         AND revision.source_file_public_id = active.source_file_public_id
         AND revision.public_id = active.active_source_revision_public_id
         AND revision.deleted_at IS NULL
        JOIN focowiki.object_registrations source_object
          ON source_object.object_id = revision.object_id
         AND source_object.state = 'verified'
        JOIN focowiki.generated_page_heads page
          ON page.knowledge_base_id = active.knowledge_base_id
         AND page.source_file_public_id = active.source_file_public_id
         AND page.source_revision_public_id
           = active.active_source_revision_public_id
         AND page.entry_kind = 'source'
        WHERE EXISTS (
          SELECT 1
          FROM focowiki.search_document_owners owner
          WHERE owner.knowledge_base_id = active.knowledge_base_id
            AND owner.source_file_public_id = active.source_file_public_id
            AND owner.source_revision_public_id
              = active.active_source_revision_public_id
            AND owner.state = 'active'
        )
        ORDER BY requested.ordinal
      `;
      return rows
        .filter((row) => canExposeRevisionArtifact({
          surface: "search",
          artifactSourceRevisionPublicId:
            row.artifact_source_revision_public_id,
          activeSourceRevisionPublicId: row.source_revision_public_id,
          documentState: row.document_state,
          sourceDeletedAt: row.source_deleted_at === null
            ? null : new Date(row.source_deleted_at).toISOString(),
          bodyReadable: true
        }))
        .map(mapHydration);
    }
  };
}

function mapHydration(row: HydrationRow): StorageVnextSearchHydrationRecord {
  return {
    sourceFilePublicId: row.public_id,
    sourceRevisionPublicId: row.source_revision_public_id,
    logicalPath: row.logical_path,
    title: presentationTitle(row.metadata, row.title),
    metadata: structuredClone(row.metadata)
  };
}

function presentationTitle(
  metadata: StorageVnextStructuredMetadata,
  fallback: string
): string {
  const title = metadata.title;
  return typeof title === "string" && title.trim() ? title.trim() : fallback;
}
