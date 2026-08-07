import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPostgresStorageVnextSearchProjectionRepository
} from "../src/storage-vnext/search/postgres-repository.js";
import {
  createPostgresStorageVnextSearchHydration
} from "../src/storage-vnext/search/postgres-hydration.js";
import {
  createPostgresStorageVnextSearchCleanupRepository
} from "../src/storage-vnext/search/postgres-cleanup-repository.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(
  databaseUrl && runOwner && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedDatabase = hasOwnedTarget ? describe : describe.skip;

describeOwnedDatabase("storage vNext search projection repository", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const ownerToken = (runOwner ?? "invalid").replaceAll("-", "_");
  const databaseName = `focowiki_vnext_search_${ownerToken}_${
    randomUUID().replaceAll("-", "").slice(0, 10)
  }`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 2 });
  const repository = createPostgresStorageVnextSearchProjectionRepository(sql);
  const hydration = createPostgresStorageVnextSearchHydration(sql);
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await sql.unsafe(readFileSync(
      resolve(import.meta.dirname, "../migrations/001_storage_vnext.sql"),
      "utf8"
    ));
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES
        ('kb-a', 'Knowledge base A', 1),
        ('kb-b', 'Knowledge base B', 1),
        ('kb-c', 'Knowledge base C', 1)
    `;
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        'object-source-a', 'owned/source-a', ${"1".repeat(64)}, 10,
        'text/markdown', 'source-markdown', 'verified', 'write-source-a', now()
      )
    `;
    await sql`
      INSERT INTO focowiki.source_files (
        public_id, knowledge_base_id, logical_path, normalized_path,
        title, status, revision
      ) VALUES (
        'source-a', 'kb-a', 'guides/a.md', 'guides/a.md', 'Guide A', 'ready', 1
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type, revision_role
      ) VALUES (
        'revision-source-a', 'kb-a', 'source-a', 'object-source-a',
        ${"1".repeat(64)}, 10, 'text/markdown', 'current'
      )
    `;
    await sql`
      INSERT INTO focowiki.source_file_current_revisions (
        knowledge_base_id, source_file_public_id, source_revision_public_id, revision
      ) VALUES ('kb-a', 'source-a', 'revision-source-a', 1)
    `;
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
      );
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("reserves one exact replayable unified candidate per knowledge base", async () => {
    const first = await repository.reserveCandidate(candidate("candidate-a"));
    const replay = await repository.reserveCandidate({
      ...candidate("candidate-a"),
      providerIndexUid: "owned_candidate-a_retry-proposal"
    });

    expect(first.outcome).toBe("created");
    expect(replay.outcome).toBe("existing");
    expect(replay.projection.providerIndexUid).toBe("owned_candidate-a");
    await expect(
      repository.reserveCandidate(candidate("candidate-b"))
    ).rejects.toMatchObject({
      code: "candidate_exists"
    });
  });

  it("converges concurrent exact candidate reservations", async () => {
    const input = candidate("candidate-concurrent", "kb-b");
    const outcomes = await Promise.all([
      repository.reserveCandidate(input),
      repository.reserveCandidate(input)
    ]);

    expect(outcomes.map((result) => result.outcome).sort())
      .toEqual(["created", "existing"]);
  });

  it("hydrates only current source identities with released logical paths", async () => {
    await expect(hydration.hydrateCurrentSources({
      knowledgeBaseId: "kb-a",
      sourceFilePublicIds: ["source-a", "missing-source"]
    })).resolves.toEqual([{
      sourceFilePublicId: "source-a",
      sourceRevisionPublicId: "revision-source-a",
      logicalPath: "pages/guides/a.md",
      title: "Guide A"
    }]);
    await expect(hydration.hydrateCurrentSources({
      knowledgeBaseId: "kb-b",
      sourceFilePublicIds: ["source-a"]
    })).resolves.toEqual([]);
  });

  it("persists provider operation correlation and resumes the same operation", async () => {
    const started = await repository.beginProviderOperation({
      candidatePublicId: "candidate-a",
      correlationPublicId: "create-candidate-a"
    });
    await repository.recordProviderOperation({
      candidatePublicId: "candidate-a",
      correlationPublicId: "create-candidate-a",
      providerOperationRef: "meilisearch:41"
    });
    const resumed = await repository.beginProviderOperation({
      candidatePublicId: "candidate-a",
      correlationPublicId: "create-candidate-a"
    });

    expect(started).toEqual({ outcome: "start", providerOperationRef: null });
    expect(resumed).toEqual({
      outcome: "resume",
      providerOperationRef: "meilisearch:41"
    });
    await repository.completeProviderOperation({
      candidatePublicId: "candidate-a",
      correlationPublicId: "create-candidate-a"
    });
    await repository.markCandidateIndexing("candidate-a");
  });

  it("enforces ordered, checksum-bound, idempotent document batches", async () => {
    const checksum = "d".repeat(64);
    const started = await repository.beginDocumentBatch({
      candidatePublicId: "candidate-a",
      batchOrdinal: 0,
      payloadChecksum: checksum,
      correlationPublicId: "batch-candidate-a-0"
    });
    await repository.recordProviderOperation({
      candidatePublicId: "candidate-a",
      correlationPublicId: "batch-candidate-a-0",
      providerOperationRef: "meilisearch:52"
    });
    const resumed = await repository.beginDocumentBatch({
      candidatePublicId: "candidate-a",
      batchOrdinal: 0,
      payloadChecksum: checksum,
      correlationPublicId: "batch-candidate-a-0"
    });
    await repository.completeDocumentBatch({
      candidatePublicId: "candidate-a",
      batchOrdinal: 0,
      payloadChecksum: checksum,
      correlationPublicId: "batch-candidate-a-0",
      documentCount: 3
    });
    const replay = await repository.beginDocumentBatch({
      candidatePublicId: "candidate-a",
      batchOrdinal: 0,
      payloadChecksum: checksum,
      correlationPublicId: "batch-candidate-a-0"
    });

    expect(started).toEqual({ outcome: "start", providerOperationRef: null });
    expect(resumed).toEqual({
      outcome: "resume",
      providerOperationRef: "meilisearch:52"
    });
    expect(replay).toEqual({ outcome: "completed", providerOperationRef: null });
    expect(await repository.getCandidate("candidate-a")).toMatchObject({
      documentCount: 3,
      nextBatchOrdinal: 1,
      lastBatchOrdinal: 0,
      lastBatchChecksum: checksum
    });
    await expect(repository.beginDocumentBatch({
      candidatePublicId: "candidate-a",
      batchOrdinal: 0,
      payloadChecksum: "e".repeat(64),
      correlationPublicId: "batch-candidate-a-0-other"
    })).rejects.toMatchObject({ code: "batch_conflict" });

    const documentChecksum = "f".repeat(64);
    await expect(repository.beginCandidateValidation({
      candidatePublicId: "candidate-a",
      expectedDocumentCount: 3,
      documentChecksum,
      schemaChecksum: "a".repeat(64),
      settingsChecksum: "b".repeat(64)
    })).resolves.toEqual({ outcome: "validate" });
    expect(await repository.getCandidate("candidate-a")).toMatchObject({
      state: "validating",
      documentChecksum
    });
    await repository.completeCandidateValidation({
      candidatePublicId: "candidate-a",
      documentChecksum
    });
    expect(await repository.getCandidate("candidate-a")).toMatchObject({
      state: "ready",
      documentChecksum
    });
  });

  it("leases failed cleanup and active compaction through durable provider tasks", async () => {
    const cleanup = createPostgresStorageVnextSearchCleanupRepository(sql);
    await repository.reserveCandidate(candidate("candidate-cleanup", "kb-c"));
    await repository.failCandidateValidation({
      candidatePublicId: "candidate-cleanup",
      safeErrorCode: "candidate_checksum_mismatch"
    });
    await sql`
      UPDATE focowiki.search_projections
      SET updated_at = '2020-08-01T00:00:00.000Z'
      WHERE public_id = 'candidate-cleanup'
    `;

    const failed = await cleanup.claimFailedCandidate({
      failedBefore: "2021-08-01T00:00:00.000Z",
      correlationPublicId: "cleanup-cycle-c",
      providerKind: "meilisearch"
    });
    expect(failed).toMatchObject({
      publicId: "candidate-cleanup",
      correlationPublicId: "cleanup-cycle-c",
      providerKind: "meilisearch",
      providerOperationRef: null
    });
    await cleanup.recordCleanupOperation({
      projectionPublicId: "candidate-cleanup",
      correlationPublicId: "cleanup-cycle-c",
      providerOperationRef: "meilisearch:701"
    });
    await cleanup.clearCleanupOperation({
      projectionPublicId: "candidate-cleanup",
      correlationPublicId: "cleanup-cycle-c",
      providerOperationRef: "meilisearch:701"
    });
    await expect(cleanup.claimFailedCandidate({
      failedBefore: "2021-08-01T00:00:00.000Z",
      correlationPublicId: "cleanup-cycle-c",
      providerKind: "meilisearch"
    })).resolves.toMatchObject({ providerOperationRef: null });
    await cleanup.completeFailedCandidateCleanup({
      candidatePublicId: "candidate-cleanup",
      correlationPublicId: "cleanup-cycle-c"
    });
    await expect(repository.getCandidate("candidate-cleanup")).resolves.toBeNull();

    await repository.reserveCandidate(candidate("candidate-active", "kb-c"));
    await repository.markCandidateIndexing("candidate-active");
    await repository.beginCandidateValidation({
      candidatePublicId: "candidate-active",
      expectedDocumentCount: 0,
      documentChecksum: "c".repeat(64),
      schemaChecksum: "a".repeat(64),
      settingsChecksum: "b".repeat(64)
    });
    await repository.completeCandidateValidation({
      candidatePublicId: "candidate-active",
      documentChecksum: "c".repeat(64)
    });
    await sql`
      UPDATE focowiki.search_projections
      SET projection_role = 'active'
      WHERE public_id = 'candidate-active'
    `;
    await expect(cleanup.listRetainedProviderIndexUids({
      providerKind: "meilisearch",
      providerIndexUids: ["owned_candidate-active", "owned_missing"]
    })).resolves.toEqual(["owned_candidate-active"]);

    const active = await cleanup.claimActiveCompaction({
      compactedBefore: "2099-08-01T00:00:00.000Z",
      correlationPublicId: "compaction-cycle-c"
    });
    expect(active).toMatchObject({
      publicId: "candidate-active",
      correlationPublicId: "compaction-cycle-c",
      providerKind: "meilisearch",
      providerOperationRef: null
    });
    await cleanup.recordCleanupOperation({
      projectionPublicId: "candidate-active",
      correlationPublicId: "compaction-cycle-c",
      providerOperationRef: "meilisearch:702"
    });
    await cleanup.completeCompaction({
      projectionPublicId: "candidate-active",
      correlationPublicId: "compaction-cycle-c",
      databaseSizeBytes: 70,
      usedDatabaseSizeBytes: 60
    });
    const rows = await sql<Array<{
      last_compacted_at: Date | string | null;
      last_database_size_bytes: number | string | null;
      last_used_database_size_bytes: number | string | null;
      correlation_public_id: string | null;
      provider_operation_ref: string | null;
    }>>`
      SELECT maintenance.last_compacted_at,
             maintenance.last_database_size_bytes,
             maintenance.last_used_database_size_bytes,
             projection.correlation_public_id,
             projection.provider_operation_ref
      FROM focowiki.search_projections AS projection
      JOIN focowiki.meilisearch_projection_maintenance AS maintenance
        ON maintenance.projection_public_id = projection.public_id
      WHERE projection.public_id = 'candidate-active'
    `;
    expect(rows[0]).toMatchObject({
      last_database_size_bytes: "70",
      last_used_database_size_bytes: "60",
      correlation_public_id: null,
      provider_operation_ref: null
    });
    expect(rows[0]?.last_compacted_at).not.toBeNull();
  });

  function candidate(publicId: string, knowledgeBaseId = "kb-a") {
    return {
      publicId,
      knowledgeBaseId,
      providerKind: "meilisearch" as const,
      providerIndexUid: `owned_${publicId}`,
      schemaChecksum: "a".repeat(64),
      settingsChecksum: "b".repeat(64)
    };
  }
});

function databaseConnectionUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
