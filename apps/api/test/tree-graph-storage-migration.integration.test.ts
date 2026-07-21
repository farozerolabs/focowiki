import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  readMigrationSql,
  RUNTIME_SCHEMA_GENERATION
} from "../src/db/migrations.js";
import { createPostgresActiveGenerationReadRepository } from "../src/infrastructure/postgres/active-generation-read-repository.js";
import { createPostgresImmutableObjectRepository } from "../src/infrastructure/postgres/immutable-object-repository.js";
import { createPostgresProjectionRepairRepository } from "../src/infrastructure/postgres/projection-repair-repository.js";
import { createPostgresPublicationGenerationRepository } from "../src/infrastructure/postgres/publication-generation-repository.js";
import { createPostgresStorageReconciliationRepository } from "../src/infrastructure/postgres/storage-reconciliation-repository.js";
import { createImmutableObjectKey } from "../src/domain/generation.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("tree, graph, and storage compatible migration integration", () => {
  const connectionUrl = databaseUrl ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_migration_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const adminUrl = databaseConnectionUrl(connectionUrl, "postgres");
  const testUrl = databaseConnectionUrl(connectionUrl, databaseName);
  const admin = postgres(adminUrl, { max: 1 });
  const sql = postgres(testUrl, { max: 2 });
  let before: Awaited<ReturnType<typeof releasedSnapshot>>;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await sql.unsafe(readMigrationSql("001_production_admin_web.sql"));
    await seedReleasedSchema(sql);
    before = await releasedSnapshot(sql);
    await applyMigrations(sql);
    await applyMigrations(sql);
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  it("preserves released data and active reads while upgrading in place", async () => {
    const after = await releasedSnapshot(sql);
    expect(after).toEqual(before);
    expect(after.model).toMatchObject({
      id: "model-released-migration",
      model_name: "fixture-model",
      is_active: true
    });
    expect(after.projectionKinds).toEqual([
      "graph_edge",
      "graph_node",
      "search",
      "tree"
    ]);
    expect(after.generationReferences).toEqual([
      {
        ref_kind: "page",
        ref_key: "source-file-released",
        logical_path: "pages/guides/released.md"
      }
    ]);
    expect((await sql<Array<{ generation: string }>>`
      SELECT generation FROM focowiki.runtime_generation WHERE singleton = true
    `)[0]?.generation).toBe(RUNTIME_SCHEMA_GENERATION);

    const migratedObjects = await sql<Array<{
      lifecycle_state: string;
      write_token: string | null;
      integrity_error_code: string | null;
    }>>`
      SELECT lifecycle_state, write_token, integrity_error_code
      FROM focowiki.immutable_objects
      WHERE checksum_sha256 = ${"ab".repeat(32)} AND format_version = 1
    `;
    expect(migratedObjects).toEqual([{
      lifecycle_state: "active",
      write_token: null,
      integrity_error_code: null
    }]);

    const generations = await sql<Array<{ generation_kind: string }>>`
      SELECT generation_kind
      FROM focowiki.publication_generations
      WHERE id = 'generation-released-active'
    `;
    expect(generations).toEqual([{ generation_kind: "normal" }]);

    const repository = createPostgresActiveGenerationReadRepository(sql);
    const active = await repository.withActiveGeneration(
      "kb-released-migration",
      async (scope) => ({
        generationId: scope.generationId,
        file: await scope.findFileById("source-file-released")
      })
    );
    expect(active).toMatchObject({
      generationId: "generation-released-active",
      file: {
        fileId: "source-file-released",
        path: "pages/guides/released.md",
        objectKey: "test/generated/v1/objects/ab/" + "ab".repeat(32)
      }
    });
  });

  it("repairs legacy tree statistics idempotently and retries after a newer activation", async () => {
    const repair = createPostgresProjectionRepairRepository(sql);
    const bootstrappedAt = "2026-07-18T13:00:00.000Z";
    expect(await repair.bootstrap({ repairVersion: 1, bootstrappedAt })).toBe(1);
    expect(await repair.bootstrap({ repairVersion: 1, bootstrappedAt })).toBe(0);

    let job = await repair.claim({
      repairVersion: 1,
      leaseToken: "repair-lease-released",
      leaseExpiresAt: "2099-07-18T13:10:00.000Z",
      targetGenerationId: "generation-repair-released",
      claimedAt: "2026-07-18T13:00:01.000Z"
    });
    expect(job).toMatchObject({
      knowledgeBaseId: "kb-released-migration",
      baseGenerationId: "generation-released-active",
      targetGenerationId: "generation-repair-released"
    });
    job = await repair.claim({
      repairVersion: 1,
      leaseToken: "repair-lease-released",
      leaseExpiresAt: "2099-07-18T13:10:01.000Z",
      targetGenerationId: "generation-repair-must-not-replace-active-slice",
      claimedAt: "2026-07-18T13:00:02.000Z"
    });
    expect(job).toMatchObject({
      targetGenerationId: "generation-repair-released",
      attemptCount: 1
    });
    const publicationProgress = createPostgresPublicationGenerationRepository(sql);
    await expect(publicationProgress.getProgressSummary({
      knowledgeBaseId: "kb-released-migration"
    })).resolves.toMatchObject({ generationId: null, stage: null });

    const page = await repair.listTreePage({
      job: job!,
      leaseToken: "repair-lease-released",
      limit: 100
    });
    expect(page.find((record) => record.recordId === "directory:pages")?.payload).toMatchObject({
      directEntryCount: 1,
      directDirectoryCount: 1,
      directFileCount: 0,
      descendantFileCount: 1
    });
    expect(page.find((record) => record.recordId === "directory:pages/guides")?.payload).toMatchObject({
      directEntryCount: 1,
      directDirectoryCount: 0,
      directFileCount: 1,
      descendantFileCount: 1
    });
    expect(page.find((record) => record.recordId === "source-file-released")?.payload).toMatchObject({
      directEntryCount: 0,
      directDirectoryCount: 0,
      directFileCount: 0,
      descendantFileCount: 0
    });
    expect(JSON.stringify(page)).not.toContain("childCount");

    const reads = createPostgresActiveGenerationReadRepository(sql);
    await expect(reads.withActiveGeneration("kb-released-migration", async (scope) => ({
      generationId: scope.generationId,
      file: await scope.findFileById("source-file-released")
    }))).resolves.toMatchObject({
      generationId: "generation-released-active",
      file: { fileId: "source-file-released", path: "pages/guides/released.md" }
    });
    await sql`
      UPDATE focowiki.knowledge_bases
      SET deleted_at = '2026-07-18T13:00:30.000Z'
      WHERE id = 'kb-released-migration'
    `;
    expect(await repair.listTreePage({
      job: job!,
      leaseToken: "repair-lease-released",
      limit: 100
    })).toEqual([]);
    await sql`
      UPDATE focowiki.knowledge_bases
      SET deleted_at = NULL
      WHERE id = 'kb-released-migration'
    `;

    await sql.begin(async (transaction) => {
      await transaction`
        UPDATE focowiki.publication_generations
        SET state = 'superseded', updated_at = '2026-07-18T13:01:00.000Z'
        WHERE id = 'generation-released-active'
      `;
      await transaction`
        INSERT INTO focowiki.publication_generations (
          id, knowledge_base_id, predecessor_generation_id, state,
          format_version, generation_kind, activated_at
        ) VALUES (
          'generation-normal-winner', 'kb-released-migration',
          'generation-released-active', 'active', 1, 'normal',
          '2026-07-18T13:01:00.000Z'
        )
      `;
      await transaction`
        UPDATE focowiki.knowledge_bases
        SET active_generation_id = 'generation-normal-winner'
        WHERE id = 'kb-released-migration'
      `;
    });

    expect(await repair.listTreePage({
      job: job!,
      leaseToken: "repair-lease-released",
      limit: 100
    })).toEqual([]);
    await repair.retryFromLatest({
      job: job!,
      leaseToken: "repair-lease-released",
      errorCode: "PROJECTION_REPAIR_SUPERSEDED",
      retryAt: "2026-07-18T13:02:00.000Z",
      failedAt: "2026-07-18T13:01:01.000Z",
      maxAttempts: 5
    });

    const [state] = await sql<Array<{
      state: string;
      base_generation_id: string;
      target_generation_id: string | null;
      checkpoint_json: unknown;
    }>>`
      SELECT state, base_generation_id, target_generation_id, checkpoint_json
      FROM focowiki.knowledge_base_projection_repairs
      WHERE knowledge_base_id = 'kb-released-migration' AND repair_version = 1
    `;
    expect(state).toEqual({
      state: "retry",
      base_generation_id: "generation-normal-winner",
      target_generation_id: null,
      checkpoint_json: {}
    });
    expect((await sql<Array<{ state: string }>>`
      SELECT state FROM focowiki.publication_generations
      WHERE id = 'generation-repair-released'
    `)[0]?.state).toBe("superseded");
    await expect(reads.withActiveGeneration("kb-released-migration", async (scope) => ({
      generationId: scope.generationId,
      file: await scope.findFileById("source-file-released")
    }))).resolves.toMatchObject({
      generationId: "generation-normal-winner",
      file: { fileId: "source-file-released", path: "pages/guides/released.md" }
    });
  });

  it("serializes immutable reservations with reconciliation deletion authorization", async () => {
    const objects = createPostgresImmutableObjectRepository(sql);
    const reconciliation = createPostgresStorageReconciliationRepository(sql);
    const prefix = "test/generated/";
    const cycleId = "cycle-identity-fence";
    const leaseToken = "lease-identity-fence";
    const deletingChecksum = "ef".repeat(32);
    const deletingKey = createImmutableObjectKey({
      prefix: "test",
      checksumSha256: deletingChecksum,
      formatVersion: 1
    });
    await sql`
      INSERT INTO focowiki.storage_reconciliation_cycles (
        prefix, cycle_id, state, lease_token, lease_expires_at, next_scan_at
      ) VALUES (
        ${prefix}, ${cycleId}, 'verifying', ${leaseToken},
        '2026-07-18T14:30:00.000Z', '2026-07-18T14:00:00.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.storage_reconciliation_candidates (
        prefix, object_key, checksum_sha256, format_version, state,
        first_seen_cycle_id, last_seen_cycle_id, confirmation_count,
        first_seen_at, last_seen_at, observed_size_bytes, observed_etag,
        attempt_count, next_attempt_at
      ) VALUES (
        ${prefix}, ${deletingKey}, ${deletingChecksum}, 1, 'deleting',
        ${cycleId}, ${cycleId}, 2, '2026-07-16T14:00:00.000Z',
        '2026-07-18T14:00:00.000Z', 20, 'etag-delete', 1,
        '2026-07-18T14:00:00.000Z'
      )
    `;

    expect(await reconciliation.authorizeCandidateDeletion({
      cycle: {
        prefix,
        cycleId,
        state: "verifying",
        continuationToken: null,
        verificationCursor: null
      },
      leaseToken,
      objectKey: deletingKey,
      checksumSha256: deletingChecksum,
      formatVersion: 1,
      authorizedAt: "2026-07-18T14:00:01.000Z"
    })).toBe(true);
    await expect(objects.reserve({
      checksumSha256: deletingChecksum,
      formatVersion: 1,
      objectKey: deletingKey,
      contentType: "text/markdown",
      sizeBytes: 20,
      writeToken: "write-during-delete",
      writeStartedAt: "2026-07-18T14:00:02.000Z",
      staleBefore: "2026-07-18T13:55:02.000Z"
    })).resolves.toEqual({ status: "deleting", record: null });

    await reconciliation.completeCandidateDeletion({
      prefix,
      objectKey: deletingKey,
      completedAt: "2026-07-18T14:00:03.000Z"
    });
    await expect(objects.reserve({
      checksumSha256: deletingChecksum,
      formatVersion: 1,
      objectKey: deletingKey,
      contentType: "text/markdown",
      sizeBytes: 20,
      writeToken: "write-after-delete",
      writeStartedAt: "2026-07-18T14:00:04.000Z",
      staleBefore: "2026-07-18T13:55:04.000Z"
    })).resolves.toMatchObject({ status: "reserved" });

    const registeredChecksum = "12".repeat(32);
    const registeredKey = createImmutableObjectKey({
      prefix: "test",
      checksumSha256: registeredChecksum,
      formatVersion: 1
    });
    await sql`
      INSERT INTO focowiki.storage_reconciliation_candidates (
        prefix, object_key, checksum_sha256, format_version, state,
        first_seen_cycle_id, last_seen_cycle_id, confirmation_count,
        first_seen_at, last_seen_at, observed_size_bytes, observed_etag,
        attempt_count, next_attempt_at
      ) VALUES (
        ${prefix}, ${registeredKey}, ${registeredChecksum}, 1, 'quarantined',
        ${cycleId}, ${cycleId}, 2, '2026-07-16T14:00:00.000Z',
        '2026-07-18T14:00:00.000Z', 18, 'etag-register', 0,
        '2026-07-18T14:00:00.000Z'
      )
    `;
    await objects.reserve({
      checksumSha256: registeredChecksum,
      formatVersion: 1,
      objectKey: registeredKey,
      contentType: "text/markdown",
      sizeBytes: 18,
      writeToken: "write-register",
      writeStartedAt: "2026-07-18T14:00:05.000Z",
      staleBefore: "2026-07-18T13:55:05.000Z"
    });
    const claimed = await reconciliation.claimDeletionCandidates({
      cycle: {
        prefix,
        cycleId,
        state: "verifying",
        continuationToken: null,
        verificationCursor: null
      },
      leaseToken,
      now: "2026-07-18T14:00:06.000Z",
      graceBefore: "2026-07-18T14:00:06.000Z",
      confirmationPasses: 2,
      maxAttempts: 5,
      limit: 100
    });
    expect(claimed).toEqual([]);
    expect((await sql<Array<{ state: string }>>`
      SELECT state FROM focowiki.storage_reconciliation_candidates
      WHERE prefix = ${prefix} AND object_key = ${registeredKey}
    `)[0]?.state).toBe("resolved");
  });

  it("records one bounded reconciliation page with a bulk upsert", async () => {
    const reconciliation = createPostgresStorageReconciliationRepository(sql);
    const prefix = "test/bulk/generated/";
    const claimed = await reconciliation.claimCycle({
      prefix,
      cycleId: "cycle-bulk-page",
      leaseToken: "lease-bulk-page",
      now: "2026-07-18T16:00:00.000Z",
      leaseExpiresAt: "2026-07-18T16:10:00.000Z"
    });
    expect(claimed).toMatchObject({ state: "scanning", continuationToken: null });

    const objects = Array.from({ length: 1_000 }, (_, index) => {
      const checksumSha256 = index.toString(16).padStart(64, "0");
      return {
        key: `${prefix}v1/objects/${checksumSha256.slice(0, 2)}/${checksumSha256}`,
        checksumSha256,
        formatVersion: 1,
        sizeBytes: index + 1,
        etag: index % 2 === 0 ? `etag-${index}` : null,
        lastModified: null
      };
    });
    await expect(reconciliation.recordScanPage({
      cycle: claimed!,
      leaseToken: "lease-bulk-page",
      objects,
      nextContinuationToken: null,
      recordedAt: "2026-07-18T16:00:01.000Z"
    })).resolves.toBe(true);

    expect((await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.storage_reconciliation_candidates
      WHERE prefix = ${prefix} AND state = 'quarantined'
    `)[0]?.count).toBe(1_000);
    expect((await sql<Array<{ state: string; listed_count: number; quarantined_count: number }>>`
      SELECT state, listed_count::int AS listed_count,
             quarantined_count::int AS quarantined_count
      FROM focowiki.storage_reconciliation_cycles
      WHERE prefix = ${prefix}
    `)[0]).toEqual({
      state: "verifying",
      listed_count: 1_000,
      quarantined_count: 1_000
    });
  });

  it("refuses to activate a generation that references a writing object", async () => {
    const objects = createPostgresImmutableObjectRepository(sql);
    const generations = createPostgresPublicationGenerationRepository(sql);
    const checksum = "34".repeat(32);
    const objectKey = createImmutableObjectKey({ prefix: "test", checksumSha256: checksum });
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES ('kb-writing-object', 'Writing object guard')
    `;
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, state, format_version, generation_kind,
        frozen_at, validated_at
      ) VALUES (
        'generation-writing-object', 'kb-writing-object', 'validating', 1,
        'normal', '2026-07-18T15:00:00.000Z', '2026-07-18T15:00:01.000Z'
      )
    `;
    await objects.reserve({
      checksumSha256: checksum,
      formatVersion: 1,
      objectKey,
      contentType: "application/json",
      sizeBytes: 32,
      writeToken: "writing-object-token",
      writeStartedAt: "2026-07-18T15:00:00.000Z",
      staleBefore: "2026-07-18T14:55:00.000Z"
    });
    await sql`
      INSERT INTO focowiki.generation_object_refs (
        generation_id, knowledge_base_id, ref_kind, ref_key, file_id,
        action, checksum_sha256, format_version, logical_path
      ) VALUES (
        'generation-writing-object', 'kb-writing-object', 'generation_manifest',
        'root', 'generation-manifest-writing', 'upsert', ${checksum}, 1, NULL
      )
    `;

    await expect(generations.activateGeneration({
      knowledgeBaseId: "kb-writing-object",
      generationId: "generation-writing-object",
      expectedPredecessorGenerationId: null,
      rootManifestChecksumSha256: checksum,
      rootManifestObjectKey: objectKey,
      activatedAt: "2026-07-18T15:00:02.000Z"
    })).rejects.toThrow("unverified immutable object");
    expect((await sql<Array<{ active_generation_id: string | null }>>`
      SELECT active_generation_id FROM focowiki.knowledge_bases
      WHERE id = 'kb-writing-object'
    `)[0]?.active_generation_id).toBeNull();
    expect((await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM focowiki.active_object_refs
      WHERE knowledge_base_id = 'kb-writing-object'
    `)[0]?.count).toBe(0);
  });
});

