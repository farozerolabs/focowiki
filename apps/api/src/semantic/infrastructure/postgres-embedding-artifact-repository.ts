import { createHash } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import type { EmbeddingArtifactIdentity } from "../domain/contracts.js";
import type {
  EmbeddingArtifactDescriptor,
  EmbeddingArtifactRecord,
  EmbeddingArtifactRepositoryPort,
  EmbeddingArtifactSourceReference
} from "../embedding/artifact-ports.js";
import { createOkfSearchSignals } from
  "../../storage-vnext/search/okf-signals.js";
import type { StorageVnextStructuredMetadata } from
  "../../storage-vnext/shared/types.js";

type ArtifactRow = {
  public_id: string;
  knowledge_base_id: string;
  object_id: string;
  storage_key: string;
  owner_kind: EmbeddingArtifactIdentity["ownerKind"];
  owner_public_id: string;
  source_revision_public_id: string | null;
  canonical_input_sha256: string;
  input_kind: EmbeddingArtifactIdentity["inputKind"];
  embedding_configuration_revision_public_id: string;
  normalization: EmbeddingArtifactIdentity["normalization"];
  dimension: number;
  artifact_schema_version: string;
  vector_checksum_sha256: string;
  byte_count: number | string;
  state: EmbeddingArtifactRecord["state"];
};

type ObjectRow = {
  object_id: string;
  storage_key: string;
  checksum_sha256: string;
  byte_count: number | string;
  content_type: string;
  object_format: string;
  state: "reserved" | "verified" | "deleting" | "deleted";
  write_attempt_public_id: string;
  reservation_expires_at: Date | string | null;
  zero_owner_since: Date | string | null;
};

type CommitVerifiedInput = Parameters<
  EmbeddingArtifactRepositoryPort["commitVerified"]
>[0];

const ARTIFACT_COLUMNS = `
  artifact.public_id, artifact.knowledge_base_id, artifact.object_id,
  object.storage_key, artifact.owner_kind, artifact.owner_public_id,
  artifact.source_revision_public_id, artifact.canonical_input_sha256,
  artifact.input_kind, artifact.embedding_configuration_revision_public_id,
  artifact.normalization, artifact.dimension, artifact.artifact_schema_version,
  artifact.vector_checksum_sha256, artifact.byte_count, artifact.state
`;

