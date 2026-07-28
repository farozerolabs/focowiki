import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  MIGRATION_FILES,
  readMigrationSql,
  RUNTIME_SCHEMA_GENERATION
} from "../src/db/migrations.js";
import { createPostgresImmutableObjectRepository } from "../src/infrastructure/postgres/immutable-object-repository.js";
import { createPostgresObjectProtectionRepository } from "../src/infrastructure/postgres/object-protection-repository.js";
import { runObjectProtectionMaintenanceSlice } from "../src/maintenance/object-protection-maintenance.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase.sequential("object protection repository integration", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_object_protection_${process.pid}_${
    randomUUID().replaceAll("-", "").slice(0, 10)
  }`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), {
    max: 1,
    onnotice: () => {}
  });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), {
    max: 4,
    onnotice: () => {}
  });
  const repository = createPostgresObjectProtectionRepository(sql);
  const immutableObjects = createPostgresImmutableObjectRepository(sql);
  const existingChecksum = "aa".repeat(32);
  const existingObjectKey = objectKey(existingChecksum);
  const lifecycleChecksum = "bb".repeat(32);
  const lifecycleObjectKey = objectKey(lifecycleChecksum);
  const concurrentChecksum = "cc".repeat(32);
  const concurrentObjectKey = objectKey(concurrentChecksum);
  const reservationChecksum = "dd".repeat(32);
  const reservationObjectKey = objectKey(reservationChecksum);
  const expiredChecksum = "ee".repeat(32);
  const expiredObjectKey = objectKey(expiredChecksum);
  const sourceChecksum = "f0".repeat(32);
  const sourceObjectKey = `object-protection/source/${sourceChecksum}.md`;
  const replacementChecksum = "f1".repeat(32);
  const replacementObjectKey =
    `object-protection/source/${replacementChecksum}.md`;
  const overlapChecksum = "12".repeat(32);
  const overlapObjectKey = objectKey(overlapChecksum);
  const removedDuringBackfillChecksum = "13".repeat(32);
  const removedDuringBackfillObjectKey =
    objectKey(removedDuringBackfillChecksum);

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    const migrationIndex = MIGRATION_FILES.indexOf(
      "017_indexed_storage_object_protection.sql"
    );
    for (const fileName of MIGRATION_FILES.slice(0, migrationIndex)) {
      await sql.begin(async (transaction) => {
        await transaction.unsafe(readMigrationSql(fileName));
      });
    }
    await sql`
      INSERT INTO focowiki.immutable_objects (
        checksum_sha256, format_version, object_key,
        content_type, size_bytes, lifecycle_state, verified_at
      ) VALUES (
        ${existingChecksum}, 1, ${existingObjectKey},
        'application/json', 64, 'active', now()
      )
    `;
    await applyMigrations(sql);
    await applyMigrations(sql);
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await admin.unsafe(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
    );
    await admin.end({ timeout: 5 });
  });

  it("keeps migration schema-only and resumes bounded backfill after lease takeover", async () => {
    expect((await sql<Array<{ generation: string }>>`
      SELECT generation
      FROM focowiki.runtime_generation
      WHERE singleton = true
    `)[0]?.generation).toBe(RUNTIME_SCHEMA_GENERATION);
    expect(await repository.getStatus()).toMatchObject({
      readiness: "pending",
      phase: "immutable_objects",
      processedCount: 0
    });
    expect(await repository.lookupIdentities([{
      objectKey: existingObjectKey,
      checksumSha256: existingChecksum,
      formatVersion: 1
    }])).toEqual([]);

    const firstClaim = await repository.claimMaintenance({
      leaseToken: "first-owner",
      now: "2090-07-27T00:00:00.000Z",
      leaseExpiresAt: "2090-07-27T00:02:00.000Z"
    });
    expect(firstClaim).not.toBeNull();
    await expect(repository.claimMaintenance({
      leaseToken: "second-owner",
      now: "2090-07-27T00:01:00.000Z",
      leaseExpiresAt: "2090-07-27T00:03:00.000Z"
    })).resolves.toBeNull();

    const takeoverClaim = await repository.claimMaintenance({
      leaseToken: "second-owner",
      now: "2090-07-27T00:02:01.000Z",
      leaseExpiresAt: "2090-07-27T00:04:01.000Z"
    });
    expect(takeoverClaim).not.toBeNull();
    await expect(repository.runBackfillBatch({
      claim: firstClaim!,
      leaseToken: "first-owner",
      limit: 10,
      now: "2090-07-27T00:02:02.000Z"
    })).rejects.toMatchObject({
      code: "OBJECT_PROTECTION_OWNERSHIP_EXPIRED"
    });

    let currentTime = Date.parse("2090-07-27T00:02:03.000Z");
    for (let index = 0; index < 12; index += 1) {
      const result = await runObjectProtectionMaintenanceSlice({
        repository,
        batchSize: 10,
        leaseToken: "second-owner",
        now: () => new Date(currentTime)
      });
      currentTime += 1_000;
      if (result.completed) break;
    }

    expect(await repository.getStatus()).toMatchObject({
      readiness: "ready",
      phase: "ready"
    });
    expect(await repository.lookupIdentities([{
      objectKey: existingObjectKey,
      checksumSha256: existingChecksum,
      formatVersion: 1
    }])).toEqual([
      expect.objectContaining({
        protected: true,
        dirty: false,
        classes: ["registered"]
      })
    ]);
  });

  it("marks an empty database ready through bounded maintenance phases", async () => {
    await cleanup();
    await resetBackfill("2090-07-27T00:00:00.000Z");
    let currentTime = Date.parse("2090-07-27T00:00:01.000Z");
    let completed = false;

    for (let index = 0; index < 10; index += 1) {
      const result = await runObjectProtectionMaintenanceSlice({
        repository,
        batchSize: 100,
        leaseToken: "empty-owner",
        now: () => new Date(currentTime)
      });
      currentTime += 1_000;
      if (result.completed) {
        completed = true;
        break;
      }
    }

    expect(completed).toBe(true);
    expect(await repository.getStatus()).toMatchObject({
      readiness: "ready",
      phase: "ready",
      processedCount: 0,
      verifiedCount: 0,
      dirtyCount: 0
    });
  });

  it("applies lifecycle protection immediately and refreshes removals conservatively", async () => {
    await sql`
      INSERT INTO focowiki.immutable_objects (
        checksum_sha256, format_version, object_key,
        content_type, size_bytes, lifecycle_state, verified_at
      ) VALUES (
        ${lifecycleChecksum}, 1, ${lifecycleObjectKey},
        'application/json', 64, 'active', now()
      )
    `;
    await repository.protectIdentities({
      identities: [
        {
          objectKey: lifecycleObjectKey,
          checksumSha256: lifecycleChecksum,
          formatVersion: 1,
          protectionClass: "active_reference"
        },
        {
          objectKey: lifecycleObjectKey,
          checksumSha256: lifecycleChecksum,
          formatVersion: 1,
          protectionClass: "active_reference"
        }
      ]
    });
    expect(await repository.lookupIdentities([{
      objectKey: lifecycleObjectKey,
      checksumSha256: lifecycleChecksum,
      formatVersion: 1
    }])).toEqual([
      expect.objectContaining({
        protected: true,
        dirty: false,
        classes: ["active_reference", "registered"]
      })
    ]);

    await sql`
      DELETE FROM focowiki.immutable_objects
      WHERE checksum_sha256 = ${lifecycleChecksum}
        AND format_version = 1
    `;
    expect(await repository.lookupIdentities([{
      objectKey: lifecycleObjectKey,
      checksumSha256: lifecycleChecksum,
      formatVersion: 1
    }])).toEqual([
      expect.objectContaining({
        protected: true,
        dirty: true
      })
    ]);

    const refreshed = await runObjectProtectionMaintenanceSlice({
      repository,
      batchSize: 10,
      leaseToken: "dirty-owner",
      now: () => new Date("2090-07-27T00:10:00.000Z")
    });
    expect(refreshed).toMatchObject({
      claimed: true,
      phase: "ready",
      completed: true
    });
    expect(await repository.lookupIdentities([{
      objectKey: lifecycleObjectKey,
      checksumSha256: lifecycleChecksum,
      formatVersion: 1
    }])).toEqual([
      expect.objectContaining({
        protected: false,
        dirty: false,
        classes: []
      })
    ]);
    expect(await repository.getStatus()).toMatchObject({
      processedCount: 0,
      expectedCount: 0,
      dirtyCount: 0
    });
  });

  it("tracks immutable reservation, retry recovery, activation, and expiration", async () => {
    await expect(immutableObjects.reserve({
      checksumSha256: reservationChecksum,
      formatVersion: 1,
      objectKey: reservationObjectKey,
      contentType: "application/json",
      sizeBytes: 64,
      writeToken: "reservation-owner-a",
      writeStartedAt: "2090-07-27T00:12:00.000Z",
      staleBefore: "2090-07-27T00:11:00.000Z"
    })).resolves.toMatchObject({ status: "reserved" });
    expect(await repository.lookupIdentities([{
      objectKey: reservationObjectKey,
      checksumSha256: reservationChecksum,
      formatVersion: 1
    }])).toEqual([
      expect.objectContaining({
        protected: true,
        dirty: false,
        classes: ["write_reservation"]
      })
    ]);

    await expect(immutableObjects.reserve({
      checksumSha256: reservationChecksum,
      formatVersion: 1,
      objectKey: reservationObjectKey,
      contentType: "application/json",
      sizeBytes: 64,
      writeToken: "reservation-owner-b",
      writeStartedAt: "2090-07-27T00:14:00.000Z",
      staleBefore: "2090-07-27T00:13:00.000Z"
    })).resolves.toMatchObject({
      status: "reserved",
      record: { writeAttemptCount: 2 }
    });
    await immutableObjects.activate({
      checksumSha256: reservationChecksum,
      formatVersion: 1,
      objectKey: reservationObjectKey,
      contentType: "application/json",
      sizeBytes: 64,
      writeToken: "reservation-owner-b",
      verifiedAt: "2090-07-27T00:14:01.000Z"
    });
    expect(await repository.lookupIdentities([{
      objectKey: reservationObjectKey,
      checksumSha256: reservationChecksum,
      formatVersion: 1
    }])).toEqual([
      expect.objectContaining({
        protected: true,
        dirty: false,
        classes: ["registered"]
      })
    ]);

    await immutableObjects.reserve({
      checksumSha256: expiredChecksum,
      formatVersion: 1,
      objectKey: expiredObjectKey,
      contentType: "application/json",
      sizeBytes: 64,
      writeToken: "expired-owner",
      writeStartedAt: "2090-07-27T00:15:00.000Z",
      staleBefore: "2090-07-27T00:14:00.000Z"
    });
    await expect(immutableObjects.releaseFailedWrite({
      checksumSha256: expiredChecksum,
      formatVersion: 1,
      writeToken: "expired-owner"
    })).resolves.toBe(true);
    expect(await repository.lookupIdentities([{
      objectKey: expiredObjectKey,
      checksumSha256: expiredChecksum,
      formatVersion: 1
    }])).toEqual([
      expect.objectContaining({
        protected: true,
        dirty: true
      })
    ]);
    await runObjectProtectionMaintenanceSlice({
      repository,
      batchSize: 10,
      leaseToken: "expired-refresh-owner",
      now: () => new Date("2090-07-27T00:16:00.000Z")
    });
    expect(await repository.lookupIdentities([{
      objectKey: expiredObjectKey,
      checksumSha256: expiredChecksum,
      formatVersion: 1
    }])).toEqual([
      expect.objectContaining({
        protected: false,
        dirty: false,
        classes: []
      })
    ]);
  });

  it("tracks source registration, replacement, task hiding, and hard deletion", async () => {
    await sql.begin(async (transaction) => {
      await transaction`SET CONSTRAINTS ALL DEFERRED`;
      await transaction`
        INSERT INTO focowiki.knowledge_bases (id, name)
        VALUES ('kb-object-protection-source', 'Object protection source')
      `;
      await transaction`
        INSERT INTO focowiki.source_directories (
          id, knowledge_base_id, name, relative_path, path_key, depth
        ) VALUES (
          'source-directory-object-protection',
          'kb-object-protection-source',
          'documents', 'documents', 'documents', 1
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, object_key, content_type, size_bytes,
          checksum_sha256, name, relative_path, path_key, directory_id,
          active_revision_id
        ) VALUES (
          'source-file-object-protection', 'kb-object-protection-source',
          ${sourceObjectKey}, 'text/markdown', 64, ${sourceChecksum},
          'source.md', 'documents/source.md', 'documents/source.md',
          'source-directory-object-protection',
          'source-revision-object-protection'
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256
        ) VALUES (
          'source-revision-object-protection',
          'kb-object-protection-source',
          'source-file-object-protection', 1, ${sourceObjectKey},
          'text/markdown', 64, ${sourceChecksum}
        )
      `;
    });
    expect(await repository.lookupIdentities([{
      objectKey: sourceObjectKey,
      checksumSha256: sourceChecksum,
      formatVersion: 1
    }])).toEqual([
      expect.objectContaining({
        protected: true,
        dirty: false,
        classes: ["source"]
      })
    ]);

    await sql`
      UPDATE focowiki.source_files
      SET task_deleted_at = now()
      WHERE id = 'source-file-object-protection'
    `;
    expect(await repository.lookupIdentities([{
      objectKey: sourceObjectKey,
      checksumSha256: sourceChecksum,
      formatVersion: 1
    }])).toEqual([
      expect.objectContaining({
        protected: true,
        dirty: false
      })
    ]);

    await sql`
      UPDATE focowiki.source_files
      SET object_key = ${replacementObjectKey},
          checksum_sha256 = ${replacementChecksum},
          task_deleted_at = NULL
      WHERE id = 'source-file-object-protection'
    `;
    expect(await repository.lookupIdentities([
      {
        objectKey: sourceObjectKey,
        checksumSha256: sourceChecksum,
        formatVersion: 1
      },
      {
        objectKey: replacementObjectKey,
        checksumSha256: replacementChecksum,
        formatVersion: 1
      }
    ])).toEqual(expect.arrayContaining([
      expect.objectContaining({
        objectKey: sourceObjectKey,
        protected: true,
        dirty: true
      }),
      expect.objectContaining({
        objectKey: replacementObjectKey,
        protected: true,
        dirty: false,
        classes: ["source"]
      })
    ]));

    await sql`
      UPDATE focowiki.source_files
      SET deleted_at = now()
      WHERE directory_id = 'source-directory-object-protection'
    `;
    expect(await repository.lookupIdentities([{
      objectKey: replacementObjectKey,
      checksumSha256: replacementChecksum,
      formatVersion: 1
    }])).toEqual([
      expect.objectContaining({
        protected: true,
        dirty: true
      })
    ]);
    await sql`
      UPDATE focowiki.source_files
      SET deleted_at = NULL
      WHERE directory_id = 'source-directory-object-protection'
    `;
    expect(await repository.lookupIdentities([{
      objectKey: replacementObjectKey,
      checksumSha256: replacementChecksum,
      formatVersion: 1
    }])).toEqual([
      expect.objectContaining({
        protected: true,
        dirty: false
      })
    ]);

    await sql`
      DELETE FROM focowiki.knowledge_bases
      WHERE id = 'kb-object-protection-source'
    `;
    expect(await repository.lookupIdentities([{
      objectKey: replacementObjectKey,
      checksumSha256: replacementChecksum,
      formatVersion: 1
    }])).toEqual([
      expect.objectContaining({
        protected: true,
        dirty: true
      })
    ]);

    for (let index = 0; index < 2; index += 1) {
      await runObjectProtectionMaintenanceSlice({
        repository,
        batchSize: 10,
        leaseToken: "source-refresh-owner",
        now: () => new Date(`2090-07-27T00:18:0${index}.000Z`)
      });
    }
    expect(await repository.lookupIdentities([
      {
        objectKey: sourceObjectKey,
        checksumSha256: sourceChecksum,
        formatVersion: 1
      },
      {
        objectKey: replacementObjectKey,
        checksumSha256: replacementChecksum,
        formatVersion: 1
      }
    ])).toEqual(expect.arrayContaining([
      expect.objectContaining({
        objectKey: sourceObjectKey,
        protected: false,
        dirty: false
      }),
      expect.objectContaining({
        objectKey: replacementObjectKey,
        protected: false,
        dirty: false
      })
    ]));
  });

  it("keeps duplicate dirty work bounded and converges with a concurrent protection add", async () => {
    const identity = {
      objectKey: concurrentObjectKey,
      checksumSha256: concurrentChecksum,
      formatVersion: 1
    };
    await repository.markIdentitiesDirty({
      identities: [
        { ...identity, reason: "first_removal" },
        { ...identity, reason: "duplicate_removal" }
      ]
    });
    await repository.markIdentitiesDirty({
      identities: [{ ...identity, reason: "latest_removal" }]
    });

    const dirtyRows = await sql<Array<{
      count: number;
      revision: number;
      reason: string;
    }>>`
      SELECT count(*)::int AS count, max(revision)::int AS revision,
             max(reason) AS reason
      FROM focowiki.storage_object_protection_dirty
      WHERE object_key = ${concurrentObjectKey}
    `;
    expect(dirtyRows[0]).toMatchObject({
      count: 1,
      revision: 3,
      reason: "latest_removal"
    });

    const claim = await repository.claimMaintenance({
      leaseToken: "concurrent-owner",
      now: "2090-07-27T00:20:00.000Z",
      leaseExpiresAt: "2090-07-27T00:22:00.000Z"
    });
    expect(claim).toMatchObject({ phase: "dirty_refresh" });
    await Promise.all([
      repository.refreshDirtyBatch({
        claim: claim!,
        leaseToken: "concurrent-owner",
        limit: 10,
        now: "2090-07-27T00:20:01.000Z"
      }),
      sql`
        INSERT INTO focowiki.immutable_objects (
          checksum_sha256, format_version, object_key,
          content_type, size_bytes, lifecycle_state, verified_at
        ) VALUES (
          ${concurrentChecksum}, 1, ${concurrentObjectKey},
          'application/json', 64, 'active', now()
        )
      `
    ]);

    expect(await repository.lookupIdentities([identity])).toEqual([
      expect.objectContaining({
        protected: true,
        dirty: false,
        classes: expect.arrayContaining(["registered"])
      })
    ]);
    expect((await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.storage_object_protection_dirty
      WHERE object_key = ${concurrentObjectKey}
    `)[0]?.count).toBe(0);
  });

  it("rejects stale page replay and releases ownership between bounded batches", async () => {
    await sql`
      UPDATE focowiki.storage_object_protection_backfills
      SET state = 'pending',
          phase = 'immutable_objects',
          cursor_object_key = NULL,
          processed_count = 0,
          expected_count = 0,
          verified_count = 0,
          retry_count = 0,
          revision = revision + 1,
          lease_token = NULL,
          lease_expires_at = NULL,
          next_attempt_at = '2090-07-27T00:29:00.000Z',
          completed_at = NULL
      WHERE schema_version = 1
    `;
    const firstClaim = await repository.claimMaintenance({
      leaseToken: "restart-owner-a",
      now: "2090-07-27T00:30:00.000Z",
      leaseExpiresAt: "2090-07-27T00:31:00.000Z"
    });
    expect(firstClaim).not.toBeNull();
    const firstBatch = await repository.runBackfillBatch({
      claim: firstClaim!,
      leaseToken: "restart-owner-a",
      limit: 1,
      now: "2090-07-27T00:30:01.000Z"
    });
    expect(firstBatch).toMatchObject({ processed: 1, completed: false });
    await expect(repository.runBackfillBatch({
      claim: firstClaim!,
      leaseToken: "restart-owner-a",
      limit: 1,
      now: "2090-07-27T00:30:02.000Z"
    })).rejects.toMatchObject({
      code: "OBJECT_PROTECTION_OWNERSHIP_EXPIRED"
    });

    const resumedClaim = await repository.claimMaintenance({
      leaseToken: "restart-owner-b",
      now: "2090-07-27T00:30:02.000Z",
      leaseExpiresAt: "2090-07-27T00:32:02.000Z"
    });
    expect(resumedClaim).toMatchObject({
      phase: "immutable_objects"
    });
    expect(resumedClaim?.cursorObjectKey).not.toBeNull();
    await repository.runBackfillBatch({
      claim: resumedClaim!,
      leaseToken: "restart-owner-b",
      limit: 1,
      now: "2090-07-27T00:30:03.000Z"
    });
    expect(await repository.getStatus()).toMatchObject({
      processedCount: 2
    });
  });

  it("backfills reused projection objects once per immutable identity", async () => {
    const sharedChecksum = "14".repeat(32);
    const sharedObjectKey = objectKey(sharedChecksum);
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES ('kb-object-protection-shared', 'Shared projection objects')
    `;
    await resetBackfill("2090-07-27T00:35:00.000Z");
    const initial = await runObjectProtectionMaintenanceSlice({
      repository,
      batchSize: 100,
      leaseToken: "shared-projection-owner",
      now: () => new Date("2090-07-27T00:36:00.000Z")
    });
    expect(initial).toMatchObject({
      failed: false,
      phase: "source_files"
    });
    await sql`
      INSERT INTO focowiki.projection_segments (
        id, knowledge_base_id, projection_kind, logical_partition,
        segment_kind, sequence_number, checksum_sha256, object_key,
        logical_path, entry_count, encoded_bytes, lifecycle_state,
        ownership_count
      ) VALUES
        (
          'projection-segment-shared-a', 'kb-object-protection-shared',
          'tree', 'shared-a', 'base', 1, ${sharedChecksum},
          ${sharedObjectKey}, '_index/shared-a.jsonl', 1, 64, 'active', 1
        ),
        (
          'projection-segment-shared-b', 'kb-object-protection-shared',
          'tree', 'shared-b', 'base', 1, ${sharedChecksum},
          ${sharedObjectKey}, '_index/shared-b.jsonl', 1, 64, 'active', 1
        )
    `;

    let currentTime = Date.parse("2090-07-27T00:37:00.000Z");
    for (let index = 0; index < 100; index += 1) {
      const result = await runObjectProtectionMaintenanceSlice({
        repository,
        batchSize: 1,
        leaseToken: "shared-projection-owner",
        now: () => new Date(currentTime)
      });
      currentTime += 60_000;
      if (result.completed) break;
      expect(result.failed).toBe(false);
    }

    const status = await repository.getStatus();
    expect(status).toMatchObject({
      readiness: "ready",
      phase: "ready"
    });
    expect(status.processedCount).toBe(status.expectedCount);
    expect(status.verifiedCount).toBe(status.expectedCount);
    await sql`
      DELETE FROM focowiki.knowledge_bases
      WHERE id = 'kb-object-protection-shared'
    `;
  });

  it("recovers verification failure while writes and removals overlap backfill", async () => {
    await resetBackfill("2090-07-27T00:40:00.000Z");
    const first = await runObjectProtectionMaintenanceSlice({
      repository,
      batchSize: 100,
      leaseToken: "overlap-owner",
      now: () => new Date("2090-07-27T00:41:00.000Z")
    });
    expect(first.phase).toBe("source_files");

    await sql`
      INSERT INTO focowiki.immutable_objects (
        checksum_sha256, format_version, object_key,
        content_type, size_bytes, lifecycle_state, verified_at
      ) VALUES
        (
          ${overlapChecksum}, 1, ${overlapObjectKey},
          'application/json', 64, 'active', now()
        ),
        (
          ${removedDuringBackfillChecksum}, 1,
          ${removedDuringBackfillObjectKey},
          'application/json', 64, 'active', now()
        )
    `;
    await sql`
      DELETE FROM focowiki.immutable_objects
      WHERE checksum_sha256 = ${removedDuringBackfillChecksum}
        AND format_version = 1
    `;

    await runObjectProtectionMaintenanceSlice({
      repository,
      batchSize: 100,
      leaseToken: "overlap-owner",
      now: () => new Date("2090-07-27T00:42:00.000Z")
    });
    const projectionPhase = await runObjectProtectionMaintenanceSlice({
      repository,
      batchSize: 100,
      leaseToken: "overlap-owner",
      now: () => new Date("2090-07-27T00:43:00.000Z")
    });
    expect(projectionPhase.phase).toBe("verify_immutable_objects");

    await sql`
      DELETE FROM focowiki.storage_object_protection_index
      WHERE object_key = ${reservationObjectKey}
    `;
    const failed = await runObjectProtectionMaintenanceSlice({
      repository,
      batchSize: 100,
      leaseToken: "overlap-owner",
      now: () => new Date("2090-07-27T00:44:00.000Z")
    });
    expect(failed).toMatchObject({
      failed: true,
      phase: "verify_immutable_objects"
    });
    expect(await repository.getStatus()).toMatchObject({
      readiness: "retrying",
      phase: "verify_immutable_objects",
      lastErrorCode: "OBJECT_PROTECTION_VERIFICATION_FAILED"
    });

    await repository.protectIdentities({
      identities: [{
        objectKey: reservationObjectKey,
        checksumSha256: reservationChecksum,
        formatVersion: 1,
        protectionClass: "registered"
      }]
    });
    let currentTime = Date.parse("2090-07-27T00:45:00.000Z");
    for (let index = 0; index < 10; index += 1) {
      const result = await runObjectProtectionMaintenanceSlice({
        repository,
        batchSize: 100,
        leaseToken: "overlap-owner",
        now: () => new Date(currentTime)
      });
      currentTime += 60_000;
      if (result.completed) break;
    }

    expect(await repository.getStatus()).toMatchObject({
      readiness: "ready",
      phase: "ready",
      dirtyCount: 0
    });
    expect(await repository.lookupIdentities([
      {
        objectKey: overlapObjectKey,
        checksumSha256: overlapChecksum,
        formatVersion: 1
      },
      {
        objectKey: removedDuringBackfillObjectKey,
        checksumSha256: removedDuringBackfillChecksum,
        formatVersion: 1
      }
    ])).toEqual(expect.arrayContaining([
      expect.objectContaining({
        objectKey: overlapObjectKey,
        protected: true,
        dirty: false
      }),
      expect.objectContaining({
        objectKey: removedDuringBackfillObjectKey,
        protected: false,
        dirty: false
      })
    ]));
  });

  async function resetBackfill(nextAttemptAt: string): Promise<void> {
    await sql`
      UPDATE focowiki.storage_object_protection_backfills
      SET state = 'pending',
          phase = 'immutable_objects',
          cursor_object_key = NULL,
          processed_count = 0,
          expected_count = 0,
          verified_count = 0,
          retry_count = 0,
          revision = revision + 1,
          lease_token = NULL,
          lease_expires_at = NULL,
          next_attempt_at = ${nextAttemptAt},
          last_error_code = NULL,
          last_error_message = NULL,
          completed_at = NULL
      WHERE schema_version = 1
    `;
  }

  async function cleanup(): Promise<void> {
    await sql`DELETE FROM focowiki.knowledge_bases`;
    await sql`DELETE FROM focowiki.immutable_objects`;
    await sql`DELETE FROM focowiki.storage_object_protection_dirty`;
    await sql`DELETE FROM focowiki.storage_object_protection_index`;
  }
});

function objectKey(checksumSha256: string): string {
  return `object-protection/generated/v1/objects/${
    checksumSha256.slice(0, 2)
  }/${checksumSha256}`;
}

function databaseConnectionUrl(url: string, databaseName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
