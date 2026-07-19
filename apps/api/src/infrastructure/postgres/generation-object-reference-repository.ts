import type {
  ActiveObjectReference,
  GenerationObjectReferenceRepository
} from "../../application/ports/generation-object-reference-repository.js";
import type { DatabaseClient } from "../../db/client.js";

type ActiveReferenceRow = {
  knowledge_base_id: string;
  ref_kind: string;
  ref_key: string;
  file_id: string;
  last_changed_generation_id: string;
  checksum_sha256: string;
  format_version: number;
  logical_path: string | null;
  source_file_id: string | null;
  projection_shard_id: string | null;
  object_key: string;
  content_type: string;
  size_bytes: number;
};

const ACTIVE_REFERENCE_COLUMNS = `
  active.knowledge_base_id, active.ref_kind, active.ref_key,
  active.file_id,
  active.last_changed_generation_id, active.checksum_sha256,
  active.format_version, active.logical_path, active.source_file_id,
  active.projection_shard_id, object.object_key, object.content_type,
  object.size_bytes
`;

export function createPostgresGenerationObjectReferenceRepository(
  sql: DatabaseClient
): GenerationObjectReferenceRepository {
  return {
    async stageUpsert(input) {
      const rows = await sql.begin(async (transaction) => {
        const objects = await transaction<Array<{ checksum_sha256: string }>>`
          SELECT checksum_sha256
          FROM focowiki.immutable_objects
          WHERE checksum_sha256 = ${input.checksumSha256}
            AND format_version = ${input.formatVersion}
            AND lifecycle_state = 'active'
          FOR UPDATE
        `;
        if (!objects[0]) return [];
        return transaction<Array<{ ref_key: string }>>`
          INSERT INTO focowiki.generation_object_refs (
            generation_id, knowledge_base_id, ref_kind, ref_key, action,
            file_id, checksum_sha256, format_version, logical_path, source_file_id,
            projection_shard_id
          ) VALUES (
            ${input.generationId}, ${input.knowledgeBaseId}, ${input.refKind},
            ${input.refKey}, 'upsert', ${input.fileId}, ${input.checksumSha256}, ${input.formatVersion},
            ${input.logicalPath}, ${input.sourceFileId}, ${input.projectionShardId}
          )
          ON CONFLICT (generation_id, ref_kind, ref_key) DO UPDATE
          SET action = 'upsert', file_id = EXCLUDED.file_id,
              checksum_sha256 = EXCLUDED.checksum_sha256,
              format_version = EXCLUDED.format_version,
              logical_path = EXCLUDED.logical_path,
              source_file_id = EXCLUDED.source_file_id,
              projection_shard_id = EXCLUDED.projection_shard_id
          RETURNING ref_key
        `;
      });
      if (!rows[0]) {
        throw new Error("Immutable object is unavailable for generation reference");
      }
    },

    async stageDelete(input) {
      await sql`
        INSERT INTO focowiki.generation_object_refs (
          generation_id, knowledge_base_id, ref_kind, ref_key, action,
          file_id, checksum_sha256, format_version, logical_path, source_file_id
        ) VALUES (
          ${input.generationId}, ${input.knowledgeBaseId}, ${input.refKind},
          ${input.refKey}, 'delete', NULL, NULL, NULL, ${input.logicalPath}, ${input.sourceFileId}
        )
        ON CONFLICT (generation_id, ref_kind, ref_key) DO UPDATE
        SET action = 'delete', file_id = NULL,
            checksum_sha256 = NULL, format_version = NULL,
            logical_path = EXCLUDED.logical_path,
            source_file_id = EXCLUDED.source_file_id,
            projection_shard_id = NULL
      `;
    },

    async findActiveByPath(input) {
      const rows = await sql<ActiveReferenceRow[]>`
        SELECT ${sql.unsafe(ACTIVE_REFERENCE_COLUMNS)}
        FROM focowiki.active_object_refs active
        JOIN focowiki.immutable_objects object
          ON object.checksum_sha256 = active.checksum_sha256
         AND object.format_version = active.format_version
        WHERE active.knowledge_base_id = ${input.knowledgeBaseId}
          AND active.logical_path = ${input.logicalPath}
        LIMIT 1
      `;
      return rows[0] ? mapActiveReference(rows[0]) : null;
    },

    async findActiveByRef(input) {
      const rows = await sql<ActiveReferenceRow[]>`
        SELECT ${sql.unsafe(ACTIVE_REFERENCE_COLUMNS)}
        FROM focowiki.active_object_refs active
        JOIN focowiki.immutable_objects object
          ON object.checksum_sha256 = active.checksum_sha256
         AND object.format_version = active.format_version
        WHERE active.knowledge_base_id = ${input.knowledgeBaseId}
          AND active.ref_kind = ${input.refKind}
          AND active.ref_key = ${input.refKey}
        LIMIT 1
      `;
      return rows[0] ? mapActiveReference(rows[0]) : null;
    },

    async findStagedByRef(input) {
      const rows = await sql<ActiveReferenceRow[]>`
        SELECT change.knowledge_base_id, change.ref_kind, change.ref_key,
               change.file_id,
               change.generation_id AS last_changed_generation_id,
               change.checksum_sha256, change.format_version, change.logical_path,
               change.source_file_id, change.projection_shard_id,
               object.object_key, object.content_type, object.size_bytes
        FROM focowiki.generation_object_refs change
        JOIN focowiki.immutable_objects object
          ON object.checksum_sha256 = change.checksum_sha256
         AND object.format_version = change.format_version
        WHERE change.knowledge_base_id = ${input.knowledgeBaseId}
          AND change.generation_id = ${input.generationId}
          AND change.ref_kind = ${input.refKind}
          AND change.ref_key = ${input.refKey}
          AND change.action = 'upsert'
        LIMIT 1
      `;
      return rows[0] ? mapActiveReference(rows[0]) : null;
    },

    async findEffectiveByRef(input) {
      const rows = await sql<ActiveReferenceRow[]>`
        WITH staged AS (
          SELECT change.knowledge_base_id, change.ref_kind, change.ref_key,
                 change.file_id,
                 change.generation_id AS last_changed_generation_id,
                 change.checksum_sha256, change.format_version,
                 change.logical_path, change.source_file_id,
                 change.projection_shard_id, change.action
          FROM focowiki.generation_object_refs change
          WHERE change.knowledge_base_id = ${input.knowledgeBaseId}
            AND change.generation_id = ${input.generationId}
            AND change.ref_kind = ${input.refKind}
            AND change.ref_key = ${input.refKey}
        )
        SELECT staged.knowledge_base_id, staged.ref_kind, staged.ref_key,
               staged.file_id, staged.last_changed_generation_id,
               staged.checksum_sha256, staged.format_version,
               staged.logical_path, staged.source_file_id,
               staged.projection_shard_id, object.object_key,
               object.content_type, object.size_bytes
        FROM staged
        JOIN focowiki.immutable_objects object
          ON object.checksum_sha256 = staged.checksum_sha256
         AND object.format_version = staged.format_version
        WHERE staged.action = 'upsert'

        UNION ALL

        SELECT ${sql.unsafe(ACTIVE_REFERENCE_COLUMNS)}
        FROM focowiki.active_object_refs active
        JOIN focowiki.immutable_objects object
          ON object.checksum_sha256 = active.checksum_sha256
         AND object.format_version = active.format_version
        WHERE active.knowledge_base_id = ${input.knowledgeBaseId}
          AND active.ref_kind = ${input.refKind}
          AND active.ref_key = ${input.refKey}
          AND NOT EXISTS (SELECT 1 FROM staged)
        LIMIT 1
      `;
      return rows[0] ? mapActiveReference(rows[0]) : null;
    }
  };
}

function mapActiveReference(row: ActiveReferenceRow): ActiveObjectReference {
  return {
    knowledgeBaseId: row.knowledge_base_id,
    refKind: row.ref_kind,
    refKey: row.ref_key,
    fileId: row.file_id,
    lastChangedGenerationId: row.last_changed_generation_id,
    checksumSha256: row.checksum_sha256,
    formatVersion: row.format_version,
    logicalPath: row.logical_path,
    sourceFileId: row.source_file_id,
    projectionShardId: row.projection_shard_id,
    objectKey: row.object_key,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes)
  };
}