export function createPostgresEmbeddingArtifactRepository(
  sql: DatabaseClient
): EmbeddingArtifactRepositoryPort {
  return {
    async findCompatible(identity) {
      const rows = await sql<ArtifactRow[]>`
        SELECT ${sql.unsafe(ARTIFACT_COLUMNS)}
        FROM focowiki.embedding_artifacts artifact
        JOIN focowiki.object_registrations object
          ON object.object_id = artifact.object_id
         AND object.state = 'verified'
        WHERE artifact.knowledge_base_id = ${identity.knowledgeBaseId}
          AND artifact.owner_kind = ${identity.ownerKind}
          AND artifact.owner_public_id = ${identity.ownerPublicId}
          AND artifact.source_revision_public_id IS NOT DISTINCT FROM ${identity.sourceRevisionPublicId}
          AND artifact.canonical_input_sha256 = ${identity.canonicalInputSha256}
          AND artifact.input_kind = ${identity.inputKind}
          AND artifact.embedding_configuration_revision_public_id = ${identity.embeddingConfigurationRevisionPublicId}
          AND artifact.normalization = ${identity.normalization}
          AND artifact.dimension = ${identity.dimension}
          AND artifact.artifact_schema_version = ${identity.artifactSchemaVersion}
          AND artifact.state IN ('verified', 'orphaned')
          AND artifact.deleted_at IS NULL
        LIMIT 1
      `;
      return rows[0] ? mapArtifact(rows[0]) : null;
    },
    async findReusable(identity) {
      const rows = await sql<ArtifactRow[]>`
        SELECT ${sql.unsafe(ARTIFACT_COLUMNS)}
        FROM focowiki.embedding_artifacts artifact
        JOIN focowiki.object_registrations object
          ON object.object_id = artifact.object_id
         AND object.state = 'verified'
        WHERE artifact.knowledge_base_id = ${identity.knowledgeBaseId}
          AND artifact.owner_kind = ${identity.ownerKind}
          AND artifact.canonical_input_sha256 = ${identity.canonicalInputSha256}
          AND artifact.input_kind = ${identity.inputKind}
          AND artifact.embedding_configuration_revision_public_id
            = ${identity.embeddingConfigurationRevisionPublicId}
          AND artifact.normalization = ${identity.normalization}
          AND artifact.dimension = ${identity.dimension}
          AND artifact.artifact_schema_version = ${identity.artifactSchemaVersion}
          AND artifact.state IN ('verified', 'orphaned')
          AND artifact.deleted_at IS NULL
        ORDER BY artifact.created_at DESC, artifact.public_id COLLATE "C"
        LIMIT 1
      `;
      return rows[0] ? mapArtifact(rows[0]) : null;
    },
    async reserveObject(input) {
      return sql.begin(async (transaction) => {
        const existing = await lockObject(transaction, input.descriptor.objectId);
        if (existing) {
          assertObjectMetadata(existing, input.descriptor);
          if (existing.state === "verified") return "reused" as const;
          if (
            existing.state === "reserved"
            && existing.write_attempt_public_id === input.writeAttemptPublicId
          ) return "reserved" as const;
          if (
            (existing.state === "reserved"
              && existing.reservation_expires_at !== null
              && new Date(existing.reservation_expires_at).getTime()
                <= Date.parse(input.createdAt))
            || existing.state === "deleted"
          ) {
            const reclaimed = await transaction<Array<{ object_id: string }>>`
              UPDATE focowiki.object_registrations registration
              SET state = 'reserved',
                  write_attempt_public_id = ${input.writeAttemptPublicId},
                  verified_at = NULL,
                  reservation_expires_at = ${reservationExpiresAt(input.createdAt)},
                  zero_owner_since = NULL,
                  created_at = ${input.createdAt}
              WHERE registration.object_id = ${input.descriptor.objectId}
                AND NOT EXISTS (
                  SELECT 1 FROM focowiki.object_owners owner
                  WHERE owner.object_id = registration.object_id
                )
              RETURNING registration.object_id
            `;
            if (reclaimed[0]) return "reserved" as const;
          }
          throw new Error("Embedding artifact object reservation conflicts");
        }
        await transaction`
          INSERT INTO focowiki.object_registrations (
            object_id, storage_key, checksum_sha256, byte_count, content_type,
            object_format, state, write_attempt_public_id,
            reservation_expires_at, created_at
          ) VALUES (
            ${input.descriptor.objectId}, ${input.descriptor.storageKey},
            ${input.descriptor.checksumSha256}, ${input.descriptor.byteCount},
            ${input.descriptor.contentType}, ${input.descriptor.objectFormat},
            'reserved', ${input.writeAttemptPublicId},
            ${reservationExpiresAt(input.createdAt)}, ${input.createdAt}
          )
        `;
        return "reserved" as const;
      }) as Promise<"reserved" | "reused">;
    },
    async commitVerified(input) {
      return sql.begin(async (transaction) => {
        const object = await lockObject(transaction, input.descriptor.objectId);
        if (!object) throw new Error("Embedding artifact object reservation is unavailable");
        assertObjectMetadata(object, input.descriptor);
        if (
          object.state !== "verified"
          && (object.state !== "reserved"
            || object.write_attempt_public_id !== input.writeAttemptPublicId)
        ) throw new Error("Embedding artifact object reservation is stale");
        await transaction`
          UPDATE focowiki.object_registrations
          SET state = 'verified', verified_at = COALESCE(verified_at, ${input.verifiedAt}),
              reservation_expires_at = NULL, zero_owner_since = NULL
          WHERE object_id = ${input.descriptor.objectId}
        `;
        const artifact = input.replaceUnavailable
          && input.replaceUnavailable.objectId !== input.descriptor.objectId
          ? await replaceUnavailableArtifact(transaction, input)
          : await insertOrVerifyArtifact(transaction, input);
        assertArtifactMatches(artifact, input.identity, input.descriptor);
        await attachObjectOwner(transaction, artifact, input.verifiedAt);
        await attachSemanticOwnerAndReference(transaction, {
          artifact,
          semanticGenerationPublicId: input.semanticGenerationPublicId,
          operationPublicId: input.operationPublicId,
          sourceFilePublicId: input.sourceFilePublicId,
          sourceExcerpt: input.sourceExcerpt,
          retentionKind: input.retentionKind
        });
        return mapArtifact(artifact);
      }) as Promise<EmbeddingArtifactRecord>;
    },
    async reuseVerified(input) {
      return sql.begin(async (transaction) => {
        const sources = await transaction<ArtifactRow[]>`
          SELECT ${transaction.unsafe(ARTIFACT_COLUMNS)}
          FROM focowiki.embedding_artifacts artifact
          JOIN focowiki.object_registrations object
            ON object.object_id = artifact.object_id
           AND object.state = 'verified'
          WHERE artifact.public_id = ${input.sourceArtifact.publicId}
            AND artifact.knowledge_base_id = ${input.identity.knowledgeBaseId}
            AND artifact.canonical_input_sha256
              = ${input.identity.canonicalInputSha256}
            AND artifact.input_kind = ${input.identity.inputKind}
            AND artifact.embedding_configuration_revision_public_id
              = ${input.identity.embeddingConfigurationRevisionPublicId}
            AND artifact.normalization = ${input.identity.normalization}
            AND artifact.dimension = ${input.identity.dimension}
            AND artifact.artifact_schema_version
              = ${input.identity.artifactSchemaVersion}
            AND artifact.state IN ('verified', 'orphaned')
            AND artifact.deleted_at IS NULL
          FOR UPDATE OF artifact, object
        `;
        const source = requireArtifact(sources[0]);
        await transaction`
          INSERT INTO focowiki.embedding_artifacts (
            public_id, knowledge_base_id, object_id, owner_kind,
            owner_public_id, source_revision_public_id,
            canonical_input_sha256, input_kind,
            embedding_configuration_revision_public_id, normalization,
            dimension, artifact_schema_version, vector_checksum_sha256,
            byte_count, state, created_at
          ) VALUES (
            ${input.artifactPublicId}, ${input.identity.knowledgeBaseId},
            ${source.object_id}, ${input.identity.ownerKind},
            ${input.identity.ownerPublicId}, ${input.identity.sourceRevisionPublicId},
            ${input.identity.canonicalInputSha256}, ${input.identity.inputKind},
            ${input.identity.embeddingConfigurationRevisionPublicId},
            ${input.identity.normalization}, ${input.identity.dimension},
            ${input.identity.artifactSchemaVersion},
            ${source.vector_checksum_sha256}, ${source.byte_count}, 'verified',
            ${input.reusedAt}
          )
          ON CONFLICT (public_id) DO NOTHING
        `;
        const targets = await transaction<ArtifactRow[]>`
          SELECT ${transaction.unsafe(ARTIFACT_COLUMNS)}
          FROM focowiki.embedding_artifacts artifact
          JOIN focowiki.object_registrations object
            ON object.object_id = artifact.object_id
          WHERE artifact.public_id = ${input.artifactPublicId}
          FOR UPDATE OF artifact, object
        `;
        const target = requireArtifact(targets[0]);
        assertArtifactIdentity(target, input.identity);
        if (target.object_id !== source.object_id
          || target.vector_checksum_sha256 !== source.vector_checksum_sha256
          || Number(target.byte_count) !== Number(source.byte_count)) {
          throw new Error("Embedding artifact reuse conflicts");
        }
        await attachObjectOwner(transaction, target, input.reusedAt);
        await attachSemanticOwnerAndReference(transaction, {
          artifact: target,
          semanticGenerationPublicId: input.semanticGenerationPublicId,
          operationPublicId: input.operationPublicId,
          sourceFilePublicId: input.sourceFilePublicId,
          sourceExcerpt: input.sourceExcerpt,
          retentionKind: input.retentionKind
        });
        return mapArtifact(target);
      }) as Promise<EmbeddingArtifactRecord>;
    },
    async attachReference(input) {
      await sql.begin(async (transaction) => {
        const rows = await transaction<ArtifactRow[]>`
          SELECT ${transaction.unsafe(ARTIFACT_COLUMNS)}
          FROM focowiki.embedding_artifacts artifact
          JOIN focowiki.object_registrations object
            ON object.object_id = artifact.object_id
          WHERE artifact.public_id = ${input.artifact.publicId}
            AND artifact.knowledge_base_id = ${input.artifact.knowledgeBaseId}
            AND artifact.state IN ('verified', 'orphaned')
            AND artifact.deleted_at IS NULL
            AND object.state = 'verified'
          FOR UPDATE OF artifact, object
        `;
        const artifact = requireArtifact(rows[0]);
        if (artifact.state === "orphaned") {
          await transaction`
            UPDATE focowiki.embedding_artifacts
            SET state = 'verified', deleted_at = NULL
            WHERE public_id = ${artifact.public_id}
              AND state = 'orphaned'
          `;
        }
        await attachSemanticOwnerAndReference(transaction, {
          artifact,
          semanticGenerationPublicId: input.semanticGenerationPublicId,
          operationPublicId: input.operationPublicId,
          sourceFilePublicId: input.sourceFilePublicId,
          sourceExcerpt: input.sourceExcerpt,
          retentionKind: input.retentionKind
        });
      });
    },
    async listSourceReferences(input) {
      const limit = assertSourceReferenceLimit(input.limit);
      const rows = await sql<Array<ArtifactRow & {
        source_file_public_id: string;
        evidence_target_path: string;
        source_excerpt: string;
        source_metadata: StorageVnextStructuredMetadata;
      }>>`
        SELECT DISTINCT ON (artifact.input_kind, artifact.owner_public_id)
               ${sql.unsafe(ARTIFACT_COLUMNS)},
               reference.source_file_public_id,
               source.logical_path AS evidence_target_path,
               reference.source_excerpt,
               source.metadata AS source_metadata
        FROM focowiki.semantic_embedding_artifact_refs reference
        JOIN focowiki.embedding_artifacts artifact
          ON artifact.knowledge_base_id = reference.knowledge_base_id
         AND artifact.public_id = reference.artifact_public_id
         AND artifact.state = 'verified'
         AND artifact.deleted_at IS NULL
        JOIN focowiki.object_registrations object
          ON object.object_id = artifact.object_id
         AND object.state = 'verified'
        JOIN focowiki.semantic_generations generation
          ON generation.knowledge_base_id = reference.knowledge_base_id
         AND generation.public_id = reference.semantic_generation_public_id
         AND generation.deleted_at IS NULL
        JOIN focowiki.source_files source
          ON source.knowledge_base_id = reference.knowledge_base_id
         AND source.public_id = reference.source_file_public_id
         AND source.deleted_at IS NULL
        WHERE reference.knowledge_base_id = ${input.knowledgeBaseId}
          AND reference.semantic_generation_public_id
            = ${input.semanticGenerationPublicId}
          AND reference.source_file_public_id = ${input.sourceFilePublicId}
          AND artifact.source_revision_public_id = ${input.sourceRevisionPublicId}
          AND (
            generation.generation_role = 'candidate'
              AND generation.state IN ('building', 'validating', 'ready')
            OR generation.generation_role = 'active'
              AND generation.state = 'active'
          )
        ORDER BY artifact.input_kind,
                 artifact.owner_public_id,
                 artifact.created_at DESC,
                 artifact.public_id COLLATE "C"
        LIMIT ${limit + 1}
      `;
      if (rows.length > limit) {
        throw new Error("Embedding artifact source reference limit exceeded");
      }
      return rows.map((row): EmbeddingArtifactSourceReference => ({
        artifact: mapArtifact(row),
        sourceFilePublicId: row.source_file_public_id,
        evidenceTargetPath: row.evidence_target_path,
        sourceExcerpt: row.source_excerpt,
        fileKind: "page",
        okfSignals: createOkfSearchSignals(row.source_metadata)
      }));
    },
    async markWriteFailed(input) {
      await sql`
        UPDATE focowiki.object_registrations
        SET zero_owner_since = COALESCE(zero_owner_since, ${input.failedAt})
        WHERE object_id = ${input.descriptor.objectId}
          AND write_attempt_public_id = ${input.writeAttemptPublicId}
          AND state = 'reserved'
          AND NOT EXISTS (
            SELECT 1 FROM focowiki.object_owners owner
            WHERE owner.object_id = object_registrations.object_id
          )
      `;
    },
    async releaseReferences(input) {
      if (input.ownerPublicIds !== null && input.ownerPublicIds.length === 0) return 0;
      return sql.begin(async (transaction) => {
        const rows = await transaction<Array<{ artifact_public_id: string }>>`
          SELECT DISTINCT owner.artifact_public_id
          FROM focowiki.embedding_artifact_owners owner
          WHERE owner.knowledge_base_id = ${input.knowledgeBaseId}
            AND owner.semantic_generation_public_id
              = ${input.semanticGenerationPublicId}
            AND (${input.ownerPublicIds}::text[] IS NULL
              OR owner.owner_public_id = ANY(${input.ownerPublicIds}))
          ORDER BY owner.artifact_public_id
        `;
        const artifactPublicIds = rows.map((row) => row.artifact_public_id);
        if (artifactPublicIds.length === 0) return 0;
        await transaction`
          DELETE FROM focowiki.semantic_embedding_artifact_refs
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND semantic_generation_public_id
              = ${input.semanticGenerationPublicId}
            AND artifact_public_id = ANY(${artifactPublicIds})
            AND (${input.ownerPublicIds}::text[] IS NULL
              OR semantic_owner_public_id = ANY(${input.ownerPublicIds}))
        `;
        await transaction`
          DELETE FROM focowiki.embedding_artifact_owners
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND semantic_generation_public_id
              = ${input.semanticGenerationPublicId}
            AND artifact_public_id = ANY(${artifactPublicIds})
            AND (${input.ownerPublicIds}::text[] IS NULL
              OR owner_public_id = ANY(${input.ownerPublicIds}))
        `;
        const orphaned = await transaction<Array<{ public_id: string }>>`
          UPDATE focowiki.embedding_artifacts artifact
          SET state = 'orphaned', deleted_at = NULL
          WHERE artifact.knowledge_base_id = ${input.knowledgeBaseId}
            AND artifact.public_id = ANY(${artifactPublicIds})
            AND artifact.state IN ('registered', 'verified', 'failed')
            AND NOT EXISTS (
              SELECT 1 FROM focowiki.embedding_artifact_owners owner
              WHERE owner.artifact_public_id = artifact.public_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM focowiki.semantic_embedding_artifact_refs reference
              WHERE reference.artifact_public_id = artifact.public_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM focowiki.semantic_vector_documents vector
              WHERE vector.artifact_public_id = artifact.public_id
                AND vector.deleted_at IS NULL
                AND vector.state <> 'deleted'
            )
          RETURNING artifact.public_id
        `;
        return orphaned.length;
      });
    },
    async releaseSupersededSourceReferences(input) {
      const limit = assertSourceReferenceLimit(input.limit);
      return sql.begin(async (transaction) => {
        const rows = await transaction<Array<{ artifact_public_id: string }>>`
          SELECT DISTINCT reference.artifact_public_id COLLATE "C"
            AS artifact_public_id
          FROM focowiki.semantic_embedding_artifact_refs reference
          JOIN focowiki.embedding_artifacts artifact
            ON artifact.knowledge_base_id = reference.knowledge_base_id
           AND artifact.public_id = reference.artifact_public_id
          WHERE reference.knowledge_base_id = ${input.knowledgeBaseId}
            AND reference.semantic_generation_public_id
              = ${input.semanticGenerationPublicId}
            AND reference.source_file_public_id = ${input.sourceFilePublicId}
            AND artifact.source_revision_public_id IS DISTINCT FROM
              ${input.currentSourceRevisionPublicId}
          ORDER BY artifact_public_id
          LIMIT ${limit + 1}
        `;
        if (rows.length > limit) {
          throw new Error("Embedding artifact superseded reference limit exceeded");
        }
        const artifactPublicIds = rows.map((row) => row.artifact_public_id);
        if (artifactPublicIds.length === 0) return 0;
        const released = await transaction<Array<{ artifact_public_id: string }>>`
          DELETE FROM focowiki.semantic_embedding_artifact_refs
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND semantic_generation_public_id
              = ${input.semanticGenerationPublicId}
            AND source_file_public_id = ${input.sourceFilePublicId}
            AND artifact_public_id = ANY(${artifactPublicIds})
          RETURNING artifact_public_id
        `;
        await transaction`
          DELETE FROM focowiki.embedding_artifact_owners owner
          USING focowiki.embedding_artifacts artifact
          WHERE owner.knowledge_base_id = ${input.knowledgeBaseId}
            AND owner.semantic_generation_public_id
              = ${input.semanticGenerationPublicId}
            AND owner.artifact_public_id = ANY(${artifactPublicIds})
            AND artifact.public_id = owner.artifact_public_id
            AND artifact.source_revision_public_id IS DISTINCT FROM
              ${input.currentSourceRevisionPublicId}
        `;
        await transaction`
          UPDATE focowiki.embedding_artifacts artifact
          SET state = 'orphaned', deleted_at = NULL
          WHERE artifact.knowledge_base_id = ${input.knowledgeBaseId}
            AND artifact.public_id = ANY(${artifactPublicIds})
            AND artifact.state IN ('registered', 'verified', 'failed')
            AND NOT EXISTS (
              SELECT 1 FROM focowiki.embedding_artifact_owners owner
              WHERE owner.artifact_public_id = artifact.public_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM focowiki.semantic_embedding_artifact_refs reference
              WHERE reference.artifact_public_id = artifact.public_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM focowiki.semantic_vector_documents vector
              WHERE vector.artifact_public_id = artifact.public_id
                AND vector.deleted_at IS NULL
                AND vector.state <> 'deleted'
            )
        `;
        await transaction`
          UPDATE focowiki.object_registrations object
          SET zero_owner_since = COALESCE(
            object.zero_owner_since, ${input.releasedAt}
          )
          WHERE object.object_id IN (
            SELECT artifact.object_id
            FROM focowiki.embedding_artifacts artifact
            WHERE artifact.public_id = ANY(${artifactPublicIds})
              AND artifact.state = 'orphaned'
          )
            AND NOT EXISTS (
              SELECT 1 FROM focowiki.object_owners owner
              WHERE owner.object_id = object.object_id
            )
        `;
        return released.length;
      });
    },
    async listOrphaned(input) {
      const limit = assertCleanupLimit(input.limit);
      const cursor = decodeCleanupCursor(input.cursor, input.knowledgeBaseId);
      const rows = await sql<ArtifactRow[]>`
        SELECT ${sql.unsafe(ARTIFACT_COLUMNS)}
        FROM focowiki.embedding_artifacts artifact
        JOIN focowiki.object_registrations object
          ON object.object_id = artifact.object_id
        WHERE artifact.knowledge_base_id = ${input.knowledgeBaseId}
          AND artifact.state = 'orphaned'
          AND (${cursor}::text IS NULL
            OR artifact.public_id COLLATE "C" > ${cursor}::text COLLATE "C")
        ORDER BY artifact.public_id COLLATE "C"
        LIMIT ${limit + 1}
      `;
      const items = rows.slice(0, limit).map(mapArtifact);
      return {
        items,
        nextCursor: rows.length > limit && items.at(-1)
          ? encodeCleanupCursor(input.knowledgeBaseId, items.at(-1)!.publicId)
          : null
      };
    },
    async claimOrphaned(input) {
      return sql.begin(async (transaction) => {
        const rows = await transaction<ArtifactRow[]>`
          SELECT ${transaction.unsafe(ARTIFACT_COLUMNS)}
          FROM focowiki.embedding_artifacts artifact
          JOIN focowiki.object_registrations object
            ON object.object_id = artifact.object_id
          WHERE artifact.knowledge_base_id = ${input.knowledgeBaseId}
            AND artifact.public_id = ${input.artifactPublicId}
            AND artifact.state = 'orphaned'
          FOR UPDATE OF artifact, object
        `;
        const artifact = rows[0];
        if (!artifact || await hasLiveArtifactReferences(transaction, artifact.public_id)) {
          return null;
        }
        await transaction`
          UPDATE focowiki.embedding_artifacts
          SET deleted_at = COALESCE(deleted_at, ${input.claimedAt})
          WHERE public_id = ${artifact.public_id}
        `;
        const otherOwners = await transaction<Array<{ count: string }>>`
          SELECT count(*) AS count
          FROM focowiki.object_owners owner
          WHERE owner.object_id = ${artifact.object_id}
            AND NOT (
              owner.owner_kind = 'embedding_artifact'
              AND owner.embedding_artifact_public_id = ${artifact.public_id}
            )
        `;
        if (Number(otherOwners[0]?.count ?? 0) > 0) {
          return { artifactPublicId: artifact.public_id, descriptor: null };
        }
        await transaction`
          UPDATE focowiki.object_registrations
          SET state = 'deleting'
          WHERE object_id = ${artifact.object_id}
            AND state IN ('verified', 'deleting')
        `;
        return {
          artifactPublicId: artifact.public_id,
          descriptor: descriptorFromArtifact(artifact)
        };
      });
    },
    async completeOrphanDeletion(input) {
      return sql.begin(async (transaction) => {
        const rows = await transaction<ArtifactRow[]>`
          SELECT ${transaction.unsafe(ARTIFACT_COLUMNS)}
          FROM focowiki.embedding_artifacts artifact
          JOIN focowiki.object_registrations object
            ON object.object_id = artifact.object_id
          WHERE artifact.knowledge_base_id = ${input.knowledgeBaseId}
            AND artifact.public_id = ${input.artifactPublicId}
            AND artifact.state = 'orphaned'
            AND artifact.deleted_at IS NOT NULL
          FOR UPDATE OF artifact, object
        `;
        const artifact = rows[0];
        if (!artifact || await hasLiveArtifactReferences(transaction, artifact.public_id)) {
          return false;
        }
        if (input.descriptor) assertArtifactDescriptor(artifact, input.descriptor);
        await transaction`
          DELETE FROM focowiki.embedding_artifacts
          WHERE public_id = ${artifact.public_id}
        `;
        if (input.descriptor) {
          await transaction`
            UPDATE focowiki.object_registrations
            SET state = 'deleted', zero_owner_since = NULL
            WHERE object_id = ${artifact.object_id}
              AND state = 'deleting'
              AND NOT EXISTS (
                SELECT 1 FROM focowiki.object_owners owner
                WHERE owner.object_id = object_registrations.object_id
              )
          `;
        }
        return true;
      });
    },
    async abandonOrphanDeletion(input) {
      await sql.begin(async (transaction) => {
        const rows = await transaction<ArtifactRow[]>`
          SELECT ${transaction.unsafe(ARTIFACT_COLUMNS)}
          FROM focowiki.embedding_artifacts artifact
          JOIN focowiki.object_registrations object
            ON object.object_id = artifact.object_id
          WHERE artifact.knowledge_base_id = ${input.knowledgeBaseId}
            AND artifact.public_id = ${input.artifactPublicId}
            AND artifact.state = 'orphaned'
          FOR UPDATE OF artifact, object
        `;
        const artifact = rows[0];
        if (!artifact) return;
        if (input.descriptor) assertArtifactDescriptor(artifact, input.descriptor);
        await transaction`
          UPDATE focowiki.embedding_artifacts
          SET deleted_at = NULL
          WHERE public_id = ${artifact.public_id}
        `;
        if (input.descriptor) {
          await transaction`
            UPDATE focowiki.object_registrations
            SET state = 'verified'
            WHERE object_id = ${artifact.object_id}
              AND state = 'deleting'
          `;
        }
      });
    }
  };
}

