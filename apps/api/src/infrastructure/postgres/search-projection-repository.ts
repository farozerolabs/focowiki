import type {
  SearchProjectionDocumentRecord,
  SearchProjectionIdentity,
  SearchProjectionRepository
} from "../../application/ports/search-projection-repository.js";
import type { DatabaseClient } from "../../db/client.js";

type SearchDocumentRow = {
  id: string;
  knowledge_base_id: string;
  source_file_id: string;
  source_revision_id: string;
  source_body_checksum_sha256: string;
  search_schema_version: string;
  tokenizer_contract_version: string;
  segmentation_version: string;
  segment_count: number;
  lifecycle_state: SearchProjectionDocumentRecord["lifecycleState"];
};

const SEGMENT_INSERT_BATCH_SIZE = 250;

export function createPostgresSearchProjectionRepository(
  sql: DatabaseClient
): SearchProjectionRepository {
  return {
    async persistDocument(input) {
      return sql.begin(async (transaction) => {
        const document = input.document;
        await transaction`
          INSERT INTO focowiki.search_projection_documents (
            id, knowledge_base_id, source_file_id, source_revision_id,
            source_body_checksum_sha256, search_schema_version,
            tokenizer_contract_version, segmentation_version
          ) VALUES (
            ${document.documentId}, ${document.knowledgeBaseId},
            ${document.sourceFileId}, ${document.sourceRevisionId},
            ${document.sourceBodyChecksumSha256}, ${document.searchSchemaVersion},
            ${document.tokenizerContractVersion}, ${document.segmentationVersion}
          )
          ON CONFLICT (id) DO NOTHING
        `;
        const rows = await transaction<SearchDocumentRow[]>`
          SELECT id, knowledge_base_id, source_file_id, source_revision_id,
                 source_body_checksum_sha256, search_schema_version,
                 tokenizer_contract_version, segmentation_version,
                 segment_count, lifecycle_state
          FROM focowiki.search_projection_documents
          WHERE id = ${document.documentId}
          FOR UPDATE
        `;
        const existing = rows[0];
        if (!existing) {
          throw new Error("Search projection document reservation is unavailable");
        }
        assertDocumentIdentity(existing, document);
        if (existing.lifecycle_state === "ready") {
          return { status: "reused" as const, document: mapDocument(existing) };
        }

        await transaction`
          DELETE FROM focowiki.search_projection_segments
          WHERE document_id = ${document.documentId}
        `;
        for (
          let offset = 0;
          offset < document.segments.length;
          offset += SEGMENT_INSERT_BATCH_SIZE
        ) {
          const segments = document.segments
            .slice(offset, offset + SEGMENT_INSERT_BATCH_SIZE)
            .map((segment) => ({
              ordinal: segment.ordinal,
              heading: segment.heading,
              normalized_text: segment.normalizedText,
              tokens: segment.tokens,
              token_text: segment.tokens.join(" "),
              character_count: [...segment.normalizedText].length,
              byte_count: Buffer.byteLength(segment.normalizedText, "utf8")
            }));
          await transaction`
            INSERT INTO focowiki.search_projection_segments (
              document_id, knowledge_base_id, ordinal, heading,
              normalized_text, tokens, token_text, character_count, byte_count
            )
            SELECT
              ${document.documentId}, ${document.knowledgeBaseId},
              segment.ordinal, segment.heading, segment.normalized_text,
              segment.tokens, segment.token_text,
              segment.character_count, segment.byte_count
            FROM jsonb_to_recordset(${transaction.json(segments as never)}) AS segment(
              ordinal integer,
              heading text,
              normalized_text text,
              tokens text[],
              token_text text,
              character_count integer,
              byte_count integer
            )
          `;
        }
        const completed = await transaction<SearchDocumentRow[]>`
          UPDATE focowiki.search_projection_documents
          SET source_revision_id = ${document.sourceRevisionId},
              segment_count = ${document.segments.length},
              lifecycle_state = 'ready',
              safe_error_code = NULL,
              safe_error_message = NULL,
              completed_at = ${input.completedAt},
              updated_at = ${input.completedAt}
          WHERE id = ${document.documentId}
          RETURNING id, knowledge_base_id, source_file_id, source_revision_id,
                    source_body_checksum_sha256, search_schema_version,
                    tokenizer_contract_version, segmentation_version,
                    segment_count, lifecycle_state
        `;
        return {
          status: "created" as const,
          document: mapDocument(completed[0]!)
        };
      });
    },

    async findReadyDocument(input) {
      const rows = await sql<SearchDocumentRow[]>`
        SELECT id, knowledge_base_id, source_file_id, source_revision_id,
               source_body_checksum_sha256, search_schema_version,
               tokenizer_contract_version, segmentation_version,
               segment_count, lifecycle_state
        FROM focowiki.search_projection_documents
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_file_id = ${input.sourceFileId}
          AND source_body_checksum_sha256 = ${input.sourceBodyChecksumSha256}
          AND search_schema_version = ${input.searchSchemaVersion}
          AND tokenizer_contract_version = ${input.tokenizerContractVersion}
          AND segmentation_version = ${input.segmentationVersion}
          AND lifecycle_state = 'ready'
        LIMIT 1
      `;
      return rows[0] ? mapDocument(rows[0]) : null;
    },

    async attachGenerationReference(input) {
      const rows = await sql<Array<{ source_file_id: string }>>`
        INSERT INTO focowiki.generation_search_projection_refs (
          knowledge_base_id, generation_id, source_file_id, source_revision_id,
          search_document_id, search_schema_version, tokenizer_contract_version,
          segmentation_version, path_revision,
          logical_path, title, summary, source_url, metadata_json, updated_at
        )
        SELECT
          ${input.knowledgeBaseId}, ${input.generationId}, ${input.sourceFileId},
          ${input.sourceRevisionId}, document.id, ${input.searchSchemaVersion},
          ${input.tokenizerContractVersion}, ${input.segmentationVersion},
          source.resource_revision,
          ${input.logicalPath}, ${input.title},
          ${input.summary}, ${input.sourceUrl},
          ${sql.json(input.metadata as never)}, now()
        FROM focowiki.search_projection_documents document
        JOIN focowiki.source_files source
          ON source.knowledge_base_id = document.knowledge_base_id
         AND source.id = document.source_file_id
        WHERE document.id = ${input.searchDocumentId}
          AND document.knowledge_base_id = ${input.knowledgeBaseId}
          AND document.source_file_id = ${input.sourceFileId}
          AND document.search_schema_version = ${input.searchSchemaVersion}
          AND document.tokenizer_contract_version = ${input.tokenizerContractVersion}
          AND document.segmentation_version = ${input.segmentationVersion}
          AND document.lifecycle_state = 'ready'
        ON CONFLICT (generation_id, source_file_id) DO UPDATE
        SET source_revision_id = EXCLUDED.source_revision_id,
            search_document_id = EXCLUDED.search_document_id,
            search_schema_version = EXCLUDED.search_schema_version,
            tokenizer_contract_version = EXCLUDED.tokenizer_contract_version,
            segmentation_version = EXCLUDED.segmentation_version,
            path_revision = EXCLUDED.path_revision,
            logical_path = EXCLUDED.logical_path,
            title = EXCLUDED.title,
            summary = EXCLUDED.summary,
            source_url = EXCLUDED.source_url,
            metadata_json = EXCLUDED.metadata_json,
            updated_at = now()
        RETURNING source_file_id
      `;
      if (rows.length !== 1) {
        throw new Error("Ready search projection document is unavailable");
      }
    },

    async deleteGenerationReferences(input) {
      if (input.sourceFileIds.length === 0) return 0;
      const rows = await sql<Array<{ source_file_id: string }>>`
        DELETE FROM focowiki.generation_search_projection_refs
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND generation_id = ${input.generationId}
          AND source_file_id = ANY(${input.sourceFileIds})
        RETURNING source_file_id
      `;
      return rows.length;
    },

    async cleanupUnreferencedDocuments(input) {
      const rows = await sql<Array<{ id: string }>>`
        WITH candidates AS MATERIALIZED (
          SELECT document.id
          FROM focowiki.search_projection_documents document
          WHERE document.updated_at < ${input.olderThan}
            AND NOT EXISTS (
              SELECT 1
              FROM focowiki.generation_search_projection_refs reference
              WHERE reference.search_document_id = document.id
            )
          ORDER BY document.updated_at, document.id
          LIMIT ${boundedCleanupLimit(input.limit)}
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM focowiki.search_projection_documents document
        USING candidates
        WHERE document.id = candidates.id
        RETURNING document.id
      `;
      return rows.length;
    }
  };
}