async function seedReleasedSchema(sql: ReturnType<typeof postgres>): Promise<void> {
  const checksum = "ab".repeat(32);
  const objectKey = `test/generated/v1/objects/ab/${checksum}`;
  await sql.begin(async (transaction) => {
    await transaction`SET CONSTRAINTS ALL DEFERRED`;
    await transaction`
      INSERT INTO focowiki.model_configs (
        id, display_name, base_url, encrypted_api_key, api_key_fingerprint,
        model_name, context_window_tokens, request_max_timeout_ms,
        request_idle_timeout_ms, suggestion_concurrency,
        transient_retry_delay_ms, request_min_interval_ms,
        status, is_active
      ) VALUES (
        'model-released-migration', 'Fixture model',
        'https://model.invalid/v1', 'fixture-encrypted-key',
        ${"ef".repeat(32)}, 'fixture-model', 8192, 30000, 10000, 2,
        1000, 0, 'active', true
      )
    `;
    await transaction`
      INSERT INTO focowiki.knowledge_bases (
        id, name, description, resource_revision, catalog_generation
      ) VALUES (
        'kb-released-migration', 'Released migration', 'Preserved description', 3, 7
      )
    `;
    await transaction`
      INSERT INTO focowiki.source_files (
        id, knowledge_base_id, object_key, content_type, size_bytes,
        checksum_sha256, metadata_json, model_suggestions_json,
        processing_status, processing_stage, generated_output_status,
        name, relative_path, path_key, active_revision_id,
        resource_revision, content_revision
      ) VALUES (
        'source-file-released', 'kb-released-migration',
        'test/knowledge-bases/kb-released-migration/source/released.md',
        'text/markdown', 28, ${"cd".repeat(32)},
        ${transaction.json({ title: "Released source" })},
        ${transaction.json({ title: "Released source", tags: ["migration"] })},
        'completed', 'generation_activation', 'visible',
        'released.md', 'guides/released.md', 'guides/released.md',
        'source-revision-released', 4, 2
      )
    `;
    await transaction`
      INSERT INTO focowiki.source_revisions (
        id, knowledge_base_id, source_file_id, revision, object_key,
        content_type, size_bytes, checksum_sha256, metadata_json, processing_status
      ) VALUES (
        'source-revision-released', 'kb-released-migration', 'source-file-released', 2,
        'test/knowledge-bases/kb-released-migration/source/released.md',
        'text/markdown', 28, ${"cd".repeat(32)},
        ${transaction.json({ title: "Released source" })}, 'completed'
      )
    `;
    await transaction`
      INSERT INTO focowiki.immutable_objects (
        checksum_sha256, format_version, object_key, content_type, size_bytes,
        lifecycle_state, verified_at
      ) VALUES (
        ${checksum}, 1, ${objectKey}, 'text/markdown', 31, 'active',
        '2026-07-01T00:00:00.000Z'
      )
    `;
    await transaction`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, state, format_version,
        root_manifest_checksum_sha256, root_manifest_object_key,
        frozen_at, validated_at, activated_at
      ) VALUES (
        'generation-released-active', 'kb-released-migration', 'active', 1,
        ${checksum}, ${objectKey},
        '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:01.000Z',
        '2026-07-01T00:00:02.000Z'
      )
    `;
    await transaction`
      INSERT INTO focowiki.active_object_refs (
        knowledge_base_id, ref_kind, ref_key, file_id,
        last_changed_generation_id, checksum_sha256, format_version,
        logical_path, source_file_id
      ) VALUES (
        'kb-released-migration', 'page', 'source-file-released',
        'source-file-released', 'generation-released-active', ${checksum}, 1,
        'pages/guides/released.md', 'source-file-released'
      )
    `;
    await transaction`
      INSERT INTO focowiki.active_projection_records (
        knowledge_base_id, projection_kind, record_id,
        last_changed_generation_id, shard_key, logical_path,
        parent_path, sort_key, title, searchable_text, payload_json
      ) VALUES
        (
          'kb-released-migration', 'tree', 'directory:pages',
          'generation-released-active', 'tree/v1/0000', 'pages', '',
          '0:pages', 'pages', 'pages',
          ${transaction.json({ kind: "directory", path: "pages", childCount: 1 })}
        ),
        (
          'kb-released-migration', 'tree', 'directory:pages/guides',
          'generation-released-active', 'tree/v1/0000', 'pages/guides', 'pages',
          '0:guides', 'guides', 'guides',
          ${transaction.json({ kind: "directory", path: "pages/guides", childCount: 1 })}
        ),
        (
          'kb-released-migration', 'tree', 'source-file-released',
          'generation-released-active', 'tree/v1/0000', 'pages/guides/released.md',
          'pages/guides', '1:released.md', 'Released source', 'released source',
          ${transaction.json({
            id: "source-file-released",
            kind: "file",
            path: "pages/guides/released.md",
            childCount: 9
          })}
        ),
        (
          'kb-released-migration', 'search', 'source-file-released',
          'generation-released-active', 'search/v1/0000',
          'pages/guides/released.md', NULL, 'released source',
          'Released source', 'released source migration fixture',
          ${transaction.json({ path: "pages/guides/released.md" })}
        ),
        (
          'kb-released-migration', 'graph_node', 'source-file-released',
          'generation-released-active', 'graph_node/v1/0000',
          'pages/guides/released.md', NULL, 'released source',
          'Released source', 'released source migration fixture',
          ${transaction.json({ sourceFileId: "source-file-released" })}
        ),
        (
          'kb-released-migration', 'graph_edge',
          'source-file-released:source-file-released',
          'generation-released-active', 'graph_edge/v1/0000',
          NULL, NULL, 'released source relation', 'Released relation',
          'released source explicit relation',
          ${transaction.json({
            sourceFileId: "source-file-released",
            relatedSourceFileId: "source-file-released",
            relationType: "explicit_reference"
          })}
        )
    `;
    await transaction`
      UPDATE focowiki.active_projection_records
      SET source_file_id = 'source-file-released',
          related_source_file_id = CASE
            WHEN projection_kind = 'graph_edge' THEN 'source-file-released'
            ELSE NULL
          END
      WHERE knowledge_base_id = 'kb-released-migration'
        AND projection_kind IN ('search', 'graph_node', 'graph_edge')
    `;
    await transaction`
      INSERT INTO focowiki.generation_object_refs (
        generation_id, knowledge_base_id, ref_kind, ref_key, file_id,
        action, checksum_sha256, format_version, logical_path, source_file_id
      ) VALUES (
        'generation-released-active', 'kb-released-migration', 'page',
        'source-file-released', 'source-file-released', 'upsert', ${checksum}, 1,
        'pages/guides/released.md', 'source-file-released'
      )
    `;
    await transaction`
      INSERT INTO focowiki.role_jobs (
        id, role, kind, knowledge_base_id, source_file_id,
        source_revision_id, generation_id, status, completed_at
      ) VALUES (
        'worker-job-released', 'publication', 'publication',
        'kb-released-migration', 'source-file-released',
        'source-revision-released', 'generation-released-active',
        'completed', '2026-07-01T00:00:03.000Z'
      )
    `;
    await transaction`
      INSERT INTO focowiki.runtime_settings (key, value_json, version, source)
      VALUES ('worker', ${transaction.json({ sourceFileConcurrency: 2 })}, 5, 'admin')
    `;
    await transaction`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = 'generation-released-active'
      WHERE id = 'kb-released-migration'
    `;
  });
}

