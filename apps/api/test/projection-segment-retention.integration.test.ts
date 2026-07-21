import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresGenerationCleanupRepository } from "../src/infrastructure/postgres/generation-cleanup-repository.js";
import { createPostgresStorageReconciliationRepository } from "../src/infrastructure/postgres/storage-reconciliation-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("projection segment retention integration", () => {
  const sql = postgres(databaseUrl!, { max: 3 });
  const cleanup = createPostgresGenerationCleanupRepository(sql);
  const reconciliation = createPostgresStorageReconciliationRepository(sql);
  const knowledgeBaseId = "kb-segment-retention";
  const checksum = "9".repeat(64);
  const objectKey = "test/generated/v2/objects/99/" + checksum;

  beforeEach(async () => {
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.immutable_objects WHERE object_key = ${objectKey}`;
    await sql`
      DELETE FROM focowiki.storage_reconciliation_candidates
      WHERE prefix = 'test/generated/' AND object_key = ${objectKey}
    `;
    await sql`DELETE FROM focowiki.storage_reconciliation_cycles WHERE prefix = 'test/generated/'`;
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Projection segment retention')
    `;
    await sql`
      INSERT INTO focowiki.projection_segments (
        id, knowledge_base_id, projection_kind, logical_partition,
        segment_kind, sequence_number, format_version, checksum_sha256,
        object_key, logical_path, entry_count, encoded_bytes,
        lifecycle_state, ownership_count
      ) VALUES (
        'segment-retained-object', ${knowledgeBaseId}, 'search', 'search/v2/0001',
        'base', 0, 2, ${checksum}, ${objectKey},
        '_segments/search/search-v2-0001/base.json', 1, 64, 'retained', 1
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.immutable_objects WHERE object_key = ${objectKey}`;
    await sql`
      DELETE FROM focowiki.storage_reconciliation_candidates
      WHERE prefix = 'test/generated/' AND object_key = ${objectKey}
    `;
    await sql`DELETE FROM focowiki.storage_reconciliation_cycles WHERE prefix = 'test/generated/'`;
    await sql.end({ timeout: 5 });
  });

  it("blocks storage reconciliation when a retained segment owns the object identity", async () => {
    await sql`
      INSERT INTO focowiki.storage_reconciliation_cycles (
        prefix, cycle_id, state, lease_token, lease_expires_at, next_scan_at
      ) VALUES (
        'test/generated/', 'cycle-segment-retention', 'verifying',
        'lease-segment-retention', '2099-01-01T00:00:00.000Z', now()
      )
    `;
    await sql`
      INSERT INTO focowiki.storage_reconciliation_candidates (
        prefix, object_key, checksum_sha256, format_version, state,
        first_seen_cycle_id, last_seen_cycle_id, confirmation_count,
        first_seen_at, last_seen_at, attempt_count, next_attempt_at
      ) VALUES (
        'test/generated/', ${objectKey}, ${checksum}, 2, 'deleting',
        'cycle-segment-retention', 'cycle-segment-retention', 2,
        '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 1, now()
      )
    `;

    await expect(reconciliation.authorizeCandidateDeletion({
      cycle: {
        prefix: "test/generated/",
        cycleId: "cycle-segment-retention",
        state: "verifying",
        continuationToken: null,
        verificationCursor: null
      },
      leaseToken: "lease-segment-retention",
      objectKey,
      checksumSha256: checksum,
      formatVersion: 2,
      authorizedAt: "2026-07-20T00:00:00.000Z"
    })).resolves.toBe(false);
  });

  it("does not claim immutable objects still owned by retained segments", async () => {
    await sql`
      INSERT INTO focowiki.immutable_objects (
        checksum_sha256, format_version, object_key, content_type,
        size_bytes, verified_at, created_at
      ) VALUES (
        ${checksum}, 2, ${objectKey}, 'application/json', 64, now(),
        '2026-01-01T00:00:00.000Z'
      )
    `;
    const result = await cleanup.claimUnreferencedImmutableObjects({
      jobId: "cleanup-segment-retention",
      cursor: null,
      olderThan: "2026-07-20T00:00:00.000Z",
      limit: 10
    });
    expect(result.objects).toEqual([]);
  });

  it("claims old quarantined compacted segments after every owner is released", async () => {
    await sql`
      UPDATE focowiki.projection_segments
      SET segment_kind = 'compacted', lifecycle_state = 'quarantined',
          ownership_count = 0, compacted_at = '2026-01-02T00:00:00.000Z'
      WHERE id = 'segment-retained-object'
    `;
    await sql`
      INSERT INTO focowiki.immutable_objects (
        checksum_sha256, format_version, object_key, content_type,
        size_bytes, verified_at, created_at
      ) VALUES (
        ${checksum}, 2, ${objectKey}, 'application/json', 64, now(),
        '2026-01-01T00:00:00.000Z'
      )
    `;

    const result = await cleanup.claimUnreferencedImmutableObjects({
      jobId: "cleanup-quarantined-compacted",
      cursor: null,
      olderThan: "2026-07-20T00:00:00.000Z",
      limit: 10
    });

    expect(result.objects).toEqual([{
      checksumSha256: checksum,
      formatVersion: 2,
      objectKey
    }]);
    const segments = await sql<Array<{ lifecycle_state: string }>>`
      SELECT lifecycle_state FROM focowiki.projection_segments
      WHERE id = 'segment-retained-object'
    `;
    expect(segments[0]?.lifecycle_state).toBe("deleted");
  });
});