function assertDocumentIdentity(
  row: SearchDocumentRow,
  identity: SearchProjectionIdentity & { documentId: string }
): void {
  if (
    row.knowledge_base_id !== identity.knowledgeBaseId
    || row.source_file_id !== identity.sourceFileId
    || row.source_body_checksum_sha256 !== identity.sourceBodyChecksumSha256
    || row.search_schema_version !== identity.searchSchemaVersion
    || row.tokenizer_contract_version !== identity.tokenizerContractVersion
    || row.segmentation_version !== identity.segmentationVersion
  ) {
    throw new Error("Search projection document identity collision");
  }
}

function mapDocument(row: SearchDocumentRow): SearchProjectionDocumentRecord {
  return {
    documentId: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    sourceFileId: row.source_file_id,
    sourceRevisionId: row.source_revision_id,
    sourceBodyChecksumSha256: row.source_body_checksum_sha256,
    searchSchemaVersion: row.search_schema_version,
    tokenizerContractVersion: row.tokenizer_contract_version,
    segmentationVersion: row.segmentation_version,
    segmentCount: Number(row.segment_count),
    lifecycleState: row.lifecycle_state
  };
}

function boundedCleanupLimit(value: number): number {
  return Math.min(1_000, Math.max(1, Math.trunc(value)));
}
