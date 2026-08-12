import type { DatabaseClient } from "../../db/client.js";
import type {
  SemanticDeletionRepositoryPort
} from "../application/deletion-service.js";
import { enqueueUnavailableSemanticVectorDocumentCleanupActions } from
  "./postgres-vector-document-cleanup-actions.js";

type VectorRow = {
  semantic_generation_public_id: string;
  mapping_fingerprint_sha256: string;
  search_provider_kind: "meilisearch" | "opensearch";
  provider_document_id: string;
};

export function createPostgresSemanticDeletionRepository(
  sql: DatabaseClient
): SemanticDeletionRepositoryPort {
  return {
    async cancelSourceWork(input) {
      assertSourceBatch(input.sourceFilePublicIds);
      assertTimestamp(input.requestedAt);
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.semantic_stage_work_items
        SET cancellation_requested_at = ${input.requestedAt},
            state = CASE WHEN state IN ('queued', 'retry')
              THEN 'cancelled' ELSE state END,
            completed_at = CASE WHEN state IN ('queued', 'retry')
              THEN ${input.requestedAt} ELSE completed_at END,
            revision = revision + 1, updated_at = ${input.requestedAt}
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_file_public_id = ANY(${input.sourceFilePublicIds})
          AND state IN ('queued', 'running', 'retry')
          AND cancellation_requested_at IS NULL
        RETURNING public_id
      `;
      return rows.length;
    },

    async hasRunningSourceWork(input) {
      assertSourceBatch(input.sourceFilePublicIds);
      const rows = await sql<Array<{ present: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM focowiki.semantic_stage_work_items
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND (
              source_file_public_id = ANY(${input.sourceFilePublicIds})
              OR source_file_public_id IS NULL
            )
            AND state = 'running'
        ) AS present
      `;
      return rows[0]?.present === true;
    },

    async hasRunningKnowledgeBaseWork(input) {
      const rows = await sql<Array<{ present: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM focowiki.semantic_stage_work_items
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND state = 'running'
        ) AS present
      `;
      return rows[0]?.present === true;
    },

    async deferUnavailableSourceVectors(input) {
      assertSourceBatch(input.sourceFilePublicIds);
      assertTimestamp(input.notBefore);
      return enqueueUnavailableSemanticVectorDocumentCleanupActions(sql, input);
    },

    async listSourceVectorPage(input) {
      assertSourceBatch(input.sourceFilePublicIds);
      const limit = assertLimit(input.limit);
      const cursor = decodeVectorCursor(input.cursor);
      const rows = await sql<VectorRow[]>`
        SELECT vector.semantic_generation_public_id,
               contract.mapping_fingerprint_sha256,
               contract.search_provider_kind,
               vector.provider_document_id
        FROM focowiki.semantic_vector_documents vector
        JOIN focowiki.semantic_projection_contracts contract
          ON contract.knowledge_base_id = vector.knowledge_base_id
         AND contract.semantic_generation_public_id
           = vector.semantic_generation_public_id
         AND contract.public_id = vector.projection_contract_public_id
        JOIN focowiki.semantic_generations generation
          ON generation.knowledge_base_id = vector.knowledge_base_id
         AND generation.public_id = vector.semantic_generation_public_id
         AND generation.deleted_at IS NULL
        WHERE vector.knowledge_base_id = ${input.knowledgeBaseId}
          AND contract.search_provider_kind = ${input.selectedProviderKind}
          AND (
            vector.source_file_public_id = ANY(${input.sourceFilePublicIds})
            OR (
              vector.vector_family = 'community'
              AND EXISTS (
                SELECT 1
                FROM focowiki.semantic_community_memberships membership
                JOIN focowiki.semantic_entity_observations observation
                  ON observation.knowledge_base_id = membership.knowledge_base_id
                 AND observation.semantic_generation_public_id
                   = membership.semantic_generation_public_id
                 AND observation.entity_public_id = membership.entity_public_id
                WHERE membership.knowledge_base_id = vector.knowledge_base_id
                  AND membership.semantic_generation_public_id
                    = vector.semantic_generation_public_id
                  AND membership.community_public_id = vector.owner_public_id
                  AND observation.source_file_public_id
                    = ANY(${input.sourceFilePublicIds})
              )
            )
          )
          AND vector.deleted_at IS NULL
          AND (${cursor.generationPublicId}::text IS NULL
            OR ROW(
              vector.semantic_generation_public_id COLLATE "C",
              vector.provider_document_id COLLATE "C"
            ) > ROW(
              ${cursor.generationPublicId}::text COLLATE "C",
              ${cursor.documentPublicId}::text COLLATE "C"
            ))
        ORDER BY vector.semantic_generation_public_id COLLATE "C",
                 vector.provider_document_id COLLATE "C"
        LIMIT ${limit + 1}
      `;
      const selected = rows.slice(0, limit);
      const groups = new Map<string, {
        semanticGenerationPublicId: string;
        mappingFingerprintSha256: string;
        searchProviderKind: "meilisearch" | "opensearch";
        documentIds: string[];
      }>();
      for (const row of selected) {
        const key = [
          row.semantic_generation_public_id,
          row.mapping_fingerprint_sha256,
          row.search_provider_kind
        ].join("\u001f");
        const group = groups.get(key) ?? {
          semanticGenerationPublicId: row.semantic_generation_public_id,
          mappingFingerprintSha256: row.mapping_fingerprint_sha256,
          searchProviderKind: row.search_provider_kind,
          documentIds: []
        };
        group.documentIds.push(row.provider_document_id);
        groups.set(key, group);
      }
      const last = selected.at(-1);
      return {
        items: [...groups.values()],
        nextCursor: rows.length > limit && last
          ? encodeVectorCursor(
              last.semantic_generation_public_id,
              last.provider_document_id
            )
          : null
      };
    },

    async listKnowledgeBaseGenerationPage(input) {
      const limit = assertLimit(input.limit);
      const [rows, remainingRows] = await Promise.all([sql<Array<{
        semantic_generation_public_id: string;
        mapping_fingerprint_sha256: string;
        search_provider_kind: "meilisearch" | "opensearch";
      }>>`
        SELECT contract.semantic_generation_public_id,
               contract.mapping_fingerprint_sha256,
               contract.search_provider_kind
        FROM focowiki.semantic_projection_contracts contract
        JOIN focowiki.semantic_generations generation
          ON generation.knowledge_base_id = contract.knowledge_base_id
         AND generation.public_id = contract.semantic_generation_public_id
        WHERE contract.knowledge_base_id = ${input.knowledgeBaseId}
          AND contract.search_provider_kind = ${input.selectedProviderKind}
          AND (${input.cursor}::text IS NULL
            OR contract.semantic_generation_public_id COLLATE "C"
              > ${input.cursor}::text COLLATE "C")
        ORDER BY contract.semantic_generation_public_id COLLATE "C"
        LIMIT ${limit + 1}
      `, sql<Array<{
        search_provider_kind: "meilisearch" | "opensearch";
      }>>`
        SELECT DISTINCT contract.search_provider_kind
        FROM focowiki.semantic_projection_contracts contract
        WHERE contract.knowledge_base_id = ${input.knowledgeBaseId}
          AND contract.search_provider_kind <> ${input.selectedProviderKind}
        ORDER BY contract.search_provider_kind
        LIMIT 1
      `]);
      const selected = rows.slice(0, limit);
      return {
        items: selected.map((row) => ({
          semanticGenerationPublicId: row.semantic_generation_public_id,
          mappingFingerprintSha256: row.mapping_fingerprint_sha256,
          searchProviderKind: row.search_provider_kind
        })),
        nextCursor: rows.length > limit
          ? selected.at(-1)?.semantic_generation_public_id ?? null
          : null,
        remainingProviderKind: remainingRows[0]?.search_provider_kind ?? null
      };
    },

    async purgeSourceState(input) {
      assertSourceBatch(input.sourceFilePublicIds);
      assertTimestamp(input.deletedAt);
      await sql.begin(async (transaction) => {
        await transaction`
          UPDATE focowiki.semantic_stage_work_items
          SET cancellation_requested_at = COALESCE(
                cancellation_requested_at, ${input.deletedAt}
              ),
              state = CASE WHEN state IN ('queued', 'retry')
                THEN 'cancelled' ELSE state END,
              completed_at = CASE WHEN state IN ('queued', 'retry')
                THEN ${input.deletedAt} ELSE completed_at END,
              revision = revision + 1, updated_at = ${input.deletedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND source_file_public_id = ANY(${input.sourceFilePublicIds})
            AND state IN ('queued', 'running', 'retry')
        `;
        await transaction`
          UPDATE focowiki.semantic_dirty_partitions partition
          SET state = 'superseded', lease_owner = NULL,
              lease_expires_at = NULL,
              safe_error_code = 'semantic_partition_superseded',
              revision = partition.revision + 1,
              updated_at = ${input.deletedAt}
          WHERE partition.knowledge_base_id = ${input.knowledgeBaseId}
            AND partition.state IN ('dirty', 'processing', 'failed')
            AND EXISTS (
              SELECT 1
              FROM focowiki.semantic_entity_partitions assignment
              JOIN focowiki.semantic_entity_observations observation
                ON observation.knowledge_base_id = assignment.knowledge_base_id
               AND observation.semantic_generation_public_id
                 = assignment.semantic_generation_public_id
               AND observation.entity_public_id = assignment.entity_public_id
              WHERE assignment.knowledge_base_id = partition.knowledge_base_id
                AND assignment.semantic_generation_public_id
                  = partition.semantic_generation_public_id
                AND assignment.partition_key = partition.partition_key
                AND observation.source_file_public_id
                  = ANY(${input.sourceFilePublicIds})
            )
        `;
        const artifacts = await transaction<Array<{ artifact_public_id: string }>>`
          DELETE FROM focowiki.semantic_embedding_artifact_refs
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND (
              source_file_public_id = ANY(${input.sourceFilePublicIds})
              OR (
                semantic_owner_kind = 'community'
                AND EXISTS (
                  SELECT 1
                  FROM focowiki.semantic_community_memberships membership
                  JOIN focowiki.semantic_entity_observations observation
                    ON observation.knowledge_base_id
                      = membership.knowledge_base_id
                   AND observation.semantic_generation_public_id
                     = membership.semantic_generation_public_id
                   AND observation.entity_public_id = membership.entity_public_id
                  WHERE membership.knowledge_base_id
                    = semantic_embedding_artifact_refs.knowledge_base_id
                    AND membership.semantic_generation_public_id
                      = semantic_embedding_artifact_refs.semantic_generation_public_id
                    AND membership.community_public_id
                      = semantic_embedding_artifact_refs.semantic_owner_public_id
                    AND observation.source_file_public_id
                      = ANY(${input.sourceFilePublicIds})
                )
              )
            )
          RETURNING artifact_public_id
        `;
        const artifactIds = [...new Set(artifacts.map((row) => row.artifact_public_id))];
        await transaction`
          DELETE FROM focowiki.semantic_vector_documents
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND (
              source_file_public_id = ANY(${input.sourceFilePublicIds})
              OR (
                vector_family = 'community'
                AND EXISTS (
                  SELECT 1
                  FROM focowiki.semantic_community_memberships membership
                  JOIN focowiki.semantic_entity_observations observation
                    ON observation.knowledge_base_id
                      = membership.knowledge_base_id
                   AND observation.semantic_generation_public_id
                     = membership.semantic_generation_public_id
                   AND observation.entity_public_id = membership.entity_public_id
                  WHERE membership.knowledge_base_id
                    = semantic_vector_documents.knowledge_base_id
                    AND membership.semantic_generation_public_id
                      = semantic_vector_documents.semantic_generation_public_id
                    AND membership.community_public_id
                      = semantic_vector_documents.owner_public_id
                    AND observation.source_file_public_id
                      = ANY(${input.sourceFilePublicIds})
                )
              )
            )
        `;
        await transaction`
          DELETE FROM focowiki.semantic_communities community
          WHERE community.knowledge_base_id = ${input.knowledgeBaseId}
            AND EXISTS (
              SELECT 1
              FROM focowiki.semantic_community_memberships membership
              JOIN focowiki.semantic_entity_observations observation
                ON observation.knowledge_base_id = membership.knowledge_base_id
               AND observation.semantic_generation_public_id
                 = membership.semantic_generation_public_id
               AND observation.entity_public_id = membership.entity_public_id
              WHERE membership.knowledge_base_id = community.knowledge_base_id
                AND membership.semantic_generation_public_id
                  = community.semantic_generation_public_id
                AND membership.community_public_id = community.public_id
                AND observation.source_file_public_id
                  = ANY(${input.sourceFilePublicIds})
            )
        `;
        await transaction`
          DELETE FROM focowiki.semantic_reverse_references
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND source_file_public_id = ANY(${input.sourceFilePublicIds})
        `;
        await transaction`
          DELETE FROM focowiki.semantic_relationship_observations
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND source_file_public_id = ANY(${input.sourceFilePublicIds})
        `;
        await transaction`
          DELETE FROM focowiki.semantic_entity_observations
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND source_file_public_id = ANY(${input.sourceFilePublicIds})
        `;
        await transaction`
          DELETE FROM focowiki.semantic_evidence
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND source_file_public_id = ANY(${input.sourceFilePublicIds})
        `;
        await transaction`
          UPDATE focowiki.semantic_relationships relationship
          SET deleted_at = COALESCE(relationship.deleted_at, ${input.deletedAt}),
              revision = relationship.revision + 1
          WHERE relationship.knowledge_base_id = ${input.knowledgeBaseId}
            AND relationship.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM focowiki.semantic_relationship_observations observation
              WHERE observation.semantic_generation_public_id
                = relationship.semantic_generation_public_id
                AND observation.relationship_public_id = relationship.public_id
            )
        `;
        await transaction`
          UPDATE focowiki.semantic_entities entity
          SET deleted_at = COALESCE(entity.deleted_at, ${input.deletedAt}),
              revision = entity.revision + 1
          WHERE entity.knowledge_base_id = ${input.knowledgeBaseId}
            AND entity.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM focowiki.semantic_entity_observations observation
              WHERE observation.semantic_generation_public_id
                = entity.semantic_generation_public_id
                AND observation.entity_public_id = entity.public_id
            )
        `;
        await transaction`
          DELETE FROM focowiki.semantic_community_memberships membership
          USING focowiki.semantic_entities entity
          WHERE membership.knowledge_base_id = ${input.knowledgeBaseId}
            AND entity.knowledge_base_id = membership.knowledge_base_id
            AND entity.semantic_generation_public_id
              = membership.semantic_generation_public_id
            AND entity.public_id = membership.entity_public_id
            AND entity.deleted_at IS NOT NULL
        `;
        await transaction`
          UPDATE focowiki.semantic_communities community
          SET deleted_at = COALESCE(community.deleted_at, ${input.deletedAt}),
              revision = community.revision + 1
          WHERE community.knowledge_base_id = ${input.knowledgeBaseId}
            AND community.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM focowiki.semantic_community_memberships membership
              WHERE membership.semantic_generation_public_id
                = community.semantic_generation_public_id
                AND membership.community_public_id = community.public_id
            )
        `;
        await transaction`
          DELETE FROM focowiki.semantic_source_reconciliations
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND source_file_public_id = ANY(${input.sourceFilePublicIds})
        `;
        if (artifactIds.length > 0) {
          await transaction`
            DELETE FROM focowiki.embedding_artifact_owners owner
            WHERE owner.knowledge_base_id = ${input.knowledgeBaseId}
              AND owner.artifact_public_id = ANY(${artifactIds})
              AND NOT EXISTS (
                SELECT 1 FROM focowiki.semantic_embedding_artifact_refs reference
                WHERE reference.semantic_generation_public_id
                  = owner.semantic_generation_public_id
                  AND reference.artifact_public_id = owner.artifact_public_id
              )
          `;
          await transaction`
            DELETE FROM focowiki.object_owners owner
            WHERE owner.embedding_artifact_public_id = ANY(${artifactIds})
              AND NOT EXISTS (
                SELECT 1 FROM focowiki.embedding_artifact_owners artifact_owner
                WHERE artifact_owner.artifact_public_id
                  = owner.embedding_artifact_public_id
              )
          `;
          await transaction`
            UPDATE focowiki.embedding_artifacts artifact
            SET state = 'orphaned', deleted_at = COALESCE(
                  artifact.deleted_at, ${input.deletedAt}
                )
            WHERE artifact.knowledge_base_id = ${input.knowledgeBaseId}
              AND artifact.public_id = ANY(${artifactIds})
              AND NOT EXISTS (
                SELECT 1 FROM focowiki.embedding_artifact_owners owner
                WHERE owner.artifact_public_id = artifact.public_id
              )
          `;
          await transaction`
            UPDATE focowiki.object_registrations object
            SET zero_owner_since = COALESCE(
              object.zero_owner_since, ${input.deletedAt}
            )
            WHERE object.object_id IN (
              SELECT artifact.object_id
              FROM focowiki.embedding_artifacts artifact
              WHERE artifact.public_id = ANY(${artifactIds})
            )
              AND NOT EXISTS (
                SELECT 1 FROM focowiki.object_owners owner
                WHERE owner.object_id = object.object_id
              )
          `;
        }
      });
    },

    async cancelKnowledgeBaseWork(input) {
      assertTimestamp(input.requestedAt);
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.semantic_stage_work_items
        SET cancellation_requested_at = COALESCE(
              cancellation_requested_at, ${input.requestedAt}
            ),
            state = CASE WHEN state IN ('queued', 'retry')
              THEN 'cancelled' ELSE state END,
            completed_at = CASE WHEN state IN ('queued', 'retry')
              THEN ${input.requestedAt} ELSE completed_at END,
            revision = revision + 1, updated_at = ${input.requestedAt}
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND state IN ('queued', 'running', 'retry')
          AND cancellation_requested_at IS NULL
        RETURNING public_id
      `;
      return rows.length;
    }
  };
}

