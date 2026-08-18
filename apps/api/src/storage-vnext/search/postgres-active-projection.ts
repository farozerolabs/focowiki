import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import type { SearchProviderKind } from
  "../../application/ports/search-provider-runtime.js";
import type {
  StorageVnextActiveSearchProjection,
  StorageVnextActiveSearchProjectionRepository
} from "./active-projection-repository.js";

type ActiveProjectionRow = {
  public_id: string;
  knowledge_base_id: string;
  provider_kind: SearchProviderKind;
  provider_index_uid: string;
  schema_checksum_sha256: string;
  settings_checksum_sha256: string;
  active_contract_revision: number | string;
  document_count: number | string;
};

export function createPostgresStorageVnextActiveSearchProjectionRepository(
  sql: DatabaseClient
): StorageVnextActiveSearchProjectionRepository {
  return {
    async getActiveProjection(knowledgeBaseId) {
      assertId(knowledgeBaseId);
      const rows = await sql<ActiveProjectionRow[]>`
        SELECT public_id, knowledge_base_id, provider_kind,
               provider_index_uid, schema_checksum_sha256,
               settings_checksum_sha256, active_contract_revision,
               document_count
        FROM focowiki.search_projections
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND state = 'active'
        ORDER BY provider_kind COLLATE "C"
        LIMIT 2
      `;
      if (rows.length > 1) {
        throw new Error("Multiple active search providers are configured");
      }
      return rows[0] ? mapProjection(rows[0]) : null;
    }
  };
}

function mapProjection(row: ActiveProjectionRow): StorageVnextActiveSearchProjection {
  const activeContractRevision = toSafeNumber(row.active_contract_revision);
  return {
    publicId: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    providerKind: row.provider_kind,
    providerIndexUid: row.provider_index_uid,
    schemaChecksum: row.schema_checksum_sha256,
    settingsChecksum: row.settings_checksum_sha256,
    activeContractRevision,
    documentChecksum: createHash("sha256").update(JSON.stringify([
      row.schema_checksum_sha256,
      row.settings_checksum_sha256,
      activeContractRevision
    ])).digest("hex"),
    documentCount: toSafeNumber(row.document_count)
  };
}

function assertId(value: string): void {
  if (!value || Buffer.byteLength(value) > 255) {
    throw new Error("Storage vNext active search projection input is invalid");
  }
}

function toSafeNumber(value: number | string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("Storage vNext active search projection is invalid");
  }
  return result;
}
