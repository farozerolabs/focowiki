import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyStorageVnextTestMigrations } from "./helpers/storage-vnext-test-migrations.js";
import { createEmbeddingArtifactIdentity } from "../src/semantic/embedding/contract-identity.js";
import { encodeVectorArtifact } from "../src/semantic/embedding/vector-artifact-codec.js";
import { createPostgresEmbeddingArtifactRepository } from "../src/semantic/infrastructure/postgres-embedding-artifact-repository.js";
import { purgePostgresStorageVnextDeletedRegistrations } from
  "../src/storage-vnext/ownership/postgres-repository.js";

function descriptorFor(
  encoded: ReturnType<typeof encodeVectorArtifact>,
  suffix: string
) {
  return {
    objectId: `semantic-sha256:semantic-vector-v1:${encoded.checksumSha256}`,
    storageKey: `focowiki/semantic/${suffix}/${encoded.checksumSha256}.bin`,
    checksumSha256: encoded.checksumSha256,
    byteCount: encoded.byteCount,
    contentType: "application/octet-stream" as const,
    objectFormat: "semantic-vector-v1" as const
  };
}

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(databaseUrl && runOwner && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));
const describeOwnedDatabase = hasOwnedTarget ? describe : describe.skip;

describeOwnedDatabase("embedding artifact PostgreSQL repository", () => {
  const connectionUrl = databaseUrl ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const owner = (runOwner ?? "invalid").replaceAll("-", "_");
  const databaseName = `focowiki_artifact_${owner}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 4 });
  const repository = createPostgresEmbeddingArtifactRepository(sql);
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
    await seed();
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("recovers abandoned and deleted content-addressed object reservations", async () => {
    const abandonedEncoded = encodeVectorArtifact({
      vector: [0.1, 0.2, 0.3], normalization: "none"
    });
    const abandonedDescriptor = descriptorFor(abandonedEncoded, "abandoned");
    await expect(repository.reserveObject({
      descriptor: abandonedDescriptor,
      writeAttemptPublicId: "write-abandoned-a",
      createdAt: "2026-08-08T00:00:00.000Z"
    })).resolves.toBe("reserved");
    await expect(repository.reserveObject({
      descriptor: abandonedDescriptor,
      writeAttemptPublicId: "write-abandoned-b",
      createdAt: "2026-08-08T00:00:01.000Z"
    })).rejects.toThrow("reservation conflicts");
    await repository.markWriteFailed({
      descriptor: abandonedDescriptor,
      writeAttemptPublicId: "write-abandoned-a",
      safeCode: "embedding_artifact_write_failed",
      failedAt: "2026-08-08T00:00:02.000Z"
    });
    await expect(repository.reserveObject({
      descriptor: abandonedDescriptor,
      writeAttemptPublicId: "write-abandoned-b",
      createdAt: "2026-08-08T00:00:03.000Z"
    })).resolves.toBe("reserved");

    const deletedEncoded = encodeVectorArtifact({
      vector: [0.4, 0.5, 0.6], normalization: "none"
    });
    const deletedDescriptor = descriptorFor(deletedEncoded, "deleted");
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at,
        zero_owner_since, created_at
      ) VALUES (
        ${deletedDescriptor.objectId}, ${deletedDescriptor.storageKey},
        ${deletedDescriptor.checksumSha256}, ${deletedDescriptor.byteCount},
        ${deletedDescriptor.contentType}, ${deletedDescriptor.objectFormat},
        'deleted', 'write-deleted-a', '2026-08-08T00:00:00.000Z',
        '2026-08-08T00:00:00.000Z',
        '2026-08-08T00:00:00.000Z'
      )
    `;
    await expect(repository.reserveObject({
      descriptor: deletedDescriptor,
      writeAttemptPublicId: "write-deleted-b",
      createdAt: "2026-08-08T00:00:04.000Z"
    })).resolves.toBe("reserved");

    const rows = await sql<Array<{
      object_id: string;
      state: string;
      write_attempt_public_id: string;
      zero_owner_since: Date | null;
    }>>`
      SELECT object_id, state, write_attempt_public_id, zero_owner_since
      FROM focowiki.object_registrations
      WHERE object_id IN (
        ${abandonedDescriptor.objectId}, ${deletedDescriptor.objectId}
      )
      ORDER BY object_id
    `;
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        object_id: abandonedDescriptor.objectId,
        state: "reserved",
        write_attempt_public_id: "write-abandoned-b",
        zero_owner_since: null
      }),
      expect.objectContaining({
        object_id: deletedDescriptor.objectId,
        state: "reserved",
        write_attempt_public_id: "write-deleted-b",
        zero_owner_since: null
      })
    ]));
  });

  it("retains deleted registrations while an embedding artifact still references them", async () => {
    const checksum = "6".repeat(64);
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at,
        zero_owner_since
      ) VALUES (
        'semantic-object-retained', 'focowiki/semantic/retained.bin',
        ${checksum}, 28, 'application/octet-stream', 'semantic-vector-v1',
        'deleted', 'write-semantic-retained', now(), now()
      )
    `;
    await sql`
      INSERT INTO focowiki.embedding_artifacts (
        public_id, knowledge_base_id, object_id, owner_kind, owner_public_id,
        source_revision_public_id, canonical_input_sha256, input_kind,
        embedding_configuration_revision_public_id, normalization, dimension,
        artifact_schema_version, vector_checksum_sha256, byte_count, state
      ) VALUES (
        'artifact-retained', 'kb-artifact', 'semantic-object-retained',
        'content', 'content-retained', NULL, ${"5".repeat(64)}, 'content',
        'embedding-revision-artifact', 'l2', 3,
        'focowiki-vector-artifact-v1', ${checksum}, 28, 'orphaned'
      )
    `;

    await expect(purgePostgresStorageVnextDeletedRegistrations(sql, { limit: 10 }))
      .resolves.toBe(0);
    await expect(count(
      "object_registrations", "object_id = $1", ["semantic-object-retained"]
    )).resolves.toBe(1);
    await sql`
      DELETE FROM focowiki.embedding_artifacts
      WHERE public_id = 'artifact-retained'
    `;
  });

  it("replaces a verified artifact object only when the recorded object is unavailable", async () => {
    const original = encodeVectorArtifact({
      vector: [0.11, 0.22, 0.33], normalization: "none"
    });
    const replacement = encodeVectorArtifact({
      vector: [0.44, 0.55, 0.66], normalization: "none"
    });
    const originalDescriptor = descriptorFor(original, "repair-original");
    const replacementDescriptor = descriptorFor(replacement, "repair-replacement");
    const identity = createEmbeddingArtifactIdentity({
      knowledgeBaseId: "kb-artifact",
      ownerKind: "content",
      ownerPublicId: "content-repair",
      sourceRevisionPublicId: "revision-artifact",
      canonicalInputSha256: "f".repeat(64),
      embeddingConfigurationRevisionPublicId: "embedding-revision-artifact",
      normalization: "none",
      dimension: 3,
      inputKind: "content"
    });
    await repository.reserveObject({
      descriptor: originalDescriptor,
      writeAttemptPublicId: "write-repair-original",
      createdAt: "2026-08-08T00:00:00.000Z"
    });
    await repository.commitVerified({
      identity,
      artifactPublicId: identity.artifactPublicId,
      descriptor: originalDescriptor,
      writeAttemptPublicId: "write-repair-original",
      vectorChecksumSha256: original.checksumSha256,
      semanticGenerationPublicId: "generation-artifact-a",
      operationPublicId: "operation-artifact-a",
      sourceFilePublicId: "file-artifact",
      sourceExcerpt: "Source-grounded repair excerpt.",
      retentionKind: "active",
      verifiedAt: "2026-08-08T00:00:01.000Z"
    });
    await repository.reserveObject({
      descriptor: replacementDescriptor,
      writeAttemptPublicId: "write-repair-replacement",
      createdAt: "2026-08-08T00:00:02.000Z"
    });

    await expect(repository.commitVerified({
      identity,
      artifactPublicId: identity.artifactPublicId,
      descriptor: replacementDescriptor,
      writeAttemptPublicId: "write-repair-replacement",
      vectorChecksumSha256: replacement.checksumSha256,
      semanticGenerationPublicId: "generation-artifact-a",
      operationPublicId: "operation-artifact-a",
      sourceFilePublicId: "file-artifact",
      sourceExcerpt: "Source-grounded repair excerpt.",
      retentionKind: "active",
      verifiedAt: "2026-08-08T00:00:03.000Z",
      replaceUnavailable: {
        artifactPublicId: identity.artifactPublicId,
        objectId: originalDescriptor.objectId
      }
    })).resolves.toMatchObject({
      publicId: identity.artifactPublicId,
      objectId: replacementDescriptor.objectId,
      vectorChecksumSha256: replacement.checksumSha256
    });
    const ownerCounts = await sql<Array<{
      object_id: string;
      owner_count: number | string;
      zero_owner_since: Date | string | null;
    }>>`
      SELECT object.object_id, count(owner.public_id) AS owner_count,
             object.zero_owner_since
      FROM focowiki.object_registrations object
      LEFT JOIN focowiki.object_owners owner ON owner.object_id = object.object_id
      WHERE object.object_id IN (
        ${originalDescriptor.objectId}, ${replacementDescriptor.objectId}
      )
      GROUP BY object.object_id, object.zero_owner_since
      ORDER BY object.object_id
    `;
    expect(ownerCounts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        object_id: originalDescriptor.objectId,
        owner_count: "0",
        zero_owner_since: expect.anything()
      }),
      expect.objectContaining({
        object_id: replacementDescriptor.objectId,
        owner_count: "1",
        zero_owner_since: null
      })
    ]));

    await sql`
      DELETE FROM focowiki.semantic_embedding_artifact_refs
      WHERE artifact_public_id = ${identity.artifactPublicId}
    `;
    await sql`
      DELETE FROM focowiki.embedding_artifact_owners
      WHERE artifact_public_id = ${identity.artifactPublicId}
    `;
    await sql`DELETE FROM focowiki.embedding_artifacts WHERE public_id = ${identity.artifactPublicId}`;
    await sql`
      DELETE FROM focowiki.object_registrations
      WHERE object_id IN (${originalDescriptor.objectId}, ${replacementDescriptor.objectId})
    `;
  });

  it("reclaims an orphaned compatible artifact while its object is verified", async () => {
    const encoded = encodeVectorArtifact({
      vector: [0.3, 0.4, 0.5], normalization: "l2"
    });
    const descriptor = descriptorFor(encoded, "orphan-reuse");
    const identity = createEmbeddingArtifactIdentity({
      knowledgeBaseId: "kb-artifact",
      ownerKind: "content",
      ownerPublicId: "content-orphan-reuse",
      sourceRevisionPublicId: "revision-artifact",
      canonicalInputSha256: "4".repeat(64),
      embeddingConfigurationRevisionPublicId: "embedding-revision-artifact",
      normalization: "l2",
      dimension: 3,
      inputKind: "content"
    });
    await repository.reserveObject({
      descriptor,
      writeAttemptPublicId: "write-orphan-reuse",
      createdAt: "2026-08-08T00:00:00.000Z"
    });
    await repository.commitVerified({
      identity,
      artifactPublicId: identity.artifactPublicId,
      descriptor,
      writeAttemptPublicId: "write-orphan-reuse",
      vectorChecksumSha256: encoded.checksumSha256,
      semanticGenerationPublicId: "generation-artifact-a",
      operationPublicId: "operation-artifact-a",
      sourceFilePublicId: "file-artifact",
      sourceExcerpt: "Source-grounded orphan reuse excerpt.",
      retentionKind: "active",
      verifiedAt: "2026-08-08T00:00:01.000Z"
    });
    await expect(repository.releaseReferences({
      knowledgeBaseId: "kb-artifact",
      semanticGenerationPublicId: "generation-artifact-a",
      ownerPublicIds: [identity.ownerPublicId],
      releasedAt: "2026-08-08T00:00:02.000Z"
    })).resolves.toBe(1);

    const orphaned = await repository.findCompatible(identity);
    expect(orphaned).toMatchObject({
      publicId: identity.artifactPublicId,
      state: "orphaned"
    });
    await repository.attachReference({
      artifact: orphaned!,
      semanticGenerationPublicId: "generation-artifact-a",
      operationPublicId: "operation-artifact-a",
      sourceFilePublicId: "file-artifact",
      sourceExcerpt: "Source-grounded orphan reuse excerpt.",
      retentionKind: "active"
    });
    await expect(repository.findCompatible(identity)).resolves.toMatchObject({
      state: "verified"
    });
    await expect(repository.releaseReferences({
      knowledgeBaseId: "kb-artifact",
      semanticGenerationPublicId: "generation-artifact-a",
      ownerPublicIds: [identity.ownerPublicId],
      releasedAt: "2026-08-08T00:00:03.000Z"
    })).resolves.toBe(1);
    const cleanup = await repository.claimOrphaned({
      knowledgeBaseId: "kb-artifact",
      artifactPublicId: identity.artifactPublicId,
      claimedAt: "2026-08-08T00:00:04.000Z"
    });
    await expect(repository.completeOrphanDeletion({
      knowledgeBaseId: "kb-artifact",
      artifactPublicId: identity.artifactPublicId,
      descriptor: cleanup?.descriptor ?? null,
      completedAt: "2026-08-08T00:00:05.000Z"
    })).resolves.toBe(true);
  });

  it("registers object, artifact ownership, and reference atomically", async () => {
    const encoded = encodeVectorArtifact({ vector: [0.6, 0.8, 0], normalization: "l2" });
    const descriptor = {
      objectId: `semantic-sha256:semantic-vector-v1:${encoded.checksumSha256}`,
      storageKey: `focowiki/semantic/${encoded.checksumSha256}.bin`,
      checksumSha256: encoded.checksumSha256,
      byteCount: encoded.byteCount,
      contentType: "application/octet-stream" as const,
      objectFormat: "semantic-vector-v1" as const
    };
    const identity = createEmbeddingArtifactIdentity({
      knowledgeBaseId: "kb-artifact",
      ownerKind: "content",
      ownerPublicId: "content-artifact",
      sourceRevisionPublicId: "revision-artifact",
      canonicalInputSha256: "a".repeat(64),
      embeddingConfigurationRevisionPublicId: "embedding-revision-artifact",
      normalization: "l2",
      dimension: 3,
      inputKind: "content"
    });
    await expect(repository.findCompatible(identity)).resolves.toBeNull();
    await expect(repository.reserveObject({
      descriptor,
      writeAttemptPublicId: "write-artifact",
      createdAt: "2026-08-08T00:00:00.000Z"
    })).resolves.toBe("reserved");
    const committed = await repository.commitVerified({
      identity,
      artifactPublicId: identity.artifactPublicId,
      descriptor,
      writeAttemptPublicId: "write-artifact",
      vectorChecksumSha256: encoded.checksumSha256,
      semanticGenerationPublicId: "generation-artifact-a",
      operationPublicId: "operation-artifact-a",
      sourceFilePublicId: "file-artifact",
      sourceExcerpt: "Source-grounded excerpt.",
      retentionKind: "active",
      verifiedAt: "2026-08-08T00:00:01.000Z"
    });
    expect(committed).toMatchObject({ state: "verified", sourceRevisionPublicId: "revision-artifact" });
    await expect(repository.findCompatible(identity)).resolves.toMatchObject({ publicId: identity.artifactPublicId });
    await expect(count("object_owners", "owner_kind = 'embedding_artifact'")).resolves.toBe(1);
    await expect(count("embedding_artifact_owners", "artifact_public_id = $1", [identity.artifactPublicId])).resolves.toBe(1);
    await expect(count("semantic_embedding_artifact_refs", "artifact_public_id = $1", [identity.artifactPublicId])).resolves.toBe(1);

    await repository.attachReference({
      artifact: committed,
      semanticGenerationPublicId: "generation-artifact-b",
      operationPublicId: "operation-artifact-b",
      sourceFilePublicId: "file-artifact",
      sourceExcerpt: "Source-grounded excerpt.",
      retentionKind: "candidate"
    });
    await expect(count("embedding_artifact_owners", "artifact_public_id = $1", [identity.artifactPublicId])).resolves.toBe(2);
    await expect(repository.findCompatible({ ...identity, sourceRevisionPublicId: "revision-artifact-other" }))
      .resolves.toBeNull();
    await sql`UPDATE focowiki.semantic_generations SET state = 'cancelled' WHERE public_id = 'generation-artifact-b'`;
    await expect(repository.attachReference({
      artifact: committed,
      semanticGenerationPublicId: "generation-artifact-b",
      operationPublicId: "operation-artifact-b",
      sourceFilePublicId: "file-artifact",
      sourceExcerpt: "Source-grounded excerpt.",
      retentionKind: "candidate"
    })).rejects.toThrow("stale");

    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.object_registrations (
          object_id, storage_key, checksum_sha256, byte_count, content_type,
          object_format, state, write_attempt_public_id, verified_at
        ) VALUES (
          'source-object-artifact-new', 'sources/artifact-new',
          ${"e".repeat(64)}, 11, 'text/markdown', 'source-markdown-v1',
          'verified', 'source-write-artifact-new', now()
        )
      `;
      await transaction`
        UPDATE focowiki.source_revisions
        SET revision_role = 'rollback',
            expires_at = '2027-08-09T00:00:00.000Z'
        WHERE public_id = 'revision-artifact'
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          public_id, knowledge_base_id, source_file_public_id, object_id,
          checksum_sha256, byte_count, content_type, revision_role
        ) VALUES (
          'revision-artifact-new', 'kb-artifact', 'file-artifact',
          'source-object-artifact-new', ${"e".repeat(64)}, 11,
          'text/markdown', 'current'
        )
      `;
      await transaction`
        UPDATE focowiki.source_file_current_revisions
        SET source_revision_public_id = 'revision-artifact-new',
            revision = revision + 1
        WHERE knowledge_base_id = 'kb-artifact'
          AND source_file_public_id = 'file-artifact'
      `;
    });
    await expect(repository.attachReference({
      artifact: committed,
      semanticGenerationPublicId: "generation-artifact-a",
      operationPublicId: "operation-artifact-a",
      sourceFilePublicId: "file-artifact",
      sourceExcerpt: "Source-grounded excerpt.",
      retentionKind: "active"
    })).rejects.toThrow("stale");

    await expect(repository.releaseReferences({
      knowledgeBaseId: "kb-artifact",
      semanticGenerationPublicId: "generation-artifact-b",
      ownerPublicIds: null,
      releasedAt: "2026-08-08T00:00:02.000Z"
    })).resolves.toBe(0);
    await expect(repository.findCompatible(identity)).resolves.toMatchObject({
      state: "verified"
    });
    await expect(repository.releaseReferences({
      knowledgeBaseId: "kb-artifact",
      semanticGenerationPublicId: "generation-artifact-a",
      ownerPublicIds: ["content-artifact"],
      releasedAt: "2026-08-08T00:00:03.000Z"
    })).resolves.toBe(1);
    const page = await repository.listOrphaned({
      knowledgeBaseId: "kb-artifact", cursor: null, limit: 1
    });
    expect(page.items).toEqual([expect.objectContaining({
      publicId: identity.artifactPublicId, state: "orphaned"
    })]);
    const claim = await repository.claimOrphaned({
      knowledgeBaseId: "kb-artifact",
      artifactPublicId: identity.artifactPublicId,
      claimedAt: "2026-08-08T00:00:04.000Z"
    });
    expect(claim?.descriptor).toEqual(descriptor);
    await expect(repository.completeOrphanDeletion({
      knowledgeBaseId: "kb-artifact",
      artifactPublicId: identity.artifactPublicId,
      descriptor,
      completedAt: "2026-08-08T00:00:05.000Z"
    })).resolves.toBe(true);
    await expect(count(
      "embedding_artifacts", "public_id = $1", [identity.artifactPublicId]
    )).resolves.toBe(0);
    await expect(count(
      "object_registrations", "object_id = $1 and state = 'deleted'", [descriptor.objectId]
    )).resolves.toBe(1);
  });

  it("attaches an embedding artifact to a mutation-owned candidate source revision", async () => {
    const encoded = encodeVectorArtifact({
      vector: [0.2, 0.4, 0.8], normalization: "l2"
    });
    const descriptor = descriptorFor(encoded, "mutation-candidate");
    const identity = createEmbeddingArtifactIdentity({
      knowledgeBaseId: "kb-artifact",
      ownerKind: "content",
      ownerPublicId: "content-mutation-candidate",
      sourceRevisionPublicId: "revision-artifact-candidate",
      canonicalInputSha256: "7".repeat(64),
      embeddingConfigurationRevisionPublicId: "embedding-revision-artifact",
      normalization: "l2",
      dimension: 3,
      inputKind: "content"
    });
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        'source-object-artifact-candidate', 'sources/artifact-candidate',
        ${"8".repeat(64)}, 12, 'text/markdown', 'source-markdown-v1',
        'verified', 'source-write-artifact-candidate', now()
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type, revision_role, expires_at
      ) VALUES (
        'revision-artifact-candidate', 'kb-artifact', 'file-artifact',
        'source-object-artifact-candidate', ${"8".repeat(64)}, 12,
        'text/markdown', 'candidate', '2027-08-08T00:00:00.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state
      ) VALUES (
        'operation-artifact-mutation', 'kb-artifact', 'source_replace',
        'processing'
      )
    `;
    await sql`
      INSERT INTO focowiki.runtime_setting_revisions (
        public_id, checksum_sha256, settings_values
      ) VALUES (
        'settings-artifact-mutation', ${"9".repeat(64)}, '{}'::jsonb
      )
    `;
    await sql`
      INSERT INTO focowiki.operation_work_items (
        operation_public_id, knowledge_base_id, work_kind, state,
        operation_revision, settings_revision_public_id, attempt_count,
        checkpoint
      ) VALUES (
        'operation-artifact-mutation', 'kb-artifact', 'mutation', 'queued',
        0, 'settings-artifact-mutation', 0,
        ${sql.json({
          version: 1,
          kind: "source_replace",
          candidateRevisionPublicId: "revision-artifact-candidate"
        })}
      )
    `;
    await expect(repository.reserveObject({
      descriptor,
      writeAttemptPublicId: "write-artifact-mutation-candidate",
      createdAt: "2026-08-08T00:00:00.000Z"
    })).resolves.toBe("reserved");

    await expect(repository.commitVerified({
      identity,
      artifactPublicId: identity.artifactPublicId,
      descriptor,
      writeAttemptPublicId: "write-artifact-mutation-candidate",
      vectorChecksumSha256: encoded.checksumSha256,
      semanticGenerationPublicId: "generation-artifact-a",
      operationPublicId: "operation-artifact-mutation",
      sourceFilePublicId: "file-artifact",
      sourceExcerpt: "Source-grounded excerpt.",
      retentionKind: "candidate",
      verifiedAt: "2026-08-08T00:00:01.000Z"
    })).resolves.toMatchObject({
      sourceRevisionPublicId: "revision-artifact-candidate",
      state: "verified"
    });
  });

  async function seed() {
    await sql`INSERT INTO focowiki.knowledge_bases (public_id, name, revision) VALUES ('kb-artifact', 'Artifact KB', 1)`;
    for (const suffix of ["a", "b"]) {
      await sql`
        INSERT INTO focowiki.operations (
          public_id, knowledge_base_id, operation_kind, state, completed_at
        ) VALUES (
          ${`operation-artifact-${suffix}`}, 'kb-artifact', 'maintenance',
          ${suffix === "b" ? "processing" : "completed"},
          ${suffix === "b" ? null : "2026-08-08T00:00:00.000Z"}
        )
      `;
      await sql`
        INSERT INTO focowiki.semantic_generations (
          public_id, knowledge_base_id, operation_public_id, generation_role,
          state, generation_model_configuration_public_id,
          generation_model_configuration_revision,
          extraction_contract_version, graph_schema_version,
          prompt_contract_version, contract_fingerprint_sha256, activated_at, revision
        ) VALUES (
          ${`generation-artifact-${suffix}`}, 'kb-artifact', ${`operation-artifact-${suffix}`},
          ${suffix === "a" ? "active" : "candidate"},
          ${suffix === "a" ? "active" : "building"},
          'model-config-test', 1, 'extract-v1', 'graph-v1', 'prompt-v1', ${suffix.repeat(64)},
          ${suffix === "a" ? "2026-08-08T00:00:00.000Z" : null}, 0
        )
      `;
    }
    await sql`INSERT INTO focowiki.embedding_configurations (public_id, display_name, lifecycle_status, revision) VALUES ('embedding-artifact', 'Embedding artifact', 'active', 1)`;
    await sql`
      INSERT INTO focowiki.embedding_configuration_revisions (
        public_id, configuration_public_id, revision_number, authentication_mode,
        base_url, model_name, requested_dimension, resolved_dimension,
        normalization, maximum_input_tokens, batch_size, timeout_ms, retry_count,
        minimum_interval_ms, concurrency, maximum_response_bytes,
        minimum_vector_relevance, vector_producing_revision_public_id,
        validation_status, validation_fingerprint_sha256, validated_at
      ) VALUES (
        'embedding-revision-artifact', 'embedding-artifact', 1, 'none',
        'http://embedding.local/v1', 'embedding-model', 3, 3, 'l2',
        8192, 16, 5000, 1, 0, 2, 1048576, 0.7,
        'embedding-revision-artifact', 'valid', ${"c".repeat(64)}, now()
      )
    `;
    await sql`UPDATE focowiki.embedding_configurations SET active_revision_public_id = 'embedding-revision-artifact' WHERE public_id = 'embedding-artifact'`;
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        'source-object-artifact', 'sources/artifact', ${"d".repeat(64)}, 10,
        'text/markdown', 'source-markdown-v1', 'verified', 'source-write-artifact', now()
      )
    `;
    await sql`INSERT INTO focowiki.source_files (public_id, knowledge_base_id, logical_path, normalized_path, title, status, revision) VALUES ('file-artifact', 'kb-artifact', 'artifact.md', 'artifact.md', 'Artifact', 'ready', 1)`;
    await sql`INSERT INTO focowiki.source_revisions (public_id, knowledge_base_id, source_file_public_id, object_id, checksum_sha256, byte_count, content_type, revision_role) VALUES ('revision-artifact', 'kb-artifact', 'file-artifact', 'source-object-artifact', ${"d".repeat(64)}, 10, 'text/markdown', 'current')`;
    await sql`INSERT INTO focowiki.source_file_current_revisions (knowledge_base_id, source_file_public_id, source_revision_public_id, revision) VALUES ('kb-artifact', 'file-artifact', 'revision-artifact', 1)`;
  }

  async function count(table: string, where: string, parameters: string[] = []): Promise<number> {
    if (!/^[a-z_]+$/u.test(table) || !/^[a-z_ ='.\$0-9]+$/u.test(where)) throw new Error("Unsafe query");
    const rows = await sql.unsafe<Array<{ count: string }>>(
      `SELECT count(*) AS count FROM focowiki.${table} WHERE ${where}`,
      parameters
    );
    return Number(rows[0]?.count ?? 0);
  }
});

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