function encodeVectorCursor(generationPublicId: string, documentPublicId: string): string {
  return Buffer.from(JSON.stringify({ generationPublicId, documentPublicId }))
    .toString("base64url");
}

function decodeVectorCursor(value: string | null): {
  generationPublicId: string | null;
  documentPublicId: string | null;
} {
  if (value === null) return { generationPublicId: null, documentPublicId: null };
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed.generationPublicId !== "string"
      || typeof parsed.documentPublicId !== "string"
      || !parsed.generationPublicId || !parsed.documentPublicId) throw new Error();
    return parsed;
  } catch {
    throw repositoryError("semantic_deletion_cursor_invalid");
  }
}

function assertSourceBatch(values: readonly string[]): void {
  if (values.length < 1 || values.length > 1_000
    || values.some((value) => !value || Buffer.byteLength(value) > 255)) {
    throw repositoryError("semantic_deletion_source_batch_invalid");
  }
}

function assertLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw repositoryError("semantic_deletion_limit_invalid");
  }
  return value;
}

function assertTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw repositoryError("semantic_deletion_timestamp_invalid");
  }
}

function repositoryError(code: string): Error & { code: string; retryable: false } {
  return Object.assign(new Error(`Semantic deletion repository failed: ${code}`), {
    code,
    retryable: false as const
  });
}