async function insertOrVerifyArtifact(
  sql: TransactionSql,
  input: CommitVerifiedInput
): Promise<ArtifactRow> {
  const artifacts = await sql<ArtifactRow[]>`
    INSERT INTO focowiki.embedding_artifacts AS artifact (
      public_id, knowledge_base_id, object_id, owner_kind, owner_public_id,
      source_revision_public_id, canonical_input_sha256, input_kind,
      embedding_configuration_revision_public_id, normalization, dimension,
      artifact_schema_version, vector_checksum_sha256, byte_count, state
    ) VALUES (
      ${input.artifactPublicId}, ${input.identity.knowledgeBaseId},
      ${input.descriptor.objectId}, ${input.identity.ownerKind},
      ${input.identity.ownerPublicId}, ${input.identity.sourceRevisionPublicId},
      ${input.identity.canonicalInputSha256}, ${input.identity.inputKind},
      ${input.identity.embeddingConfigurationRevisionPublicId},
      ${input.identity.normalization}, ${input.identity.dimension},
      ${input.identity.artifactSchemaVersion}, ${input.vectorChecksumSha256},
      ${input.descriptor.byteCount}, 'verified'
    )
    ON CONFLICT (public_id) DO UPDATE
    SET state = CASE
      WHEN artifact.state IN ('registered', 'verified') THEN 'verified'
      ELSE artifact.state
    END
    RETURNING public_id, knowledge_base_id, object_id,
      ${input.descriptor.storageKey}::text AS storage_key,
      owner_kind, owner_public_id, source_revision_public_id,
      canonical_input_sha256, input_kind,
      embedding_configuration_revision_public_id, normalization, dimension,
      artifact_schema_version, vector_checksum_sha256, byte_count, state
  `;
  return requireArtifact(artifacts[0]);
}

