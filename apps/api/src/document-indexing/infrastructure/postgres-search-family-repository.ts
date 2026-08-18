import { createHash } from "node:crypto";
import type { SearchProviderKind } from
  "../../application/ports/search-provider-runtime.js";
import type { DatabaseClient } from "../../db/client.js";
import {
  assertRepositoryIdentity,
  assertRepositorySha256,
  assertRepositoryTimestamp,
  repositoryContractError,
  uniqueBoundedStrings
} from "./document-repository-validation.js";

export const DOCUMENT_SEARCH_FAMILIES = [
  "content_metadata",
  "content_segments_vectors",
  "semantic_seed_vectors",
  "relation_evidence",
  "graph_seed"
] as const;
export type DocumentSearchFamily = (typeof DOCUMENT_SEARCH_FAMILIES)[number];

export function createPostgresSearchFamilyRepository(sql: DatabaseClient) {
  return {
    async recordAcknowledged(input: {
      knowledgeBaseId: string;
      sourceFilePublicId: string;
      sourceRevisionPublicId: string;
      providerKind: SearchProviderKind;
      family: DocumentSearchFamily;
      inputFingerprintSha256: string;
      providerDocumentIds: readonly string[];
      acknowledgedAt: string;
    }): Promise<string> {
      if (!DOCUMENT_SEARCH_FAMILIES.includes(input.family)) {
        throw repositoryContractError("invalid_search_family");
      }
      const ids = uniqueBoundedStrings(
        input.providerDocumentIds,
        "provider_document_ids",
        20_000,
        512
      ).sort((left, right) => left.localeCompare(right, "en"));
      const knowledgeBaseId = assertRepositoryIdentity(
        input.knowledgeBaseId,
        "knowledge_base_id"
      );
      const sourceRevisionPublicId = assertRepositoryIdentity(
        input.sourceRevisionPublicId,
        "source_revision_public_id"
      );
      const fingerprint = assertRepositorySha256(
        input.inputFingerprintSha256,
        "input_fingerprint"
      );
      const publicId = `search-family-${createHash("sha256")
        .update(JSON.stringify([
          knowledgeBaseId,
          sourceRevisionPublicId,
          input.providerKind,
          input.family,
          fingerprint
        ]))
        .digest("hex")}`;
      const rows = await sql<Array<{ public_id: string }>>`
        INSERT INTO focowiki.search_family_receipts (
          public_id, knowledge_base_id, source_file_public_id,
          source_revision_public_id, provider_kind, family,
          input_fingerprint_sha256, provider_document_ids,
          state, acknowledged_at
        ) VALUES (
          ${publicId}, ${knowledgeBaseId},
          ${assertRepositoryIdentity(input.sourceFilePublicId, "source_file_public_id")},
          ${sourceRevisionPublicId}, ${input.providerKind}, ${input.family},
          ${fingerprint}, ${ids}, 'acknowledged',
          ${assertRepositoryTimestamp(input.acknowledgedAt, "acknowledged_at")}
        )
        ON CONFLICT (
          knowledge_base_id, source_revision_public_id,
          provider_kind, family, input_fingerprint_sha256
        ) DO UPDATE SET
          provider_document_ids = excluded.provider_document_ids,
          state = 'acknowledged', acknowledged_at = excluded.acknowledged_at
        WHERE search_family_receipts.provider_document_ids
          = excluded.provider_document_ids
        RETURNING public_id
      `;
      if (!rows[0]) throw repositoryContractError("search_family_identity_conflict");
      return rows[0].public_id;
    },

    async activateRevision(input: {
      transaction: DatabaseClient;
      knowledgeBaseId: string;
      sourceFilePublicId: string;
      sourceRevisionPublicId: string;
    }): Promise<number> {
      const transaction = input.transaction;
      await transaction`
        UPDATE focowiki.search_family_receipts
        SET active = false
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_file_public_id = ${input.sourceFilePublicId}
          AND source_revision_public_id <> ${input.sourceRevisionPublicId}
          AND active
      `;
      const rows = await transaction<Array<{ public_id: string }>>`
        UPDATE focowiki.search_family_receipts
        SET active = true
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_file_public_id = ${input.sourceFilePublicId}
          AND source_revision_public_id = ${input.sourceRevisionPublicId}
          AND state = 'acknowledged'
        RETURNING public_id
      `;
      return rows.length;
    },

    async listAcknowledged(input: {
      knowledgeBaseId: string;
      sourceRevisionPublicId: string;
    }): Promise<readonly {
      publicId: string;
      family: DocumentSearchFamily;
      providerDocumentIds: readonly string[];
    }[]> {
      const rows = await sql<Array<{
        public_id: string;
        family: DocumentSearchFamily;
        provider_document_ids: string[];
      }>>`
        SELECT public_id, family, provider_document_ids
        FROM focowiki.search_family_receipts
        WHERE knowledge_base_id = ${assertRepositoryIdentity(input.knowledgeBaseId, "knowledge_base_id")}
          AND source_revision_public_id = ${assertRepositoryIdentity(input.sourceRevisionPublicId, "source_revision_public_id")}
          AND state = 'acknowledged'
        ORDER BY family, public_id
      `;
      return rows.map((row) => ({
        publicId: row.public_id,
        family: row.family,
        providerDocumentIds: [...row.provider_document_ids]
      }));
    }
  };
}
