import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresMaintenanceProgressRepository } from "../src/infrastructure/postgres/maintenance-progress-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("maintenance progress repository integration", () => {
  const sql = postgres(databaseUrl!, { max: 4 });
  const repository = createPostgresMaintenanceProgressRepository(sql);
  const knowledgeBaseId = "kb-maintenance-progress";
  const otherKnowledgeBaseId = "kb-maintenance-progress-other";

  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
  });

  it("returns one bounded migration row and the latest scoped compaction states", async () => {
    const summary = await repository.getSummary({ knowledgeBaseId });

    expect(summary).toMatchObject({
      migration: {
        state: "backfilling",
        phase: "projection_segments",
        attemptCount: 2,
        maxAttempts: 5,
        safeErrorCode: null
      },
      compaction: {
        active: {
          state: "running",
          attemptCount: 1,
          maxAttempts: 5,
          safeErrorCode: null
        },
        latestCompleted: {
          state: "completed",
          attemptCount: 1,
          maxAttempts: 5
        }
      }
    });
    expect(summary.migration?.startedAt).toBe("2026-07-20T00:00:00.000Z");
    expect(summary.compaction.active?.queuedAt).toBe("2026-07-20T00:00:01.000Z");
  });

  it("returns empty bounded state for an unknown knowledge base", async () => {
    await expect(repository.getSummary({ knowledgeBaseId: "kb-missing" })).resolves.toEqual({
      migration: null,
      compaction: { active: null, latestCompleted: null }
    });
  });

  async function seed(): Promise<void> {
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Maintenance progress'),
             (${otherKnowledgeBaseId}, 'Other maintenance progress')
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_optimization_migrations (
        knowledge_base_id, state, phase, attempt_count, max_attempts,
        started_at, updated_at
      ) VALUES (
        ${knowledgeBaseId}, 'backfilling', 'projection_segments', 2, 5,
        '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:02.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.projection_compaction_jobs (
        id, knowledge_base_id, projection_kind, logical_partition,
        active_generation_id, expected_segment_ids, reason_codes, state,
        attempt_count, max_attempts, created_at, updated_at, completed_at
      ) VALUES (
        'compaction-progress-running', ${knowledgeBaseId}, 'search', 'search/0001',
        'generation-progress', ARRAY['segment-a'], ARRAY['depth'], 'running',
        1, 5, '2026-07-20T00:00:01.000Z', '2026-07-20T00:00:03.000Z', NULL
      ), (
        'compaction-progress-completed', ${knowledgeBaseId}, 'tree', 'tree/0001',
        'generation-progress', ARRAY['segment-b'], ARRAY['bytes'], 'completed',
        1, 5, '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:02.000Z',
        '2026-07-20T00:00:02.000Z'
      ), (
        'compaction-progress-other', ${otherKnowledgeBaseId}, 'search', 'search/0001',
        'generation-other', ARRAY['segment-c'], ARRAY['depth'], 'failed',
        5, 5, '2026-07-20T00:00:04.000Z', '2026-07-20T00:00:05.000Z', NULL
      )
    `;
  }

  async function cleanup(): Promise<void> {
    await sql`
      DELETE FROM focowiki.knowledge_bases
      WHERE id IN (${knowledgeBaseId}, ${otherKnowledgeBaseId})
    `;
  }
});
