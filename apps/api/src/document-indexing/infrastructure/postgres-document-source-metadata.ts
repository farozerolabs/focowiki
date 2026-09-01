import type { DatabaseClient } from "../../db/client.js";
import type {
  DocumentSourceMetadataRepairClaim,
  DocumentSourceMetadataRepairRepository
} from "../application/document-source-metadata-repair.js";

type ClaimedRow = {
  knowledge_base_id: string;
  source_file_public_id: string;
  source_revision_public_id: string;
  logical_path: string;
  object_id: string;
  checksum_sha256: string;
  byte_count: number | string;
  content_type: string;
};

export function createPostgresDocumentSourceMetadataRepository(
  sql: DatabaseClient
): DocumentSourceMetadataRepairRepository & {
  persistPrepared(input: {
    knowledgeBaseId: string;
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
    title: string;
    metadata: Readonly<Record<string, unknown>>;
    parsedAt: string;
  }): Promise<void>;
} {
  return {
    async persistPrepared(input) {
      const rows = await sql<Array<{ source_revision_public_id: string }>>`
        UPDATE focowiki.source_revision_presentations
        SET title = ${input.title},
            metadata = ${sql.json(input.metadata as never)},
            metadata_parsed_at = ${input.parsedAt},
            metadata_repair_started_at = NULL
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_file_public_id = ${input.sourceFilePublicId}
          AND source_revision_public_id = ${input.sourceRevisionPublicId}
        RETURNING source_revision_public_id
      `;
      if (rows.length !== 1) throw metadataRepositoryError(
        "source_revision_presentation_not_found"
      );
    },

    async claim(input) {
      const rows = await sql<ClaimedRow[]>`
        WITH candidates AS MATERIALIZED (
          SELECT presentation.knowledge_base_id,
                 presentation.source_file_public_id,
                 presentation.source_revision_public_id
          FROM focowiki.source_revision_presentations presentation
          JOIN focowiki.source_file_active_revisions active
            ON active.knowledge_base_id = presentation.knowledge_base_id
           AND active.source_file_public_id
                 = presentation.source_file_public_id
           AND active.active_source_revision_public_id
                 = presentation.source_revision_public_id
          JOIN focowiki.source_files source
            ON source.knowledge_base_id = presentation.knowledge_base_id
           AND source.public_id = presentation.source_file_public_id
           AND source.deleted_at IS NULL
          WHERE presentation.metadata_parsed_at IS NULL
            AND (
              presentation.metadata_repair_started_at IS NULL
              OR presentation.metadata_repair_started_at <= ${input.staleBefore}
            )
          ORDER BY presentation.created_at,
                   presentation.source_revision_public_id COLLATE "C"
          LIMIT ${input.limit}
          FOR UPDATE OF presentation SKIP LOCKED
        ), claimed AS (
          UPDATE focowiki.source_revision_presentations presentation
          SET metadata_repair_started_at = ${input.now}
          FROM candidates
          WHERE presentation.knowledge_base_id
                  = candidates.knowledge_base_id
            AND presentation.source_file_public_id
                  = candidates.source_file_public_id
            AND presentation.source_revision_public_id
                  = candidates.source_revision_public_id
            AND presentation.metadata_parsed_at IS NULL
          RETURNING presentation.knowledge_base_id,
                    presentation.source_file_public_id,
                    presentation.source_revision_public_id,
                    presentation.logical_path,
                    presentation.metadata_repair_started_at
        )
        SELECT claimed.knowledge_base_id, claimed.source_file_public_id,
               claimed.source_revision_public_id, claimed.logical_path,
               revision.object_id, revision.checksum_sha256,
               revision.byte_count, revision.content_type
        FROM claimed
        JOIN focowiki.source_revisions revision
          ON revision.knowledge_base_id = claimed.knowledge_base_id
         AND revision.source_file_public_id = claimed.source_file_public_id
         AND revision.public_id = claimed.source_revision_public_id
        ORDER BY claimed.source_revision_public_id COLLATE "C"
      `;
      return rows.map((row) => mapClaimedRow(row, input.now));
    },

    async complete(input) {
      return sql.begin(async (transaction) => {
        const rows = await transaction<Array<{
          source_revision_public_id: string;
        }>>`
          UPDATE focowiki.source_revision_presentations presentation
          SET title = ${input.title},
              metadata = ${transaction.json(input.metadata as never)},
              metadata_parsed_at = ${input.completedAt},
              metadata_repair_started_at = NULL
          WHERE presentation.knowledge_base_id = ${input.knowledgeBaseId}
            AND presentation.source_file_public_id
                  = ${input.sourceFilePublicId}
            AND presentation.source_revision_public_id
                  = ${input.sourceRevisionPublicId}
            AND presentation.metadata_parsed_at IS NULL
            AND presentation.metadata_repair_started_at
                  = ${input.repairStartedAt}
          RETURNING presentation.source_revision_public_id
        `;
        if (rows.length !== 1) return false;
        await transaction`
          UPDATE focowiki.source_files source
          SET title = ${input.title},
              metadata = ${transaction.json(input.metadata as never)},
              updated_at = ${input.completedAt}
          FROM focowiki.source_file_active_revisions active
          WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
            AND source.public_id = ${input.sourceFilePublicId}
            AND active.knowledge_base_id = source.knowledge_base_id
            AND active.source_file_public_id = source.public_id
            AND active.active_source_revision_public_id
                  = ${input.sourceRevisionPublicId}
            AND source.deleted_at IS NULL
        `;
        return true;
      });
    },

    async defer(input) {
      await sql`
        UPDATE focowiki.source_revision_presentations presentation
        SET metadata_repair_started_at = ${input.deferredAt}
        WHERE presentation.knowledge_base_id = ${input.knowledgeBaseId}
          AND presentation.source_file_public_id = ${input.sourceFilePublicId}
          AND presentation.source_revision_public_id
                = ${input.sourceRevisionPublicId}
          AND presentation.metadata_parsed_at IS NULL
          AND presentation.metadata_repair_started_at
                = ${input.repairStartedAt}
      `;
    }
  };
}

function mapClaimedRow(
  row: ClaimedRow,
  repairStartedAt: string
): DocumentSourceMetadataRepairClaim {
  return {
    knowledgeBaseId: row.knowledge_base_id,
    sourceFilePublicId: row.source_file_public_id,
    sourceRevisionPublicId: row.source_revision_public_id,
    logicalPath: row.logical_path,
    objectId: row.object_id,
    checksumSha256: row.checksum_sha256,
    byteCount: Number(row.byte_count),
    contentType: row.content_type,
    repairStartedAt
  };
}

function metadataRepositoryError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document source metadata error: ${code}`), {
    code
  });
}
