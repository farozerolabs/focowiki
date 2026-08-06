import type { DatabaseClient } from "../../db/client.js";
import type {
  StorageVnextActiveSearchProjection,
  StorageVnextActiveSearchProjectionRepository
} from "./active-projection-repository.js";

type ActiveProjectionRow = {
  public_id: string;
  knowledge_base_id: string;
  provider_index_uid: string;
  schema_checksum_sha256: string;
  settings_checksum_sha256: string;
  document_checksum_sha256: string;
  document_count: number | string;
};

export function createPostgresStorageVnextActiveSearchProjectionRepository(
  sql: DatabaseClient
): StorageVnextActiveSearchProjectionRepository {
  return {
    async getActiveProjection(knowledgeBaseId) {
      assertId(knowledgeBaseId);
      const rows = await sql<ActiveProjectionRow[]>`
        SELECT projection.public_id, projection.knowledge_base_id,
               projection.provider_index_uid,
               projection.schema_checksum_sha256,
               projection.settings_checksum_sha256,
               projection.document_checksum_sha256,
               projection.document_count
        FROM focowiki.active_snapshots AS snapshot
        JOIN focowiki.search_projections AS projection
          ON projection.knowledge_base_id = snapshot.knowledge_base_id
         AND projection.public_id = snapshot.search_projection_public_id
        WHERE snapshot.knowledge_base_id = ${knowledgeBaseId}
          AND projection.projection_role = 'active'
          AND projection.state = 'ready'
        LIMIT 1
      `;
      return rows[0] ? mapProjection(rows[0]) : null;
    }
  };
}

function mapProjection(row: ActiveProjectionRow): StorageVnextActiveSearchProjection {
  return {
    publicId: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    providerIndexUid: row.provider_index_uid,
    schemaChecksum: row.schema_checksum_sha256,
    settingsChecksum: row.settings_checksum_sha256,
    documentChecksum: row.document_checksum_sha256,
    documentCount: toSafeNumber(row.document_count)
  };
}

function assertId(value: string) {
  if (!value || Buffer.byteLength(value) > 255) {
    throw new Error("Storage vNext active search projection input is invalid");
  }
}

function toSafeNumber(value: number | string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("Storage vNext active search projection is invalid");
  }
  return result;
}