async function replaceUnavailableArtifact(
  sql: TransactionSql,
  input: CommitVerifiedInput
): Promise<ArtifactRow> {
  const expected = input.replaceUnavailable;
  if (!expected || expected.artifactPublicId !== input.artifactPublicId) {
    throw new Error("Embedding artifact replacement identity conflicts");
  }
  const currentRows = await sql<ArtifactRow[]>`
    SELECT ${sql.unsafe(ARTIFACT_COLUMNS)}
    FROM focowiki.embedding_artifacts artifact
    JOIN focowiki.object_registrations object
      ON object.object_id = artifact.object_id
    WHERE artifact.public_id = ${input.artifactPublicId}
    FOR UPDATE OF artifact, object
  `;
  const current = requireArtifact(currentRows[0]);
  assertArtifactIdentity(current, input.identity);
  if (current.object_id !== expected.objectId) {
    throw new Error("Embedding artifact replacement object conflicts");
  }
  await sql`
    UPDATE focowiki.embedding_artifacts
    SET object_id = ${input.descriptor.objectId},
        vector_checksum_sha256 = ${input.vectorChecksumSha256},
        byte_count = ${input.descriptor.byteCount},
        state = 'verified', deleted_at = NULL
    WHERE public_id = ${input.artifactPublicId}
      AND object_id = ${expected.objectId}
  `;
  await sql`
    DELETE FROM focowiki.object_owners
    WHERE object_id = ${expected.objectId}
      AND owner_kind = 'embedding_artifact'
      AND embedding_artifact_public_id = ${input.artifactPublicId}
  `;
  await sql`
    UPDATE focowiki.object_registrations object
    SET zero_owner_since = COALESCE(object.zero_owner_since, ${input.verifiedAt})
    WHERE object.object_id = ${expected.objectId}
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.object_owners owner
        WHERE owner.object_id = object.object_id
      )
  `;
  const repairedRows = await sql<ArtifactRow[]>`
    SELECT ${sql.unsafe(ARTIFACT_COLUMNS)}
    FROM focowiki.embedding_artifacts artifact
    JOIN focowiki.object_registrations object
      ON object.object_id = artifact.object_id
    WHERE artifact.public_id = ${input.artifactPublicId}
    FOR UPDATE OF artifact, object
  `;
  return requireArtifact(repairedRows[0]);
}

