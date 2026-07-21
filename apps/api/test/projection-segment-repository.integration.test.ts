import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresProjectionRecordRepository } from "../src/infrastructure/postgres/projection-record-repository.js";
import { createPostgresProjectionSegmentRepository } from "../src/infrastructure/postgres/projection-segment-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("projection segment repository integration", () => {
  const sql = postgres(databaseUrl!, { max: 2 });
  const segments = createPostgresProjectionSegmentRepository(sql);
  const records = createPostgresProjectionRecordRepository(sql);
  const knowledgeBaseId = "kb-projection-segment-integration";
  const activeGenerationId = "generation-projection-segment-active";
  const candidateGenerationId = "generation-projection-segment-candidate";
  const partition = {
    knowledgeBaseId,
    generationId: candidateGenerationId,
    projectionKind: "search",
    logicalPartition: "search/v1/0001"
  };

  beforeEach(async () => {
    await cleanup();
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Projection segment integration')
    `;
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, state, created_at, updated_at
      ) VALUES (
        ${activeGenerationId}, ${knowledgeBaseId}, 'active', now(), now()
      ), (
        ${candidateGenerationId}, ${knowledgeBaseId}, 'building', now(), now()
      )
    `;
    await sql`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = ${activeGenerationId}
      WHERE id = ${knowledgeBaseId}
    `;
  });

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
  });

  it("inherits active lineage and appends candidate segments without rewriting the base", async () => {
    const base = await segments.registerAndAttach({
      id: "projection-segment-base-integration",
      knowledgeBaseId,
      generationId: activeGenerationId,
      projectionKind: "search",
      logicalPartition: "search/v1/0001",
      segmentKind: "base",
      sequenceNumber: 0,
      ordinal: 0,
      formatVersion: 2,
      checksumSha256: "aa".repeat(32),
      objectKey: "objects/base",
      logicalPath: "_segments/search/search/v1/0001/base.json",
      entryCount: 1,
      encodedBytes: 128,
      firstRecordIdentity: "record-a",
      lastRecordIdentity: "record-a",
      baseSegmentId: null,
      lifecycleState: "active"
    });
    await sql`
      INSERT INTO focowiki.active_projection_segments (
        knowledge_base_id, projection_kind, logical_partition,
        segment_id, ordinal
      ) VALUES (
        ${knowledgeBaseId}, 'search', 'search/v1/0001', ${base.id}, 0
      )
    `;
    await sql`
      INSERT INTO focowiki.active_projection_records (
        knowledge_base_id, projection_kind, record_id,
        last_changed_generation_id, shard_key, payload_json
      ) VALUES (
        ${knowledgeBaseId}, 'search', 'record-a', ${activeGenerationId},
        'search/v1/0001', ${sql.json({ id: "record-a" })}
      )
    `;

    await segments.initializeLineage(partition);
    expect(await segments.nextSequence(partition)).toBe(1);
    expect((await segments.listGenerationLineage(partition)).map((item) => item.id))
      .toEqual([base.id]);

    await records.stageUpsert({
      knowledgeBaseId,
      generationId: candidateGenerationId,
      projectionKind: "search",
      recordId: "record-b",
      shardKey: "search/v1/0001",
      sourceFileId: null,
      relatedSourceFileId: null,
      logicalPath: "pages/b.md",
      parentPath: "pages",
      sortKey: "b",
      title: "B",
      summary: null,
      searchableText: "b",
      payload: { id: "record-b" }
    });
    expect(await segments.countEffectiveRecords({
      ...partition,
      changes: [{ recordId: "record-b", action: "upsert" }]
    })).toBe(2);

    await segments.registerAndAttach({
      id: "projection-segment-delta-integration",
      knowledgeBaseId,
      generationId: candidateGenerationId,
      projectionKind: "search",
      logicalPartition: "search/v1/0001",
      segmentKind: "delta",
      sequenceNumber: 1,
      ordinal: 1,
      formatVersion: 2,
      checksumSha256: "bb".repeat(32),
      objectKey: "objects/delta",
      logicalPath: "_segments/search/search/v1/0001/delta.json",
      entryCount: 1,
      encodedBytes: 128,
      firstRecordIdentity: "record-b",
      lastRecordIdentity: "record-b",
      baseSegmentId: base.id,
      lifecycleState: "active"
    });
    await segments.setGenerationRecordCount({ ...partition, recordCount: 2 });

    const lineage = await segments.listGenerationLineage(partition);
    expect(lineage.map((item) => item.segmentKind)).toEqual(["base", "delta"]);
    const statistics = await sql<Array<{ record_count: number }>>`
      SELECT record_count
      FROM focowiki.generation_projection_partition_stats
      WHERE generation_id = ${candidateGenerationId}
        AND projection_kind = 'search'
        AND logical_partition = 'search/v1/0001'
    `;
    expect(Number(statistics[0]?.record_count)).toBe(2);
  });

  it("attaches the existing segment when immutable identity already has another id", async () => {
    const existingId = "projection-segment-existing-identity";
    const checksum = "dd".repeat(32);
    await sql`
      INSERT INTO focowiki.projection_segments (
        id, knowledge_base_id, projection_kind, logical_partition,
        segment_kind, sequence_number, format_version, checksum_sha256,
        object_key, logical_path, entry_count, encoded_bytes,
        lifecycle_state
      ) VALUES (
        ${existingId}, ${knowledgeBaseId}, 'search', 'search/v1/0001',
        'base', 0, 2, ${checksum}, 'objects/existing-identity',
        '_segments/existing-identity.json', 1, 128, 'retained'
      )
    `;

    const registered = await segments.registerAndAttach({
      id: "projection-segment-requested-identity",
      knowledgeBaseId,
      generationId: candidateGenerationId,
      projectionKind: "search",
      logicalPartition: "search/v1/0001",
      segmentKind: "base",
      sequenceNumber: 0,
      ordinal: 0,
      formatVersion: 2,
      checksumSha256: checksum,
      objectKey: "objects/requested-identity",
      logicalPath: "_segments/requested-identity.json",
      entryCount: 1,
      encodedBytes: 128,
      firstRecordIdentity: null,
      lastRecordIdentity: null,
      baseSegmentId: null,
      lifecycleState: "active"
    });

    expect(registered.id).toBe(existingId);
    expect(await sql<Array<{ segment_id: string }>>`
      SELECT segment_id
      FROM focowiki.generation_projection_segments
      WHERE generation_id = ${candidateGenerationId}
    `).toEqual([{ segment_id: existingId }]);
  });

  async function cleanup(): Promise<void> {
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
  }
});
