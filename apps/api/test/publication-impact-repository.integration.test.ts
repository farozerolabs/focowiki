import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresPublicationImpactRepository } from "../src/infrastructure/postgres/publication-impact-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("publication impact repository integration", () => {
  const sql = postgres(databaseUrl!, { max: 4 });
  const repository = createPostgresPublicationImpactRepository(sql);
  const knowledgeBaseId = "kb-impact-integration";
  const generationId = "generation-impact-integration";

  beforeEach(async () => {
    await cleanup();
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Impact integration')
    `;
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, state, frozen_at
      ) VALUES (${generationId}, ${knowledgeBaseId}, 'frozen', now())
    `;
    await sql`
      INSERT INTO focowiki.publication_progress (
        knowledge_base_id, generation_id, stage, total_impact_count
      ) VALUES (${knowledgeBaseId}, ${generationId}, 'planning', 3)
    `;
    for (let index = 1; index <= 3; index += 1) {
      const factId = `change-impact-${index}`;
      await sql`
        INSERT INTO focowiki.publication_change_facts (
          id, knowledge_base_id, kind, path, resource_revision, generation_id
        ) VALUES (
          ${factId}, ${knowledgeBaseId}, 'source_created',
          ${`docs/file-${index}.md`}, ${index}, ${generationId}
        )
      `;
      await sql`
        INSERT INTO focowiki.publication_projection_inputs (
          knowledge_base_id, generation_id, input_key, payload_json
        ) VALUES (
          ${knowledgeBaseId}, ${generationId}, ${`source:source-file-${index}`},
          ${sql.json({ kind: "empty", index } as never)}
        )
      `;
      await sql`
        INSERT INTO focowiki.publication_impacts (
          id, knowledge_base_id, generation_id,
          projection_kind, projection_key, record_identity, action,
          projection_input_key, run_after, max_attempts
        ) VALUES (
          ${`impact-${index}`}, ${knowledgeBaseId}, ${generationId},
          'search', ${`search/v1/000${index}`}, ${`source-file-${index}`}, 'upsert',
          ${`source:source-file-${index}`}, '2026-07-17T03:00:00.000Z', 2
        )
      `;
      await sql`
        INSERT INTO focowiki.publication_impact_causes (impact_id, change_fact_id)
        VALUES (${`impact-${index}`}, ${factId})
      `;
    }
  });

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
  });

  it("claims bounded work and advances durable progress once", async () => {
    const claimed = await repository.claimBatch({
      knowledgeBaseId,
      generationId,
      workerId: "publication-worker-a",
      limit: 2,
      now: "2026-07-17T04:00:00.000Z",
      staleBefore: "2026-07-17T03:55:00.000Z"
    });
    expect(claimed.map((impact) => impact.id)).toEqual(["impact-1", "impact-2"]);
    expect(claimed[0]).toMatchObject({
      changeKind: "source_created",
      path: "docs/file-1.md",
      attemptCount: 1,
      projectionInput: { kind: "empty", index: 1 }
    });
    expect(await repository.complete({
      knowledgeBaseId,
      generationId,
      impactId: "impact-1",
      workerId: "publication-worker-a",
      touchedShardCount: 1,
      completedAt: "2026-07-17T04:00:01.000Z"
    })).toBe(true);
    expect(await repository.complete({
      knowledgeBaseId,
      generationId,
      impactId: "impact-1",
      workerId: "publication-worker-a",
      touchedShardCount: 1,
      completedAt: "2026-07-17T04:00:02.000Z"
    })).toBe(false);
    const progress = await sql<Array<{
      processed_impact_count: number;
      touched_shard_count: number;
    }>>`
      SELECT processed_impact_count, touched_shard_count
      FROM focowiki.publication_progress
      WHERE generation_id = ${generationId}
    `;
    expect(progress[0]).toEqual({
      processed_impact_count: "1",
      touched_shard_count: "1"
    });
  });

  it("reclaims stale work and stops retrying at the durable attempt bound", async () => {
    const first = await repository.claimBatch({
      knowledgeBaseId,
      generationId,
      workerId: "publication-worker-a",
      limit: 1,
      now: "2026-07-17T04:00:00.000Z",
      staleBefore: "2026-07-17T03:55:00.000Z"
    });
    expect(first[0]?.id).toBe("impact-1");
    const reclaimed = await repository.claimBatch({
      knowledgeBaseId,
      generationId,
      workerId: "publication-worker-b",
      limit: 1,
      now: "2026-07-17T04:10:00.000Z",
      staleBefore: "2026-07-17T04:05:00.000Z"
    });
    expect(reclaimed[0]).toMatchObject({ id: "impact-1", attemptCount: 2 });
    expect(await repository.fail({
      knowledgeBaseId,
      generationId,
      impactId: "impact-1",
      workerId: "publication-worker-b",
      code: "PROJECTION_FAILED",
      message: "Projection failed",
      retryCursor: { offset: 1 },
      retryAt: "2026-07-17T04:11:00.000Z",
      failedAt: "2026-07-17T04:10:01.000Z"
    })).toEqual({ terminal: true, attemptCount: 2, maxAttempts: 2 });
    expect(await repository.countIncomplete({ knowledgeBaseId, generationId })).toEqual({
      pending: 2,
      running: 0,
      failed: 1
    });
  });

  async function cleanup() {
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
  }
});
