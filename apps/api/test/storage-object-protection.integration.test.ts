import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresStorageReconciliationRepository } from "../src/infrastructure/postgres/storage-reconciliation-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("storage object protection integration", () => {
  const sql = postgres(databaseUrl!, { max: 3 });
  const repository = createPostgresStorageReconciliationRepository(sql);
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

  beforeEach(async () => {
    await cleanup();
    await seedProtectionLineage();
  });

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
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
    await expect(repository.recordScanPage({
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
    await repository.recordScanPage({
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
      graceBefore: "2026-07-19T23:59:59.000Z",
      confirmationPasses: 2,
      maxAttempts: 3,
      limit: 10
    })).resolves.toEqual([]);

    const candidates = await repository.claimDeletionCandidates({
      cycle: verifying,
      leaseToken: "lease-protection-2",
      now: "2026-07-20T00:00:05.000Z",
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
      prefix,
      objectKey: object.key,
      completedAt: "2026-07-20T00:00:07.000Z"
    });

    expect((await sql<Array<{ lifecycle_state: string }>>`
      SELECT lifecycle_state FROM focowiki.projection_segments
      WHERE id = 'segment-protection-compacted'
    `)[0]?.lifecycle_state).toBe("deleted");
  });

  it("records a missing protected segment without exposing neighboring objects to deletion", async () => {
    const cycle = await claimScanningCycle("cycle-protection-missing", "lease-protection-missing", "2026-07-20T01:00:00.000Z");
    await repository.recordScanPage({
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
});
