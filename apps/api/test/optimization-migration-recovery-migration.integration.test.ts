import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readMigrationSql } from "../src/db/migrations.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("optimization migration recovery migration", () => {
  const connectionUrl = databaseUrl ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_optimization_recovery_${process.pid}_${randomUUID()
    .replaceAll("-", "").slice(0, 12)}`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 2 });
  const knowledgeBaseId = "kb-optimization-recovery";
  const priorGenerationId = "generation-optimization-recovery-prior";
  const activeGenerationId = "generation-optimization-recovery-active";

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    for (const migration of [
      "001_production_admin_web.sql",
      "002_tree_graph_storage_reconciliation.sql",
      "003_bounded_publication_recovery.sql",
      "004_immutable_object_contention_recovery.sql",
      "005_publication_retry_budget_recovery.sql",
      "006_publication_continuation_recovery.sql",
      "007_publication_write_livelock_recovery.sql",
      "008_large_scale_ingestion_runtime.sql"
    ] as const) {
      await sql.unsafe(readMigrationSql(migration));
    }
    await seedFailedMigration();
    await sql.unsafe(readMigrationSql("009_optimization_migration_rebase_recovery.sql"));
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  it("rebases and requeues an exhausted generic migration failure", async () => {
    expect(await sql<Array<{
      state: string;
      phase: string;
      prior_active_generation_id: string | null;
      attempt_count: number;
      last_error_code: string | null;
    }>>`
      SELECT state, phase, prior_active_generation_id,
             attempt_count, last_error_code
      FROM focowiki.knowledge_base_optimization_migrations
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `).toEqual([{
      state: "verifying",
      phase: "verifying",
      prior_active_generation_id: activeGenerationId,
      attempt_count: 0,
      last_error_code: null
    }]);
  });

  it("advances the runtime generation without deleting business data", async () => {
    expect(await sql<Array<{ generation: string }>>`
      SELECT generation FROM focowiki.runtime_generation WHERE singleton = true
    `).toEqual([{ generation: "optimization-migration-rebase-recovery-v9" }]);
    expect(await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.publication_generations
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `).toEqual([{ count: 2 }]);
  });

  async function seedFailedMigration(): Promise<void> {
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Optimization migration recovery')
    `;
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, predecessor_generation_id, state
      ) VALUES
        (${priorGenerationId}, ${knowledgeBaseId}, NULL, 'superseded'),
        (${activeGenerationId}, ${knowledgeBaseId}, ${priorGenerationId}, 'active')
    `;
    await sql`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = ${activeGenerationId}
      WHERE id = ${knowledgeBaseId}
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_optimization_migrations (
        knowledge_base_id, state, phase, prior_active_generation_id,
        attempt_count, max_attempts, last_error_code, last_error_message
      ) VALUES (
        ${knowledgeBaseId}, 'failed', 'verifying', ${priorGenerationId},
        5, 5, 'MIGRATION_SLICE_FAILED',
        'Knowledge base optimization migration failed'
      )
    `;
  }
});

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
