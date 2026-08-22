import type { DatabaseClient } from "../../db/client.js";
import type { DocumentProjectionOwnershipRepository } from
  "../application/document-publication-repository-ports.js";
import { normalizeDocumentProjectionOwnedPath } from
  "../application/document-projection-path-ownership.js";
import {
  assertRepositoryIdentity,
  assertRepositoryTimestamp,
  repositoryContractError
} from "./document-repository-validation.js";

export function createPostgresProjectionPathOwnerRepository(
  sql: DatabaseClient
): DocumentProjectionOwnershipRepository {
  return {
    async transferArtifacts(input): Promise<number> {
      const records = uniqueRecords(input.owners.map((owner) => ({
        normalized_path: normalizeDocumentProjectionOwnedPath(
          owner.normalizedPath
        ),
        owner_scope_identity: scopeIdentity(owner.ownerScopeIdentity),
        artifact_family: owner.artifactFamily
      })), "normalized_path");
      return sql.begin(async (transaction) => {
        const rows = await transaction<Array<{ normalized_path: string }>>`
          INSERT INTO focowiki.projection_artifact_owners (
            knowledge_base_id, normalized_path, owner_scope_identity,
            artifact_family, ownership_epoch, generation_public_id, updated_at
          )
          SELECT ${assertRepositoryIdentity(
              input.knowledgeBaseId,
              "knowledge_base_id"
            )}, desired.normalized_path, desired.owner_scope_identity,
                 desired.artifact_family, ${input.ownershipEpoch},
                 ${input.generationId},
                 ${assertRepositoryTimestamp(input.updatedAt, "updated_at")}
          FROM jsonb_to_recordset(${transaction.json(records as never)}::jsonb)
            AS desired(
              normalized_path text,
              owner_scope_identity text,
              artifact_family text
            )
          ON CONFLICT (knowledge_base_id, normalized_path) DO UPDATE
          SET owner_scope_identity = excluded.owner_scope_identity,
              artifact_family = excluded.artifact_family,
              ownership_epoch = excluded.ownership_epoch,
              generation_public_id = excluded.generation_public_id,
              updated_at = excluded.updated_at
          WHERE projection_artifact_owners.ownership_epoch
                  < excluded.ownership_epoch
             OR (projection_artifact_owners.ownership_epoch
                    = excluded.ownership_epoch
               AND projection_artifact_owners.owner_scope_identity
                    = excluded.owner_scope_identity
               AND projection_artifact_owners.artifact_family
                    = excluded.artifact_family
               AND projection_artifact_owners.generation_public_id
                    = excluded.generation_public_id)
          RETURNING normalized_path
        `;
        assertAllTransferred(rows.length, records.length);
        return rows.length;
      }) as Promise<number>;
    },

    async transferDirectories(input): Promise<number> {
      const records = uniqueRecords(input.owners.map((owner) => ({
        directory_path: directoryPath(owner.directoryPath),
        owner_scope_identity: scopeIdentity(owner.ownerScopeIdentity)
      })), "directory_path");
      return sql.begin(async (transaction) => {
        const rows = await transaction<Array<{ directory_path: string }>>`
          INSERT INTO focowiki.projection_directory_owners (
            knowledge_base_id, directory_path, owner_scope_identity,
            ownership_epoch, generation_public_id, updated_at
          )
          SELECT ${assertRepositoryIdentity(
              input.knowledgeBaseId,
              "knowledge_base_id"
            )}, desired.directory_path, desired.owner_scope_identity,
                 ${input.ownershipEpoch}, ${input.generationId},
                 ${assertRepositoryTimestamp(input.updatedAt, "updated_at")}
          FROM jsonb_to_recordset(${transaction.json(records as never)}::jsonb)
            AS desired(directory_path text, owner_scope_identity text)
          ON CONFLICT (knowledge_base_id, directory_path) DO UPDATE
          SET owner_scope_identity = excluded.owner_scope_identity,
              ownership_epoch = excluded.ownership_epoch,
              generation_public_id = excluded.generation_public_id,
              updated_at = excluded.updated_at
          WHERE projection_directory_owners.ownership_epoch
                  < excluded.ownership_epoch
             OR (projection_directory_owners.ownership_epoch
                    = excluded.ownership_epoch
               AND projection_directory_owners.owner_scope_identity
                    = excluded.owner_scope_identity
               AND projection_directory_owners.generation_public_id
                    = excluded.generation_public_id)
          RETURNING directory_path
        `;
        assertAllTransferred(rows.length, records.length);
        return rows.length;
      }) as Promise<number>;
    }
  };
}

function uniqueRecords<T extends Record<string, string>>(
  records: readonly T[],
  key: keyof T
): readonly T[] {
  if (records.length < 1 || records.length > 256) {
    throw repositoryContractError("projection_owner_transfer_limit");
  }
  const unique = [...new Map(records.map((record) => [record[key], record]))
    .values()];
  if (unique.length !== records.length) {
    throw repositoryContractError("projection_owner_duplicate_path");
  }
  return unique;
}

function scopeIdentity(value: string): string {
  if (!value || Buffer.byteLength(value, "utf8") > 2048) {
    throw repositoryContractError("projection_owner_scope_invalid");
  }
  return value;
}

function directoryPath(value: string): string {
  const normalized = value.toLocaleLowerCase("en-US");
  if (normalized !== value || value.startsWith("/") || value.includes("..")
    || Buffer.byteLength(value, "utf8") > 4096) {
    throw repositoryContractError("projection_owner_directory_invalid");
  }
  return value;
}

function assertAllTransferred(actual: number, expected: number): void {
  if (actual !== expected) {
    throw repositoryContractError("projection_owner_epoch_stale");
  }
}