async function attachObjectOwner(
  sql: TransactionSql,
  artifact: ArtifactRow,
  createdAt: string
): Promise<void> {
  const publicId = `embedding-object-owner:${hash(artifact.public_id, artifact.object_id)}`;
  await sql`
    INSERT INTO focowiki.object_owners (
      public_id, knowledge_base_id, object_id, owner_kind,
      embedding_artifact_public_id, created_at
    ) VALUES (
      ${publicId}, ${artifact.knowledge_base_id}, ${artifact.object_id},
      'embedding_artifact', ${artifact.public_id}, ${createdAt}
    )
    ON CONFLICT (object_id, owner_kind, owner_public_id) DO NOTHING
  `;
  await sql`
    UPDATE focowiki.object_registrations
    SET zero_owner_since = NULL
    WHERE object_id = ${artifact.object_id}
  `;
}

async function attachSemanticOwnerAndReference(
  sql: TransactionSql,
  input: {
    artifact: ArtifactRow;
    semanticGenerationPublicId: string;
    operationPublicId: string | null;
    sourceFilePublicId: string;
    sourceExcerpt: string;
    retentionKind: "candidate" | "active" | "retry" | "cleanup";
  }
): Promise<void> {
  if (!input.sourceExcerpt.trim()
    || Buffer.byteLength(input.sourceExcerpt, "utf8") > 4_096) {
    throw new Error("Embedding artifact source excerpt is invalid");
  }
  const generations = await sql<Array<{ public_id: string }>>`
    SELECT generation.public_id
    FROM focowiki.semantic_generations generation
    JOIN focowiki.knowledge_bases knowledge_base
      ON knowledge_base.public_id = generation.knowledge_base_id
     AND knowledge_base.deleted_at IS NULL
    JOIN focowiki.source_files source
      ON source.knowledge_base_id = generation.knowledge_base_id
     AND source.public_id = ${input.sourceFilePublicId}
     AND source.deleted_at IS NULL
    WHERE generation.knowledge_base_id = ${input.artifact.knowledge_base_id}
      AND generation.public_id = ${input.semanticGenerationPublicId}
      AND generation.state IN ('building', 'validating', 'ready', 'active')
      AND EXISTS (
        SELECT 1
        FROM focowiki.source_file_active_revisions current_revision
        WHERE current_revision.knowledge_base_id = source.knowledge_base_id
          AND current_revision.source_file_public_id = source.public_id
          AND current_revision.current_source_revision_public_id
            = ${input.artifact.source_revision_public_id}
      )
    FOR UPDATE OF generation
  `;
  if (!generations[0]) throw new Error("Embedding artifact target generation is stale");
  await sql`
    INSERT INTO focowiki.embedding_artifact_owners (
      knowledge_base_id, artifact_public_id, semantic_generation_public_id,
      operation_public_id, source_revision_public_id, owner_kind,
      owner_public_id, retention_kind
    ) VALUES (
      ${input.artifact.knowledge_base_id}, ${input.artifact.public_id},
      ${input.semanticGenerationPublicId}, ${input.operationPublicId},
      ${input.artifact.source_revision_public_id}, ${input.artifact.owner_kind},
      ${input.artifact.owner_public_id}, ${input.retentionKind}
    )
    ON CONFLICT DO NOTHING
  `;
  await sql`
    INSERT INTO focowiki.semantic_embedding_artifact_refs (
      knowledge_base_id, semantic_generation_public_id, artifact_public_id,
      semantic_owner_kind, semantic_owner_public_id, source_file_public_id,
      source_excerpt
    ) VALUES (
      ${input.artifact.knowledge_base_id}, ${input.semanticGenerationPublicId},
      ${input.artifact.public_id}, ${input.artifact.owner_kind},
      ${input.artifact.owner_public_id}, ${input.sourceFilePublicId},
      ${input.sourceExcerpt}
    )
    ON CONFLICT (
      semantic_generation_public_id, semantic_owner_kind,
      semantic_owner_public_id, artifact_public_id
    ) DO UPDATE SET source_excerpt = excluded.source_excerpt
  `;
}