async function releasedSnapshot(sql: ReturnType<typeof postgres>) {
  const [knowledgeBase] = await sql<Array<Record<string, unknown>>>`
    SELECT id, name, description, active_generation_id, resource_revision, catalog_generation
    FROM focowiki.knowledge_bases WHERE id = 'kb-released-migration'
  `;
  const [source] = await sql<Array<Record<string, unknown>>>`
    SELECT id, active_revision_id, relative_path, path_key, checksum_sha256,
           resource_revision, content_revision, generated_output_status
    FROM focowiki.source_files WHERE id = 'source-file-released'
  `;
  const [revision] = await sql<Array<Record<string, unknown>>>`
    SELECT id, source_file_id, revision, object_key, checksum_sha256, processing_status
    FROM focowiki.source_revisions WHERE id = 'source-revision-released'
  `;
  const [object] = await sql<Array<Record<string, unknown>>>`
    SELECT checksum_sha256, format_version, object_key, content_type, size_bytes,
           lifecycle_state, verified_at
    FROM focowiki.immutable_objects
    WHERE checksum_sha256 = ${"ab".repeat(32)} AND format_version = 1
  `;
  const [reference] = await sql<Array<Record<string, unknown>>>`
    SELECT knowledge_base_id, ref_kind, ref_key, file_id,
           last_changed_generation_id, checksum_sha256, format_version,
           logical_path, source_file_id
    FROM focowiki.active_object_refs
    WHERE knowledge_base_id = 'kb-released-migration'
  `;
  const [job] = await sql<Array<Record<string, unknown>>>`
    SELECT id, role, kind, knowledge_base_id, source_file_id,
           source_revision_id, generation_id, status
    FROM focowiki.role_jobs WHERE id = 'worker-job-released'
  `;
  const [setting] = await sql<Array<Record<string, unknown>>>`
    SELECT key, value_json, version, source
    FROM focowiki.runtime_settings WHERE key = 'worker'
  `;
  const [model] = await sql<Array<Record<string, unknown>>>`
    SELECT id, model_name, status, is_active
    FROM focowiki.model_configs
    WHERE id = 'model-released-migration'
  `;
  const projectionKinds = (await sql<Array<{ projection_kind: string }>>`
    SELECT DISTINCT projection_kind
    FROM focowiki.active_projection_records
    WHERE knowledge_base_id = 'kb-released-migration'
    ORDER BY projection_kind
  `).map((row) => row.projection_kind);
  const generationReferences = await sql<Array<{
    ref_kind: string;
    ref_key: string;
    logical_path: string | null;
  }>>`
    SELECT ref_kind, ref_key, logical_path
    FROM focowiki.generation_object_refs
    WHERE knowledge_base_id = 'kb-released-migration'
    ORDER BY ref_kind, ref_key
  `;
  return {
    knowledgeBase,
    source,
    revision,
    object,
    reference,
    job,
    setting,
    model,
    projectionKinds,
    generationReferences
  };
}

function databaseConnectionUrl(value: string, databaseName: string): string {
  const url = new URL(value);
  url.hostname = url.hostname === "postgres" ? "127.0.0.1" : url.hostname;
  if (url.port === "5432" || url.port === "") url.port = process.env.POSTGRES_PORT ?? "55432";
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/u.test(value)) throw new Error("Unsafe database identifier");
  return `"${value}"`;
}
