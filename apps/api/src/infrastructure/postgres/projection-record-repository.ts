import type {
  ProjectionRecord,
  ProjectionRecordRepository
} from "../../application/ports/projection-record-repository.js";
import type { SerializableJson } from "../../application/ports/source-dispatch-repository.js";
import type { DatabaseClient } from "../../db/client.js";

type ProjectionRecordRow = {
  knowledge_base_id: string;
  projection_kind: ProjectionRecord["projectionKind"];
  record_id: string;
  last_changed_generation_id: string;
  shard_key: string;
  source_file_id: string | null;
  related_source_file_id: string | null;
  logical_path: string | null;
  parent_path: string | null;
  sort_key: string | null;
  title: string | null;
  summary: string | null;
  searchable_text: string | null;
  payload_json: SerializableJson;
};

export function createPostgresProjectionRecordRepository(
  sql: DatabaseClient
): ProjectionRecordRepository {
  return {
    async stageUpsert(input) {
      await sql`
        INSERT INTO focowiki.generation_projection_records (
          generation_id, knowledge_base_id, projection_kind, record_id,
          action, shard_key, source_file_id, related_source_file_id,
          logical_path, parent_path, sort_key, title, summary,
          searchable_text, payload_json
        ) VALUES (
          ${input.generationId}, ${input.knowledgeBaseId}, ${input.projectionKind},
          ${input.recordId}, 'upsert', ${input.shardKey}, ${input.sourceFileId},
          ${input.relatedSourceFileId}, ${input.logicalPath}, ${input.parentPath},
          ${input.sortKey}, ${input.title}, ${input.summary}, ${input.searchableText},
          ${sql.json(input.payload)}
        )
        ON CONFLICT (generation_id, projection_kind, record_id) DO UPDATE
        SET action = 'upsert', shard_key = EXCLUDED.shard_key,
            source_file_id = EXCLUDED.source_file_id,
            related_source_file_id = EXCLUDED.related_source_file_id,
            logical_path = EXCLUDED.logical_path, parent_path = EXCLUDED.parent_path,
            sort_key = EXCLUDED.sort_key, title = EXCLUDED.title,
            summary = EXCLUDED.summary, searchable_text = EXCLUDED.searchable_text,
            payload_json = EXCLUDED.payload_json
      `;
    },

    async stageDelete(input) {
      await sql`
        INSERT INTO focowiki.generation_projection_records (
          generation_id, knowledge_base_id, projection_kind, record_id,
          action, shard_key
        ) VALUES (
          ${input.generationId}, ${input.knowledgeBaseId}, ${input.projectionKind},
          ${input.recordId}, 'delete', ${input.shardKey}
        )
        ON CONFLICT (generation_id, projection_kind, record_id) DO UPDATE
        SET action = 'delete', shard_key = EXCLUDED.shard_key,
            source_file_id = NULL, related_source_file_id = NULL,
            logical_path = NULL, parent_path = NULL, sort_key = NULL,
            title = NULL, summary = NULL, searchable_text = NULL,
            payload_json = '{}'
      `;
    },

    async findActive(input) {
      const rows = await sql<ProjectionRecordRow[]>`
        SELECT knowledge_base_id, projection_kind, record_id,
               last_changed_generation_id, shard_key, source_file_id,
               related_source_file_id, logical_path, parent_path, sort_key,
               title, summary, searchable_text, payload_json
        FROM focowiki.active_projection_records
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND projection_kind = ${input.projectionKind}
          AND record_id = ${input.recordId}
        LIMIT 1
      `;
      return rows[0] ? mapRecord(rows[0]) : null;
    },

    async findStaged(input) {
      const rows = await sql<ProjectionRecordRow[]>`
        SELECT knowledge_base_id, projection_kind, record_id,
               generation_id AS last_changed_generation_id, shard_key,
               source_file_id, related_source_file_id, logical_path,
               parent_path, sort_key, title, summary, searchable_text,
               payload_json
        FROM focowiki.generation_projection_records
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND generation_id = ${input.generationId}
          AND projection_kind = ${input.projectionKind}
          AND record_id = ${input.recordId}
          AND action = 'upsert'
        LIMIT 1
      `;
      return rows[0] ? mapRecord(rows[0]) : null;
    }
  };
}

function mapRecord(row: ProjectionRecordRow): ProjectionRecord {
  return {
    knowledgeBaseId: row.knowledge_base_id,
    projectionKind: row.projection_kind,
    recordId: row.record_id,
    lastChangedGenerationId: row.last_changed_generation_id,
    shardKey: row.shard_key,
    sourceFileId: row.source_file_id,
    relatedSourceFileId: row.related_source_file_id,
    logicalPath: row.logical_path,
    parentPath: row.parent_path,
    sortKey: row.sort_key,
    title: row.title,
    summary: row.summary,
    searchableText: row.searchable_text,
    payload: row.payload_json
  };
}