async function lockObject(sql: TransactionSql, objectId: string): Promise<ObjectRow | null> {
  const rows = await sql<ObjectRow[]>`
    SELECT object_id, storage_key, checksum_sha256, byte_count, content_type,
      object_format, state, write_attempt_public_id,
      reservation_expires_at, zero_owner_since
    FROM focowiki.object_registrations
    WHERE object_id = ${objectId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

function reservationExpiresAt(createdAt: string): string {
  return new Date(Date.parse(createdAt) + 30_000).toISOString();
}

function assertObjectMetadata(row: ObjectRow, descriptor: EmbeddingArtifactDescriptor): void {
  if (
    row.object_id !== descriptor.objectId
    || row.storage_key !== descriptor.storageKey
    || row.checksum_sha256 !== descriptor.checksumSha256
    || Number(row.byte_count) !== descriptor.byteCount
    || row.content_type !== descriptor.contentType
    || row.object_format !== descriptor.objectFormat
  ) throw new Error("Embedding artifact object metadata conflicts");
}

function assertArtifactMatches(
  row: ArtifactRow,
  identity: EmbeddingArtifactIdentity,
  descriptor: EmbeddingArtifactDescriptor
): void {
  assertArtifactIdentity(row, identity);
  if (
    row.object_id !== descriptor.objectId
    || row.vector_checksum_sha256 !== descriptor.checksumSha256
    || Number(row.byte_count) !== descriptor.byteCount
  ) throw new Error("Embedding artifact identity conflicts");
}

function assertArtifactIdentity(
  row: ArtifactRow,
  identity: EmbeddingArtifactIdentity
): void {
  if (
    row.knowledge_base_id !== identity.knowledgeBaseId
    || row.owner_kind !== identity.ownerKind
    || row.owner_public_id !== identity.ownerPublicId
    || row.source_revision_public_id !== identity.sourceRevisionPublicId
    || row.canonical_input_sha256 !== identity.canonicalInputSha256
    || row.input_kind !== identity.inputKind
    || row.embedding_configuration_revision_public_id
      !== identity.embeddingConfigurationRevisionPublicId
    || row.normalization !== identity.normalization
    || Number(row.dimension) !== identity.dimension
    || row.artifact_schema_version !== identity.artifactSchemaVersion
  ) throw new Error("Embedding artifact identity conflicts");
}

async function hasLiveArtifactReferences(
  sql: TransactionSql,
  artifactPublicId: string
): Promise<boolean> {
  const rows = await sql<Array<{ live: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM focowiki.embedding_artifact_owners owner
      WHERE owner.artifact_public_id = ${artifactPublicId}
    ) OR EXISTS (
      SELECT 1 FROM focowiki.semantic_embedding_artifact_refs reference
      WHERE reference.artifact_public_id = ${artifactPublicId}
    ) OR EXISTS (
      SELECT 1 FROM focowiki.semantic_vector_documents vector
      WHERE vector.artifact_public_id = ${artifactPublicId}
        AND vector.deleted_at IS NULL
        AND vector.state <> 'deleted'
    ) AS live
  `;
  return rows[0]?.live === true;
}

