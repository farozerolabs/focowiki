import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/db/migrations.js";
import { createStoragePageCheckpointId } from "../src/maintenance/storage-reconciliation-chunks.js";
import { createPostgresObjectProtectionRepository } from "../src/infrastructure/postgres/object-protection-repository.js";
import { createPostgresStorageReconciliationRepository } from "../src/infrastructure/postgres/storage-reconciliation-repository.js";
import { runObjectProtectionMaintenanceSlice } from "../src/maintenance/object-protection-maintenance.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("storage object protection integration", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_storage_protection_${process.pid}_${
    randomUUID().replaceAll("-", "").slice(0, 10)
  }`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), {
    max: 1,
    onnotice: () => {}
  });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), {
    max: 3,
    onnotice: () => {}
  });
  const repository = createPostgresStorageReconciliationRepository(sql);
  const protection = createPostgresObjectProtectionRepository(sql);
  const knowledgeBaseId = "kb-storage-object-protection";
  const prefix = "test/protection/";
  const checksums = {
    base: "11".repeat(32),
    delta: "22".repeat(32),
    tombstone: "33".repeat(32),
    compacted: "44".repeat(32),
    manifest: "55".repeat(32),
    retainedRoot: "66".repeat(32),
    legacy: "77".repeat(32),
    generationRoot: "89".repeat(32)
  };

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await applyMigrations(sql);
  }, 120_000);

  beforeEach(async () => {
    await cleanup();
    await seedProtectionLineage();
    await markProtectionReady();
    await runObjectProtectionMaintenanceSlice({
      repository: protection,
      batchSize: 100,
      leaseToken: "storage-protection-test",
      now: () => new Date("2090-07-27T00:00:00.000Z")
    });
  });

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
    await admin.unsafe(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
    );
    await admin.end({ timeout: 5 });
  });

  it("classifies active, retained, legacy, and unreferenced projection objects", async () => {
    const rows = await sql<Array<{
      object_key: string;
      object_kind: string;
      protection_class: string;
    }>>`
      SELECT object_key, object_kind, protection_class
      FROM focowiki.storage_object_protection
      WHERE object_key >= ${prefix} AND object_key < ${`${prefix}\uffff`}
      ORDER BY object_key, object_kind, protection_class
    `;
    const classes = new Map<string, Set<string>>();
    for (const row of rows) {
      const values = classes.get(row.object_key) ?? new Set<string>();
      values.add(`${row.object_kind}:${row.protection_class}`);
      classes.set(row.object_key, values);
    }

    expect([...classes.get(`${prefix}base.json`) ?? []]).toContain("base:active_referenced");
    expect([...classes.get(`${prefix}delta.json`) ?? []]).toContain("delta:retained_referenced");
    expect([...classes.get(`${prefix}tombstone.json`) ?? []]).toContain("tombstone:retained_referenced");
    expect([...classes.get(`${prefix}compacted.json`) ?? []]).toEqual(["compacted:unreferenced"]);
    expect([...classes.get(`${prefix}manifest.json`) ?? []]).toContain("manifest:active_referenced");
    expect([...classes.get(`${prefix}retained-root.json`) ?? []]).toContain("root:retained_referenced");
    expect([...classes.get(`${prefix}legacy.json`) ?? []]).toContain("root:legacy_retained");
    expect([...classes.get(`${prefix}generation-root.json`) ?? []])
      .toContain("manifest:active_referenced");

    const indexed = await protection.lookupIdentities(
      Object.entries(checksums).map(([name, checksumSha256]) => ({
        objectKey: `${prefix}${name === "retainedRoot"
          ? "retained-root"
          : name === "generationRoot" ? "generation-root" : name}.json`,
        checksumSha256,
        formatVersion: name === "legacy" ? 1 : 2
      }))
    );
    expect(indexed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        objectKey: `${prefix}base.json`,
        protected: true,
        dirty: false
      }),
      expect.objectContaining({
        objectKey: `${prefix}delta.json`,
        protected: true,
        dirty: false
      }),
      expect.objectContaining({
        objectKey: `${prefix}tombstone.json`,
        protected: true,
        dirty: false
      }),
      expect.objectContaining({
        objectKey: `${prefix}compacted.json`,
        protected: false,
        dirty: false
      }),
      expect.objectContaining({
        objectKey: `${prefix}generation-root.json`,
        protected: true,
        dirty: false
      })
    ]));
  });

  it("covers every canonical durable protection boundary", async () => {
    const rows = await sql<Array<{
      table_name: string;
      trigger_name: string;
    }>>`
      SELECT DISTINCT event_object_table AS table_name, trigger_name
      FROM information_schema.triggers
      WHERE trigger_schema = 'focowiki'
        AND trigger_name = ANY(ARRAY[
          'source_files_storage_protection_trigger',
          'immutable_objects_storage_protection_trigger',
          'projection_segments_storage_protection_trigger'
        ])
      ORDER BY event_object_table, trigger_name
    `;
    expect(rows).toEqual([
      {
        table_name: "immutable_objects",
        trigger_name: "immutable_objects_storage_protection_trigger"
      },
      {
        table_name: "projection_segments",
        trigger_name: "projection_segments_storage_protection_trigger"
      },
      {
        table_name: "source_files",
        trigger_name: "source_files_storage_protection_trigger"
      }
    ]);

    const referenceTargets = await sql<Array<{
      table_name: string;
      foreign_table_name: string;
    }>>`
      SELECT DISTINCT
        constraint_table.relname AS table_name,
        referenced_table.relname AS foreign_table_name
      FROM pg_constraint constraint_record
      JOIN pg_class constraint_table
        ON constraint_table.oid = constraint_record.conrelid
      JOIN pg_namespace constraint_namespace
        ON constraint_namespace.oid = constraint_table.relnamespace
      JOIN pg_class referenced_table
        ON referenced_table.oid = constraint_record.confrelid
      WHERE constraint_record.contype = 'f'
        AND constraint_namespace.nspname = 'focowiki'
        AND constraint_table.relname = ANY(ARRAY[
          'active_object_refs',
          'generation_object_refs',
          'active_projection_segments',
          'generation_projection_segments'
        ])
        AND referenced_table.relname = ANY(ARRAY[
          'immutable_objects',
          'projection_segments'
        ])
      ORDER BY constraint_table.relname, referenced_table.relname
    `;
    expect(referenceTargets).toEqual([
      {
        table_name: "active_object_refs",
        foreign_table_name: "immutable_objects"
      },
      {
        table_name: "active_projection_segments",
        foreign_table_name: "projection_segments"
      },
      {
        table_name: "generation_object_refs",
        foreign_table_name: "immutable_objects"
      },
      {
        table_name: "generation_projection_segments",
        foreign_table_name: "projection_segments"
      }
    ]);
  });

  it("requires repeated observation and grace before deleting an unreferenced compacted segment", async () => {
    const object = {
      key: `${prefix}compacted.json`,
      checksumSha256: checksums.compacted,
      formatVersion: 2,
      sizeBytes: 64,
      etag: "compacted-etag",
      lastModified: "2026-07-20T00:00:00.000Z"
    };
    const first = await claimScanningCycle("cycle-protection-1", "lease-protection-1", "2026-07-20T00:00:00.000Z");
    await expect(recordBatchedPage({
      reconciliation: repository,
      cycle: first,
      leaseToken: "lease-protection-1",
      objects: [object],
      nextContinuationToken: null,
      recordedAt: "2026-07-20T00:00:01.000Z"
    })).resolves.toBe(true);
    await expect(repository.claimDeletionCandidates({
      cycle: { ...first, state: "verifying" },
      leaseToken: "lease-protection-1",
      now: "2026-07-20T00:00:02.000Z",
      staleDeletingBefore: "2026-07-19T23:55:02.000Z",
      graceBefore: "2026-07-20T00:00:02.000Z",
      confirmationPasses: 2,
      maxAttempts: 3,
      limit: 10
    })).resolves.toEqual([]);
    await repository.finishCycle({
      cycle: { ...first, state: "verifying" },
      leaseToken: "lease-protection-1",
      nextScanAt: "2026-07-20T00:00:03.000Z",
      completedAt: "2026-07-20T00:00:02.000Z"
    });

    const second = await claimScanningCycle("cycle-protection-2", "lease-protection-2", "2026-07-20T00:00:03.000Z");
    await recordBatchedPage({
      reconciliation: repository,
      cycle: second,
      leaseToken: "lease-protection-2",
      objects: [object],
      nextContinuationToken: null,
      recordedAt: "2026-07-20T00:00:04.000Z"
    });
    const verifying = { ...second, state: "verifying" as const };
    await expect(repository.claimDeletionCandidates({
      cycle: verifying,
      leaseToken: "lease-protection-2",
      now: "2026-07-20T00:00:05.000Z",
      staleDeletingBefore: "2026-07-19T23:55:05.000Z",
      graceBefore: "2026-07-19T23:59:59.000Z",
      confirmationPasses: 2,
      maxAttempts: 3,
      limit: 10
    })).resolves.toEqual([]);

    const candidates = await repository.claimDeletionCandidates({
      cycle: verifying,
      leaseToken: "lease-protection-2",
      now: "2026-07-20T00:00:05.000Z",
      staleDeletingBefore: "2026-07-19T23:55:05.000Z",
      graceBefore: "2026-07-20T00:00:02.000Z",
      confirmationPasses: 2,
      maxAttempts: 3,
      limit: 10
    });
    expect(candidates).toEqual([expect.objectContaining({
      key: object.key,
      confirmationCount: 2,
      attemptCount: 1
    })]);
    await expect(repository.authorizeCandidateDeletion({
      cycle: verifying,
      leaseToken: "lease-protection-2",
      objectKey: object.key,
      checksumSha256: object.checksumSha256,
      formatVersion: object.formatVersion,
      authorizedAt: "2026-07-20T00:00:06.000Z"
    })).resolves.toBe(true);
    await repository.completeCandidateDeletion({
      cycle: verifying,
      leaseToken: "lease-protection-2",
      objectKey: object.key,
      completedAt: "2026-07-20T00:00:07.000Z"
    });

    expect((await sql<Array<{ lifecycle_state: string }>>`
      SELECT lifecycle_state FROM focowiki.projection_segments
      WHERE id = 'segment-protection-compacted'
    `)[0]?.lifecycle_state).toBe("deleted");
  });

  it("counts candidates missing from a later complete scan as resolved", async () => {
    const object = {
      key: `${prefix}compacted.json`,
      checksumSha256: checksums.compacted,
      formatVersion: 2,
      sizeBytes: 64,
      etag: "compacted-etag",
      lastModified: "2026-07-20T00:00:00.000Z"
    };
    const first = await claimScanningCycle(
      "cycle-resolved-1",
      "lease-resolved-1",
      "2026-07-20T00:00:00.000Z"
    );
    await recordBatchedPage({
      reconciliation: repository,
      cycle: first,
      leaseToken: "lease-resolved-1",
      objects: [object],
      nextContinuationToken: null,
      recordedAt: "2026-07-20T00:00:01.000Z"
    });
    await repository.finishCycle({
      cycle: { ...first, state: "verifying" },
      leaseToken: "lease-resolved-1",
      nextScanAt: "2026-07-20T00:00:02.000Z",
      completedAt: "2026-07-20T00:00:02.000Z"
    });

    const second = await claimScanningCycle(
      "cycle-resolved-2",
      "lease-resolved-2",
      "2026-07-20T00:00:03.000Z"
    );
    await recordBatchedPage({
      reconciliation: repository,
      cycle: second,
      leaseToken: "lease-resolved-2",
      objects: [],
      nextContinuationToken: null,
      recordedAt: "2026-07-20T00:00:04.000Z"
    });

    expect(await repository.getStatus(prefix)).toMatchObject({
      state: "verifying",
      resolvedCount: 1
    });
    expect((await sql<Array<{ state: string }>>`
      SELECT state
      FROM focowiki.storage_reconciliation_candidates
      WHERE prefix = ${prefix}
        AND object_key = ${object.key}
    `)[0]?.state).toBe("resolved");
  });

  it("records a missing protected segment without exposing neighboring objects to deletion", async () => {
    const cycle = await claimScanningCycle("cycle-protection-missing", "lease-protection-missing", "2026-07-20T01:00:00.000Z");
    await recordBatchedPage({
      reconciliation: repository,
      cycle,
      leaseToken: "lease-protection-missing",
      objects: [],
      nextContinuationToken: null,
      recordedAt: "2026-07-20T01:00:01.000Z"
    });
    const verifying = { ...cycle, state: "verifying" as const };
    const registered = await repository.listRegisteredObjectsForVerification({
      cycle: verifying,
      leaseToken: "lease-protection-missing",
      limit: 100
    });
    expect(registered).toContainEqual({
      checksumSha256: checksums.base,
      formatVersion: 2,
      objectKey: `${prefix}base.json`
    });

    await expect(repository.recordRegisteredObjectCheck({
      cycle: verifying,
      leaseToken: "lease-protection-missing",
      object: {
        checksumSha256: checksums.base,
        formatVersion: 2,
        objectKey: `${prefix}base.json`
      },
      exists: false,
      checkedAt: "2026-07-20T01:00:02.000Z"
    })).resolves.toBe(true);

    expect((await sql<Array<{ integrity_error_code: string | null }>>`
      SELECT integrity_error_code FROM focowiki.projection_segments
      WHERE id = 'segment-protection-base'
    `)[0]?.integrity_error_code).toBe("STORAGE_OBJECT_MISSING");
    expect((await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.storage_reconciliation_candidates
      WHERE prefix = ${prefix}
    `)[0]?.count).toBe(0);
  });

  it("rejects stale verification without changing registered integrity state", async () => {
    const cycle = await claimScanningCycle(
      "cycle-protection-stale-verification",
      "lease-protection-stale-verification",
      "2026-07-20T01:30:00.000Z"
    );
    await recordBatchedPage({
      reconciliation: repository,
      cycle,
      leaseToken: "lease-protection-stale-verification",
      objects: [],
      nextContinuationToken: null,
      recordedAt: "2026-07-20T01:30:01.000Z"
    });
    const verifying = { ...cycle, state: "verifying" as const };
    await sql`
      UPDATE focowiki.storage_reconciliation_cycles
      SET lease_expires_at = '2026-07-20T01:30:01.500Z'
      WHERE prefix = ${prefix}
        AND cycle_id = ${cycle.cycleId}
    `;

    await expect(repository.recordRegisteredObjectCheck({
      cycle: verifying,
      leaseToken: "lease-protection-stale-verification",
      object: {
        checksumSha256: checksums.base,
        formatVersion: 2,
        objectKey: `${prefix}base.json`
      },
      exists: false,
      checkedAt: "2026-07-20T01:30:02.000Z"
    })).resolves.toBe(false);

    expect((await sql<Array<{ integrity_error_code: string | null }>>`
      SELECT integrity_error_code
      FROM focowiki.projection_segments
      WHERE id = 'segment-protection-base'
    `)[0]?.integrity_error_code).toBeNull();
  });

  it("resumes durable scan and verification checkpoints after repository restart", async () => {
    const firstRepository = createPostgresStorageReconciliationRepository(sql);
    const firstCycle = await firstRepository.claimCycle({
      prefix,
      cycleId: "cycle-repository-restart",
      leaseToken: "lease-repository-restart-1",
      now: "2026-07-20T01:40:00.000Z",
      leaseExpiresAt: "2026-07-20T01:40:02.000Z"
    });
    expect(firstCycle).toMatchObject({
      cycleId: "cycle-repository-restart",
      state: "scanning",
      continuationToken: null
    });

    const objects = [
      {
        key: `${prefix}base.json`,
        checksumSha256: checksums.base,
        formatVersion: 2,
        sizeBytes: 64,
        etag: "base-etag",
        lastModified: "2026-07-20T01:40:00.000Z"
      },
      {
        key: `${prefix}compacted.json`,
        checksumSha256: checksums.compacted,
        formatVersion: 2,
        sizeBytes: 64,
        etag: "compacted-etag",
        lastModified: "2026-07-20T01:40:00.000Z"
      }
    ];
    const pageId = createStoragePageCheckpointId({
      cycleId: firstCycle!.cycleId,
      continuationToken: null,
      nextContinuationToken: null
    });
    await expect(firstRepository.prepareScanPage({
      cycle: firstCycle!,
      leaseToken: "lease-repository-restart-1",
      pageId,
      nextContinuationToken: null,
      listedCount: objects.length,
      databaseChunkSize: 25,
      preparedAt: "2026-07-20T01:40:00.500Z"
    })).resolves.toMatchObject({ completedObjectCount: 0, committed: false });
    await expect(firstRepository.recordScanChunk({
      cycle: firstCycle!,
      leaseToken: "lease-repository-restart-1",
      pageId,
      objectOffset: 0,
      objects: objects.slice(0, 1),
      allowQuarantine: true,
      recordedAt: "2026-07-20T01:40:01.000Z"
    })).resolves.toBe(true);

    const resumedRepository = createPostgresStorageReconciliationRepository(sql);
    const resumedCycle = await resumedRepository.claimCycle({
      prefix,
      cycleId: "ignored-new-cycle",
      leaseToken: "lease-repository-restart-2",
      now: "2026-07-20T01:40:03.000Z",
      leaseExpiresAt: "2026-07-20T01:41:00.000Z"
    });
    expect(resumedCycle).toMatchObject({
      cycleId: "cycle-repository-restart",
      state: "scanning",
      continuationToken: null
    });
    await expect(resumedRepository.prepareScanPage({
      cycle: resumedCycle!,
      leaseToken: "lease-repository-restart-2",
      pageId,
      nextContinuationToken: null,
      listedCount: objects.length,
      databaseChunkSize: 25,
      preparedAt: "2026-07-20T01:40:03.500Z"
    })).resolves.toMatchObject({ completedObjectCount: 1, committed: false });
    await expect(resumedRepository.recordScanChunk({
      cycle: resumedCycle!,
      leaseToken: "lease-repository-restart-2",
      pageId,
      objectOffset: 1,
      objects: objects.slice(1),
      allowQuarantine: true,
      recordedAt: "2026-07-20T01:40:04.000Z"
    })).resolves.toBe(true);
    await expect(resumedRepository.completeScanPage({
      cycle: resumedCycle!,
      leaseToken: "lease-repository-restart-2",
      pageId,
      completedAt: "2026-07-20T01:40:04.500Z",
      batchLatencyMs: 4_000
    })).resolves.toBe(true);

    const verifyingCycle = { ...resumedCycle!, state: "verifying" as const };
    const firstVerificationPage =
      await resumedRepository.listRegisteredObjectsForVerification({
        cycle: verifyingCycle,
        leaseToken: "lease-repository-restart-2",
        limit: 1
      });
    expect(firstVerificationPage).toHaveLength(1);
    await expect(resumedRepository.recordRegisteredObjectCheck({
      cycle: verifyingCycle,
      leaseToken: "lease-repository-restart-2",
      object: firstVerificationPage[0]!,
      exists: true,
      checkedAt: "2026-07-20T01:40:05.000Z"
    })).resolves.toBe(true);
    await sql`
      UPDATE focowiki.storage_reconciliation_cycles
      SET lease_expires_at = '2026-07-20T01:40:05.500Z'
      WHERE prefix = ${prefix}
        AND cycle_id = 'cycle-repository-restart'
    `;

    const verificationRepository =
      createPostgresStorageReconciliationRepository(sql);
    const verificationCycle = await verificationRepository.claimCycle({
      prefix,
      cycleId: "ignored-verification-cycle",
      leaseToken: "lease-repository-restart-3",
      now: "2026-07-20T01:40:06.000Z",
      leaseExpiresAt: "2026-07-20T01:41:00.000Z"
    });
    expect(verificationCycle).toMatchObject({
      cycleId: "cycle-repository-restart",
      state: "verifying",
      verificationCursor: firstVerificationPage[0]!.objectKey
    });
    await expect(verificationRepository.listRegisteredObjectsForVerification({
      cycle: verificationCycle!,
      leaseToken: "lease-repository-restart-3",
      limit: 100
    })).resolves.not.toContainEqual(firstVerificationPage[0]);

    const state = await sql<Array<{
      listed_count: number;
      quarantined_count: number;
      confirmation_count: number;
      chunk_count: number;
    }>>`
      SELECT
        cycle.listed_count::int AS listed_count,
        cycle.quarantined_count::int AS quarantined_count,
        candidate.confirmation_count,
        (
          SELECT count(*)::int
          FROM focowiki.storage_reconciliation_chunk_checkpoints chunk
          WHERE chunk.prefix = cycle.prefix
            AND chunk.cycle_id = cycle.cycle_id
            AND chunk.page_id = ${pageId}
        ) AS chunk_count
      FROM focowiki.storage_reconciliation_cycles cycle
      JOIN focowiki.storage_reconciliation_candidates candidate
        ON candidate.prefix = cycle.prefix
       AND candidate.object_key = ${objects[1]!.key}
      WHERE cycle.prefix = ${prefix}
    `;
    expect(state[0]).toEqual({
      listed_count: 2,
      quarantined_count: 1,
      confirmation_count: 1,
      chunk_count: 2
    });
  });

  it("blocks final deletion for incomplete, dirty, changed, or stale ownership", async () => {
    const cycle = await seedDeletingCandidate({
      cycleId: "cycle-final-authorization",
      leaseToken: "lease-final-authorization"
    });
    const candidate = {
      cycle,
      leaseToken: "lease-final-authorization",
      objectKey: `${prefix}compacted.json`,
      checksumSha256: checksums.compacted,
      formatVersion: 2,
      authorizedAt: "2026-07-20T02:00:01.000Z"
    };

    await sql`
      UPDATE focowiki.storage_object_protection_backfills
      SET state = 'backfilling', phase = 'immutable_objects'
      WHERE schema_version = 1
    `;
    await expect(repository.authorizeCandidateDeletion(candidate)).resolves.toBe(false);

    await markProtectionReady();
    await resetDeletingCandidate(candidate.objectKey, candidate.leaseToken);
    await sql`
      UPDATE focowiki.storage_object_protection_index
      SET protected = false, dirty = true
      WHERE object_key = ${candidate.objectKey}
    `;
    await expect(repository.authorizeCandidateDeletion(candidate)).resolves.toBe(false);

    await resetDeletingCandidate(candidate.objectKey, candidate.leaseToken);
    await sql`
      UPDATE focowiki.storage_object_protection_index
      SET protected = true, dirty = false
      WHERE object_key = ${candidate.objectKey}
    `;
    await expect(repository.authorizeCandidateDeletion(candidate)).resolves.toBe(false);

    await resetUnprotectedCandidate(candidate.objectKey, candidate.leaseToken);
    await sql`
      INSERT INTO focowiki.immutable_objects (
        checksum_sha256, format_version, object_key, content_type,
        size_bytes, lifecycle_state, verified_at
      ) VALUES (
        ${candidate.checksumSha256}, ${candidate.formatVersion},
        ${candidate.objectKey}, 'application/json', 64, 'active', now()
      )
    `;
    await expect(repository.authorizeCandidateDeletion(candidate)).resolves.toBe(false);
    await sql`
      DELETE FROM focowiki.immutable_objects
      WHERE checksum_sha256 = ${candidate.checksumSha256}
        AND format_version = ${candidate.formatVersion}
    `;

    await resetUnprotectedCandidate(candidate.objectKey, candidate.leaseToken);
    await sql`
      UPDATE focowiki.projection_segments
      SET ownership_count = 1
      WHERE id = 'segment-protection-compacted'
    `;
    await expect(repository.authorizeCandidateDeletion(candidate)).resolves.toBe(false);

    await sql`
      UPDATE focowiki.projection_segments
      SET ownership_count = 0
      WHERE id = 'segment-protection-compacted'
    `;
    await resetUnprotectedCandidate(candidate.objectKey, candidate.leaseToken);
    await sql`
      UPDATE focowiki.storage_reconciliation_cycles
      SET lease_expires_at = '2026-07-20T01:59:59.000Z'
      WHERE prefix = ${prefix}
        AND cycle_id = ${cycle.cycleId}
    `;
    await expect(repository.authorizeCandidateDeletion(candidate)).resolves.toBe(false);
    await repository.completeCandidateDeletion({
      cycle,
      leaseToken: candidate.leaseToken,
      objectKey: candidate.objectKey,
      completedAt: candidate.authorizedAt
    });
    expect((await sql<Array<{ state: string }>>`
      SELECT state
      FROM focowiki.storage_reconciliation_candidates
      WHERE prefix = ${prefix}
        AND object_key = ${candidate.objectKey}
    `)[0]?.state).toBe("deleting");
  });

  async function claimScanningCycle(cycleId: string, leaseToken: string, now: string) {
    const cycle = await repository.claimCycle({
      prefix,
      cycleId,
      leaseToken,
      now,
      leaseExpiresAt: "2099-01-01T00:00:00.000Z"
    });
    expect(cycle).toMatchObject({ cycleId, state: "scanning" });
    return cycle!;
  }

  async function seedDeletingCandidate(input: {
    cycleId: string;
    leaseToken: string;
  }) {
    await sql`
      INSERT INTO focowiki.storage_reconciliation_cycles (
        prefix, cycle_id, state, lease_token, lease_expires_at,
        scan_started_at, scan_completed_at, next_scan_at
      ) VALUES (
        ${prefix}, ${input.cycleId}, 'verifying', ${input.leaseToken},
        '2099-01-01T00:00:00.000Z', '2026-07-20T02:00:00.000Z',
        '2026-07-20T02:00:00.000Z', '2026-07-20T02:00:00.000Z'
      )
    `;
    await resetDeletingCandidate(
      `${prefix}compacted.json`,
      input.leaseToken
    );
    return {
      prefix,
      cycleId: input.cycleId,
      state: "verifying" as const,
      continuationToken: null,
      verificationCursor: null,
      databaseChunkSize: null
    };
  }

  async function resetDeletingCandidate(
    objectKey: string,
    leaseToken: string
  ): Promise<void> {
    await sql`
      INSERT INTO focowiki.storage_reconciliation_candidates (
        prefix, object_key, checksum_sha256, format_version, state,
        first_seen_cycle_id, last_seen_cycle_id, confirmation_count,
        first_seen_at, last_seen_at, observed_size_bytes, observed_etag,
        attempt_count, next_attempt_at, deletion_lease_token, updated_at
      ) VALUES (
        ${prefix}, ${objectKey}, ${checksums.compacted}, 2, 'deleting',
        'cycle-final-authorization', 'cycle-final-authorization', 2,
        '2026-07-18T02:00:00.000Z', '2026-07-20T02:00:00.000Z',
        64, 'etag-final-authorization', 1,
        '2026-07-20T02:00:00.000Z', ${leaseToken},
        '2026-07-20T02:00:00.000Z'
      )
      ON CONFLICT (prefix, object_key) DO UPDATE
      SET state = 'deleting',
          deletion_lease_token = EXCLUDED.deletion_lease_token,
          resolved_at = NULL,
          deleted_at = NULL,
          updated_at = EXCLUDED.updated_at
    `;
  }

  async function resetUnprotectedCandidate(
    objectKey: string,
    leaseToken: string
  ): Promise<void> {
    await resetDeletingCandidate(objectKey, leaseToken);
    await sql`
      UPDATE focowiki.storage_object_protection_index
      SET protected = false, dirty = false, protection_classes = ARRAY[]::text[]
      WHERE object_key = ${objectKey}
    `;
    await sql`
      DELETE FROM focowiki.storage_object_protection_dirty
      WHERE object_key = ${objectKey}
    `;
  }

  async function seedProtectionLineage() {
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Storage object protection')
    `;
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, state, format_version
      ) VALUES
        ('generation-protection-active', ${knowledgeBaseId}, 'active', 2),
        ('generation-protection-retained', ${knowledgeBaseId}, 'superseded', 2),
        ('generation-protection-legacy', ${knowledgeBaseId}, 'superseded', 1)
    `;
    await sql`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = 'generation-protection-active'
      WHERE id = ${knowledgeBaseId}
    `;
    await sql`
      INSERT INTO focowiki.immutable_objects (
        checksum_sha256, format_version, object_key, content_type,
        size_bytes, verified_at
      ) VALUES
        (${checksums.manifest}, 2, ${`${prefix}manifest.json`}, 'application/json', 64, now()),
        (${checksums.retainedRoot}, 2, ${`${prefix}retained-root.json`}, 'application/json', 64, now()),
        (${checksums.legacy}, 1, ${`${prefix}legacy.json`}, 'application/json', 64, now()),
        (${checksums.generationRoot}, 2, ${`${prefix}generation-root.json`}, 'application/json', 64, now())
    `;
    await sql`
      UPDATE focowiki.publication_generations
      SET root_manifest_checksum_sha256 = ${checksums.generationRoot},
          root_manifest_object_key = ${`${prefix}generation-root.json`}
      WHERE id = 'generation-protection-active'
    `;
    await sql`
      INSERT INTO focowiki.active_object_refs (
        knowledge_base_id, ref_kind, ref_key, file_id,
        last_changed_generation_id, checksum_sha256, format_version
      ) VALUES (
        ${knowledgeBaseId}, 'generation_manifest', 'root', 'manifest-protection',
        'generation-protection-active', ${checksums.manifest}, 2
      )
    `;
    await sql`
      INSERT INTO focowiki.generation_object_refs (
        generation_id, knowledge_base_id, ref_kind, ref_key, file_id,
        action, checksum_sha256, format_version
      ) VALUES
        ('generation-protection-retained', ${knowledgeBaseId}, 'index', 'root',
         'retained-root-protection', 'upsert', ${checksums.retainedRoot}, 2),
        ('generation-protection-legacy', ${knowledgeBaseId}, 'projection_shard', 'legacy',
         'legacy-protection', 'upsert', ${checksums.legacy}, 1)
    `;
    await sql`
      INSERT INTO focowiki.projection_segments (
        id, knowledge_base_id, projection_kind, logical_partition,
        segment_kind, sequence_number, format_version, checksum_sha256,
        object_key, logical_path, entry_count, encoded_bytes,
        lifecycle_state, ownership_count, compacted_at
      ) VALUES
        ('segment-protection-base', ${knowledgeBaseId}, 'search', 'search/base',
         'base', 0, 2, ${checksums.base}, ${`${prefix}base.json`},
         '_segments/search/base.json', 1, 64, 'active', 0, NULL),
        ('segment-protection-delta', ${knowledgeBaseId}, 'search', 'search/delta',
         'delta', 1, 2, ${checksums.delta}, ${`${prefix}delta.json`},
         '_segments/search/delta.json', 1, 64, 'active', 0, NULL),
        ('segment-protection-tombstone', ${knowledgeBaseId}, 'search', 'search/tombstone',
         'tombstone', 2, 2, ${checksums.tombstone}, ${`${prefix}tombstone.json`},
         '_segments/search/tombstone.json', 1, 64, 'retained', 0, NULL),
        ('segment-protection-compacted', ${knowledgeBaseId}, 'search', 'search/compacted',
         'compacted', 3, 2, ${checksums.compacted}, ${`${prefix}compacted.json`},
         '_segments/search/compacted.json', 1, 64, 'quarantined', 0,
         '2026-07-01T00:00:00.000Z')
    `;
    await sql`
      INSERT INTO focowiki.active_projection_segments (
        knowledge_base_id, projection_kind, logical_partition, segment_id, ordinal
      ) VALUES (${knowledgeBaseId}, 'search', 'search/base', 'segment-protection-base', 0)
    `;
    await sql`
      INSERT INTO focowiki.generation_projection_segments (
        generation_id, segment_id, ordinal, effective
      ) VALUES ('generation-protection-retained', 'segment-protection-delta', 0, true)
    `;
  }

  async function cleanup() {
    await sql`DELETE FROM focowiki.storage_reconciliation_candidates WHERE prefix = ${prefix}`;
    await sql`DELETE FROM focowiki.storage_reconciliation_cycles WHERE prefix = ${prefix}`;
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.immutable_objects WHERE object_key >= ${prefix} AND object_key < ${`${prefix}\uffff`}`;
  }

  async function markProtectionReady(): Promise<void> {
    await sql`
      UPDATE focowiki.storage_object_protection_backfills
      SET state = 'ready',
          phase = 'ready',
          lease_token = NULL,
          lease_expires_at = NULL,
          completed_at = now(),
          updated_at = now()
      WHERE schema_version = 1
    `;
  }
});

async function recordBatchedPage(input: {
  reconciliation: ReturnType<typeof createPostgresStorageReconciliationRepository>;
  cycle: NonNullable<Awaited<ReturnType<
    ReturnType<typeof createPostgresStorageReconciliationRepository>["claimCycle"]
  >>>;
  leaseToken: string;
  objects: Array<{
    key: string;
    checksumSha256: string;
    formatVersion: number;
    sizeBytes: number;
    etag: string | null;
    lastModified: string | null;
  }>;
  nextContinuationToken: string | null;
  recordedAt: string;
}): Promise<boolean> {
  const pageId = createStoragePageCheckpointId({
    cycleId: input.cycle.cycleId,
    continuationToken: input.cycle.continuationToken,
    nextContinuationToken: input.nextContinuationToken
  });
  const prepared = await input.reconciliation.prepareScanPage({
    cycle: input.cycle,
    leaseToken: input.leaseToken,
    pageId,
    nextContinuationToken: input.nextContinuationToken,
    listedCount: input.objects.length,
    databaseChunkSize: 100,
    preparedAt: input.recordedAt
  });
  if (!prepared) return false;
  for (
    let objectOffset = prepared.completedObjectCount;
    objectOffset < input.objects.length;
    objectOffset += prepared.databaseChunkSize
  ) {
    const committed = await input.reconciliation.recordScanChunk({
      cycle: input.cycle,
      leaseToken: input.leaseToken,
      pageId,
      objectOffset,
      objects: input.objects.slice(
        objectOffset,
        objectOffset + prepared.databaseChunkSize
      ),
      allowQuarantine: true,
      recordedAt: input.recordedAt
    });
    if (!committed) return false;
  }
  return input.reconciliation.completeScanPage({
    cycle: input.cycle,
    leaseToken: input.leaseToken,
    pageId,
    completedAt: input.recordedAt,
    batchLatencyMs: 1
  });
}

function databaseConnectionUrl(url: string, databaseName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
