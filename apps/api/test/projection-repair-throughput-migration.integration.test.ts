import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  MIGRATION_FILES,
  readMigrationSql,
  RUNTIME_SCHEMA_GENERATION
} from "../src/db/migrations.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("projection repair throughput migration integration", () => {
  const connectionUrl = databaseUrl ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_repair_migration_${process.pid}_${
    randomUUID().replaceAll("-", "").slice(0, 10)
  }`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 4 });

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    for (const fileName of MIGRATION_FILES.slice(0, -1)) {
      await sql.begin(async (transaction) => {
        await transaction.unsafe(readMigrationSql(fileName));
      });
    }
    await seedCompatibleDatabase();
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  it("upgrades populated resumable repairs and is idempotent after completion", async () => {
    await applyMigrations(sql);
    await applyMigrations(sql);

    expect((await sql<Array<{ generation: string }>>`
      SELECT generation
      FROM focowiki.runtime_generation
      WHERE singleton = true
    `)[0]?.generation).toBe(RUNTIME_SCHEMA_GENERATION);
    expect(await sql<Array<{
      repair_version: number;
      state: string;
      current_phase: string;
      planner_version: number;
      settings_snapshot_json: unknown;
    }>>`
      SELECT repair_version, state, current_phase,
             planner_version, settings_snapshot_json
      FROM focowiki.knowledge_base_projection_repairs
      WHERE knowledge_base_id = 'kb-repair-migration'
      ORDER BY repair_version
    `).toEqual([
      {
        repair_version: 2,
        state: "superseded",
        current_phase: "superseded",
        planner_version: 1,
        settings_snapshot_json: {}
      },
      {
        repair_version: 3,
        state: "running",
        current_phase: "tree",
        planner_version: 1,
        settings_snapshot_json: {}
      }
    ]);
    expect(await sql<Array<{ id: string; state: string }>>`
      SELECT id, state
      FROM focowiki.publication_generations
      WHERE id IN ('generation-repair-old', 'generation-repair-current')
      ORDER BY id
    `).toEqual([
      { id: "generation-repair-current", state: "building" },
      { id: "generation-repair-old", state: "superseded" }
    ]);
    expect((await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM pg_indexes
      WHERE schemaname = 'focowiki'
        AND indexname IN (
          'knowledge_base_projection_repairs_one_active_version_idx',
          'projection_repair_subtasks_claim_idx',
          'projection_repair_subtasks_lease_idx'
        )
    `)[0]?.count).toBe(3);
    expect((await sql<Array<{ active_generation_id: string | null }>>`
      SELECT active_generation_id
      FROM focowiki.knowledge_bases
      WHERE id = 'kb-repair-migration'
    `)[0]?.active_generation_id).toBe("generation-repair-active");
  });

  async function seedCompatibleDatabase(): Promise<void> {
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.knowledge_bases (id, name, resource_revision)
        VALUES ('kb-repair-migration', 'Repair migration', 9)
      `;
      await transaction`
        INSERT INTO focowiki.publication_generations (
          id, knowledge_base_id, predecessor_generation_id,
          state, generation_kind, activated_at
        ) VALUES
          (
            'generation-repair-active', 'kb-repair-migration',
            NULL, 'active', 'normal', now()
          ),
          (
            'generation-repair-old', 'kb-repair-migration',
            'generation-repair-active', 'superseded', 'projection_repair', NULL
          ),
          (
            'generation-repair-current', 'kb-repair-migration',
            'generation-repair-active', 'building', 'projection_repair', NULL
          )
      `;
      await transaction`
        UPDATE focowiki.knowledge_bases
        SET active_generation_id = 'generation-repair-active'
        WHERE id = 'kb-repair-migration'
      `;
      await transaction`
        INSERT INTO focowiki.knowledge_base_projection_repairs (
          knowledge_base_id, repair_version, base_generation_id,
          target_generation_id, state, checkpoint_json,
          lease_token, lease_expires_at, updated_at
        ) VALUES
          (
            'kb-repair-migration', 2, 'generation-repair-active',
            'generation-repair-old', 'pending', '{}'::jsonb,
            NULL, NULL, '2026-07-23T00:00:00.000Z'
          ),
          (
            'kb-repair-migration', 3, 'generation-repair-active',
            'generation-repair-current', 'running',
            '{"treeComplete":false}'::jsonb,
            'legacy-lease', '2099-07-24T00:00:00.000Z',
            '2026-07-24T00:00:00.000Z'
          )
      `;
    });
  }
});

function databaseConnectionUrl(source: string, database: string): string {
  const url = new URL(source);
  url.pathname = `/${database}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