function descriptorFromArtifact(row: ArtifactRow): EmbeddingArtifactDescriptor {
  return {
    objectId: row.object_id,
    storageKey: row.storage_key,
    checksumSha256: row.vector_checksum_sha256,
    byteCount: Number(row.byte_count),
    contentType: "application/octet-stream",
    objectFormat: "semantic-vector-v1"
  };
}

function assertArtifactDescriptor(
  row: ArtifactRow,
  descriptor: EmbeddingArtifactDescriptor
): void {
  const actual = descriptorFromArtifact(row);
  if (
    actual.objectId !== descriptor.objectId
    || actual.storageKey !== descriptor.storageKey
    || actual.checksumSha256 !== descriptor.checksumSha256
    || actual.byteCount !== descriptor.byteCount
    || actual.contentType !== descriptor.contentType
    || actual.objectFormat !== descriptor.objectFormat
  ) throw new Error("Embedding artifact cleanup descriptor conflicts");
}

function assertCleanupLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Embedding artifact cleanup limit is invalid");
  }
  return value;
}

function assertSourceReferenceLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new Error("Embedding artifact source reference limit is invalid");
  }
  return value;
}

function encodeCleanupCursor(scope: string, publicId: string): string {
  return Buffer.from(JSON.stringify({ scope, publicId }), "utf8").toString("base64url");
}

