import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresProjectionCompactionRepository } from "../src/infrastructure/postgres/projection-compaction-repository.js";
import type { ProjectionSegment } from "../src/application/ports/projection-segment-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("projection compaction repository integration", () => {
  const sql = postgres(databaseUrl!, { max: 2 });
  const repository = createPostgresProjectionCompactionRepository(sql);
  const knowledgeBaseId = "kb-projection-compaction";
  const generationId = "generation-projection-compaction";

  beforeEach(async () => {
    await cleanup();
    await sql`
      UPDATE focowiki.projection_compaction_scan_cursor
      SET knowledge_base_id = NULL, projection_kind = NULL,
          logical_partition = NULL, updated_at = now()
      WHERE singleton = true
    `;
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name, active_generation_id)
      VALUES (${knowledgeBaseId}, 'Projection compaction', NULL)
    `;
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, state, created_at, updated_at
      ) VALUES (${generationId}, ${knowledgeBaseId}, 'active', now(), now())
    `;
    await sql`
      UPDATE focowiki.knowledge_bases SET active_generation_id = ${generationId}
      WHERE id = ${knowledgeBaseId}
    `;
    await sql`
      INSERT INTO focowiki.active_projection_partition_stats (
        knowledge_base_id, projection_kind, logical_partition,
        record_count, last_changed_generation_id
      ) VALUES (${knowledgeBaseId}, 'search', 'search/v1/0001', 2, ${generationId})
    `;
    for (const [ordinal, id, kind] of [
      [0, "segment-compaction-base", "base"],
      [1, "segment-compaction-delta", "delta"]
    ] as const) {
      await sql`
        INSERT INTO focowiki.projection_segments (
          id, knowledge_base_id, projection_kind, logical_partition,
          segment_kind, sequence_number, checksum_sha256, object_key,
          logical_path, entry_count, encoded_bytes, lifecycle_state
        ) VALUES (
          ${id}, ${knowledgeBaseId}, 'search', 'search/v1/0001', ${kind},
          ${ordinal}, ${String(ordinal + 1).padStart(64, "0")},
          ${`objects/${id}`}, ${`_segments/${id}.json`}, 1, 128, 'active'
        )
      `;
      await sql`
        INSERT INTO focowiki.active_projection_segments (
          knowledge_base_id, projection_kind, logical_partition, segment_id, ordinal
        ) VALUES (${knowledgeBaseId}, 'search', 'search/v1/0001', ${id}, ${ordinal})
      `;
      await sql`
        INSERT INTO focowiki.generation_projection_segments (
          generation_id, segment_id, ordinal, effective
        ) VALUES (${generationId}, ${id}, ${ordinal}, true)
      `;
    }
    await sql`
      INSERT INTO focowiki.active_projection_records (
        knowledge_base_id, projection_kind, record_id,
        last_changed_generation_id, shard_key, payload_json
      ) VALUES
        (${knowledgeBaseId}, 'search', 'a', ${generationId}, 'search/v1/0001', ${sql.json({ id: "a" })}),
        (${knowledgeBaseId}, 'search', 'b', ${generationId}, 'search/v1/0001', ${sql.json({ id: "b" })})
    `;
  });

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
  });

  it("discovers, claims, and atomically replaces one active partition", async () => {
    const ownership = await sql<Array<{ ownership_count: number }>>`
      SELECT ownership_count FROM focowiki.projection_segments
      WHERE id = 'segment-compaction-base'
    `;
    expect(Number(ownership[0]?.ownership_count)).toBe(1);
    expect(await repository.discoverCandidates({
      limits: {
        maxDepth: 1,
        maxEncodedBytes: 1024,
        maxTombstoneRatio: 1,
        maxReadAmplification: 1
      },
      partitionLimit: 10,
      maxAttempts: 3,
      discoveredAt: "2026-07-20T00:00:00.000Z"
    })).toBe(1);
    const jobs = await repository.claim({
      workerId: "maintenance-worker",
      limit: 1,
      now: "2026-07-20T00:00:01.000Z",
      leaseExpiresAt: "2026-07-20T00:01:01.000Z"
    });
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect((await repository.listActiveRecords({
      job,
      afterRecordId: null,
      limit: 1
    })).map((record) => record.recordId)).toEqual(["a"]);
    expect((await repository.listActiveRecords({
      job,
      afterRecordId: "a",
      limit: 10
    })).map((record) => record.recordId)).toEqual(["b"]);
    expect(await repository.heartbeat({
      job,
      heartbeatAt: "2026-07-20T00:00:02.000Z",
      leaseExpiresAt: "2026-07-20T00:01:02.000Z"
    })).toBe(true);

    expect(await repository.activateCompactedSegments({
      job,
      segments: [compactedSegment()],
      completedAt: "2026-07-20T00:00:03.000Z"
    })).toBe("completed");
    const active = await sql<Array<{ segment_id: string }>>`
      SELECT segment_id FROM focowiki.active_projection_segments
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;
    expect(active).toEqual([{ segment_id: "segment-compaction-result" }]);
    const retainedLineage = await sql<Array<{ segment_id: string }>>`
      SELECT segment_id FROM focowiki.generation_projection_segments
      WHERE generation_id = ${generationId}
      ORDER BY ordinal, segment_id
    `;
    expect(retainedLineage).toEqual([
      { segment_id: "segment-compaction-base" },
      { segment_id: "segment-compaction-delta" }
    ]);
    const prior = await sql<Array<{ lifecycle_state: string }>>`
      SELECT lifecycle_state FROM focowiki.projection_segments
      WHERE id = 'segment-compaction-base'
    `;
    expect(prior[0]?.lifecycle_state).toBe("retained");
  });

  it("supersedes stale work when publication changes the active lineage", async () => {
    await repository.discoverCandidates({
      limits: {
        maxDepth: 1,
        maxEncodedBytes: 1024,
        maxTombstoneRatio: 1,
        maxReadAmplification: 1
      },
      partitionLimit: 10,
      maxAttempts: 3,
      discoveredAt: "2026-07-20T00:00:00.000Z"
    });
    const job = (await repository.claim({
      workerId: "maintenance-worker",
      limit: 1,
      now: "2026-07-20T00:00:01.000Z",
      leaseExpiresAt: "2026-07-20T00:01:01.000Z"
    }))[0]!;
    await sql`
      DELETE FROM focowiki.active_projection_segments
      WHERE segment_id = 'segment-compaction-delta'
    `;

    expect(await repository.activateCompactedSegments({
      job,
      segments: [compactedSegment()],
      completedAt: "2026-07-20T00:00:03.000Z"
    })).toBe("superseded");
  });

  it("resets the bounded scan cursor after reaching the final partition", async () => {
    await repository.discoverCandidates({
      limits: {
        maxDepth: 1,
        maxEncodedBytes: 1024,
        maxTombstoneRatio: 1,
        maxReadAmplification: 1
      },
      partitionLimit: 10,
      maxAttempts: 3,
      discoveredAt: "2026-07-20T00:00:00.000Z"
    });
    expect(await repository.discoverCandidates({
      limits: {
        maxDepth: 1,
        maxEncodedBytes: 1024,
        maxTombstoneRatio: 1,
        maxReadAmplification: 1
      },
      partitionLimit: 10,
      maxAttempts: 3,
      discoveredAt: "2026-07-20T00:00:01.000Z"
    })).toBe(0);
    expect(await repository.discoverCandidates({
      limits: {
        maxDepth: 1,
        maxEncodedBytes: 1024,
        maxTombstoneRatio: 1,
        maxReadAmplification: 1
      },
      partitionLimit: 10,
      maxAttempts: 3,
      discoveredAt: "2026-07-20T00:00:02.000Z"
    })).toBe(1);
  });

  function compactedSegment(): ProjectionSegment {
    return {
      id: "segment-compaction-result",
      knowledgeBaseId,
      projectionKind: "search",
      logicalPartition: "search/v1/0001",
      segmentKind: "compacted",
      sequenceNumber: 0,
      formatVersion: 2,
      checksumSha256: "cc".repeat(32),
      objectKey: "objects/compacted",
      logicalPath: "_segments/compacted/result.json",
      entryCount: 2,
      encodedBytes: 256,
      firstRecordIdentity: "a",
      lastRecordIdentity: "b",
      baseSegmentId: "segment-compaction-base",
      lifecycleState: "active"
    };
  }

  async function cleanup(): Promise<void> {
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
  }
});
