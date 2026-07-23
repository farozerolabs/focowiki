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

  it("returns bounded migration, projection repair, and compaction progress", async () => {
    const summary = await repository.getSummary({ knowledgeBaseId });

    expect(summary).toMatchObject({
      migration: {
        state: "backfilling",
        phase: "projection_segments",
        attemptCount: 2,
        maxAttempts: 5,
        safeErrorCode: null
      },
      projectionRepair: {
        repairVersion: 3,
        state: "running",
        phase: "navigation",
        attemptCount: 1,
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
    expect(summary.projectionRepair?.updatedAt).toBe("2026-07-20T00:00:04.000Z");
    expect(summary.compaction.active?.queuedAt).toBe("2026-07-20T00:00:01.000Z");
  });

  it("returns empty bounded state for an unknown knowledge base", async () => {
    await expect(repository.getSummary({ knowledgeBaseId: "kb-missing" })).resolves.toEqual({
      migration: null,
      projectionRepair: null,
      compaction: { active: null, latestCompleted: null }
    });
  });

  it("returns the safe failure details for the latest projection repair", async () => {
    await sql`
      UPDATE focowiki.knowledge_base_projection_repairs
      SET state = 'failed',
          last_error_code = 'PROJECTION_REPAIR_FAILED',
          last_error_message = 'Projection repair validation failed',
          updated_at = '2026-07-20T00:00:05.000Z'
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND repair_version = 3
    `;

    await expect(repository.getSummary({ knowledgeBaseId })).resolves.toMatchObject({
      projectionRepair: {
        repairVersion: 3,
        state: "failed",
        phase: "navigation",
        safeErrorCode: "PROJECTION_REPAIR_FAILED",
        safeErrorMessage: "Projection repair validation failed"
      }
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
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, predecessor_generation_id, state,
        format_version, generation_kind, activated_at
      ) VALUES (
        'generation-progress-repair-base', ${knowledgeBaseId}, NULL, 'active',
        2, 'normal', '2026-07-20T00:00:00.000Z'
      ), (
        'generation-progress-repair-target', ${knowledgeBaseId},
        'generation-progress-repair-base', 'building', 2, 'projection_repair', NULL
      )
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_projection_repairs (
        knowledge_base_id, repair_version, base_generation_id, target_generation_id,
        state, checkpoint_json, attempt_count, updated_at
      ) VALUES (
        ${knowledgeBaseId}, 2, 'generation-progress-repair-base', NULL,
        'completed', ${sql.json({
          treeComplete: true,
          navigationComplete: true,
          graphComplete: true
        })}, 1, '2026-07-20T00:00:03.000Z'
      ), (
        ${knowledgeBaseId}, 3, 'generation-progress-repair-base',
        'generation-progress-repair-target', 'running', ${sql.json({
          treeComplete: true,
          navigationComplete: false,
          graphComplete: false
        })}, 1, '2026-07-20T00:00:04.000Z'
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