function decodeCleanupCursor(value: string | null, scope: string): string | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      scope?: unknown;
      publicId?: unknown;
    };
    if (parsed.scope !== scope || typeof parsed.publicId !== "string" || !parsed.publicId) {
      throw new Error("invalid");
    }
    return parsed.publicId;
  } catch {
    throw new Error("Embedding artifact cleanup cursor is invalid");
  }
}

function mapArtifact(row: ArtifactRow): EmbeddingArtifactRecord {
  return {
    publicId: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    objectId: row.object_id,
    storageKey: row.storage_key,
    ownerKind: row.owner_kind,
    ownerPublicId: row.owner_public_id,
    sourceRevisionPublicId: row.source_revision_public_id,
    canonicalInputSha256: row.canonical_input_sha256,
    inputKind: row.input_kind,
    embeddingConfigurationRevisionPublicId: row.embedding_configuration_revision_public_id,
    normalization: row.normalization,
    dimension: Number(row.dimension),
    artifactSchemaVersion: row.artifact_schema_version,
    vectorChecksumSha256: row.vector_checksum_sha256,
    byteCount: Number(row.byte_count),
    state: row.state
  };
}

function requireArtifact(value: ArtifactRow | undefined): ArtifactRow {
  if (!value) throw new Error("Embedding artifact is unavailable");
  return value;
}

function hash(...values: string[]): string {
  return createHash("sha256").update(values.join("\u001f")).digest("hex");
}
