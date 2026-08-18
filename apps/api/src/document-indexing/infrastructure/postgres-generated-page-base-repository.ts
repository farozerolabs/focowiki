import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import {
  assertRepositoryIdentity,
  assertRepositorySha256,
  repositoryContractError,
  uniqueBoundedStrings
} from "./document-repository-validation.js";

const MAXIMUM_VISIBLE_SOURCE_IDENTITIES = 10_000;

export type GeneratedPageBase = {
  publicId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  inputFingerprintSha256: string;
  object: {
    objectId: string;
    storageKey: string;
    checksumSha256: string;
    byteCount: number;
    contentType: "application/json; charset=utf-8";
    objectFormat: "okf-generated-json-v1";
  };
};

type BaseRow = {
  public_id: string;
  source_file_public_id: string;
  source_revision_public_id: string;
  input_fingerprint_sha256: string;
  object_id: string;
  storage_key: string;
  checksum_sha256: string;
  byte_count: number | string;
  content_type: string;
  object_format: string;
};

export function createPostgresGeneratedPageBaseRepository(sql: DatabaseClient) {
  return {
    async store(input: {
      knowledgeBaseId: string;
      sourceFilePublicId: string;
      sourceRevisionPublicId: string;
      inputFingerprintSha256: string;
      objectId: string;
      checksumSha256: string;
    }): Promise<string> {
      const identity = createHash("sha256").update(JSON.stringify([
        input.knowledgeBaseId,
        input.sourceRevisionPublicId,
        input.inputFingerprintSha256
      ])).digest("hex");
      const rows = await sql<Array<{ public_id: string }>>`
        INSERT INTO focowiki.generated_page_bases (
          public_id, knowledge_base_id, source_file_public_id,
          source_revision_public_id, input_fingerprint_sha256,
          object_id, checksum_sha256
        ) VALUES (
          ${`generated-page-base-${identity}`},
          ${assertRepositoryIdentity(input.knowledgeBaseId, "knowledge_base_id")},
          ${assertRepositoryIdentity(input.sourceFilePublicId, "source_file_public_id")},
          ${assertRepositoryIdentity(input.sourceRevisionPublicId, "source_revision_public_id")},
          ${assertRepositorySha256(input.inputFingerprintSha256, "input_fingerprint")},
          ${assertRepositoryIdentity(input.objectId, "object_id")},
          ${assertRepositorySha256(input.checksumSha256, "checksum")}
        )
        ON CONFLICT (
          knowledge_base_id, source_revision_public_id, input_fingerprint_sha256
        ) DO NOTHING
        RETURNING public_id
      `;
      const stored = rows[0] ?? (await sql<Array<{ public_id: string }>>`
        SELECT public_id FROM focowiki.generated_page_bases
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_revision_public_id = ${input.sourceRevisionPublicId}
          AND input_fingerprint_sha256 = ${input.inputFingerprintSha256}
          AND object_id = ${input.objectId}
          AND checksum_sha256 = ${input.checksumSha256}
      `)[0];
      if (!stored) throw repositoryContractError("generated_page_base_conflict");
      return stored.public_id;
    },

    async listForSources(input: {
      knowledgeBaseId: string;
      sourceFilePublicIds: readonly string[];
      includeSourceRevisionPublicId: string;
      limit: number;
    }): Promise<readonly GeneratedPageBase[]> {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1
        || input.limit > 10_000) {
        throw repositoryContractError("invalid_limit");
      }
      const ids = uniqueBoundedStrings(
        input.sourceFilePublicIds,
        "source_file_public_ids",
        input.limit,
        255
      );
      if (ids.length === 0) return [];
      const rows = await sql<BaseRow[]>`
        SELECT DISTINCT ON (base.source_file_public_id)
               base.public_id, base.source_file_public_id,
               base.source_revision_public_id, base.input_fingerprint_sha256,
               registration.object_id, registration.storage_key,
               registration.checksum_sha256, registration.byte_count,
               registration.content_type, registration.object_format
        FROM focowiki.generated_page_bases base
        JOIN focowiki.object_registrations registration
          ON registration.object_id = base.object_id
         AND registration.state = 'verified'
        JOIN focowiki.source_file_active_revisions active
          ON active.knowledge_base_id = base.knowledge_base_id
         AND active.source_file_public_id = base.source_file_public_id
        WHERE base.knowledge_base_id = ${assertRepositoryIdentity(input.knowledgeBaseId, "knowledge_base_id")}
          AND base.source_file_public_id IN ${sql(ids)}
          AND (base.source_revision_public_id
                = active.active_source_revision_public_id
            OR base.source_revision_public_id
                = ${assertRepositoryIdentity(input.includeSourceRevisionPublicId, "source_revision_public_id")})
        ORDER BY base.source_file_public_id,
                 (base.source_revision_public_id
                   = ${input.includeSourceRevisionPublicId}) DESC,
                 base.created_at DESC, base.public_id
        LIMIT ${input.limit}
      `;
      return rows.map(mapBase);
    },

    async listVisibleForSources(input: {
      knowledgeBaseId: string;
      sourceFilePublicIds: readonly string[];
      includedSourceRevisionPublicIds: readonly string[];
      excludedActiveSourceFilePublicIds: readonly string[];
      preferredCurrentSourceFilePublicIds?: readonly string[];
      limit: number;
    }): Promise<readonly GeneratedPageBase[]> {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1
        || input.limit > 10_000) {
        throw repositoryContractError("invalid_limit");
      }
      const ids = uniqueBoundedStrings(
        input.sourceFilePublicIds,
        "source_file_public_ids",
        MAXIMUM_VISIBLE_SOURCE_IDENTITIES,
        255
      );
      const included = uniqueBoundedStrings(
        input.includedSourceRevisionPublicIds,
        "included_source_revision_public_ids",
        MAXIMUM_VISIBLE_SOURCE_IDENTITIES,
        255
      );
      const excluded = uniqueBoundedStrings(
        input.excludedActiveSourceFilePublicIds,
        "excluded_active_source_file_public_ids",
        MAXIMUM_VISIBLE_SOURCE_IDENTITIES,
        255
      );
      const preferredCurrent = uniqueBoundedStrings(
        input.preferredCurrentSourceFilePublicIds ?? [],
        "preferred_current_source_file_public_ids",
        MAXIMUM_VISIBLE_SOURCE_IDENTITIES,
        255
      );
      if (ids.length === 0) return [];
      const rows = await sql<BaseRow[]>`
        SELECT DISTINCT ON (base.source_file_public_id)
               base.public_id, base.source_file_public_id,
               base.source_revision_public_id, base.input_fingerprint_sha256,
               registration.object_id, registration.storage_key,
               registration.checksum_sha256, registration.byte_count,
               registration.content_type, registration.object_format
        FROM focowiki.generated_page_bases base
        JOIN focowiki.object_registrations registration
          ON registration.object_id = base.object_id
         AND registration.state = 'verified'
        LEFT JOIN focowiki.source_file_active_revisions active
          ON active.knowledge_base_id = base.knowledge_base_id
         AND active.source_file_public_id = base.source_file_public_id
        WHERE base.knowledge_base_id = ${assertRepositoryIdentity(input.knowledgeBaseId, "knowledge_base_id")}
          AND base.source_file_public_id IN ${sql(ids)}
          AND (base.source_revision_public_id = ANY(${included}::text[])
            OR (base.source_file_public_id = ANY(${preferredCurrent}::text[])
              AND base.source_revision_public_id
                = active.current_source_revision_public_id)
            OR (base.source_revision_public_id
                  = active.active_source_revision_public_id
              AND base.source_file_public_id <> ALL(${excluded}::text[])))
        ORDER BY base.source_file_public_id,
                 (base.source_revision_public_id = ANY(${included}::text[])) DESC,
                 (base.source_file_public_id = ANY(${preferredCurrent}::text[])
                   AND base.source_revision_public_id
                     = active.current_source_revision_public_id) DESC,
                 base.created_at DESC, base.public_id
        LIMIT ${input.limit}
      `;
      return rows.map(mapBase);
    }
  };
}

function mapBase(row: BaseRow): GeneratedPageBase {
  const byteCount = Number(row.byte_count);
  if (!Number.isSafeInteger(byteCount) || byteCount < 1
    || row.content_type !== "application/json; charset=utf-8"
    || row.object_format !== "okf-generated-json-v1") {
    throw repositoryContractError("generated_page_base_invalid");
  }
  return {
    publicId: row.public_id,
    sourceFilePublicId: row.source_file_public_id,
    sourceRevisionPublicId: row.source_revision_public_id,
    inputFingerprintSha256: row.input_fingerprint_sha256,
    object: {
      objectId: row.object_id,
      storageKey: row.storage_key,
      checksumSha256: row.checksum_sha256,
      byteCount,
      contentType: row.content_type,
      objectFormat: row.object_format
    } as GeneratedPageBase["object"]
  };
}
